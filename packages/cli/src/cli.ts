import { parseUnits, type Address, type Hex } from "viem";
import { defaultHome, initHome, loadConfig, loadToken, type ArenaConfig } from "./config.js";

export type CliIo = {
  env: NodeJS.ProcessEnv;
  fetch: typeof fetch;
  out(s: string): void;
  err(s: string): void;
};

const USAGE = `usage: arena <command> [options]
  init --rpc URL --chain-id N --hub ADDR --usdc ADDR --rules ADDR --server URL [--port N] [--wallet-key HEX]
       [--max-fee N] [--session-gas-wei N] [--poll-ms N]
  offers | offer --deposit USDC --stake USDC [--timeout SECONDS] | accept <offerId>
  channels | status [--channel ID] | wait [--channel ID] [--timeout SECONDS]
  move <move> [--offer-draw] [--channel ID]
  resign | accept-draw | next-game | close | challenge | reclaim  [--channel ID]
  handoff human|agent [--note TEXT] [--channel ID]`;

class UsageError extends Error {}

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

    if (cmd === "init") {
      const cfg: ArenaConfig = {
        rpcUrl: need("rpc"),
        chainId: Number(need("chain-id")),
        hub: need("hub") as Address,
        usdc: need("usdc") as Address,
        rules: need("rules") as Address,
        serverUrl: need("server"),
        port: Number(flag("port") ?? "7070"),
        maxFeePerPlayer: BigInt(flag("max-fee") ?? "10000"),
        sessionGasWei: BigInt(flag("session-gas-wei") ?? "10000000000000000"),
        pollMs: Number(flag("poll-ms") ?? "2000"),
      };
      const { walletKey } = initHome(home, cfg, flag("wallet-key") as Hex | undefined);
      const { privateKeyToAccount } = await import("viem/accounts");
      io.out(JSON.stringify({ home, wallet: privateKeyToAccount(walletKey).address, port: cfg.port }, null, 2));
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
          body: {
            deposit: parseUnits(need("deposit"), 6).toString(),
            stakePerGame: parseUnits(need("stake"), 6).toString(),
            challengeTimeout: flag("timeout") ?? "600",
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
