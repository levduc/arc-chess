/**
 * Process harness for Plan 4.5 Task 7's system tests. Drives real OS processes -- Anvil, the compiled contracts
 * (deployed through viem, not `forge script`, so nothing races the shared `contracts/deployments/<chainid>.json`
 * file), the host server (`apps/server/bin/arena-server.mjs`), and `arena daemon` child processes
 * (`packages/cli/bin/arena.mjs`) -- so later tasks (dispute e2e, adversarial, chaos, load, LLM games) can build on
 * one API instead of re-inventing process plumbing each time.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
let processHooksInstalled = false;

/** Kills every process group this module has ever spawned, best-effort. Shared by the `exit` backstop and the
 *  explicit SIGINT/SIGTERM handlers below. */
function killAllTracked(): void {
  for (const pgid of TRACKED_PGIDS) {
    try {
      process.kill(-pgid, "SIGKILL");
    } catch {
      // already gone
    }
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
  /** Talks to this daemon's local HTTP API (the same surface an agent uses). Throws on a non-2xx response. */
  api(method: "GET" | "POST", path: string, body?: object): Promise<any>;
  /** Sends `signal` (default SIGTERM) to the daemon's process group and waits for it to exit. */
  kill(signal?: NodeJS.Signals): Promise<void>;
  /** Restarts `arena daemon` on this player's existing ARENA_HOME (same wallet, config, and API port). */
  start(): Promise<void>;
  /** The daemon process's combined stdout+stderr, most recent lines last. */
  logs(): string;
  /** This player's daemon's current OS pid (a method, not a field, since it changes across `kill()`/`start()`),
   *  or `undefined` if it has exited. For soak/load sampling: `/proc/<pid>/status` (RSS) and `/proc/<pid>/fd`. */
  pid(): number | undefined;
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
  player(name: string, key?: Hex, opts?: { serverUrl?: string; rpcUrl?: string }): Promise<Player>;
  /** Gives `address` native gas (100 ETH) and, unless `usdc` is 0, mints it MockUSDC (default 10 USDC) -- the same
   *  funding `player()` gives a daemon's wallet, for SDK-only actors (a malicious peer, an attacker). */
  fund(address: Address, usdc?: bigint): Promise<void>;
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
export function runCli(args: string[], home: string): Promise<{ stdout: string; stderr: string; status: number }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("node", [CLI_BIN, ...args], {
      cwd: REPO_ROOT,
      env: { ...process.env, ARENA_HOME: home },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
    child.once("error", reject);
    child.once("close", (code) => resolvePromise({ stdout, stderr, status: code ?? 1 }));
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
  const tried = new Set<number>();
  const attempts = preferred !== undefined ? 1 : MAX_ANVIL_BIND_ATTEMPTS;
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    const port = await pickAnvilPort(preferred, tried);
    tried.add(port);
    const rpcUrl = `http://127.0.0.1:${port}`;
    const anvilArgs = ["--port", String(port), "--silent"];
    if (blockTime !== undefined) anvilArgs.push("--block-time", String(blockTime));
    const tracked = spawnTracked(`anvil:${port}`, "anvil", anvilArgs, {
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
      defaults: { deposit: "1000000", stakePerGame: "100000", challengeTimeout: "600" },
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

    async function player(name: string, key?: Hex, opts: { serverUrl?: string; rpcUrl?: string } = {}): Promise<Player> {
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
      ],
      home,
    );
    if (init.status !== 0) {
      throw new Error(`arena init failed for player "${name}":\n${init.stderr || init.stdout}`);
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

    const api = async (method: "GET" | "POST", path: string, body?: object): Promise<any> => {
      const res = await fetch(`${apiUrl}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-arena-actor": "agent" },
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
