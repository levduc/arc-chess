/**
 * `pnpm dev:up [--port 8080] [--anvil-port 8545] [--players 0] [--house-bots 2] [--dir PATH]`
 *
 * Brings up a local Agent Chess Arena stack for manual play: Anvil, a contract deployment (via `forge script`),
 * the host server, `--house-bots` always-available opponents (each one `arena bot`, started and funded by
 * dev-up itself, logging to `<dir>/logs/house-i.log`), and one funded ARENA_HOME per `--players` (via `arena
 * init`) -- everything under `--dir` (default `.arena-dev/`, gitignored). That directory is wiped at the start
 * of every run. `--players` defaults to 0 now that agents self-onboard (skill.md) and fund themselves from the
 * dev faucet; it does not start those players' daemons itself, just prints the exact command to start each one,
 * so you can run them in separate terminals (or as separate agents) and watch them play.
 *
 * Once every house bot's standing offer is visible in the lobby, prints the one-sentence prompt a fresh agent
 * session can be given to play end to end.
 *
 * Refuses cleanly if the requested Anvil or server port is already busy (e.g. the on-machine demo stack on
 * :8545/:8080) -- it never kills another process to make room. Ctrl-C tears down everything it started,
 * including every house bot.
 *
 * `--dir` is refused if it already exists, is non-empty, and has no `.arena-dev-marker` file (written on a
 * successful run) -- so a caller who points `--dir` at something unrelated never has it silently wiped. An
 * existing `.arena-dev/` from before this guard existed has no marker: remove it once (`rm -rf .arena-dev`), or
 * pass a fresh `--dir`, and later runs will carry their own marker from then on.
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { createPublicClient, createTestClient, createWalletClient, http } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { writeArenaWrapper } from "../tests/system/claude-sandbox.js";

const REPO_ROOT = join(import.meta.dirname, "..");
const CONTRACTS_DIR = join(REPO_ROOT, "contracts");
const CLI_BIN = join(REPO_ROOT, "packages/cli/bin/arena.mjs");
const SERVER_BIN = join(REPO_ROOT, "apps/server/bin/arena-server.mjs");
const DEFAULT_DEV_DIR = join(REPO_ROOT, ".arena-dev");

// Anvil's well-known default account 0, derived from its built-in test mnemonic ("test test test test test test
// test test test test test junk"). Anvil pre-funds it with ETH at startup. Local-dev only: never use this key
// anywhere real funds could reach it.
const OWNER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;

const PLAYER_NAMES = ["alice", "bob", "carol", "dave", "erin", "frank", "grace", "heidi"];

// Plan 5 Task 1 (mainnet gates: `dev-up --dir` guard): dev-up wipes `--dir` at the start of every run (see
// `main()`) -- fine for its own gitignored state, but a caller who points `--dir` at something else by mistake
// (or forgets a previous, unrelated use of that path) would otherwise have it silently deleted. This marker,
// written on a run's first successful use of a directory, is the only thing that makes wiping it safe next time.
const DEV_DIR_MARKER = ".arena-dev-marker";

function parseArgs(argv: string[]): { port: number; anvilPort: number; players: number; houseBots: number; dir: string } {
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
    // Plan 5.5 Task 2: agents self-onboard (skill.md) and fund themselves from the dev faucet, so unfunded human
    // homes are no longer the default -- pass --players explicitly to still get some.
    players: Number(flags.get("players") ?? "0"),
    // Plan 5.5 Task 2: always-available opponents, started and funded by dev-up itself.
    houseBots: Number(flags.get("house-bots") ?? "2"),
    // Final review m12: a caller (the dev-up test) passes its own temporary directory, so running the test suite
    // never wipes the repo's .arena-dev.
    dir: resolve(flags.get("dir") ?? DEFAULT_DEV_DIR),
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

/** Plan 5.5 Task 2: polls the host server's lobby until `player` (lower-cased address) has at least one open
 *  offer -- i.e. until that house bot's standing offer is visible to anyone else looking at the lobby. Reads the
 *  wire-format body as plain JSON (not `fromWire`): `Offer.player`/`Offer.signer` are plain address strings,
 *  untouched by `toWire`'s bigint wrapping, so no SDK import is needed here. */
async function waitForOffer(serverUrl: string, player: `0x${string}`, timeoutMs = 30_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${serverUrl}/offers`, { signal: AbortSignal.timeout(2_000) });
      if (res.ok) {
        const list = (await res.json()) as Array<{ offer?: { player?: string } }>;
        if (list.some((o) => o.offer?.player?.toLowerCase() === player.toLowerCase())) return;
      }
    } catch {
      // not there yet
    }
    await sleep(150);
  }
  throw new Error(`house bot ${player} did not post a standing offer within ${timeoutMs}ms`);
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
const bots: Array<{ label: string; child: ChildProcess }> = [];
let shuttingDown = false;

async function teardown(): Promise<void> {
  // House bots depend on the server and anvil, so they come down first.
  await Promise.all(bots.map((b) => stopChild(b.label, b.child)));
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
  const { port: serverPort, anvilPort, players: numPlayers, houseBots: numHouseBots, dir: DEV_DIR } = parseArgs(process.argv.slice(2));

  // Fix round (minor): --dir existing as a plain file (not a directory) is a clear, distinct refusal --
  // readdirSync below would otherwise throw a raw ENOTDIR with a Node stack trace.
  if (existsSync(DEV_DIR) && !statSync(DEV_DIR).isDirectory()) {
    process.stderr.write(`dev-up: refusing to start -- --dir ${DEV_DIR} is not a directory. Nothing was started or touched.\n`);
    process.exit(1);
  }
  // Plan 5 Task 1: refuse a non-empty --dir that carries no marker from a previous dev-up run -- before the port
  // checks (this refusal needs no ports) and before the wipe below, so nothing of a caller's own directory is ever
  // touched. A directory dev-up itself created keeps the marker across runs (it is never wiped).
  if (existsSync(DEV_DIR) && readdirSync(DEV_DIR).length > 0 && !existsSync(join(DEV_DIR, DEV_DIR_MARKER))) {
    process.stderr.write(
      `dev-up: refusing to start -- --dir ${DEV_DIR} is non-empty and was not created by a previous dev-up run ` +
        `(no ${DEV_DIR_MARKER} file). Pass an empty or new --dir, or delete it yourself if you are sure. Nothing was started or touched.\n`,
    );
    process.exit(1);
  }

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
  writeFileSync(join(DEV_DIR, DEV_DIR_MARKER), `${new Date().toISOString()}\n`);
  const playersDir = join(DEV_DIR, "players");
  mkdirSync(playersDir, { recursive: true });
  const wrapperPath = writeArenaWrapper(DEV_DIR, CLI_BIN);

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  process.stderr.write(`dev-up: starting anvil on :${anvilPort}\n`);
  // Final review I1: without --block-time, Anvil only mines on an incoming transaction, so chain time freezes
  // between them. Silence detection (opponent-silent), challenge/funding deadlines and offer expiry are all
  // driven by that same frozen clock -- on a stack where only the agent and house bots run, nothing mines, so
  // none of them ever fire even when they should. --block-time 1 makes chain time track wall-clock time, the
  // same as it does on Arc.
  anvil = spawn("anvil", ["--port", String(anvilPort), "--block-time", "1"], {
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
    // Fix round 1 (M3): `defaults.challengeTimeout` overrides were silently ignored before this round's
    // config.ts fix (a dotted-key lookup bug), so this "600" was always actually served as the daemon's real
    // 900 s floor (final review I4) by accident. Now that the override takes effect, matching it to 900
    // explicitly keeps /templates' published default consistent with what a daemon will actually accept --
    // house bots never read this field anyway (they let the daemon apply its own minChallengeTimeoutOf), so
    // nothing here depended on the old, silently-ignored "600".
    defaults: { deposit: "1000000", stakePerGame: "100000", challengeTimeout: "900" },
    // Plan 5.5 Task 3: the wrapper's absolute path, not the bare string "arena" -- skill.md then shows a command
    // a fresh agent can run from any directory with no PATH setup (see writeArenaWrapper).
    cliCommand: wrapperPath,
    audit: "unaudited (development build)",
    indexer: { pollMs: 1_000, chunkBlocks: 1000, startBlock: 0 },
    limits: {},
    trustProxy: false,
    // Plan 5.5 Task 1: dev-up always runs a local Anvil at chainId 31337, so the three-way faucet guard's other
    // two checks (chainId, Anvil's web3_clientVersion) are satisfied too -- /faucet comes up enabled.
    devFaucet: true,
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

  // Mints 100 USDC and sets a generous native balance for `address` -- the same funding every player and house
  // bot home gets.
  async function fundAccount(address: `0x${string}`): Promise<void> {
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
  }

  const commands: string[] = [];
  for (let i = 0; i < numPlayers; i++) {
    const name = PLAYER_NAMES[i] ?? `player${i + 1}`;
    const key = generatePrivateKey();
    const address = privateKeyToAccount(key).address;
    await fundAccount(address);

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

  // Plan 5.5 Task 2: house bots -- always-available opponents dev-up starts, funds and tears down itself. Each
  // one is `arena bot` (packages/cli/src/bot.ts): a long-lived process that runs its own daemon in-process, keeps
  // a standing offer open, and plays with a simple strategy. dev-up waits for each one's offer to actually appear
  // in the lobby before calling itself ready.
  const houseBotsDir = join(DEV_DIR, "house-bots");
  mkdirSync(houseBotsDir, { recursive: true });
  const logsDir = join(DEV_DIR, "logs");
  mkdirSync(logsDir, { recursive: true });
  for (let i = 1; i <= numHouseBots; i++) {
    // M4: a Ctrl-C that lands mid-startup runs shutdown()/teardown() against whatever `bots` holds *right now*;
    // main() itself just keeps looping through this for-loop regardless, since nothing here was awaiting the
    // signal. Without this check, the next bot spawned after that snapshot was taken would never receive the
    // terminal's SIGINT and would survive against an already-dead stack.
    if (shuttingDown) break;
    const name = `house-${i}`;
    const key = generatePrivateKey();
    const address = privateKeyToAccount(key).address;
    await fundAccount(address);

    const home = join(houseBotsDir, name);
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

    process.stderr.write(`dev-up: starting house bot ${name} (logging to ${join(logsDir, `${name}.log`)})\n`);
    const logFd = openSync(join(logsDir, `${name}.log`), "a");
    // Final review I2(d): an LLM opponent is much slower than the scripted test agent, so the default 120s
    // idle-close would end a game -- and start the "both of you must agree to close" standoff I2 fixes -- while
    // a real agent is still mid-turn. 600s gives it real headroom.
    const bot = spawn("node", [CLI_BIN, "bot", "--idle-close-seconds", "600"], {
      cwd: REPO_ROOT,
      env: { ...process.env, ARENA_HOME: home },
      stdio: ["ignore", logFd, logFd],
    });
    // M4: a house bot's own exit (e.g. a sticky lobbyError -- M8, parked) was otherwise silent; at least log it
    // so dev-up's own output tells a human watching that the lobby has one fewer opponent in it. Never logged
    // during an ordinary teardown, which this process itself initiates.
    bot.on("exit", (code, signal) => {
      if (!shuttingDown) process.stderr.write(`dev-up: house bot ${name} exited unexpectedly (code=${code} signal=${signal})\n`);
    });
    bots.push({ label: name, child: bot });
    await waitForOffer(serverUrl, address);
  }

  process.stderr.write("\ndev-up: ready.\n\n");
  process.stderr.write(`  owner/deployer private key (LOCAL DEV ONLY, never use for real funds): ${OWNER_KEY}\n`);
  process.stderr.write(`  anvil:  ${rpcUrl}\n`);
  process.stderr.write(`  server: ${serverUrl}\n\n`);
  process.stderr.write(`  arena CLI wrapper: ${wrapperPath}\n`);
  process.stderr.write(`  optional: export PATH=${join(DEV_DIR, "bin")}:$PATH\n\n`);
  if (numHouseBots > 0) {
    process.stderr.write(`  ${numHouseBots} house bot(s) are up and have standing offers open (logs under ${logsDir}).\n\n`);
    process.stderr.write(
      `  Go to http://127.0.0.1:${serverPort} and use your money to play 10 $1 games with whoever is available.\n`,
    );
    process.stderr.write("  (a fresh Claude Code session, pointed at that one sentence, can run this end to end.)\n\n");
  }
  if (commands.length > 0) {
    process.stderr.write("  start each player's daemon in its own terminal:\n\n");
    for (const cmd of commands) process.stderr.write(`    ${cmd}\n`);
    process.stderr.write("\n");
  }
  process.stderr.write("  Ctrl-C here tears down anvil, the server and every house bot.\n\n");

  // One machine-readable line, last, so tooling (and this task's own dev-up test) can wait for it deterministically.
  console.log(
    JSON.stringify({ ready: true, anvilPort, serverPort, rpcUrl, serverUrl, players: numPlayers, houseBots: numHouseBots, dir: DEV_DIR }),
  );

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
