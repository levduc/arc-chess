/**
 * T5 review I-1 and I-2: the two safety helpers of `scripts/arc-rehearsal.ts` (in `scripts/arc-rehearsal-lib.ts`,
 * which has no side effects on import). No chain, no network: the env builder on synthetic environments, and the pid
 * matching on a real short-lived child process. Final review C: the checkout probe's environment, and the run's
 * block window for the explorer's listing.
 */
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkoutNow, childEnv, isOurs, procStartTime, sentInRange, type ListedTx } from "../../scripts/arc-rehearsal-lib.js";

const REPO_ROOT = join(import.meta.dirname, "../..");

/** A synthetic 32-byte hex string shaped like a private key. Not a key anyone holds. */
const KEY_SHAPED = `0x${"11".repeat(32)}`;

describe("arc-rehearsal childEnv: children get an allowlist, never the parent's whole environment (I-1)", () => {
  it("keeps the allowlisted variables and NODE_*, and drops everything else", () => {
    const env = childEnv({
      PATH: "/usr/bin",
      LANG: "C.UTF-8",
      TMPDIR: "/tmp/x",
      HTTPS_PROXY: "http://proxy:3128",
      NODE_OPTIONS: "--max-old-space-size=2048",
      ARENA_DEPLOYER_KEY: KEY_SHAPED,
      PRIVATE_KEY: KEY_SHAPED,
      AWS_SECRET_ACCESS_KEY: "abc",
      GITHUB_TOKEN: "ghp_x",
      HOME: "/home/someone",
      ARENA_HOME: "/home/someone/.arena",
      SOMETHING_ELSE: "1",
    });
    expect(env).toEqual({
      PATH: "/usr/bin",
      LANG: "C.UTF-8",
      TMPDIR: "/tmp/x",
      HTTPS_PROXY: "http://proxy:3128",
      NODE_OPTIONS: "--max-old-space-size=2048",
    });
  });

  it("drops a secret-looking name even under NODE_*, and a key-shaped value under any name", () => {
    const env = childEnv({ NODE_AUTH_TOKEN: "npm_x", NODE_EXTRA_CA_CERTS: "/etc/ca.pem", TZ: KEY_SHAPED, LC_ALL: ` ${KEY_SHAPED.slice(2)} ` });
    expect(env).toEqual({ NODE_EXTRA_CA_CERTS: "/etc/ca.pem" });
  });

  it("adds what the child needs on top, and an undefined in `set` removes a variable", () => {
    const env = childEnv({ PATH: "/usr/bin", TZ: "UTC" }, { HOME: "/run/fake", ARENA_HOME: "/run/fake/alice", npm_config_cache: "/c", TZ: undefined });
    expect(env).toEqual({ PATH: "/usr/bin", HOME: "/run/fake", ARENA_HOME: "/run/fake/alice", npm_config_cache: "/c" });
    expect(childEnv({ PATH: "/usr/bin" }, { ARENA_HOME: undefined })).toEqual({ PATH: "/usr/bin" });
  });
});

describe("arc-rehearsal isOurs: a recorded pid is signalled only while it is the same process (I-2)", () => {
  it("matches pid + start time + command line, and nothing else; never a bare pid; never after exit", async () => {
    const marker = `arc-rehearsal-test-${process.pid}-${Date.now()}`;
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)", marker], { stdio: "ignore" });
    try {
      const pid = child.pid!;
      let startTime: string | null = null;
      for (let i = 0; i < 40 && startTime === null; i++) {
        startTime = procStartTime(pid);
        if (startTime === null) await new Promise((r) => setTimeout(r, 25));
      }
      expect(startTime).not.toBeNull();
      const entry = { pid, startTime: startTime! };
      expect(isOurs(entry, [process.execPath, marker])).toBe(true);
      expect(isOurs({ pid, startTime: `${startTime}0` }, [marker])).toBe(false); // another process at a reused pid
      expect(isOurs(entry, [marker, "not-in-its-command-line"])).toBe(false);
      expect(isOurs(pid, [marker])).toBe(false); // a state.json from before the check: never signalled
      expect(isOurs(undefined, [marker])).toBe(false);
      expect(isOurs({ pid: 1, startTime: procStartTime(1) ?? "0" }, [])).toBe(false); // never init
      const exited = new Promise((r) => child.once("exit", r));
      child.kill("SIGKILL");
      await exited;
      expect(isOurs(entry, [marker])).toBe(false);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  });
});

describe("arc-rehearsal checkoutNow: git runs with the allowlisted environment (t5-rereview)", () => {
  it("names this checkout's HEAD, with an allowlisted environment that has no HOME", () => {
    const head = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).stdout.trim();
    expect(head).toMatch(/^[0-9a-f]{7,}$/);
    expect(checkoutNow(REPO_ROOT, childEnv({ PATH: process.env.PATH ?? "" })).startsWith(head)).toBe(true);
  });

  it("passes only the environment it is given: git sees that, not this process's", () => {
    const bin = mkdtempSync(join(tmpdir(), "arena-fake-git-"));
    try {
      // A stand-in git that answers rev-parse with what it sees of two variables, and status with nothing.
      writeFileSync(join(bin, "git"), '#!/bin/sh\nif [ "$1" = rev-parse ]; then echo "mark=${MARK:-unset} inherited=${FW_C_PARENT_ONLY:-unset}"; fi\n');
      chmodSync(join(bin, "git"), 0o755);
      process.env.FW_C_PARENT_ONLY = "leaked";
      expect(checkoutNow(REPO_ROOT, { PATH: `${bin}:/usr/bin:/bin`, MARK: "given" })).toBe("mark=given inherited=unset");
    } finally {
      delete process.env.FW_C_PARENT_ONLY;
      rmSync(bin, { recursive: true, force: true });
    }
  });
});

describe("arc-rehearsal sentInRange: --collect-only counts the run's own window only (final review C m-12)", () => {
  const ME = "0x840d6f90dd12A713CC5F1fb6EAbBF99e0E74A7E0";
  const tx = (n: number, block: number, from = ME, key: "block_number" | "block" = "block_number"): ListedTx => ({
    hash: `0x${n.toString(16).padStart(64, "0")}`,
    [key]: block,
    from: { hash: from.toLowerCase() },
  });
  it("keeps what the address sent from the start block to the end block, both included", () => {
    const items = [tx(1, 99), tx(2, 100), tx(3, 150, ME, "block"), tx(4, 200), tx(5, 201), tx(6, 150, "0x" + "22".repeat(20))];
    expect(sentInRange(items, ME, 100n, 200n)).toEqual([items[1]!.hash, items[2]!.hash, items[3]!.hash]);
  });
  it("drops a later send by the same key (another stack paying from the deployer after the run)", () => {
    expect(sentInRange([tx(1, 300)], ME, 100n, 200n)).toEqual([]);
  });
});
