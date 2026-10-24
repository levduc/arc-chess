import { spawn } from "node:child_process";
import { closeSync, fstatSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readConfig } from "./config.js";
import { livePidHoldingLock } from "./lock.js";

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
