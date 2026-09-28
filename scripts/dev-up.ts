/**
 * `pnpm dev:up [--port 8080] [--anvil-port 8545] [--players 2]`
 *
 * Brings up a local Agent Chess Arena stack for manual play: Anvil, a contract deployment (via `forge script`),
 * the host server, and one funded ARENA_HOME per player (via `arena init`) -- everything under `.arena-dev/`
 * (gitignored). It does not start the players' daemons itself; it prints the exact command to start each one, so
 * you can run them in separate terminals (or as separate agents) and watch them play.
 *
 * Refuses cleanly if the requested Anvil or server port is already busy (e.g. the on-machine demo stack on
 * :8545/:8080) -- it never kills another process to make room. Ctrl-C tears down everything it started.
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { createPublicClient, createTestClient, createWalletClient, http } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";

const REPO_ROOT = join(import.meta.dirname, "..");
const CONTRACTS_DIR = join(REPO_ROOT, "contracts");
const CLI_BIN = join(REPO_ROOT, "packages/cli/bin/arena.mjs");
const SERVER_BIN = join(REPO_ROOT, "apps/server/bin/arena-server.mjs");
const DEV_DIR = join(REPO_ROOT, ".arena-dev");

// Anvil's well-known default account 0, derived from its built-in test mnemonic ("test test test test test test
// test test test test test junk"). Anvil pre-funds it with ETH at startup. Local-dev only: never use this key
// anywhere real funds could reach it.
const OWNER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;

const PLAYER_NAMES = ["alice", "bob", "carol", "dave", "erin", "frank", "grace", "heidi"];

function parseArgs(argv: string[]): { port: number; anvilPort: number; players: number } {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a?.startsWith("--")) {
      const v = argv[i + 1];
      if (v !== undefined) flags.set(a.slice(2), v);
      i++;
    }
  }
  return {
    port: Number(flags.get("port") ?? "8080"),
    anvilPort: Number(flags.get("anvil-port") ?? "8545"),
    players: Number(flags.get("players") ?? "2"),
  };
}

async function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const srv = createServer();
    srv.once("error", () => resolvePromise(false));
    srv.listen(port, "127.0.0.1", () => srv.close(() => resolvePromise(true)));
  });
}

async function freeTcpPort(): Promise<number> {
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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForHttp(url: string, label: string, timeoutMs = 30_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await sleep(150);
  }
  throw new Error(`${label} did not become ready within ${timeoutMs}ms (${url})`);
}

async function waitForRpc(url: string, label: string, timeoutMs = 30_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
        signal: AbortSignal.timeout(2_000),
      });
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await sleep(150);
  }
  throw new Error(`${label} did not become ready within ${timeoutMs}ms (${url})`);
}

/** Stops a child (SIGTERM, then SIGKILL after `graceMs` if it hasn't exited). These children are plain (not
 *  detached), so they share dev-up's own process group -- `child.kill()` is used rather than a process-group
 *  kill, which would target the wrong id (or nothing at all) for a non-group-leader child. */
async function stopChild(label: string, child: ChildProcess | undefined, graceMs = 5_000): Promise<void> {
  if (!child || child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  process.stderr.write(`dev-up: stopping ${label}...\n`);
  const exited = new Promise<void>((resolvePromise) => child.once("exit", () => resolvePromise()));
  child.kill("SIGTERM");
  const timedOut = await Promise.race([exited.then(() => false), sleep(graceMs).then(() => true)]);
  if (timedOut && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  await exited;
}

// Module-level (not local to `main()`) so both the signal handlers *and* the top-level `.catch()` below can
// reach the same teardown -- a failure partway through `main()` (a bad deploy, `arena init` failing, ...) must
// tear down whatever was already spawned just as surely as a Ctrl-C does; it must never leave Anvil or the
// server running with nothing left able to stop them.
let anvil: ChildProcess | undefined;
let server: ChildProcess | undefined;
let shuttingDown = false;

async function teardown(): Promise<void> {
  await stopChild("server", server);
  await stopChild("anvil", anvil);
}

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  process.stderr.write(`\ndev-up: caught ${signal}, tearing down\n`);
  await teardown();
  process.stderr.write("dev-up: stopped\n");
  process.exit(0);
}

async function main(): Promise<void> {
  const { port: serverPort, anvilPort, players: numPlayers } = parseArgs(process.argv.slice(2));

  if (!(await isPortFree(anvilPort))) {
    process.stderr.write(
      `dev-up: refusing to start -- port ${anvilPort} is already in use (the demo stack, or a previous dev-up?). ` +
        `Pass --anvil-port to use a different one. Nothing was started or killed.\n`,
    );
    process.exit(1);
  }
  if (!(await isPortFree(serverPort))) {
    process.stderr.write(
      `dev-up: refusing to start -- port ${serverPort} is already in use (the demo stack, or a previous dev-up?). ` +
        `Pass --port to use a different one. Nothing was started or killed.\n`,
    );
    process.exit(1);
  }

  // Wipe any previous run's state before starting anything new. This run deploys a fresh set of contracts on a
  // fresh chain (even at the same --anvil-port, Anvil starts from block 0 again each time), so reusing an old
  // .arena-dev/server.sqlite here would point the indexer's persisted cursor -- and the server's whole notion of
  // which chain/deployment this database belongs to -- at a chain that no longer exists. The server's own
  // startup now refuses to run against a mismatched database (see apps/server's chain-identity check), but
  // dev-up avoids ever hitting that refusal by not reusing stale state in the first place.
  rmSync(DEV_DIR, { recursive: true, force: true });
  mkdirSync(DEV_DIR, { recursive: true });
  const playersDir = join(DEV_DIR, "players");
  mkdirSync(playersDir, { recursive: true });

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  process.stderr.write(`dev-up: starting anvil on :${anvilPort}\n`);
  anvil = spawn("anvil", ["--port", String(anvilPort)], {
    cwd: REPO_ROOT,
    env: { ...process.env, PATH: `${process.env.HOME}/.foundry/bin:${process.env.PATH ?? ""}` },
    stdio: ["ignore", "ignore", "inherit"],
  });
  const rpcUrl = `http://127.0.0.1:${anvilPort}`;
  await waitForRpc(rpcUrl, "anvil");

  process.stderr.write("dev-up: deploying contracts (forge script)\n");
  const owner = privateKeyToAccount(OWNER_KEY).address;
  const deploy = spawnSync("forge", ["script", "script/Deploy.s.sol", "--rpc-url", rpcUrl, "--broadcast", "--private-key", OWNER_KEY], {
    cwd: CONTRACTS_DIR,
    env: {
      ...process.env,
      PATH: `${process.env.HOME}/.foundry/bin:${process.env.PATH ?? ""}`,
      ARENA_OWNER: owner,
      ARENA_FEE_RECIPIENT: owner,
    },
    encoding: "utf8",
    stdio: ["ignore", "inherit", "inherit"],
  });
  if (deploy.status !== 0) {
    throw new Error("forge script failed (see output above)");
  }
  const deploymentPath = join(CONTRACTS_DIR, "deployments", `${foundry.id}.json`);
  const deployment = JSON.parse(readFileSync(deploymentPath, "utf8")) as {
    token: string;
    chessRules: string;
    channelHub: string;
  };

  const serverConfigPath = join(DEV_DIR, "server.json");
  const serverConfig = {
    host: "127.0.0.1",
    port: serverPort,
    publicUrl: "",
    rpcUrl,
    publicRpcUrl: "",
    chainId: foundry.id,
    hub: deployment.channelHub,
    usdc: deployment.token,
    rules: deployment.chessRules,
    dbPath: join(DEV_DIR, "server.sqlite"),
    fundingWindow: "3600",
    offerMaxLifetime: "86400",
    defaults: { deposit: "1000000", stakePerGame: "100000", challengeTimeout: "600" },
    cliCommand: "arena",
    audit: "unaudited (development build)",
    indexer: { pollMs: 1_000, chunkBlocks: 1000, startBlock: 0 },
    limits: {},
    trustProxy: false,
  };
  writeFileSync(serverConfigPath, JSON.stringify(serverConfig, null, 2));

  process.stderr.write(`dev-up: starting the host server on :${serverPort}\n`);
  server = spawn("node", [SERVER_BIN, "--config", serverConfigPath], {
    cwd: REPO_ROOT,
    stdio: ["ignore", "inherit", "inherit"],
  });
  const serverUrl = `http://127.0.0.1:${serverPort}`;
  await waitForHttp(`${serverUrl}/healthz`, "server");

  const pub = createPublicClient({ chain: foundry, transport: http(rpcUrl) });
  const deployer = createWalletClient({ account: privateKeyToAccount(OWNER_KEY), chain: foundry, transport: http(rpcUrl) });
  const testClient = createTestClient({ mode: "anvil", chain: foundry, transport: http(rpcUrl) });

  const commands: string[] = [];
  for (let i = 0; i < numPlayers; i++) {
    const name = PLAYER_NAMES[i] ?? `player${i + 1}`;
    const key = generatePrivateKey();
    const address = privateKeyToAccount(key).address;
    await testClient.setBalance({ address, value: 10n ** 20n });
    const mintHash = await deployer.writeContract({
      address: deployment.token as `0x${string}`,
      abi: [
        {
          type: "function",
          name: "mint",
          stateMutability: "nonpayable",
          inputs: [
            { name: "to", type: "address" },
            { name: "amount", type: "uint256" },
          ],
          outputs: [],
        },
      ] as const,
      functionName: "mint",
      args: [address, 100_000_000n], // 100 USDC (6 decimals)
      chain: foundry,
      account: deployer.account,
    });
    await pub.waitForTransactionReceipt({ hash: mintHash });

    const home = join(playersDir, name);
    mkdirSync(home, { recursive: true });
    const apiPort = await freeTcpPort();
    const init = spawnSync(
      "node",
      [CLI_BIN, "init", "--server", serverUrl, "--wallet-key", key, "--port", String(apiPort), "--poll-ms", "500"],
      { cwd: REPO_ROOT, env: { ...process.env, ARENA_HOME: home }, encoding: "utf8" },
    );
    if (init.status !== 0) {
      throw new Error(`arena init failed for ${name}:\n${init.stderr}`);
    }
    commands.push(`ARENA_HOME=${home} node ${CLI_BIN} daemon`);
  }

  process.stderr.write("\ndev-up: ready.\n\n");
  process.stderr.write(`  owner/deployer private key (LOCAL DEV ONLY, never use for real funds): ${OWNER_KEY}\n`);
  process.stderr.write(`  anvil:  ${rpcUrl}\n`);
  process.stderr.write(`  server: ${serverUrl}\n\n`);
  process.stderr.write("  start each player's daemon in its own terminal:\n\n");
  for (const cmd of commands) process.stderr.write(`    ${cmd}\n`);
  process.stderr.write("\n  Ctrl-C here tears down anvil and the server.\n\n");

  // One machine-readable line, last, so tooling (and this task's own dev-up test) can wait for it deterministically.
  console.log(JSON.stringify({ ready: true, anvilPort, serverPort, rpcUrl, serverUrl, players: numPlayers }));

  await new Promise<void>(() => {}); // keep running until Ctrl-C
}

main().catch(async (err: unknown) => {
  process.stderr.write(`dev-up: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  // Route through the same teardown as a Ctrl-C: whatever was already spawned (Anvil, at minimum, since it's
  // always the first thing started) must not be left running just because the failure happened after spawn
  // instead of before it. `shuttingDown` also guards against racing an in-flight SIGINT/SIGTERM handler.
  if (!shuttingDown) {
    shuttingDown = true;
    await teardown().catch(() => {});
  }
  process.exit(1);
});
