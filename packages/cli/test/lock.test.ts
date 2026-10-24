import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { acquireHomeLock, livePidHoldingLock, readLockFile } from "../src/lock.js";

/** Neither a successful acquire nor a failed/stale one leaves any of its private temp files behind. */
function tempLockFiles(home: string): string[] {
  return readdirSync(home).filter((f) => f.startsWith(".daemon.lock"));
}

describe("acquireHomeLock", () => {
  it("a second lock on the same home fails while the first is held, and succeeds after release", () => {
    const home = mkdtempSync(join(tmpdir(), "arena-lock-"));
    const l1 = acquireHomeLock(home);
    expect(() => acquireHomeLock(home)).toThrow(/another arena daemon \(pid \d+\)/);
    l1.release();
    acquireHomeLock(home).release();
    expect(tempLockFiles(home)).toEqual([]);
  });

  it("takes over a stale lock left by a dead process", () => {
    const home = mkdtempSync(join(tmpdir(), "arena-lock-"));
    writeFileSync(join(home, "daemon.lock"), JSON.stringify({ pid: 2 ** 22 + 12345 }), { mode: 0o600 });
    acquireHomeLock(home).release();
    expect(tempLockFiles(home)).toEqual([]);
  });

  it("treats an unreadable lock file as stale", () => {
    const home = mkdtempSync(join(tmpdir(), "arena-lock-"));
    writeFileSync(join(home, "daemon.lock"), "not valid json {{{", { mode: 0o600 });
    acquireHomeLock(home).release();
  });

  it("release is idempotent", () => {
    const home = mkdtempSync(join(tmpdir(), "arena-lock-"));
    const l = acquireHomeLock(home);
    l.release();
    expect(() => l.release()).not.toThrow();
    acquireHomeLock(home).release(); // the home is free again
  });

  it("two acquires against a stale lock leave exactly one holder", () => {
    const home = mkdtempSync(join(tmpdir(), "arena-lock-"));
    const deadPid = 2 ** 22 + 12345;
    writeFileSync(join(home, "daemon.lock"), JSON.stringify({ pid: deadPid }), { mode: 0o600 });
    // The first call takes over the stale lock (now legitimately holding it under our own pid); a second call
    // right behind it must not also succeed -- it finds our own live pid there and is refused.
    const l1 = acquireHomeLock(home);
    expect(() => acquireHomeLock(home)).toThrow(/another arena daemon \(pid \d+\)/);
    l1.release();
    acquireHomeLock(home).release(); // the home is free again
    expect(tempLockFiles(home)).toEqual([]);
  });

  it("release does not delete a lock now owned by another pid", () => {
    const home = mkdtempSync(join(tmpdir(), "arena-lock-"));
    const l = acquireHomeLock(home);
    const lockPath = join(home, "daemon.lock");
    // Simulate the lock having been taken over by someone else's pid in between (e.g. this process lost a race
    // for a stale lock elsewhere, or a later daemon started against the same home after this one crashed
    // without releasing) -- release() must check ownership before ever deleting the file.
    const otherPid = process.pid + 1;
    writeFileSync(lockPath, JSON.stringify({ pid: otherPid }), { mode: 0o600 });
    l.release();
    expect(JSON.parse(readFileSync(lockPath, "utf8"))).toEqual({ pid: otherPid });
  });
});

describe("livePidHoldingLock", () => {
  it("returns null when there is no lock file at all", () => {
    const home = mkdtempSync(join(tmpdir(), "arena-lock-"));
    expect(livePidHoldingLock(home)).toBeNull();
  });

  it("returns the pid when the lock names a genuinely live process", () => {
    const home = mkdtempSync(join(tmpdir(), "arena-lock-"));
    writeFileSync(join(home, "daemon.lock"), JSON.stringify({ pid: process.pid }), { mode: 0o600 });
    expect(livePidHoldingLock(home)).toBe(process.pid);
  });

  it("returns null for a stale lock (dead pid) -- never a take-over, just not a block", () => {
    const home = mkdtempSync(join(tmpdir(), "arena-lock-"));
    writeFileSync(join(home, "daemon.lock"), JSON.stringify({ pid: 2 ** 22 + 12345 }), { mode: 0o600 });
    expect(livePidHoldingLock(home)).toBeNull();
    // Confirms it really left the lock alone, unlike acquireHomeLock.
    expect(JSON.parse(readFileSync(join(home, "daemon.lock"), "utf8"))).toEqual({ pid: 2 ** 22 + 12345 });
  });

  it("returns null for an unreadable lock file", () => {
    const home = mkdtempSync(join(tmpdir(), "arena-lock-"));
    writeFileSync(join(home, "daemon.lock"), "not valid json {{{", { mode: 0o600 });
    expect(livePidHoldingLock(home)).toBeNull();
  });
});

describe("H4 fix round 2: the lock's per-acquisition nonce", () => {
  it("acquireHomeLock writes {pid, nonce}, a fresh 32-hex nonce each time; readLockFile reads it, and an older {pid} lock too", () => {
    const home = mkdtempSync(join(tmpdir(), "arena-lock-"));
    const l1 = acquireHomeLock(home);
    expect(l1.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(JSON.parse(readFileSync(join(home, "daemon.lock"), "utf8"))).toEqual({ pid: process.pid, nonce: l1.nonce });
    expect(readLockFile(home)).toEqual({ pid: process.pid, nonce: l1.nonce });
    l1.release();
    expect(readLockFile(home)).toBeNull();
    const l2 = acquireHomeLock(home);
    expect(l2.nonce).not.toBe(l1.nonce);
    l2.release();
    writeFileSync(join(home, "daemon.lock"), JSON.stringify({ pid: 4242 }), { mode: 0o600 });
    expect(readLockFile(home)).toEqual({ pid: 4242 });
    writeFileSync(join(home, "daemon.lock"), "not json", { mode: 0o600 });
    expect(readLockFile(home)).toBeNull();
  });
});
