/**
 * T5 review I-1 and I-2: the two safety helpers of `scripts/arc-rehearsal.ts` (in `scripts/arc-rehearsal-lib.ts`,
 * which has no side effects on import). No chain, no network: the env builder on synthetic environments, and the pid
 * matching on a real short-lived child process.
 */
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { childEnv, isOurs, procStartTime } from "../../scripts/arc-rehearsal-lib.js";

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
