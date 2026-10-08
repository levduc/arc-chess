import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { freeTcpPort, isPortFree } from "./harness.js";

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

let child: ChildProcess | undefined;
let deploymentSnapshot: string | null | undefined;
let devDir: string | undefined;

afterEach(async () => {
  if (child && child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  child = undefined;
  if (devDir) rmSync(devDir, { recursive: true, force: true });
  devDir = undefined;
  if (deploymentSnapshot !== undefined) {
    if (deploymentSnapshot === null) rmSync(DEPLOYMENT_31337, { force: true });
    else writeFileSync(DEPLOYMENT_31337, deploymentSnapshot);
    deploymentSnapshot = undefined;
  }
}, 20_000);

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
      await Promise.race([
        exited,
        sleep(20_000).then(() => {
          throw new Error("dev-up did not exit within 20s of SIGINT");
        }),
      ]);

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
      await Promise.race([
        exited,
        sleep(20_000).then(() => {
          throw new Error("dev-up did not exit within 20s of SIGINT");
        }),
      ]);

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
});
