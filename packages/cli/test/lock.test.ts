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
    // Another live process: this test runner's parent.
    writeFileSync(join(home, "daemon.lock"), JSON.stringify({ pid: process.ppid, nonce: "ab".repeat(16) }), { mode: 0o600 });
    expect(livePidHoldingLock(home)).toBe(process.ppid);
    // A lock this process holds itself.
    const home2 = mkdtempSync(join(tmpdir(), "arena-lock-"));
    const l = acquireHomeLock(home2);
    expect(livePidHoldingLock(home2)).toBe(process.pid);
    l.release();
  });

  it("N-1: returns null for a lock naming this process's own pid that this process did not write", () => {
    const home = mkdtempSync(join(tmpdir(), "arena-lock-"));
    writeFileSync(join(home, "daemon.lock"), JSON.stringify({ pid: process.pid, nonce: "cd".repeat(16) }), { mode: 0o600 });
    expect(livePidHoldingLock(home)).toBeNull();
    writeFileSync(join(home, "daemon.lock"), JSON.stringify({ pid: process.pid }), { mode: 0o600 });
    expect(livePidHoldingLock(home)).toBeNull();
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

describe("N-1 (self-host re-review): a lock naming our own pid that we did not write", () => {
  it("is stale and taken over: a container restarted after an unclean kill reuses its pids", () => {
    const home = mkdtempSync(join(tmpdir(), "arena-lock-"));
    // What a killed daemon with this same pid leaves behind, with its own nonce.
    writeFileSync(join(home, "daemon.lock"), JSON.stringify({ pid: process.pid, nonce: "ef".repeat(16) }), { mode: 0o600 });
    const l = acquireHomeLock(home);
    expect(l.nonce).not.toBe("ef".repeat(16));
    expect(readLockFile(home)).toEqual({ pid: process.pid, nonce: l.nonce });
    // Ours now: a second acquisition in this process is still refused.
    expect(() => acquireHomeLock(home)).toThrow(/another arena daemon \(pid \d+\)/);
    l.release();
    expect(readLockFile(home)).toBeNull();
    expect(tempLockFiles(home)).toEqual([]);
  });

  it("is stale too when it has no nonce (written by an older CLI with our pid)", () => {
    const home = mkdtempSync(join(tmpdir(), "arena-lock-"));
    writeFileSync(join(home, "daemon.lock"), JSON.stringify({ pid: process.pid }), { mode: 0o600 });
    acquireHomeLock(home).release();
    expect(tempLockFiles(home)).toEqual([]);
  });

  it("another live pid stays held, whatever its nonce", () => {
    const home = mkdtempSync(join(tmpdir(), "arena-lock-"));
    writeFileSync(join(home, "daemon.lock"), JSON.stringify({ pid: process.ppid, nonce: "01".repeat(16) }), { mode: 0o600 });
    expect(() => acquireHomeLock(home)).toThrow(new RegExp(`another arena daemon \\(pid ${process.ppid}\\)`));
    expect(JSON.parse(readFileSync(join(home, "daemon.lock"), "utf8"))).toEqual({ pid: process.ppid, nonce: "01".repeat(16) });
  });

  it("release never removes a lock that names our pid but another acquisition's nonce", () => {
    const home = mkdtempSync(join(tmpdir(), "arena-lock-"));
    const l = acquireHomeLock(home);
    const other = { pid: process.pid, nonce: "23".repeat(16) };
    writeFileSync(join(home, "daemon.lock"), JSON.stringify(other), { mode: 0o600 });
    l.release();
    expect(JSON.parse(readFileSync(join(home, "daemon.lock"), "utf8"))).toEqual(other);
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
