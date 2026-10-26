/**
 * Process harness for Plan 4.5 Task 7's system tests. Drives real OS processes -- Anvil, the compiled contracts
 * (deployed through viem, not `forge script`, so nothing races the shared `contracts/deployments/<chainid>.json`
 * file), the host server (`apps/server/bin/arena-server.mjs`), and `arena daemon` child processes
 * (`packages/cli/bin/arena.mjs`) -- so later tasks (dispute e2e, adversarial, chaos, load, LLM games) can build on
 * one API instead of re-inventing process plumbing each time.
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  getAddress,
  http,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { channelHubAbi, mockUsdcAbi } from "@arena/sdk";
import { loadToken } from "@arena/cli";

// -------------------------------------------------------------------------------------------------------- paths

const REPO_ROOT = join(import.meta.dirname, "../..");
const CONTRACTS_OUT = join(REPO_ROOT, "contracts/out");
export const CLI_BIN = join(REPO_ROOT, "packages/cli/bin/arena.mjs");
export const SERVER_BIN = join(REPO_ROOT, "apps/server/bin/arena-server.mjs");

/** Anvil default accounts 0 (deployer/owner), 1..N (players unless a caller passes its own key), 3 (fee
 *  recipient/"host"). Copied from packages/sdk/test/helpers/chain.ts's ANVIL_KEYS -- reimplemented here (not
 *  imported) because that module's deploy/mint/setLimits helpers are bound to a fixed RPC (its global-setup's
 *  Anvil on :8546); this harness needs the same operations against whichever port it picked for this stack. */
export const ANVIL_KEYS = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
] as const satisfies readonly Hex[];

// -------------------------------------------------------------------------------------------- process bookkeeping

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** A spawned child process, its own process group, and its captured output. */
type Tracked = {
  child: ChildProcess;
  label: string;
  /** Ring buffer of combined stdout+stderr lines, capped, for diagnostics. */
  lines: string[];
};

const TRACKED_PGIDS = new Set<number>();
/** Plan 5.7 Task 5: compose projects `startXmtpLocal` brought up and has not taken down yet. */
const TRACKED_COMPOSE = new Set<string>();
let processHooksInstalled = false;

/** Kills every process group this module has ever spawned, best-effort, and takes down every XMTP local-node
 *  fixture still up (synchronously: this also runs as an `exit` listener). Shared by the `exit` backstop and the
 *  explicit SIGINT/SIGTERM handlers below. */
function killAllTracked(): void {
  for (const pgid of TRACKED_PGIDS) {
    try {
      process.kill(-pgid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  downTrackedComposeSync();
}

/** Takes down (`down -v`, synchronously) every XMTP local-node fixture `startXmtpLocal` started and has not stopped. */
function downTrackedComposeSync(): void {
  for (const project of TRACKED_COMPOSE) {
    spawnSync("docker", composeArgs(project, ["down", "-v", "--timeout", "5"]), { stdio: "ignore", timeout: 60_000 });
    TRACKED_COMPOSE.delete(project);
  }
}

/** Registered once per process. Two layers, because they cover different cases:
 *  - `process.on("exit", ...)` is the backstop for a normal exit (the test run finishes, or `process.exit()` is
 *    called elsewhere) -- 'exit' listeners can only do synchronous work, which `killAllTracked` is.
 *  - `process.on("SIGINT"/"SIGTERM", ...)` is required *in addition*: Node's default disposition for a signal
 *    that reaches a process with no listener registered for it is to terminate immediately, without ever
 *    emitting 'exit' -- so a bare Ctrl-C (or a `kill`) during a test run would otherwise leave every detached
 *    Anvil/server/daemon child orphaned. Registering a handler switches Node to the listener-driven path, so this
 *    process's own shutdown is now in our control: clean up, then exit with the conventional 128+signal code. */
function installProcessHooks(): void {
  if (processHooksInstalled) return;
  processHooksInstalled = true;
  process.on("exit", killAllTracked);
  process.on("SIGINT", () => {
    killAllTracked();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    killAllTracked();
    process.exit(143);
  });
}

function pushLine(t: Tracked, line: string): void {
  t.lines.push(line);
  if (t.lines.length > 500) t.lines.shift();
}

function attachLogging(t: Tracked, stream: NodeJS.ReadableStream | null): void {
  if (!stream) return;
  let buf = "";
  stream.on("data", (chunk: Buffer) => {
    buf += chunk.toString("utf8");
    let idx: number;
    while ((idx = buf.indexOf("\n")) >= 0) {
      pushLine(t, buf.slice(0, idx));
      buf = buf.slice(idx + 1);
    }
  });
  stream.on("end", () => {
    if (buf) pushLine(t, buf);
    buf = "";
  });
}

/** Spawns `cmd` in its own process group (so the harness can kill the whole tree it starts), capturing combined
 *  stdout+stderr for diagnostics. */
function spawnTracked(label: string, cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Tracked {
  installProcessHooks();
  const child = spawn(cmd, args, {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (typeof child.pid === "number") TRACKED_PGIDS.add(child.pid);
  const t: Tracked = { child, label, lines: [] };
  attachLogging(t, child.stdout);
  attachLogging(t, child.stderr);
  child.once("exit", () => {
    if (typeof child.pid === "number") TRACKED_PGIDS.delete(child.pid);
  });
  return t;
}

function tailLog(t: Tracked, n = 50): string {
  return t.lines.slice(-n).join("\n");
}

function isExited(t: Tracked): boolean {
  return t.child.exitCode !== null || t.child.signalCode !== null;
}

/** Resolves once `child` has exited (immediately if it already has); rejects after `timeoutMs`. */
function waitForExit(child: ChildProcess, timeoutMs = 10_000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      child.removeListener("exit", onExit);
      reject(new Error(`process did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      resolvePromise();
    };
    child.once("exit", onExit);
  });
}

/** SIGTERMs `t`'s process group, waits up to `graceMs`, then SIGKILLs it. No-ops if it has already exited. */
async function terminate(t: Tracked, graceMs = 5_000): Promise<void> {
  if (isExited(t)) return;
  const pid = t.child.pid;
  if (pid === undefined) return;
  const exited = waitForExit(t.child, graceMs + 5_000);
  try {
    process.kill(-pid, "SIGTERM");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
  }
  const timedOut = await Promise.race([exited.then(() => false), sleep(graceMs).then(() => true)]);
  if (timedOut && !isExited(t)) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
    }
  }
  await exited.catch(() => {});
}

// ------------------------------------------------------------------------------------------------- port picking

export async function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const srv = createServer();
    srv.once("error", () => resolvePromise(false));
    srv.listen(port, "127.0.0.1", () => srv.close(() => resolvePromise(true)));
  });
}

/** An ephemeral free port, picked by binding to port 0 and reading back what the OS assigned. */
export async function freeTcpPort(): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;
      srv.close(() => resolvePromise(port));
    });
  });
}

const ANVIL_PORT_MIN = 8600;
const ANVIL_PORT_MAX = 8699;

/** Plan 6 Task 3: which anvil binary `startAnvil` spawns -- `tools/bin/arc-anvil` for `pnpm test:arc`, plain
 *  `anvil` (today's behaviour) otherwise. */
const ANVIL_BIN = process.env.ARENA_ANVIL_BIN ?? "anvil";
/** Arc Foundry's anvil needs `--network arc` to model Arc's EVM semantics (the EIP-7708 native-transfer log;
 *  a 20 gwei base-fee floor that holds at this process's default chain id, 31337, and at 5042, but decays
 *  away by chain id 5042002 -- tools/arc-foundry.md point 3 has the full table; never pass `--chain-id`
 *  through here, so this always stays at 31337) -- inferred from `ANVIL_BIN`'s basename rather than a
 *  separate flag, so a caller only has to point `ARENA_ANVIL_BIN` at `arc-anvil` to get both. */
const ANVIL_NETWORK_ARGS = /(?:^|\/)arc-anvil$/.test(ANVIL_BIN) ? ["--network", "arc"] : [];
/** Plan 6 Task 3: when set (`pnpm test:arc`), the preferred port `startAnvil` uses in place of its usual
 *  dynamic scan over `ANVIL_PORT_MIN`-`ANVIL_PORT_MAX` -- so the Arc subset never races a concurrent
 *  standard-anvil system-test run for the same port. Must fall within that reserved range; unset, today's
 *  dynamic-scan behaviour for system tests is exactly unchanged. */
const ENV_ANVIL_PORT = process.env.ARENA_TEST_ANVIL_PORT ? Number(process.env.ARENA_TEST_ANVIL_PORT) : undefined;

/** Picks an Anvil port from the 8600-8699 range reserved for this harness (never the demo stack's :8545), with a
 *  bind check so two stacks started back to back don't race for the same port. `excluding` skips ports already
 *  known to be bad in this call (e.g. Anvil itself just failed to bind one, even though the bind check said it
 *  was free -- a caller retrying after such a failure passes the previous port back in here). An explicit
 *  `preferred` port outside the reserved range is refused outright, never silently reassigned. */
export async function pickAnvilPort(preferred?: number, excluding: ReadonlySet<number> = new Set()): Promise<number> {
  if (preferred !== undefined) {
    if (preferred < ANVIL_PORT_MIN || preferred > ANVIL_PORT_MAX) {
      throw new Error(`anvil port ${preferred} is outside the harness's reserved range ${ANVIL_PORT_MIN}-${ANVIL_PORT_MAX}`);
    }
    if (!(await isPortFree(preferred))) throw new Error(`anvil port ${preferred} is already in use`);
    return preferred;
  }
  for (let port = ANVIL_PORT_MIN; port <= ANVIL_PORT_MAX; port++) {
    if (excluding.has(port)) continue;
    if (await isPortFree(port)) return port;
  }
  throw new Error(`no free anvil port in ${ANVIL_PORT_MIN}-${ANVIL_PORT_MAX}`);
}

// -------------------------------------------------------------------------------------------------- readiness

/** Polls `check()` until it resolves truthy, racing against `t` exiting; throws with the child's last 50 log
 *  lines on either timeout or an early exit, so a broken child process fails with a diagnosable error. */
async function waitReady(t: Tracked, timeoutMs: number, check: () => Promise<boolean>): Promise<void> {
  const start = Date.now();
  let lastErr: unknown;
  while (Date.now() - start < timeoutMs) {
    if (isExited(t)) {
      throw new Error(
        `${t.label}: exited before becoming ready (code=${t.child.exitCode} signal=${t.child.signalCode})\n${tailLog(t)}`,
      );
    }
    try {
      if (await check()) return;
    } catch (err) {
      lastErr = err;
    }
    await sleep(100);
  }
  throw new Error(
    `${t.label}: timed out after ${timeoutMs}ms waiting to become ready` +
      `${lastErr ? ` (last error: ${String(lastErr)})` : ""}\n${tailLog(t)}`,
  );
}

async function waitForRpc(t: Tracked, rpcUrl: string, timeoutMs = 20_000): Promise<void> {
  await waitReady(t, timeoutMs, async () => {
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      signal: AbortSignal.timeout(2_000),
    });
    return res.ok;
  });
}

async function waitForHttp(t: Tracked, url: string, timeoutMs = 20_000): Promise<void> {
  await waitReady(t, timeoutMs, async () => {
    const res = await fetch(url, { signal: AbortSignal.timeout(2_000) });
    return res.ok;
  });
}

// --------------------------------------------------------------------------------------------------- contracts

/** A compiled contract's ABI and creation bytecode from `contracts/out` (or `outDir`). Exported for tests that deploy
 *  a contract of their own next to the stack's (e.g. an attacker's second ChannelHub). */
export function artifact(name: string, outDir: string = CONTRACTS_OUT): { abi: Abi; bytecode: Hex } {
  const json = JSON.parse(readFileSync(join(outDir, `${name}.sol/${name}.json`), "utf8")) as {
    abi: Abi;
    bytecode: { object: Hex };
  };
  return { abi: json.abi, bytecode: json.bytecode.object };
}

async function deployContracts(
  deployer: WalletClient,
  pub: PublicClient,
  host: Address,
  outDir: string,
): Promise<{ usdc: Address; rules: Address; hub: Address }> {
  const deploy = async (name: string, args: unknown[]): Promise<Address> => {
    const a = artifact(name, outDir);
    const hash = await deployer.deployContract({
      abi: a.abi,
      bytecode: a.bytecode,
      args,
      chain: foundry,
      account: deployer.account!,
    });
    const receipt = await pub.waitForTransactionReceipt({ hash });
    if (!receipt.contractAddress) throw new Error(`deploy ${name} failed (no contractAddress in receipt)`);
    return getAddress(receipt.contractAddress);
  };
  const usdc = await deploy("MockUSDC", []);
  const rules = await deploy("ChessRules", []);
  const hub = await deploy("ChannelHub", [
    usdc,
    deployer.account!.address,
    host,
    5_000n,
    1_000_000n,
    10_000_000n,
    10n ** 12n,
  ]);
  return { usdc, rules, hub };
}

// ------------------------------------------------------------------------------------------------------- types

export type Player = {
  name: string;
  home: string;
  address: Address;
  apiUrl: string;
  token: string;
  /** Talks to this daemon's local HTTP API (the same surface an agent uses). Throws on a non-2xx response, with the
   *  status code in the message. `actor` is the `x-arena-actor` header (default "agent"; the web board sends
   *  "human"). */
  api(method: "GET" | "POST", path: string, body?: object, actor?: "agent" | "human"): Promise<any>;
  /** Sends `signal` (default SIGTERM) to the daemon's process group and waits for it to exit. */
  kill(signal?: NodeJS.Signals): Promise<void>;
  /** Restarts `arena daemon` on this player's existing ARENA_HOME (same wallet, config, and API port). */
  start(): Promise<void>;
  /** The daemon process's combined stdout+stderr, most recent lines last. */
  logs(): string;
  /** This player's daemon's current OS pid (a method, not a field, since it changes across `kill()`/`start()`),
   *  or `undefined` if it has exited. For soak/load sampling: `/proc/<pid>/status` (RSS) and `/proc/<pid>/fd`. */
  pid(): number | undefined;
  /** Plan 5.7 Task 5: how the current daemon process exited (`code` 0 after a clean shutdown; `signal` set when a
   *  signal killed it outright), or null while it runs. Optional only so hand-built test doubles of `Player` need not
   *  carry it; `Stack.player()` always provides it. */
  exitStatus?(): { code: number | null; signal: NodeJS.Signals | null } | null;
};

/** `serverUrl`/`rpcUrl`: see `Stack.player`. `sessionGasWei`/`sessionGasFloor`: the daemon's session-key dispute gas
 *  target and refill floor (`arena init --session-gas-wei/--session-gas-floor`); default 1e16 wei and half of it. */
export type PlayerOptions = {
  serverUrl?: string;
  rpcUrl?: string;
  sessionGasWei?: bigint;
  sessionGasFloor?: bigint;
  /** Plan 5.7 Task 5: an installed SDK directory (`installXmtpSdk().sdkDir`, an `arena xmtp enable` home's
   *  `xmtp/sdk`). The player's `<home>/xmtp/sdk` becomes a symlink to it before its daemon starts, so a whole test
   *  run shares one real install. With the server publishing `xmtp`, the daemon then starts with `fallback: "xmtp"`. */
  xmtpSdkDir?: string;
};

export type Stack = {
  rpcUrl: string;
  chainId: number;
  hub: Address;
  usdc: Address;
  rules: Address;
  host: Address;
  serverUrl: string;
  server: ChildProcess;
  anvil: ChildProcess;
  /** The host server's sqlite database file (e.g. to read its relay cache from a test). */
  serverDbPath: string;
  /** Creates, funds and starts a daemon player. `opts.serverUrl` points its `arena init --server` (and so its
   *  daemon's host connection) somewhere other than the stack's own server -- e.g. at a MITM proxy in front of it.
   *  `opts.rpcUrl` overrides the RPC the daemon uses (`arena init --rpc`) -- e.g. a faulty RPC proxy in front of
   *  this stack's Anvil; everything else still comes from the server's `/templates`. */
  player(name: string, key?: Hex, opts?: PlayerOptions): Promise<Player>;
  /** Gives `address` native gas (100 ETH) and, unless `usdc` is 0, mints it MockUSDC (default 10 USDC) -- the same
   *  funding `player()` gives a daemon's wallet, for SDK-only actors (a malicious peer, an attacker). */
  fund(address: Address, usdc?: bigint): Promise<void>;
  /** Plan 5.7 Task 5: stops the host server and leaves it down, the site-outage case: by default SIGTERM (then
   *  SIGKILL after a grace period); `"SIGKILL"` kills it outright, a crash. `restartServer()` brings it back on the
   *  same port, config and database. */
  stopServer(signal?: "SIGTERM" | "SIGKILL"): Promise<void>;
  /** Stops the server (a no-op when `stopServer()` already did) and starts it again on the same port and DB. */
  restartServer(): Promise<void>;
  setLimits(maxDeposit: bigint, maxCommitted: bigint): Promise<void>;
  setPaused(p: boolean): Promise<void>;
  increaseTime(seconds: number): Promise<void>;
  stop(): Promise<void>;
};

// ------------------------------------------------------------------------------------------------- Stack build

/** Runs one `arena` CLI command to completion. Asynchronous on purpose (not spawnSync): a caller may be serving the
 *  very endpoint the command talks to from this same process -- e.g. a MITM proxy in front of the server that `arena
 *  init --server` fetches `/templates` through -- and a blocked event loop would deadlock against it. */
export function runCli(
  args: string[],
  home: string,
  opts: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<{ stdout: string; stderr: string; status: number }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("node", [CLI_BIN, ...args], {
      cwd: REPO_ROOT,
      env: { ...process.env, ...opts.env, ARENA_HOME: home },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    // Plan 5.7 Task 5: an optional bound (an `xmtp enable` whose npm install hangs must fail the run, not stall it).
    const timer =
      opts.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            stderr += `\n[harness] runCli: killed after ${opts.timeoutMs}ms`;
            child.kill("SIGKILL");
          }, opts.timeoutMs);
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
    child.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ stdout, stderr, status: code ?? 1 });
    });
  });
}

// A pathological run of bad luck (or a systemic problem unrelated to the port itself, e.g. a missing `anvil`
// binary) must not retry forever -- cap it well under the size of the reserved range.
const MAX_ANVIL_BIND_ATTEMPTS = 5;

/** Spawns Anvil, retrying with the next free port in 8600-8699 if it exits early (a bind failure the free-port
 *  check above missed, e.g. a race with something else grabbing the port) -- but only when the caller let this
 *  function pick the port itself; an explicit `preferred` port's failure is never silently swapped out from under
 *  the caller. */
async function startAnvil(preferred: number | undefined, blockTime: number | undefined): Promise<{ tracked: Tracked; port: number; rpcUrl: string }> {
  // Plan 6 Task 3: an explicit caller `preferred` port always wins; otherwise ARENA_TEST_ANVIL_PORT (set only
  // for `pnpm test:arc`) stands in for it, so that mode's dynamic-scan is skipped too -- unset, this is
  // `undefined` exactly as before.
  const effectivePreferred = preferred ?? ENV_ANVIL_PORT;
  const tried = new Set<number>();
  const attempts = effectivePreferred !== undefined ? 1 : MAX_ANVIL_BIND_ATTEMPTS;
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    const port = await pickAnvilPort(effectivePreferred, tried);
    tried.add(port);
    const rpcUrl = `http://127.0.0.1:${port}`;
    const anvilArgs = ["--port", String(port), ...ANVIL_NETWORK_ARGS, "--silent"];
    if (blockTime !== undefined) anvilArgs.push("--block-time", String(blockTime));
    const tracked = spawnTracked(`anvil:${port}`, ANVIL_BIN, anvilArgs, {
      env: { ...process.env, PATH: `${process.env.HOME}/.foundry/bin:${process.env.PATH ?? ""}` },
    });
    try {
      await waitForRpc(tracked, rpcUrl);
      return { tracked, port, rpcUrl };
    } catch (err) {
      await terminate(tracked).catch(() => {});
      lastErr = err;
      // Only retry when Anvil actually exited (a real bind/startup failure). A timeout with the process still
      // running is a different, more concerning failure mode (e.g. RPC hung) -- surface it immediately rather
      // than masking it as a port race.
      if (!isExited(tracked)) throw err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("anvil did not start after retrying free ports");
}

export async function startStack(
  opts: {
    anvilPort?: number;
    serverOverrides?: object;
    blockTime?: number;
    /** Test-only: overrides where compiled contract artifacts are read from, to exercise `startStack()`'s
     *  cleanup-on-partial-failure path (e.g. point it at a directory with no `MockUSDC.sol/MockUSDC.json`). */
    contractsOutOverride?: string;
  } = {},
): Promise<Stack> {
  const dir = mkdtempSync(join(tmpdir(), "arena-system-"));
  const registry: Tracked[] = [];
  try {
    const { tracked: anvilTracked, port: anvilPort, rpcUrl } = await startAnvil(opts.anvilPort, opts.blockTime);
    registry.push(anvilTracked);

    const pub = createPublicClient({ chain: foundry, transport: http(rpcUrl) }) as PublicClient;
    const deployer = createWalletClient({ account: privateKeyToAccount(ANVIL_KEYS[0]), chain: foundry, transport: http(rpcUrl) });
    const testClient = createTestClient({ mode: "anvil", chain: foundry, transport: http(rpcUrl) });
    const host = privateKeyToAccount(ANVIL_KEYS[3]).address;
    const { usdc, rules, hub } = await deployContracts(deployer, pub, host, opts.contractsOutOverride ?? CONTRACTS_OUT);

    const serverPort = await freeTcpPort();
    const serverConfigPath = join(dir, "server.json");
    const baseConfig = {
      host: "127.0.0.1",
      port: serverPort,
      publicUrl: "",
      rpcUrl,
      publicRpcUrl: "",
      chainId: foundry.id,
      hub,
      usdc,
      rules,
      dbPath: join(dir, "server.sqlite"),
      fundingWindow: "3600",
      offerMaxLifetime: "86400",
      // Final fix wave (M9): 900 s, as dev-up serves -- since c7ead3d this override takes effect, and every daemon
      // refuses a challengeTimeout below its own 900 s minChallengeTimeout default.
      defaults: { deposit: "1000000", stakePerGame: "100000", challengeTimeout: "900" },
      cliCommand: "arena",
      audit: "unaudited (development build)",
      indexer: { pollMs: 200, chunkBlocks: 1000, startBlock: 0 },
      limits: {},
      trustProxy: false,
      ...(opts.serverOverrides ?? {}),
    };
    writeFileSync(serverConfigPath, JSON.stringify(baseConfig, null, 2));
    const serverUrl = `http://127.0.0.1:${serverPort}`;

    let serverTracked = spawnTracked(`server:${serverPort}`, "node", [SERVER_BIN, "--config", serverConfigPath], { cwd: REPO_ROOT });
    registry.push(serverTracked);
    await waitForHttp(serverTracked, `${serverUrl}/healthz`);

    const players: Array<{ home: string; getTracked: () => Tracked }> = [];

    async function fund(address: Address, amount = 10_000_000n): Promise<void> {
      await testClient.setBalance({ address, value: 10n ** 20n });
      if (amount === 0n) return;
      const mintHash = await deployer.writeContract({
        address: usdc,
        abi: mockUsdcAbi,
        functionName: "mint",
        args: [address, amount],
        chain: foundry,
        account: deployer.account!,
      });
      await pub.waitForTransactionReceipt({ hash: mintHash });
    }

    async function player(name: string, key?: Hex, opts: PlayerOptions = {}): Promise<Player> {
    const walletKey = key ?? generatePrivateKey();
    const address = privateKeyToAccount(walletKey).address;
    await fund(address);

    const home = mkdtempSync(join(dir, `player-${name}-`));
    const apiPort = await freeTcpPort();
    const init = await runCli(
      [
        "init",
        "--server",
        opts.serverUrl ?? serverUrl,
        ...(opts.rpcUrl ? ["--rpc", opts.rpcUrl] : []),
        "--wallet-key",
        walletKey,
        "--port",
        String(apiPort),
        "--poll-ms",
        "200",
        // The suites use the hub's minimum challengeTimeout (60 s) and move chain time with increaseTime; the
        // daemon's production floor is 900 s (final review I4).
        "--min-challenge-timeout",
        "60",
        // Explicit, so the suites' session-key balances do not depend on Anvil's gas price (arena init's default is
        // derived from it, final review C1).
        "--session-gas-wei",
        String(opts.sessionGasWei ?? 10n ** 16n),
        ...(opts.sessionGasFloor !== undefined ? ["--session-gas-floor", String(opts.sessionGasFloor)] : []),
      ],
      home,
    );
    if (init.status !== 0) {
      throw new Error(`arena init failed for player "${name}":\n${init.stderr || init.stdout}`);
    }
    if (opts.xmtpSdkDir !== undefined) {
      mkdirSync(join(home, "xmtp"), { recursive: true });
      symlinkSync(opts.xmtpSdkDir, join(home, "xmtp", "sdk"), "dir");
    }

    let tracked = spawnTracked(`daemon:${name}`, "node", [CLI_BIN, "daemon"], {
      cwd: REPO_ROOT,
      env: { ...process.env, ARENA_HOME: home },
    });
    registry.push(tracked);
    const apiUrl = `http://127.0.0.1:${apiPort}`;
    await waitForHttp(tracked, `${apiUrl}/health`);
    const token = loadToken(home);

    players.push({ home, getTracked: () => tracked });

    const api = async (method: "GET" | "POST", path: string, body?: object, actor: "agent" | "human" = "agent"): Promise<any> => {
      const res = await fetch(`${apiUrl}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-arena-actor": actor },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${(payload as { error?: string }).error ?? res.statusText}`);
      return payload;
    };

    return {
      name,
      home,
      address,
      apiUrl,
      token,
      api,
      async kill(signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
        if (isExited(tracked)) return;
        const pid = tracked.child.pid;
        const exited = waitForExit(tracked.child, 10_000);
        if (pid !== undefined) {
          try {
            process.kill(-pid, signal);
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
          }
        }
        await exited;
      },
      async start(): Promise<void> {
        tracked = spawnTracked(`daemon:${name}`, "node", [CLI_BIN, "daemon"], {
          cwd: REPO_ROOT,
          env: { ...process.env, ARENA_HOME: home },
        });
        registry.push(tracked);
        await waitForHttp(tracked, `${apiUrl}/health`);
      },
      logs(): string {
        return tracked.lines.join("\n");
      },
      pid(): number | undefined {
        return tracked.child.pid;
      },
      exitStatus() {
        return isExited(tracked) ? { code: tracked.child.exitCode, signal: tracked.child.signalCode } : null;
      },
    };
  }

  return {
    rpcUrl,
    chainId: foundry.id,
    hub,
    usdc,
    rules,
    host,
    serverUrl,
    serverDbPath: baseConfig.dbPath,
    get server(): ChildProcess {
      return serverTracked.child;
    },
    get anvil(): ChildProcess {
      return anvilTracked.child;
    },
    player,
    fund,
    async stopServer(signal: "SIGTERM" | "SIGKILL" = "SIGTERM"): Promise<void> {
      if (signal === "SIGTERM" || isExited(serverTracked) || serverTracked.child.pid === undefined) {
        await terminate(serverTracked);
        return;
      }
      const exited = waitForExit(serverTracked.child, 10_000);
      try {
        process.kill(-serverTracked.child.pid, "SIGKILL");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
      }
      await exited;
    },
    async restartServer(): Promise<void> {
      await terminate(serverTracked);
      serverTracked = spawnTracked(`server:${serverPort}`, "node", [SERVER_BIN, "--config", serverConfigPath], { cwd: REPO_ROOT });
      registry.push(serverTracked);
      await waitForHttp(serverTracked, `${serverUrl}/healthz`);
    },
    async setLimits(maxDeposit: bigint, maxCommitted: bigint): Promise<void> {
      const hash = await deployer.writeContract({
        address: hub,
        abi: channelHubAbi,
        functionName: "setLimits",
        args: [maxDeposit, maxCommitted],
        chain: foundry,
        account: deployer.account!,
      });
      await pub.waitForTransactionReceipt({ hash });
    },
    async setPaused(p: boolean): Promise<void> {
      const hash = await deployer.writeContract({
        address: hub,
        abi: channelHubAbi,
        functionName: "setPaused",
        args: [p],
        chain: foundry,
        account: deployer.account!,
      });
      await pub.waitForTransactionReceipt({ hash });
    },
    async increaseTime(seconds: number): Promise<void> {
      await testClient.increaseTime({ seconds });
      await testClient.mine({ blocks: 1 });
    },
    async stop(): Promise<void> {
      await Promise.all(registry.map((t) => terminate(t).catch(() => {})));
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best effort
      }
    },
    };
  } catch (err) {
    // A failure at any point above (a bad deploy, the server never becoming healthy, ...) must not leave whatever
    // was already spawned (Anvil, at minimum) running with nothing left to stop it and no test able to reach it.
    await Promise.all(registry.map((t) => terminate(t).catch(() => {})));
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort
    }
    throw err;
  }
}

/** Reads an ERC-20 (MockUSDC) balance directly from the chain -- for asserting exact settlement amounts. */
export async function usdcBalanceOf(stack: Stack, who: Address): Promise<bigint> {
  const pub = createPublicClient({ chain: foundry, transport: http(stack.rpcUrl) });
  return pub.readContract({ address: stack.usdc, abi: mockUsdcAbi, functionName: "balanceOf", args: [who] }) as Promise<bigint>;
}

/** True if the daemon's home lock file exists on disk right now (used to verify a SIGKILL leaves a stale lock,
 *  and that `Player.start()` still succeeds by taking it over). */
export function hasLockFile(home: string): boolean {
  return existsSync(join(home, "daemon.lock"));
}

// ------------------------------------------------------------------------------- XMTP local node (Plan 5.7 Task 5)

/** Task 3's fixture: a pinned copy of xmtp/xmtp-local-node, every image pinned by digest, host ports parameterized. */
export const XMTP_COMPOSE_FILE = join(REPO_ROOT, "tests/system/xmtp-local/docker-compose.yml");

function composeArgs(project: string, args: string[]): string[] {
  return ["compose", "-p", project, "-f", XMTP_COMPOSE_FILE, ...args];
}

/** Why the XMTP local node cannot run here (no Docker, the daemon down, no compose plugin), or null when it can. A
 *  cheap synchronous probe, meant to be checked once at module load (as xmtp-local.test.ts does). */
export function dockerUnavailableReason(): string | null {
  const info = spawnSync("docker", ["info"], { stdio: "ignore", timeout: 30_000 });
  if (info.error) return `docker is not available (${String(info.error.message)})`;
  if (info.status !== 0) return "`docker info` failed (is the Docker daemon running?)";
  const compose = spawnSync("docker", ["compose", "version"], { stdio: "ignore", timeout: 30_000 });
  if (compose.error || compose.status !== 0) return "the `docker compose` plugin is not available";
  return null;
}

/** One `docker compose` command, asynchronously (a `spawnSync` would block the event loop, and with it the draining
 *  of every tracked child's output pipes), bounded by `timeoutMs`. Never rejects. */
function runCompose(
  project: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<{ status: number | null; output: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn("docker", composeArgs(project, args), { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const timer = setTimeout(() => {
      output += `\n[harness] docker compose ${args.join(" ")}: killed after ${timeoutMs}ms`;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (c: Buffer) => (output += c.toString("utf8")));
    child.stderr.on("data", (c: Buffer) => (output += c.toString("utf8")));
    child.once("error", (err) => {
      clearTimeout(timer);
      resolvePromise({ status: null, output: `${output}\n${String(err)}` });
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ status: code, output });
    });
  });
}

let composeExitHookInstalled = false;

/** An `exit` backstop for fixtures alone (synchronous `down -v`), installed without any signal handler, so a caller
 *  with its own SIGINT/SIGTERM teardown (dev-up) keeps it. Test processes also get `installProcessHooks`'s signal
 *  handlers from their stacks, and those take fixtures down too. */
function installComposeExitHook(): void {
  if (composeExitHookInstalled) return;
  composeExitHookInstalled = true;
  process.on("exit", downTrackedComposeSync);
}

export type XmtpLocal = {
  /** The XMTP SDK's `apiUrl`: the `XMTP_API_PORT`-mapped port (container 5556), node-go's gRPC/HTTP2 endpoint. */
  apiUrl: string;
  /** The compose project, unique per call. Every container of the fixture carries it as its project label. */
  project: string;
  ports: { grpc: number; api: number; history: number };
  /** `up -d` (including any image pull) and readiness after it, in milliseconds. */
  timings: { upMs: number; readyMs: number };
  /** `docker compose down -v` for this project. Idempotent; never throws (a failure is returned as text). */
  stop(): Promise<string | null>;
};

/** Three distinct free host ports (two back-to-back `freeTcpPort()` calls can, rarely, return the same one). */
async function distinctFreePorts(n: number): Promise<number[]> {
  const ports = new Set<number>();
  while (ports.size < n) ports.add(await freeTcpPort());
  return [...ports];
}

/**
 * Plan 5.7 Task 5: brings up XMTP's local node from Task 3's pinned fixture and waits until it answers, modelled on
 * tests/system/xmtp-local.test.ts:
 * - a unique compose project per call (`opts.project`, default `arena-xmtp-<pid>-<time>`) and three freshly picked
 *   host ports, so it never collides with another run or touches anything else;
 * - readiness is a real HTTP response on the `XMTP_GRPC_PORT`-mapped port (container 5555, the one node-go serves
 *   HTTP on), never a bare TCP connect (Docker's proxy accepts those before node-go is up);
 * - teardown is always `down -v`: on a failed start here, from `stop()`, and from the process's `exit` backstop.
 * History sync is moot: the daemon's transport runs with `disableDeviceSync: true`, so `XMTP_HISTORY_PORT` is only
 * mapped (to a free port) to keep the fixture off the default 5558.
 */
export async function startXmtpLocal(
  opts: { project?: string; upTimeoutMs?: number; readyTimeoutMs?: number } = {},
): Promise<XmtpLocal> {
  const project = opts.project ?? `arena-xmtp-${process.pid}-${Date.now()}`;
  const [grpc, api, history] = await distinctFreePorts(3);
  const env = { XMTP_GRPC_PORT: String(grpc), XMTP_API_PORT: String(api), XMTP_HISTORY_PORT: String(history) };
  installComposeExitHook();
  TRACKED_COMPOSE.add(project);
  let stopped = false;
  const stop = async (): Promise<string | null> => {
    if (stopped) return null;
    stopped = true;
    const down = await runCompose(project, ["down", "-v", "--timeout", "5"], env, 120_000);
    TRACKED_COMPOSE.delete(project);
    return down.status === 0 ? null : `docker compose down -v failed (exit ${String(down.status)}): ${down.output.slice(-2000)}`;
  };
  try {
    const t0 = Date.now();
    // `--pull missing`: a cold first run pulls the five pinned images (minutes); later runs start offline.
    const up = await runCompose(project, ["up", "-d", "--quiet-pull", "--pull", "missing"], env, opts.upTimeoutMs ?? 600_000);
    if (up.status !== 0) throw new Error(`docker compose up failed (exit ${String(up.status)}):\n${up.output.slice(-4000)}`);
    const upMs = Date.now() - t0;
    const t1 = Date.now();
    const deadline = t1 + (opts.readyTimeoutMs ?? 120_000);
    let lastErr: unknown;
    for (;;) {
      try {
        const res = await fetch(`http://127.0.0.1:${grpc}/`, { signal: AbortSignal.timeout(2_000) });
        await res.body?.cancel().catch(() => undefined);
        break; // any HTTP response (a 404 included) is node-go itself answering
      } catch (err) {
        lastErr = err;
      }
      if (Date.now() > deadline) {
        throw new Error(`XMTP local node never answered HTTP on :${grpc} within ${opts.readyTimeoutMs ?? 120_000}ms (last error: ${String(lastErr)})`);
      }
      await sleep(500);
    }
    return { apiUrl: `http://127.0.0.1:${api}`, project, ports: { grpc, api, history }, timings: { upMs, readyMs: Date.now() - t1 }, stop };
  } catch (err) {
    await stop();
    throw err;
  }
}

/** Plan 5.7 Task 5: npm's cache for the SDK install, shared across runs under the system-test temp root, so only a
 *  cold machine downloads the SDK's ~150 MB of tarballs. Set through npm's own `npm_config_cache` setting; nothing
 *  else about npm (its registry, scripts, or safety settings) is overridden. */
export const XMTP_NPM_CACHE = join(tmpdir(), "arena-system-xmtp-npm-cache");

export type XmtpSdkInstall = {
  /** The temp ARENA_HOME `arena xmtp enable` ran in. */
  home: string;
  /** `<home>/xmtp/sdk`: what each player's own `<home>/xmtp/sdk` symlinks to (`PlayerOptions.xmtpSdkDir`). */
  sdkDir: string;
  /** How long the install took, in milliseconds. */
  ms: number;
  /** Deletes the install (about 480 MB). */
  remove(): void;
};

/**
 * Plan 5.7 Task 5 (ruling 1): installs the real `@xmtp/node-sdk` once, with the real `arena xmtp enable` (npm, the
 * pinned version, temp-then-rename), into a fresh temp ARENA_HOME. A test file calls this once (in `beforeAll`) and
 * points every player at it through `PlayerOptions.xmtpSdkDir`, so a run installs the SDK once, not once per home.
 */
export async function installXmtpSdk(opts: { timeoutMs?: number } = {}): Promise<XmtpSdkInstall> {
  const home = mkdtempSync(join(tmpdir(), "arena-system-xmtp-sdk-"));
  const remove = () => rmSync(home, { recursive: true, force: true });
  const t0 = Date.now();
  const r = await runCli(["xmtp", "enable"], home, { env: { npm_config_cache: XMTP_NPM_CACHE }, timeoutMs: opts.timeoutMs ?? 600_000 });
  if (r.status !== 0) {
    remove();
    throw new Error(`arena xmtp enable failed (exit ${r.status}):\n${(r.stderr || r.stdout).slice(-4000)}`);
  }
  return { home, sdkDir: join(home, "xmtp", "sdk"), ms: Date.now() - t0, remove };
}
