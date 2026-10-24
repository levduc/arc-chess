import { randomBytes } from "node:crypto";
import { closeSync, linkSync, openSync, readFileSync, renameSync, rmSync, unlinkSync, writeSync } from "node:fs";
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

/** True when a lock file naming `pid` is stale: unreadable/no pid, or a dead process that isn't us. */
function isStale(pid: number | null): boolean {
  return pid === null || (pid !== process.pid && !alive(pid));
}

/** Writes `{pid, nonce}` to a fresh, unique 0600 file under `home` and returns its path -- the source side of the
 *  atomic `linkSync` in `acquireHomeLock`: a hard link either succeeds once, atomically, or fails EEXIST, which a
 *  plain write-then-rename onto the lock path itself would not give us against a concurrent stale-takeover. */
function writePidFile(home: string, pid: number, nonce: string): string {
  const tmp = join(home, `.daemon.lock.${pid}.${randomBytes(6).toString("hex")}.tmp`);
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeSync(fd, JSON.stringify({ pid, nonce }));
  } finally {
    closeSync(fd);
  }
  return tmp;
}

/**
 * H4 fix round 2 (N1, N3): `daemon.lock` as written: its `pid`, and the random `nonce` this acquisition wrote (absent in
 * a lock written by an older CLI). Null when the lock is missing, unreadable or holds no well-formed pid. The running
 * daemon reports the same nonce from its authenticated `/health` (`api.ts`), which is how `daemon stop` and `daemon
 * --detach` tell the lock's writer from a process that merely has its pid -- with no clock involved.
 */
export function readLockFile(home: string): { pid: number; nonce?: string } | null {
  try {
    const raw = JSON.parse(readFileSync(join(home, "daemon.lock"), "utf8")) as { pid?: unknown; nonce?: unknown };
    if (typeof raw.pid !== "number") return null;
    return typeof raw.nonce === "string" ? { pid: raw.pid, nonce: raw.nonce } : { pid: raw.pid };
  } catch {
    return null;
  }
}

/** The pid currently holding `<home>/daemon.lock`, only if it is genuinely alive (not stale) -- a read-only
 *  check, never a take-over. Used by `arena init` to refuse re-pointing a home a live daemon still holds
 *  (final review I4): acquiring and taking over a stale lock stays `acquireHomeLock`'s job, for `daemon`/`bot`
 *  to do when one of them actually starts. */
export function livePidHoldingLock(home: string): number | null {
  const pid = readPid(join(home, "daemon.lock"));
  return pid !== null && alive(pid) ? pid : null;
}

/**
 * Spec §6: one daemon per ARENA_HOME. A lock file (`daemon.lock`) holds the owner's pid; a lock whose pid is our
 * own or belongs to a live process is held (throws); a lock whose pid is missing, unreadable, or belongs to a
 * dead process is stale and is taken over.
 *
 * Atomicity: this process never writes `daemon.lock` directly. It writes its pid to a private temp file, then
 * `linkSync`s that onto `daemon.lock` -- a hard link is created atomically, so two processes racing to acquire
 * the same fresh lock can never both succeed. On EEXIST (someone already holds it, live or stale), the existing
 * file is moved aside atomically (`renameSync` to a unique name) before being inspected, so no other process can
 * ever observe two lock files, or a lock file with mixed/torn content, at `daemon.lock`. If the moved-aside copy
 * turns out to be live after all (a very tight race), it is relinked back before the "held" error is thrown; if
 * even that fails (someone else has since relinked `daemon.lock`), this reports ambiguous contention instead of
 * guessing.
 */
export function acquireHomeLock(home: string): { release(): void; nonce: string } {
  const path = join(home, "daemon.lock");
  // H4 fix round 2: one per acquisition, so a later daemon with the same pid (a pid reuse) never matches it.
  const nonce = randomBytes(16).toString("hex");
  for (let attempt = 0; attempt < 2; attempt++) {
    const tmp = writePidFile(home, process.pid, nonce);
    try {
      linkSync(tmp, path);
    } catch (err) {
      unlinkSync(tmp); // this side's private temp file is never left behind, win or lose
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;

      // Read the current holder *before* touching anything. A lock held by a live process (ours or someone
      // else's) is refused right here, with no rename -- moving a live holder's lock aside, even briefly, would
      // open a window for a third acquirer to slip in and land two "holders". Only a lock that already reads as
      // stale is moved aside for the take-over below.
      const pidBefore = readPid(path);
      if (!isStale(pidBefore)) throw new Error(`another arena daemon (pid ${pidBefore}) is using ${home}`);

      const staleName = join(home, `.daemon.lock.stale.${process.pid}.${randomBytes(6).toString("hex")}`);
      try {
        renameSync(path, staleName);
      } catch (renameErr) {
        if ((renameErr as NodeJS.ErrnoException).code === "ENOENT") continue; // it's gone already: retry the link
        throw renameErr;
      }

      // Confirm the moved-aside copy is still the same stale entry we just read (same dead pid, or still
      // unreadable) -- not a live lock that a racing process wrote to `path` in the gap between our read above
      // and this rename.
      const pidAfter = readPid(staleName);
      if (pidAfter === null || pidAfter === pidBefore) {
        rmSync(staleName, { force: true }); // confirmed stale: take it over
        continue;
      }

      // It changed under us: put the moved-aside entry back if nothing has re-claimed `path` in the meantime.
      let restored = false;
      try {
        linkSync(staleName, path);
        restored = true;
      } catch {
        restored = false;
      }
      if (restored) {
        unlinkSync(staleName);
        throw new Error(`another arena daemon (pid ${pidAfter}) is using ${home}`);
      }
      // `path` was retaken by someone else between our rename and our attempt to restore it: we can no longer
      // vouch for who holds it now, so this is ambiguous contention rather than a specific pid.
      rmSync(staleName, { force: true });
      throw new Error(`lock contention on ${home}`);
    }
    unlinkSync(tmp); // the hard link now at `path` is unaffected by removing this second name to it
    let released = false;
    return {
      nonce,
      release: () => {
        if (released) return;
        released = true;
        // Only remove the lock file if it still names this process -- never delete a lock some other process
        // (a faster racer, or a later daemon after a stale takeover elsewhere) now legitimately owns.
        if (readPid(path) === process.pid) rmSync(path, { force: true });
      },
    };
  }
  throw new Error(`could not lock ${home}`);
}
