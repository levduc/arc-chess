#!/usr/bin/env node
/**
 * Plan 5.5 Task 2: `pnpm dev:claude-opponent [--server http://127.0.0.1:8080] [--games 3] [--stake 1]
 *   [--model ID] [--minutes 30] [--cli PATH]`
 *
 * Launches ONE headless `claude -p` session as an optional, real opponent against whatever is already available
 * on a dev stack -- house bots (`arena bot`, see packages/cli/src/bot.ts), another agent, or a human. Unlike
 * `tests/system/llm-games.ts` (two scripted agents playing each other, used for the automated pass criterion),
 * this never starts its own stack: it expects `pnpm dev:up` (or equivalent) to already be serving `--server`.
 *
 * It deliberately does NOT run `arena init` for this agent. Its `ARENA_HOME` is fresh and empty; the agent must
 * read `<server>/skill.md` and onboard itself (init, fund, find an opponent, play) exactly like a real first-time
 * user's agent would -- that self-onboarding is the whole point of this plan.
 *
 * Reuses the same sandbox builders as `tests/system/llm-games.ts` (`tests/system/claude-sandbox.ts`): a narrow
 * `--allowedTools` list (the `arena` CLI, plus `curl` pinned to `--server`'s origin) and a minimal environment.
 * The allowed tools must include running the `cliCommand` wrapper the server advertises -- `<dir>/bin/arena`,
 * written by `dev:up` (Plan 5.5 Task 3, `writeArenaWrapper` in `tests/system/claude-sandbox.ts`, shared with
 * `dev-up.ts`) and set as the server's `cliCommand`, so `skill.md` shows this exact path. `--cli` accepts an
 * explicit path too, defaulting to `<repo>/.arena-dev/bin/arena` (the default `--dir`'s wrapper).
 *
 * This spends real Claude usage -- never run it as part of a test or CI. Tests that touch this file must verify
 * only `--help`/argument parsing (see the Plan 5.5 Task 2 report); `main()` only runs when this file is executed
 * directly, exactly like `llm-games.ts`'s own guard.
 */
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { agentHomeAndWorkDir, buildAllowedTools, buildClaudeEnv, extractCost } from "../tests/system/claude-sandbox.js";

const REPO_ROOT = join(import.meta.dirname, "..");
const DEV_DIR = join(REPO_ROOT, ".arena-dev");
const CLAUDE_BIN = join(process.env.HOME ?? "", ".local/bin/claude");

/** True if `pid` is alive and its command line looks like an `arena` daemon (packages/cli/bin/arena.mjs, run
 *  directly or through the wrapper) -- a cheap, best-effort /proc check (Linux only) before M7's cleanup
 *  SIGTERMs a pid `daemon.lock` once named. Any error (no /proc, pid gone, unreadable cmdline) reads as "not
 *  it": the only consequence of a false negative here is leaving a daemon running, no worse than before this
 *  existed, which is strictly better than SIGTERMing an unrelated process that happens to reuse an old pid. */
function looksLikeArenaDaemon(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").includes("arena");
  } catch {
    return false;
  }
}

const USAGE = `usage: pnpm dev:claude-opponent [--server http://127.0.0.1:8080] [--games 3] [--stake 1] [--model ID] [--minutes 30] [--cli PATH]

Launches a headless Claude Code session as an optional opponent: a real agent that onboards itself from
<server>/skill.md (it is never pre-initialized here), finds someone to play in the lobby -- a house bot, another
agent, or a human -- and plays. Spends real Claude usage: run it deliberately, after "pnpm dev:up" (or
equivalent) is already serving --server.

  --server   the host server's URL (default http://127.0.0.1:8080)
  --games    how many games to ask the agent to play (default 3)
  --stake    the USDC stake per game, for the prompt only (default 1)
  --model    passed through to "claude -p --model" (default: claude's own default)
  --minutes  wall-clock budget; the session is stopped once it elapses (default 30)
  --cli      path to the "arena" CLI wrapper this agent's Bash tool is allowed to run
             (default <repo>/.arena-dev/bin/arena -- the wrapper "pnpm dev:up" writes)
`;

export type Args = { server: string; games: number; stake: string; model?: string; minutes: number; cli: string };

export function parseArgs(argv: string[]): Args {
  const str = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : undefined;
  };
  const positiveNum = (name: string, def: number): number => {
    const v = str(name);
    if (v === undefined) return def;
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`--${name} must be a positive number`);
    return n;
  };
  const stake = str("stake") ?? "1";
  if (!/^[0-9]+(\.[0-9]+)?$/.test(stake)) throw new Error("--stake must be a non-negative decimal amount");
  return {
    server: str("server") ?? "http://127.0.0.1:8080",
    games: positiveNum("games", 3),
    stake,
    model: str("model"),
    minutes: positiveNum("minutes", 30),
    cli: str("cli") ?? join(DEV_DIR, "bin", "arena"),
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(USAGE);
    return;
  }
  const args = parseArgs(argv);

  if (!existsSync(CLAUDE_BIN)) throw new Error(`BLOCKED: claude CLI not found at ${CLAUDE_BIN}`);
  if (!existsSync(args.cli)) {
    throw new Error(
      `--cli ${args.cli} does not exist. Run "pnpm dev:up" first (it writes this wrapper), or pass --cli explicitly.`,
    );
  }

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const root = join(DEV_DIR, `claude-opponent-${ts}`);
  // Deliberately not initialized: no `arena init` call here -- see this script's own docstring. The agent reads
  // skill.md and onboards itself, exactly like a real user's agent on a fresh machine.
  const { home, workDir } = agentHomeAndWorkDir(root);
  const logPath = join(DEV_DIR, `claude-opponent-${ts}.log`);
  writeFileSync(logPath, "");

  const prompt = `Go to ${args.server} and use your money to play ${args.games} $${args.stake} games with whoever is available.`;
  console.log(`[claude-opponent] home=${home} log=${logPath}`);
  console.log(`[claude-opponent] prompt: ${prompt}`);

  const cliArgs = [
    "-p",
    prompt,
    "--allowedTools",
    // Final review I5: args.cli is the absolute wrapper path a dev-up stack's served skill.md actually names
    // (cliCommand) -- without it, every command the agent's own recipe tells it to run is denied outright.
    ...buildAllowedTools(args.server, args.cli),
    "--permission-mode",
    "manual",
    "--permission-prompts",
    "none",
    "--output-format",
    "stream-json",
    "--verbose",
    "--setting-sources",
    "",
    "--strict-mcp-config",
    "--disable-slash-commands",
    // A runaway-cost guard only -- generous on purpose, matching llm-games.ts's own budget. The real cap is the
    // wall-clock --minutes budget below, not dollars.
    "--max-budget-usd",
    "40",
    ...(args.model ? ["--model", args.model] : []),
  ];

  const child = spawn(CLAUDE_BIN, cliArgs, {
    cwd: workDir,
    env: buildClaudeEnv(home, dirname(args.cli)),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const onChunk = (chunk: Buffer) => {
    process.stdout.write(chunk);
    appendFileSync(logPath, chunk);
  };
  child.stdout?.on("data", onChunk);
  child.stderr?.on("data", onChunk);

  let exited = false;
  const exitedPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (code, signal) => {
      exited = true;
      resolve({ code, signal });
    });
  });

  const stopNow = (why: string) => {
    if (exited) return;
    console.log(`\n[claude-opponent] ${why}: stopping the session`);
    child.kill("SIGTERM");
  };
  const onSigint = () => stopNow("caught SIGINT");
  const onSigterm = () => stopNow("caught SIGTERM");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);

  try {
    const timeoutMs = Math.max(0, args.minutes * 60_000);
    const result = await Promise.race([
      exitedPromise,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
    ]);
    if (result === null) {
      stopNow(`--minutes ${args.minutes} elapsed`);
      const graceExited = await Promise.race([
        exitedPromise.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 10_000)),
      ]);
      if (!graceExited && !exited) child.kill("SIGKILL");
      await exitedPromise;
    }
  } finally {
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
    if (!exited) {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
    }
    // M7: the agent's own daemon (nohup'd per skill.md's recipe step 3) otherwise outlives this script --
    // holding funds in any open channel, and the next dev-up run wipes its home out from underneath it. Read
    // the pid this specific ARENA_HOME's lock names, and stop only that, only if it is still alive and still
    // looks like an arena daemon (not some unrelated process that has since reused the same pid).
    try {
      const { pid } = JSON.parse(readFileSync(join(home, "daemon.lock"), "utf8")) as { pid?: unknown };
      if (typeof pid === "number" && looksLikeArenaDaemon(pid)) {
        console.log(`[claude-opponent] stopping this agent's own daemon (pid ${pid})`);
        process.kill(pid, "SIGTERM");
      }
    } catch {
      // no lock file, malformed, or already gone -- nothing to stop
    }
  }

  const cost = extractCost(logPath);
  console.log(`[claude-opponent] done. cost: ${cost !== undefined ? `$${cost.toFixed(4)}` : "unknown"}`);
}

// Only run when executed directly (`tsx scripts/claude-opponent.ts` / `pnpm dev:claude-opponent`), not when
// imported for its pure `parseArgs` -- mirrors tests/system/llm-games.ts's own guard.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err: unknown) => {
    console.error("[claude-opponent] fatal:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
