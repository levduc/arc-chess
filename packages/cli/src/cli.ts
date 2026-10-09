import { existsSync, mkdirSync, rmdirSync } from "node:fs";
import { encodeFunctionData, formatUnits, parseUnits, type Address, type Hex } from "viem";
import { channelHubAbi, DEFAULT_FEE_CEILING_WEI } from "@arena/sdk";
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
  knownDeploymentWarnings,
  type ArenaConfig,
} from "./config.js";
import { computeFundingNeed, formatUsdc6, fundMessage, type FundingNeed } from "./funding.js";
import { readJson } from "./jsonfile.js";
import { classifyOwner, forbiddenOwners, noOwnerMessage, ownerNonceOf, readRecordedOwner, setOwner, UsageError } from "./owner.js";
import { RecordStore } from "./records.js";
import { startDaemonProcess } from "./run.js";
import { cliVersion } from "./version.js";

export type CliIo = {
  env: NodeJS.ProcessEnv;
  fetch: typeof fetch;
  out(s: string): void;
  err(s: string): void;
};

/** The command name `owner set` builds its printed `command` from (`setOwner`'s `cmd`). */
const CLI_COMMAND = "arena";

const USAGE = `usage: arena <command> [options]
  init --server URL [--rpc URL --chain-id N --hub ADDR --usdc ADDR --rules ADDR] [--port N] [--wallet-key HEX]
       [--owner ADDR] [--max-fee N] [--session-gas-wei N] [--session-gas-floor N] [--poll-ms N] [--log-chunk-blocks N]
       [--fee-ceiling-wei N] [--min-challenge-timeout SECONDS] [--auto-return-on-challenge true|false] [--no-faucet]
       (--session-gas-wei defaults to 4 x 2.1M gas x max(fee ceiling, 4 x the RPC's gas price): dispute gas per channel)
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
  wallet  (prints {address, usdc, native, chainId} by reading the chain directly -- no daemon needed)
          [--wait-for-usdc A] [--wait-for-native B] [--timeout SECONDS (default 1800, max 3600)]
          (with a --wait-for-* flag: polls every 5s -- override with ARENA_WAIT_POLL_MS -- until every given
           threshold holds or the timeout passes, then prints the same JSON plus {reached, waitedSeconds}.
           Exit 0 once reached, 2 on timeout, 1 on error.)
  faucet  (calls the server's dev faucet for this wallet explicitly; fails if the server has none)
  fund --games N --stake X [--deposit D]
       (works out what to ask your human for: reads /templates' deposit cap and faucet, the hub's
        feePerPlayer, and this wallet's balances -- no daemon needed. deposit defaults to min(N x X, cap).
        Calls the server's faucet once, the same way init does, if anything is short and one is advertised.
        Prints {address, chainId, deposit, feePerPlayer, usdc, native, owner, faucet?, message}, where
        message is a ready-to-relay sentence. faucet is present only when a faucet call was attempted: on
        success it is {usdc, native} (the wallet's new balances, formatted like "arena faucet"); on failure
        (unreachable, rate-limited, wrong origin, ...) it is the string "skipped: <reason>" instead, and the
        usdc/native fields above keep reporting the shortfall as it actually stands. Exit 0 whenever the
        computation succeeds -- a shortfall is data, not an error; exit 1 if the server or the hub cannot be
        read at all (for example, a hub address with no contract code on this chain).)
  owner   (prints {owner}: the address withdraw pays, or null)
  owner set ADDR [--signature 0x...]
          (records the human owner's address -- the only place withdraw ever sends USDC. The first set is free;
           changing it needs the CURRENT owner's EIP-191 signature: without --signature it prints {messageToSign,
           signer, command} and exits 1. The signature is checked locally (ECDSA, never through the RPC), so a
           smart-contract owner cannot be changed here -- only by hand-editing config.json. Never the wallet, the
           hub, the USDC token, the rules contract, a session key or the zero address.)
  withdraw --amount A | --all
          (sends USDC from this wallet to the recorded owner -- it takes no destination -- through the daemon:
           started in-process, and stopped again, if none is running. Refused while a channel still awaits this
           wallet's deposit. Funds escrowed in channels are not in the wallet: close open channels first. Succeeds
           only when the receipt shows the USDC Transfer to the owner. Prints {to, amount, txHash, usdcAfter}
           (usdcAfter null, with a note, if the balance cannot be read after it); a note on stderr if this wallet
           still has open offers.)
  bot [--deposit 10] [--stake 1] [--offers 1] [--timeout SECONDS] [--idle-close-seconds 120] [--allow-real-chain]
      (a long-lived process: runs the daemon in-process, keeps --offers standing offers open, and plays its own
       agent-controlled seats with a simple strategy -- mate in one, else the best qualifying capture, else
       sometimes a check or a capture, else a random move. Refuses any chain but 31337 unless --allow-real-chain.)
  offers | offer --deposit USDC --stake USDC [--timeout SECONDS (default: this daemon's minChallengeTimeout)] | accept <offerId>
  channels | status [--channel ID] | wait [--channel ID] [--timeout SECONDS]
  move <move> [--offer-draw] [--channel ID]
  resign | accept-draw | next-game | close | challenge | reclaim | sweep [--channel ID]
  handoff human|agent [--note TEXT] [--channel ID]
  version  (prints this CLI's version)`;

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

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
export function daemonStartLine(proc: { apiUrl: string; pid: number; wallet: string }): Record<string, unknown> {
  return {
    api: proc.apiUrl,
    pid: proc.pid,
    wallet: proc.wallet,
    board: `${proc.apiUrl}/board`,
    boardHint: "run: arena board",
  };
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
        let template: { rpcUrl?: string; chainId?: string; hub?: string; usdc?: string; rules?: string; faucet?: string } = {};
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
        const feeCeilingWei = flag("fee-ceiling-wei") !== undefined ? BigInt(flag("fee-ceiling-wei")!) : undefined;
        let sessionGasWei: bigint;
        if (flag("session-gas-wei") !== undefined) sessionGasWei = BigInt(flag("session-gas-wei")!);
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
        const existingCfg = readJson<{ owner?: unknown; ownerNonce?: unknown }>(paths.config);
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
      io.out(JSON.stringify(daemonStartLine({ apiUrl: proc.apiUrl, pid: process.pid, wallet: proc.daemon.wallet.address })));
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
      const cfg = loadConfig(home);
      const token = loadToken(home);
      let res: Response;
      try {
        res = await io.fetch(`http://127.0.0.1:${cfg.port}/board/code`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        });
      } catch {
        throw new Error(`cannot reach the daemon on 127.0.0.1:${cfg.port}: start it with "arena daemon", then run "arena board" again`);
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
      const cfg = loadConfig(home);
      const { privateKeyToAccount } = await import("viem/accounts");
      const address = privateKeyToAccount(loadWalletKey(home)).address;

      const waitUsdcRaw = flag("wait-for-usdc");
      const waitNativeRaw = flag("wait-for-native");
      if (waitUsdcRaw === undefined && waitNativeRaw === undefined) {
        const usdcBalance = await usdcBalanceOf(io, cfg.rpcUrl, cfg.usdc, address);
        const nativeBalance = await nativeBalanceOf(io, cfg.rpcUrl, address);
        io.out(
          JSON.stringify(
            { address, chainId: cfg.chainId, usdc: formatUsdc6(usdcBalance), native: formatNativeBalance(nativeBalance) },
            null,
            2,
          ),
        );
        return 0;
      }

      // Plan 5.6 Task 2 (spec §4.2, Review Focus 2): spec §4.2's exit codes are an exhaustive partition -- 0
      // once reached, 2 on an actual elapsed timeout, 1 on error -- so every input problem on this path
      // (a malformed --wait-for-* amount, a malformed --timeout, or one outside [1, 3600]) is deliberately a
      // plain Error, not this CLI's usual UsageError (exit 2): an agent that sees exit 2 here must read it as
      // "timed out, not malfunctioned", never as "bad flags", so no input mistake may share that code.
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
      // A hidden test knob (Task 2 brief): production always polls every 5s.
      const pollMsRaw = io.env.ARENA_WAIT_POLL_MS;
      const pollMs = pollMsRaw !== undefined && /^[0-9]+$/.test(pollMsRaw) && Number(pollMsRaw) > 0 ? Number(pollMsRaw) : 5000;

      const startedAt = Date.now();
      for (;;) {
        const usdcBalance = await usdcBalanceOf(io, cfg.rpcUrl, cfg.usdc, address);
        const nativeBalance = await nativeBalanceOf(io, cfg.rpcUrl, address);
        const reached =
          (usdcThreshold === undefined || usdcBalance >= usdcThreshold) &&
          (nativeThreshold === undefined || nativeBalance >= nativeThreshold);
        const elapsedMs = Date.now() - startedAt;
        const body = {
          address,
          chainId: cfg.chainId,
          usdc: formatUsdc6(usdcBalance),
          native: formatNativeBalance(nativeBalance),
          reached,
          waitedSeconds: Math.floor(elapsedMs / 1000),
        };
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
      const cfg = loadConfig(home);
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
      // Plan 5.6 Task 2 (spec §4.1): works out what to ask the human for -- no daemon needed.
      const cfg = loadConfig(home);
      const { privateKeyToAccount } = await import("viem/accounts");
      const address = privateKeyToAccount(loadWalletKey(home)).address;

      const gamesRaw = need("games");
      if (!/^[0-9]+$/.test(gamesRaw)) throw new UsageError("--games must be a positive whole number of games");
      const games = BigInt(gamesRaw);

      const stakeRaw = need("stake");
      if (!/^[0-9]+(\.[0-9]{1,6})?$/.test(stakeRaw)) {
        throw new UsageError("--stake must be a non-negative USDC amount with at most 6 decimal places");
      }
      const stake = parseUnits(stakeRaw, 6);

      let explicitDeposit: bigint | undefined;
      const depositRaw = flag("deposit");
      if (depositRaw !== undefined) {
        if (!/^[0-9]+(\.[0-9]{1,6})?$/.test(depositRaw)) {
          throw new UsageError("--deposit must be a non-negative USDC amount with at most 6 decimal places");
        }
        explicitDeposit = parseUnits(depositRaw, 6);
      }

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

      const feePerPlayerRaw = await rpcCall(io, cfg.rpcUrl, "eth_call", [
        { to: cfg.hub, data: encodeFunctionData({ abi: channelHubAbi, functionName: "feePerPlayer" }) },
        "latest",
      ]);
      // Fix round 1 (Important): `init` only verifies the hub holds code when it derived chain settings from
      // the server (`verifyChain`, skipped whenever every chain flag was given explicitly) -- so `cfg.hub` can
      // reach `fund` completely unverified. A no-code address answers eth_call with "0x", not a revert, and
      // `hexToBigIntOrThrow` would silently turn that into a fee of 0n, under-asking the human by the real fee
      // (Review Focus 1). Reject it by name instead of trusting a zero read.
      if (feePerPlayerRaw === "0x") {
        throw new Error(
          `the hub at ${cfg.hub} has no contract code on chain ${cfg.chainId} -- re-run "arena init" against ` +
            "the server (or pass --hub explicitly) before funding",
        );
      }
      const feePerPlayer = hexToBigIntOrThrow(feePerPlayerRaw, `RPC ${cfg.rpcUrl} eth_call (feePerPlayer)`);
      const feeCeilingWei = cfg.feeCeilingWei ?? DEFAULT_FEE_CEILING_WEI;

      let usdcHave = await usdcBalanceOf(io, cfg.rpcUrl, cfg.usdc, address);
      let nativeHave = await nativeBalanceOf(io, cfg.rpcUrl, address);
      let funding: FundingNeed = computeFundingNeed({
        games,
        stake,
        deposit: explicitDeposit,
        cap,
        feePerPlayer,
        sessionGasWei: cfg.sessionGasWei,
        feeCeilingWei,
        usdcHave,
        nativeHave,
      });

      // spec §4.1: call the faucet (as init does) only when something is actually short and the template
      // advertises one; never fails fund -- a failed top-up just leaves the shortfall for the human to cover.
      let faucetReported: { usdc: string; native: string } | string | undefined;
      if ((funding.usdc.shortfall > 0n || funding.native.shortfall > 0n) && faucetUrl !== undefined) {
        try {
          const funded = await callFaucet(io, faucetUrl, cfg.serverUrl, address);
          faucetReported = { usdc: formatUsdc6(funded.usdc), native: formatNativeBalance(funded.native) };
          usdcHave = await usdcBalanceOf(io, cfg.rpcUrl, cfg.usdc, address);
          nativeHave = await nativeBalanceOf(io, cfg.rpcUrl, address);
          funding = computeFundingNeed({
            games,
            stake,
            deposit: explicitDeposit,
            cap,
            feePerPlayer,
            sessionGasWei: cfg.sessionGasWei,
            feeCeilingWei,
            usdcHave,
            nativeHave,
          });
        } catch (err) {
          faucetReported = `skipped: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`;
        }
      }

      // Plan 5.6 Task 3: the owner recorded in config.json (`arena owner set` / `init --owner`), or null.
      const owner = cfg.owner ?? null;
      const message = fundMessage(funding, { address, chainId: cfg.chainId, ownerSet: owner !== null, games, stake });

      const body: Record<string, unknown> = {
        address,
        chainId: cfg.chainId,
        deposit: formatUsdc6(funding.deposit),
        feePerPlayer: formatUsdc6(funding.feePerPlayer),
        usdc: { have: formatUsdc6(funding.usdc.have), need: formatUsdc6(funding.usdc.need), shortfall: formatUsdc6(funding.usdc.shortfall) },
        native: {
          have: formatNativeBalance(funding.native.have),
          need: formatNativeBalance(funding.native.need),
          shortfall: formatNativeBalance(funding.native.shortfall),
        },
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
      const cfg = loadConfig(home);

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
      const cfg = loadConfig(home);
      if (cfg.chainId !== 31337 && !flags.has("allow-real-chain")) {
        throw new UsageError(
          `refusing to run "arena bot" against chain ${cfg.chainId}: house bots are dev tooling for chain 31337 ` +
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
          ...daemonStartLine({ apiUrl: proc.apiUrl, pid: process.pid, wallet: proc.daemon.wallet.address }),
          bot: true,
        }),
      );

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
      }).catch((err) => io.err(`bot: ${err instanceof Error ? err.message : String(err)}`));

      await proc.stop();
      // Plan 5.5 Task 2: `daemon.wait()` polls in up-to-1s steps against its own `timeoutMs` (default 15s); an
      // abandoned call from the moment `controller.abort()` fired keeps a harmless timer alive until it elapses
      // on its own. `arena.mjs` never calls process.exit() itself (it just sets `process.exitCode`), so without
      // this the process would otherwise linger for that long after a clean shutdown -- this command is the only
      // one with such a loop, so forcing the exit here (after every bit of cleanup above has already run) is safe.
      process.exit(0);
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
        if (!arg) throw new UsageError("move needs a move, e.g. arena move e4");
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

    const cfg = loadConfig(home);
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
      // own wording (skill.md's recipe step 2 starts the daemon).
      throw new Error(
        `cannot reach the daemon on 127.0.0.1:${cfg.port}: start it with "arena daemon" (skill.md's recipe step 2), ` +
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
      if (remaining > 0) io.err(`note: ${remaining} channel(s) still need sweeping; rerun "arena sweep" to continue`);
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
