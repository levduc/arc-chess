import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, fstatSync, openSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { loadToken, readConfig } from "./config.js";
import { livePidHoldingLock } from "./lock.js";
import { RecordStore } from "./records.js";

/** Plan 6 hardening H4: how long `arena daemon --detach` waits, by default, for the daemon it started to answer.
 *  `start()` reads the chain before the API listens, and a rate-limited RPC retries each read for up to 15.5 s. */
export const DETACH_WAIT_DEFAULT_S = 60;

/** How long a daemon that did not come up gets to stop on SIGTERM before it is SIGKILLed. */
const DETACH_STOP_GRACE_MS = 10_000;

/** How often the parent re-reads the log and the lock while it waits. */
const DETACH_POLL_MS = 200;

/** What `arena daemon --detach` prints on success: one JSON line. */
export type DetachedDaemon = { detached: true; pid: number; api: string; log: string };

/** The last few lines of `text`, on one line: the CLI prints only an error's first line. */
function tailOneLine(text: string): string {
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l !== "");
  const tail = lines.slice(-5).join(" | ");
  return tail.length > 800 ? `…${tail.slice(-799)}` : tail;
}

/** The start line `arena daemon` prints once its API listens (`daemonStartLine`), if `pid`'s is in `text`. */
function startLineOf(text: string, pid: number): { api: string } | undefined {
  for (const line of text.split("\n")) {
    if (!line.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(line) as { pid?: unknown; api?: unknown };
      if (parsed.pid === pid && typeof parsed.api === "string") return { api: parsed.api };
    } catch {
      // a log line that only looks like JSON
    }
  }
  return undefined;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Plan 6 hardening H4 (live run friction 4): starts this home's daemon as a detached child, so it outlives the
 * command -- and the agent's tool session -- that started it. In the first live run every agent started the daemon
 * with its tool's background-task feature, and ending the session killed it, once mid-game with a channel open.
 *
 * The child is this same CLI, re-run directly as `<node> <execArgv> <entry script> daemon` (`self`), never a wrapper
 * or `npx` again: the `.arena-dev/bin/arena` and `.arena-testnet/bin/arena` wrappers `exec` node, and under `npx` the
 * entry script is the installed bundle. `detached: true` gives it its own session and process group, so a kill aimed
 * at the caller's group never reaches it; its stdout and stderr append to `<home>/daemon.log`, and it holds no
 * descriptor of the caller's.
 *
 * Refuses, before spawning, when a live daemon already holds this home's lock. Then waits up to `waitMs` for the
 * child's own start line in the log (printed once its API listens), its `/health`, and its pid in `daemon.lock`. If
 * the child exits first, or the wait runs out, it fails with the log's last lines -- and a child still running at the
 * deadline is stopped (SIGTERM, then SIGKILL), by its own pid only.
 */
export async function startDetachedDaemon(
  home: string,
  opts: {
    env: NodeJS.ProcessEnv;
    fetch: typeof fetch;
    waitMs: number;
    /** How a message names this CLI (`selfCommand()`). */
    command: string;
    /** The command line that re-runs this CLI (default: this process's own node, flags and entry script). */
    self?: { cmd: string; args: string[] };
  },
): Promise<DetachedDaemon> {
  const holder = livePidHoldingLock(home);
  if (holder !== null) {
    throw new Error(
      `another arena daemon (pid ${holder}) is using ${home}: it is already running, so there is nothing to start ` +
        `(check it with "${opts.command} channels")`,
    );
  }
  readConfig(home); // a home init has not written fails here, before anything is spawned
  const self = opts.self ?? { cmd: process.execPath, args: [...process.execArgv, process.argv[1]!] };
  const log = join(home, "daemon.log");
  const fd = openSync(log, "a", 0o600);
  const from = fstatSync(fd).size;
  const child = (() => {
    try {
      return spawn(self.cmd, [...self.args, "daemon"], {
        detached: true,
        stdio: ["ignore", fd, fd],
        env: { ...process.env, ...opts.env, ARENA_HOME: home },
      });
    } finally {
      closeSync(fd); // the child has its own copy
    }
  })();
  let exited: string | undefined;
  child.once("error", (err) => (exited ??= `could not be started: ${err.message}`));
  child.once("exit", (code, signal) => (exited ??= signal !== null ? `was killed by ${signal}` : `exited with code ${code}`));
  child.unref();
  const pid = child.pid;
  const logSince = () => {
    try {
      return readFileSync(log).subarray(from).toString("utf8");
    } catch {
      return "";
    }
  };
  const failure = (what: string) => {
    const tail = tailOneLine(logSince());
    return new Error(`the daemon ${what}${tail !== "" ? `: ${tail}` : ""} (its log: ${log})`);
  };

  const deadline = Date.now() + opts.waitMs;
  while (pid !== undefined && exited === undefined && Date.now() < deadline) {
    const started = startLineOf(logSince(), pid);
    if (started !== undefined && livePidHoldingLock(home) === pid) {
      try {
        const res = await opts.fetch(`${started.api}/health`, { signal: AbortSignal.timeout(2_000) });
        if (res.ok) return { detached: true, pid, api: started.api, log };
      } catch {
        // not answering yet
      }
    }
    await new Promise((r) => setTimeout(r, DETACH_POLL_MS));
  }
  if (exited !== undefined || pid === undefined) throw failure(`${exited ?? "could not be started"} before it came up`);

  // It did not come up in time: stop the one process this call started, and nothing else. `exited` is checked before
  // each signal: once the child has been reaped, its pid may name another process.
  const signal = (sig: NodeJS.Signals) => {
    try {
      if (exited === undefined) process.kill(pid, sig);
    } catch {
      // already gone
    }
  };
  signal("SIGTERM");
  const graceEnd = Date.now() + DETACH_STOP_GRACE_MS;
  while (exited === undefined && alive(pid) && Date.now() < graceEnd) await new Promise((r) => setTimeout(r, DETACH_POLL_MS));
  if (alive(pid)) signal("SIGKILL");
  throw failure(`did not come up within ${Math.round(opts.waitMs / 1000)} s, so it was stopped (pid ${pid})`);
}

/** H4 add-on: how long `arena daemon stop` waits, by default, for the daemon to exit. Its shutdown is bounded by the
 *  RPC calls already in flight (`ArenaDaemon.stop()`), each retried for up to 15.5 s on a rate-limited RPC. */
export const STOP_WAIT_DEFAULT_S = 60;

/** A process started this long after `daemon.lock` was last written cannot be the process that wrote it. The slack
 *  covers the start-time sources' own precision: whole seconds (`/proc/stat`'s `btime`, `ps`'s `etime`). */
const LOCK_WRITER_SLACK_MS = 2_000;

/** The phases a running daemon must keep watching: a challenge there needs an answer before its deadline. `Unknown`
 *  (the daemon has not read the channel's chain state yet) might be either. */
const LIVE_PHASES = new Set(["Open", "Challenged", "Unknown"]);

/** `ps -o etime=`'s `[[dd-]hh:]mm:ss`, in seconds; null if it is not that shape. Exported for tests. */
export function parseEtime(etime: string): number | null {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(etime.trim());
  if (m === null) return null;
  return Number(m[1] ?? 0) * 86_400 + Number(m[2] ?? 0) * 3_600 + Number(m[3]) * 60 + Number(m[4]);
}

/**
 * H4 add-on: what `daemon stop` checks about a pid before it signals it -- its argv and when it started (ms since the
 * epoch) -- or null when the process is gone (a zombie, exited but not yet reaped, counts as gone) or cannot be read.
 * Linux reads `/proc` (`cmdline`; `stat`'s start time in USER_HZ ticks, 100 per second, after `/proc/stat`'s boot
 * time); elsewhere, `ps -o etime= -o args=`.
 */
export function processFacts(pid: number, now = Date.now()): { argv: string[]; startedAtMs: number } | null {
  try {
    if (existsSync("/proc/self/stat")) {
      const argv = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
      if (argv.at(-1) === "") argv.pop();
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      // Fields after the parenthesised command name, which may itself hold spaces or ")": the state is field 3, the
      // start time field 22.
      const fields = stat.slice(stat.lastIndexOf(") ") + 2).split(" ");
      if (fields[0] === "Z") return null;
      const ticks = Number(fields[19]);
      const btime = Number(/^btime (\d+)$/m.exec(readFileSync("/proc/stat", "utf8"))?.[1]);
      if (!Number.isFinite(ticks) || !Number.isFinite(btime)) return null;
      return { argv, startedAtMs: btime * 1000 + ticks * 10 };
    }
    const r = spawnSync("ps", ["-o", "etime=", "-o", "args=", "-p", String(pid)], { encoding: "utf8", timeout: 5_000 });
    const line = r.status === 0 ? r.stdout.trim() : "";
    const [etime, ...args] = line.split(/\s+/);
    const seconds = etime === undefined ? null : parseEtime(etime);
    if (seconds === null || args.length === 0 || args.some((a) => a.includes("<defunct>"))) return null;
    return { argv: args, startedAtMs: now - seconds * 1000 };
  } catch {
    return null;
  }
}

/**
 * H4 add-on: why `pid` must not be signalled as `home`'s daemon, or null when it may be. `daemon.lock` names a pid
 * only; the process with that pid is the one that wrote the lock if, and only if, it started before the lock was
 * written (a pid cannot be reused while its process lives). And it must be `arena daemon` itself: `arena bot` and an
 * in-process `withdraw` hold the same lock.
 */
export function stopRefusal(home: string, pid: number, facts: { argv: string[]; startedAtMs: number } | null, command: string): string | null {
  const lock = join(home, "daemon.lock");
  if (facts === null) return `cannot read pid ${pid}'s start time or command line, so it cannot be verified as this home's daemon: not signalling it`;
  let written: number;
  try {
    written = statSync(lock).mtimeMs;
  } catch {
    return `${lock} is gone: the daemon stopped already`;
  }
  if (facts.startedAtMs > written + LOCK_WRITER_SLACK_MS) {
    return (
      `pid ${pid} started after ${lock} was written, so it is not the daemon that wrote it (its pid was reused): not ` +
      `signalling it. The lock is stale, but while that process runs no daemon can start on this home: tell your human`
    );
  }
  if (!facts.argv.includes("daemon")) {
    return (
      `pid ${pid} holds ${home} but is not "${command} daemon" (${facts.argv.slice(1).join(" ").slice(0, 120)}): an ` +
      `"${command} bot" or a withdraw in progress holds the lock too. Not stopping it`
    );
  }
  return null;
}

/** The channels of `home`'s running daemon that it must keep watching, by id: from its own `GET /channels`, or, if
 *  that cannot be read, every channel record on disk that is not finalized. */
async function liveChannels(home: string, port: number, fetchFn: typeof fetch): Promise<{ ids: string[]; source: string }> {
  try {
    const res = await fetchFn(`http://127.0.0.1:${port}/channels`, {
      headers: { authorization: `Bearer ${loadToken(home)}`, "x-arena-actor": "agent" },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`answered ${res.status}`);
    const list = (await res.json()) as Array<{ channelId?: unknown; phase?: unknown; degraded?: unknown }>;
    if (!Array.isArray(list)) throw new Error("answered something other than a list");
    const ids = list.filter((c) => c.degraded !== true && LIVE_PHASES.has(String(c.phase))).map((c) => String(c.channelId));
    return { ids, source: "the daemon's channels" };
  } catch (err) {
    const ids = new RecordStore(home).channels().filter((r) => !r.finalized).map((r) => r.channelId);
    return { ids, source: `the channel records on disk (the daemon's own list could not be read: ${err instanceof Error ? err.message : String(err)})` };
  }
}

/**
 * H4 add-on (`arena daemon stop`): stops this home's running daemon -- SIGTERM, its own clean shutdown -- and waits up
 * to `waitMs` until that process is gone. The daemon API has no shutdown route, so the pid comes from `daemon.lock`,
 * checked with `stopRefusal` before the signal and again right before it. Refuses while a channel is `Open` or
 * `Challenged` (or not read yet) unless `override`: with no daemon, nothing answers a challenge before its deadline.
 */
export async function stopDaemon(
  home: string,
  opts: { fetch: typeof fetch; waitMs: number; command: string; override: boolean; warn(line: string): void },
): Promise<{ stopped: true; pid: number }> {
  const pid = livePidHoldingLock(home);
  if (pid === null) throw new Error(`no arena daemon is running on ${home}: nothing to stop`);
  const facts = processFacts(pid);
  const refusal = stopRefusal(home, pid, facts, opts.command);
  if (refusal !== null) throw new Error(refusal);
  const { config } = readConfig(home);
  const live = await liveChannels(home, config.port, opts.fetch);
  if (live.ids.length > 0) {
    if (!opts.override) {
      throw new Error(
        `channels are live (${live.ids.join(", ")}, from ${live.source}): settle first (${opts.command} close --channel <id>, ` +
          `then wait for Finalized) or run the daemon elsewhere -- with no daemon, nothing answers a challenge before its ` +
          `deadline. To stop it anyway: ${opts.command} daemon stop --yes-i-understand`,
      );
    }
    opts.warn(`note: stopping with ${live.ids.length} live channel(s) (${live.ids.join(", ")}): nothing answers a challenge until a daemon runs again`);
  }
  // Checked again right before the signal: the same process, started at the same time, still holds the lock.
  const again = processFacts(pid);
  if (livePidHoldingLock(home) !== pid || again === null || again.startedAtMs !== facts!.startedAtMs) {
    throw new Error(`pid ${pid} changed while it was being checked: not signalling it; run "${opts.command} daemon stop" again`);
  }
  process.kill(pid, "SIGTERM");
  const gone = () => {
    const now = processFacts(pid);
    return now === null || now.startedAtMs !== facts!.startedAtMs;
  };
  const deadline = Date.now() + opts.waitMs;
  while (!gone()) {
    if (Date.now() > deadline) {
      throw new Error(`the daemon (pid ${pid}) did not exit within ${Math.round(opts.waitMs / 1000)} s of SIGTERM; it may still be shutting down`);
    }
    await new Promise((r) => setTimeout(r, DETACH_POLL_MS));
  }
  return { stopped: true, pid };
}
