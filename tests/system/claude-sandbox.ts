/**
 * Plan 5.5 Task 2: the sandbox builders shared by every script that launches a headless `claude -p` session
 * against a local Agent Chess Arena server -- `tests/system/llm-games.ts` (two agents playing each other) and
 * `scripts/claude-opponent.ts` (one agent playing against the house bots). Extracted here, rather than copied,
 * so both stay in lockstep: the same narrow Bash allowlist, the same minimal environment, the same tmp-root
 * shape.
 *
 * Node built-ins only (no `@arena/*`, no `viem`, no test-framework imports): `scripts/claude-opponent.ts` is a
 * plain root-level script, outside every workspace package's own `tsconfig`/`node_modules` layout, and imports
 * this file directly across that boundary.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// -------------------------------------------------------------------------------------------------- allowed tools

/** The handful of flag prefixes real curl invocations are likely to use before the URL -- not because the flags
 *  themselves matter (they don't: every variant below is still hard-pinned to the same origin, so none of them
 *  widens what host can be reached), but because Claude Code's Bash allow rules are plain command-*prefix* matches
 *  (confirmed by hand: a rule's text before its wildcard must be a literal prefix of the real command, so
 *  `Bash(curl <origin>/*)` does NOT match `curl -s <origin>/...` -- the `-s` breaks the prefix). `""` and `"-s"`
 *  were the only two shapes either agent actually typed across Runs 1-2 of `llm-games` (`grep`ped from their
 *  logs); the rest are defensive headroom against a session picking a different common combination, since a
 *  rule-syntax miss here can only be diagnosed by spending real agent usage.
 */
const CURL_FLAG_PREFIXES = ["", "-s", "-sS", "-sL", "-sSL", "-fsSL", "-L"];

/** The exact `--allowedTools` patterns for one session, as a pure function of the server's URL so it can be unit
 *  tested without spawning anything. Deliberately minimal:
 *  - `Bash(arena *)` -- the CLI, via a wrapper on PATH (`buildClaudeEnv`'s `binDir`).
 *  - `Bash(curl <flags> <origin>/*)` for each of `CURL_FLAG_PREFIXES`, pinned to this stack's own server origin --
 *    never a bare `Bash(curl *)`. Confirmed by hand that this pin actually restricts the origin, not just the
 *    flags: the same rule denies `curl -s http://example.com/`.
 *  - No `Bash(cat *)` (too wide -- nothing in the play loop needs it) and no Write/Edit/Read at all.
 *  `--permission-prompts none` means anything outside this list is denied automatically rather than hanging on a
 *  prompt nobody can answer.
 */
export function buildAllowedTools(serverUrl: string): string[] {
  const origin = new URL(serverUrl).origin;
  return ["Bash(arena *)", ...CURL_FLAG_PREFIXES.map((flags) => `Bash(curl ${flags ? `${flags} ` : ""}${origin}/*)`)];
}

// --------------------------------------------------------------------------------------------------------- env

/** The exact environment for one session, as a pure function so it can be unit tested without spawning anything.
 *  The orchestrator's *entire* environment must not be forwarded into the agent's sandbox. Empirically confirmed
 *  by hand (`env -i HOME=... PATH=... claude -p ...`, every other variable cleared) that `claude -p` needs
 *  nothing beyond `PATH` (to resolve `node`/`sh`/`curl`/the `arena` wrapper) and `HOME` (its on-disk auth/config
 *  live under `~/.claude`; `apiKeySource` was `"none"` in every smoke test here, so no `ANTHROPIC_API_KEY` or
 *  similar is required) to run and authenticate -- `ARENA_HOME` is the one variable the `arena` CLI itself needs,
 *  not `claude`. This is the complete env; nothing else from the orchestrator's process leaks into the agent's
 *  sandbox. Throws rather than silently omitting `HOME` if it's unset in this process, since a session that can't
 *  authenticate is a much worse failure mode than a fast, clear error here. */
export function buildClaudeEnv(arenaHome: string, binDir: string): NodeJS.ProcessEnv {
  const home = process.env.HOME;
  if (!home) throw new Error("HOME is not set in this process's environment -- required for the claude CLI's auth/config");
  return { PATH: `${binDir}:${process.env.PATH ?? ""}`, HOME: home, ARENA_HOME: arenaHome };
}

// ------------------------------------------------------------------------------------------------------- tmp root

/** Creates `home` and `workDir` as siblings under `root` (which the caller owns -- a fresh mkdtemp root for
 *  `llm-games.ts`, or a fixed `.arena-dev/claude-opponent-<ts>` path for `claude-opponent.ts`). `home` is this
 *  agent's own `ARENA_HOME`; `workDir` is the directory the `claude -p` process is spawned with as its cwd, kept
 *  separate so the agent's shell commands never run rooted at its own ARENA_HOME. */
export function agentHomeAndWorkDir(root: string): { home: string; workDir: string } {
  const home = join(root, "home");
  const workDir = join(root, "work");
  mkdirSync(home, { recursive: true });
  mkdirSync(workDir, { recursive: true });
  return { home, workDir };
}

/** `agentHomeAndWorkDir`, under a fresh, unpredictable tmp root (`mkdtempSync(tmpdir(), prefix)`) -- the shape
 *  every per-agent tmp directory `llm-games.ts` creates for itself uses. Deliberately *not* named after the
 *  agent (e.g. no "-alice-"/"-bob-" in the path) when more than one of these share a run: a fixed, predictable
 *  naming scheme would let one agent's own path tell it exactly how to construct the other's, glob or not. */
export function makeTmpAgentRoot(prefix: string): { root: string; home: string; workDir: string } {
  const root = mkdtempSync(join(tmpdir(), prefix));
  return { root, ...agentHomeAndWorkDir(root) };
}

// -------------------------------------------------------------------------------------------------------- cost

/** The session's total cost, from the last `total_cost_usd` seen in a `claude -p --output-format stream-json`
 *  log. Each `result` event's `total_cost_usd` is already cumulative for the whole session (confirmed against a
 *  two-turn smoke test: the second result's usage was the sum of both turns) -- so this takes the *last* value,
 *  never sums across events, which would double- (or N-)count. */
export function extractCost(logPath: string): number | undefined {
  if (!existsSync(logPath)) return undefined;
  let last: number | undefined;
  for (const line of readFileSync(logPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const obj = JSON.parse(trimmed) as { total_cost_usd?: number };
      if (typeof obj.total_cost_usd === "number") last = obj.total_cost_usd;
    } catch {
      // not a complete JSON line -- skip
    }
  }
  return last;
}
