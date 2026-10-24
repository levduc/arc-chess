/**
 * `pnpm testnet:up [--port 8090] [--rpc URL] [--public-rpc URL] [--house-bots 2] [--bot-usdc 2.5] [--bot-deposit 1]
 *   [--bot-stake 0.1] [--bot-timeout SECONDS] [--xmtp-bots] [--limits JSON] [--start-block N] [--dir PATH]`
 * `pnpm testnet:down [--withdraw] [--settle-seconds 120] [--dir PATH]`
 * `<dir>/bin/pay <agent address> <usdc>` | `<dir>/bin/pay balance` (also `pnpm testnet:up pay ...`)
 *
 * T5b: a persistent Agent Chess Arena stack on Arc TESTNET (chain 5042002), for testing by hand with real agents and
 * faucet USDC. The counterpart of `pnpm dev:up` (scripts/dev-up.ts), minus Anvil and the deployment: the contracts are
 * the ones in `contracts/deployments/5042002.json`, read on every run (a redeploy changes them; nothing here is
 * hard-coded). Everything lives under `--dir` (default `.arena-testnet/`, gitignored), and nothing there is ever
 * wiped: a rerun reuses it.
 *
 * `up`, in order:
 *  1. `eth_chainId` must be 0x4cef52 (Arc testnet), before anything else, on both RPCs. Every other chain is refused,
 *     Arc MAINNET (5042) by name. `--rpc` is what the server and the house bots use; `--public-rpc` is what the server
 *     publishes to agents in /templates (so skill.md). Both default to Arc's public testnet RPC
 *     (`https://rpc.testnet.arc.io`), which rate-limits per IP (HTTP 429): the server, every bot and every local
 *     agent's daemon share this machine's IP. A keyed provider URL belongs in `--rpc`, never in `--public-rpc`.
 *  2. The hub, rules and USDC must hold code, and must be the deployment the CLI pins for Arc testnet
 *     (`KNOWN_DEPLOYMENTS`, read from packages/cli at run time): if they differ, every `arena init` would refuse. The
 *     hub's limits, fee and timeout bounds are read.
 *  3. The server port (127.0.0.1 only) must be free and not one of `FORBIDDEN_PORTS` (the owner's demo stack, the
 *     test suites, the rehearsal). A previous `up` whose processes are still alive is refused: `testnet:down` first.
 *     `<dir>/state.json` records the hub the directory was made for; a different hub in the deployments file is
 *     refused, because the server's database and every bot home are bound to the old one (and may hold funds). Every
 *     existing bot home is checked here too, before anything starts: its hub, and `--bot-timeout` against its own
 *     `minChallengeTimeout` (a bot asked for offers below it exits at once).
 *  4. Writes `<dir>/bin/arena` (the CLI wrapper, advertised as the server's `cliCommand`) and `<dir>/bin/pay` (the
 *     human's funding helper, see below), then starts the host server with `xmtp: {env: "dev"}`, no faucet, and
 *     per-IP limits sized for a loopback-only server (`TESTNET_SERVER_LIMITS`, overridable with `--limits`).
 *  5. `--house-bots` house bots, each in its own ARENA_HOME `<dir>/house-bots/house-<i>`: `arena init` once (owner
 *     recorded as the deployer, so `withdraw` pays back there), then `arena bot --allow-real-chain`. Once its API
 *     answers, the bot is topped up through `<dir>/bin/pay` to `--bot-usdc` counted over everything it holds: its
 *     wallet, its share of every channel that is not finalized, and the session gas not yet swept back. A restart
 *     mid-game pays nothing for the escrow. `--bot-usdc 0` funds nothing. `--xmtp-bots` also runs `arena xmtp
 *     enable` (one install, symlinked into every other bot home). A bot that exits before `up` is ready fails `up`.
 *  6. Prints the skill.md URL, the watch page, the hub's explorer link, what this run paid, and the agent prompt
 *     (with its own ARENA_HOME and API port), then a JSON ready line on stdout, and runs in the foreground. Ctrl-C or
 *     SIGTERM stops the bots, then the server: only the children this process started, by pid.
 *
 * The server and the bots are started detached (their own process groups, logging to `<dir>/logs/`), so a Ctrl-C in
 * this terminal reaches only this process, which stops them in order. A pay helper in flight is detached too, and
 * teardown waits for it rather than kill a transfer that may already be broadcast. If this process dies without its
 * teardown, the bots keep running (they keep watching their channels): `<dir>/pids.json` records them, and
 * `testnet:down` stops exactly those pids, after checking that each one is still the process that was recorded (same
 * start time, same command line, under this `--dir`). Nothing is ever killed by name or pattern. `down` refuses a
 * directory without testnet:up's marker and an Arc-testnet `state.json`.
 *
 * `down --withdraw` first settles what it can while the stack still runs: it asks each house bot to close every open
 * channel whose game is over (a cooperative close: the opponent's daemon must co-sign it) and waits up to
 * `--settle-seconds` for those to finalize. Then it stops the stack, and in each bot home starts the daemon, sweeps
 * the session keys, lists every channel that is still not finalized (its escrow is not in the wallet), and runs
 * `arena withdraw --all`: the bot's USDC goes to its owner, the deployer. A channel in the middle of a game is never
 * closed; it is listed.
 *
 * `<dir>/bin/pay` sends testnet USDC (a native transfer: on Arc, USDC is the gas token, one balance) from the
 * deployer to an agent. It reads the deployer key from `~/.config/arena-deploy/arc-testnet-deployer.json` itself,
 * inside its own process, at call time: the key is never printed, logged, written under `--dir`, or put on a
 * command line. It asserts chain 5042002 (twice: before it reads the key and right before it sends), refuses more
 * than `PAY_MAX_USDC` per call and refuses to take the deployer below `DEPLOYER_FLOOR_USDC`, refuses while the
 * deployer has a pending transaction (another sender is using the key), pays a 40 gwei fee cap (Arc drops anything
 * under 20 gwei), waits for the receipt and checks its status. A mixed-case address must carry a valid checksum.
 *
 * Test hook (`pay` only): `ARENA_TESTNET_TEST_OVERRIDE`, a JSON object `{rpcUrl, chainId, keyFile}`, all three
 * required. Only tests set it (tests/system/testnet-up.test.ts). It is refused outright unless `rpcUrl` is a loopback
 * http URL, `chainId` is 31337 and that RPC's `web3_clientVersion` starts with `anvil/`; the real key file is never
 * opened under it. Left set in a shell by mistake, it makes `pay` fail against a local Anvil (or refuse); it can never
 * send anything on any real chain.
 */
import { type ChildProcess, spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import {
  createPublicClient,
  defineChain,
  formatUnits,
  getAddress,
  http,
  isAddress,
  keccak256,
  parseUnits,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { DEFAULT_LIMITS } from "../apps/server/src/config.js";
import {
  DEFAULT_MIN_CHALLENGE_TIMEOUT,
  KNOWN_DEPLOYMENTS,
  feeCeilingOf,
  loadConfig,
  minChallengeTimeoutOf,
  pinnedDeploymentRefusals,
  type KnownDeployment,
} from "../packages/cli/src/config.js";
import { oneBalanceOpenNeed } from "../packages/cli/src/funding.js";
import { channelHubAbi } from "../packages/sdk/src/abi.js";
import { writeArenaWrapper } from "../tests/system/claude-sandbox.js";

// ------------------------------------------------------------------------------------------------- constants

// `__dirname`/`__filename`, not `import.meta`: tsx runs this root-level script as CommonJS (the root package.json has
// no "type"), and so does tsc when tests/system's typecheck follows the test's import here; vitest injects both too.
const REPO_ROOT = join(__dirname, "..");
const SELF = __filename;
const CLI_BIN = join(REPO_ROOT, "packages/cli/bin/arena.mjs");
const SERVER_BIN = join(REPO_ROOT, "apps/server/bin/arena-server.mjs");
const TSX_CLI = join(REPO_ROOT, "node_modules/tsx/dist/cli.mjs");
const DEPLOYMENT_FILE = join(REPO_ROOT, "contracts/deployments/5042002.json");
const DEFAULT_DIR = join(REPO_ROOT, ".arena-testnet");

/** Arc TESTNET's public RPC: the default for both `--rpc` and `--public-rpc`. */
export const RPC_URL = "https://rpc.testnet.arc.io";
export const CHAIN_ID = 5042002;
const CHAIN_ID_HEX = "0x4cef52";
const MAINNET_CHAIN_ID = 5042;
export const EXPLORER = "https://explorer.testnet.arc.io";
/** The testnet deployer: owner and fee recipient of the hub, the pay helper's sender, and every house bot's owner. */
export const DEPLOYER: Address = "0x840d6f90dd12A713CC5F1fb6EAbBF99e0E74A7E0";
const DEPLOYER_KEY_FILE = join(homedir(), ".config/arena-deploy/arc-testnet-deployer.json");

/** The pay helper's caps, in USDC (one balance, 18 decimals natively). */
export const PAY_MAX_USDC = "3";
export const DEPLOYER_FLOOR_USDC = "2";
/** The pay helper's fees: Arc's floor is 20 gwei (anything under is silently dropped); 40 gwei is the CLI's Arc
 *  profile ceiling, 1 gwei the tip. A plain value transfer is 21,000 gas on Arc (arc-facts.md). */
const PAY_MAX_FEE = 40_000_000_000n;
const PAY_TIP = 1_000_000_000n;
const TRANSFER_GAS = 21_000n;
const PAY_RECEIPT_TIMEOUT_MS = 180_000;

/** A top-up below this (0.001 USDC) is skipped: not worth a transaction. */
const TOP_UP_DUST_WEI = 10n ** 15n;
const WEI_PER_USDC6 = 10n ** 12n;

/** The marker that makes `--dir` ours: a non-empty directory without it is refused, by `up` and by `down`. */
const DIR_MARKER = ".arena-testnet-marker";

/** Ports this script never uses: the owner's live demo stack (8545, 8080, 7070), the SDK/CLI suites (8546), the
 *  test:arc suites (8650-8655) and the Arc rehearsal (8660, 8760-8762). */
export const FORBIDDEN_PORTS: ReadonlySet<number> = new Set([
  8545, 8080, 7070, 8546, 8650, 8651, 8652, 8653, 8654, 8655, 8660, 8760, 8761, 8762,
]);

/**
 * T5b fix round 1 (I-2): the server's per-IP limits, sized for a server that listens on 127.0.0.1 only. Every house
 * bot and every local agent reaches it from that one address, so the defaults (5 open offers, 16 sockets, 1 POST/s
 * per IP) would make the whole stack one throttled client. These leave room for 10 bots and about 20 agents: an open
 * offer or two each, a socket each plus browser watch pages, and a busy agent's curl and CLI calls. The on-chain caps
 * (deposit per player, total escrow) are the hub's and unchanged. `--limits '{"maxOpenOffersPerIp": 10}'` overrides
 * any of them, by the server's own field names.
 */
export const TESTNET_SERVER_LIMITS = {
  maxOpenOffersPerIp: 64,
  wsPerIp: 128,
  httpPostBurst: 600,
  httpPostPerSec: 30,
  httpGetBurst: 2_400,
  httpGetPerSec: 200,
} as const;

const HOUSE_BOT_IDLE_CLOSE_SECONDS = "600";
/** House bots read the chain every 4 s, not the CLI's default 2 s: the public RPC rate-limits per IP. Their
 *  challenge timeouts are minutes long, so nothing they watch for is missed. */
const HOUSE_BOT_POLL_MS = "4000";

// --------------------------------------------------------------------------------------------- arguments

export type UpArgs = {
  port: number;
  /** What the server and the house bots use; it must answer chain 5042002. Never published. */
  rpc: string;
  /** What the server publishes to agents (/templates, so skill.md); it must answer chain 5042002 too. */
  publicRpc: string;
  houseBots: number;
  /** Decimal USDC strings, validated. */
  botUsdc: string;
  botDeposit: string;
  botStake: string;
  botTimeout?: number;
  xmtpBots: boolean;
  /** `--limits`: overrides of `TESTNET_SERVER_LIMITS` (or of any other server limit), by field name. */
  limits: Record<string, number>;
  startBlock?: bigint;
  dir: string;
};

export type DownArgs = { withdraw: boolean; settleSeconds: number; dir: string };

const USDC_RE = /^[0-9]+(\.[0-9]{1,6})?$/;

function usdcFlag(name: string, raw: string, opts: { allowZero?: boolean; max?: string } = {}): string {
  if (!USDC_RE.test(raw)) throw new Error(`--${name} must be a USDC amount with at most 6 decimal places`);
  const units = parseUnits(raw, 6);
  if (units === 0n && !opts.allowZero) throw new Error(`--${name} must be greater than 0`);
  if (opts.max !== undefined && units > parseUnits(opts.max, 6)) throw new Error(`--${name} must be at most ${opts.max}`);
  return raw;
}

function intFlag(name: string, raw: string, min: number, max: number): number {
  if (!/^[0-9]+$/.test(raw)) throw new Error(`--${name} must be a whole number`);
  const n = Number(raw);
  if (n < min || n > max) throw new Error(`--${name} must be between ${min} and ${max}`);
  return n;
}

function urlFlag(name: string, raw: string): string {
  let protocol: string;
  try {
    protocol = new URL(raw).protocol;
  } catch {
    throw new Error(`--${name} must be a URL`);
  }
  if (protocol !== "https:" && protocol !== "http:") throw new Error(`--${name} must be an http(s) URL`);
  return raw;
}

function limitsFlag(raw: string | undefined): Record<string, number> {
  if (raw === undefined) return {};
  let o: unknown;
  try {
    o = JSON.parse(raw);
  } catch {
    throw new Error(`--limits must be a JSON object, e.g. '{"maxOpenOffersPerIp": 10}'`);
  }
  if (typeof o !== "object" || o === null || Array.isArray(o)) throw new Error("--limits must be a JSON object");
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(o)) {
    if (!Object.hasOwn(DEFAULT_LIMITS, k)) throw new Error(`--limits: unknown server limit ${JSON.stringify(k)} (known: ${Object.keys(DEFAULT_LIMITS).join(", ")})`);
    if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) throw new Error(`--limits: ${k} must be a positive whole number`);
    out[k] = v;
  }
  return out;
}

/** Splits `argv` into value flags and boolean flags, refusing anything else: a mistyped flag must not be ignored. */
function readFlags(argv: string[], valueFlags: string[], boolFlags: string[]): { values: Map<string, string>; bools: Set<string> } {
  const values = new Map<string, string>();
  const bools = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const name = a.startsWith("--") ? a.slice(2) : undefined;
    if (name !== undefined && boolFlags.includes(name)) {
      bools.add(name);
      continue;
    }
    if (name !== undefined && valueFlags.includes(name)) {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) throw new Error(`--${name} needs a value`);
      values.set(name, v);
      i++;
      continue;
    }
    throw new Error(`unknown argument ${JSON.stringify(a)}`);
  }
  return { values, bools };
}

export function parseUpArgs(argv: string[]): UpArgs {
  const { values, bools } = readFlags(
    argv,
    ["port", "rpc", "public-rpc", "house-bots", "bot-usdc", "bot-deposit", "bot-stake", "bot-timeout", "limits", "start-block", "dir"],
    ["xmtp-bots"],
  );
  const port = intFlag("port", values.get("port") ?? "8090", 1024, 65_535);
  if (FORBIDDEN_PORTS.has(port)) throw new Error(`--port ${port} is reserved (the demo stack, the test suites or the rehearsal use it)`);
  const startBlockRaw = values.get("start-block");
  if (startBlockRaw !== undefined && !/^[0-9]+$/.test(startBlockRaw)) throw new Error("--start-block must be a block number");
  const timeoutRaw = values.get("bot-timeout");
  return {
    port,
    rpc: urlFlag("rpc", values.get("rpc") ?? RPC_URL),
    publicRpc: urlFlag("public-rpc", values.get("public-rpc") ?? RPC_URL),
    houseBots: intFlag("house-bots", values.get("house-bots") ?? "2", 0, 10),
    // Paid in one pay-helper call, so it is capped like one.
    botUsdc: usdcFlag("bot-usdc", values.get("bot-usdc") ?? "2.5", { allowZero: true, max: PAY_MAX_USDC }),
    botDeposit: usdcFlag("bot-deposit", values.get("bot-deposit") ?? "1"),
    botStake: usdcFlag("bot-stake", values.get("bot-stake") ?? "0.1"),
    ...(timeoutRaw !== undefined ? { botTimeout: intFlag("bot-timeout", timeoutRaw, 1, 86_400) } : {}),
    xmtpBots: bools.has("xmtp-bots"),
    limits: limitsFlag(values.get("limits")),
    ...(startBlockRaw !== undefined ? { startBlock: BigInt(startBlockRaw) } : {}),
    dir: resolve(values.get("dir") ?? DEFAULT_DIR),
  };
}

export function parseDownArgs(argv: string[]): DownArgs {
  const { values, bools } = readFlags(argv, ["dir", "settle-seconds"], ["withdraw"]);
  return {
    withdraw: bools.has("withdraw"),
    settleSeconds: intFlag("settle-seconds", values.get("settle-seconds") ?? "120", 0, 3_600),
    dir: resolve(values.get("dir") ?? DEFAULT_DIR),
  };
}

// ------------------------------------------------------------------------------------------ chain checks

type TestOverride = { rpcUrl: string; chainId: 31337; keyFile: string };

/** The test hook (see this file's docstring), validated; `undefined` when unset. Throws on anything malformed or
 *  incomplete: without its own `keyFile`, the hook would fall back to the real key file. */
export function testOverride(env: NodeJS.ProcessEnv = process.env): TestOverride | undefined {
  const raw = env.ARENA_TESTNET_TEST_OVERRIDE;
  if (raw === undefined || raw === "") return undefined;
  let o: unknown;
  try {
    o = JSON.parse(raw);
  } catch {
    throw new Error("ARENA_TESTNET_TEST_OVERRIDE is not JSON (it is a test hook: unset it)");
  }
  const r = (typeof o === "object" && o !== null ? o : {}) as Record<string, unknown>;
  let url: URL;
  try {
    url = new URL(String(r.rpcUrl));
  } catch {
    throw new Error("ARENA_TESTNET_TEST_OVERRIDE.rpcUrl must be a URL (it is a test hook: unset it)");
  }
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    throw new Error("ARENA_TESTNET_TEST_OVERRIDE.rpcUrl must be a loopback http URL (it is a test hook: unset it)");
  }
  if (r.chainId !== 31337) {
    throw new Error("ARENA_TESTNET_TEST_OVERRIDE.chainId must be 31337, a local Anvil (it is a test hook: unset it)");
  }
  if (typeof r.keyFile !== "string" || r.keyFile === "") {
    throw new Error("ARENA_TESTNET_TEST_OVERRIDE.keyFile is required: the hook never opens the real key file (it is a test hook: unset it)");
  }
  return { rpcUrl: url.toString(), chainId: 31337, keyFile: r.keyFile };
}

/** An RPC URL as messages show it: scheme and host only, since a provider URL can carry an API key in its path or
 *  query (fix round 1, m-10). */
export function shownUrl(u: string): string {
  try {
    const url = new URL(u);
    return `${url.protocol}//${url.host}${url.pathname !== "/" || url.search !== "" ? "/…" : ""}`;
  } catch {
    return "(an RPC URL)";
  }
}

/** The public testnet RPC rate-limits (HTTP 429, or JSON-RPC -32005 "Request exceeds defined limit"): every client
 *  here retries with a back-off of 1, 2, 4, 8 and 16 s. Retrying a send is safe: the same signed transaction. */
const RPC_RETRY = { timeout: 30_000, retryCount: 5, retryDelay: 1_000 } as const;

async function rpc(rpcUrl: string, method: string, params: unknown[] = []): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = res.ok ? ((await res.json()) as { result?: unknown; error?: { code?: unknown } }) : undefined;
    const limited = res.status === 429 || body?.error?.code === -32005;
    if (limited && attempt < RPC_RETRY.retryCount) {
      await sleep(RPC_RETRY.retryDelay * 2 ** attempt);
      continue;
    }
    if (!res.ok) throw new Error(`RPC ${shownUrl(rpcUrl)} ${method}: HTTP ${res.status}`);
    if (body?.error !== undefined) throw new Error(`RPC ${shownUrl(rpcUrl)} ${method}: ${JSON.stringify(body.error).slice(0, 200)}`);
    return body?.result;
  }
}

/** Refuses unless `rpcUrl`'s `eth_chainId` is `expected` (Arc testnet unless a test says otherwise). Arc mainnet is
 *  named in the refusal, and is refused even if a caller asks for it. */
export async function assertChain(rpcUrl: string, expected: number = CHAIN_ID): Promise<void> {
  if (expected === MAINNET_CHAIN_ID) throw new Error("refusing: this script never runs against Arc MAINNET (chain 5042)");
  const shown = shownUrl(rpcUrl);
  let raw: unknown;
  try {
    raw = await rpc(rpcUrl, "eth_chainId");
  } catch (err) {
    throw new Error(`refusing: cannot read eth_chainId from ${shown}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (typeof raw !== "string" || !/^0x[0-9a-fA-F]{1,16}$/.test(raw)) {
    throw new Error(`refusing: ${shown} returned a malformed eth_chainId ${JSON.stringify(raw)?.slice(0, 40)}`);
  }
  const got = Number(BigInt(raw));
  if (got === MAINNET_CHAIN_ID) throw new Error(`refusing: ${shown} is Arc MAINNET (chain 5042); this stack runs on Arc testnet (5042002) only`);
  if (got !== expected) {
    throw new Error(`refusing: ${shown} is chain ${got}, not ${expected === CHAIN_ID ? `Arc testnet (${CHAIN_ID_HEX}, ${CHAIN_ID})` : expected}`);
  }
}

type Deployment = { hub: Address; rules: Address; usdc: Address };

/** `contracts/deployments/5042002.json`, read fresh: a redeploy changes it. */
export function readDeployment(path: string = DEPLOYMENT_FILE): Deployment {
  const raw = JSON.parse(readFileSync(path, "utf8")) as { channelHub?: unknown; chessRules?: unknown; token?: unknown };
  const addr = (v: unknown, what: string): Address => {
    if (typeof v !== "string" || !isAddress(v)) throw new Error(`${path}: ${what} is not an address`);
    return getAddress(v);
  };
  return { hub: addr(raw.channelHub, "channelHub"), rules: addr(raw.chessRules, "chessRules"), usdc: addr(raw.token, "token") };
}

/**
 * Fix round 1 (m-11): why the deployments file and the CLI's pinned Arc-testnet deployment disagree, or null. On a
 * pinned chain `arena init` refuses any other hub, so a mismatch would fail every bot's and every agent's init, but
 * only after the server is up: refused here first instead. Both are read at run time (a redeploy changes both).
 */
export function hubPinProblem(d: Deployment, table: Record<number, KnownDeployment> = KNOWN_DEPLOYMENTS): string | null {
  const refusals = pinnedDeploymentRefusals(CHAIN_ID, d, { table });
  if (refusals.length === 0) return null;
  return (
    `refusing: ${DEPLOYMENT_FILE} does not match the Arc testnet deployment the CLI pins (KNOWN_DEPLOYMENTS in ` +
    `packages/cli/src/config.ts): ${refusals.join("; ")}. Every arena init would refuse it. Update whichever is stale`
  );
}

type HubLimits = {
  maxDepositPerPlayer: bigint;
  maxCommittedEscrow: bigint;
  feePerPlayer: bigint;
  paused: boolean;
  timeoutBounds: { min: bigint; max: bigint };
};

async function readHub(pub: PublicClient, d: Deployment): Promise<HubLimits> {
  for (const [what, a] of [["hub", d.hub], ["rules", d.rules], ["usdc", d.usdc]] as const) {
    const code = await pub.getCode({ address: a });
    if (!code || code === "0x") throw new Error(`refusing: the ${what} ${a} holds no code on this chain (see ${DEPLOYMENT_FILE})`);
  }
  const read = <T>(functionName: "maxDepositPerPlayer" | "maxCommittedEscrow" | "feePerPlayer" | "paused" | "MIN_TIMEOUT" | "MAX_TIMEOUT") =>
    pub.readContract({ address: d.hub, abi: channelHubAbi, functionName }) as Promise<T>;
  const [maxDepositPerPlayer, maxCommittedEscrow, feePerPlayer, paused, min, max] = await Promise.all([
    read<bigint>("maxDepositPerPlayer"),
    read<bigint>("maxCommittedEscrow"),
    read<bigint>("feePerPlayer"),
    read<boolean>("paused"),
    read<bigint | number>("MIN_TIMEOUT"),
    read<bigint | number>("MAX_TIMEOUT"),
  ]);
  return { maxDepositPerPlayer, maxCommittedEscrow, feePerPlayer, paused, timeoutBounds: { min: BigInt(min), max: BigInt(max) } };
}

// ---------------------------------------------------------------------------------------- server config

/** The host server's config for this stack: a pure function of its inputs, so it is unit tested as is. */
export function buildServerConfig(o: {
  dir: string;
  port: number;
  rpcUrl: string;
  publicRpcUrl: string;
  deployment: Deployment;
  limits: Pick<HubLimits, "maxDepositPerPlayer" | "maxCommittedEscrow" | "feePerPlayer">;
  serverLimits?: Record<string, number>;
  startBlock: bigint;
  cliCommand: string;
  deposit: string;
  stake: string;
}): Record<string, unknown> {
  const usdc = (v: bigint) => formatUnits(v, 6);
  return {
    host: "127.0.0.1",
    port: o.port,
    publicUrl: `http://127.0.0.1:${o.port}`,
    rpcUrl: o.rpcUrl,
    // What /templates (so skill.md and every agent's init) shows: never the host's own --rpc, which may be keyed.
    publicRpcUrl: o.publicRpcUrl,
    chainId: CHAIN_ID,
    hub: o.deployment.hub,
    usdc: o.deployment.usdc,
    rules: o.deployment.rules,
    dbPath: join(o.dir, "server.sqlite"),
    fundingWindow: "3600",
    offerMaxLifetime: "86400",
    defaults: { deposit: parseUnits(o.deposit, 6).toString(), stakePerGame: parseUnits(o.stake, 6).toString(), challengeTimeout: "900" },
    cliCommand: o.cliCommand,
    audit:
      `unaudited; Arc TESTNET test stack (pnpm testnet:up), faucet USDC only, served on 127.0.0.1. Hub limits: ` +
      `${usdc(o.limits.maxDepositPerPlayer)} USDC deposit per player, ${usdc(o.limits.maxCommittedEscrow)} USDC total ` +
      `committed escrow; fee ${usdc(o.limits.feePerPlayer)} USDC per player; owner and fee recipient are the testnet deployer`,
    // 3 s, not dev-up's 1 s: the public RPC's per-IP rate limit is shared with every bot and local agent.
    indexer: { pollMs: 3_000, chunkBlocks: 1_000, startBlock: o.startBlock.toString() },
    limits: { ...TESTNET_SERVER_LIMITS, ...(o.serverLimits ?? {}) },
    trustProxy: false,
    // Never a faucet: the server's own guard refuses one off Anvil anyway.
    devFaucet: false,
    // XMTP's dev network charges no fees, so no gateway is needed.
    xmtp: { env: "dev" },
  };
}

// ------------------------------------------------------------------------------------------- pay helper

/** Writes `<dir>/bin/pay`, the human's funding helper: a wrapper that runs this file's `pay` subcommand, through
 *  the stack's `--rpc` when that is not the public one. It names only this script and that RPC; the key is read by
 *  that process itself (see `loadDeployer`). Single-quoted like `writeArenaWrapper`. */
export function writePayWrapper(dir: string, rpcUrl: string = RPC_URL): string {
  const binDir = join(dir, "bin");
  mkdirSync(binDir, { recursive: true });
  const path = join(binDir, "pay");
  const sq = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
  writeFileSync(
    path,
    [
      "#!/bin/sh",
      "# testnet:up's funding helper (Arc TESTNET): you, the human, pay your agent from the testnet deployer.",
      `#   pay <agent address> <usdc>   send at most ${PAY_MAX_USDC} USDC; the deployer keeps at least ${DEPLOYER_FLOOR_USDC}`,
      "#   pay balance                  show the deployer's balance",
      `exec ${sq(process.execPath)} ${sq(TSX_CLI)} ${sq(SELF)} pay ${rpcUrl !== RPC_URL ? `--rpc ${sq(rpcUrl)} ` : ""}"$@"`,
      "",
    ].join("\n"),
  );
  chmodSync(path, 0o700);
  return path;
}

/** The deployer's account, from its key file: `{data: {address, private_key}}`, or `{data: [{address, private_key}]}`
 *  as the Circle CLI writes it. Every error is generic: none may quote the file. Never logged. */
export function loadDeployer(keyFile: string, expected: Address | undefined): PrivateKeyAccount {
  const mode = statSync(keyFile).mode & 0o777;
  if ((mode & 0o077) !== 0) throw new Error(`refusing: ${keyFile} is readable by others (mode ${mode.toString(8)}): chmod 600 it`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(keyFile, "utf8"));
  } catch {
    throw new Error(`cannot read ${keyFile} as JSON`);
  }
  const data = (raw as { data?: unknown } | null)?.data;
  const entries = (Array.isArray(data) ? data : [data]).filter((e): e is Record<string, unknown> => typeof e === "object" && e !== null);
  const entry =
    expected !== undefined
      ? entries.find((e) => typeof e.address === "string" && e.address.toLowerCase() === expected.toLowerCase())
      : entries.length === 1
        ? entries[0]
        : undefined;
  if (entry === undefined) throw new Error(`${keyFile} holds no entry for ${expected ?? "exactly one address"}`);
  const key = entry.private_key;
  if (typeof key !== "string" || !/^(0x)?[0-9a-fA-F]{64}$/.test(key)) throw new Error(`${keyFile} holds no well-formed private_key`);
  let account: PrivateKeyAccount;
  try {
    account = privateKeyToAccount((key.startsWith("0x") ? key : `0x${key}`) as Hex);
  } catch {
    throw new Error(`${keyFile}'s private_key is not a valid key`);
  }
  if (typeof entry.address === "string" && account.address.toLowerCase() !== entry.address.toLowerCase()) {
    throw new Error(`${keyFile}'s private_key does not belong to its address`);
  }
  if (expected !== undefined && account.address.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(`${keyFile} is not the key of ${expected}`);
  }
  return account;
}

/** What one `pay` call may send: checked before the key is read, so a refused call never touches it. An address in
 *  mixed case must carry a valid EIP-55 checksum (fix round 1, m-2): a one-character typo is refused, not paid. */
export function checkPayRequest(toRaw: string, amountRaw: string, deployment: Deployment | undefined, from: Address | undefined): { to: Address; wei: bigint } {
  if (!isAddress(toRaw, { strict: false })) throw new Error(`refusing: ${JSON.stringify(toRaw).slice(0, 60)} is not an address`);
  if (!isAddress(toRaw)) throw new Error(`refusing: ${toRaw} has an invalid checksum (a typo?): check it, or pass it all in lowercase`);
  const to = getAddress(toRaw);
  const forbidden: Array<[string, Address | undefined]> = [
    ["the zero address", "0x0000000000000000000000000000000000000000"],
    ["the deployer itself", from],
    ["the USDC contract", deployment?.usdc],
    ["the hub", deployment?.hub],
    ["the rules contract", deployment?.rules],
  ];
  for (const [what, a] of forbidden) if (a !== undefined && a.toLowerCase() === to.toLowerCase()) throw new Error(`refusing: ${to} is ${what}`);
  if (!USDC_RE.test(amountRaw)) throw new Error("refusing: the amount must be a USDC amount with at most 6 decimal places, e.g. 2.5");
  const wei = parseUnits(amountRaw, 18);
  if (wei === 0n) throw new Error("refusing: the amount must be greater than 0");
  if (wei > parseUnits(PAY_MAX_USDC, 18)) throw new Error(`refusing: at most ${PAY_MAX_USDC} USDC per call (asked for ${amountRaw})`);
  return { to, wei };
}

/** The deployer's balance and nonces, the balance and the `latest` nonce read at one block (fix round 1, m-3), so a
 *  pay mined between two reads cannot pair an old balance with a new nonce. A node behind the pinned block (a
 *  load-balanced RPC) is retried once at a fresh one. */
async function deployerState(pub: PublicClient, address: Address): Promise<{ balance: bigint; latest: number; pending: number }> {
  for (let attempt = 0; ; attempt++) {
    const blockNumber = await pub.getBlockNumber({ cacheTime: 0 });
    try {
      const [balance, latest, pending] = await Promise.all([
        pub.getBalance({ address, blockNumber }),
        pub.getTransactionCount({ address, blockNumber }),
        pub.getTransactionCount({ address, blockTag: "pending" }),
      ]);
      return { balance, latest, pending };
    } catch (err) {
      if (attempt >= 1) throw err;
      await sleep(1_000);
    }
  }
}

/** `pay`: see this file's docstring. Prints one JSON line on stdout; refusals go to stderr with exit 1. */
async function pay(argvIn: string[]): Promise<number> {
  // `--rpc URL`, first, only from the wrapper: any RPC will do, since the chain is asserted and the transaction is
  // signed for chain 5042002 (EIP-155), so it is valid nowhere else.
  const viaRpc = argvIn[0] === "--rpc" ? argvIn[1] : undefined;
  const argv = viaRpc !== undefined ? argvIn.slice(2) : argvIn;
  const override = testOverride();
  const rpcUrl = override?.rpcUrl ?? viaRpc ?? RPC_URL;
  const chainId = override?.chainId ?? CHAIN_ID;
  const keyFile = override?.keyFile ?? DEPLOYER_KEY_FILE;
  // In production the sender is the known deployer; under the test hook, whatever single address the key file holds.
  const expected = override !== undefined ? undefined : DEPLOYER;

  const balanceOnly = argv[0] === "balance" && argv.length === 1;
  if (!balanceOnly && argv.length !== 2) {
    process.stderr.write(`usage: pay <agent address> <usdc, at most ${PAY_MAX_USDC}>  |  pay balance\n`);
    return 2;
  }
  const deployment = override !== undefined ? undefined : readDeployment();
  const request = balanceOnly ? undefined : checkPayRequest(argv[0]!, argv[1]!, deployment, expected);

  await assertChain(rpcUrl, chainId);
  if (override !== undefined) {
    const client = await rpc(rpcUrl, "web3_clientVersion");
    if (typeof client !== "string" || !client.startsWith("anvil/")) throw new Error("refusing: the test hook needs a local Anvil");
  }
  const chain = defineChain({
    id: chainId,
    name: chainId === CHAIN_ID ? "Arc Testnet" : "Anvil",
    nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  const pub = createPublicClient({ chain, transport: http(rpcUrl, RPC_RETRY) }) as PublicClient;

  if (request === undefined) {
    const balance = await pub.getBalance({ address: expected ?? loadDeployer(keyFile, undefined).address });
    process.stdout.write(`${JSON.stringify({ deployer: expected ?? "(test key)", usdc: formatUnits(balance, 18) })}\n`);
    return 0;
  }

  const account = loadDeployer(keyFile, expected);
  if (account.address.toLowerCase() === request.to.toLowerCase()) throw new Error("refusing: that is the deployer itself");
  const { balance, latest, pending } = await deployerState(pub, account.address);
  if (latest !== pending) {
    throw new Error(
      `refusing: the deployer has a pending transaction (nonce latest ${latest}, pending ${pending}); another sender ` +
        "is using its key. Wait for it to confirm, then retry",
    );
  }
  const maxGasCost = TRANSFER_GAS * PAY_MAX_FEE;
  const floor = parseUnits(DEPLOYER_FLOOR_USDC, 18);
  if (balance - request.wei - maxGasCost < floor) {
    throw new Error(
      `refusing: the deployer holds ${formatUnits(balance, 18)} USDC; sending ${formatUnits(request.wei, 18)} would leave it ` +
        `under ${DEPLOYER_FLOOR_USDC} USDC. Use https://faucet.circle.com (Arc Testnet) instead`,
    );
  }
  await assertChain(rpcUrl, chainId);
  // Signed here, so the hash is known before the send: a send whose answer is lost (a rate limit, a timeout) is
  // looked up by that hash instead of being reported as failed, which would invite a second payment.
  const serialized = await account.signTransaction({
    chainId,
    type: "eip1559",
    to: request.to,
    value: request.wei,
    gas: TRANSFER_GAS,
    maxFeePerGas: PAY_MAX_FEE,
    maxPriorityFeePerGas: PAY_TIP,
    nonce: latest,
  });
  const hash = keccak256(serialized);
  try {
    await pub.sendRawTransaction({ serializedTransaction: serialized });
  } catch (err) {
    await sleep(3_000);
    const seen = await pub.getTransaction({ hash }).then(
      () => true,
      () => false,
    );
    if (!seen) throw new Error(`the send failed and ${hash} is not on the chain: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
  }
  const explorer = `${EXPLORER}/tx/${hash}`;
  process.stderr.write(`pay: sent ${formatUnits(request.wei, 18)} USDC to ${request.to}: ${explorer}\n`);
  let status: string;
  try {
    status = (await pub.waitForTransactionReceipt({ hash, timeout: PAY_RECEIPT_TIMEOUT_MS })).status;
  } catch {
    process.stderr.write(`pay: no receipt within ${PAY_RECEIPT_TIMEOUT_MS / 1000}s; do not resend until ${hash} confirms or drops\n`);
    process.stdout.write(`${JSON.stringify({ sent: false, to: request.to, txHash: hash, explorer, status: "pending" })}\n`);
    return 1;
  }
  const after = await pub.getBalance({ address: account.address });
  process.stdout.write(
    `${JSON.stringify({ sent: status === "success", usdc: formatUnits(request.wei, 18), to: request.to, txHash: hash, explorer, status, deployerUsdc: formatUnits(after, 18) })}\n`,
  );
  return status === "success" ? 0 : 1;
}

// ------------------------------------------------------------------------------------------- processes

export type PidEntry = { pid: number; startTime: string };
export type PidsFile = {
  up?: PidEntry;
  server?: PidEntry & { config: string };
  bots: Array<PidEntry & { name: string; home: string }>;
};

/** `/proc/<pid>/stat`'s start time (clock ticks since boot): with the pid, it names one process, never a reuse. */
export function procStartTime(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? null;
  } catch {
    return null;
  }
}

/** Fix round 1 (m-5): the start time a pid entry is recorded with. Retried briefly; an entry that could never match
 *  (no start time) is a loud failure, not a silent "never ours" later. */
async function startTimeOrThrow(pid: number | undefined, label: string): Promise<string> {
  for (let i = 0; i < 40 && pid !== undefined; i++) {
    const t = procStartTime(pid);
    if (t !== null) return t;
    await sleep(25);
  }
  throw new Error(`cannot read the start time of ${label} (pid ${pid}) from /proc: testnet:down could not stop it safely`);
}

/** True once `pid` is gone, is another process, or is a zombie (exited, not yet reaped by its parent). */
function gone(pid: number, startTime: string): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return fields[0] === "Z" || fields[19] !== startTime;
  } catch {
    return true;
  }
}

function procArgs(pid: number): string[] {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter((s) => s !== "");
  } catch {
    return [];
  }
}

function procEnv(pid: number, name: string): string | undefined {
  try {
    const line = readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").find((l) => l.startsWith(`${name}=`));
    return line?.slice(name.length + 1);
  } catch {
    return undefined;
  }
}

/** True only if `entry`'s pid is alive, started at the recorded time, and its command line is the one `kind` names:
 *  this script's `up`, the server on this config, or `arena bot` on this home. With `dir`, the config or home must
 *  also sit under it (fix round 1, m-8). Any doubt reads as "not ours". */
export function isOurs(kind: "up" | "server" | "bot", entry: PidEntry & { config?: string; home?: string }, dir?: string): boolean {
  if (!Number.isInteger(entry.pid) || entry.pid <= 1) return false;
  const start = procStartTime(entry.pid);
  if (start === null || start !== entry.startTime) return false;
  const under = (p: string | undefined) => p !== undefined && (dir === undefined || resolve(p).startsWith(resolve(dir) + sep));
  const args = procArgs(entry.pid);
  if (kind === "up") {
    const i = args.findIndex((a) => a.endsWith("testnet-up.ts"));
    return i >= 0 && args[i + 1] !== "down" && args[i + 1] !== "pay";
  }
  if (kind === "server") return args.includes(SERVER_BIN) && under(entry.config) && args.includes(entry.config!);
  return args.includes(CLI_BIN) && args.includes("bot") && under(entry.home) && procEnv(entry.pid, "ARENA_HOME") === entry.home;
}

function readPids(dir: string): PidsFile {
  try {
    const p = JSON.parse(readFileSync(join(dir, "pids.json"), "utf8")) as PidsFile;
    return { ...p, bots: Array.isArray(p.bots) ? p.bots : [] };
  } catch {
    return { bots: [] };
  }
}

function writePids(dir: string, p: PidsFile): void {
  writeFileSync(join(dir, "pids.json"), `${JSON.stringify(p, null, 2)}\n`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** SIGTERM `pid`, then SIGKILL after `graceMs` if the same process is still there. */
async function stopPid(label: string, pid: number, startTime: string, graceMs: number): Promise<void> {
  process.stderr.write(`testnet: stopping ${label} (pid ${pid})\n`);
  process.kill(pid, "SIGTERM");
  const end = Date.now() + graceMs;
  while (Date.now() < end) {
    if (gone(pid, startTime)) return;
    await sleep(250);
  }
  if (!gone(pid, startTime)) {
    process.stderr.write(`testnet: ${label} (pid ${pid}) did not stop within ${graceMs / 1000}s: SIGKILL\n`);
    process.kill(pid, "SIGKILL");
  }
}

async function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const srv = createServer();
    srv.once("error", () => resolvePromise(false));
    srv.listen(port, "127.0.0.1", () => srv.close(() => resolvePromise(true)));
  });
}

async function waitForHttp(url: string, label: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await sleep(250);
  }
  throw new Error(`${label} did not become ready within ${timeoutMs}ms (${url})`);
}

/** Polls the lobby until `player` has an open offer (wire format read as plain JSON, as dev-up does). */
async function waitForOffer(serverUrl: string, player: Address, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${serverUrl}/offers`, { signal: AbortSignal.timeout(5_000) });
      if (res.ok) {
        const list = (await res.json()) as Array<{ offer?: { player?: string } }>;
        if (list.some((o) => o.offer?.player?.toLowerCase() === player.toLowerCase())) return true;
      }
    } catch {
      // not there yet
    }
    await sleep(1_000);
  }
  return false;
}

/**
 * Fix round 1 (I-1): `work`, unless `child` exits first. A house bot that exits while `up` is still starting (a
 * refused `--timeout`, a busy API port, a bad home) must fail `up`, never leave a stack that says "ready" with fewer
 * opponents and unwatched channels. Rejects at once if it has already exited.
 */
export function unlessExits<T>(child: ChildProcess, label: string, work: Promise<T>): Promise<T> {
  return new Promise<T>((resolvePromise, reject) => {
    const failed = (code: number | null, signal: NodeJS.Signals | null) =>
      reject(new Error(`${label} exited while testnet:up was starting (code=${code} signal=${signal})`));
    if (child.exitCode !== null || child.signalCode !== null) {
      failed(child.exitCode, child.signalCode);
      return;
    }
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => failed(code, signal);
    child.once("exit", onExit);
    work.then(
      (v) => {
        child.removeListener("exit", onExit);
        resolvePromise(v);
      },
      (err: unknown) => {
        child.removeListener("exit", onExit);
        reject(err);
      },
    );
  });
}

/** Children that are still running a one-shot CLI command (init, owner, channels, ...): stopped by teardown too. */
const inflight = new Set<ChildProcess>();

/** Runs a one-shot command to completion, capturing its output (never its environment). */
function run(cmd: string, args: string[], opts: { env?: NodeJS.ProcessEnv; timeoutMs: number }): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, { cwd: REPO_ROOT, env: opts.env ?? process.env, stdio: ["ignore", "pipe", "pipe"] });
    inflight.add(child);
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
    child.stderr?.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
    const timer = setTimeout(() => child.kill("SIGTERM"), opts.timeoutMs);
    child.once("error", (err) => {
      clearTimeout(timer);
      inflight.delete(child);
      reject(err);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      inflight.delete(child);
      resolvePromise({ code, stdout, stderr });
    });
  });
}

function arena(home: string, args: string[], timeoutMs = 120_000) {
  return run(process.execPath, [CLI_BIN, ...args], { env: { ...process.env, ARENA_HOME: home }, timeoutMs });
}

/** A pay helper call that is still running: teardown waits for it (it may already have broadcast). */
let payInFlight: Promise<unknown> | undefined;

/**
 * Fix round 1 (m-4): runs `<dir>/bin/pay` detached (a terminal Ctrl-C never reaches it), its stderr -- the hash and
 * explorer link as soon as it sends -- streamed straight to ours, and registered so teardown waits for it instead of
 * killing a transfer mid-flight. It is bounded by its own receipt wait.
 */
function runPay(payPath: string, to: Address, usdc: string): Promise<{ code: number | null; stdout: string }> {
  const p = new Promise<{ code: number | null; stdout: string }>((resolvePromise, reject) => {
    const child = spawn(payPath, [to, usdc], { cwd: REPO_ROOT, detached: true, stdio: ["ignore", "pipe", "inherit"] });
    let stdout = "";
    child.stdout?.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
    child.once("error", reject);
    child.once("exit", (code) => resolvePromise({ code, stdout }));
  });
  payInFlight = p.finally(() => {
    if (payInFlight === tracked) payInFlight = undefined;
  });
  const tracked = payInFlight;
  return p;
}

/** The last JSON value a CLI command printed on stdout (they print one, sometimes pretty-printed). */
function lastJson(stdout: string): unknown {
  const t = stdout.trim();
  try {
    return JSON.parse(t) as unknown;
  } catch {
    for (const l of t.split("\n").reverse()) {
      try {
        return JSON.parse(l) as unknown;
      } catch {
        // keep looking
      }
    }
    throw new Error(`expected JSON on stdout, got ${JSON.stringify(t.slice(0, 200))}`);
  }
}

function lastJsonObject(stdout: string): Record<string, unknown> {
  const v = lastJson(stdout);
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error(`expected a JSON object on stdout, got ${JSON.stringify(stdout.trim().slice(0, 200))}`);
  return v as Record<string, unknown>;
}

/** The USDC to pay so `holdings` reach `target` (both in wei, 18 decimals), rounded up to 6 decimals; `null` when
 *  nothing is due (at or above target, or short only by dust). Never more than `target` itself. */
export function topUpAmount(holdings: bigint, target: bigint): string | null {
  const need = target - holdings;
  if (need <= TOP_UP_DUST_WEI) return null;
  const units = (need + WEI_PER_USDC6 - 1n) / WEI_PER_USDC6;
  return formatUnits(units, 6);
}

/** The parts of `arena channels` this script reads (see packages/cli/src/status.ts `ChannelStatus`). */
export type ChannelView = {
  channelId?: string;
  phase?: string;
  degraded?: boolean;
  gameStatus?: string;
  closing?: boolean;
  balances?: { me?: string };
  swept?: unknown;
};

const SETTLED_PHASES = new Set(["Finalized", "Reclaimed"]);

/**
 * Fix round 1 (I-3): everything a house bot holds, in wei: its wallet, its own balance in every channel that is not
 * settled (`balances.me`, whole USDC), and one `sessionGasWei` for every channel past `None` whose session key has
 * not been swept back yet. Counting only the wallet re-paid a bot's escrow (about 1.34 USDC) on every restart in the
 * middle of a game. A count that errs does so upward (a channel still funding counts its deposit and its gas), so the
 * deployer never pays for money the bot already has.
 */
export function holdingsWei(walletWei: bigint, channels: ChannelView[], sessionGasWei: bigint): bigint {
  let total = walletWei;
  for (const c of channels) {
    if (c.degraded) continue;
    if (!SETTLED_PHASES.has(c.phase ?? "") && typeof c.balances?.me === "string" && USDC_RE.test(c.balances.me)) {
      total += parseUnits(c.balances.me, 18);
    }
    if (c.phase !== "None" && (c.swept === null || c.swept === undefined)) total += sessionGasWei;
  }
  return total;
}

/** Fix round 1 (m-6): the wallet balance (wei) a bot needs to post and carry one more offer, by the CLI's own funding
 *  math (`oneBalanceOpenNeed`: deposit + fee + this channel's session gas + the other channels' gas reserve). */
export function openNeedWei(o: { deposit6: bigint; feePerPlayer6: bigint; sessionGasWei: bigint; feeCeilingWei: bigint; otherChannels: number }): bigint {
  const need6 = oneBalanceOpenNeed({
    deposit: o.deposit6,
    feePerPlayer: o.feePerPlayer6,
    ownGasWei: o.sessionGasWei,
    otherChannels: o.otherChannels,
    sessionGasWei: o.sessionGasWei,
    feeCeilingWei: o.feeCeilingWei,
  });
  return need6 * WEI_PER_USDC6;
}

/** One existing bot home, as the preflight sees it. */
export type BotHome = { name: string; hub: string; minChallengeTimeout: bigint };

/**
 * Fix round 1 (I-1): checked before the server starts. `refusals` stop `up`; `notes` are printed. A home's daemon
 * refuses offers whose challenge timeout is below its own `minChallengeTimeout` (set once, at init), so `arena bot
 * --timeout` below it exits at startup; and the hub refuses timeouts outside its bounds.
 */
export function botHomeProblems(
  homes: BotHome[],
  o: { hub: Address; botTimeout?: number; bounds: { min: bigint; max: bigint } },
): { refusals: string[]; notes: string[] } {
  const refusals: string[] = [];
  const notes: string[] = [];
  if (o.botTimeout !== undefined) {
    const t = BigInt(o.botTimeout);
    if (t < o.bounds.min || t > o.bounds.max) {
      refusals.push(`--bot-timeout ${t} is outside the hub's ${o.bounds.min}-${o.bounds.max} s challenge-timeout range`);
    }
  }
  for (const h of homes) {
    if (h.hub.toLowerCase() !== o.hub.toLowerCase()) {
      refusals.push(`${h.name} is bound to hub ${h.hub}, not ${o.hub}: withdraw it (testnet:down --withdraw), then use a fresh --dir`);
      continue;
    }
    if (o.botTimeout !== undefined && BigInt(o.botTimeout) < h.minChallengeTimeout) {
      refusals.push(
        `${h.name} was created with a ${h.minChallengeTimeout} s minimum challenge timeout, and its daemon refuses offers ` +
          `below it, so --bot-timeout ${o.botTimeout} would stop it at once. Omit --bot-timeout, or use a fresh --dir for ` +
          `${o.botTimeout} s offers`,
      );
    } else if (o.botTimeout === undefined && h.minChallengeTimeout < DEFAULT_MIN_CHALLENGE_TIMEOUT) {
      notes.push(
        `${h.name} posts ${h.minChallengeTimeout} s offers (it was created with --bot-timeout ${h.minChallengeTimeout}); an ` +
          `agent with the default ${DEFAULT_MIN_CHALLENGE_TIMEOUT} s floor refuses them`,
      );
    }
  }
  return { refusals, notes };
}

/** Fix round 1 (m-9): the message to give an agent -- everything it needs, including its own home and API port. */
export function agentPrompt(serverUrl: string, stake: string, agentPort: number): string {
  return (
    `Go to ${serverUrl} and use your money to play 5 $${Number(stake).toFixed(2)} games with whoever is available. ` +
    `Follow ${serverUrl}/skill.md; run every arena command with ARENA_HOME=$PWD/arena-home, and pass --port ${agentPort} to arena init.`
  );
}

/** The first `n` ports from `from` upward that are not reserved. */
function portsFrom(from: number, n: number): number[] {
  const out: number[] = [];
  for (let p = from; out.length < n && p <= 65_535; p++) if (!FORBIDDEN_PORTS.has(p)) out.push(p);
  return out;
}

// --------------------------------------------------------------------------------------------------- up

type State = { chainId: number; hub: Address; rules: Address; usdc: Address; startBlock: string; createdAt: string };

let server: ChildProcess | undefined;
const bots: Array<{ name: string; child: ChildProcess }> = [];
let upDir: string | undefined;
let shuttingDown = false;

async function stopChild(label: string, child: ChildProcess | undefined, graceMs: number): Promise<void> {
  if (!child || child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  process.stderr.write(`testnet-up: stopping ${label} (pid ${child.pid})\n`);
  const exited = new Promise<void>((r) => child.once("exit", () => r()));
  child.kill("SIGTERM");
  const timedOut = await Promise.race([exited.then(() => false), sleep(graceMs).then(() => true)]);
  if (timedOut && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  await exited;
}

async function teardown(): Promise<void> {
  if (payInFlight !== undefined) {
    process.stderr.write("testnet-up: waiting for the pay helper in flight to finish (it may already have sent)\n");
    await Promise.race([payInFlight.catch(() => {}), sleep(PAY_RECEIPT_TIMEOUT_MS + 60_000)]);
  }
  for (const c of inflight) c.kill("SIGTERM");
  // The bots depend on the server; each stops its own daemon (and its API) on SIGTERM.
  await Promise.all(bots.map((b) => stopChild(`house bot ${b.name}`, b.child, 30_000)));
  await stopChild("server", server, 10_000);
  if (upDir !== undefined) rmSync(join(upDir, "pids.json"), { force: true });
}

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  process.stderr.write(`\ntestnet-up: caught ${signal}, stopping what this run started\n`);
  await teardown();
  process.stderr.write("testnet-up: stopped. Open channels are unwatched until the next testnet:up.\n");
  process.exit(0);
}

/** Picks a free daemon API port for a new bot home: `base`, then upward, skipping reserved and already-taken ones. */
async function pickApiPort(base: number, taken: Set<number>): Promise<number> {
  for (let p = base; p < base + 200 && p <= 65_535; p++) {
    if (FORBIDDEN_PORTS.has(p) || taken.has(p)) continue;
    if (await isPortFree(p)) return p;
  }
  throw new Error(`no free API port in ${base}-${base + 199}`);
}

/** Polls `arena channels` until the bot's own API answers; fails if the bot exits first. */
async function botChannels(home: string, child: ChildProcess, name: string, timeoutMs: number): Promise<ChannelView[]> {
  const work = (async () => {
    const end = Date.now() + timeoutMs;
    for (;;) {
      const r = await arena(home, ["channels"], 60_000);
      if (r.code === 0) {
        const v = lastJson(r.stdout);
        if (!Array.isArray(v)) throw new Error(`${name}: arena channels printed no list`);
        return v as ChannelView[];
      }
      if (Date.now() > end) throw new Error(`${name}'s API did not answer within ${timeoutMs / 1000}s: ${r.stderr.trim().slice(-300)}`);
      await sleep(1_000);
    }
  })();
  return unlessExits(child, `house bot ${name}`, work);
}

async function up(args: UpArgs): Promise<void> {
  // Before anything else: the chain, on both RPCs.
  await assertChain(args.rpc, CHAIN_ID);
  if (args.publicRpc !== args.rpc) await assertChain(args.publicRpc, CHAIN_ID);
  const rpcUrl = args.rpc;

  const dir = args.dir;
  if (existsSync(dir) && !statSync(dir).isDirectory()) throw new Error(`refusing: --dir ${dir} is not a directory`);
  if (existsSync(dir) && readdirSync(dir).length > 0 && !existsSync(join(dir, DIR_MARKER))) {
    throw new Error(`refusing: --dir ${dir} is non-empty and was not made by testnet:up (no ${DIR_MARKER}). Nothing was touched`);
  }

  const deployment = readDeployment();
  const chain = defineChain({
    id: CHAIN_ID,
    name: "Arc Testnet",
    nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  const pub = createPublicClient({ chain, transport: http(rpcUrl, RPC_RETRY) }) as PublicClient;
  const limits = await readHub(pub, deployment);
  const pin = hubPinProblem(deployment);
  if (pin !== null) throw new Error(pin);
  if (parseUnits(args.botDeposit, 6) > limits.maxDepositPerPlayer) {
    throw new Error(`refusing: --bot-deposit ${args.botDeposit} is above the hub's ${formatUnits(limits.maxDepositPerPlayer, 6)} USDC cap`);
  }

  if (!(await isPortFree(args.port))) throw new Error(`refusing: port ${args.port} is already in use. Pass --port. Nothing was started`);
  const previous = readPids(dir);
  const stillRunning = [
    ...(previous.up && isOurs("up", previous.up, dir) ? [`testnet:up (pid ${previous.up.pid})`] : []),
    ...(previous.server && isOurs("server", previous.server, dir) ? [`the server (pid ${previous.server.pid})`] : []),
    ...previous.bots.filter((b) => isOurs("bot", b, dir)).map((b) => `${b.name} (pid ${b.pid})`),
  ];
  if (stillRunning.length > 0) {
    throw new Error(`refusing: a previous testnet:up is still running: ${stillRunning.join(", ")}. Run "pnpm testnet:down" first`);
  }

  // state.json: the deployment this directory belongs to. The server's database and every bot home are bound to it.
  const statePath = join(dir, "state.json");
  let state: State;
  if (existsSync(statePath)) {
    state = JSON.parse(readFileSync(statePath, "utf8")) as State;
    if (state.hub.toLowerCase() !== deployment.hub.toLowerCase() || state.chainId !== CHAIN_ID) {
      throw new Error(
        `refusing: ${dir} was made for hub ${state.hub}, but ${DEPLOYMENT_FILE} now names ${deployment.hub} (a redeploy). ` +
          `Its database and bot homes cannot move to a new hub: run "pnpm testnet:down --withdraw" (the bots' USDC goes back ` +
          `to the deployer), then move ${dir} aside and rerun`,
      );
    }
  } else {
    const head = await pub.getBlockNumber();
    state = {
      chainId: CHAIN_ID,
      ...deployment,
      // The indexer starts here, not at block 0: Arc testnet is ~69M blocks deep. Channels opened through this server
      // all come later; the database's own cursor takes over once it exists.
      startBlock: (args.startBlock ?? (head > 1_000n ? head - 1_000n : 0n)).toString(),
      createdAt: new Date().toISOString(),
    };
  }

  // Fix round 1 (I-1): every existing bot home, before anything starts.
  const botsDir = join(dir, "house-bots");
  const existing: Array<BotHome & { rpcUrl: string }> = [];
  for (let i = 1; i <= args.houseBots; i++) {
    const home = join(botsDir, `house-${i}`);
    if (!existsSync(join(home, "config.json")) || !existsSync(join(home, "wallet.json"))) continue;
    const cfg = loadConfig(home, { warn: () => {} });
    existing.push({ name: `house-${i}`, hub: cfg.hub, minChallengeTimeout: minChallengeTimeoutOf(cfg), rpcUrl: cfg.rpcUrl });
  }
  const problems = botHomeProblems(existing, { hub: deployment.hub, botTimeout: args.botTimeout, bounds: limits.timeoutBounds });
  if (problems.refusals.length > 0) throw new Error(`refusing: ${problems.refusals.join("; ")}. Nothing was started`);
  for (const n of problems.notes) process.stderr.write(`testnet-up: note: ${n}\n`);
  for (const h of existing) {
    if (h.rpcUrl !== rpcUrl) {
      process.stderr.write(`testnet-up: note: ${h.name} keeps its own RPC (${shownUrl(h.rpcUrl)}); init changes it only with every channel finalized\n`);
    }
  }

  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, DIR_MARKER), `${state.createdAt}\n`);
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
  const logsDir = join(dir, "logs");
  mkdirSync(logsDir, { recursive: true });
  mkdirSync(botsDir, { recursive: true });
  const wrapperPath = writeArenaWrapper(dir, CLI_BIN);
  const payPath = writePayWrapper(dir, rpcUrl);
  upDir = dir;
  const pids: PidsFile = { up: { pid: process.pid, startTime: await startTimeOrThrow(process.pid, "testnet:up") }, bots: [] };
  writePids(dir, pids);

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  const configPath = join(dir, "server.json");
  const serverConfig = buildServerConfig({
    dir,
    port: args.port,
    rpcUrl,
    publicRpcUrl: args.publicRpc,
    deployment,
    limits,
    serverLimits: args.limits,
    startBlock: BigInt(state.startBlock),
    cliCommand: wrapperPath,
    deposit: args.botDeposit,
    stake: args.botStake,
  });
  writeFileSync(configPath, `${JSON.stringify(serverConfig, null, 2)}\n`, { mode: 0o600 });

  const serverLog = join(logsDir, "server.log");
  process.stderr.write(`testnet-up: starting the host server on 127.0.0.1:${args.port} (logging to ${serverLog})\n`);
  const serverFd = openSync(serverLog, "a");
  server = spawn(process.execPath, [SERVER_BIN, "--config", configPath], { cwd: REPO_ROOT, detached: true, stdio: ["ignore", serverFd, serverFd] });
  server.on("exit", (code, signal) => {
    if (!shuttingDown) process.stderr.write(`testnet-up: the server exited (code=${code} signal=${signal}); see ${serverLog}\n`);
  });
  pids.server = { pid: server.pid!, startTime: await startTimeOrThrow(server.pid, "the server"), config: configPath };
  writePids(dir, pids);
  const serverUrl = `http://127.0.0.1:${args.port}`;
  await unlessExits(server, "the server", waitForHttp(`${serverUrl}/healthz`, "server", 60_000));

  const ready: Array<{ name: string; address: Address; apiPort: number; log: string; offer: boolean; paid: string | null }> = [];
  const takenPorts = new Set<number>([args.port]);
  let sharedXmtpSdk: string | undefined;
  const target = parseUnits(args.botUsdc, 18);
  let paidWei = 0n;
  for (let i = 1; i <= args.houseBots; i++) {
    if (shuttingDown) return;
    const name = `house-${i}`;
    const home = join(botsDir, name);
    const log = join(logsDir, `${name}.log`);
    mkdirSync(home, { recursive: true });

    // Init once. A home with config.json and wallet.json is reused as is (its wallet, owner, API port and channels).
    let address: Address;
    if (!existsSync(join(home, "config.json")) || !existsSync(join(home, "wallet.json"))) {
      const apiPort = await pickApiPort(args.port + i, takenPorts);
      const init = await arena(home, [
        "init",
        "--server", serverUrl,
        // The host's own RPC, not the published one: a keyed provider stays between this machine and the bots.
        "--rpc", rpcUrl,
        "--port", String(apiPort),
        "--poll-ms", HOUSE_BOT_POLL_MS,
        "--owner", DEPLOYER,
        ...(args.botTimeout !== undefined ? ["--min-challenge-timeout", String(args.botTimeout)] : []),
      ]);
      if (init.code !== 0) throw new Error(`arena init failed for ${name}:\n${init.stderr.slice(-2000)}`);
      const summary = lastJsonObject(init.stdout);
      if (summary.chainId !== CHAIN_ID || String(summary.hub).toLowerCase() !== deployment.hub.toLowerCase()) {
        throw new Error(`${name}'s init came back with chain ${String(summary.chainId)}, hub ${String(summary.hub)}`);
      }
      address = getAddress(String(summary.wallet));
      process.stderr.write(`testnet-up: ${name} initialised: wallet ${address}, API 127.0.0.1:${apiPort}\n`);
    } else {
      const w = await arena(home, ["wallet"]);
      if (w.code !== 0) throw new Error(`arena wallet failed for ${name}:\n${w.stderr.slice(-2000)}`);
      address = getAddress(String(lastJsonObject(w.stdout).address));
      process.stderr.write(`testnet-up: reusing ${name}: wallet ${address}\n`);
    }
    const cfg = loadConfig(home, { warn: () => {} });
    const apiPort = cfg.port;
    takenPorts.add(apiPort);

    // The owner: recorded by init for a new home; a home without one gets the deployer. A different one is left alone.
    const owner = await arena(home, ["owner"]);
    const recorded = owner.code === 0 ? lastJsonObject(owner.stdout).owner : undefined;
    if (recorded === null) {
      const set = await arena(home, ["owner", "set", DEPLOYER]);
      if (set.code !== 0) throw new Error(`arena owner set failed for ${name}:\n${set.stderr.slice(-2000)}`);
    } else if (typeof recorded === "string" && recorded.toLowerCase() !== DEPLOYER.toLowerCase()) {
      process.stderr.write(`testnet-up: note: ${name}'s owner is ${recorded}, not the deployer; withdraw pays there\n`);
    }

    // Plan 5.7 pattern (dev-up --xmtp-local): one real SDK install, symlinked into every other bot home.
    if (args.xmtpBots) {
      const sdk = join(home, "xmtp", "sdk");
      const present = existsSync(sdk) || (() => { try { return lstatSync(sdk).isSymbolicLink(); } catch { return false; } })();
      if (present) sharedXmtpSdk ??= sdk;
      else if (sharedXmtpSdk === undefined) {
        process.stderr.write(`testnet-up: arena xmtp enable for ${name} (a one-time npm install, about 480 MB)\n`);
        const r = await arena(home, ["xmtp", "enable"], 1_200_000);
        if (r.code !== 0) throw new Error(`arena xmtp enable failed for ${name}:\n${r.stderr.slice(-2000)}`);
        sharedXmtpSdk = sdk;
      } else {
        mkdirSync(join(home, "xmtp"), { recursive: true });
        symlinkSync(sharedXmtpSdk, sdk, "dir");
      }
    }
    if (shuttingDown) return;

    // Started before it is funded: its API is what tells what it already holds in channels, and it is the watchtower
    // of those channels either way. It posts no offer until its balance covers one (bot.ts's own rule; it rechecks
    // every 15 s).
    if (!(await isPortFree(apiPort))) throw new Error(`${name}'s API port ${apiPort} is in use (by what? a daemon still running on ${home}?)`);
    process.stderr.write(`testnet-up: starting house bot ${name} (logging to ${log})\n`);
    const fd = openSync(log, "a");
    const bot = spawn(
      process.execPath,
      [
        CLI_BIN, "bot", "--allow-real-chain",
        "--deposit", args.botDeposit,
        "--stake", args.botStake,
        "--idle-close-seconds", HOUSE_BOT_IDLE_CLOSE_SECONDS,
        ...(args.botTimeout !== undefined ? ["--timeout", String(args.botTimeout)] : []),
      ],
      { cwd: REPO_ROOT, env: { ...process.env, ARENA_HOME: home }, detached: true, stdio: ["ignore", fd, fd] },
    );
    bot.on("exit", (code, signal) => {
      if (!shuttingDown) process.stderr.write(`testnet-up: house bot ${name} exited (code=${code} signal=${signal}); see ${log}\n`);
    });
    bots.push({ name, child: bot });
    pids.bots.push({ name, home, pid: bot.pid!, startTime: await startTimeOrThrow(bot.pid, `house bot ${name}`) });
    writePids(dir, pids);
    const channels = await botChannels(home, bot, name, 90_000);

    // Fix round 1 (I-3): top up what it holds overall, not its wallet alone.
    const sessionGasWei = cfg.sessionGasWei;
    const walletWei = await pub.getBalance({ address });
    const holdings = holdingsWei(walletWei, channels, sessionGasWei);
    const due = target > 0n ? topUpAmount(holdings, target) : null;
    if (due !== null) {
      process.stderr.write(
        `testnet-up: funding ${name} with ${due} USDC (it holds ${formatUnits(holdings, 18)} of ${args.botUsdc}: wallet, channels and session gas)\n`,
      );
      const p = await runPay(payPath, address, due);
      if (p.code === 0) paidWei += parseUnits(due, 18);
      else process.stderr.write(`testnet-up: funding ${name} failed (exit ${p.code}); see above\n`);
    }
    if (shuttingDown) return;
    const unsettled = channels.filter((c) => !c.degraded && !SETTLED_PHASES.has(c.phase ?? "")).length;
    const need = openNeedWei({
      deposit6: parseUnits(args.botDeposit, 6),
      feePerPlayer6: limits.feePerPlayer,
      sessionGasWei,
      feeCeilingWei: feeCeilingOf(cfg),
      otherChannels: unsettled,
    });
    const balance = await pub.getBalance({ address });
    const funded = balance >= need;
    if (!funded) {
      process.stderr.write(
        `testnet-up: ${name}'s wallet holds ${formatUnits(balance, 18)} USDC, under the ${formatUnits(need, 18)} one more offer needs ` +
          `(deposit, fee, session gas and the gas reserve of ${unsettled} open channel(s)): no offer until ${address} has more\n`,
      );
    }
    const offer = funded && (await unlessExits(bot, `house bot ${name}`, waitForOffer(serverUrl, address, 120_000)));
    if (funded && !offer) process.stderr.write(`testnet-up: ${name} has posted no offer after 120s; see ${log}\n`);
    ready.push({ name, address, apiPort, log, offer, paid: due });
  }
  if (shuttingDown) return;
  // A bot that started and then died (after its offer, or while unfunded) still fails the run.
  for (const b of bots) await unlessExits(b.child, `house bot ${b.name}`, Promise.resolve());

  const agentPorts = portsFrom(args.port + 11, 3);
  const prompt = agentPrompt(serverUrl, args.botStake, agentPorts[0]!);
  const hubLink = `${EXPLORER}/address/${deployment.hub}`;
  process.stderr.write("\ntestnet-up: ready (Arc TESTNET, chain 5042002; faucet USDC only).\n\n");
  process.stderr.write(`  skill.md:  ${serverUrl}/skill.md\n`);
  process.stderr.write(`  watch:     ${serverUrl}/  (every channel, each with a live board at /watch/<id>; open offers: ${serverUrl}/offers)\n`);
  process.stderr.write(`  hub:       ${hubLink}${limits.paused ? "  (PAUSED: no new channels)" : ""}\n`);
  process.stderr.write(`  arena CLI: ${wrapperPath}\n`);
  process.stderr.write(`  pay:       ${payPath} <agent address> <usdc>   (at most ${PAY_MAX_USDC} per call; ${payPath} balance)\n`);
  process.stderr.write(`  paid this run: ${formatUnits(paidWei, 18)} USDC to house bots\n\n`);
  for (const b of ready) {
    process.stderr.write(`  ${b.name}: ${b.address}${b.offer ? "" : " (no offer yet)"}  API ${b.apiPort}  log ${b.log}\n`);
  }
  process.stderr.write(`\n  Give an agent this:\n\n    ${prompt}\n\n`);
  process.stderr.write(
    `  More agents: each in its own directory, with its own port (${agentPorts.slice(1).join(", ")}, ...).\n\n`,
  );
  process.stderr.write("  Ctrl-C here stops the house bots and the server (only those). pnpm testnet:down does the same from elsewhere.\n\n");
  console.log(
    JSON.stringify({
      ready: true,
      chainId: CHAIN_ID,
      serverUrl,
      skillMd: `${serverUrl}/skill.md`,
      watch: `${serverUrl}/`,
      hub: deployment.hub,
      hubExplorer: hubLink,
      dir,
      arena: wrapperPath,
      pay: payPath,
      paidUsdc: formatUnits(paidWei, 18),
      houseBots: ready,
      prompt,
      agentPorts,
    }),
  );
  await new Promise<void>(() => {}); // keep running until Ctrl-C
}

// ------------------------------------------------------------------------------------------------- down

/** Fix round 1 (m-8): `down` acts only on a directory testnet:up made for Arc testnet: dev-up's `.arena-dev/` has the
 *  same `house-bots/<name>` layout, and `--withdraw` there would run against the demo Anvil. */
export function assertTestnetDir(dir: string): void {
  if (!existsSync(join(dir, DIR_MARKER))) throw new Error(`refusing: ${dir} was not made by testnet:up (no ${DIR_MARKER})`);
  let state: { chainId?: unknown };
  try {
    state = JSON.parse(readFileSync(join(dir, "state.json"), "utf8")) as { chainId?: unknown };
  } catch {
    throw new Error(`refusing: ${dir} has no readable state.json`);
  }
  if (state.chainId !== CHAIN_ID) throw new Error(`refusing: ${dir}'s state.json is for chain ${String(state.chainId)}, not Arc testnet (${CHAIN_ID})`);
}

async function down(args: DownArgs): Promise<void> {
  const { dir } = args;
  assertTestnetDir(dir);
  let p = readPids(dir);
  if (args.withdraw) await settle(dir, p, args.settleSeconds);
  // A testnet:up still in the foreground somewhere: let it stop its own children, in order.
  if (p.up && isOurs("up", p.up, dir)) {
    await stopPid("testnet:up", p.up.pid, p.up.startTime, PAY_RECEIPT_TIMEOUT_MS + 120_000);
    p = readPids(dir);
  } else if (p.up && alive(p.up.pid)) {
    process.stderr.write(`testnet-down: pid ${p.up.pid} is no longer testnet:up: left alone\n`);
  }
  for (const b of p.bots) {
    if (isOurs("bot", b, dir)) await stopPid(`house bot ${b.name}`, b.pid, b.startTime, 30_000);
    else if (alive(b.pid)) process.stderr.write(`testnet-down: pid ${b.pid} is no longer house bot ${b.name}: left alone\n`);
  }
  if (p.server) {
    if (isOurs("server", p.server, dir)) await stopPid("server", p.server.pid, p.server.startTime, 10_000);
    else if (alive(p.server.pid)) process.stderr.write(`testnet-down: pid ${p.server.pid} is no longer the server: left alone\n`);
  }
  rmSync(join(dir, "pids.json"), { force: true });
  process.stderr.write("testnet-down: stopped.\n");
  if (!args.withdraw) return;

  const botsDir = join(dir, "house-bots");
  const homes = existsSync(botsDir) ? readdirSync(botsDir).filter((n) => existsSync(join(botsDir, n, "config.json"))).sort() : [];
  for (const name of homes) {
    try {
      await withdrawHome(name, join(botsDir, name), join(dir, "logs"));
    } catch (err) {
      process.stderr.write(`testnet-down: ${name}: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }
}

/**
 * Fix round 1 (m-14): `down --withdraw`'s settling, while the stack is still up. Each running house bot is asked to
 * close every open channel whose game is over (`arena close`: a cooperative close, which the opponent's daemon must
 * co-sign over the relay), and this waits up to `seconds` for those channels to finalize. A channel in the middle of
 * a game is left as it is. Nothing here is forced: what does not finalize is listed by the withdraw step.
 */
async function settle(dir: string, p: PidsFile, seconds: number): Promise<void> {
  const running = p.bots.filter((b) => isOurs("bot", b, dir));
  if (running.length === 0 || seconds === 0) return;
  const asked: Array<{ name: string; home: string; channelId: string }> = [];
  for (const b of running) {
    const r = await arena(b.home, ["channels"], 60_000);
    if (r.code !== 0) continue;
    let list: ChannelView[];
    try {
      list = lastJson(r.stdout) as ChannelView[];
    } catch {
      continue;
    }
    for (const c of Array.isArray(list) ? list : []) {
      const over = c.gameStatus === "white_won" || c.gameStatus === "black_won" || c.gameStatus === "draw";
      if (c.degraded || c.phase !== "Open" || !over || c.channelId === undefined) continue;
      const close = await arena(b.home, ["close", "--channel", c.channelId], 60_000);
      if (close.code === 0) asked.push({ name: b.name, home: b.home, channelId: c.channelId });
      else process.stderr.write(`testnet-down: ${b.name}: close ${c.channelId}: ${close.stderr.trim().slice(-300)}\n`);
    }
  }
  if (asked.length === 0) return;
  process.stderr.write(`testnet-down: asked for ${asked.length} cooperative close(s); waiting up to ${seconds}s for them to finalize\n`);
  const end = Date.now() + seconds * 1000;
  let pending = asked;
  while (pending.length > 0 && Date.now() < end) {
    await sleep(5_000);
    const still: typeof pending = [];
    for (const a of pending) {
      const r = await arena(a.home, ["status", "--channel", a.channelId], 60_000);
      const phase = r.code === 0 ? (lastJson(r.stdout) as ChannelView).phase : undefined;
      if (phase === "Finalized") process.stderr.write(`testnet-down: ${a.name}: ${a.channelId} finalized\n`);
      else still.push(a);
    }
    pending = still;
  }
  for (const a of pending) process.stderr.write(`testnet-down: ${a.name}: ${a.channelId} did not finalize in ${seconds}s (its opponent has not co-signed)\n`);
}

/** `down --withdraw` for one bot home: its daemon, a sweep, the channels that still hold escrow, `withdraw --all`. */
async function withdrawHome(name: string, home: string, logsDir: string): Promise<void> {
  process.stderr.write(`testnet-down: ${name}: starting its daemon to sweep and withdraw\n`);
  mkdirSync(logsDir, { recursive: true });
  const fd = openSync(join(logsDir, `${name}-withdraw.log`), "a");
  const daemon = spawn(process.execPath, [CLI_BIN, "daemon"], { cwd: REPO_ROOT, env: { ...process.env, ARENA_HOME: home }, stdio: ["ignore", "pipe", fd] });
  try {
    const started = await new Promise<boolean>((resolvePromise) => {
      const timer = setTimeout(() => resolvePromise(false), 60_000);
      daemon.stdout?.once("data", () => {
        clearTimeout(timer);
        resolvePromise(true);
      });
      daemon.once("exit", () => {
        clearTimeout(timer);
        resolvePromise(false);
      });
    });
    daemon.stdout?.resume(); // never let its pipe fill
    if (!started) {
      process.stderr.write(`testnet-down: ${name}: its daemon did not start; see ${join(logsDir, `${name}-withdraw.log`)}\n`);
      return;
    }
    const sweep = await arena(home, ["sweep"], 300_000);
    if (sweep.code !== 0) process.stderr.write(`testnet-down: ${name}: sweep: ${sweep.stderr.trim().slice(-400)}\n`);
    const ch = await arena(home, ["channels"]);
    if (ch.code === 0) {
      try {
        const list = lastJson(ch.stdout) as ChannelView[];
        for (const c of Array.isArray(list) ? list : []) {
          if (!c.degraded && SETTLED_PHASES.has(c.phase ?? "")) continue;
          process.stderr.write(
            `testnet-down: ${name}: channel ${c.channelId} is ${c.degraded ? "degraded" : c.phase}: its escrow is not in the wallet yet\n`,
          );
        }
      } catch {
        process.stderr.write(`testnet-down: ${name}: could not read its channel list\n`);
      }
    }
    const w = await arena(home, ["withdraw", "--all"], 300_000);
    if (w.code === 0) process.stderr.write(`testnet-down: ${name}: withdrew to the owner: ${JSON.stringify(lastJson(w.stdout))}\n`);
    else process.stderr.write(`testnet-down: ${name}: withdraw --all: ${w.stderr.trim().slice(-400)}\n`);
  } finally {
    if (daemon.exitCode === null && daemon.signalCode === null) {
      const exited = new Promise<void>((r) => daemon.once("exit", () => r()));
      daemon.kill("SIGTERM");
      await Promise.race([exited, sleep(20_000).then(() => daemon.kill("SIGKILL"))]);
    }
  }
}

// ------------------------------------------------------------------------------------------------- main

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (cmd === "pay") return pay(rest);
  if (cmd === "down") {
    await down(parseDownArgs(rest));
    return 0;
  }
  await up(parseUpArgs(cmd === "up" ? rest : argv));
  return 0;
}

// Only when executed directly (`tsx scripts/testnet-up.ts`), not when imported by its test.
if (process.argv[1] && resolve(process.argv[1]) === SELF) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    async (err: unknown) => {
      process.stderr.write(`testnet: ${err instanceof Error ? err.message : String(err)}\n`);
      // Same teardown as a Ctrl-C: a failure after the server started must not leave it running.
      if (!shuttingDown) {
        shuttingDown = true;
        await teardown().catch(() => {});
      }
      process.exit(1);
    },
  );
}
