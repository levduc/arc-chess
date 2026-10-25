import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generatePrivateKey } from "viem/accounts";
import { afterEach, describe, expect, it } from "vitest";
import { initHome, livePidHoldingLock, loadToken, readConfig, readLockFile, runCli, type ArenaConfig, type CliIo } from "../src/index.js";
import { identify, logAfter, processState, startDetachedDaemon, stopDaemon } from "../src/detach.js";
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

/**
 * A stand-in for a lock holder (H4 fix round 2): a node process that writes `home`'s `daemon.lock` itself, as
 * `acquireHomeLock` does ({pid, nonce}), unless `lock: false` -- or, with `nonceless`, an older CLI's `{pid}`. With
 * `answer`, it also answers `GET /health` on `home`'s configured port as a daemon's API does: asked with this home's
 * token, `{ok, pid, lock, role, degraded}`; otherwise `{ok}`. `answer.pid`, `answer.nonce` and `answer.token` make it
 * lie about the pid, report another nonce, or expect another home's token; `answer.degraded` names channels it does
 * not watch.
 */
async function standIn(
  home: string,
  opts: { lock?: boolean; nonceless?: boolean; answer?: { role?: string; pid?: number; nonce?: string; token?: string; degraded?: string[] } } = {},
): Promise<{ child: ChildProcess; nonce: string }> {
  const nonce = Math.random().toString(16).slice(2).padEnd(32, "0");
  const script =
    'const fs = require("node:fs"); const e = process.env;' +
    'if (e.FAKE_LOCK === "1") fs.writeFileSync(e.FAKE_HOME + "/daemon.lock", JSON.stringify(e.FAKE_NONCELESS === "1" ? { pid: process.pid } : { pid: process.pid, nonce: e.FAKE_NONCE }));' +
    "if (e.FAKE_PORT) require(\"node:http\").createServer((q, r) => r.end(JSON.stringify(" +
    'q.url === "/health" && q.headers.authorization === "Bearer " + e.FAKE_TOKEN' +
    "  ? { ok: true, pid: Number(e.FAKE_PID || process.pid), lock: e.FAKE_REPORT_NONCE || e.FAKE_NONCE, role: e.FAKE_ROLE, degraded: JSON.parse(e.FAKE_DEGRADED) }" +
    '  : { ok: true }))).listen(Number(e.FAKE_PORT), "127.0.0.1");' +
    "else setInterval(() => {}, 1000);";
  const port = readConfig(home).config.port;
  const child = spawn(process.execPath, ["-e", script], {
    env: {
      ...process.env,
      FAKE_HOME: home,
      FAKE_NONCE: nonce,
      FAKE_LOCK: opts.lock === false ? "0" : "1",
      FAKE_PORT: opts.answer !== undefined ? String(port) : "",
      FAKE_TOKEN: opts.answer?.token ?? loadToken(home),
      FAKE_ROLE: opts.answer?.role ?? "daemon",
      FAKE_PID: opts.answer?.pid !== undefined ? String(opts.answer.pid) : "",
      FAKE_REPORT_NONCE: opts.answer?.nonce ?? "",
      FAKE_NONCELESS: opts.nonceless === true ? "1" : "0",
      FAKE_DEGRADED: JSON.stringify(opts.answer?.degraded ?? []),
    },
    stdio: "ignore",
  });
  children.push(child);
  if (opts.lock !== false) await until(() => readLockFile(home)?.pid === child.pid, 10_000);
  if (opts.answer !== undefined) await until(async () => (await fetch(`http://127.0.0.1:${port}/health`).catch(() => null))?.ok === true, 10_000);
  return { child, nonce };
}
const running = (c: ChildProcess) => c.exitCode === null && c.signalCode === null;
/** A channel record on disk, as `RecordStore` reads it (only the fields `daemon stop` looks at). */
function writeRecord(home: string, n: number, finalized: boolean, finalPhase?: string): string {
  const id = `0x${n.toString(16).padStart(64, "0")}`;
  mkdirSync(join(home, "channels", id), { recursive: true });
  writeFileSync(join(home, "channels", id, "record.json"), JSON.stringify({ channelId: id, finalized, ...(finalPhase ? { finalPhase } : {}) }));
  return id;
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
    const line = JSON.parse(out.split("\n")[0]!) as { detached: boolean; healthy: boolean; pid: number; api: string; log: string };
    daemons.push({ pid: line.pid, home });
    expect(Object.keys(line)).toEqual(["detached", "healthy", "pid", "api", "log"]);
    expect(line).toMatchObject({ detached: true, healthy: true, api: `http://127.0.0.1:${port}`, log: join(home, "daemon.log") });
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

    // A second --detach on the same home starts nothing: this home's daemon is running and answering (fix round 1, I2).
    const second = await runBin(home, ["daemon", "--detach"]);
    expect(second.code, second.err).toBe(0);
    expect(JSON.parse(second.out.trim())).toEqual({ alreadyRunning: true, healthy: true, pid: line.pid, api: line.api, log: line.log });
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

  it("a child that never takes the home's lock is stopped at the deadline, by its own pid, with its log and --timeout 100", async () => {
    const home = bareHome();
    const self = { cmd: process.execPath, args: ["-e", 'console.log("still starting"); setInterval(() => {}, 1000)'] };
    const before = Date.now();
    const err = await startDetachedDaemon(home, { env: { ARENA_HOME: home }, fetch, waitMs: 1_000, command: "arena", self }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    const pid = Number(/^the daemon \(pid (\d+)\)/.exec(message)?.[1]);
    expect(message).toMatch(
      /^the daemon \(pid \d+\) did not take this home's lock within 1 s, so it was stopped: still starting \(its log: .*daemon\.log\)\. If this machine or its RPC is slow, run it again with --timeout 100$/,
    );
    expect(alive(pid)).toBe(false);
    expect(Date.now() - before).toBeLessThan(15_000);
  });

  it("fix round 1 (M9): one that ignores SIGTERM is SIGKILLed after the 10 s grace", async () => {
    const home = bareHome();
    const self = { cmd: process.execPath, args: ["-e", 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'] };
    const before = Date.now();
    const err = await startDetachedDaemon(home, { env: { ARENA_HOME: home }, fetch, waitMs: 1_000, command: "arena", self }).catch((e: Error) => e);
    const pid = Number(/^the daemon \(pid (\d+)\)/.exec((err as Error).message)?.[1]);
    expect(pid).toBeGreaterThan(0);
    await until(() => !alive(pid), 5_000);
    const took = Date.now() - before;
    expect(took).toBeGreaterThan(10_000); // it did get the grace
    expect(took).toBeLessThan(1_000 + 10_000 + 5_000);
  }, 30_000);

  it("fix round 1 (I1): a child that holds the lock but does not answer in time is left running, reported healthy: false", async () => {
    const port = await freePort(); // nothing answers there
    const home = bareHome(port);
    // A daemon stuck in start(): it took the lock (the first thing startDaemonProcess does), and its API never listens.
    // With a nonce, as this CLI's acquireHomeLock writes it (final fix wave B, m-1: a nonceless lock is an older CLI's).
    const takeLock =
      'require("node:fs").writeFileSync(process.env.ARENA_HOME + "/daemon.lock", JSON.stringify({ pid: process.pid, nonce: "a".repeat(32) }))';
    const self = { cmd: process.execPath, args: ["-e", `${takeLock}; setInterval(() => {}, 1000)`] };
    const result = await startDetachedDaemon(home, { env: { ARENA_HOME: home }, fetch, waitMs: 1_500, command: "arena", self });
    expect(result).toMatchObject({ detached: true, healthy: false, api: `http://127.0.0.1:${port}`, log: join(home, "daemon.log") });
    const pid = result.pid;
    daemons.push({ pid, home });
    expect("hint" in result && result.hint).toBe(
      'the daemon is running but still starting (a slow or rate-limited RPC), and it keeps running: do not start another. ' +
        'Run "arena channels" in a minute; next time, --timeout 100 waits longer',
    );
    await new Promise((r) => setTimeout(r, 500));
    expect(alive(pid)).toBe(true); // never stopped
    expect(livePidHoldingLock(home)).toBe(pid);
    // And a second --detach does not start another: it names the one that does not answer, and the way out.
    const t = cliIo(home);
    expect(await runCli(["daemon", "--detach", "--timeout", "1"], t.io)).toBe(1);
    expect(t.err.join("\n")).toMatch(
      new RegExp(
        `another arena daemon \\(pid ${pid}\\) holds .* but does not answer on http://127\\.0\\.0\\.1:${port}: it may still be ` +
          `starting .* do not start another\\. Run "arena channels" in a minute; if it still cannot reach the daemon, tell your ` +
          `human: pid ${pid}, its log .*daemon\\.log`,
      ),
    );
    expect(alive(pid)).toBe(true);
  });

  it("a daemon that exits during startup fails with its pid, exit code and log, and nothing is left running", async () => {
    const home = bareHome();
    const self = { cmd: process.execPath, args: ["-e", 'console.error("error: cannot reach the RPC"); process.exit(3)'] };
    const err = await startDetachedDaemon(home, { env: { ARENA_HOME: home }, fetch, waitMs: 30_000, command: "arena", self }).catch((e: Error) => e);
    const message = (err as Error).message;
    expect(message).toMatch(/^the daemon \(pid \d+\) exited with code 3 before it came up: error: cannot reach the RPC \(its log: /);
    expect(alive(Number(/^the daemon \(pid (\d+)\)/.exec(message)?.[1]))).toBe(false);
  });

  it("fix round 1 (M9): an earlier run's lines in daemon.log, before the spawn offset, are never read", () => {
    const home = bareHome();
    const log = join(home, "daemon.log");
    writeFileSync(log, '{"api":"http://127.0.0.1:1","pid":4242}\n');
    const from = readFileSync(log).length;
    expect(logAfter(log, from)).toBe("");
    writeFileSync(log, '{"api":"http://127.0.0.1:2","pid":4243}\n', { flag: "a" });
    expect(logAfter(log, from)).toBe('{"api":"http://127.0.0.1:2","pid":4243}\n');
    expect(logAfter(join(home, "missing.log"), 0)).toBe("");
  });

  it("fix round 2 (N3): a live lock pid that never answers -- stuck, starting, or a reused pid -- is 'not answering', never 'reused'", async () => {
    // A daemon stuck before its API listens: it wrote the lock, and nothing answers on the port.
    const stuckHome = bareHome(await freePort());
    const stuck = await standIn(stuckHome);
    // A reused pid: a lock written by an earlier daemon, whose pid now names an unrelated process.
    const reusedHome = bareHome(await freePort());
    const unrelated = await standIn(reusedHome, { lock: false });
    writeFileSync(join(reusedHome, "daemon.lock"), JSON.stringify({ pid: unrelated.child.pid, nonce: "f".repeat(32) }));
    for (const [home, pid] of [[stuckHome, stuck.child.pid!], [reusedHome, unrelated.child.pid!]] as const) {
      const t = cliIo(home);
      expect(await runCli(["daemon", "--detach", "--timeout", "1"], t.io)).toBe(1);
      const err = t.err.join("\n");
      expect(err).toMatch(
        new RegExp(
          `another arena daemon \\(pid ${pid}\\) holds .* but does not answer on http://127\\.0\\.0\\.1:\\d+: it may still be starting \\(a slow or ` +
            `rate-limited RPC\\) or be stuck, and it may already be watching your channels, so do not start another\\. Run "arena channels" ` +
            `in a minute; if it still cannot reach the daemon, tell your human: pid ${pid}, its log .*daemon\\.log`,
        ),
      );
      expect(err).not.toMatch(/reused|stale/);
      expect(existsSync(join(home, "daemon.log"))).toBe(false); // nothing spawned
    }
    expect(running(stuck.child) && running(unrelated.child)).toBe(true);
  });

  it("fix round 2: the holder's own API names it -- this home's daemon is alreadyRunning; a bot, a withdraw, a stranger are named", async () => {
    const answering = async (answer: { role?: string; pid?: number; nonce?: string; token?: string }, timeout = "1") => {
      const home = bareHome(await freePort());
      const holder = await standIn(home, { answer });
      const t = cliIo(home);
      const code = await runCli(["daemon", "--detach", "--timeout", timeout], t.io);
      return { home, holder, code, out: t.out.join("\n"), err: t.err.join("\n") };
    };
    const daemon = await answering({ role: "daemon" });
    expect(daemon.code, daemon.err).toBe(0);
    expect(JSON.parse(daemon.out)).toEqual({
      alreadyRunning: true,
      healthy: true,
      pid: daemon.holder.child.pid,
      api: `http://127.0.0.1:${readConfig(daemon.home).config.port}`,
      log: join(daemon.home, "daemon.log"),
    });
    const bot = await answering({ role: "bot" });
    expect(bot.code).toBe(1);
    expect(bot.err).toContain(`an "arena bot" (pid ${bot.holder.child.pid}) holds ${bot.home}, and a home runs one daemon or one bot: use another ARENA_HOME`);
    const withdraw = await answering({ role: "withdraw" });
    expect(withdraw.code).toBe(1);
    expect(withdraw.err).toContain(`a withdraw in progress (pid ${withdraw.holder.child.pid}) holds ${withdraw.home}: wait until it ends (it takes seconds), then run "arena daemon --detach"`);
    // Another nonce than the lock's: the answering process is not the lock's writer.
    const other = await answering({ nonce: "e".repeat(32) });
    expect(other.code).toBe(1);
    expect(other.err).toMatch(/is answered with this home's token by pid \d+, not by the daemon\.lock's writer: tell your human/);
    // Another home's daemon on this port (or an older CLI's): it answers, but not with this home's identity. Final fix
    // wave B (m-2): a definite answer, so it fails at once -- before, it was polled until the deadline -- and says
    // how the human stops it by hand.
    const started = Date.now();
    const stranger = await answering({ token: "0".repeat(64) }, "30");
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(stranger.code).toBe(1);
    expect(stranger.err).toContain(
      `pid ${stranger.holder.child.pid} holds ${stranger.home}, but a daemon from an older CLI (or another home) answers on ` +
        `http://127.0.0.1:${readConfig(stranger.home).config.port} without saying which process it is: this CLI cannot confirm it ` +
        `is this home's daemon. Tell your human: pid ${stranger.holder.child.pid}, its log ${join(stranger.home, "daemon.log")}; ` +
        `if it is this home's daemon from before a CLI upgrade, they stop it by hand (the CLI README, "Stopping a daemon by ` +
        `hand"). Do not start another daemon`,
    );
    for (const c of [daemon, bot, withdraw, other, stranger]) expect(running(c.holder.child)).toBe(true);
    for (const c of [daemon, bot, withdraw, other, stranger]) expect(existsSync(join(c.home, "daemon.log"))).toBe(false);
  });

  it("final fix wave B (m-1): a lock with no nonce is never confirmed, even by a listener that echoes its pid -- nothing is signalled", async () => {
    // A {pid} lock (an older CLI's, or a stuck one's whose pid was reused) and a listener on the home's port that
    // answers this home's token with that pid and role "daemon". Before: --detach reported it alreadyRunning, and
    // daemon stop SIGTERMed it, on the pid alone.
    const home = bareHome(await freePort());
    const holder = await standIn(home, { nonceless: true, answer: {} });
    expect(readLockFile(home)).toEqual({ pid: holder.child.pid });
    const detach = cliIo(home);
    expect(await runCli(["daemon", "--detach", "--timeout", "30"], detach.io)).toBe(1);
    const why = "its daemon.lock has no nonce (an older CLI wrote it), so no answer can confirm it: this CLI cannot confirm it is this home's daemon";
    expect(detach.err.join("\n")).toContain(`pid ${holder.child.pid} holds ${home}, but ${why}. Tell your human:`);
    expect(detach.out).toEqual([]);
    const stop = cliIo(home);
    expect(await runCli(["daemon", "stop"], stop.io)).toBe(1);
    expect(stop.err.join("\n")).toContain(`but ${why}`);
    expect(stop.err.join("\n")).toMatch(/Not signalling anything$/m);
    await new Promise((r) => setTimeout(r, 300));
    expect(running(holder.child)).toBe(true);
    expect(existsSync(join(home, "daemon.log"))).toBe(false); // nothing spawned
  });

  it("fix round 1 (I3, M4): init on a home a daemon holds says to skip init, and names daemon stop -- never kill", async () => {
    const home = bareHome();
    const daemon = await standIn(home);
    const t = cliIo(home);
    expect(await runCli(["init", "--server", "http://127.0.0.1:3000"], t.io)).toBe(1);
    const err = t.err.join("\n");
    expect(err).toContain(`a live arena daemon (pid ${daemon.child.pid}) already holds ${home}. If this home is already set up for this server, skip init`);
    expect(err).toContain('To re-run init anyway, stop it first with "arena daemon stop" (refused while a channel is live)');
    expect(err).not.toMatch(/\bkill\b/);
  });

  it("fix round 1 (M1, M9): two --detach at once leave exactly one daemon; the other reports it alreadyRunning", async () => {
    const { home } = await detachHome();
    const [a, b] = await Promise.all([runBin(home, ["daemon", "--detach"]), runBin(home, ["daemon", "--detach"])]);
    expect([a.code, b.code], `${a.err}\n${b.err}`).toEqual([0, 0]);
    const lines = [JSON.parse(a.out.trim()), JSON.parse(b.out.trim())] as Array<{ detached?: true; alreadyRunning?: true; healthy: boolean; pid: number }>;
    const started = lines.filter((l) => l.detached === true);
    const found = lines.filter((l) => l.alreadyRunning === true);
    expect([started.length, found.length]).toEqual([1, 1]);
    expect(started[0]!.healthy && found[0]!.healthy).toBe(true);
    expect(found[0]!.pid).toBe(started[0]!.pid);
    daemons.push({ pid: started[0]!.pid, home });
    expect(livePidHoldingLock(home)).toBe(started[0]!.pid);
    const stop = await runBin(home, ["daemon", "stop"]);
    expect(stop.code, stop.err).toBe(0);
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

describe("H4 add-on: arena daemon stop (fix round 2: the daemon's own API names it; every unfinalized record is live)", () => {
  const stopIo = (home: string) => cliIo(home);

  it("a lock pid that does not answer is never signalled, whatever it is: wait, retry, then tell the human", async () => {
    const stuckHome = bareHome(await freePort());
    const stuck = await standIn(stuckHome);
    const reusedHome = bareHome(await freePort());
    const unrelated = await standIn(reusedHome, { lock: false });
    writeFileSync(join(reusedHome, "daemon.lock"), JSON.stringify({ pid: unrelated.child.pid, nonce: "f".repeat(32) }));
    for (const [home, pid] of [[stuckHome, stuck.child.pid!], [reusedHome, unrelated.child.pid!]] as const) {
      const t = stopIo(home);
      expect(await runCli(["daemon", "stop"], t.io)).toBe(1);
      expect(t.err.join("\n")).toMatch(
        new RegExp(
          `the daemon daemon\\.lock names \\(pid ${pid}\\) does not answer on http://127\\.0\\.0\\.1:\\d+, so it is not signalled: it may ` +
            `still be starting, be stuck, or not be a daemon at all\\. Wait a minute and run "arena daemon stop" again; if it still ` +
            `does not answer, tell your human: pid ${pid}, its log .*daemon\\.log`,
        ),
      );
      expect(t.out).toEqual([]);
    }
    await new Promise((r) => setTimeout(r, 300));
    expect(running(stuck.child) && running(unrelated.child)).toBe(true);
  });

  it("refuses a holder whose API is not the lock's writer, or is a bot or a withdraw -- nothing is signalled", async () => {
    for (const [answer, want] of [
      [{ nonce: "e".repeat(32) }, /not by the daemon\.lock's writer: not signalling anything\. Tell your human/],
      [{ role: "bot" }, /is "arena bot", not "arena daemon": not stopping it$/m],
      [{ role: "withdraw" }, /is "arena withdraw", not "arena daemon": not stopping it \(a withdraw ends by itself in seconds\)/],
    ] as const) {
      const home = bareHome(await freePort());
      const holder = await standIn(home, { answer });
      const t = stopIo(home);
      expect(await runCli(["daemon", "stop"], t.io)).toBe(1);
      expect(t.err.join("\n")).toMatch(want);
      await new Promise((r) => setTimeout(r, 200));
      expect(running(holder.child)).toBe(true);
    }
  });

  it("N2: every channel record that is not finalized is live, whatever its phase -- retired ones are not; m2: the override is the human's", async () => {
    const home = bareHome(await freePort());
    const live = [
      writeRecord(home, 1, false), // None: our own deposit may be in flight
      writeRecord(home, 2, false), // Funding: the hub opens it by itself on the opponent's deposit
      writeRecord(home, 3, false), // Open
      writeRecord(home, 4, false), // Challenged
      writeRecord(home, 5, false), // Funding past its deadline with our deposit: this daemon must reclaim it
    ];
    writeRecord(home, 6, true, "Finalized");
    writeRecord(home, 7, true, "Reclaimed");
    writeRecord(home, 8, true, "None"); // retired: the funding window closed with none of our money in it
    writeRecord(home, 9, true, "Funding"); // retired: only the opponent funded (theirs to reclaim)
    const daemon = await standIn(home, { answer: {} });
    const t = stopIo(home);
    expect(await runCli(["daemon", "stop"], t.io)).toBe(1);
    const err = t.err.join("\n");
    const named = /channels are live \(([^:]*): their records are not finalized\)/.exec(err)?.[1]?.split(", ") ?? [];
    expect([...named].sort()).toEqual([...live].sort());
    expect(err).toContain("a channel being funded can open with nobody watching it");
    expect(err).toMatch(/Stopping it anyway is your human's decision, not yours$/m);
    expect(err).not.toContain("--yes-i-understand");
    await new Promise((r) => setTimeout(r, 300));
    expect(running(daemon.child)).toBe(true);

    const forced = stopIo(home);
    expect(await runCli(["daemon", "stop", "--yes-i-understand"], forced.io), forced.err.join("\n")).toBe(0);
    expect(JSON.parse(forced.out.join("\n"))).toEqual({ stopped: true, pid: daemon.child.pid });
    expect(forced.err.join("\n")).toMatch(/note: stopping with 5 live channel\(s\)/);
    await until(() => !running(daemon.child), 5_000);
    expect(daemon.child.signalCode).toBe("SIGTERM");
  });

  it("final fix wave B (m-4): an unreadable or degraded record blocks stop too, named as not watched by any daemon -- the human's, never close", async () => {
    const home = bareHome(await freePort());
    const open = writeRecord(home, 1, false);
    const degraded = writeRecord(home, 2, false); // readable, but the daemon could not load its session
    const unreadable = `0x${(3).toString(16).padStart(64, "0")}`;
    mkdirSync(join(home, "channels", unreadable), { recursive: true });
    writeFileSync(join(home, "channels", unreadable, "record.json"), "{ not json");
    writeRecord(home, 4, true, "Finalized");
    const daemon = await standIn(home, { answer: { degraded: [degraded] } });
    const t = cliIo(home);
    expect(await runCli(["daemon", "stop"], t.io)).toBe(1);
    const err = t.err.join("\n");
    // Before: the unreadable record did not count at all, and the degraded one was told to `close`.
    expect(err).toContain(`channels are live (${open}: their records are not finalized): settle first (arena close --channel <id>`);
    expect(err).toContain(
      `channel(s) ${degraded} (degraded), ${unreadable} (its record cannot be read) are not finalized and not watched by any ` +
        "daemon: close cannot settle them, so tell your human (they may still hold funds). Stopping it anyway is your human's decision, not yours",
    );
    await new Promise((r) => setTimeout(r, 300));
    expect(running(daemon.child)).toBe(true);
    // Only unwatched ones: no "settle first" at all.
    const onlyUnwatched = bareHome(await freePort());
    mkdirSync(join(onlyUnwatched, "channels", unreadable), { recursive: true });
    writeFileSync(join(onlyUnwatched, "channels", unreadable, "record.json"), "{ not json");
    await standIn(onlyUnwatched, { answer: {} });
    const u = cliIo(onlyUnwatched);
    expect(await runCli(["daemon", "stop"], u.io)).toBe(1);
    expect(u.err.join("\n")).toMatch(new RegExp(`^error: channel\\(s\\) ${unreadable} \\(its record cannot be read\\) are not finalized`));
    expect(u.err.join("\n")).not.toContain("settle first");
  });

  it("with only finalized records (settled, reclaimed, retired) it stops without the override -- and on the ps path, with no /proc", async () => {
    const home = bareHome(await freePort());
    writeRecord(home, 1, true, "Finalized");
    writeRecord(home, 2, true, "None");
    const daemon = await standIn(home, { answer: {} });
    const lock = readLockFile(home)!;
    expect(lock).toEqual({ pid: daemon.child.pid, nonce: daemon.nonce });
    expect(await identify(home, `http://127.0.0.1:${readConfig(home).config.port}`, lock, fetch)).toEqual({ state: "confirmed", pid: daemon.child.pid, role: "daemon", degraded: [] });
    expect(processState(daemon.child.pid!, "ps")).toBe("running");
    expect(processState(daemon.child.pid!, "proc")).toBe("running");
    const result = await stopDaemon(home, { fetch, waitMs: 10_000, command: "arena", override: false, warn: () => {}, processSource: "ps" });
    expect(result).toEqual({ stopped: true, pid: daemon.child.pid });
    await until(() => !running(daemon.child), 5_000);
    expect(processState(daemon.child.pid!, "ps")).toBe("gone");
    expect(processState(daemon.child.pid!, "proc")).toBe("gone");
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
