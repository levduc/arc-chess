/**
 * Live agent run (Arc testnet): the "human" side of `scripts/claude-opponent.ts --human-pay <pay helper>`.
 *
 * On a testnet stack (`pnpm testnet:up`) there is no faucet: the agent must ask its human for USDC, exactly as a
 * real user's agent would. This watcher plays that human. It tails the session's `stream-json` log, reads only what
 * a human would see -- the agent's own text (assistant text blocks and the final `result`), never the CLI output in
 * tool results -- and, when the agent asks for USDC to be sent to its own wallet, pays exactly that amount once
 * through the stack's pay helper (`<dir>/bin/pay <address> <usdc>`, which signs from the testnet deployer; this
 * file never sees that key).
 *
 * The agent's wallet address comes from the CLI's own read-only `arena wallet` in the agent's `ARENA_HOME` -- never
 * from `wallet.json`. An ask naming any other address (the owner's, an opponent's) is logged and never paid.
 *
 * Every decision is appended to a JSON-lines ledger, with an ISO timestamp, *before* the pay helper runs, so a
 * resumed session (`--resume`) or a crash mid-payment can never pay the same ask twice. Node built-ins only, like
 * `tests/system/claude-sandbox.ts`.
 */
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";

/** One "send X USDC to 0x…" the agent put in front of its human. */
export type FundingAsk = { usdc: string; address: string };

/** One line of the ledger. `pay` is written before the helper runs; `paid` after it returns. */
export type LedgerEntry =
  | { t: string; kind: "ask"; usdc: string; address: string; text: string }
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
  private pending: Array<{ ask: FundingAsk; text: string }> = [];
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
          for (const text of agentTexts(line)) {
            const asks = parseFundingAsks(text);
            for (const ask of asks) this.pending.push({ ask, text });
            // Something that reads like an ask but did not parse is never paid by guesswork: flag it for a person.
            if (asks.length === 0 && /\bsend\b/i.test(text) && /USDC/.test(text) && /0x[0-9a-fA-F]{40}/.test(text)) {
              this.record({ t: new Date().toISOString(), kind: "note", text: `possible ask not parsed: ${text.slice(0, 600)}` });
            }
          }
        }
      }
      const queue = this.pending;
      this.pending = [];
      for (const { ask, text } of queue) if (!(await this.handle(ask, text))) this.pending.push({ ask, text });
    } finally {
      this.busy = false;
    }
  }

  /** False when the ask could not be decided yet (no wallet address): the caller keeps it queued. */
  private async handle(ask: FundingAsk, text: string): Promise<boolean> {
    const key = `${ask.address.toLowerCase()}:${ask.usdc}`;
    if (!this.seen.has(key)) {
      this.seen.add(key);
      this.record({ t: new Date().toISOString(), kind: "ask", ...ask, text: text.slice(0, 600) });
    }
    const wallet = this.walletAddress();
    if (wallet === undefined) return false;
    const verdict = decide(ask, wallet, readLedger(this.o.ledgerPath), this.o.budget);
    if (!verdict.pay) {
      if (verdict.why !== "already paid this ask") this.record({ t: new Date().toISOString(), kind: "skip", ...ask, why: verdict.why });
      return true;
    }
    this.record({ t: new Date().toISOString(), kind: "pay", ...ask });
    const result = await new Promise<{ exit: number | null; stdout: string; stderr: string }>((resolve) => {
      const child = spawn(this.o.pay, [ask.address, ask.usdc], { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
      child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
      child.once("exit", (exit) => resolve({ exit, stdout: stdout.trim(), stderr: stderr.trim() }));
    });
    // Exit 1 with `"status":"pending"` means sent but unconfirmed: never resend, look the hash up instead.
    this.record({ t: new Date().toISOString(), kind: "paid", ...ask, ...result });
    return true;
  }
}
