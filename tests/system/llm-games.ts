#!/usr/bin/env node
/**
 * Plan 4.5 Task 12: live games between two headless Claude Code agents -- the product's main success criterion.
 * Each agent gets nothing but a URL and a funded wallet; it must read `<server>/skill.md` on its own, find the
 * other agent through the `arena` CLI's lobby, open a USDC state channel, play chess, and close. This script does
 * not run the agents' daemons or drive any moves for them -- it only starts the stack (Task 7), pre-initializes
 * two funded homes (`arena init`, so the agents only need `arena daemon`), launches the two `claude -p` sessions,
 * and polls the chain and the server for the pass criteria.
 *
 * Usage: pnpm llm-games [--agents 2] [--games 2] [--minutes 30] [--model <id>]
 *
 * This spends real Claude usage: cap runs at 3 total (see the Task 12 report) and keep `--minutes` reasonable.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, http, type Address, type Hex, type PublicClient } from "viem";
import { foundry } from "viem/chains";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { HubClient } from "@arena/sdk";
import { loadToken } from "@arena/cli";
import { buildAllowedTools, buildClaudeEnv, extractCost, makeTmpAgentRoot } from "./claude-sandbox.js";
import { CLI_BIN, freeTcpPort, runCli, startStack, usdcBalanceOf, type Stack } from "./harness.js";

// Plan 5.5 Task 2: re-exported so llm-games.test.ts's existing `import { buildAllowedTools, buildClaudeEnv } from
// "./llm-games.js"` keeps working unchanged -- the builders themselves now live in claude-sandbox.ts, shared with
// scripts/claude-opponent.ts.
export { buildAllowedTools, buildClaudeEnv };

const REPO_ROOT = join(import.meta.dirname, "../..");
const LOG_DIR = join(REPO_ROOT, ".arena-dev", "llm");
const REPORT_PATH = join(REPO_ROOT, "tests", "system", "LLM-GAMES.md");
const CLAUDE_BIN = join(homedir(), ".local/bin/claude");

/** Matches `Stack.fund`'s own default -- kept explicit here so this script's numbers don't silently drift if that
 *  default ever changes. */
const START_USDC = 10_000_000n;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// -------------------------------------------------------------------------------------------------------- args

export type Args = { agents: number; games: number; minutes: number; model?: string };

export function parseArgs(argv: string[]): Args {
  const str = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : undefined;
  };
  const num = (name: string, def: number): number => {
    const v = str(name);
    if (v === undefined) return def;
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`--${name} must be a positive number`);
    return n;
  };
  const agents = num("agents", 2);
  if (agents !== 2) throw new Error("--agents only supports 2 right now");
  return { agents, games: num("games", 2), minutes: num("minutes", 30), model: str("model") };
}

// ---------------------------------------------------------------------------------------------------- arena wrapper

/** A PATH-resident `arena` wrapper so the agents' own Bash tool calls can just run `arena ...`, matching the
 *  stack's published `cliCommand` (see harness.ts's `baseConfig.cliCommand`, already "arena"). */
function writeArenaWrapper(dir: string): void {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "arena");
  writeFileSync(path, `#!/bin/sh\nexec node ${CLI_BIN} "$@"\n`);
  chmodSync(path, 0o755);
}

// ------------------------------------------------------------------------------------------------------ agent homes

type AgentHome = {
  name: string;
  /** This agent's own unpredictable tmp parent directory (`home` and `workDir` both live under it) -- removed
   *  entirely after the run. Deliberately *not* named after the agent (no "-alice-"/"-bob-" in the path): a fixed,
   *  predictable naming scheme would let one agent's own path tell it exactly how to construct the other's, glob
   *  or not. Each root's only shared substring with its sibling is the generic "arena-llm-" prefix every run uses
   *  for its own cleanup/debugging -- the part that actually distinguishes and isolates the two is mkdtemp's own
   *  random suffix. */
  root: string;
  home: string;
  workDir: string;
  address: Address;
  apiPort: number;
  token: string;
};

/** Funds a fresh wallet and runs `arena init` for it (Task 7's harness normally also starts the daemon via
 *  `Stack.player()`; here the daemon is deliberately left unstarted -- the whole point is that the agent starts
 *  its own). */
async function initAgentHome(stack: Stack, name: string): Promise<AgentHome> {
  const key = generatePrivateKey();
  const address = privateKeyToAccount(key).address;
  await stack.fund(address, START_USDC);
  const { root, home, workDir } = makeTmpAgentRoot("arena-llm-");
  const apiPort = await freeTcpPort();
  const init = await runCli(
    ["init", "--server", stack.serverUrl, "--wallet-key", key, "--port", String(apiPort), "--poll-ms", "200"],
    home,
  );
  if (init.status !== 0) throw new Error(`arena init failed for "${name}":\n${init.stderr || init.stdout}`);
  return { name, root, home, workDir, address, apiPort, token: loadToken(home) };
}

/** Best-effort removal of `agent`'s tmp root (see `AgentHome.root`'s docstring) after a run -- this script's own
 *  cleanup, distinct from `stack.stop()`'s (the stack's own tmp dir). */
function cleanupAgentHome(agent: AgentHome): void {
  try {
    rmSync(agent.root, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

/** A read-only GET against `agent`'s own daemon API -- the same local HTTP surface `arena` itself talks to (see
 *  packages/cli/src/api.ts) -- used only for this script's own polling, never to act on the agent's behalf. */
async function daemonApi(agent: AgentHome, path: string): Promise<any> {
  const res = await fetch(`http://127.0.0.1:${agent.apiPort}${path}`, {
    headers: { authorization: `Bearer ${agent.token}` },
    signal: AbortSignal.timeout(5_000),
  });
  if (!res.ok) throw new Error(`GET ${path} (${agent.name}) -> ${res.status}`);
  return res.json();
}

// -------------------------------------------------------------------------------------------------- claude sessions

type Session = {
  name: string;
  child: ChildProcess;
  logPath: string;
  startedAt: number;
  endedAt?: number;
  exitCode: number | null;
  exitSignal: NodeJS.Signals | null;
};

// buildAllowedTools and buildClaudeEnv now live in ./claude-sandbox.ts (shared with scripts/claude-opponent.ts);
// see the re-export near the top of this file.

/** Launches one headless agent. `--setting-sources ""`, `--strict-mcp-config` and `--disable-slash-commands` strip
 *  this machine's own CLAUDE.md/plugins/MCP servers out of the session, so it behaves like the clean agent the
 *  product is meant for (and costs far less per turn). */
function spawnClaudeAgent(agent: AgentHome, binDir: string, serverUrl: string, games: number, model?: string): Session {
  mkdirSync(LOG_DIR, { recursive: true });
  const logPath = join(LOG_DIR, `${agent.name}.log`);
  writeFileSync(logPath, "");
  const prompt =
    `Read ${serverUrl}/skill.md and play chess against another agent. Play ${games} games, then close the channel. ` +
    // H4: `daemon --detach` (skill.md's recipe step 2), not the tool's own background task, which ends with the
    // session; killDaemon below stops it through daemon.lock either way.
    `Your wallet key is in ARENA_HOME already. Start the daemon with \`arena daemon --detach\` (skill.md's recipe ` +
    `step 2): it keeps running after that command returns.`;
  const args = [
    "-p",
    prompt,
    "--allowedTools",
    ...buildAllowedTools(serverUrl),
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
    // A runaway-cost guard only -- generous on purpose. A real game (many wait/status/move round trips, each
    // status carrying the board and legal moves) easily runs tens of dollars list price; the brief's real cap is
    // the wall-clock --minutes budget, not dollars, so this must never be the thing that cuts a healthy game short.
    "--max-budget-usd",
    "40",
    ...(model ? ["--model", model] : []),
  ];
  const child = spawn(CLAUDE_BIN, args, {
    cwd: agent.workDir,
    env: buildClaudeEnv(agent.home, binDir),
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (c: Buffer) => appendFileSync(logPath, c));
  child.stderr.on("data", (c: Buffer) => appendFileSync(logPath, c));
  const session: Session = { name: agent.name, child, logPath, startedAt: Date.now(), exitCode: null, exitSignal: null };
  child.once("exit", (code, signal) => {
    session.exitCode = code;
    session.exitSignal = signal;
    session.endedAt = Date.now();
  });
  return session;
}

async function killSession(session: Session): Promise<void> {
  if (session.exitCode !== null) return;
  try {
    session.child.kill("SIGTERM");
  } catch {
    // already gone
  }
  await Promise.race([new Promise<void>((r) => session.child.once("exit", () => r())), sleep(10_000)]);
  if (session.exitCode === null) {
    try {
      session.child.kill("SIGKILL");
    } catch {
      // already gone
    }
  }
}

/** True if `pid` still names a live process this user can signal (matches packages/cli/src/lock.ts's own check). */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Kills `agent`'s daemon (started by the agent itself, not this script) by reading its pid from `daemon.lock` in
 *  ARENA_HOME (packages/cli/src/lock.ts writes `{"pid": N}` there) -- the only way this script, which never held a
 *  handle to that process, can find and stop it. SIGTERM first (the daemon's normal graceful path -- see
 *  packages/cli/src/run.ts), then SIGKILL if it is somehow still alive a moment later. Best-effort throughout: a
 *  missing or stale lock file is not an error. */
async function killDaemon(agent: AgentHome): Promise<void> {
  const lockPath = join(agent.home, "daemon.lock");
  if (!existsSync(lockPath)) return;
  let pid: number;
  try {
    ({ pid } = JSON.parse(readFileSync(lockPath, "utf8")) as { pid: number });
  } catch {
    return; // malformed/stale lock file
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return; // already gone
  }
  await sleep(3_000);
  if (isAlive(pid)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
}

// -------------------------------------------------------------------------------------------------- pass criteria

type PollResult = {
  channelId?: Hex;
  finalized: boolean;
  conserved?: boolean;
  gamesPlayed?: number;
  balancesBefore?: { a: bigint; b: bigint; host: bigint };
  balancesAfter?: { a: bigint; b: bigint; host: bigint };
};

/** The three pass criteria from the ruling, all required: a channel opened between the two wallets (folded into
 *  `conserved`, which is false unless both addresses were found among the on-chain participants), at least one
 *  game completed (an unverified `gamesPlayed` -- e.g. the `/api/channels/:id` fetch failed -- is never treated as
 *  a pass), and the channel reached Finalized with conserved balances. */
function isPass(result: PollResult): boolean {
  return result.finalized === true && result.conserved === true && result.gamesPlayed !== undefined && result.gamesPlayed >= 1;
}

/** The first channel either agent's own daemon reports, i.e. discovered purely through daemon status -- no
 *  channel id is known up front. On this isolated stack the only possible counterparty for either wallet is the
 *  other agent, so any channel found here is, by construction, between the two agents' wallets; `pollForResult`
 *  still double-checks that against on-chain `channelParams` before calling it a pass. */
async function findChannelId(agentA: AgentHome, agentB: AgentHome): Promise<Hex | undefined> {
  for (const agent of [agentA, agentB]) {
    try {
      const list = (await daemonApi(agent, "/channels")) as Array<{ channelId: Hex; degraded?: boolean }>;
      const found = list.find((c) => !c.degraded && c.channelId);
      if (found) return found.channelId;
    } catch {
      // daemon not up yet (or between requests) -- try the other agent / next poll
    }
  }
  return undefined;
}

async function usdcSnapshot(stack: Stack, agentA: AgentHome, agentB: AgentHome): Promise<{ a: bigint; b: bigint; host: bigint }> {
  const [a, b, host] = await Promise.all([
    usdcBalanceOf(stack, agentA.address),
    usdcBalanceOf(stack, agentB.address),
    usdcBalanceOf(stack, stack.host),
  ]);
  return { a, b, host };
}

/** Polls the chain (via HubClient, independent of the server's relay cache) and the server until the channel
 *  reaches Finalized, or `deadline` passes, or both sessions have already exited without ever finalizing. */
async function pollForResult(
  stack: Stack,
  agentA: AgentHome,
  agentB: AgentHome,
  deadline: number,
  sessions: Session[],
): Promise<PollResult> {
  const pub = createPublicClient({ chain: foundry, transport: http(stack.rpcUrl) }) as PublicClient;
  const hub = new HubClient(stack.hub, pub);
  const before = await usdcSnapshot(stack, agentA, agentB);
  let channelId: Hex | undefined;
  while (Date.now() < deadline) {
    if (!channelId) channelId = await findChannelId(agentA, agentB);
    if (channelId) {
      const info = await hub.channelInfo(channelId).catch(() => undefined);
      if (info?.phase === "Finalized") {
        const params = await hub.channelParams(channelId);
        const participants = params.participants.map((p) => p.toLowerCase());
        const bothPresent =
          participants.includes(agentA.address.toLowerCase()) && participants.includes(agentB.address.toLowerCase());
        const after = await usdcSnapshot(stack, agentA, agentB);
        const conserved = bothPresent && before.a + before.b + before.host === after.a + after.b + after.host;
        // Per the ruling: "checked on-chain or through daemon status. The server's /api/channels/:id shows the
        // gameIndex and status." `status` is numeric (0 playing, 1 draw_offered, 2 white_won, 3 black_won, 4
        // draw -- see docs.ts's WATCH_SCRIPT STATUS_NAME); a channel can only close on a finished game (skill.md),
        // so at Finalized the last game's status is always terminal, and gameIndex+1 games were completed. Left
        // undefined (not defaulted to a passing value) if this fetch fails, so a fetch failure can never manufacture
        // a pass.
        let gamesPlayed: number | undefined;
        try {
          const res = await fetch(`${stack.serverUrl}/api/channels/${channelId}`);
          const body = (await res.json()) as { latest?: { gameIndex: number; status: number } };
          if (res.ok && body.latest) gamesPlayed = body.latest.gameIndex + (body.latest.status >= 2 ? 1 : 0);
        } catch {
          // left undefined -- see docstring above
        }
        return { channelId, finalized: true, conserved, gamesPlayed, balancesBefore: before, balancesAfter: after };
      }
    }
    if (sessions.every((s) => s.exitCode !== null)) break; // nothing left to wait for
    await sleep(3_000);
  }
  return { channelId, finalized: false, balancesBefore: before };
}

// ------------------------------------------------------------------------------------------------------- reporting

// extractCost now lives in ./claude-sandbox.ts (shared with scripts/claude-opponent.ts); see the import at the
// top of this file.

/** Pulls a handful of short, human-readable quotes out of a stream-json log that look like the agent got confused
 *  or blocked -- for the report's "notable confusions" section. Best-effort text mining, not a parser: stream-json
 *  assistant text lives inside `content[].text` fields, so this just regexes those out of lines that also contain
 *  a trouble keyword. */
function extractConfusions(logPath: string, max = 5): string[] {
  if (!existsSync(logPath)) return [];
  const quotes: string[] = [];
  const keywords = /denied|permission|blocked|can't|cannot|couldn't|stuck|unable|error|failed|confus/i;
  for (const line of readFileSync(logPath, "utf8").split("\n")) {
    if (quotes.length >= max) break;
    if (!keywords.test(line)) continue;
    try {
      const obj = JSON.parse(line) as { type?: string; message?: { content?: Array<{ type: string; text?: string }> } };
      if (obj.type !== "assistant" || !obj.message?.content) continue;
      for (const block of obj.message.content) {
        if (block.type === "text" && block.text && keywords.test(block.text)) {
          const snippet = block.text.trim().slice(0, 220).replace(/\s+/g, " ");
          if (snippet) quotes.push(snippet);
          break;
        }
      }
    } catch {
      // not a complete JSON line -- skip
    }
  }
  return quotes;
}

/** The authoritative denial list from stream-json's final `result` event (`permission_denials`), deduped by
 *  command -- more reliable than text-mining `extractConfusions`'s prose, but only present for a session that got
 *  to emit a `result` at all (a session killed mid-turn, e.g. by this script's own cleanup, has none; that is
 *  itself worth noting, not silently treated as "no denials"). */
function extractPermissionDenials(logPath: string): string[] {
  if (!existsSync(logPath)) return [];
  const seen = new Set<string>();
  for (const line of readFileSync(logPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const obj = JSON.parse(trimmed) as {
        type?: string;
        permission_denials?: Array<{ tool_name: string; tool_input?: { command?: string } }>;
      };
      if (obj.type !== "result" || !obj.permission_denials) continue;
      for (const d of obj.permission_denials) seen.add(`${d.tool_name}: ${d.tool_input?.command ?? "(no command)"}`);
    } catch {
      // not a complete JSON line -- skip
    }
  }
  return [...seen];
}

type RunSummary = {
  args: Args;
  result: PollResult;
  durationMs: number;
  sessions: Session[];
  costA?: number;
  costB?: number;
  agentA: AgentHome;
  agentB: AgentHome;
};

function fmtUsdc(n: bigint): string {
  const neg = n < 0n;
  const abs = neg ? -n : n;
  const whole = abs / 1_000_000n;
  const frac = (abs % 1_000_000n).toString().padStart(6, "0");
  return `${neg ? "-" : ""}${whole}.${frac}`;
}

function writeReport(summary: RunSummary): void {
  const { args, result, durationMs, sessions, costA, costB } = summary;
  const pass = isPass(result);
  const existing = existsSync(REPORT_PATH) ? readFileSync(REPORT_PATH, "utf8") : "";
  const runNumber = (existing.match(/^## Run \d+/gm) ?? []).length + 1;

  const lines: string[] = [];
  if (!existing) {
    lines.push("# LLM Games (Plan 4.5 Task 12)", "", "Live games between two headless Claude Code agents, driven only by `skill.md` and the `arena` CLI.", "");
  }
  lines.push(`## Run ${runNumber} -- ${new Date().toISOString()}`, "");
  lines.push(`- Result: **${pass ? "PASS" : "FAIL"}**`);
  lines.push(`- Args: --agents ${args.agents} --games ${args.games} --minutes ${args.minutes}${args.model ? ` --model ${args.model}` : ""}`);
  lines.push(`- Duration: ${(durationMs / 60_000).toFixed(1)} min`);
  for (const s of sessions) {
    const dur = s.endedAt ? ((s.endedAt - s.startedAt) / 60_000).toFixed(1) : "still running";
    const gotResult = extractCost(s.logPath) !== undefined;
    const note =
      s.exitCode === 0
        ? "ended its own turn"
        : !gotResult
          ? "killed by this script's cleanup (SIGTERM/SIGKILL) before it emitted a final result -- likely mid a long `arena wait`; cost unknown for this session"
          : `exit code ${s.exitCode}`;
    const signalNote = s.exitSignal ? `, signal=${s.exitSignal}` : "";
    lines.push(`- ${s.name}: exit=${s.exitCode ?? "n/a"}${signalNote}, duration=${dur} min (${note})`);
  }
  lines.push(`- Channel: ${result.channelId ?? "none discovered"}`);
  lines.push(`- Finalized: ${result.finalized}`);
  if (result.finalized) {
    lines.push(`- Games played (server-reported): ${result.gamesPlayed ?? "unknown"}`);
    lines.push(`- Conserved balances: ${result.conserved}`);
    if (result.balancesBefore && result.balancesAfter) {
      lines.push(
        `  - before: A=${fmtUsdc(result.balancesBefore.a)} B=${fmtUsdc(result.balancesBefore.b)} host=${fmtUsdc(result.balancesBefore.host)} USDC`,
      );
      lines.push(
        `  - after: A=${fmtUsdc(result.balancesAfter.a)} B=${fmtUsdc(result.balancesAfter.b)} host=${fmtUsdc(result.balancesAfter.host)} USDC`,
      );
    }
  }
  const costTotal = (costA ?? 0) + (costB ?? 0);
  lines.push(`- Cost: alice=$${costA?.toFixed(4) ?? "unknown"}, bob=$${costB?.toFixed(4) ?? "unknown"}, total=$${costTotal.toFixed(4)}`);
  lines.push("", "### Notable agent confusions", "");
  for (const s of sessions) {
    const quotes = extractConfusions(s.logPath);
    const denials = extractPermissionDenials(s.logPath);
    if (quotes.length === 0 && denials.length === 0) {
      lines.push(`- ${s.name}: none found`);
      continue;
    }
    lines.push(`- ${s.name}:`);
    for (const q of quotes) lines.push(`  - "${q}"`);
    if (denials.length > 0) {
      lines.push(`  - allowlist denials (from the session's own \`permission_denials\`, none arena-level -- all outside this run's allowlist, built by \`buildAllowedTools\` -- \`arena\` plus \`curl\` pinned to this stack's own server origin, nothing else):`);
      for (const d of denials) lines.push(`    - \`${d}\``);
    }
  }
  lines.push(
    "",
    "### skill.md text this run used",
    "",
    "Not duplicated here (a copy here would silently go stale the next time `apps/server/src/docs.ts` changes) --" +
      " see that file's `skillMd`/`chessSkillMd` at this run's commit for the exact wording.",
    "",
  );

  writeFileSync(REPORT_PATH, existing + lines.join("\n") + "\n");
}

// ------------------------------------------------------------------------------------------------------------ main

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!existsSync(CLAUDE_BIN)) throw new Error(`BLOCKED: claude CLI not found at ${CLAUDE_BIN}`);

  const startedAt = Date.now();
  const deadline = startedAt + args.minutes * 60_000;

  const binDir = mkdtempSync(join(tmpdir(), "arena-llm-bin-"));
  writeArenaWrapper(binDir);

  console.log("[llm-games] starting stack...");
  const stack = await startStack();
  console.log(`[llm-games] stack up: server=${stack.serverUrl} rpc=${stack.rpcUrl}`);

  let sessions: Session[] = [];
  let agentA: AgentHome | undefined;
  let agentB: AgentHome | undefined;
  try {
    agentA = await initAgentHome(stack, "alice");
    agentB = await initAgentHome(stack, "bob");
    console.log(`[llm-games] homes ready: alice=${agentA.address} bob=${agentB.address}`);

    sessions = [
      spawnClaudeAgent(agentA, binDir, stack.serverUrl, args.games, args.model),
      spawnClaudeAgent(agentB, binDir, stack.serverUrl, args.games, args.model),
    ];
    console.log(`[llm-games] both claude sessions launched, logging to ${LOG_DIR}`);

    const result = await pollForResult(stack, agentA, agentB, deadline, sessions);

    if (result.finalized) {
      // Give both sessions a grace period to notice the close and end their own turn cleanly. Run 1 (see
      // LLM-GAMES.md) showed 30s is too short: the first close-signer's `arena wait` has no `attention` reason to
      // return on once the *other* side's settlement lands (daemon.ts's `wait()` only wakes on `attention` or
      // `control-changed`), so it can only return on its own ~60s default timeout. 90s covers that plus a status
      // call.
      const graceEnd = Date.now() + 90_000;
      while (Date.now() < graceEnd && sessions.some((s) => s.exitCode === null)) await sleep(1_000);
    }

    await Promise.all(sessions.map(killSession));
    await killDaemon(agentA);
    await killDaemon(agentB);

    const durationMs = Date.now() - startedAt;
    const costA = extractCost(sessions[0].logPath);
    const costB = extractCost(sessions[1].logPath);
    writeReport({ args, result, durationMs, sessions, costA, costB, agentA, agentB });

    const pass = isPass(result);
    console.log(`[llm-games] ${pass ? "PASS" : "FAIL"} -- see tests/system/LLM-GAMES.md`);
    process.exitCode = pass ? 0 : 1;
  } finally {
    await Promise.all(sessions.map((s) => killSession(s).catch(() => {})));
    if (agentA) await killDaemon(agentA).catch(() => {});
    if (agentB) await killDaemon(agentB).catch(() => {});
    if (agentA) cleanupAgentHome(agentA);
    if (agentB) cleanupAgentHome(agentB);
    try {
      rmSync(binDir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
    await stack.stop();
  }
}

// Only run when executed directly (`tsx tests/system/llm-games.ts` / `pnpm llm-games`), not when imported for its
// pure builder functions by llm-games.test.ts -- importing this module must never start a stack or spawn `claude`.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error("[llm-games] fatal:", err);
    process.exitCode = 1;
  });
}
