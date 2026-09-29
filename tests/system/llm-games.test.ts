/**
 * Plan 4.5 Task 12 review (fix round): unit tests for `llm-games.ts`'s argument and environment builders. These
 * are pure functions precisely so they can be tested here without spawning a stack or a `claude` process --
 * importing `llm-games.ts` itself must not start anything (see its own guard around `main()`).
 */
import { describe, expect, it } from "vitest";
import { buildAllowedTools, buildClaudeEnv, parseArgs } from "./llm-games.js";

describe("buildAllowedTools", () => {
  const rules = buildAllowedTools("http://127.0.0.1:45431");

  it("never includes a cat rule", () => {
    expect(rules.some((r) => /\bcat\b/.test(r))).toBe(false);
  });

  it("never includes a bare, unpinned curl rule", () => {
    expect(rules).not.toContain("Bash(curl *)");
    expect(rules.some((r) => r === "Bash(curl *)" || /^Bash\(curl\s+\*\)$/.test(r))).toBe(false);
  });

  it("pins every curl rule to the exact server origin, whatever flags precede it", () => {
    const curlRules = rules.filter((r) => r.includes("curl"));
    expect(curlRules.length).toBeGreaterThan(0);
    // Bash allow rules are prefix matches: strip "Bash(curl", any flag tokens (leading "-"), and the rule must
    // then start with exactly this server's origin followed by "/" -- never a different host, never a bare "*".
    for (const r of curlRules) {
      const inner = r.replace(/^Bash\(curl\s*/, "").replace(/\)$/, "");
      const afterFlags = inner
        .split(/\s+/)
        .filter((tok) => tok.length > 0 && !tok.startsWith("-"))
        .join(" ");
      expect(afterFlags.startsWith("http://127.0.0.1:45431/")).toBe(true);
    }
  });

  it("includes the arena rule and nothing else beyond arena/curl", () => {
    expect(rules).toContain("Bash(arena *)");
    for (const r of rules) {
      expect(r.startsWith("Bash(arena ") || r.startsWith("Bash(curl ")).toBe(true);
    }
  });

  it("re-pins to a different port for a different server URL (no hardcoded port)", () => {
    const other = buildAllowedTools("http://127.0.0.1:9999");
    expect(other.some((r) => r.includes(":9999/"))).toBe(true);
    expect(other.some((r) => r.includes(":45431/"))).toBe(false);
  });
});

describe("buildClaudeEnv", () => {
  const realHome = process.env.HOME;

  it("returns exactly the allowlisted env keys -- PATH, HOME, ARENA_HOME -- nothing else", () => {
    const env = buildClaudeEnv("/tmp/some-arena-home", "/tmp/some-bin-dir");
    expect(Object.keys(env).sort()).toEqual(["ARENA_HOME", "HOME", "PATH"]);
  });

  it("puts binDir first on PATH and preserves the rest of the orchestrator's PATH", () => {
    const env = buildClaudeEnv("/tmp/some-arena-home", "/tmp/some-bin-dir");
    expect(String(env.PATH)).toMatch(/^\/tmp\/some-bin-dir:/);
  });

  it("sets ARENA_HOME to exactly the given path", () => {
    const env = buildClaudeEnv("/tmp/some-arena-home", "/tmp/some-bin-dir");
    expect(env.ARENA_HOME).toBe("/tmp/some-arena-home");
  });

  it("throws rather than silently omitting HOME when it is unset", () => {
    delete process.env.HOME;
    try {
      expect(() => buildClaudeEnv("/tmp/some-arena-home", "/tmp/some-bin-dir")).toThrow(/HOME/);
    } finally {
      if (realHome !== undefined) process.env.HOME = realHome;
    }
  });
});

describe("parseArgs", () => {
  it("defaults games=2, minutes=30, agents=2, no model", () => {
    expect(parseArgs([])).toEqual({ agents: 2, games: 2, minutes: 30, model: undefined });
  });

  it("rejects --agents other than 2", () => {
    expect(() => parseArgs(["--agents", "3"])).toThrow(/--agents only supports 2/);
  });

  it("parses --games, --minutes and --model", () => {
    expect(parseArgs(["--games", "5", "--minutes", "10", "--model", "sonnet"])).toEqual({
      agents: 2,
      games: 5,
      minutes: 10,
      model: "sonnet",
    });
  });
});
