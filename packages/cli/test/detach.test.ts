import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generatePrivateKey } from "viem/accounts";
import { afterEach, describe, expect, it } from "vitest";
import { initHome, livePidHoldingLock, runCli, type ArenaConfig, type CliIo } from "../src/index.js";
import { startDetachedDaemon } from "../src/detach.js";
import { RPC, deployArena } from "../../sdk/test/helpers/chain.js";

// Plan 6 hardening H4 (live run friction 4): `arena daemon --detach`, through the real `bin/arena.mjs` -- inside vitest
// `process.argv[1]` is the test runner, so only a spawned CLI re-runs itself. The home points its host at a closed
// loopback port, as in withdraw.test.ts: a daemon's host connection only retries in the background.
const CLI_BIN = join(import.meta.dirname, "../bin/arena.mjs");
const NOWHERE = "http://127.0.0.1:9";

/** Daemons this file started, each stopped by number after its test -- only while its home's lock still names it,
 *  so a pid since reused by another process is never signalled. */
let daemons: Array<{ pid: number; home: string }> = [];
/** Direct children (the CLI, the shell), killed after each test if still running. */
let children: ChildProcess[] = [];
afterEach(async () => {
  for (const d of daemons) if (livePidHoldingLock(d.home) === d.pid) process.kill(d.pid, "SIGTERM");
  for (const d of daemons) await until(() => livePidHoldingLock(d.home) !== d.pid, 20_000).catch(() => undefined);
  for (const c of children) {
    if (c.exitCode !== null || c.signalCode !== null) continue;
    // A shell started in its own group takes its `sleep` with it; anything else is killed alone.
    try {
      if (c.spawnargs[0] === "sh") process.kill(-c.pid!, "SIGKILL");
      else c.kill("SIGKILL");
    } catch {
      // already gone
    }
  }
  daemons = [];
  children = [];
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function until(cond: () => boolean | Promise<boolean>, ms: number): Promise<void> {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

/** A home against a freshly deployed hub; nothing funded -- a daemon starts without any money. */
async function detachHome(): Promise<{ home: string; port: number }> {
  const env = await deployArena();
  const home = mkdtempSync(join(tmpdir(), "arena-detach-"));
  const port = await freePort();
  const config: ArenaConfig = {
    rpcUrl: RPC,
    chainId: env.domain.chainId,
    hub: env.hub,
    usdc: env.usdc,
    rules: env.rules,
    serverUrl: NOWHERE,
    port,
    maxFeePerPlayer: 10_000n,
    sessionGasWei: 10n ** 16n,
    pollMs: 100,
    minChallengeTimeout: 60n,
  };
  initHome(home, config, generatePrivateKey());
  return { home, port };
}

/** A placeholder home: config, wallet and token, but no chain behind it -- for the paths that never start a daemon. */
function bareHome(): string {
  const home = mkdtempSync(join(tmpdir(), "arena-detach-bare-"));
  initHome(
    home,
    {
      rpcUrl: NOWHERE,
      chainId: 31337,
      hub: "0x000000000000000000000000000000000000beef",
      usdc: "0x000000000000000000000000000000000000cafe",
      rules: "0x00000000000000000000000000000000000000e5",
      serverUrl: NOWHERE,
      port: 0,
      maxFeePerPlayer: 10_000n,
      sessionGasWei: 10n ** 16n,
      pollMs: 100,
    },
    generatePrivateKey(),
  );
  return home;
}

function cliIo(home: string) {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = { env: { ARENA_HOME: home }, fetch, out: (s: string) => out.push(s), err: (s: string) => err.push(s) };
  return { out, err, io };
}

/** Runs the real CLI to completion. */
function runBin(home: string, args: string[]): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI_BIN, ...args], { env: { ...process.env, ARENA_HOME: home }, stdio: ["ignore", "pipe", "pipe"] });
    children.push(child);
    let out = "";
    let err = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (err += d.toString()));
    child.once("close", (code) => resolve({ code, out, err }));
  });
}

describe("H4: arena daemon --detach", () => {
  it("survives a kill of the process group that started it, answers, and refuses a second --detach", async () => {
    const { home, port } = await detachHome();
    // The command skill.md names: a wrapper that `exec`s node, as testnet:up's and dev:up's `bin/arena` do.
    const sq = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
    const wrapper = join(mkdtempSync(join(tmpdir(), "arena-detach-bin-")), "arena");
    writeFileSync(wrapper, `#!/bin/sh\nexec ${sq(process.execPath)} ${sq(CLI_BIN)} "$@"\n`);
    chmodSync(wrapper, 0o755);
    // The agent's tool session: a shell in its own process group that runs `daemon --detach`, then lingers.
    const shell = spawn("sh", ["-c", `${sq(wrapper)} daemon --detach; echo "cli-exit $?"; sleep 120`], {
      detached: true,
      env: { ...process.env, ARENA_HOME: home },
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(shell);
    let closed = false;
    shell.once("close", () => (closed = true));
    let out = "";
    let err = "";
    shell.stdout!.on("data", (d: Buffer) => (out += d.toString()));
    shell.stderr!.on("data", (d: Buffer) => (err += d.toString()));
    await until(() => /cli-exit \d+/.test(out), 90_000).catch(() => {
      throw new Error(`--detach never returned: ${out} ${err}`);
    });
    expect(out, err).toMatch(/cli-exit 0/);
    const line = JSON.parse(out.split("\n")[0]!) as { detached: boolean; pid: number; api: string; log: string };
    daemons.push({ pid: line.pid, home });
    expect(Object.keys(line)).toEqual(["detached", "pid", "api", "log"]);
    expect(line).toMatchObject({ detached: true, api: `http://127.0.0.1:${port}`, log: join(home, "daemon.log") });
    expect(line.pid).not.toBe(shell.pid);
    // The detached process is the daemon itself (node running the CLI's entry), in a session of its own.
    const stat = readFileSync(`/proc/${line.pid}/stat`, "utf8").split(") ")[1]!.split(" ");
    expect(Number(stat[2]), "pgrp").toBe(line.pid);
    expect(Number(stat[3]), "session").toBe(line.pid);
    expect(readFileSync(`/proc/${line.pid}/cmdline`, "utf8").split("\0")).toEqual([process.execPath, CLI_BIN, "daemon", ""]);

    // Kill the whole process group, as a tool does when its session ends: the shell dies, the daemon does not.
    process.kill(-shell.pid!, "SIGKILL");
    // Its output pipes close with the group: the daemon holds none of them. (A daemon that inherited them would keep
    // them open, which is what kept `claude -p` alive after its last answer in the live run.)
    await until(() => closed, 10_000);
    await new Promise((r) => setTimeout(r, 1_000));
    expect(alive(line.pid)).toBe(true);
    expect(livePidHoldingLock(home)).toBe(line.pid);
    expect((await fetch(`${line.api}/health`)).status).toBe(200);
    const channels = cliIo(home);
    expect(await runCli(["channels"], channels.io), channels.err.join("\n")).toBe(0);
    expect(JSON.parse(channels.out.join("\n"))).toEqual([]);
    // Its own start line, and nothing of the shell's, is in the log.
    const log = readFileSync(line.log, "utf8");
    expect(log).toContain(`"pid":${line.pid}`);
    expect(log).not.toContain("cli-exit");

    // A second --detach on the same home is refused, before it spawns anything.
    const second = await runBin(home, ["daemon", "--detach"]);
    expect(second.code).toBe(1);
    expect(second.out).toBe("");
    expect(second.err).toMatch(new RegExp(`another arena daemon \\(pid ${line.pid}\\) is using .*: it is already running, so there is nothing to start`));
    expect(livePidHoldingLock(home)).toBe(line.pid);

    // It stops on SIGTERM like any daemon, and releases its lock.
    process.kill(line.pid, "SIGTERM");
    await until(() => !alive(line.pid) && livePidHoldingLock(home) === null, 20_000);
  });

  it("a daemon that does not come up in time is stopped, by its own pid, and the error carries its log", async () => {
    const home = bareHome();
    const self = { cmd: process.execPath, args: ["-e", 'console.log("still starting"); setInterval(() => {}, 1000)'] };
    const before = Date.now();
    const err = await startDetachedDaemon(home, { env: { ARENA_HOME: home }, fetch, waitMs: 1_000, command: "arena", self }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    const pid = Number(/so it was stopped \(pid (\d+)\)/.exec(message)?.[1]);
    expect(message).toMatch(/^the daemon did not come up within 1 s, so it was stopped \(pid \d+\): still starting \(its log: .*daemon\.log\)$/);
    expect(alive(pid)).toBe(false);
    expect(Date.now() - before).toBeLessThan(15_000);
  });

  it("a daemon that exits during startup fails with its exit code and log, and nothing is left running", async () => {
    const home = bareHome();
    const self = { cmd: process.execPath, args: ["-e", 'console.error("error: cannot reach the RPC"); process.exit(3)'] };
    const err = await startDetachedDaemon(home, { env: { ARENA_HOME: home }, fetch, waitMs: 30_000, command: "arena", self }).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/^the daemon exited with code 3 before it came up: error: cannot reach the RPC \(its log: /);
    expect(livePidHoldingLock(home)).toBeNull();
  });

  it("refuses up front -- no log, no child -- on a home init never wrote, and on a bad --timeout", async () => {
    const empty = mkdtempSync(join(tmpdir(), "arena-detach-empty-"));
    const t = cliIo(empty);
    expect(await runCli(["daemon", "--detach"], t.io)).toBe(1);
    expect(t.err.join("\n")).toMatch(/init/);
    expect(existsSync(join(empty, "daemon.log"))).toBe(false);

    const home = bareHome();
    for (const bad of ["0", "601", "1.5", "soon"]) {
      const b = cliIo(home);
      expect(await runCli(["daemon", "--detach", "--timeout", bad], b.io)).toBe(2);
      expect(b.err.join("\n")).toMatch(/--timeout must be a whole number of seconds from 1 to 600/);
    }
    expect(existsSync(join(home, "daemon.log"))).toBe(false);
  });
});
