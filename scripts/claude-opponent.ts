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
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { buildAllowedTools, buildClaudeEnv, extractCost } from "../tests/system/claude-sandbox.js";
import { HumanWatcher, sessionIdOf } from "./claude-human-watcher.js";

// `__dirname`/`__filename`, not `import.meta`: tsx runs this root-level script as CommonJS (the root package.json has
// no "type"), and so does tsc when tests/system's typecheck follows claude-opponent.test.ts's import here (the same
// note as scripts/testnet-up.ts).
const REPO_ROOT = join(__dirname, "..");
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
         [--dir DIR] [--prompt TEXT] [--owner 0x…] [--human-pay PAY] [--human-budget 3] [--keep-daemon] [--resume SESSION]

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

Testnet live runs (a "pnpm testnet:up" stack has no faucet, so the agent must ask its human for USDC):
  --dir           this agent's own directory: the session runs in DIR/work with ARENA_HOME=DIR/work/arena-home
                  (the "$PWD/arena-home" testnet:up's agent message names), and its logs go in DIR
                  (default: a fresh <repo>/.arena-dev/claude-opponent-<ts>)
  --prompt        the whole prompt instead of the one built from --server/--games/--stake (e.g. the agent message
                  testnet:up prints); with --resume, the human's reply
  --owner         appended to the prompt as the human's cash-out address on Arc
  --human-pay     the stack's pay helper (<testnet dir>/bin/pay): plays the human, paying exactly what the agent
                  asks for in its own text ("send X USDC to 0x…"), once per ask, to the agent's own wallet only
                  (read with "arena wallet"); every decision goes to DIR/human.jsonl
  --human-budget  the most --human-pay pays this agent in total, across resumes (default 3 USDC)
  --keep-daemon   leave the agent's daemon running when the session ends (needed to --resume while a channel is
                  open, and for withdraw, which goes through the daemon)
  --resume        continue that session (its id is printed at the end of each run) with --prompt as the human's
                  reply; needs --dir, the same directory the session ran in
`;

export type Args = {
  server: string;
  games: number;
  stake: string;
  model?: string;
  minutes: number;
  cli: string;
  dir?: string;
  prompt?: string;
  owner?: string;
  humanPay?: string;
  humanBudget: string;
  keepDaemon: boolean;
  resume?: string;
};

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
  const owner = str("owner");
  if (owner !== undefined && !/^0x[0-9a-fA-F]{40}$/.test(owner)) throw new Error("--owner must be a 0x-prefixed 20-byte address");
  const humanBudget = str("human-budget") ?? "3";
  if (!/^[0-9]+(\.[0-9]{1,6})?$/.test(humanBudget)) throw new Error("--human-budget must be a USDC amount with at most 6 decimals");
  const resume = str("resume");
  const dir = str("dir");
  const prompt = str("prompt");
  if (resume !== undefined && (dir === undefined || prompt === undefined)) {
    throw new Error("--resume needs --dir (the directory that session ran in) and --prompt (the human's reply)");
  }
  return {
    server: str("server") ?? "http://127.0.0.1:8080",
    games: positiveNum("games", 3),
    stake,
    model: str("model"),
    minutes: positiveNum("minutes", 30),
    cli: str("cli") ?? join(DEV_DIR, "bin", "arena"),
    dir: dir !== undefined ? resolve(dir) : undefined,
    prompt,
    owner,
    humanPay: str("human-pay"),
    humanBudget,
    keepDaemon: argv.includes("--keep-daemon"),
    resume,
  };
}

/** The prompt one run sends: the human's reply on --resume, else --prompt (or the dev:up sentence) plus the owner. */
export function buildPrompt(args: Args): string {
  if (args.resume !== undefined) return args.prompt!;
  const base =
    args.prompt ?? `Go to ${args.server} and use your money to play ${args.games} $${args.stake} games with whoever is available.`;
  return args.owner !== undefined ? `${base} My Arc address for cash-out is ${args.owner}.` : base;
}

/** Where one run's files go (paths only; `main` creates the directories). Without --dir, the dev:up layout
 *  `agentHomeAndWorkDir` makes (home and work as siblings under .arena-dev). With --dir, ARENA_HOME is
 *  DIR/work/arena-home: the "$PWD/arena-home" testnet:up's agent message tells the agent to use, so a command the
 *  agent prefixes with it and one it does not both reach the same home. */
export function runPaths(args: Args, ts: string): { home: string; workDir: string; logPath: string; ledgerPath?: string } {
  if (args.dir === undefined) {
    const root = join(DEV_DIR, `claude-opponent-${ts}`);
    return { home: join(root, "home"), workDir: join(root, "work"), logPath: join(DEV_DIR, `claude-opponent-${ts}.log`) };
  }
  const workDir = join(args.dir, "work");
  return { home: join(workDir, "arena-home"), workDir, logPath: join(args.dir, `claude-${ts}.log`), ledgerPath: join(args.dir, "human.jsonl") };
}

/** Allow rules for the "ARENA_HOME=$PWD/arena-home <cli> …" form testnet:up's agent message asks for: allow rules
 *  are command-prefix matches, so the plain `<cli> *` rule never matches a command that starts with the assignment. */
export function homePrefixRules(home: string, cli: string): string[] {
  return [`Bash(ARENA_HOME=$PWD/arena-home ${cli} *)`, `Bash(ARENA_HOME=${home} ${cli} *)`, "Bash(ARENA_HOME=$PWD/arena-home arena *)"];
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

  if (args.humanPay !== undefined && !existsSync(args.humanPay)) throw new Error(`--human-pay ${args.humanPay} does not exist`);
  if (args.humanPay !== undefined && args.dir === undefined) throw new Error("--human-pay needs --dir (its ledger lives there)");

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  // Deliberately not initialized: no `arena init` call here -- see this script's own docstring. The agent reads
  // skill.md and onboards itself, exactly like a real user's agent on a fresh machine.
  const { home, workDir, logPath, ledgerPath } = runPaths(args, ts);
  mkdirSync(home, { recursive: true });
  mkdirSync(workDir, { recursive: true });
  writeFileSync(logPath, "");
  // stream-json events carry no wall-clock time: this copy stamps every line as it arrives, for phase timings.
  const stampedPath = `${logPath}.stamped`;
  writeFileSync(stampedPath, "");

  const prompt = buildPrompt(args);
  console.log(`[claude-opponent] home=${home} log=${logPath}${args.resume !== undefined ? ` resume=${args.resume}` : ""}`);
  console.log(`[claude-opponent] prompt: ${prompt}`);

  const cliArgs = [
    "-p",
    prompt,
    ...(args.resume !== undefined ? ["--resume", args.resume] : []),
    "--allowedTools",
    // Final review I5: args.cli is the absolute wrapper path a dev-up stack's served skill.md actually names
    // (cliCommand) -- without it, every command the agent's own recipe tells it to run is denied outright.
    ...buildAllowedTools(args.server, args.cli),
    ...(args.dir !== undefined ? homePrefixRules(home, args.cli) : []),
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
  let partial = "";
  const onChunk = (chunk: Buffer) => {
    process.stdout.write(chunk);
    appendFileSync(logPath, chunk);
    const lines = (partial + chunk.toString("utf8")).split("\n");
    partial = lines.pop() ?? "";
    const now = new Date().toISOString();
    if (lines.length > 0) appendFileSync(stampedPath, lines.map((l) => `${now}\t${l}\n`).join(""));
  };
  child.stdout?.on("data", onChunk);
  child.stderr?.on("data", onChunk);

  const watcher =
    args.humanPay !== undefined && ledgerPath !== undefined
      ? new HumanWatcher({ logPath, ledgerPath, arenaHome: home, cli: args.cli, pay: args.humanPay, budget: args.humanBudget })
      : undefined;
  const watchTimer = watcher !== undefined ? setInterval(() => void watcher.poll(), 5_000) : undefined;

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

  // Cleared in `finally`: left pending, it kept this script alive for the rest of --minutes after the session had
  // already exited (seen on every short --resume of the live run).
  let budgetTimer: NodeJS.Timeout | undefined;
  try {
    const timeoutMs = Math.max(0, args.minutes * 60_000);
    const result = await Promise.race([
      exitedPromise,
      new Promise<null>((resolve) => {
        budgetTimer = setTimeout(() => resolve(null), timeoutMs);
      }),
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
    clearTimeout(budgetTimer);
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
    if (!exited) {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
    }
    if (watchTimer !== undefined) clearInterval(watchTimer);
    // One last pass: an agent that relays its ask and then ends its turn must still be paid.
    if (watcher !== undefined) await watcher.poll();
    // M7: the agent's own daemon (nohup'd per skill.md's recipe step 3) otherwise outlives this script --
    // holding funds in any open channel, and the next dev-up run wipes its home out from underneath it. Read
    // the pid this specific ARENA_HOME's lock names, and stop only that, only if it is still alive and still
    // looks like an arena daemon (not some unrelated process that has since reused the same pid).
    try {
      const { pid } = JSON.parse(readFileSync(join(home, "daemon.lock"), "utf8")) as { pid?: unknown };
      if (typeof pid === "number" && looksLikeArenaDaemon(pid)) {
        if (args.keepDaemon) {
          console.log(`[claude-opponent] --keep-daemon: leaving this agent's daemon running (pid ${pid})`);
        } else {
          console.log(`[claude-opponent] stopping this agent's own daemon (pid ${pid})`);
          process.kill(pid, "SIGTERM");
        }
      }
    } catch {
      // no lock file, malformed, or already gone -- nothing to stop
    }
  }

  const cost = extractCost(logPath);
  let session = watcher?.sessionId;
  if (session === undefined) for (const line of readFileSync(logPath, "utf8").split("\n")) session = sessionIdOf(line) ?? session;
  console.log(`[claude-opponent] done. cost: ${cost !== undefined ? `$${cost.toFixed(4)}` : "unknown"} session: ${session ?? "unknown"}`);
}

// Only run when executed directly (`tsx scripts/claude-opponent.ts` / `pnpm dev:claude-opponent`), not when
// imported for its pure `parseArgs` -- mirrors tests/system/llm-games.ts's own guard.
if (process.argv[1] && resolve(process.argv[1]) === __filename) {
  main().catch((err: unknown) => {
    console.error("[claude-opponent] fatal:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
