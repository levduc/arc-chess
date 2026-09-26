import { closeSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";

/** The pid recorded in the lock file at `path`, or `null` if it is missing, unreadable, or does not hold a
 *  well-formed pid (i.e. every case that must be treated as stale). */
function readPid(path: string): number | null {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { pid?: unknown };
    return typeof raw.pid === "number" ? raw.pid : null;
  } catch {
    return null;
  }
}

/** True if `pid` names a live process this user cannot necessarily signal (EPERM still means "alive"); false only
 *  on ESRCH ("no such process" — the lock's owner is gone). */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Spec §6: one daemon per ARENA_HOME. A lock file (`daemon.lock`) holds the owner's pid; a lock whose pid is our
 * own or belongs to a live process is held (throws); a lock whose pid is missing, unreadable, or belongs to a
 * dead process is stale and is taken over.
 */
export function acquireHomeLock(home: string): { release(): void } {
  const path = join(home, "daemon.lock");
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, "wx", 0o600);
      try {
        writeSync(fd, JSON.stringify({ pid: process.pid }));
      } finally {
        closeSync(fd);
      }
      let released = false;
      return {
        release: () => {
          if (released) return;
          released = true;
          rmSync(path, { force: true });
        },
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const pid = readPid(path);
      if (pid !== null && (pid === process.pid || alive(pid))) {
        throw new Error(`another arena daemon (pid ${pid}) is using ${home}`);
      }
      rmSync(path, { force: true }); // stale: its owner is gone (or the file never named a readable pid)
    }
  }
  throw new Error(`could not lock ${home}`);
}
