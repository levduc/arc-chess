import { spawn } from "node:child_process";
import { existsSync, mkdirSync, lstatSync, readdirSync, renameSync, rmdirSync, rmSync, type Dirent } from "node:fs";
import { dirname, join } from "node:path";
import { encodeFunctionData, formatUnits, parseUnits, type Address, type Hex } from "viem";
import {
  channelHubAbi,
  decodeWire,
  DEFAULT_FEE_CEILING_WEI,
  offerId as computeOfferId,
  parseSignedOffer,
  type SignedOffer,
} from "@arena/sdk";
import { runBot } from "./bot.js";
import { acquireHomeLock, livePidHoldingLock } from "./lock.js";
import {
  arenaPaths,
  defaultHome,
  initHome,
  loadConfig,
  loadToken,
  loadWalletKey,
  minChallengeTimeoutOf,
  DEFAULT_LOG_CHUNK_BLOCKS,
  defaultSessionGasWei,
  feeCeilingOf,
  knownDeploymentWarnings,
  parseXmtpConfig,
  pinnedDeploymentRefusals,
  profileSessionGasWei,
  readConfig,
  type ArenaConfig,
  type XmtpConfig,
} from "./config.js";
import { chainProfile, weiToUsdc6Down } from "./chains.js";
import {
  computeFundingNeed,
  computeOneBalanceFundingNeed,
  formatUsdc6,
  fundMessage,
  type FundingNeed,
  type OneBalanceFundingNeed,
} from "./funding.js";
import { readJson } from "./jsonfile.js";
import {
  classifyOwner,
  forbiddenOwners,
  noOwnerMessage,
  ownerNetworkNote,
  ownerNonceOf,
  readRecordedOwner,
  setOwner,
  UsageError,
} from "./owner.js";
import { RecordStore } from "./records.js";
import { startDaemonProcess } from "./run.js";
import { cliPackage, cliVersion, hostCliVerdict, selfCommand } from "./version.js";
import { loadXmtpSdk, loadXmtpSdkFrom, XMTP_SDK_VERSION } from "./xmtp/loader.js";

export type CliIo = {
  env: NodeJS.ProcessEnv;
  fetch: typeof fetch;
  out(s: string): void;
  err(s: string): void;
};

/** Plan 5.6 Task 4 (ruling 3): how *this running CLI* names itself in a message a human or agent must run again
 *  (`owner set`'s printed command, the daemon-unreachable hints) -- the exact pinned `npx` form in the published
 *  bundle, or `arena` under tsx. Never used for the init version gate's *install* hint, which names a different
 *  package/version (the host's required one, from /templates), not this build's own. */
const CLI_COMMAND = selfCommand();

const USAGE = `usage: ${CLI_COMMAND} <command> [options]
  init --server URL [--rpc URL --chain-id N --hub ADDR --usdc ADDR --rules ADDR] [--port N] [--wallet-key HEX]
       [--owner ADDR] [--max-fee N] [--session-gas-wei N] [--session-gas-floor N] [--poll-ms N] [--log-chunk-blocks N]
       [--fee-ceiling-wei N] [--min-challenge-timeout SECONDS] [--auto-return-on-challenge true|false] [--no-faucet]
       (--session-gas-wei defaults to 4 x 2.1M gas x max(fee ceiling, 4 x the RPC's gas price): dispute gas per channel;
        on Arc, 4 x 2.1M gas x Arc's 40 gwei profile ceiling = 0.336 USDC, regardless of --fee-ceiling-wei: use
        --session-gas-wei to change it)
       (--fee-ceiling-wei defaults to 100 gwei; on Arc, to 40 gwei, and a value under Arc's 20 gwei fee floor is refused)
       (--auto-return-on-challenge, default true: a human-held seat that must answer a challenge goes back to the
        agent once max(60 s, challengeTimeout / 3) is left)
       (missing chain settings are filled from the server's /templates; every chain setting is checked over the RPC;
        re-running init on an existing home never changes its chain-id, hub, usdc or rules -- use a fresh ARENA_HOME --
        and changes its RPC only once every channel is finalized;
        the wallet key must not be used anywhere else: the daemon replaces pending transactions it did not send)
       (when the server advertises a dev faucet and the wallet's USDC balance is below 20, init calls it;
        --no-faucet turns this off)
       (--owner records a first owner, or repeats the recorded one; it never changes one -- that takes "owner set"
        with the current owner's signature. Re-running init keeps the recorded owner)
  daemon [start]
  board   (prints a one-time board link, valid for 2 minutes: open it in a browser on this machine; needs the daemon)
  wallet  (prints {address, usdc, native, chainId} by reading the chain directly -- no daemon needed;
           on a chain whose gas is USDC, such as Arc, one balance: {address, chainId, usdc}, and no --wait-for-native)
          [--wait-for-usdc A] [--wait-for-native B] [--timeout SECONDS (default 1800, max 3600)]
          (with a --wait-for-* flag: polls every 5s -- ARENA_WAIT_POLL_MS overrides it, never below 200 -- until every given
           threshold holds or the timeout passes, then prints the same JSON plus {reached, waitedSeconds}.
           Exit 0 once reached, 2 on timeout, 1 on error.)
  faucet  (calls the server's dev faucet for this wallet explicitly; fails if the server has none)
  fund --games N --stake X [--deposit D]  |  fund --offer OFFER_ID [--games N]
       (works out what to ask your human for: reads /templates' deposit cap and faucet, the hub's
        feePerPlayer, and this wallet's balances -- no daemon needed. deposit defaults to min(N x X, cap).
        --offer takes the deposit and stake of that open offer from the server's own lobby instead (it cannot be
        combined with --deposit or --stake), and adds {offerId, stakePerGame} to the output; an offer that is no
        longer open exits 1. Every amount, in the output and in errors, is in whole USDC.
        Calls the server's faucet once, the same way init does, if anything is short and one is advertised.
        Prints {address, chainId, deposit, feePerPlayer, usdc, native, owner, faucet?, message}, where
        message is a ready-to-relay sentence (on Arc it names the network, warns that USDC sent on any other
        network never arrives, says how to get USDC onto Arc and, with no owner recorded, asks for an address the
        human controls on Arc). On a chain whose gas is USDC, such as Arc, there is no native:
        the gas is part of usdc.need, and message asks for USDC only; usdc.need also keeps one session gas for
        each channel of this home that is not finalized, shown as usdc.reserved. faucet is present only when a
        faucet call was attempted: on success it is {usdc, native} (the wallet's new balances, formatted like
        "arena faucet"; {usdc} alone where gas is USDC); on failure (unreachable, rate-limited, wrong origin, ...)
        it is the string "skipped: <reason>" instead, and the
        usdc/native fields above keep reporting the shortfall as it actually stands. Exit 0 whenever the
        computation succeeds -- a shortfall is data, not an error; exit 1 if the server or the hub cannot be
        read at all (for example, a hub address with no contract code on this chain).)
  owner   (prints {owner}: the address withdraw pays, or null)
  owner set ADDR [--signature 0x...]
          (records the human owner's address -- the only place withdraw ever sends USDC. The first set is free;
           changing it needs the CURRENT owner's EIP-191 signature: without --signature it prints {messageToSign,
           signer, command} and exits 1. The signature is checked locally (ECDSA, never through the RPC), so a
           smart-contract owner cannot be changed here -- only by hand-editing config.json. Never the wallet, the
           hub, the USDC token, the rules contract, a session key or the zero address. On Arc, it must be an
           address the human controls on Arc -- withdraw pays it there only -- and stderr says so.)
  withdraw --amount A | --all
          (sends USDC from this wallet to the recorded owner -- it takes no destination -- through the daemon:
           started in-process, and stopped again, if none is running. Refused while a channel still awaits this
           wallet's deposit. Funds escrowed in channels are not in the wallet: close open channels first. Succeeds
           only when the receipt shows the USDC Transfer to the owner. Prints {to, amount, txHash, usdcAfter}
           (usdcAfter null, with a note, if the balance cannot be read after it); a note on stderr if this wallet
           still has open offers. On a chain whose gas is USDC, such as Arc, --all keeps a gas reserve for the
           unsettled channels and the wallet's own transactions, and --amount never dips into it, so usdcAfter is
           not 0 after --all.)
  bot [--deposit 10] [--stake 1] [--offers 1] [--timeout SECONDS] [--idle-close-seconds 120] [--allow-real-chain]
      (a long-lived process: runs the daemon in-process, keeps --offers standing offers open, and plays its own
       agent-controlled seats with a simple strategy -- mate in one, else the best qualifying capture, else
       sometimes a check or a capture, else a random move. Refuses any chain but 31337 unless --allow-real-chain.)
  xmtp enable | status | disable
       (Plan 5.7: the XMTP fallback transport's SDK -- opt-in, never bundled, loaded only once installed.
        enable installs the pinned @xmtp/node-sdk (about 480 MB, one-time) into <ARENA_HOME>/xmtp/sdk and prints
        {enabled, version, sizeMB}; a running daemon loads it only when it starts, so restart the daemon after
        enabling. It often outlasts a 2-minute tool limit: run it in the background and poll status until enabled
        is true. A run that was killed part-way is safe to repeat, and the next enable removes its leftover
        <ARENA_HOME>/xmtp/.sdk-tmp-* directory. status prints {enabled, version|null, reason?, env|null, daemon, daemonReason?} without
        installing anything: daemon is what the RUNNING daemon loaded ("xmtp" or "off") or "not running".
        disable removes the installed SDK only -- it never touches <ARENA_HOME>/xmtp/db, so a channel's XMTP
        history survives a disable/enable cycle.
        ARENA_XMTP_NPM overrides the npm binary "enable" installs with -- a test hook, never set this normally:
        a stale value left in a shell or CI environment silently swaps the installer)
  offers | offer --deposit USDC --stake USDC [--timeout SECONDS (default: this daemon's minChallengeTimeout)]
        [--ttl SECONDS (how long the offer stays matchable, 60 to 3600; default 3600)] | accept <offerId>
  channels | status [--channel ID] | wait [--channel ID] [--timeout SECONDS]
  move <move> [--offer-draw] [--channel ID]
  resign | accept-draw | next-game | close | challenge | reclaim | sweep [--channel ID]
  handoff human|agent [--note TEXT] [--channel ID]
  version  (prints this CLI's version)`;

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** Final fix wave (M8): the fastest `wallet --wait-for-*` may poll, whatever `ARENA_WAIT_POLL_MS` says. */
export const WAIT_POLL_FLOOR_MS = 200;

/** Plan 5.5 Task 1: `init` auto-funds from the server's faucet only below this USDC balance (6 decimals). */
const FAUCET_MIN_USDC_BALANCE = 20_000_000n;

/** ERC20 `balanceOf(address)` calldata: the well-known 4-byte selector `0x70a08231`, plus the address
 *  left-padded to a 32-byte word. */
function balanceOfCalldata(address: Address): Hex {
  return `0x70a08231${address.slice(2).toLowerCase().padStart(64, "0")}` as Hex;
}

function hexToBigIntOrThrow(raw: unknown, what: string): bigint {
  if (typeof raw !== "string" || !/^0x[0-9a-fA-F]*$/.test(raw)) throw new Error(`${what}: malformed RPC result ${JSON.stringify(raw)?.slice(0, 80)}`);
  return raw === "0x" ? 0n : BigInt(raw);
}

/** USDC's `balanceOf`, read with a raw `eth_call` through `io.fetch` -- stubbable, no viem client needed. */
async function usdcBalanceOf(io: CliIo, rpcUrl: string, usdc: Address, address: Address): Promise<bigint> {
  const raw = await rpcCall(io, rpcUrl, "eth_call", [{ to: usdc, data: balanceOfCalldata(address) }, "latest"]);
  return hexToBigIntOrThrow(raw, `RPC ${rpcUrl} eth_call (USDC balanceOf)`);
}

/** The chain's native balance (wei), read with `eth_getBalance` through `io.fetch`. */
async function nativeBalanceOf(io: CliIo, rpcUrl: string, address: Address): Promise<bigint> {
  const raw = await rpcCall(io, rpcUrl, "eth_getBalance", [address, "latest"]);
  return hexToBigIntOrThrow(raw, `RPC ${rpcUrl} eth_getBalance`);
}

/** The native balance, formatted with `formatUnits` (which trims trailing zeros and, for a whole amount, the
 *  decimal point too) but always showing at least one decimal place -- `formatUnits(10n ** 18n, 18)` is `"1"`;
 *  this returns `"1.0"`. */
function formatNativeBalance(wei: bigint): string {
  const s = formatUnits(wei, 18);
  return s.includes(".") ? s : `${s}.0`;
}

/**
 * Plan 5 Task 2 fix round, CRITICAL 1: the JSON line `arena daemon` prints on stdout at startup. This must never
 * carry the token, even in a URL fragment -- every documented way to run a daemon long-lived (`nohup ... >
 * daemon.log`, README; a systemd unit whose stdout goes to journald) redirects this exact line to a log file,
 * which would defeat the token file's 0600 permissions. `board` here is the URL with no fragment at all; only
 * `arena board` (a human runs it directly, in a foreground terminal) prints a board link, and that link carries a
 * single-use, short-lived code, never the token itself (Plan 5 final fix M1).
 * A pure function so a test can check its shape without actually starting a daemon.
 */
export function daemonStartLine(proc: { apiUrl: string; pid: number; wallet: string; fallback: "xmtp" | "off" }): Record<string, unknown> {
  return {
    api: proc.apiUrl,
    pid: proc.pid,
    wallet: proc.wallet,
    board: `${proc.apiUrl}/board`,
    // Final fix wave (M5): the pinned npx form in the bundle, which an agent can run as is.
    boardHint: `run: ${CLI_COMMAND} board`,
    // Plan 5.7 (spec §2): "xmtp" once config.xmtp is set and the SDK loaded, else "off" -- mirrors ArenaDaemon's
    // own `fallback` getter (daemon.ts), so a human or agent reading the start line sees it immediately rather
    // than having to ask `status`.
    fallback: proc.fallback,
  };
}

/** Plan 5.7 Task 4: the npm binary `arena xmtp enable` installs with. Next to this build's own `process.execPath`
 *  when present (the same Node install's own npm, e.g. nvm/Volta), else the bare name -- resolved from PATH by
 *  the shell-less `spawn` itself. `ARENA_XMTP_NPM` overrides it outright: the one seam tests use to point at a
 *  fake installer script that copies a fixture package, instead of ever reaching the real ~480 MB npm download. */
export function resolveNpmBinary(io: CliIo): string {
  const override = io.env.ARENA_XMTP_NPM;
  if (override) return override;
  const name = process.platform === "win32" ? "npm.cmd" : "npm";
  const candidate = join(dirname(process.execPath), name);
  return existsSync(candidate) ? candidate : "npm";
}

/** A throwaway SDK install dir's name: `.sdk-tmp-<pid>-<epoch ms>` (see `xmtp enable`). */
const SDK_TMP_RE = /^\.sdk-tmp-(\d+)-(\d+)$/;

/** Older than this, a throwaway SDK install dir is stale even if its pid is alive again (a reused pid): no real
 *  install takes this long. */
const SDK_TMP_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** True while `pid` names a live process (EPERM still means alive); false once it is gone. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Plan 6 hardening H2 (audit-journey I-5): removes the `.sdk-tmp-<pid>-<ms>` dirs under `xmtpDir` that an earlier
 * `xmtp enable` left behind when it was killed part-way -- by an agent tool's command time limit, say. A kill skips
 * `enable`'s own cleanup, so each one can leave up to ~480 MB on disk. A dir whose pid is still alive (another
 * `enable` in progress) is left alone unless it is over a day old. Returns the names it removed; never throws -- a
 * dir it cannot read or remove is left for the next run. Exported for tests.
 */
export function removeStaleSdkTmpDirs(xmtpDir: string, isAlive: (pid: number) => boolean = pidAlive, now = Date.now()): string[] {
  let names: string[];
  try {
    names = readdirSync(xmtpDir);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const name of names) {
    const m = SDK_TMP_RE.exec(name);
    if (m === null) continue;
    const pid = Number(m[1]);
    const startedAt = Number(m[2]);
    if (pid !== process.pid && isAlive(pid) && now - startedAt < SDK_TMP_MAX_AGE_MS) continue;
    if (pid === process.pid && now - startedAt < SDK_TMP_MAX_AGE_MS) continue;
    try {
      rmSync(join(xmtpDir, name), { recursive: true, force: true });
      removed.push(name);
    } catch {
      // left for the next run
    }
  }
  return removed;
}

/** The total size (bytes) of every regular file under `dir`, recursively. A symlink counts its own link size,
 *  never the target's (so a cycle can never recurse forever); a `dir` that does not exist (or a raced-away file)
 *  counts as 0 rather than throwing. */
function dirSizeBytes(dir: string): number {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let total = 0;
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) total += dirSizeBytes(full);
    else {
      try {
        total += lstatSync(full).size;
      } catch {
        // raced away between readdir and stat: not this process's problem to report
      }
    }
  }
  return total;
}

/**
 * Plan 5.7 Task 4 (spec §4): runs `npm install --prefix <sdkDir> --no-audit --no-fund --save-exact
 * @xmtp/node-sdk@<version>` with `npmBin`, with no shell (an argv array, never a shell string -- `sdkDir` is a
 * path this process built itself, but there is no reason to open a shell-injection surface for it anyway).
 * Collects npm's combined stdout/stderr only to report on failure; prints nothing on success.
 */
function runNpmInstall(npmBin: string, sdkDir: string, version: string, io: CliIo): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = ["install", "--prefix", sdkDir, "--no-audit", "--no-fund", "--save-exact", `@xmtp/node-sdk@${version}`];
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(npmBin, args, { env: io.env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      reject(new Error(`xmtp enable: failed to start ${npmBin}: ${err instanceof Error ? err.message : String(err)}`));
      return;
    }
    let output = "";
    child.stdout?.on("data", (c: Buffer) => (output += c.toString("utf8")));
    child.stderr?.on("data", (c: Buffer) => (output += c.toString("utf8")));
    child.once("error", (err) => reject(new Error(`xmtp enable: failed to run ${npmBin}: ${err.message}`)));
    child.once("close", (code) => {
      if (code === 0) resolve();
      else {
        // Fix round 1 (Minor 1): the generic top-level handler prints only an Error's first line
        // (err.message.split("\n")[0]), which would bury npm's actually-useful line (its second line, routinely
        // -- "npm error code E404" then "npm error 404 Not Found - ..."). Write the captured output straight to
        // stderr instead, so the real reason survives that truncation; the rejection itself stays one line.
        if (output.trim()) io.err(output.trim().slice(-4000));
        reject(new Error(`xmtp enable: "${npmBin} install … @xmtp/node-sdk@${version}" exited ${code}`));
      }
    });
  });
}

/** Plan 5.7 (I-2): how long `arena xmtp status` waits for the running daemon's `GET /fallback`. */
const DAEMON_FALLBACK_TIMEOUT_MS = 2_000;

/**
 * Plan 5.7 (I-2): whether this home's RUNNING daemon loaded the XMTP SDK, from its `GET /fallback` -- `"xmtp"` or
 * `"off"` (with its reason) -- or `"not running"` when nothing answers on its port (no config or token yet counts as
 * not running), or `"unknown"` when something answers but not with a fallback (with why). Never throws.
 */
async function runningDaemonFallback(home: string, io: CliIo): Promise<{ fallback: "xmtp" | "off" | "not running" | "unknown"; reason?: string }> {
  let port: number;
  let token: string;
  try {
    port = readConfig(home).config.port;
    token = loadToken(home);
  } catch {
    return { fallback: "not running" };
  }
  let res: Response;
  try {
    res = await io.fetch(`http://127.0.0.1:${port}/fallback`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(DAEMON_FALLBACK_TIMEOUT_MS),
    });
  } catch {
    return { fallback: "not running" };
  }
  const body = (await res.json().catch(() => null)) as { fallback?: unknown; reason?: unknown; error?: unknown } | null;
  if (res.ok && (body?.fallback === "xmtp" || body?.fallback === "off")) {
    return typeof body.reason === "string" ? { fallback: body.fallback, reason: body.reason } : { fallback: body.fallback };
  }
  const why = typeof body?.error === "string" ? body.error : res.statusText;
  return { fallback: "unknown", reason: `the daemon on 127.0.0.1:${port} answered ${res.status}: ${why}` };
}

/**
 * Plan 5.7 Task 4: the one line `arena bot` logs, once, when the host configured XMTP (`config.xmtp`) but this
 * daemon ended up without the fallback -- the SDK missing, a wrong version, or a broken install
 * (`DaemonProcess.fallback` stays `"off"` exactly when `startDaemonProcess`'s own `loadXmtpSdk` failed, Task 1).
 * `null` when xmtp is not configured, or the fallback is already on -- `arena bot` never re-checks the SDK
 * itself; it only reads what the daemon already decided.
 */
export function xmtpBotHint(xmtpConfigured: boolean, fallback: "xmtp" | "off"): string | null {
  if (!xmtpConfigured || fallback === "xmtp") return null;
  return `xmtp is configured but not enabled on this machine: run "${CLI_COMMAND} xmtp enable" (about 480 MB, one-time)`;
}

/**
 * Plan 5.5 Task 2 fix round (minor 5): the reason `arena bot --timeout <timeout>` would never actually work on
 * this chain/daemon, or `null` if it's fine. The floor is the larger of the hub's own `MIN_TIMEOUT` and this
 * daemon's own `minChallengeTimeout` (`createOffer`'s own check order, mirrored here so the error surfaces at
 * startup instead of as a repeating, generic createOffer failure on every standing-offer recheck pass). A pure
 * function of the three bounds, so it's unit-testable without a chain -- `arena bot` reads `hubBounds` from
 * `daemon.hub.timeoutBounds()` once, after the daemon (and so the hub connection) is up.
 */
export function invalidOfferTimeoutReason(
  timeout: bigint,
  hubBounds: { min: bigint; max: bigint },
  minChallengeTimeout: bigint,
): string | null {
  const floor = hubBounds.min > minChallengeTimeout ? hubBounds.min : minChallengeTimeout;
  if (timeout < floor) {
    return (
      `--timeout ${timeout}s is below the minimum of ${floor}s (the hub's own minimum is ${hubBounds.min}s; ` +
      `this daemon's minChallengeTimeout is ${minChallengeTimeout}s)`
    );
  }
  if (timeout > hubBounds.max) {
    return `--timeout ${timeout}s is above the hub's maximum of ${hubBounds.max}s`;
  }
  return null;
}

/** Task 3 fix round 4 (N2): the longest one `rpcCall` may take, reply body included. Without it a hostile or dead RPC
 *  could hold `init` -- and the home lock it holds -- open for minutes (undici's own header and body timeouts). */
export const RPC_TIMEOUT_MS = 30_000;

/** One JSON-RPC call through `io.fetch` (so tests can stub it); throws on transport, HTTP or RPC errors, and when
 *  no full reply arrives within `RPC_TIMEOUT_MS`. */
async function rpcCall(io: CliIo, url: string, method: string, params: unknown[]): Promise<unknown> {
  const signal = AbortSignal.timeout(RPC_TIMEOUT_MS);
  // fetch rejects with the signal's reason, a DOMException named "TimeoutError", when the signal fires.
  const timedOut = (err: unknown) => signal.aborted || (err as { name?: unknown } | null)?.name === "TimeoutError";
  const timeoutError = () => new Error(`RPC ${url} did not answer ${method} within ${RPC_TIMEOUT_MS / 1000} s`);
  let res: Response;
  try {
    res = await io.fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal,
    });
  } catch (err) {
    if (timedOut(err)) throw timeoutError();
    throw new Error(`RPC ${url} is unreachable (${method}): ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) throw new Error(`RPC ${url} answered ${method} with status ${res.status}`);
  let body: { result?: unknown; error?: { message?: string } };
  try {
    body = (await res.json()) as typeof body;
  } catch (err) {
    if (timedOut(err)) throw timeoutError();
    throw new Error(`RPC ${url} answered ${method} with a body that is not JSON`);
  }
  if (body === null || typeof body !== "object") throw new Error(`RPC ${url} answered ${method} with a malformed body`);
  if (body.error) throw new Error(`RPC ${url} refused ${method}: ${body.error.message ?? "unknown error"}`);
  return body.result;
}

/** I8: checks, over the RPC the daemon will use, that the chain settings are at least real: the RPC serves
 *  `chainId`, and every address in `contracts` holds code (Task 3 fix round 1, I3: the hub, USDC and rules, on
 *  every init -- explicit flags included). It cannot prove they are the genuine arena contracts -- the printed
 *  trust line says so. */
async function verifyChain(io: CliIo, rpcUrl: string, chainId: number, contracts: Record<string, Address>): Promise<void> {
  const reported = await rpcCall(io, rpcUrl, "eth_chainId", []);
  if (typeof reported !== "string" || !/^0x[0-9a-fA-F]{1,64}$/.test(reported)) {
    throw new Error(`RPC ${rpcUrl} returned a malformed eth_chainId: ${JSON.stringify(reported)?.slice(0, 80)}`);
  }
  if (BigInt(reported) !== BigInt(chainId)) {
    throw new Error(`RPC ${rpcUrl} serves chain ${String(reported)}, not chain ${chainId}`);
  }
  for (const [name, address] of Object.entries(contracts)) {
    const code = await rpcCall(io, rpcUrl, "eth_getCode", [address, "latest"]);
    if (typeof code !== "string" || code === "0x" || code === "") {
      throw new Error(`${name} ${address} has no contract code on chain ${chainId} (via ${rpcUrl})`);
    }
  }
}

/**
 * Plan 5.6 Task 2: the one place that calls a server's dev faucet, shared by `init`'s auto-fund check and
 * `fund`'s shortfall top-up -- same origin pin, same 30s abort signal, same refusal to follow a redirect (M3),
 * same malformed-payload check. Returns the wallet's reported balances (base units) on success; throws on any
 * failure (wrong origin, unreachable, non-2xx, malformed payload) with a message naming the faucet URL and
 * reason -- callers decide whether that is fatal (`init` and `fund` both treat it as a skip, not a failure).
 */
async function callFaucet(io: CliIo, faucetUrl: string, serverUrl: string, address: Address): Promise<{ usdc: bigint; native: bigint }> {
  // M3: the faucet URL comes from the same /templates response as the hub/RPC addresses, but costs nothing
  // extra to pin -- refuse a faucet whose origin differs from the server's, rather than ever POSTing the
  // wallet address somewhere else a compromised or careless server named.
  if (new URL(faucetUrl).origin !== new URL(serverUrl).origin) {
    throw new Error(`faucet ${faucetUrl} is not on ${serverUrl}'s origin; refusing to call it`);
  }
  let res: Response;
  try {
    res = await io.fetch(faucetUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address }),
      // M3: a faucet that accepts and then stalls must not hang the caller forever, and a redirect is refused
      // outright rather than followed somewhere off the pinned origin.
      signal: AbortSignal.timeout(30_000),
      redirect: "error",
    });
  } catch (err) {
    throw new Error(`faucet ${faucetUrl} is unreachable: ${err instanceof Error ? err.message : String(err)}`);
  }
  const payload = (await res.json().catch(() => ({}))) as { usdc?: unknown; native?: unknown; error?: unknown };
  if (!res.ok) {
    const detail = typeof payload.error === "string" ? `: ${payload.error}` : "";
    throw new Error(`faucet ${faucetUrl} answered with status ${res.status}${detail}`);
  }
  // The server reports raw base-unit decimal strings (matching every other /templates amount); callers format
  // them the same way `arena wallet` does, rather than passing them through unchanged.
  const decStr = /^[0-9]+$/;
  if (typeof payload.usdc !== "string" || !decStr.test(payload.usdc) || typeof payload.native !== "string" || !decStr.test(payload.native)) {
    throw new Error(`faucet ${faucetUrl} answered with a malformed amount: ${JSON.stringify(payload)}`);
  }
  return { usdc: BigInt(payload.usdc), native: BigInt(payload.native) };
}

/** True for a URL whose host is this machine, where plain http cannot be intercepted on the way. */
function isLoopbackUrl(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }
  return host === "localhost" || host === "[::1]" || host === "::1" || /^127\.\d+\.\d+\.\d+$/.test(host);
}

function parse(argv: string[]): { positional: string[]; flags: Map<string, string | true> } {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--offer-draw") flags.set("offer-draw", true);
    else if (a === "--no-faucet") flags.set("no-faucet", true);
    else if (a === "--allow-real-chain") flags.set("allow-real-chain", true);
    // Plan 5.6 Task 3 (fix round 1, M5): `--all` is a boolean for every command, not only `withdraw` -- a future
    // command that wants `--all <value>` must special-case it here, or it will silently get `true`.
    else if (a === "--all") flags.set("all", true);
    else if (a.startsWith("--")) {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) throw new UsageError(`missing value for ${a}`);
      flags.set(a.slice(2), v);
      i++;
    } else positional.push(a);
  }
  return { positional, flags };
}

export async function runCli(argv: string[], io: CliIo): Promise<number> {
  try {
    if (argv[0] === "--version" || argv[0] === "version") {
      io.out(cliVersion());
      return 0;
    }
    const { positional, flags } = parse(argv);
    const [cmd, arg] = positional;
    const home = defaultHome(io.env);
    const flag = (name: string) => {
      const v = flags.get(name);
      return typeof v === "string" ? v : undefined;
    };
    const need = (name: string) => {
      const v = flag(name);
      if (!v) throw new UsageError(`--${name} is required`);
      return v;
    };
    // A USDC amount in whole units with at most 6 decimals (USDC's precision). Anything finer would be silently
    // rounded by parseUnits, and the rounded amount is what gets staked — so it is a usage error instead.
    const usdcAmount = (name: string) => {
      const v = need(name);
      if (!/^[0-9]+(\.[0-9]{1,6})?$/.test(v)) {
        throw new UsageError(`--${name} must be a non-negative USDC amount with at most 6 decimal places`);
      }
      return parseUnits(v, 6).toString();
    };

    if (cmd === "init") {
      const server = need("server");
      // Final review I4: a live daemon already holds this home's lock. Re-pointing config.json underneath it
      // would leave that daemon running against the old settings (serverUrl, chain, hub) while every later
      // `arena <cmd>` talks to it over its still-open local API, silently split-brained. A stale lock (dead
      // pid) never blocks: acquireHomeLock already takes those over the moment a daemon actually starts.
      const livePid = livePidHoldingLock(home);
      if (livePid !== null) {
        throw new Error(
          `a live arena daemon (pid ${livePid}) already holds ${home}. Stop it first (kill ${livePid}), or ` +
            "run init against a different ARENA_HOME.",
        );
      }
      // Task 3 fix round 4 (N2, spec §4.3): init holds the home lock for its whole run. Otherwise a daemon could start,
      // and open a channel under the old RPC, between the checks below (the repoint check, the RPC pin) and the
      // write -- while this init waits on a slow RPC. A brand-new ARENA_HOME is created first: the lock file lives in
      // it. A failed first init removes it again (only if still empty), so no empty home is left behind.
      const homeExisted = existsSync(home);
      mkdirSync(home, { recursive: true, mode: 0o700 });
      const lock = acquireHomeLock(home);
      try {
        const explicitFields = ["rpc", "chain-id", "hub", "usdc", "rules"];
        const haveAllExplicit = explicitFields.every((name) => flag(name) !== undefined);
        let template: {
          rpcUrl?: string;
          chainId?: string;
          hub?: string;
          usdc?: string;
          rules?: string;
          faucet?: string;
          cli?: Record<string, unknown>;
          xmtp?: unknown;
        } = {};
        if (!haveAllExplicit) {
          const templatesUrl = `${server.replace(/\/$/, "")}/templates`;
          // init holds the home lock for its whole run (N2), so a stalled server must not hold it for minutes.
          const res = await io.fetch(templatesUrl, { signal: AbortSignal.timeout(RPC_TIMEOUT_MS) });
          if (!res.ok) throw new Error(`fetching ${templatesUrl} failed with status ${res.status}`);
          const list = (await res.json()) as unknown;
          const chess = Array.isArray(list)
            ? (list as Array<Record<string, unknown>>).find((t) => t.id === "chess")
            : undefined;
          if (!chess) throw new Error(`server ${server} offers no chess template`);
          template = {
            rpcUrl: typeof chess.rpcUrl === "string" ? chess.rpcUrl : undefined,
            // Left as a string here (not coerced to a number) so a missing/non-numeric template chainId falls
            // through to the same "--chain-id is required" / NaN-rejecting checks below as a missing flag, instead
            // of silently becoming the string "undefined" or "NaN".
            chainId: chess.chainId === undefined || chess.chainId === null ? undefined : String(chess.chainId),
            hub: typeof chess.hub === "string" ? chess.hub : undefined,
            usdc: typeof chess.usdc === "string" ? chess.usdc : undefined,
            rules: typeof chess.rules === "string" ? chess.rules : undefined,
            // Plan 5.5 Task 1 (Global Constraints): only ever set by a dev server whose faucet guard is fully
            // satisfied -- a real deployment's /templates never carries this key at all.
            faucet: typeof chess.faucet === "string" ? chess.faucet : undefined,
            // Plan 5.6 Task 4 (spec §3): only ever set by a host that has pinned a published CLI version.
            cli: chess.cli !== null && typeof chess.cli === "object" && !Array.isArray(chess.cli) ? (chess.cli as Record<string, unknown>) : undefined,
            // Plan 5.7 Task 4 (spec §5): only ever set by a host that configures the XMTP fallback -- left as raw
            // `unknown` here (not shape-checked) so a malformed value still reaches `parseXmtpConfig` below and
            // fails with that function's own, specific message, instead of being silently dropped. Fix round 1
            // (Minor 5): an explicit JSON `null` (as opposed to the key being omitted) is normalized to
            // `undefined` here -- "the key is absent" and "the key is null" are the same thing to every reader
            // of `template.xmtp` below, matching spec §5's "a server without xmtp removes it" rather than
            // refusing the whole init over a host's harmless `"xmtp": null`.
            xmtp: chess.xmtp ?? undefined,
          };
        }
        const rpcUrl = flag("rpc") ?? template.rpcUrl;
        const chainIdRaw = flag("chain-id") ?? template.chainId;
        const hubRaw = flag("hub") ?? template.hub;
        const usdcRaw = flag("usdc") ?? template.usdc;
        const rulesRaw = flag("rules") ?? template.rules;
        if (!rpcUrl) throw new UsageError("--rpc is required (the server offered no template value)");
        if (!/^https?:\/\//i.test(rpcUrl)) throw new UsageError("--rpc must be an http:// or https:// URL");
        if (!chainIdRaw) throw new UsageError("--chain-id is required (the server offered no template value)");
        const chainId = Number(chainIdRaw);
        if (!Number.isInteger(chainId) || chainId <= 0) {
          throw new UsageError("--chain-id must be a positive integer (the server's template value was not)");
        }
        if (!hubRaw) throw new UsageError("--hub is required (the server offered no template value)");
        if (!usdcRaw) throw new UsageError("--usdc is required (the server offered no template value)");
        if (!rulesRaw) throw new UsageError("--rules is required (the server offered no template value)");
        const asAddress = (name: string, v: string): Address => {
          if (!ADDRESS_RE.test(v)) throw new UsageError(`--${name} must be an address (0x + 40 hex characters)`);
          return v as Address;
        };
        const hub = asAddress("hub", hubRaw);
        const usdc = asAddress("usdc", usdcRaw);
        const rules = asAddress("rules", rulesRaw);
        // Plan 6 (spec §2.5, Review Focus 3): on a chain with a built-in profile (Arc), only the profile's USDC and, once
        // the chain's deployment is pinned, only its hub and rules -- whether they came from /templates or from flags.
        // On every init, fresh or re-run, before any network call (other than a --server's /templates) and before
        // anything is written. Other chains keep the warnings below (`knownDeploymentWarnings`).
        const pinnedRefusals = pinnedDeploymentRefusals(chainId, { hub, rules, usdc });
        if (pinnedRefusals.length > 0) {
          const name = chainProfile(chainId)?.name ?? `chain ${chainId}`;
          throw new Error(
            `refusing to init on ${name} (chain ${chainId}): ${pinnedRefusals.join("; ")}. Deposits go to the hub this ` +
              `config names, so on ${name} only the CLI's own pinned addresses are accepted, whatever the server publishes`,
          );
        }
        // Plan 6 (spec §2.3): on a chain with a profile, a fee ceiling under its fee floor is refused -- before any RPC
        // call and before anything is written. Arc's mempool drops a transaction under the floor without an error.
        // Absent, the ceiling is the profile's (`feeCeilingOf`), and nothing is written for it.
        const feeCeilingWei = flag("fee-ceiling-wei") !== undefined ? BigInt(flag("fee-ceiling-wei")!) : undefined;
        const profile = chainProfile(chainId);
        if (profile !== undefined && feeCeilingWei !== undefined && feeCeilingWei < profile.minFeePerGas) {
          throw new UsageError(
            `--fee-ceiling-wei ${feeCeilingWei} is under ${profile.name}'s fee floor of ${profile.minFeePerGas} wei per gas: ` +
              `a transaction under it is dropped without an error and never lands. Leave it out (default ` +
              `${profile.feeCeilingWei}), or pass at least ${profile.minFeePerGas}`,
          );
        }
        // Task 3 fix round 1 (I3, spec §4.3): a re-init never repoints the money. This home's wallet approves and
        // deposits to `hub` on `chainId`; letting a re-init (an injected "the arena moved: run init ...") swap the
        // hub, token, rules or chain would send deposits somewhere else, past the owner lock entirely. serverUrl may
        // still change; rpcUrl only once no channel is open (fix round 3, below). Checked before any network call (other
        // than a --server's /templates), and before anything is written.
        let prior: { chainId?: unknown; hub?: unknown; usdc?: unknown; rules?: unknown; rpcUrl?: unknown } | null;
        try {
          prior = readJson<{ chainId?: unknown; hub?: unknown; usdc?: unknown; rules?: unknown; rpcUrl?: unknown }>(arenaPaths(home).config);
        } catch (err) {
          throw new Error(
            `cannot read ${arenaPaths(home).config} (${err instanceof Error ? err.message.split("\n")[0] : String(err)}): fix or remove it first`,
          );
        }
        if (prior !== null) {
          const sameAddress = (a: unknown, b: Address) => typeof a === "string" && a.toLowerCase() === b.toLowerCase();
          const changed = [
            ...(prior.chainId === chainId ? [] : ["chainId"]),
            ...(sameAddress(prior.hub, hub) ? [] : ["hub"]),
            ...(sameAddress(prior.usdc, usdc) ? [] : ["usdc"]),
            ...(sameAddress(prior.rules, rules) ? [] : ["rules"]),
          ];
          if (changed.length > 0) {
            throw new Error(
              `this home's funds are bound to hub ${String(prior.hub)} on chain ${String(prior.chainId)}; withdraw to your owner, ` +
                `then use a fresh ARENA_HOME (refusing to change ${changed.join(", ")})`,
            );
          }
          // Task 3 fix round 3: the RPC is this daemon's only view of its channels (phases, challenges, deadlines) and
          // its only way to broadcast a respond. While a channel is still live, a new RPC that hides a challenge (or
          // drops the answer) lets a stale state finalize against this player -- so the RPC, whether from --rpc or
          // from a new --server's /templates, may change only once every channel record is finalized. A record that
          // cannot be read counts as open: it cannot be shown to be settled.
          if (prior.rpcUrl !== rpcUrl) {
            const open = new RecordStore(home)
              .scanChannels()
              .filter((e) => e.record === null || e.record.finalized !== true)
              .map((e) => e.channelId);
            if (open.length > 0) {
              throw new Error(
                `refusing to change the RPC from ${String(prior.rpcUrl)} to ${rpcUrl} while ${open.length} channel(s) are not ` +
                  `finalized (${open.join(", ").slice(0, 300)}): an RPC that hides a challenge can cost an open channel its ` +
                  `funds. Finish or close the open channels first, or keep the current RPC (--rpc ${String(prior.rpcUrl)})`,
              );
            }
          }
        }
        const fromServer = !haveAllExplicit;
        if (fromServer && /^http:\/\//i.test(server) && !isLoopbackUrl(server)) {
          io.err(
            `warning: ${server} is plain http: anyone on the path can rewrite the contract addresses and RPC it ` +
              "hands you. Use https, or pass --rpc/--hub/--usdc/--rules explicitly.",
          );
        }
        // I8, and Task 3 fix round 1 (I3): the RPC serves `chainId` and the hub, the USDC token and the rules all hold
        // code -- checked even when every chain flag is explicit (an EOA "hub" would otherwise reach approve/deposit
        // unverified).
        await verifyChain(io, rpcUrl, chainId, { hub, usdc, rules });
        // Final review I2: on a chain with a known canonical deployment, a different hub or rules is loud.
        for (const w of knownDeploymentWarnings(chainId, { hub, rules, usdc })) io.err(w);
        // Final review C1: the session key's dispute gas is derived from the chain unless given. A key that cannot pay
        // for a respond cannot answer a stale challenge, and an unanswered one can roll the channel back.
        // Plan 6 (spec §2.4; the audit-journey I-4 ruling): on a chain with a profile, k x G x the profile's fee ceiling
        // -- 0.336 USDC on Arc -- with no RPC call. Arc's gas price never falls under its floor, so 4 x it always won.
        let sessionGasWei: bigint;
        if (flag("session-gas-wei") !== undefined) sessionGasWei = BigInt(flag("session-gas-wei")!);
        else if (profile !== undefined) sessionGasWei = profileSessionGasWei(profile);
        else {
          const price = await rpcCall(io, rpcUrl, "eth_gasPrice", []);
          if (typeof price !== "string" || !/^0x[0-9a-fA-F]{1,64}$/.test(price)) {
            throw new Error(`RPC ${rpcUrl} returned a malformed eth_gasPrice: ${JSON.stringify(price)?.slice(0, 80)} (or pass --session-gas-wei)`);
          }
          sessionGasWei = defaultSessionGasWei(feeCeilingWei ?? DEFAULT_FEE_CEILING_WEI, BigInt(price));
        }
        // Plan 5 Task 1: a floor above the target would refill to a target the check itself never sees as "enough".
        const sessionGasFloor = flag("session-gas-floor") !== undefined ? BigInt(flag("session-gas-floor")!) : undefined;
        if (sessionGasFloor !== undefined && sessionGasFloor > sessionGasWei) {
          throw new UsageError(`--session-gas-floor (${sessionGasFloor}) must not exceed --session-gas-wei (${sessionGasWei})`);
        }
        // Final fix wave (I1): on unless explicitly turned off.
        const autoReturnRaw = flag("auto-return-on-challenge");
        if (autoReturnRaw !== undefined && autoReturnRaw !== "true" && autoReturnRaw !== "false") {
          throw new UsageError("--auto-return-on-challenge must be true or false");
        }
        const autoReturn = autoReturnRaw === undefined ? undefined : autoReturnRaw === "true";

        // Plan 5.6 Task 3 (spec §4.3, Review Focus 3): the owner, settled before anything is written. A re-init must
        // never reset it: without --owner the recorded owner (and its ownerNonce) is carried over as is; --owner may
        // only record a first owner or repeat the current one -- a change is refused here, pointing at `owner set
        // --signature` (fix round 1, I2). Settling it ahead of initHome means a refusal leaves config.json as it was.
        const paths = arenaPaths(home);
        const currentOwner = readRecordedOwner(home); // throws on an unreadable config.json rather than drop the lock
        const { privateKeyToAccount, generatePrivateKey } = await import("viem/accounts");
        // The key initHome will use (an existing wallet.json always wins, as before), chosen here so the wallet's own
        // address is known -- and forbidden as an owner -- before anything is written.
        const walletKey: Hex =
          readJson<{ key: Hex }>(paths.wallet)?.key ?? (flag("wallet-key") as Hex | undefined) ?? generatePrivateKey();
        const walletAddress = privateKeyToAccount(walletKey).address;
        const existingCfg = readJson<{ owner?: unknown; ownerNonce?: unknown; xmtp?: unknown }>(paths.config);
        let owner: unknown = existingCfg?.owner ?? undefined; // kept verbatim
        // Fix round 1 (I2): a re-init must never reset the nonce either -- back at 0, a signature from an earlier
        // change (A→B at nonce 0, after B→A) would verify again.
        const ownerNonce = existingCfg ? ownerNonceOf(existingCfg) : 0;
        const ownerFlag = flag("owner");
        if (ownerFlag !== undefined) {
          const { owner: requested, kind } = classifyOwner(currentOwner, ownerFlag, forbiddenOwners(home, { hub, usdc, rules }, walletAddress));
          if (kind === "change") {
            throw new Error(
              `the owner is already set to ${currentOwner}; init never changes it. Run "${CLI_COMMAND} owner set ${requested}" ` +
                "for the message the current owner must sign, then run it again with --signature",
            );
          }
          owner = requested;
        }

        // Plan 5.6 Task 4 (spec §3) and the final fix wave (C1): the version gate, run only after every other refusal
        // (the chain/hub/usdc/rules repoint check, the RPC pin, the code checks, the owner rules), so a host with other
        // contracts is refused before any install hint can appear. `hostCliVerdict` validates the host's `cli` entry
        // before anything derived from it is printed, never echoes a raw value, and -- in the bundle -- refuses a host
        // that pins a package other than this build's own. Still before anything is written.
        let cliUpgrade: string | undefined;
        if (template.cli !== undefined) {
          const verdict = hostCliVerdict(template.cli, { ownPackage: cliPackage(), current: cliVersion(), server });
          if ("refusal" in verdict) throw new Error(verdict.refusal);
          cliUpgrade = verdict.upgrade;
        }

        // Plan 5.7 Task 4 (spec §5), fix round 1 (Important 1 / Ruling 1): the host's `xmtp` config, copied
        // verbatim from /templates when a template was actually fetched this run. Re-init against an updated
        // template updates it; re-init against a server that stopped publishing it drops it (spec §5: "a server
        // without xmtp removes it") -- both correct because `cfg` below is built fresh either way. But when
        // every chain flag was given explicitly, /templates is never fetched at all (haveAllExplicit, above) --
        // that run says nothing whatsoever about xmtp one way or the other, so it must carry forward whatever is
        // already cached, exactly like `owner`/`ownerNonce` just above, rather than silently dropping it (the
        // ruling this fixes: "a re-init must never silently turn the fallback off"). Validation is always
        // `loadConfig`'s own (`parseXmtpConfig`): a host -- or a config.json -- that holds something invalid
        // refuses the whole init, before anything is written.
        let xmtp: XmtpConfig | undefined;
        if (template.xmtp !== undefined) {
          try {
            xmtp = parseXmtpConfig(template.xmtp);
          } catch (err) {
            throw new Error(`server ${server} published an invalid xmtp config: ${err instanceof Error ? err.message : String(err)}`);
          }
        } else if (haveAllExplicit && existingCfg?.xmtp !== undefined) {
          try {
            xmtp = parseXmtpConfig(existingCfg.xmtp);
          } catch (err) {
            throw new Error(`the cached xmtp config in ${paths.config} is invalid: ${err instanceof Error ? err.message : String(err)}`);
          }
        }

        const cfg: ArenaConfig = {
          rpcUrl,
          chainId,
          hub,
          usdc,
          rules,
          serverUrl: server,
          port: Number(flag("port") ?? "7070"),
          maxFeePerPlayer: BigInt(flag("max-fee") ?? "10000"),
          sessionGasWei,
          ...(sessionGasFloor !== undefined ? { sessionGasFloor } : {}),
          pollMs: Number(flag("poll-ms") ?? "2000"),
          logChunkBlocks: Number(flag("log-chunk-blocks") ?? String(DEFAULT_LOG_CHUNK_BLOCKS)),
          ...(feeCeilingWei !== undefined ? { feeCeilingWei } : {}),
          ...(flag("min-challenge-timeout") !== undefined ? { minChallengeTimeout: BigInt(flag("min-challenge-timeout")!) } : {}),
          ...(autoReturn !== undefined ? { autoReturnOnChallenge: autoReturn } : {}),
          ...(owner !== undefined && owner !== null ? { owner: owner as Address } : {}),
          ...(ownerNonce !== 0 ? { ownerNonce } : {}),
          ...(xmtp !== undefined ? { xmtp } : {}),
        };
        initHome(home, cfg, walletKey);
        const summary: Record<string, unknown> = {
          home,
          wallet: walletAddress,
          port: cfg.port,
          rpcUrl,
          chainId,
          hub,
          usdc,
          rules,
          sessionGasWei: cfg.sessionGasWei.toString(),
          owner: cfg.owner ?? null,
        };
        if (fromServer) {
          summary.trust =
            `these contract addresses and the RPC come from ${server}; verify them against a source you trust, ` +
            "or pass --rpc/--hub/--usdc/--rules explicitly";
        }
        // Plan 5.6 Task 4 (spec §3): only when this CLI is older than the host's published `cli.version` (but not
        // below `minVersion`, which refuses outright above) -- equal versions, or no `cli` configured, leave no
        // `cliUpgrade` key at all.
        if (cliUpgrade !== undefined) summary.cliUpgrade = cliUpgrade;
        // Plan 5.5 Task 1: only when the template actually advertised a faucet (a real deployment's /templates
        // never does) -- a server without one leaves `summary` with no `faucet` key at all. `--no-faucet` turns
        // this off without reading the balance or reaching the faucet. A faucet failure is reported here, never
        // thrown: auto-funding is a convenience, not a reason to fail `init`.
        if (template.faucet !== undefined) {
          if (flags.has("no-faucet")) {
            summary.faucet = "skipped: --no-faucet";
          } else {
            try {
              const balance = await usdcBalanceOf(io, rpcUrl, usdc, walletAddress);
              if (balance < FAUCET_MIN_USDC_BALANCE) {
                // Plan 5.6 Task 2: the call itself (origin pin, timeout, redirect refusal, payload shape) now
                // lives in the shared callFaucet, used by `fund` too.
                const funded = await callFaucet(io, template.faucet, server, walletAddress);
                // Plan 5.5 Task 3 carry-forward: formatted the same way `arena wallet` does rather than passed
                // through unchanged, so a human (or agent) reading init's own summary sees "100.000000"/"1.0",
                // not "100000000"/"1000000000000000000".
                summary.faucet = { usdc: formatUsdc6(funded.usdc), native: formatNativeBalance(funded.native) };
              } else {
                summary.faucet = "skipped: balance already at or above 20 USDC";
              }
            } catch (err) {
              summary.faucet = `skipped: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`;
            }
          }
        }
        io.out(JSON.stringify(summary, null, 2));
        // H2 fix round 1 (review m-7): `init --owner` records the owner too, so on Arc it gets `owner set`'s note, on
        // stderr, with the summary on stdout unchanged.
        const initProfile = chainProfile(chainId);
        if (ownerFlag !== undefined && initProfile !== undefined) io.err(ownerNetworkNote(initProfile.name, chainId));
        return 0;
      } finally {
        lock.release();
        if (!homeExisted) {
          try {
            rmdirSync(home); // fails (ENOTEMPTY) once initHome has written: then the home stays, as it should
          } catch {
            // not empty: init got far enough to write it
          }
        }
      }
    }

    if (cmd === "daemon") {
      if (arg !== undefined && arg !== "start") throw new UsageError(`unknown daemon subcommand ${arg}`);
      const proc = await startDaemonProcess(home, { log: io.err });
      // Plan 5 Task 2 fix round, CRITICAL 1: no token anywhere in this line -- see daemonStartLine's own
      // docstring. Run `arena board` for a board link with a one-time code.
      io.out(JSON.stringify(daemonStartLine({ apiUrl: proc.apiUrl, pid: process.pid, wallet: proc.daemon.wallet.address, fallback: proc.fallback })));
      await new Promise<void>((resolve) => {
        const stop = () => {
          // Only one of SIGINT/SIGTERM fires; `process.once` alone would leave the other one's listener
          // registered forever. Remove both here, whichever one triggered the shutdown.
          process.removeListener("SIGINT", stop);
          process.removeListener("SIGTERM", stop);
          proc.stop().then(resolve, resolve);
        };
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
      });
      return 0;
    }

    if (cmd === "board") {
      // Final fix wave (M1): the link carries a one-time code, never the token -- a browser keeps every URL it
      // opens in its history (and omnibox autocomplete, and maybe cloud sync), which replaceState cannot undo.
      // The running daemon mints the code (POST /board/code, with the token read from disk); the board trades it
      // once for the token, which it keeps in memory only. The code expires 120 s after it is minted.
      const cfg = loadConfig(home, { warn: io.err });
      const token = loadToken(home);
      let res: Response;
      try {
        res = await io.fetch(`http://127.0.0.1:${cfg.port}/board/code`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        });
      } catch {
        throw new Error(`cannot reach the daemon on 127.0.0.1:${cfg.port}: start it with "${CLI_COMMAND} daemon", then run "${CLI_COMMAND} board" again`);
      }
      const payload = (await res.json().catch(() => ({}))) as { code?: unknown; error?: string };
      if (!res.ok || typeof payload.code !== "string") {
        io.err(`error: ${payload.error ?? res.statusText}`);
        return 1;
      }
      io.out(`http://127.0.0.1:${cfg.port}/board#code=${payload.code}`);
      return 0;
    }

    if (cmd === "wallet") {
      // Plan 5.5 Task 1: reads the chain directly (no daemon, no token) -- useful whether or not one is running.
      const cfg = loadConfig(home, { warn: io.err });
      const { privateKeyToAccount } = await import("viem/accounts");
      const address = privateKeyToAccount(loadWalletKey(home)).address;
      // Plan 6 (spec §2.1, Review Focus 1): on a chain whose gas is USDC (`nativeIsUsdc`), USDC and gas are one
      // balance. Its source of truth is the native balance (18 decimals), read alone and shown as `usdc` rounded down
      // to 6 decimal places; there is no `native` key. Every other chain reads and prints both, exactly as before.
      const profile = chainProfile(cfg.chainId);
      const oneBalance = profile?.nativeIsUsdc === true;
      const readBalances = async (): Promise<{ usdc: bigint; native: bigint | undefined }> => {
        if (oneBalance) return { usdc: weiToUsdc6Down(await nativeBalanceOf(io, cfg.rpcUrl, address)), native: undefined };
        const usdc = await usdcBalanceOf(io, cfg.rpcUrl, cfg.usdc, address);
        const native = await nativeBalanceOf(io, cfg.rpcUrl, address);
        return { usdc, native };
      };
      const shown = (b: { usdc: bigint; native: bigint | undefined }) => ({
        address,
        chainId: cfg.chainId,
        usdc: formatUsdc6(b.usdc),
        ...(b.native !== undefined ? { native: formatNativeBalance(b.native) } : {}),
      });

      const waitUsdcRaw = flag("wait-for-usdc");
      const waitNativeRaw = flag("wait-for-native");
      if (waitUsdcRaw === undefined && waitNativeRaw === undefined) {
        io.out(JSON.stringify(shown(await readBalances()), null, 2));
        return 0;
      }

      // Plan 5.6 Task 2 (spec §4.2, Review Focus 2): spec §4.2's exit codes are an exhaustive partition -- 0
      // once reached, 2 on an actual elapsed timeout, 1 on error -- so every input problem on this path
      // (a malformed --wait-for-* amount, a malformed --timeout, or one outside [1, 3600]) is deliberately a
      // plain Error, not this CLI's usual UsageError (exit 2): an agent that sees exit 2 here must read it as
      // "timed out, not malfunctioned", never as "bad flags", so no input mistake may share that code.
      // Plan 6: a one-balance chain has no separate native gas to wait for (exit 1, like every input problem here).
      if (oneBalance && waitNativeRaw !== undefined) {
        throw new Error(
          `--wait-for-native does not apply on ${profile?.name ?? `chain ${cfg.chainId}`}: its gas is paid in USDC, from the same balance -- use --wait-for-usdc`,
        );
      }
      let usdcThreshold: bigint | undefined;
      if (waitUsdcRaw !== undefined) {
        if (!/^[0-9]+(\.[0-9]{1,6})?$/.test(waitUsdcRaw)) {
          throw new Error("--wait-for-usdc must be a non-negative USDC amount with at most 6 decimal places");
        }
        usdcThreshold = parseUnits(waitUsdcRaw, 6);
      }
      let nativeThreshold: bigint | undefined;
      if (waitNativeRaw !== undefined) {
        if (!/^[0-9]+(\.[0-9]{1,18})?$/.test(waitNativeRaw)) {
          throw new Error("--wait-for-native must be a non-negative native amount with at most 18 decimal places");
        }
        nativeThreshold = parseUnits(waitNativeRaw, 18);
      }
      const timeoutRaw = flag("timeout") ?? "1800";
      if (!/^[0-9]+$/.test(timeoutRaw)) throw new Error("--timeout must be a non-negative integer number of seconds");
      const timeoutSeconds = Number(timeoutRaw);
      if (timeoutSeconds < 1 || timeoutSeconds > 3600) {
        throw new Error(`--timeout must be between 1 and 3600 seconds (the maximum is 3600s); got ${timeoutSeconds}`);
      }
      const timeoutMs = timeoutSeconds * 1000;
      // A hidden test knob (Task 2 brief): production always polls every 5s. Final fix wave (M8): never faster than
      // every 200 ms -- this is the RPC the watchtower depends on, and a provider that rate-limits or bans this
      // machine for a 1 ms poll degrades dispute handling.
      const pollMsRaw = io.env.ARENA_WAIT_POLL_MS;
      const pollMs = pollMsRaw !== undefined && /^[0-9]+$/.test(pollMsRaw) ? Math.max(WAIT_POLL_FLOOR_MS, Number(pollMsRaw)) : 5000;

      const startedAt = Date.now();
      for (;;) {
        const balances = await readBalances();
        const reached =
          (usdcThreshold === undefined || balances.usdc >= usdcThreshold) &&
          (nativeThreshold === undefined || (balances.native !== undefined && balances.native >= nativeThreshold));
        const elapsedMs = Date.now() - startedAt;
        const body = { ...shown(balances), reached, waitedSeconds: Math.floor(elapsedMs / 1000) };
        if (reached) {
          io.out(JSON.stringify(body, null, 2));
          return 0;
        }
        if (elapsedMs >= timeoutMs) {
          io.out(JSON.stringify(body, null, 2));
          return 2;
        }
        await new Promise((r) => setTimeout(r, Math.min(pollMs, timeoutMs - elapsedMs)));
      }
    }

    if (cmd === "faucet") {
      // Plan 5.5 Task 1: calls the host server's dev faucet for this wallet explicitly (no daemon needed).
      const cfg = loadConfig(home, { warn: io.err });
      const { privateKeyToAccount } = await import("viem/accounts");
      const address = privateKeyToAccount(loadWalletKey(home)).address;
      const faucetUrl = `${cfg.serverUrl.replace(/\/$/, "")}/faucet`;
      let res: Response;
      try {
        res = await io.fetch(faucetUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ address }),
        });
      } catch (err) {
        io.err(`error: cannot reach ${faucetUrl}: ${err instanceof Error ? err.message : String(err)}`);
        return 1;
      }
      const payload = (await res.json().catch(() => ({}))) as { error?: string; retryAfterSeconds?: unknown };
      if (!res.ok) {
        // M2: a 429 carries retryAfterSeconds (the server's own cooldown) -- this is exactly the command
        // skill.md's session-gas-low troubleshooting sends an agent to, so drop it on the floor here and the
        // agent has nothing to tell a human but "try again sometime".
        const retry = res.status === 429 && typeof payload.retryAfterSeconds === "number" ? ` (retry in ${payload.retryAfterSeconds}s)` : "";
        const message = res.status === 404 ? "server advertises no faucet (not a dev server)" : payload.error ?? res.statusText;
        io.err(`error: ${message}${retry}`);
        return 1;
      }
      // M2: formatted like `arena wallet`, not the server's raw base-unit strings -- consistent with every
      // other amount this CLI prints to a human (or agent) rather than to another program.
      const faucetPayload = payload as unknown as { address?: unknown; usdc?: unknown; native?: unknown };
      const decStr = /^[0-9]+$/;
      if (
        typeof faucetPayload.usdc !== "string" ||
        !decStr.test(faucetPayload.usdc) ||
        typeof faucetPayload.native !== "string" ||
        !decStr.test(faucetPayload.native)
      ) {
        io.err(`error: faucet ${faucetUrl} answered with a malformed amount: ${JSON.stringify(payload)}`);
        return 1;
      }
      io.out(
        JSON.stringify(
          { address: faucetPayload.address, usdc: formatUsdc6(BigInt(faucetPayload.usdc)), native: formatNativeBalance(BigInt(faucetPayload.native)) },
          null,
          2,
        ),
      );
      return 0;
    }

    if (cmd === "fund") {
      // Plan 5.6 Task 2 (spec §4.1): works out what to ask the human for -- no daemon needed. Every flag is checked
      // before anything is read, so a usage error never costs a network call.
      // Final fix wave (K1, I2): `--offer <offerId>` sizes the ask from one open offer on the server's public lobby
      // (its own deposit and stake, so the agent never converts the base units `offers` prints); it replaces
      // `--deposit` and `--stake`, and `--games` (optional with it) only shapes the message.
      const offerRaw = flag("offer");
      if (offerRaw !== undefined) {
        for (const other of ["deposit", "stake"]) {
          if (flags.has(other)) throw new UsageError(`--offer and --${other} are mutually exclusive: --offer uses the offer's own ${other === "stake" ? "stake" : "deposit"}`);
        }
        if (!/^0x[0-9a-fA-F]{64}$/.test(offerRaw)) throw new UsageError("--offer must be an offer id (0x followed by 64 hex characters), as offers lists it");
      }
      let games: bigint | undefined;
      const gamesRaw = offerRaw !== undefined ? flag("games") : need("games");
      if (gamesRaw !== undefined) {
        // Final fix wave (M10): 0 is not a positive number of games.
        if (!/^[0-9]+$/.test(gamesRaw) || BigInt(gamesRaw) === 0n) throw new UsageError("--games must be a positive whole number of games");
        games = BigInt(gamesRaw);
      }
      let stake: bigint | undefined;
      if (offerRaw === undefined) {
        const stakeRaw = need("stake");
        if (!/^[0-9]+(\.[0-9]{1,6})?$/.test(stakeRaw) || parseUnits(stakeRaw, 6) === 0n) {
          throw new UsageError("--stake must be a positive USDC amount with at most 6 decimal places");
        }
        stake = parseUnits(stakeRaw, 6);
      }
      let explicitDeposit: bigint | undefined;
      const depositRaw = flag("deposit");
      if (depositRaw !== undefined) {
        if (!/^[0-9]+(\.[0-9]{1,6})?$/.test(depositRaw)) {
          throw new UsageError("--deposit must be a non-negative USDC amount with at most 6 decimal places");
        }
        explicitDeposit = parseUnits(depositRaw, 6);
      }

      const cfg = loadConfig(home, { warn: io.err });
      const { privateKeyToAccount } = await import("viem/accounts");
      const address = privateKeyToAccount(loadWalletKey(home)).address;

      // Read /templates for the chess template's deposit cap and (optional) faucet -- same shape init reads,
      // but fund needs no other field from it (the chain settings already live in this home's config.json).
      const templatesUrl = `${cfg.serverUrl.replace(/\/$/, "")}/templates`;
      let tres: Response;
      try {
        tres = await io.fetch(templatesUrl, { signal: AbortSignal.timeout(RPC_TIMEOUT_MS) });
      } catch (err) {
        throw new Error(`fetching ${templatesUrl} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (!tres.ok) throw new Error(`fetching ${templatesUrl} failed with status ${tres.status}`);
      const list = (await tres.json()) as unknown;
      const chess = Array.isArray(list) ? (list as Array<Record<string, unknown>>).find((t) => t.id === "chess") : undefined;
      if (!chess) throw new Error(`server ${cfg.serverUrl} offers no chess template`);
      const limits = chess.limits as { maxDepositPerPlayer?: unknown } | null | undefined;
      if (!limits || typeof limits.maxDepositPerPlayer !== "string" || !/^[0-9]+$/.test(limits.maxDepositPerPlayer)) {
        throw new Error(`server ${cfg.serverUrl} published no usable deposit cap (/templates' limits.maxDepositPerPlayer)`);
      }
      const cap = BigInt(limits.maxDepositPerPlayer);
      const faucetUrl = typeof chess.faucet === "string" ? chess.faucet : undefined;

      // Final fix wave (K1): the chosen offer, from the server's public lobby (the same list the daemon's `offers`
      // shows, in the server's own {"$bigint": ...} wire format). Only its deposit and stake are used, to size the
      // ask; the daemon still re-reads and verifies the offer when it is accepted.
      let offerId: Hex | undefined;
      if (offerRaw !== undefined) {
        const offersUrl = `${cfg.serverUrl.replace(/\/$/, "")}/offers`;
        let ores: Response;
        try {
          ores = await io.fetch(offersUrl, { signal: AbortSignal.timeout(RPC_TIMEOUT_MS) });
        } catch (err) {
          throw new Error(`fetching ${offersUrl} failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        if (!ores.ok) throw new Error(`fetching ${offersUrl} failed with status ${ores.status}`);
        let listed: unknown;
        try {
          listed = decodeWire(await ores.text());
        } catch {
          throw new Error(`server ${cfg.serverUrl} answered ${offersUrl} with a malformed body`);
        }
        if (!Array.isArray(listed)) throw new Error(`server ${cfg.serverUrl} answered ${offersUrl} with something other than a list`);
        const wanted = offerRaw.toLowerCase();
        let found: SignedOffer | undefined;
        for (const entry of listed) {
          let so: SignedOffer;
          try {
            so = parseSignedOffer(entry);
          } catch {
            continue; // not a well-formed signed offer (the daemon's own listOffers drops these too)
          }
          if (computeOfferId(so.offer).toLowerCase() === wanted) {
            found = so;
            break;
          }
        }
        if (found === undefined) throw new Error(`offer ${offerRaw} is not open any more; run offers again`);
        offerId = wanted as Hex;
        explicitDeposit = found.offer.deposit;
        stake = found.offer.stakePerGame;
        // Only the message's "enough to play N games" uses N here: by default, as many games as the deposit covers.
        games ??= stake > 0n && explicitDeposit >= stake ? explicitDeposit / stake : 1n;
      }
      if (stake === undefined || games === undefined) throw new Error("fund: internal error: no stake or games"); // unreachable
      const fundStake: bigint = stake;
      const fundGames: bigint = games;
      // Final fix wave (I2): the range error is in whole USDC already; say which input it was about.
      const rangeHint =
        offerRaw !== undefined
          ? `; offer ${offerId}'s deposit is outside this host's current cap -- pick another offer`
          : depositRaw !== undefined
            ? " (--deposit takes whole USDC)"
            : "";
      // Plan 6 (spec §2.1, Review Focus 1): on a chain whose gas is USDC (`nativeIsUsdc`), one balance -- the native
      // one, read alone -- and one ask: the gas is folded into `usdc.need`, and there is no `native`. Every other
      // chain reads both balances and asks for both, exactly as before.
      const oneBalance = chainProfile(cfg.chainId)?.nativeIsUsdc === true;
      // Fix round 1 (spec §2.1 as amended, audit-daemon I-5): on such a chain, this home's channels that are not
      // finalized each keep one sessionGasWei of the same balance for their refills, so the ask includes it
      // (`usdc.reserved`) -- the daemon's opening gates refuse a new channel that would spend it. No daemon needed: the
      // records on disk. A record that cannot be read is not counted (the daemon cannot open it either).
      const unsettledChannels = oneBalance ? new RecordStore(home).channels().filter((r) => !r.finalized).length : 0;
      const sized = <T>(compute: () => T): T => {
        try {
          return compute();
        } catch (err) {
          if (err instanceof RangeError) throw new Error(`${err.message}${rangeHint}`);
          throw err;
        }
      };
      const readNeed = async (): Promise<FundingNeed | OneBalanceFundingNeed> => {
        const common = {
          games: fundGames,
          stake: fundStake,
          deposit: explicitDeposit,
          cap,
          feePerPlayer,
          sessionGasWei: cfg.sessionGasWei,
          feeCeilingWei,
        };
        if (oneBalance) {
          const balanceWei = await nativeBalanceOf(io, cfg.rpcUrl, address);
          return sized(() => computeOneBalanceFundingNeed({ ...common, balanceWei, unsettledChannels }));
        }
        const usdcHave = await usdcBalanceOf(io, cfg.rpcUrl, cfg.usdc, address);
        const nativeHave = await nativeBalanceOf(io, cfg.rpcUrl, address);
        return sized(() => computeFundingNeed({ ...common, usdcHave, nativeHave }));
      };

      const feePerPlayerRaw = await rpcCall(io, cfg.rpcUrl, "eth_call", [
        { to: cfg.hub, data: encodeFunctionData({ abi: channelHubAbi, functionName: "feePerPlayer" }) },
        "latest",
      ]);
      // Fix round 1 (Important): `init` checks the hub's code on every run (since Task 3 fix round 1, I3), but a
      // home written before that, or a hand-edited config.json, can still name a hub with no code. A no-code
      // address answers eth_call with "0x", not a revert, and
      // `hexToBigIntOrThrow` would silently turn that into a fee of 0n, under-asking the human by the real fee
      // (Review Focus 1). Reject it by name instead of trusting a zero read.
      if (feePerPlayerRaw === "0x") {
        throw new Error(
          `the hub at ${cfg.hub} has no contract code on chain ${cfg.chainId} -- re-run "${CLI_COMMAND} init" against ` +
            "the server (or pass --hub explicitly) before funding",
        );
      }
      const feePerPlayer = hexToBigIntOrThrow(feePerPlayerRaw, `RPC ${cfg.rpcUrl} eth_call (feePerPlayer)`);
      // Plan 6 (spec §2.4): the daemon's own wallet ceiling -- the profile's on Arc -- so this ask matches its gates.
      const feeCeilingWei = feeCeilingOf(cfg);

      let funding = await readNeed();

      // spec §4.1: call the faucet (as init does) only when something is actually short and the template
      // advertises one; never fails fund -- a failed top-up just leaves the shortfall for the human to cover.
      let faucetReported: { usdc: string; native?: string } | string | undefined;
      if ((funding.usdc.shortfall > 0n || ("native" in funding && funding.native.shortfall > 0n)) && faucetUrl !== undefined) {
        try {
          const funded = await callFaucet(io, faucetUrl, cfg.serverUrl, address);
          // Fix round 1 (m-6): on a one-balance chain, USDC only, like the rest of this output.
          faucetReported = oneBalance
            ? { usdc: formatUsdc6(funded.usdc) }
            : { usdc: formatUsdc6(funded.usdc), native: formatNativeBalance(funded.native) };
          funding = await readNeed();
        } catch (err) {
          faucetReported = `skipped: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`;
        }
      }

      // Plan 5.6 Task 3: the owner recorded in config.json (`arena owner set` / `init --owner`), or null.
      const owner = cfg.owner ?? null;
      const message = fundMessage(funding, { address, chainId: cfg.chainId, ownerSet: owner !== null, games: fundGames, stake: fundStake });

      const body: Record<string, unknown> = {
        address,
        chainId: cfg.chainId,
        // Final fix wave (K1): only with --offer -- the offer sized for, and its stake in whole USDC.
        ...(offerId !== undefined ? { offerId, stakePerGame: formatUsdc6(fundStake) } : {}),
        deposit: formatUsdc6(funding.deposit),
        feePerPlayer: formatUsdc6(funding.feePerPlayer),
        usdc: {
          have: formatUsdc6(funding.usdc.have),
          need: formatUsdc6(funding.usdc.need),
          shortfall: formatUsdc6(funding.usdc.shortfall),
          // Fix round 1 (I-5): one-balance chains only -- the part of `need` kept for the other unsettled channels.
          ...("reserved" in funding.usdc ? { reserved: formatUsdc6(funding.usdc.reserved) } : {}),
        },
        // Plan 6: absent on a one-balance chain, whose gas is in `usdc` above.
        ...("native" in funding
          ? {
              native: {
                have: formatNativeBalance(funding.native.have),
                need: formatNativeBalance(funding.native.need),
                shortfall: formatNativeBalance(funding.native.shortfall),
              },
            }
          : {}),
        owner,
      };
      if (faucetReported !== undefined) body.faucet = faucetReported;
      body.message = message;
      io.out(JSON.stringify(body, null, 2));
      return 0;
    }

    if (cmd === "owner") {
      // Plan 5.6 Task 3 (spec §4.3). Read-only without a subcommand: a home with no config (or no owner) is null.
      if (arg === undefined) {
        io.out(JSON.stringify({ owner: readRecordedOwner(home) }));
        return 0;
      }
      if (arg !== "set") throw new UsageError(`unknown owner subcommand ${arg}`);
      const addr = positional[2];
      if (addr === undefined) throw new UsageError("owner set needs an address");
      await setOwner(home, addr, io, CLI_COMMAND, flag("signature"));
      io.out(JSON.stringify({ owner: readRecordedOwner(home) }));
      // Plan 6 hardening H2 (audit-journey C-2): on Arc, the confirmation says the owner must be an address the human
      // controls on Arc. On stderr, so stdout stays the same `{owner}` JSON on every chain.
      const ownerChainId = loadConfig(home).chainId;
      const ownerProfile = chainProfile(ownerChainId);
      if (ownerProfile !== undefined) io.err(ownerNetworkNote(ownerProfile.name, ownerChainId));
      return 0;
    }

    if (cmd === "withdraw") {
      // Plan 5.6 Task 3 (spec §4.4): always through a daemon -- the one that owns this wallet's transaction
      // ordering (`SerialTxSender`) -- and always to the owner the daemon reads from config.json itself: nothing
      // here, and nothing in the request, names a destination.
      // Fix round 1 (M2, spec §4.4): so a destination the caller tries to name (`--to 0x…`, a bare address) -- or
      // any other flag -- is a usage error, never silently ignored: a confused agent must not report "sent to X".
      const unexpected = [...positional.slice(1), ...[...flags.keys()].filter((k) => k !== "amount" && k !== "all").map((k) => `--${k}`)];
      if (unexpected.length > 0) {
        throw new UsageError(
          `withdraw always pays the recorded owner; it takes no destination (unexpected: ${unexpected.join(" ").slice(0, 120)})`,
        );
      }
      const all = flags.has("all");
      const amountRaw = flag("amount");
      if (all === (amountRaw !== undefined)) throw new UsageError("withdraw needs exactly one of --amount A or --all");
      let req: { amount: bigint } | { all: true };
      if (all) req = { all: true };
      else {
        if (!/^[0-9]+(\.[0-9]{1,6})?$/.test(amountRaw!)) {
          throw new UsageError("--amount must be a USDC amount with at most 6 decimal places");
        }
        const amount = parseUnits(amountRaw!, 6);
        // A refusal (exit 1), like the daemon's own: checked here too so no daemon is started just to refuse it.
        if (amount <= 0n) throw new Error("--amount must be greater than 0");
        req = { amount };
      }
      const cfg = loadConfig(home, { warn: io.err });

      let result: { to: string; amount: bigint; txHash: string; usdcAfter: bigint | null; note?: string; openOffers?: string[] };
      if (livePidHoldingLock(home) !== null) {
        // A daemon is running (`arena daemon`, `arena bot`, or another withdraw): go through its API.
        const token = loadToken(home);
        let res: Response;
        try {
          res = await io.fetch(`http://127.0.0.1:${cfg.port}/withdraw`, {
            method: "POST",
            headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-arena-actor": "agent" },
            body: JSON.stringify("all" in req ? { all: true } : { amount: req.amount.toString() }),
          });
        } catch (err) {
          throw new Error(
            `a daemon holds ${home} but cannot be reached on 127.0.0.1:${cfg.port}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        const payload = (await res.json().catch(() => ({}))) as {
          error?: unknown;
          to?: unknown;
          amount?: unknown;
          txHash?: unknown;
          usdcAfter?: unknown;
          note?: unknown;
          openOffers?: unknown;
        };
        if (!res.ok) {
          io.err(`error: ${typeof payload.error === "string" ? payload.error : res.statusText}`);
          return 1;
        }
        const dec = /^[0-9]+$/;
        if (
          typeof payload.to !== "string" ||
          typeof payload.txHash !== "string" ||
          typeof payload.amount !== "string" ||
          !dec.test(payload.amount) ||
          // Fix round 4 (N4): null when the transfer is confirmed but the balance after it could not be read.
          (payload.usdcAfter !== null && (typeof payload.usdcAfter !== "string" || !dec.test(payload.usdcAfter)))
        ) {
          throw new Error(`the daemon answered withdraw with a malformed result: ${JSON.stringify(payload).slice(0, 200)}`);
        }
        result = {
          to: payload.to,
          amount: BigInt(payload.amount),
          txHash: payload.txHash,
          usdcAfter: payload.usdcAfter === null ? null : BigInt(payload.usdcAfter),
        };
        if (typeof payload.note === "string") result.note = payload.note;
        if (Array.isArray(payload.openOffers)) result.openOffers = payload.openOffers.filter((o): o is string => typeof o === "string");
      } else {
        // No daemon: refuse before starting one if there is no owner at all (the daemon would refuse anyway).
        if (readRecordedOwner(home) === null) throw new Error(noOwnerMessage(CLI_COMMAND));
        // Exactly as `arena bot` does: the in-process daemon takes the home lock, so nothing else can send from
        // this wallet meanwhile; it is stopped (and the lock released) whether or not the withdraw succeeds.
        const proc = await startDaemonProcess(home, { log: () => {} });
        try {
          result = await proc.daemon.withdraw(req);
        } finally {
          await proc.stop();
        }
      }
      io.out(
        JSON.stringify(
          {
            to: result.to,
            amount: formatUsdc6(result.amount),
            txHash: result.txHash,
            usdcAfter: result.usdcAfter === null ? null : formatUsdc6(result.usdcAfter),
          },
          null,
          2,
        ),
      );
      // Fix round 4 (N4): the transfer is confirmed by its receipt; only the balance shown after it is missing.
      if (result.note !== undefined) io.err(`note: ${result.note}`);
      // Fix round 1 (M1): a warning, not a refusal -- an open offer holds no funds yet, but one matched from now on
      // may find the wallet short; its channel then retires unfunded at its funding deadline (no funds are lost).
      if (result.openOffers !== undefined && result.openOffers.length > 0) {
        io.err(
          `note: this wallet still has ${result.openOffers.length} open offer(s) (${result.openOffers.join(", ")}): if one is ` +
            "matched now, its deposit may fail for lack of USDC, and that channel retires unfunded at its funding deadline",
        );
      }
      return 0;
    }

    if (cmd === "bot") {
      // Plan 5.5 Task 2: house bots are dev tooling -- refuse any chain but 31337 up front, before the home lock
      // or any RPC call, unless the caller explicitly overrides it.
      const cfg = loadConfig(home, { warn: io.err });
      if (cfg.chainId !== 31337 && !flags.has("allow-real-chain")) {
        throw new UsageError(
          `refusing to run "${CLI_COMMAND} bot" against chain ${cfg.chainId}: house bots are dev tooling for chain 31337 ` +
            `only. Pass --allow-real-chain to run one on a real chain anyway.`,
        );
      }
      // Fix round: every flag is parsed and format-checked here, before startDaemonProcess takes the home lock
      // and starts the API -- a usage error must never leave a daemon running (or a lock held) behind it.
      const amountOrDefault = (name: string, def: string): bigint => {
        const v = flag(name) ?? def;
        if (!/^[0-9]+(\.[0-9]{1,6})?$/.test(v)) {
          throw new UsageError(`--${name} must be a non-negative USDC amount with at most 6 decimal places`);
        }
        return parseUnits(v, 6);
      };
      const offers = Number(flag("offers") ?? "1");
      if (!Number.isInteger(offers) || offers < 0) throw new UsageError("--offers must be a non-negative integer");
      const idleCloseSeconds = Number(flag("idle-close-seconds") ?? "120");
      if (!Number.isFinite(idleCloseSeconds) || idleCloseSeconds < 0) {
        throw new UsageError("--idle-close-seconds must be a non-negative number");
      }
      const timeoutRaw = flag("timeout");
      if (timeoutRaw !== undefined && !/^[0-9]+$/.test(timeoutRaw)) {
        throw new UsageError("--timeout must be a non-negative integer number of seconds");
      }
      const offerTimeout = timeoutRaw !== undefined ? BigInt(timeoutRaw) : undefined;
      const deposit = amountOrDefault("deposit", "10");
      const stake = amountOrDefault("stake", "1");

      const proc = await startDaemonProcess(home, { log: io.err });
      // Fix round (minor 5): an explicit --timeout this daemon would never actually be able to use (below the
      // hub's own minimum or this daemon's minChallengeTimeout, or above the hub's maximum) is caught here,
      // clearly, at startup -- rather than only surfacing later as a repeating, generic createOffer failure on
      // every standing-offer recheck pass.
      if (offerTimeout !== undefined) {
        const bounds = await proc.daemon.hub.timeoutBounds();
        const reason = invalidOfferTimeoutReason(offerTimeout, bounds, minChallengeTimeoutOf(cfg));
        if (reason) {
          await proc.stop();
          throw new UsageError(reason);
        }
      }
      io.out(
        JSON.stringify({
          ...daemonStartLine({ apiUrl: proc.apiUrl, pid: process.pid, wallet: proc.daemon.wallet.address, fallback: proc.fallback }),
          bot: true,
        }),
      );
      // Plan 5.7 Task 4: xmtp configured (config.xmtp) but this daemon ended up without the fallback -- logged
      // once, here, rather than re-checking the SDK itself; `startDaemonProcess` (Task 1) already decided.
      const xmtpHint = xmtpBotHint(cfg.xmtp !== undefined, proc.fallback);

      const controller = new AbortController();
      // Plan 5.5 Task 2: `process.on` (not `once`), and idempotent -- a process group signal (a terminal Ctrl-C,
      // or dev-up's own teardown sending SIGTERM moments after its SIGINT reaches this process too) can deliver
      // more than one. A `once` handler that removes itself leaves the *second* signal with no listener at all,
      // so Node's default action terminates the process immediately -- mid `proc.stop()` (the daemon, the API
      // server, the home lock) rather than after it finishes cleanly.
      let stopping = false;
      const stop = () => {
        if (stopping) return;
        stopping = true;
        controller.abort();
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);

      await runBot(proc.daemon, {
        usdc: cfg.usdc,
        deposit,
        stake,
        offers,
        offerTimeout,
        idleCloseMs: idleCloseSeconds * 1000,
        log: io.err,
        signal: controller.signal,
        ...(xmtpHint ? { xmtpEnableHint: `bot: ${xmtpHint}` } : {}),
      }).catch((err) => io.err(`bot: ${err instanceof Error ? err.message : String(err)}`));

      await proc.stop();
      // Plan 5.5 Task 2: `daemon.wait()` polls in up-to-1s steps against its own `timeoutMs` (default 15s); an
      // abandoned call from the moment `controller.abort()` fired keeps a harmless timer alive until it elapses
      // on its own. `arena.mjs` never calls process.exit() itself (it just sets `process.exitCode`), so without
      // this the process would otherwise linger for that long after a clean shutdown -- this command is the only
      // one with such a loop, so forcing the exit here (after every bit of cleanup above has already run) is safe.
      process.exit(0);
    }

    if (cmd === "xmtp") {
      // Plan 5.7 Task 4 (spec §4): none of enable/status/disable needs the home lock or even an existing
      // config.json -- the SDK install is independent of ARENA_HOME's own config, and every CLI invocation here
      // uses a temp HOME/ARENA_HOME anyway (Global Constraints).
      if (arg === "enable") {
        mkdirSync(home, { recursive: true, mode: 0o700 });
        const xmtpDir = join(home, "xmtp");
        mkdirSync(xmtpDir, { recursive: true });
        const sdkDir = join(xmtpDir, "sdk");
        // Fix round 1 (Minor 4): install into a throwaway sibling dir first, and move it into place only once
        // npm *and* the loader both succeed -- a failed install (npm exits non-zero, or the installed SDK fails
        // to load) then never leaves a half-populated <home>/xmtp/sdk behind; a concurrent `status`, or a retried
        // `enable`, still sees only the last good install (or none at all), never a corrupt partial one.
        // Plan 6 hardening H2 (audit-journey I-5): a run killed part-way never reached the `catch` below, so its
        // throwaway dir is cleared here, on the next run.
        for (const name of removeStaleSdkTmpDirs(xmtpDir)) io.err(`xmtp enable: removed ${name}, left by an earlier run that was stopped part-way`);
        const tmpDir = join(xmtpDir, `.sdk-tmp-${process.pid}-${Date.now()}`);
        mkdirSync(tmpDir, { recursive: true });
        try {
          const npmBin = resolveNpmBinary(io);
          io.err(`xmtp enable: installing @xmtp/node-sdk@${XMTP_SDK_VERSION} into ${sdkDir} (about 480 MB; this can take a while)...`);
          await runNpmInstall(npmBin, tmpDir, XMTP_SDK_VERSION, io);
          const loaded = await loadXmtpSdkFrom(join(tmpDir, "node_modules"));
          if (!loaded.ok) throw new Error(`xmtp enable: installed, but the SDK failed to load: ${loaded.reason}`);
          rmSync(sdkDir, { recursive: true, force: true });
          renameSync(tmpDir, sdkDir);
          const sizeMB = Math.round(dirSizeBytes(sdkDir) / (1024 * 1024));
          io.out(JSON.stringify({ enabled: true, version: loaded.version, sizeMB }));
          return 0;
        } catch (err) {
          rmSync(tmpDir, { recursive: true, force: true });
          throw err;
        }
      }
      if (arg === "status") {
        const loaded = await loadXmtpSdk(home);
        // The SDK's own install state (above) is independent of config.json -- `status` must still answer
        // before `init` has ever run, so a missing or unreadable config just means `env: null`, never a throw.
        let env: XmtpConfig["env"] | null = null;
        let configProblem: string | null = null;
        if (existsSync(arenaPaths(home).config)) {
          try {
            const read = readConfig(home);
            env = read.config.xmtp?.env ?? null;
            configProblem = read.xmtpProblem;
          } catch {
            env = null;
          }
        }
        // Plan 5.7 (I-2): what the RUNNING daemon loaded -- it loads the SDK once, at start, so an `enable` after it
        // started needs a daemon restart. "not running" when no daemon of this home answers.
        const daemon = await runningDaemonFallback(home, io);
        io.out(
          JSON.stringify({
            ...(loaded.ok ? { enabled: true, version: loaded.version } : { enabled: false, version: null, reason: loaded.reason }),
            env,
            ...(configProblem !== null ? { configProblem } : {}),
            daemon: daemon.fallback,
            ...(daemon.reason !== undefined ? { daemonReason: daemon.reason } : {}),
          }),
        );
        return 0;
      }
      if (arg === "disable") {
        // Plan 5.7 Task 4: removes only the installed SDK -- `<home>/xmtp/db` (every channel's XMTP message
        // history and installation state) is a sibling directory, never touched here, so a later `xmtp enable`
        // resumes instead of re-registering a fresh installation.
        rmSync(join(home, "xmtp", "sdk"), { recursive: true, force: true });
        io.out(JSON.stringify({ enabled: false }));
        return 0;
      }
      throw new UsageError(`unknown xmtp subcommand ${arg ?? "(none)"}: use enable, status or disable`);
    }

    const channel = flag("channel");
    const withChannel = (b: Record<string, unknown>) => (channel ? { ...b, channel } : b);
    let request: { method: "GET" | "POST"; path: string; body?: Record<string, unknown> };
    switch (cmd) {
      case "offers":
        request = { method: "GET", path: "/offers" };
        break;
      case "offer":
        request = {
          method: "POST",
          path: "/offers",
          // Plan 5 Task 1: omitted unless --timeout is given -- the daemon applies its own minChallengeTimeoutOf.
          body: {
            deposit: usdcAmount("deposit"),
            stakePerGame: usdcAmount("stake"),
            ...(flag("timeout") !== undefined ? { challengeTimeout: flag("timeout") } : {}),
            // H1: omitted unless --ttl is given -- the daemon keeps its default lifetime and checks the range.
            ...(flag("ttl") !== undefined ? { ttl: flag("ttl") } : {}),
          },
        };
        break;
      case "accept":
        if (!arg) throw new UsageError("accept needs an offer id");
        request = { method: "POST", path: "/offers/accept", body: { offerId: arg } };
        break;
      case "channels":
        request = { method: "GET", path: "/channels" };
        break;
      case "status":
        request = { method: "GET", path: `/status${channel ? `?channel=${channel}` : ""}` };
        break;
      case "wait": {
        const qs = new URLSearchParams();
        if (channel) qs.set("channel", channel);
        qs.set("timeout", flag("timeout") ?? "60");
        request = { method: "GET", path: `/wait?${qs.toString()}` };
        break;
      }
      case "move":
        if (!arg) throw new UsageError(`move needs a move, e.g. ${CLI_COMMAND} move e4`);
        request = {
          method: "POST",
          path: "/move",
          body: withChannel(flags.has("offer-draw") ? { move: arg, offerDraw: true } : { move: arg }),
        };
        break;
      case "resign":
      case "accept-draw":
      case "next-game":
      case "close":
      case "challenge":
      case "reclaim":
      case "sweep":
        request = { method: "POST", path: `/${cmd}`, body: withChannel({}) };
        break;
      case "handoff":
        if (arg !== "human" && arg !== "agent") throw new UsageError("handoff needs human or agent");
        request = { method: "POST", path: "/handoff", body: withChannel(flag("note") ? { to: arg, note: flag("note") } : { to: arg }) };
        break;
      default:
        throw new UsageError(cmd ? `unknown command ${cmd}` : "no command given");
    }

    const cfg = loadConfig(home, { warn: io.err });
    const token = loadToken(home);
    let res: Response;
    try {
      res = await io.fetch(`http://127.0.0.1:${cfg.port}${request.path}`, {
        method: request.method,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-arena-actor": "agent" },
        body: request.body === undefined ? undefined : JSON.stringify(request.body),
      });
    } catch (err) {
      // M1: a bare "fetch failed" named neither the port nor what to do about it. Mirrors the board command's
      // own wording (skill.md's recipe step 2 starts the daemon -- the final fix wave moved it back ahead of
      // picking an offer and `fund --offer`).
      throw new Error(
        `cannot reach the daemon on 127.0.0.1:${cfg.port}: start it with "${CLI_COMMAND} daemon" (skill.md's recipe step 2), ` +
          `then retry: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const payload = (await res.json()) as unknown;
    if (!res.ok) {
      io.err(`error: ${(payload as { error?: string }).error ?? res.statusText}`);
      return 1;
    }
    io.out(JSON.stringify(payload, null, 2));
    // Plan 5 fix round (I5): a daemon-wide sweep may not finish everything within its own time budget.
    if (cmd === "sweep" && typeof (payload as { remaining?: unknown }).remaining === "number") {
      const remaining = (payload as { remaining: number }).remaining;
      if (remaining > 0) io.err(`note: ${remaining} channel(s) still need sweeping; rerun "${CLI_COMMAND} sweep" to continue`);
    }
    return 0;
  } catch (err) {
    if (err instanceof UsageError) {
      io.err(`error: ${err.message}\n${USAGE}`);
      return 2;
    }
    io.err(`error: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
    return 1;
  }
}
