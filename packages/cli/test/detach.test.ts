import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generatePrivateKey } from "viem/accounts";
import { afterEach, describe, expect, it } from "vitest";
import { initHome, livePidHoldingLock, runCli, type ArenaConfig, type CliIo } from "../src/index.js";
import { parseEtime, processFacts, startDetachedDaemon } from "../src/detach.js";
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
function bareHome(port = 0): string {
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
      port,
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

    // H4 add-on: `daemon stop` stops it (no channel is live), waits until it has exited, and its lock is released.
    const stop = await runBin(home, ["daemon", "stop"]);
    expect(stop.code, stop.err).toBe(0);
    expect(JSON.parse(stop.out.trim())).toEqual({ stopped: true, pid: line.pid });
    expect(alive(line.pid)).toBe(false);
    expect(livePidHoldingLock(home)).toBeNull();
    const again = await runBin(home, ["daemon", "stop"]);
    expect(again.code).toBe(1);
    expect(again.err).toMatch(/no arena daemon is running on .*: nothing to stop/);
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

describe("H4 add-on: arena daemon stop", () => {
  /** A stand-in for a lock holder: node, with `role` as its last argument ("daemon", "bot"); with `channels`, it also
   *  answers `GET /channels` on `port` with that body, as a daemon's API would. */
  async function standIn(role: string, opts: { port?: number; channels?: unknown } = {}): Promise<ChildProcess> {
    const script =
      opts.channels === undefined
        ? "setInterval(() => {}, 1000)"
        : 'require("node:http").createServer((q, r) => r.end(q.url === "/channels" ? process.env.FAKE_CHANNELS : "{}"))' +
          '.listen(Number(process.env.FAKE_PORT), "127.0.0.1")';
    const child = spawn(process.execPath, ["-e", script, role], {
      env: { ...process.env, FAKE_PORT: String(opts.port ?? 0), FAKE_CHANNELS: JSON.stringify(opts.channels ?? []) },
      stdio: "ignore",
    });
    children.push(child);
    await until(() => processFacts(child.pid!)?.argv.at(-1) === role, 10_000);
    if (opts.channels !== undefined) {
      await until(async () => (await fetch(`http://127.0.0.1:${opts.port}/channels`).catch(() => null))?.ok === true, 10_000);
    }
    return child;
  }
  const holdLock = (home: string, pid: number) => writeFileSync(join(home, "daemon.lock"), JSON.stringify({ pid }));
  const running = (c: ChildProcess) => c.exitCode === null && c.signalCode === null;

  it("parses ps's etime", () => {
    expect(parseEtime("05:07")).toBe(307);
    expect(parseEtime("02:05:07")).toBe(7507);
    expect(parseEtime("3-02:05:07")).toBe(3 * 86_400 + 7507);
    expect(parseEtime(" 00:01 ")).toBe(1);
    expect(parseEtime("soon")).toBeNull();
  });

  it("refuses a lock whose pid now names a process started after the lock was written: a reused pid is never signalled", async () => {
    const home = bareHome();
    const reused = await standIn("daemon");
    holdLock(home, reused.pid!);
    const past = new Date(Date.now() - 3_600_000);
    utimesSync(join(home, "daemon.lock"), past, past); // the lock was written an hour before this process started
    const t = cliIo(home);
    expect(await runCli(["daemon", "stop"], t.io)).toBe(1);
    expect(t.err.join("\n")).toMatch(new RegExp(`pid ${reused.pid} started after .*daemon\\.lock was written, so it is not the daemon that wrote it \\(its pid was reused\\): not signalling it`));
    expect(t.out).toEqual([]);
    await new Promise((r) => setTimeout(r, 300));
    expect(running(reused)).toBe(true);
  });

  it("refuses a lock holder that is not arena daemon itself (arena bot, a withdraw in progress)", async () => {
    const home = bareHome();
    const bot = await standIn("bot");
    holdLock(home, bot.pid!);
    const t = cliIo(home);
    expect(await runCli(["daemon", "stop"], t.io)).toBe(1);
    expect(t.err.join("\n")).toMatch(new RegExp(`pid ${bot.pid} holds .* but is not "arena daemon" .*Not stopping it`));
    await new Promise((r) => setTimeout(r, 300));
    expect(running(bot)).toBe(true);
  });

  it("refuses while a channel is Open or Challenged, naming it; --yes-i-understand stops it anyway, with a note", async () => {
    const port = await freePort();
    const home = bareHome(port);
    const channels = [
      { channelId: "0xaa", phase: "Open" },
      { channelId: "0xbb", phase: "Finalized" },
      { channelId: "0xcc", phase: "Challenged" },
      { channelId: "0xdd", degraded: true },
    ];
    const daemon = await standIn("daemon", { port, channels });
    holdLock(home, daemon.pid!);
    const t = cliIo(home);
    expect(await runCli(["daemon", "stop"], t.io)).toBe(1);
    expect(t.err.join("\n")).toMatch(
      /channels are live \(0xaa, 0xcc, from the daemon's channels\): settle first \(arena close --channel <id>, then wait for Finalized\) or run the daemon elsewhere/,
    );
    expect(t.err.join("\n")).toMatch(/To stop it anyway: arena daemon stop --yes-i-understand/);
    await new Promise((r) => setTimeout(r, 300));
    expect(running(daemon)).toBe(true);

    const forced = cliIo(home);
    expect(await runCli(["daemon", "stop", "--yes-i-understand"], forced.io), forced.err.join("\n")).toBe(0);
    expect(JSON.parse(forced.out.join("\n"))).toEqual({ stopped: true, pid: daemon.pid });
    expect(forced.err.join("\n")).toMatch(/note: stopping with 2 live channel\(s\) \(0xaa, 0xcc\)/);
    await until(() => !running(daemon), 5_000);
    expect(daemon.signalCode).toBe("SIGTERM");
  });

  it("when the daemon's own channel list cannot be read, a channel record on disk that is not finalized counts as live", async () => {
    const home = bareHome(await freePort()); // nothing listens on that port
    const id = `0x${"ab".repeat(32)}`;
    mkdirSync(join(home, "channels", id), { recursive: true });
    writeFileSync(join(home, "channels", id, "record.json"), JSON.stringify({ channelId: id, finalized: false }));
    const daemon = await standIn("daemon");
    holdLock(home, daemon.pid!);
    const t = cliIo(home);
    expect(await runCli(["daemon", "stop"], t.io)).toBe(1);
    expect(t.err.join("\n")).toMatch(new RegExp(`channels are live \\(${id}, from the channel records on disk \\(the daemon's own list could not be read: `));
    await new Promise((r) => setTimeout(r, 300));
    expect(running(daemon)).toBe(true);
  });

  it("refuses with nothing to stop, and rejects --detach and a bad --timeout", async () => {
    const home = bareHome();
    const t = cliIo(home);
    expect(await runCli(["daemon", "stop"], t.io)).toBe(1);
    expect(t.err.join("\n")).toMatch(/no arena daemon is running on .*: nothing to stop/);
    const d = cliIo(home);
    expect(await runCli(["daemon", "stop", "--detach"], d.io)).toBe(2);
    expect(d.err.join("\n")).toMatch(/daemon stop takes no --detach/);
    const b = cliIo(home);
    expect(await runCli(["daemon", "stop", "--timeout", "0"], b.io)).toBe(2);
  });
});
