import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, fstatSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadToken, readConfig } from "./config.js";
import { livePidHoldingLock, readLockFile } from "./lock.js";
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
 * - `detached`, `healthy: true`: the daemon it started answers, and says it is the process that holds the lock;
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

/** Where a pid's state is read: `/proc` (Linux) or `ps` (macOS and every other system without it). */
export type ProcessSource = "proc" | "ps";

/**
 * H4 fix round 2: whether `pid` still runs -- `"zombie"` (exited, not yet reaped) and `"gone"` both mean it has
 * exited. Used only to see a stopped daemon go, never to identify one (that is `identify`'s job, with no clock).
 * Exported for tests, which force the `ps` path.
 */
export function processState(pid: number, source: ProcessSource = existsSync("/proc/self/stat") ? "proc" : "ps"): "running" | "zombie" | "gone" {
  if (!alive(pid)) return "gone";
  if (source === "proc") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      // The state is the field right after the parenthesised command name, which may itself hold spaces or ")".
      return stat.slice(stat.lastIndexOf(") ") + 2).startsWith("Z") ? "zombie" : "running";
    } catch {
      return "gone";
    }
  }
  const r = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8", timeout: 5_000 });
  if (r.status !== 0) return "gone";
  return r.stdout.trim().startsWith("Z") ? "zombie" : "running";
}

/** What `identify` learned about the process `daemon.lock` names. `definite` (final fix wave B, m-2): a `silent` that
 *  waiting does not change -- an answer without identity, or a lock no answer can match -- unlike one that does not
 *  answer (yet). `degraded` (m-4): the channels the confirmed daemon does not watch. */
export type Identity =
  | { state: "confirmed"; pid: number; role: string; degraded: string[] }
  | { state: "silent"; why: string; definite?: true }
  | { state: "other"; why: string };

/**
 * H4 fix round 2 (N1, N3): who answers this home's API, and whether it is the process `daemon.lock` names -- asked of
 * the daemon itself, with no clock. `GET /health` with this home's bearer token answers `{pid, lock, role, degraded}`:
 * its own pid, the random nonce its `acquireHomeLock` wrote into `daemon.lock`, the command running it, and the
 * channels it does not watch. `confirmed` only when that pid is the lock's pid, that nonce the lock's nonce, and a
 * role is named. Final fix wave B (m-1): a lock with no nonce (written by an older CLI) is never confirmed -- only the
 * nonce proves anything, and any loopback listener can echo a pid. `silent` when nothing answers, or the answer names
 * no process (another home's daemon on that port, without this token, or an older CLI's); `other` when this home's
 * token is answered by a different pid or nonce than the lock's.
 */
export async function identify(home: string, api: string | null, lock: { pid: number; nonce?: string }, fetchFn: typeof fetch): Promise<Identity> {
  if (api === null) return { state: "silent", why: "cannot be asked: this home's port is 0" };
  if (lock.nonce === undefined) {
    return { state: "silent", why: "its daemon.lock has no nonce (an older CLI wrote it), so no answer can confirm it", definite: true };
  }
  let body: { pid?: unknown; lock?: unknown; role?: unknown; degraded?: unknown };
  try {
    const res = await fetchFn(`${api}/health`, {
      headers: { authorization: `Bearer ${loadToken(home)}` },
      signal: AbortSignal.timeout(2_000),
    });
    if (!res.ok) return { state: "silent", why: `answers ${api} with ${res.status}` };
    body = (await res.json()) as typeof body;
  } catch {
    return { state: "silent", why: `does not answer on ${api}` };
  }
  if (typeof body.pid !== "number") {
    return { state: "silent", why: `a daemon from an older CLI (or another home) answers on ${api} without saying which process it is`, definite: true };
  }
  if (body.pid !== lock.pid || body.lock !== lock.nonce) {
    return { state: "other", why: `${api} is answered with this home's token by pid ${body.pid}, not by the daemon.lock's writer` };
  }
  if (typeof body.role !== "string") {
    return { state: "silent", why: `${api} answers for pid ${body.pid} without saying which command it runs`, definite: true };
  }
  const degraded = Array.isArray(body.degraded) ? body.degraded.filter((d): d is string => typeof d === "string") : [];
  return { state: "confirmed", pid: body.pid, role: body.role, degraded };
}

/** Final fix wave B (m-2): what a holder this CLI cannot identify, and will not signal, needs: the human's manual stop. */
function unidentifiedHolder(pid: number, home: string, why: string, log: string): string {
  return (
    `pid ${pid} holds ${home}, but ${why}: this CLI cannot confirm it is this home's daemon. Tell your human: pid ${pid}, ` +
    `its log ${log}; if it is this home's daemon from before a CLI upgrade, they stop it by hand (the CLI README, ` +
    `"Stopping a daemon by hand")`
  );
}

/**
 * H4 fix rounds 1 and 2 (I2, M1, N3): what `--detach` does when the live pid `pid` already holds this home's lock --
 * before it spawns, or after its own child lost the race for the lock. `"proceed"` when the lock turns out to be gone.
 * The holder is identified through its own API (`identify`) until `deadline` (it may be starting): this home's
 * `arena daemon` is reported running; a live pid that never answers -- still starting, stuck, or a reused pid -- gets
 * the "not answering" message, with what to do. Never a loop: no message says to run `--detach` again as is, and
 * none calls a lock stale while its pid lives.
 */
async function alreadyHeld(
  home: string,
  pid: number,
  ctx: { api: string | null; log: string; deadline: number; fetch: typeof fetch; command: string },
): Promise<DetachResult | "proceed"> {
  let why = "does not answer";
  do {
    const lock = readLockFile(home);
    if (lock === null || lock.pid !== pid || !alive(pid)) return "proceed";
    const id = await identify(home, ctx.api, lock, ctx.fetch);
    if (id.state === "confirmed") {
      if (id.role === "daemon") return { alreadyRunning: true, healthy: true, pid, api: ctx.api!, log: ctx.log };
      throw new Error(
        id.role === "withdraw"
          ? `a withdraw in progress (pid ${pid}) holds ${home}: wait until it ends (it takes seconds), then run "${ctx.command} daemon --detach"`
          : `an "${ctx.command} ${id.role}" (pid ${pid}) holds ${home}, and a home runs one daemon or one bot: use another ARENA_HOME`,
      );
    }
    if (id.state === "other") throw new Error(`pid ${pid} holds ${home}, but ${id.why}: tell your human (pid ${pid}, log ${ctx.log})`);
    // Final fix wave B (m-2): an answer that will not change is not waited on until the deadline.
    if (id.definite === true) throw new Error(`${unidentifiedHolder(pid, home, id.why, ctx.log)}. Do not start another daemon`);
    why = id.why;
    await sleep(DETACH_POLL_MS);
  } while (Date.now() < ctx.deadline);
  throw new Error(
    `another arena daemon (pid ${pid}) holds ${home} but ${why}: it may still be starting (a slow or rate-limited RPC) ` +
      `or be stuck, and it may already be watching your channels, so do not start another. Run "${ctx.command} channels" ` +
      `in a minute; if it still cannot reach the daemon, tell your human: pid ${pid}, its log ${ctx.log}`,
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
 * child (fix round 1, M1). Otherwise it waits up to `waitMs` until the child holds the lock and its API says so
 * (`identify`). Fix round 1 (I1): a child that holds the lock at the deadline is never stopped --
 * `ArenaDaemon.start()` arms its dispute timer before the chain reads that make a start slow, so it may already be
 * guarding a channel -- and is reported `healthy: false`. Only a child that exited (an error with the log's last
 * lines) or never took the lock (stopped by its own pid: SIGTERM, then SIGKILL) fails.
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

  // A home with port 0 (tests only) has no fixed API address: the child's own start line names the one it got.
  let started: { api: string } | undefined;
  while (pid !== undefined && exited === undefined && Date.now() < deadline) {
    started ??= startLineOf(logAfter(log, from), pid);
    const lock = readLockFile(home);
    const childApi = started?.api ?? api;
    if (lock?.pid === pid && childApi !== null && (await identify(home, childApi, lock, opts.fetch)).state === "confirmed") {
      return { detached: true, healthy: true, pid, api: childApi, log };
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
        `another. Run "${opts.command} channels" in a minute; next time, --timeout 100 waits longer`,
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

/**
 * H4 fix round 2 (N2): the channels a daemon must keep watching, by id -- every channel record of this home that is
 * not `finalized`, whatever its phase. Not `Open`/`Challenged` alone: in `None` our own deposit may be in flight, and in
 * `Funding` the hub opens the channel by itself on the opponent's deposit, which would then run with no watchtower; a
 * deposit past the funding deadline needs this daemon to reclaim it. `finalized` is set only once a channel is settled,
 * reclaimed, or retired with none of our money in it (`ArenaDaemon.markFinalized`), so a retired record, which keeps
 * `None` or `Funding` as its final phase, does not count. Final fix wave B (m-4): a record that cannot be read counts
 * (`unreadable`), as in init's RPC check -- it cannot be shown to be settled, and its funds may still be in a channel.
 */
export function liveChannelIds(home: string): string[] {
  return liveChannels(home).map((c) => c.channelId);
}

function liveChannels(home: string): Array<{ channelId: string; unreadable: boolean }> {
  return new RecordStore(home)
    .scanChannels()
    .filter((e) => e.record === null || e.record.finalized !== true)
    .map((e) => ({ channelId: e.channelId, unreadable: e.record === null }));
}

/**
 * H4 add-on (`arena daemon stop`), fix round 2 (N1, N3): stops this home's running `arena daemon`, and waits up to
 * `waitMs` until it has exited. The pid comes from `daemon.lock`, and is signalled (SIGTERM, the daemon's own clean
 * shutdown) only after the daemon's own API, asked with this home's token in this same call, said it is that pid and
 * holds that lock's nonce (`identify`) -- checked again right before the signal. A lock pid that does not answer is
 * never signalled, whatever it is: the error says to wait and retry, then tell the human; one that answers without an
 * identity, or a lock with no nonce, says to tell the human at once (m-2). Refuses while any channel record is not
 * finalized (`liveChannelIds`) unless `override`: with no daemon, nothing answers a challenge.
 */
export async function stopDaemon(
  home: string,
  opts: {
    fetch: typeof fetch;
    waitMs: number;
    command: string;
    override: boolean;
    warn(line: string): void;
    /** Test seam: how to see the process go (default: `/proc` where it exists, else `ps`). */
    processSource?: ProcessSource;
  },
): Promise<{ stopped: true; pid: number }> {
  const lock = readLockFile(home);
  if (lock === null || livePidHoldingLock(home) === null) throw new Error(`no arena daemon is running on ${home}: nothing to stop`);
  const { pid } = lock;
  const { config } = readConfig(home);
  const api = config.port !== 0 ? `http://127.0.0.1:${config.port}` : null;
  const log = join(home, "daemon.log");
  const check = async () => {
    const id = await identify(home, api, lock, opts.fetch);
    if (id.state === "other") throw new Error(`pid ${pid} holds ${home}, but ${id.why}: not signalling anything. Tell your human (pid ${pid}, log ${log})`);
    if (id.state === "silent" && id.definite === true) throw new Error(`${unidentifiedHolder(pid, home, id.why, log)}. Not signalling anything`);
    if (id.state === "silent") {
      throw new Error(
        `the daemon daemon.lock names (pid ${pid}) ${id.why}, so it is not signalled: it may still be starting, be stuck, ` +
          `or not be a daemon at all. Wait a minute and run "${opts.command} daemon stop" again; if it still does not ` +
          `answer, tell your human: pid ${pid}, its log ${log}`,
      );
    }
    if (id.role !== "daemon") {
      throw new Error(
        `pid ${pid} is "${opts.command} ${id.role}", not "${opts.command} daemon": not stopping it` +
          (id.role === "withdraw" ? " (a withdraw ends by itself in seconds)" : ""),
      );
    }
    return id;
  };
  const { degraded } = await check();
  const liveEntries = liveChannels(home);
  const live = liveEntries.map((c) => c.channelId);
  if (live.length > 0) {
    if (!opts.override) {
      // Final fix wave B (m-4): a channel no daemon watches -- degraded (its record or session would not load), or its
      // record unreadable -- cannot be settled with `close`: named apart, as the human's.
      const unwatched = liveEntries.filter((c) => c.unreadable || degraded.includes(c.channelId));
      const settleable = live.filter((id) => !unwatched.some((c) => c.channelId === id));
      const parts: string[] = [];
      if (settleable.length > 0) {
        parts.push(
          `channels are live (${settleable.join(", ")}: their records are not finalized): settle first (${opts.command} close ` +
            `--channel <id>, then wait for Finalized; a channel still being funded settles by itself at its funding deadline) ` +
            `or run the daemon elsewhere -- with no daemon, nothing answers a challenge before its deadline, and a channel ` +
            `being funded can open with nobody watching it. If one has only just settled, run "${opts.command} daemon stop" ` +
            `again in a minute`,
        );
      }
      if (unwatched.length > 0) {
        const what = unwatched.map((c) => `${c.channelId} (${c.unreadable ? "its record cannot be read" : "degraded"})`);
        parts.push(
          `channel(s) ${what.join(", ")} are not finalized and not watched by any daemon: close cannot settle them, so ` +
            "tell your human (they may still hold funds)",
        );
      }
      // m2: the override is the human's to give: it is named in the README, never in this message.
      throw new Error(`${parts.join(". ")}. Stopping it anyway is your human's decision, not yours`);
    }
    opts.warn(`note: stopping with ${live.length} live channel(s) (${live.join(", ")}): nothing answers a challenge until a daemon runs again`);
  }
  // Asked again right before the signal: the same process still holds the same lock and says so.
  const again = readLockFile(home);
  if (again === null || again.pid !== pid || again.nonce !== lock.nonce) {
    throw new Error(`daemon.lock changed while it was being checked: not signalling anything; run "${opts.command} daemon stop" again`);
  }
  await check();
  process.kill(pid, "SIGTERM");
  const deadline = Date.now() + opts.waitMs;
  while (processState(pid, opts.processSource) === "running") {
    if (Date.now() > deadline) {
      throw new Error(`the daemon (pid ${pid}) did not exit within ${Math.round(opts.waitMs / 1000)} s of SIGTERM; it may still be shutting down`);
    }
    await sleep(DETACH_POLL_MS);
  }
  return { stopped: true, pid };
}
