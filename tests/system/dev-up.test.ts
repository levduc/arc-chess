import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { XMTP_NPM_CACHE, dockerUnavailableReason, freeTcpPort, isPortFree } from "./harness.js";

const REPO_ROOT = join(import.meta.dirname, "../..");
const TSX_BIN = join(REPO_ROOT, "node_modules/.bin/tsx");
const DEV_UP_SCRIPT = join(REPO_ROOT, "scripts/dev-up.ts");
// `forge script`'s Deploy.s.sol always writes here (vm.projectRoot() is fixed), regardless of --anvil-port: this
// is the file the running demo stack's own past deployment left behind. dev-up overwrites it every run (a known,
// documented trade-off of using `forge script` for dev-up -- see the harness, which deploys through viem instead
// to avoid exactly this), so the test snapshots and restores it to leave no trace on the machine.
const DEPLOYMENT_31337 = join(REPO_ROOT, "contracts/deployments/31337.json");
// The repo's own dev-up state (gitignored). dev-up wipes its state dir on every run, so the test must point it at a
// temporary one (`--dir`) and never touch this one (final review m12: a test run deleted it).
const REPO_DEV_DIR = join(REPO_ROOT, ".arena-dev");

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Races `promise` against a deadline, clearing the timer the instant `promise` settles -- unlike a bare
 *  `Promise.race([promise, sleep(ms).then(() => { throw ... })])` (M11), this never leaves the losing branch's
 *  timer running: left uncleared, it fires `ms` after the race was already won and throws into a `.then()`
 *  with nothing left listening, an unhandled rejection `ms` later. Harmless only while each test file runs in
 *  its own vitest fork. */
function withDeadline<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

let child: ChildProcess | undefined;
let deploymentSnapshot: string | null | undefined;
let devDir: string | undefined;
/** Plan 5.7 Task 5: the compose project of a `--xmtp-local` run, taken down here if the test did not get to (a
 *  SIGKILLed dev-up never runs its own teardown). Final fix wave (K4): named by the test before dev-up starts
 *  (`ARENA_DEV_XMTP_PROJECT`), so it is known even when dev-up hangs before its ready line. */
let xmtpProject: string | undefined;

/** K4: a fresh compose project name for one `--xmtp-local` run, set as `xmtpProject` before dev-up is spawned. */
function nameXmtpProject(): string {
  xmtpProject = `arena-dev-xmtp-test-${process.pid}-${Date.now()}`;
  return xmtpProject;
}

/** Plan 5.7 Task 5: the containers (any state) of one compose project, by its label: only ever this test's own. */
function composeContainers(project: string): string[] {
  const ps = spawnSync("docker", ["ps", "-a", "-q", "--filter", `label=com.docker.compose.project=${project}`], { encoding: "utf8" });
  if (ps.status !== 0) throw new Error(`docker ps failed: ${ps.stderr}`);
  return ps.stdout.split("\n").filter((l) => l.trim() !== "");
}

afterEach(async () => {
  if (child && child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  child = undefined;
  if (xmtpProject) {
    // `down -v` by project name alone: the compose file's port variables have defaults, and no port is needed to
    // remove this project's own containers and volumes. Never prune, never touch anything else.
    spawnSync(
      "docker",
      ["compose", "-p", xmtpProject, "-f", join(REPO_ROOT, "tests/system/xmtp-local/docker-compose.yml"), "down", "-v", "--timeout", "5"],
      { stdio: "ignore", timeout: 120_000 },
    );
    xmtpProject = undefined;
  }
  if (devDir) rmSync(devDir, { recursive: true, force: true });
  devDir = undefined;
  if (deploymentSnapshot !== undefined) {
    if (deploymentSnapshot === null) rmSync(DEPLOYMENT_31337, { force: true });
    else writeFileSync(DEPLOYMENT_31337, deploymentSnapshot);
    deploymentSnapshot = undefined;
  }
}, 150_000);

/** Reads lines from `child`'s stdout until `predicate` matches a parsed JSON line, or `ms` elapses. */
async function waitForJsonLine(target: ChildProcess, predicate: (o: Record<string, unknown>) => boolean, ms: number): Promise<Record<string, unknown>> {
  let buf = "";
  const found = new Promise<Record<string, unknown>>((resolvePromise, reject) => {
    const onData = (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        try {
          const parsed = JSON.parse(line) as Record<string, unknown>;
          if (predicate(parsed)) {
            target.stdout?.removeListener("data", onData);
            resolvePromise(parsed);
            return;
          }
        } catch {
          // not JSON (or not the line we want): ignore
        }
      }
    };
    target.stdout?.on("data", onData);
    target.once("exit", (code, signal) => reject(new Error(`process exited before the expected line (code=${code} signal=${signal})`)));
  });
  return Promise.race([
    found,
    sleep(ms).then(() => {
      throw new Error(`timed out after ${ms}ms waiting for a matching JSON line on stdout`);
    }),
  ]);
}

describe("pnpm dev:up", () => {
  it(
    "Plan 5 Task 1: refuses a non-empty --dir with no marker, without starting anything, and leaves it untouched",
    async () => {
      devDir = mkdtempSync(join(tmpdir(), "arena-dev-up-"));
      const junkPath = join(devDir, "junk.txt");
      writeFileSync(junkPath, "pre-existing, unrelated state");

      const anvilPort = await freeTcpPort();
      const serverPort = await freeTcpPort();

      child = spawn(
        TSX_BIN,
        [DEV_UP_SCRIPT, "--anvil-port", String(anvilPort), "--port", String(serverPort), "--players", "1", "--dir", devDir],
        { cwd: REPO_ROOT, detached: true, stdio: ["ignore", "pipe", "pipe"] },
      );
      let stderr = "";
      child.stderr?.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
      const code = await new Promise<number | null>((resolvePromise) => child!.once("exit", (c) => resolvePromise(c)));
      expect(code).not.toBe(0);
      expect(stderr).toMatch(/refus.*non-empty/i);
      expect(readFileSync(junkPath, "utf8")).toBe("pre-existing, unrelated state"); // untouched
      expect(existsSync(join(devDir, ".arena-dev-marker"))).toBe(false); // never created on a refusal
      // Nothing was started: both ports are still free.
      expect(await isPortFree(anvilPort)).toBe(true);
      expect(await isPortFree(serverPort)).toBe(true);
      child = undefined;
    },
    20_000,
  );

  it(
    "fix round (minor): --dir pointing at a plain file fails with a clear error, not a raw ENOTDIR crash",
    async () => {
      const parent = mkdtempSync(join(tmpdir(), "arena-dev-up-"));
      devDir = parent;
      const filePath = join(parent, "not-a-directory");
      writeFileSync(filePath, "I am a file, not a directory");

      const anvilPort = await freeTcpPort();
      const serverPort = await freeTcpPort();

      child = spawn(
        TSX_BIN,
        [DEV_UP_SCRIPT, "--anvil-port", String(anvilPort), "--port", String(serverPort), "--players", "1", "--dir", filePath],
        { cwd: REPO_ROOT, detached: true, stdio: ["ignore", "pipe", "pipe"] },
      );
      let stderr = "";
      child.stderr?.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
      const code = await new Promise<number | null>((resolvePromise) => child!.once("exit", (c) => resolvePromise(c)));
      expect(code).not.toBe(0);
      expect(stderr).toMatch(/--dir .* is not a directory/i);
      expect(stderr).not.toMatch(/ENOTDIR/); // a clear message, not a raw fs error/stack trace
      expect(readFileSync(filePath, "utf8")).toBe("I am a file, not a directory"); // untouched
      await isPortFree(anvilPort).then((free) => expect(free).toBe(true));
      await isPortFree(serverPort).then((free) => expect(free).toBe(true));
      child = undefined;
    },
    20_000,
  );

  it(
    "starts anvil + server on free ports, prints a ready line, and Ctrl-C frees both ports",
    async () => {
      deploymentSnapshot = existsSync(DEPLOYMENT_31337) ? readFileSync(DEPLOYMENT_31337, "utf8") : null;
      devDir = mkdtempSync(join(tmpdir(), "arena-dev-up-"));
      const repoDevDirBefore = existsSync(REPO_DEV_DIR) ? statSync(REPO_DEV_DIR).ctimeMs : null;

      const anvilPort = await freeTcpPort();
      const serverPort = await freeTcpPort();
      expect(await isPortFree(anvilPort)).toBe(true);
      expect(await isPortFree(serverPort)).toBe(true);

      child = spawn(
        TSX_BIN,
        [DEV_UP_SCRIPT, "--anvil-port", String(anvilPort), "--port", String(serverPort), "--players", "2", "--dir", devDir],
        { cwd: REPO_ROOT, detached: true, stdio: ["ignore", "pipe", "inherit"] },
      );

      const ready = await waitForJsonLine(child, (o) => o.ready === true, 60_000);
      expect(ready.anvilPort).toBe(anvilPort);
      expect(ready.serverPort).toBe(serverPort);
      // m12: every file went to the --dir given, and the repo's own .arena-dev was left exactly as it was.
      expect(ready.dir).toBe(devDir);
      expect(existsSync(join(devDir, "server.json"))).toBe(true);
      expect(existsSync(join(devDir, "players", "alice", "config.json"))).toBe(true);
      expect(existsSync(REPO_DEV_DIR) ? statSync(REPO_DEV_DIR).ctimeMs : null).toBe(repoDevDirBefore);

      // Plan 5.5 Task 3: dev-up writes the "<dir>/bin/arena" CLI wrapper itself (not just this test's own copy of
      // one, as agent-recipe.test.ts uses) -- executable, and set as the server's cliCommand so skill.md actually
      // shows this exact path in its recipe. This is the file the user's one-sentence prompt depends on.
      const wrapperPath = join(devDir, "bin", "arena");
      expect(existsSync(wrapperPath)).toBe(true);
      expect(statSync(wrapperPath).mode & 0o111).not.toBe(0); // executable by someone

      // Both services are actually reachable, not just "the script said so".
      const rpcRes = await fetch(`http://127.0.0.1:${anvilPort}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      });
      expect(rpcRes.ok).toBe(true);
      const healthRes = await fetch(`http://127.0.0.1:${serverPort}/healthz`);
      expect(healthRes.ok).toBe(true);
      const skillText = await (await fetch(`http://127.0.0.1:${serverPort}/skill.md`)).text();
      expect(skillText).toContain(`${wrapperPath} init --server`);

      expect(await isPortFree(anvilPort)).toBe(false);
      expect(await isPortFree(serverPort)).toBe(false);

      const pid = child.pid;
      expect(pid).toBeDefined();
      const exited = new Promise<void>((resolvePromise) => child!.once("exit", () => resolvePromise()));
      process.kill(-pid!, "SIGINT"); // simulates a terminal Ctrl-C: signals dev-up's whole process group
      await withDeadline(exited, 20_000, "dev-up did not exit within 20s of SIGINT");

      // Ports free up promptly after teardown; poll briefly for the OS to release them.
      const end = Date.now() + 10_000;
      let anvilFree = false;
      let serverFree = false;
      while (Date.now() < end && !(anvilFree && serverFree)) {
        anvilFree = await isPortFree(anvilPort);
        serverFree = await isPortFree(serverPort);
        if (!(anvilFree && serverFree)) await sleep(200);
      }
      expect(anvilFree).toBe(true);
      expect(serverFree).toBe(true);
    },
    120_000,
  );

  it(
    "Plan 5.5 Task 2: --house-bots 1 posts a standing offer, and teardown leaves no process behind",
    async () => {
      deploymentSnapshot = existsSync(DEPLOYMENT_31337) ? readFileSync(DEPLOYMENT_31337, "utf8") : null;
      devDir = mkdtempSync(join(tmpdir(), "arena-dev-up-"));

      const anvilPort = await freeTcpPort();
      const serverPort = await freeTcpPort();

      child = spawn(
        TSX_BIN,
        [
          DEV_UP_SCRIPT,
          "--anvil-port",
          String(anvilPort),
          "--port",
          String(serverPort),
          "--players",
          "0",
          "--house-bots",
          "1",
          "--dir",
          devDir,
        ],
        { cwd: REPO_ROOT, detached: true, stdio: ["ignore", "pipe", "inherit"] },
      );

      // dev-up itself only prints the ready line once the bot's offer is already visible in the lobby (it waits
      // for that before calling itself ready) -- so this doubles as the "offer appears" assertion.
      const ready = await waitForJsonLine(child, (o) => o.ready === true, 60_000);
      expect(ready.houseBots).toBe(1);
      const homeDir = join(devDir, "house-bots", "house-1");
      expect(existsSync(join(homeDir, "config.json"))).toBe(true);
      expect(existsSync(join(devDir, "logs", "house-1.log"))).toBe(true);

      const serverUrl = `http://127.0.0.1:${serverPort}`;
      const offersRes = await fetch(`${serverUrl}/offers`);
      expect(offersRes.ok).toBe(true);
      const offers = (await offersRes.json()) as Array<{ offer?: { player?: string } }>;
      expect(offers.length).toBeGreaterThan(0);

      // The bot's own daemon process, found the same way llm-games.ts's killDaemon does (ARENA_HOME/daemon.lock).
      const lock = JSON.parse(readFileSync(join(homeDir, "daemon.lock"), "utf8")) as { pid: number };
      const botAlive = () => {
        try {
          process.kill(lock.pid, 0);
          return true;
        } catch {
          return false;
        }
      };
      expect(botAlive()).toBe(true);

      const pid = child.pid;
      expect(pid).toBeDefined();
      const exited = new Promise<void>((resolvePromise) => child!.once("exit", () => resolvePromise()));
      process.kill(-pid!, "SIGINT"); // simulates a terminal Ctrl-C: signals dev-up's whole process group
      await withDeadline(exited, 20_000, "dev-up did not exit within 20s of SIGINT");

      // The house bot's own process (not just dev-up itself) is gone, and both ports free up -- teardown stops
      // everything it started, not just anvil/server. Poll briefly for the OS to catch up.
      const end = Date.now() + 10_000;
      let anvilFree = false;
      let serverFree = false;
      while (Date.now() < end && !(anvilFree && serverFree && !botAlive())) {
        anvilFree = await isPortFree(anvilPort);
        serverFree = await isPortFree(serverPort);
        if (!(anvilFree && serverFree) || botAlive()) await sleep(200);
      }
      expect(botAlive()).toBe(false);
      expect(anvilFree).toBe(true);
      expect(serverFree).toBe(true);
    },
    120_000,
  );

  it(
    "--no-faucet: no /faucet, a funded demo human wallet, and <dir>/bin/pay sends from it",
    async () => {
      deploymentSnapshot = existsSync(DEPLOYMENT_31337) ? readFileSync(DEPLOYMENT_31337, "utf8") : null;
      devDir = mkdtempSync(join(tmpdir(), "arena-dev-up-"));
      const anvilPort = await freeTcpPort();
      const serverPort = await freeTcpPort();
      child = spawn(
        TSX_BIN,
        [DEV_UP_SCRIPT, "--anvil-port", String(anvilPort), "--port", String(serverPort), "--no-faucet",
          "--players", "0", "--house-bots", "0", "--dir", devDir],
        { cwd: REPO_ROOT, detached: true, stdio: ["ignore", "pipe", "inherit"] },
      );
      const ready = await waitForJsonLine(child, (o) => o.ready === true, 60_000);
      expect(ready.faucet).toBe(false);
      expect(ready.demoHuman).toBe("0x70997970C51812dc3A010C7d01b50e0d17dc79C8");
      const pay = ready.pay as string;
      expect(pay).toBe(join(devDir, "bin", "pay"));

      const serverUrl = `http://127.0.0.1:${serverPort}`;
      const templates = (await (await fetch(`${serverUrl}/templates`)).json()) as Array<Record<string, unknown>>;
      expect(templates[0]).not.toHaveProperty("faucet");
      const faucet = await fetch(`${serverUrl}/faucet`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address: "0x00000000000000000000000000000000000000Aa" }),
      });
      expect(faucet.status).toBe(404);

      const run = (args: string[]) => spawnSync(pay, args, { encoding: "utf8", timeout: 60_000 });
      expect(run(["balance"]).stdout).toContain("100.000000 USDC");
      const sent = run(["0x00000000000000000000000000000000000000Aa", "1.5", "0.01"]);
      expect(sent.status).toBe(0);
      expect(sent.stdout).toContain("sent 1.5 USDC and 0.01 native gas");
      expect(run(["balance"]).stdout).toContain("98.500000 USDC");

      const exited = new Promise<void>((resolvePromise) => child!.once("exit", () => resolvePromise()));
      process.kill(-child.pid!, "SIGINT");
      await withDeadline(exited, 20_000, "dev-up did not exit within 20s of SIGINT");
    },
    120_000,
  );
  // Plan 5.7 Task 5: `--xmtp-local` starts XMTP's local node (Docker), publishes it in /templates, and teardown
  // removes its containers. Skipped, with the reason in the title, when Docker is unavailable.
  const dockerSkip = dockerUnavailableReason();
  it.skipIf(dockerSkip !== null)(
    `Plan 5.7: --xmtp-local publishes xmtp {env: "local", apiUrl} in /templates, and teardown removes its containers${dockerSkip ? ` (SKIPPED: ${dockerSkip})` : ""}`,
    async () => {
      deploymentSnapshot = existsSync(DEPLOYMENT_31337) ? readFileSync(DEPLOYMENT_31337, "utf8") : null;
      devDir = mkdtempSync(join(tmpdir(), "arena-dev-up-"));
      const anvilPort = await freeTcpPort();
      const serverPort = await freeTcpPort();
      const project = nameXmtpProject(); // known before dev-up starts: torn down in afterEach whatever happens
      child = spawn(
        TSX_BIN,
        [DEV_UP_SCRIPT, "--anvil-port", String(anvilPort), "--port", String(serverPort), "--xmtp-local",
          "--players", "0", "--house-bots", "0", "--dir", devDir],
        { cwd: REPO_ROOT, detached: true, stdio: ["ignore", "pipe", "inherit"], env: { ...process.env, ARENA_DEV_XMTP_PROJECT: project } },
      );
      // A cold machine pulls the fixture's five pinned images first.
      const ready = await waitForJsonLine(child, (o) => o.ready === true, 600_000);
      const xmtp = ready.xmtp as { env: string; apiUrl: string; project: string };
      expect(xmtp.project).toBe(project);
      expect(xmtp.env).toBe("local");
      expect(xmtp.apiUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(composeContainers(xmtp.project).length).toBeGreaterThan(0);

      const serverUrl = `http://127.0.0.1:${serverPort}`;
      const templates = (await (await fetch(`${serverUrl}/templates`)).json()) as Array<Record<string, unknown>>;
      expect(templates[0].xmtp).toEqual({ env: "local", apiUrl: xmtp.apiUrl });
      // skill.md's recipe gains its XMTP step only when the host publishes `xmtp` (Plan 5.7 Task 2).
      const skillText = await (await fetch(`${serverUrl}/skill.md`)).text();
      expect(skillText).toContain("xmtp enable");

      const exited = new Promise<void>((resolvePromise) => child!.once("exit", () => resolvePromise()));
      process.kill(-child.pid!, "SIGINT");
      // `down -v` of five containers comes after the bots, server and Anvil are down.
      await withDeadline(exited, 90_000, "dev-up did not exit within 90s of SIGINT");
      expect(composeContainers(xmtp.project)).toEqual([]);
      xmtpProject = undefined;
      await isPortFree(anvilPort).then((free) => expect(free).toBe(true));
      await isPortFree(serverPort).then((free) => expect(free).toBe(true));
    },
    720_000,
  );

  // Plan 5.7 Task 5 (ruling 2): house bots under `--xmtp-local` run with the fallback on -- one real `arena xmtp
  // enable` in house-1's home, a symlink to it in house-2's. Opt-in (ARENA_XMTP_REAL_INSTALL=1, Task 4's gate for a
  // real SDK install): ruling 1 allows one real install per run, and xmtp-fallback.test.ts makes it.
  it.skipIf(dockerSkip !== null || process.env.ARENA_XMTP_REAL_INSTALL !== "1")(
    "Plan 5.7: --xmtp-local --house-bots 2 enables XMTP for every house bot through one shared install (opt-in: ARENA_XMTP_REAL_INSTALL=1)",
    async () => {
      deploymentSnapshot = existsSync(DEPLOYMENT_31337) ? readFileSync(DEPLOYMENT_31337, "utf8") : null;
      devDir = mkdtempSync(join(tmpdir(), "arena-dev-up-"));
      const anvilPort = await freeTcpPort();
      const serverPort = await freeTcpPort();
      const project = nameXmtpProject();
      child = spawn(
        TSX_BIN,
        [DEV_UP_SCRIPT, "--anvil-port", String(anvilPort), "--port", String(serverPort), "--xmtp-local",
          "--players", "0", "--house-bots", "2", "--dir", devDir],
        // npm's cache shared with the rest of the suite (harness.ts), so a warm machine installs offline.
        {
          cwd: REPO_ROOT,
          detached: true,
          stdio: ["ignore", "pipe", "inherit"],
          env: { ...process.env, npm_config_cache: XMTP_NPM_CACHE, ARENA_DEV_XMTP_PROJECT: project },
        },
      );
      const ready = await waitForJsonLine(child, (o) => o.ready === true, 900_000);
      expect((ready.xmtp as { project: string }).project).toBe(project);
      const house = (i: number) => join(devDir!, "house-bots", `house-${i}`);
      expect(lstatSync(join(house(1), "xmtp", "sdk")).isDirectory()).toBe(true);
      expect(lstatSync(join(house(2), "xmtp", "sdk")).isSymbolicLink()).toBe(true);
      for (const i of [1, 2]) {
        const startLine = readFileSync(join(devDir, "logs", `house-${i}.log`), "utf8")
          .split("\n")
          .find((l) => l.startsWith("{") && l.includes('"bot":true'));
        expect(startLine, `house-${i}'s start line`).toBeDefined();
        expect(JSON.parse(startLine!).fallback, `house-${i}'s start line`).toBe("xmtp");
      }

      const exited = new Promise<void>((resolvePromise) => child!.once("exit", () => resolvePromise()));
      process.kill(-child.pid!, "SIGINT");
      await withDeadline(exited, 90_000, "dev-up did not exit within 90s of SIGINT");
      expect(composeContainers(project)).toEqual([]);
      xmtpProject = undefined;
    },
    1_020_000,
  );
});
