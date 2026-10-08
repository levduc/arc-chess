import { formatUnits, parseUnits, type Address, type Hex } from "viem";
import { DEFAULT_FEE_CEILING_WEI } from "@arena/sdk";
import { runBot } from "./bot.js";
import { livePidHoldingLock } from "./lock.js";
import {
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
import { startDaemonProcess } from "./run.js";

export type CliIo = {
  env: NodeJS.ProcessEnv;
  fetch: typeof fetch;
  out(s: string): void;
  err(s: string): void;
};

const USAGE = `usage: arena <command> [options]
  init --server URL [--rpc URL --chain-id N --hub ADDR --usdc ADDR --rules ADDR] [--port N] [--wallet-key HEX]
       [--max-fee N] [--session-gas-wei N] [--session-gas-floor N] [--poll-ms N] [--log-chunk-blocks N]
       [--fee-ceiling-wei N] [--min-challenge-timeout SECONDS] [--auto-return-on-challenge true|false] [--no-faucet]
       (--session-gas-wei defaults to 4 x 2.1M gas x max(fee ceiling, 4 x the RPC's gas price): dispute gas per channel)
       (--auto-return-on-challenge, default true: a human-held seat that must answer a challenge goes back to the
        agent once max(60 s, challengeTimeout / 3) is left)
       (missing chain settings are filled from the server's /templates and checked over the RPC;
        the wallet key must not be used anywhere else: the daemon replaces pending transactions it did not send)
       (when the server advertises a dev faucet and the wallet's USDC balance is below 20, init calls it;
        --no-faucet turns this off)
  daemon [start]
  board   (prints a one-time board link, valid for 2 minutes: open it in a browser on this machine; needs the daemon)
  wallet  (prints {address, usdc, native, chainId} by reading the chain directly -- no daemon needed)
  faucet  (calls the server's dev faucet for this wallet explicitly; fails if the server has none)
  bot [--deposit 10] [--stake 1] [--offers 1] [--timeout SECONDS] [--idle-close-seconds 120] [--allow-real-chain]
      (a long-lived process: runs the daemon in-process, keeps --offers standing offers open, and plays its own
       agent-controlled seats with a simple strategy -- mate in one, else the best qualifying capture, else
       sometimes a check or a capture, else a random move. Refuses any chain but 31337 unless --allow-real-chain.)
  offers | offer --deposit USDC --stake USDC [--timeout SECONDS (default: this daemon's minChallengeTimeout)] | accept <offerId>
  channels | status [--channel ID] | wait [--channel ID] [--timeout SECONDS]
  move <move> [--offer-draw] [--channel ID]
  resign | accept-draw | next-game | close | challenge | reclaim | sweep [--channel ID]
  handoff human|agent [--note TEXT] [--channel ID]`;

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

/** USDC amounts always print with exactly 6 decimal places (e.g. `100.000000`), unlike `formatUnits`, which
 *  trims trailing zeros -- a fixed width makes balances easy to compare at a glance. */
function formatUsdc6(amount: bigint): string {
  const negative = amount < 0n;
  const digits = (negative ? -amount : amount).toString().padStart(7, "0");
  return `${negative ? "-" : ""}${digits.slice(0, -6) || "0"}.${digits.slice(-6)}`;
}

/** The native balance, formatted with `formatUnits` (which trims trailing zeros and, for a whole amount, the
 *  decimal point too) but always showing at least one decimal place -- `formatUnits(10n ** 18n, 18)` is `"1"`;
 *  this returns `"1.0"`. */
function formatNativeBalance(wei: bigint): string {
  const s = formatUnits(wei, 18);
  return s.includes(".") ? s : `${s}.0`;
}

class UsageError extends Error {}

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

/** One JSON-RPC call through `io.fetch` (so tests can stub it); throws on transport, HTTP or RPC errors. */
async function rpcCall(io: CliIo, url: string, method: string, params: unknown[]): Promise<unknown> {
  let res: Response;
  try {
    res = await io.fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
  } catch (err) {
    throw new Error(`RPC ${url} is unreachable (${method}): ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) throw new Error(`RPC ${url} answered ${method} with status ${res.status}`);
  let body: { result?: unknown; error?: { message?: string } };
  try {
    body = (await res.json()) as typeof body;
  } catch {
    throw new Error(`RPC ${url} answered ${method} with a body that is not JSON`);
  }
  if (body === null || typeof body !== "object") throw new Error(`RPC ${url} answered ${method} with a malformed body`);
  if (body.error) throw new Error(`RPC ${url} refused ${method}: ${body.error.message ?? "unknown error"}`);
  return body.result;
}

/** I8: checks, over the RPC the daemon will use, that the server-supplied chain settings are at least real: the
 *  RPC serves `chainId`, and the hub and rules addresses hold contracts. It cannot prove they are the genuine
 *  arena contracts -- the printed trust line says so. */
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
      const explicitFields = ["rpc", "chain-id", "hub", "usdc", "rules"];
      const haveAllExplicit = explicitFields.every((name) => flag(name) !== undefined);
      let template: { rpcUrl?: string; chainId?: string; hub?: string; usdc?: string; rules?: string; faucet?: string } = {};
      if (!haveAllExplicit) {
        const templatesUrl = `${server.replace(/\/$/, "")}/templates`;
        const res = await io.fetch(templatesUrl);
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
      const fromServer = !haveAllExplicit;
      if (fromServer) {
        if (/^http:\/\//i.test(server) && !isLoopbackUrl(server)) {
          io.err(
            `warning: ${server} is plain http: anyone on the path can rewrite the contract addresses and RPC it ` +
              "hands you. Use https, or pass --rpc/--hub/--usdc/--rules explicitly.",
          );
        }
        await verifyChain(io, rpcUrl, chainId, { hub, rules });
      }
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
      };
      const { walletKey } = initHome(home, cfg, flag("wallet-key") as Hex | undefined);
      const { privateKeyToAccount } = await import("viem/accounts");
      const walletAddress = privateKeyToAccount(walletKey).address;
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
              // M3: the faucet URL comes from the same /templates response as the hub/RPC addresses, but costs
              // nothing extra to pin -- refuse a faucet whose origin differs from --server's, rather than ever
              // POSTing the wallet address somewhere else a compromised or careless server named.
              if (new URL(template.faucet).origin !== new URL(server).origin) {
                throw new Error(`faucet ${template.faucet} is not on ${server}'s origin; refusing to call it`);
              }
              let res: Response;
              try {
                res = await io.fetch(template.faucet, {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ address: walletAddress }),
                  // M3: a faucet that accepts and then stalls must not hang init forever ("never fails init"
                  // does not cover a hang), and a redirect is refused outright rather than followed somewhere
                  // off the pinned origin.
                  signal: AbortSignal.timeout(30_000),
                  redirect: "error",
                });
              } catch (err) {
                throw new Error(`faucet ${template.faucet} is unreachable: ${err instanceof Error ? err.message : String(err)}`);
              }
              const payload = (await res.json().catch(() => ({}))) as { usdc?: unknown; native?: unknown; error?: unknown };
              if (!res.ok) {
                const detail = typeof payload.error === "string" ? `: ${payload.error}` : "";
                throw new Error(`faucet ${template.faucet} answered with status ${res.status}${detail}`);
              }
              // Plan 5.5 Task 3 carry-forward: the server reports raw base-unit decimal strings (matching every
              // other /templates amount); format them the same way `arena wallet` does rather than passing them
              // through unchanged, so a human (or agent) reading init's own summary sees "100.000000"/"1.0", not
              // "100000000"/"1000000000000000000".
              const decStr = /^[0-9]+$/;
              if (typeof payload.usdc !== "string" || !decStr.test(payload.usdc) || typeof payload.native !== "string" || !decStr.test(payload.native)) {
                throw new Error(`faucet ${template.faucet} answered with a malformed amount: ${JSON.stringify(payload)}`);
              }
              summary.faucet = { usdc: formatUsdc6(BigInt(payload.usdc)), native: formatNativeBalance(BigInt(payload.native)) };
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
    const res = await io.fetch(`http://127.0.0.1:${cfg.port}${request.path}`, {
      method: request.method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-arena-actor": "agent" },
      body: request.body === undefined ? undefined : JSON.stringify(request.body),
    });
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
