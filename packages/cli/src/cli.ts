import { parseUnits, type Address, type Hex } from "viem";
import { DEFAULT_FEE_CEILING_WEI } from "@arena/sdk";
import {
  defaultHome,
  initHome,
  loadConfig,
  loadToken,
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
       [--fee-ceiling-wei N] [--min-challenge-timeout SECONDS]
       (--session-gas-wei defaults to 4 x 2.1M gas x max(fee ceiling, 4 x the RPC's gas price): dispute gas per channel)
       (missing chain settings are filled from the server's /templates and checked over the RPC;
        the wallet key must not be used anywhere else: the daemon replaces pending transactions it did not send)
  daemon [start]
  offers | offer --deposit USDC --stake USDC [--timeout SECONDS (default: this daemon's minChallengeTimeout)] | accept <offerId>
  channels | status [--channel ID] | wait [--channel ID] [--timeout SECONDS]
  move <move> [--offer-draw] [--channel ID]
  resign | accept-draw | next-game | close | challenge | reclaim  [--channel ID]
  handoff human|agent [--note TEXT] [--channel ID]`;

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

class UsageError extends Error {}

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
      const explicitFields = ["rpc", "chain-id", "hub", "usdc", "rules"];
      const haveAllExplicit = explicitFields.every((name) => flag(name) !== undefined);
      let template: { rpcUrl?: string; chainId?: string; hub?: string; usdc?: string; rules?: string } = {};
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
      };
      const { walletKey } = initHome(home, cfg, flag("wallet-key") as Hex | undefined);
      const { privateKeyToAccount } = await import("viem/accounts");
      const summary: Record<string, unknown> = {
        home,
        wallet: privateKeyToAccount(walletKey).address,
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
      io.out(JSON.stringify(summary, null, 2));
      return 0;
    }

    if (cmd === "daemon") {
      if (arg !== undefined && arg !== "start") throw new UsageError(`unknown daemon subcommand ${arg}`);
      const proc = await startDaemonProcess(home, { log: io.err });
      io.out(JSON.stringify({ api: proc.apiUrl, pid: process.pid, wallet: proc.daemon.wallet.address }));
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
