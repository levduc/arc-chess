/**
 * Live agent run (Arc testnet): the "human" side of `scripts/claude-opponent.ts --human-pay <pay helper>`.
 *
 * On a testnet stack (`pnpm testnet:up`) there is no faucet: the agent must ask its human for USDC, exactly as a
 * real user's agent would. This watcher plays that human. It tails the session's `stream-json` log and pays, once,
 * exactly what the agent asks to be sent to its own wallet, through the stack's pay helper (`<dir>/bin/pay <address>
 * <usdc>`, which signs from the testnet deployer; this file never sees that key). An ask is either:
 *  - in the agent's own text (assistant text blocks and the final `result`): "send X USDC to 0x…"; or
 *  - `arena fund`'s own `message` in a tool result, once the agent goes on to `wallet --wait-for-usdc` -- the agent
 *    is then waiting for that money, and a human at an interactive session sees that command output in the
 *    terminal. The first live run's agent never restated the ask in its own words: it ran `fund`, said "I'll relay
 *    and wait", and waited, so a watcher reading its text alone would have left it waiting for good.
 *
 * The agent's wallet address comes from the CLI's own read-only `arena wallet` in the agent's `ARENA_HOME` -- never
 * from `wallet.json`. An ask naming any other address (the owner's, an opponent's) is logged and never paid.
 *
 * Every decision is appended to a JSON-lines ledger, with an ISO timestamp, *before* the pay helper runs, so a
 * resumed session (`--resume`) or a crash mid-payment can never pay the same ask twice. Node built-ins only, like
 * `tests/system/claude-sandbox.ts`.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, closeSync, existsSync, openSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** One "send X USDC to 0x…" the agent put in front of its human. */
export type FundingAsk = { usdc: string; address: string };

/** One line of the ledger. `pay` is written before the helper runs; `paid` after it returns. */
export type LedgerEntry =
  | { t: string; kind: "ask"; usdc: string; address: string; text: string; source?: "text" | "fund-output" }
  | { t: string; kind: "skip"; usdc: string; address: string; why: string }
  | { t: string; kind: "pay"; usdc: string; address: string }
  | { t: string; kind: "paid"; usdc: string; address: string; exit: number | null; stdout: string; stderr: string }
  | { t: string; kind: "note"; text: string };

const USDC_AMOUNT = "([0-9]+(?:\\.[0-9]{1,6})?)";
// "send 1.351 USDC to 0x…", "send me 1.35 USDC ... to 0x…", "send $1.35 USDC (Arc Testnet) to 0x…": the amount right
// after "send", then the first address within a short gap -- never an address further along the text.
const ASK_RE = new RegExp(`\\bsend\\s+(?:me\\s+|us\\s+|exactly\\s+|over\\s+|at\\s+least\\s+)?\\$?${USDC_AMOUNT}\\s*USDC\\b([^]{0,160}?)\\b(0x[0-9a-fA-F]{40})\\b`, "gi");

/** Every funding ask in one piece of the agent's text. Markdown emphasis and code spans are stripped first, so
 *  "send **1.35 USDC** to `0x…`" reads like the plain sentence `arena fund` prints. Pure, for the tests. */
export function parseFundingAsks(text: string): FundingAsk[] {
  const plain = text.replace(/[*`_]/g, "");
  const out: FundingAsk[] = [];
  for (const m of plain.matchAll(ASK_RE)) {
    const gap = m[2] ?? "";
    // "send 1 USDC per game ... to 0x" style prose is still an ask; a sentence break with another amount is not.
    if (/[0-9.]+\s*USDC/i.test(gap)) continue;
    out.push({ usdc: m[1]!, address: m[3]! });
  }
  return out;
}

/** What a human would read in one `stream-json` line: the agent's text blocks, or the final `result`. Tool calls
 *  and tool results (the CLI's own output) are not shown to a human, so they are not returned. */
export function agentTexts(line: string): string[] {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return [];
  let obj: { type?: string; result?: unknown; message?: { content?: unknown } };
  try {
    obj = JSON.parse(trimmed) as typeof obj;
  } catch {
    return [];
  }
  if (obj.type === "result") return typeof obj.result === "string" ? [obj.result] : [];
  if (obj.type !== "assistant" || !Array.isArray(obj.message?.content)) return [];
  const texts: string[] = [];
  for (const block of obj.message.content as Array<{ type?: string; text?: unknown }>) {
    if (block.type === "text" && typeof block.text === "string") texts.push(block.text);
  }
  return texts;
}

/** The asks in `arena fund`'s own `message`, inside one `stream-json` tool-result line (`"message": "Please send X
 *  USDC to 0x… on Arc Testnet …"`). Only a JSON `message` field counts, so a tool result that merely echoes text
 *  (a `curl` of skill.md, say) is never read as an ask. */
export function fundOutputAsks(line: string): FundingAsk[] {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return [];
  let obj: { type?: string; message?: { content?: unknown } };
  try {
    obj = JSON.parse(trimmed) as typeof obj;
  } catch {
    return [];
  }
  if (obj.type !== "user" || !Array.isArray(obj.message?.content)) return [];
  const out: FundingAsk[] = [];
  for (const block of obj.message.content as Array<{ type?: string; content?: unknown }>) {
    if (block.type !== "tool_result") continue;
    const content = Array.isArray(block.content)
      ? (block.content as Array<{ text?: unknown }>).map((c) => (typeof c.text === "string" ? c.text : "")).join("")
      : typeof block.content === "string"
        ? block.content
        : "";
    let parsed: { message?: unknown; usdc?: unknown };
    try {
      parsed = JSON.parse(content) as typeof parsed;
    } catch {
      continue;
    }
    if (typeof parsed.message === "string" && typeof parsed.usdc === "object") out.push(...parseFundingAsks(parsed.message));
  }
  return out;
}

/** True if one `stream-json` line is the agent running `wallet --wait-for-usdc`: it is now waiting for its human. */
export function waitsForUsdc(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return false;
  try {
    const obj = JSON.parse(trimmed) as { type?: string; message?: { content?: unknown } };
    if (obj.type !== "assistant" || !Array.isArray(obj.message?.content)) return false;
    return (obj.message.content as Array<{ type?: string; input?: { command?: unknown } }>).some(
      (b) => b.type === "tool_use" && typeof b.input?.command === "string" && /\bwallet\b[^|;&]*--wait-for-usdc\b/.test(b.input.command),
    );
  } catch {
    return false;
  }
}

/** The session id a `stream-json` line carries (the `system/init` and `result` events), for `--resume`. */
export function sessionIdOf(line: string): string | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return undefined;
  try {
    const obj = JSON.parse(trimmed) as { session_id?: unknown };
    return typeof obj.session_id === "string" ? obj.session_id : undefined;
  } catch {
    return undefined;
  }
}

/** USDC decimal string to integer micro-USDC, for exact budget arithmetic. */
export function microUsdc(usdc: string): bigint {
  const [whole, frac = ""] = usdc.split(".");
  return BigInt(whole!) * 1_000_000n + BigInt(frac.padEnd(6, "0").slice(0, 6));
}

/** Whether to pay one ask, as a pure function of what has been paid already. Pays an ask once: the same amount to
 *  the same address asked again (the agent repeating itself, or its final `result` restating its last message) is
 *  never paid twice. Refuses an address other than the agent's own wallet, more than 3 USDC in one payment (the pay
 *  helper's own cap), and anything that would take the total past `budget`. */
export function decide(
  ask: FundingAsk,
  wallet: string,
  ledger: readonly LedgerEntry[],
  budget: string,
): { pay: true } | { pay: false; why: string } {
  if (ask.address.toLowerCase() !== wallet.toLowerCase()) return { pay: false, why: `not the agent's wallet (${wallet})` };
  const amount = microUsdc(ask.usdc);
  if (amount === 0n) return { pay: false, why: "zero amount" };
  if (amount > 3_000_000n) return { pay: false, why: "over 3 USDC in one payment: stop and report" };
  const pays = ledger.filter((e): e is Extract<LedgerEntry, { kind: "pay" }> => e.kind === "pay");
  if (pays.some((p) => p.address.toLowerCase() === ask.address.toLowerCase() && microUsdc(p.usdc) === amount)) {
    return { pay: false, why: "already paid this ask" };
  }
  const total = pays.reduce((sum, p) => sum + microUsdc(p.usdc), 0n);
  if (total + amount > microUsdc(budget)) return { pay: false, why: `would exceed the ${budget} USDC budget (paid so far ${Number(total) / 1e6}): stop and report` };
  return { pay: true };
}

export function readLedger(path: string): LedgerEntry[] {
  if (!existsSync(path)) return [];
  const out: LedgerEntry[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as LedgerEntry);
    } catch {
      // a torn last line -- skip
    }
  }
  return out;
}

export type WatcherOptions = {
  logPath: string;
  ledgerPath: string;
  arenaHome: string;
  cli: string;
  pay: string;
  budget: string;
};

/** Tails one session's log and pays its asks. `poll()` is safe to call on a timer; overlapping calls are skipped. */
export class HumanWatcher {
  private offset = 0;
  private busy = false;
  private wallet: string | undefined;
  private readonly seen = new Set<string>();
  /** Asks read from the log but not yet decided (the wallet address was not readable yet): retried every poll. */
  private pending: Array<{ ask: FundingAsk; text: string; source: "text" | "fund-output" }> = [];
  /** The asks in the latest `fund` output, paid only once the agent waits for them (`wallet --wait-for-usdc`). */
  private lastFundAsks: FundingAsk[] = [];
  sessionId: string | undefined;

  constructor(private readonly o: WatcherOptions) {}

  private record(e: LedgerEntry): void {
    appendFileSync(this.o.ledgerPath, `${JSON.stringify(e)}\n`);
    const { t, kind, ...rest } = e;
    console.log(`[human ${t}] ${kind} ${JSON.stringify(rest).slice(0, 400)}`);
  }

  /** The agent's wallet address, from the CLI's read-only `wallet` (undefined until `init` has run). */
  private walletAddress(): string | undefined {
    if (this.wallet !== undefined) return this.wallet;
    const r = spawnSync(this.o.cli, ["wallet"], {
      env: { ...process.env, ARENA_HOME: this.o.arenaHome },
      encoding: "utf8",
      timeout: 60_000,
    });
    if (r.status !== 0) return undefined;
    try {
      const { address } = JSON.parse(r.stdout) as { address?: unknown };
      if (typeof address === "string" && /^0x[0-9a-fA-F]{40}$/.test(address)) this.wallet = address;
    } catch {
      // not initialized yet, or the RPC failed -- try again on the next poll
    }
    return this.wallet;
  }

  async poll(): Promise<void> {
    if (this.busy || !existsSync(this.o.logPath)) return;
    this.busy = true;
    try {
      const buf = readFileSync(this.o.logPath);
      const chunk = buf.subarray(this.offset).toString("utf8");
      const lastNl = chunk.lastIndexOf("\n");
      if (lastNl >= 0) {
        this.offset += Buffer.byteLength(chunk.slice(0, lastNl + 1));
        for (const line of chunk.slice(0, lastNl).split("\n")) {
          this.sessionId = sessionIdOf(line) ?? this.sessionId;
          const fromFund = fundOutputAsks(line);
          if (fromFund.length > 0) this.lastFundAsks = fromFund;
          if (waitsForUsdc(line)) {
            for (const ask of this.lastFundAsks) this.pending.push({ ask, text: "(arena fund's message, then wallet --wait-for-usdc)", source: "fund-output" });
            this.lastFundAsks = [];
          }
          for (const text of agentTexts(line)) {
            const asks = parseFundingAsks(text);
            for (const ask of asks) this.pending.push({ ask, text, source: "text" });
            // Something that reads like an ask but did not parse is never paid by guesswork: flag it for a person.
            if (asks.length === 0 && /\bsend\b/i.test(text) && /USDC/.test(text) && /0x[0-9a-fA-F]{40}/.test(text)) {
              this.record({ t: new Date().toISOString(), kind: "note", text: `possible ask not parsed: ${text.slice(0, 600)}` });
            }
          }
        }
      }
      const queue = this.pending;
      this.pending = [];
      for (const item of queue) if (!(await this.handle(item.ask, item.text, item.source))) this.pending.push(item);
    } finally {
      this.busy = false;
    }
  }

  /** False when the ask could not be decided yet (no wallet address): the caller keeps it queued. */
  private async handle(ask: FundingAsk, text: string, source: "text" | "fund-output"): Promise<boolean> {
    const key = `${ask.address.toLowerCase()}:${microUsdc(ask.usdc)}:${source}`;
    if (!this.seen.has(key)) {
      this.seen.add(key);
      this.record({ t: new Date().toISOString(), kind: "ask", ...ask, text: text.slice(0, 600), source });
    }
    const wallet = this.walletAddress();
    if (wallet === undefined) return false;
    const verdict = decide(ask, wallet, readLedger(this.o.ledgerPath), this.o.budget);
    if (!verdict.pay) {
      if (verdict.why !== "already paid this ask") this.record({ t: new Date().toISOString(), kind: "skip", ...ask, why: verdict.why });
      return true;
    }
    this.record({ t: new Date().toISOString(), kind: "pay", ...ask });
    const release = await payLock(this.o.pay);
    try {
      for (let attempt = 1; ; attempt++) {
        const result = await new Promise<{ exit: number | null; stdout: string; stderr: string }>((resolve) => {
          const child = spawn(this.o.pay, [ask.address, ask.usdc], { stdio: ["ignore", "pipe", "pipe"] });
          let stdout = "";
          let stderr = "";
          child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
          child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
          child.once("exit", (exit) => resolve({ exit, stdout: stdout.trim(), stderr: stderr.trim() }));
        });
        this.record({ t: new Date().toISOString(), kind: "paid", ...ask, ...result });
        // Exit 1 with `"status":"pending"` means sent but unconfirmed: never resend, look the hash up instead. Any
        // failure other than a refusal before sending is left for a person (see `isRefusalBeforeSend`).
        if (result.exit === 0 || !isRefusalBeforeSend(result.stderr) || attempt >= 3) return true;
        await new Promise((r) => setTimeout(r, 10_000 + Math.floor(Math.random() * 10_000)));
      }
    } finally {
      release();
    }
  }
}

/** True only for the pay helper's refusal while another transaction from the deployer is pending: it refused before
 *  signing anything, so a retry once that one confirms is safe. Not "the send failed and <hash> is not on the
 *  chain": the helper's lookup cannot tell a dropped send from a rate-limited lookup, so that one is left for a
 *  person, and so is `"status":"pending"`, which is never resent. */
export function isRefusalBeforeSend(stderr: string): boolean {
  return /refusing: the deployer has a pending transaction/.test(stderr);
}

/** One pay at a time per pay helper, across every watcher process on this machine. The live run's two watchers paid
 *  from the one deployer at the same moment, both read the same nonce, and the second send failed ("Transaction
 *  creation failed"). An exclusive lock file in the tmp dir, keyed by the helper's path; a lock older than 5 minutes
 *  (a watcher killed mid-pay -- the helper itself gives up on a receipt after 3) is taken over. */
async function payLock(pay: string): Promise<() => void> {
  const path = join(tmpdir(), `claude-human-pay-${createHash("sha256").update(pay).digest("hex").slice(0, 16)}.lock`);
  for (;;) {
    try {
      closeSync(openSync(path, "wx"));
      return () => {
        try {
          unlinkSync(path);
        } catch {
          // already gone
        }
      };
    } catch {
      try {
        if (Date.now() - statSync(path).mtimeMs > 5 * 60_000) unlinkSync(path);
      } catch {
        // released meanwhile
      }
      await new Promise((r) => setTimeout(r, 1_000));
    }
  }
}
