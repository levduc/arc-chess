import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { acquireHomeLock } from "../src/lock.js";

describe("acquireHomeLock", () => {
  it("a second lock on the same home fails while the first is held, and succeeds after release", () => {
    const home = mkdtempSync(join(tmpdir(), "arena-lock-"));
    const l1 = acquireHomeLock(home);
    expect(() => acquireHomeLock(home)).toThrow(/another arena daemon \(pid \d+\)/);
    l1.release();
    acquireHomeLock(home).release();
  });

  it("takes over a stale lock left by a dead process", () => {
    const home = mkdtempSync(join(tmpdir(), "arena-lock-"));
    writeFileSync(join(home, "daemon.lock"), JSON.stringify({ pid: 2 ** 22 + 12345 }), { mode: 0o600 });
    acquireHomeLock(home).release();
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
});
