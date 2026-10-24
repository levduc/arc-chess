import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, fstatSync, openSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { loadToken, readConfig } from "./config.js";
import { livePidHoldingLock } from "./lock.js";
import { RecordStore } from "./records.js";

/** Plan 6 hardening H4: how long `arena daemon --detach` waits, by default, for the daemon it started to answer.
 *  `start()` reads the chain before the API listens, and a rate-limited RPC retries each read for up to 15.5 s. */
export const DETACH_WAIT_DEFAULT_S = 60;

/** How long a child that never took the home's lock gets to stop on SIGTERM before it is SIGKILLed. */
const DETACH_STOP_GRACE_MS = 10_000;

/** How often the parent re-reads the log and the lock while it waits. */
const DETACH_POLL_MS = 200;

/**
 * What `arena daemon --detach` prints, as one JSON line, whenever this home has a daemon afterwards (exit 0):
 * - `detached`, `healthy: true`: the daemon it started answers;
 * - `detached`, `healthy: false`: the daemon it started holds the home's lock but did not answer within the wait
 *   (H4 fix round 1, I1). It is left running -- its dispute timer starts before the chain reads that make it slow --
 *   and `hint` says what to do. `api` is the configured one (null when the home's port is 0);
 * - `alreadyRunning`: this home's daemon was running and answering already (fix round 1, I2); nothing was started.
 */
export type DetachResult =
  | { detached: true; healthy: true; pid: number; api: string; log: string }
  | { detached: true; healthy: false; pid: number; api: string | null; log: string; hint: string }
  | { alreadyRunning: true; healthy: true; pid: number; api: string; log: string };

/** The last few lines of `text`, on one line: the CLI prints only an error's first line. */
function tailOneLine(text: string): string {
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l !== "");
  const tail = lines.slice(-5).join(" | ");
  return tail.length > 800 ? `…${tail.slice(-799)}` : tail;
}

/** What the log at `path` holds after byte `from` -- what a child spawned when the log was `from` bytes long wrote.
 *  Exported for tests: an earlier daemon's lines before `from` are never read as this child's. */
export function logAfter(path: string, from: number): string {
  try {
    return readFileSync(path).subarray(from).toString("utf8");
  } catch {
    return "";
  }
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** True once `<api>/health` answers 200 within 2 s. */
async function answers(api: string | null, fetchFn: typeof fetch): Promise<boolean> {
  if (api === null) return false;
  try {
    return (await fetchFn(`${api}/health`, { signal: AbortSignal.timeout(2_000) })).ok;
  } catch {
    return false;
  }
}

/** A process started this long after `daemon.lock` was last written cannot be the process that wrote it. The slack
 *  covers the start-time sources' own precision: whole seconds (`/proc/stat`'s `btime`, `ps`'s `etime`). */
const LOCK_WRITER_SLACK_MS = 2_000;

/** `ps -o etime=`'s `[[dd-]hh:]mm:ss`, in seconds; null if it is not that shape. Exported for tests. */
export function parseEtime(etime: string): number | null {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(etime.trim());
  if (m === null) return null;
  return Number(m[1] ?? 0) * 86_400 + Number(m[2] ?? 0) * 3_600 + Number(m[3]) * 60 + Number(m[4]);
}

/**
 * H4 add-on: a pid's argv and when it started (ms since the epoch), or null when the process is gone (a zombie, exited
 * but not yet reaped, counts as gone) or cannot be read. Linux reads `/proc` (`cmdline`; `stat`'s start time in
 * USER_HZ ticks, 100 per second, after `/proc/stat`'s boot time); elsewhere, `ps -o etime= -o args=`.
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

/** Why the live pid `daemon.lock` names is not this home's `arena daemon`, or null when it is. */
type HolderProblem = { kind: "unreadable" } | { kind: "gone" } | { kind: "reused" } | { kind: "notDaemon"; argv: string[] };

/**
 * H4 add-on: `daemon.lock` names a pid only. The process with that pid is the one that wrote the lock if, and only if,
 * it started before the lock was written (a pid cannot be reused while its process lives). And it must be `arena
 * daemon` itself: `arena bot` and an in-process `withdraw` hold the same lock. Shared by `daemon stop` (never signal
 * anything else) and `--detach` (fix round 1, I2: say what the holder is).
 */
function holderProblem(home: string, facts: { argv: string[]; startedAtMs: number } | null): HolderProblem | null {
  if (facts === null) return { kind: "unreadable" };
  let written: number;
  try {
    written = statSync(join(home, "daemon.lock")).mtimeMs;
  } catch {
    return { kind: "gone" };
  }
  if (facts.startedAtMs > written + LOCK_WRITER_SLACK_MS) return { kind: "reused" };
  if (!facts.argv.includes("daemon")) return { kind: "notDaemon", argv: facts.argv };
  return null;
}

const argvSummary = (argv: string[]) => argv.slice(1).join(" ").slice(0, 120);

/**
 * H4 fix round 1 (I2, M1): what `--detach` does when the live pid `pid` already holds this home's lock -- before it
 * spawns, or after its own child lost the race for the lock. `"proceed"` when the lock turns out to be gone. A pid that
 * is not this home's daemon is named, with what to do; this home's daemon is given until `deadline` to answer
 * `/health` (it may be starting), and then is reported running, or not answering with the way out. Never a loop:
 * every message says what to run next, and none says to run `--detach` again as is.
 */
async function alreadyHeld(
  home: string,
  pid: number,
  ctx: { api: string | null; log: string; deadline: number; fetch: typeof fetch; command: string },
): Promise<DetachResult | "proceed"> {
  const lock = join(home, "daemon.lock");
  const problem = holderProblem(home, processFacts(pid));
  if (problem?.kind === "gone") return "proceed";
  if (problem?.kind === "reused") {
    throw new Error(
      `${lock} names pid ${pid}, but that process started after the lock was written: it is another program that ` +
        `reused the pid, not a daemon. No daemon can start on this home until that process exits: tell your human`,
    );
  }
  if (problem?.kind === "notDaemon") {
    throw new Error(
      `pid ${pid} holds ${home} but is not "${ctx.command} daemon" (${argvSummary(problem.argv)}): an "${ctx.command} bot" ` +
        `or a withdraw in progress. Wait until it ends (a withdraw takes seconds), then run "${ctx.command} daemon --detach"`,
    );
  }
  // This home's daemon (or, "unreadable", one whose pid cannot be checked: its own /health is then the only word).
  do {
    if (await answers(ctx.api, ctx.fetch)) return { alreadyRunning: true, healthy: true, pid, api: ctx.api!, log: ctx.log };
    if (livePidHoldingLock(home) !== pid) return "proceed";
    await sleep(DETACH_POLL_MS);
  } while (Date.now() < ctx.deadline);
  throw new Error(
    `another arena daemon (pid ${pid}) is using ${home} but does not answer${ctx.api !== null ? ` on ${ctx.api}` : ""}: it ` +
      `is still starting (a slow or rate-limited RPC) or stuck, and it may already be watching your channels, so do not ` +
      `start another. Run "${ctx.command} channels" in a minute; if it still cannot reach the daemon, run "${ctx.command} ` +
      `daemon stop", then "${ctx.command} daemon --detach"; if that happens again, read the end of ${ctx.log} and tell your human`,
  );
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
 * A live pid already holding the lock goes to `alreadyHeld`, and so does one that wins the lock from this call's own
 * child (fix round 1, M1). Otherwise it waits up to `waitMs` for the child's own start line in the log (printed once
 * its API listens), its pid in `daemon.lock` and its `/health`. Fix round 1 (I1): a child that holds the lock at the
 * deadline is never stopped -- `ArenaDaemon.start()` arms its dispute timer before the chain reads that make a start
 * slow, so it may already be guarding a channel -- and is reported `healthy: false`. Only a child that exited (an error
 * with the log's last lines) or never took the lock (stopped by its own pid: SIGTERM, then SIGKILL) fails.
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
): Promise<DetachResult> {
  const { config } = readConfig(home); // a home init has not written fails here, before anything is spawned
  const api = config.port !== 0 ? `http://127.0.0.1:${config.port}` : null;
  const log = join(home, "daemon.log");
  const deadline = Date.now() + opts.waitMs;
  const ctx = { api, log, deadline, fetch: opts.fetch, command: opts.command };
  const holder = livePidHoldingLock(home);
  if (holder !== null) {
    const held = await alreadyHeld(home, holder, ctx);
    if (held !== "proceed") return held;
  }
  const self = opts.self ?? { cmd: process.execPath, args: [...process.execArgv, process.argv[1]!] };
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
  const failure = (what: string) => {
    const tail = tailOneLine(logAfter(log, from));
    return new Error(`the daemon ${what}${tail !== "" ? `: ${tail}` : ""} (its log: ${log})`);
  };

  let started: { api: string } | undefined;
  while (pid !== undefined && exited === undefined && Date.now() < deadline) {
    started ??= startLineOf(logAfter(log, from), pid);
    if (started !== undefined && livePidHoldingLock(home) === pid && (await answers(started.api, opts.fetch))) {
      return { detached: true, healthy: true, pid, api: started.api, log };
    }
    await sleep(DETACH_POLL_MS);
  }
  if (exited !== undefined || pid === undefined) {
    // M1: a child that lost the lock to another daemon (two --detach at once) is that daemon's case, not a crash.
    const other = livePidHoldingLock(home);
    if (other !== null && other !== pid) {
      const held = await alreadyHeld(home, other, ctx);
      if (held !== "proceed") return held;
    }
    throw failure(`${pid !== undefined ? `(pid ${pid}) ` : ""}${exited ?? "could not be started"} before it came up`);
  }

  // I1: it holds the lock, so it is past acquiring it and on its way through start(): left running, reported as such.
  if (livePidHoldingLock(home) === pid) {
    return {
      detached: true,
      healthy: false,
      pid,
      api: started?.api ?? api,
      log,
      hint:
        `the daemon is running but still starting (a slow or rate-limited RPC), and it keeps running: do not start ` +
        `another. Run "${opts.command} status" in a minute; next time, --timeout 100 waits longer`,
    };
  }
  // It never took the lock: stop the one process this call started, and nothing else. `exited` is checked before each
  // signal: once the child has been reaped, its pid may name another process.
  const signal = (sig: NodeJS.Signals) => {
    try {
      if (exited === undefined) process.kill(pid, sig);
    } catch {
      // already gone
    }
  };
  signal("SIGTERM");
  const graceEnd = Date.now() + DETACH_STOP_GRACE_MS;
  while (exited === undefined && alive(pid) && Date.now() < graceEnd) await sleep(DETACH_POLL_MS);
  if (alive(pid)) signal("SIGKILL");
  throw new Error(
    `${failure(`(pid ${pid}) did not take this home's lock within ${Math.round(opts.waitMs / 1000)} s, so it was stopped`).message}. ` +
      `If this machine or its RPC is slow, run it again with --timeout 100`,
  );
}

/** H4 add-on: how long `arena daemon stop` waits, by default, for the daemon to exit. Its shutdown is bounded by the
 *  RPC calls already in flight (`ArenaDaemon.stop()`), each retried for up to 15.5 s on a rate-limited RPC. */
export const STOP_WAIT_DEFAULT_S = 60;

/** The phases a running daemon must keep watching: a challenge there needs an answer before its deadline. `Unknown`
 *  (the daemon has not read the channel's chain state yet) might be either. */
const LIVE_PHASES = new Set(["Open", "Challenged", "Unknown"]);

/** H4 add-on: why `pid` must not be signalled as `home`'s daemon, or null when it may be (see `holderProblem`). */
export function stopRefusal(home: string, pid: number, facts: { argv: string[]; startedAtMs: number } | null, command: string): string | null {
  const lock = join(home, "daemon.lock");
  const problem = holderProblem(home, facts);
  if (problem === null) return null;
  switch (problem.kind) {
    case "unreadable":
      return `cannot read pid ${pid}'s start time or command line, so it cannot be verified as this home's daemon: not signalling it`;
    case "gone":
      return `${lock} is gone: the daemon stopped already`;
    case "reused":
      return (
        `pid ${pid} started after ${lock} was written, so it is not the daemon that wrote it (its pid was reused): not ` +
        `signalling it. The lock is stale, but while that process runs no daemon can start on this home: tell your human`
      );
    case "notDaemon":
      return (
        `pid ${pid} holds ${home} but is not "${command} daemon" (${argvSummary(problem.argv)}): an ` +
        `"${command} bot" or a withdraw in progress holds the lock too. Not stopping it`
      );
  }
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
    await sleep(DETACH_POLL_MS);
  }
  return { stopped: true, pid };
}
