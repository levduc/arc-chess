/**
 * Live agent run: `scripts/claude-opponent.ts`'s testnet options and `scripts/claude-human-watcher.ts`, the human who
 * pays the agent's funding ask. Never spends Claude usage: only `--help`, argument parsing and the watcher's pure
 * parsing/decision functions run here -- no `claude` process, no stack, no chain.
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fundDisclosure, fundMessage, tellYourHuman } from "../../packages/cli/src/funding.js";
import { buildPrompt, homePrefixRules, parseArgs, runPaths } from "../../scripts/claude-opponent.js";
import {
  agentTexts,
  decide,
  fundOutputAsks,
  isRefusalBeforeSend,
  microUsdc,
  parseFundingAsks,
  sessionIdOf,
  waitsForUsdc,
  type LedgerEntry,
} from "../../scripts/claude-human-watcher.js";

const REPO = join(import.meta.dirname, "../..");
const WALLET = "0x1111111111111111111111111111111111111111";
const OWNER = "0x840d6f90dd12A713CC5F1fb6EAbBF99e0E74A7E0";

describe("claude-opponent --help", () => {
  it("prints the testnet options and exits 0 without launching anything", () => {
    const r = spawnSync(join(REPO, "node_modules/.bin/tsx"), [join(REPO, "scripts/claude-opponent.ts"), "--help"], { encoding: "utf8" });
    expect(r.status).toBe(0);
    for (const flag of ["--dir", "--prompt", "--owner", "--human-pay", "--human-budget", "--keep-daemon", "--resume"]) {
      expect(r.stdout).toContain(flag);
    }
  });
});

describe("claude-opponent arguments", () => {
  it("keeps the dev defaults when no testnet option is given", () => {
    const a = parseArgs([]);
    expect(a).toMatchObject({ games: 3, stake: "1", minutes: 30, humanBudget: "3", keepDaemon: false });
    expect(a.dir).toBeUndefined();
    expect(buildPrompt(a)).toBe("Go to http://127.0.0.1:8080 and use your money to play 3 $1 games with whoever is available.");
  });

  it("appends the owner as the human's cash-out address, after a --prompt given verbatim", () => {
    const a = parseArgs(["--prompt", "Go to X and play.", "--owner", OWNER]);
    expect(buildPrompt(a)).toBe(`Go to X and play. My Arc address for cash-out is ${OWNER}.`);
  });

  it("sends --prompt alone as the human's reply on --resume", () => {
    const a = parseArgs(["--resume", "abc", "--dir", "/tmp/x", "--prompt", "Yes, withdraw.", "--owner", OWNER]);
    expect(buildPrompt(a)).toBe("Yes, withdraw.");
  });

  it("refuses --resume without the directory and the reply, a bad owner, and a bad budget", () => {
    expect(() => parseArgs(["--resume", "abc"])).toThrow(/--resume needs --dir/);
    expect(() => parseArgs(["--owner", "0x1234"])).toThrow(/--owner/);
    expect(() => parseArgs(["--human-budget", "1.0000001"])).toThrow(/--human-budget/);
  });

  it("puts ARENA_HOME at DIR/work/arena-home -- the $PWD/arena-home testnet:up's message names -- and logs in DIR", () => {
    const p = runPaths(parseArgs(["--dir", "/tmp/live/agent-a"]), "T");
    expect(p).toEqual({
      home: "/tmp/live/agent-a/work/arena-home",
      workDir: "/tmp/live/agent-a/work",
      logPath: "/tmp/live/agent-a/claude-T.log",
      ledgerPath: "/tmp/live/agent-a/human.jsonl",
    });
  });

  it("allows the ARENA_HOME-prefixed form of the CLI wrapper, pinned to that wrapper", () => {
    const rules = homePrefixRules("/h/arena-home", "/x/bin/arena");
    expect(rules).toContain("Bash(ARENA_HOME=$PWD/arena-home /x/bin/arena *)");
    expect(rules).toContain("Bash(ARENA_HOME=/h/arena-home /x/bin/arena *)");
    for (const r of rules) expect(r).toMatch(/^Bash\(ARENA_HOME=\S+ (\/x\/bin\/)?arena \*\)$/);
  });
});

describe("the human watcher's parsing", () => {
  it("reads the exact sentence arena fund prints on Arc Testnet", () => {
    const message = fundMessage(
      { deposit: 1_000_000n, feePerPlayer: 5_000n, usdc: { have: 0n, need: 1_351_234n, shortfall: 1_351_234n, reserved: 0n } },
      { address: WALLET, chainId: 5042002, ownerSet: false, games: 5n, stake: 100_000n },
    );
    expect(parseFundingAsks(message)).toEqual([{ usdc: "1.351234", address: WALLET }]);
  });

  it("reads an agent's markdown paraphrase, and ignores an address far from the amount", () => {
    expect(parseFundingAsks(`Please send **1.35 USDC** to \`${WALLET}\` on Arc Testnet.`)).toEqual([{ usdc: "1.35", address: WALLET }]);
    expect(parseFundingAsks(`Could you send me $1.35 USDC (Arc Testnet, chain 5042002) to ${WALLET}?`)).toEqual([{ usdc: "1.35", address: WALLET }]);
    expect(parseFundingAsks(`I'll send 0.5 USDC of winnings back.${" ".repeat(200)}Your address is ${OWNER}.`)).toEqual([]);
  });

  it("never guesses between two amounts before the address", () => {
    expect(parseFundingAsks(`send 1 USDC deposit plus 0.35 USDC gas to ${WALLET}`)).toEqual([]);
  });

  it("shows only what a human sees: the agent's text and its result, never a tool result", () => {
    const text = JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "hi" }, { type: "tool_use", input: {} }] } });
    const result = JSON.stringify({ type: "result", result: "done", session_id: "s-1", total_cost_usd: 1 });
    const tool = JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", content: `Please send 1 USDC to ${WALLET}` }] } });
    expect(agentTexts(text)).toEqual(["hi"]);
    expect(agentTexts(result)).toEqual(["done"]);
    expect(agentTexts(tool)).toEqual([]);
    expect(agentTexts("not json")).toEqual([]);
    expect(sessionIdOf(result)).toBe("s-1");
  });
});

describe("the human watcher's fund-output fallback (the first live agent never restated its ask)", () => {
  const fundJson = (message: string) =>
    JSON.stringify({ address: WALLET, usdc: { have: "0.000000", need: "1.361000", shortfall: "1.361000", reserved: "0.000000" }, message }, null, 2);
  const toolResult = (content: unknown) => JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", content }] } });
  const runs = (command: string) => JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command } }] } });

  it("reads arena fund's message out of its JSON output, as a string or as text blocks", () => {
    const out = fundJson(`Please send 1.361000 USDC to ${WALLET} on Arc Testnet (chain id 5042002), on the Arc Testnet network only.`);
    expect(fundOutputAsks(toolResult(out))).toEqual([{ usdc: "1.361000", address: WALLET }]);
    expect(fundOutputAsks(toolResult([{ type: "text", text: out }]))).toEqual([{ usdc: "1.361000", address: WALLET }]);
  });

  it("never reads an ask out of a tool result that is not fund's JSON (a curl of skill.md, an echo)", () => {
    expect(fundOutputAsks(toolResult(`Please send 1 USDC to ${WALLET}`))).toEqual([]);
    expect(fundOutputAsks(toolResult(JSON.stringify({ message: `Please send 1 USDC to ${WALLET}` })))).toEqual([]);
  });

  it("H4: fund's output now leads with tellYourHuman and disclosure -- still one ask, and the relayed text is the same ask", () => {
    const message = `Please send 1.361000 USDC to ${WALLET} on Arc Testnet (chain id 5042002), on the Arc Testnet network only.`;
    const disclosure = fundDisclosure({
      chainId: 5042002,
      hub: "0x9b8Bc44f261D09C94cA17b7b0281DD706f76bA41",
      audit: "unaudited; Arc TESTNET test stack, faucet USDC only. Hub limits: 2 USDC deposit per player",
      cap: 2_000_000n,
      feePerPlayer: 5_000n,
      owner: null,
    });
    const relay = tellYourHuman(disclosure, message, true);
    const out = JSON.stringify(
      { tellYourHuman: relay, disclosure, address: WALLET, usdc: { have: "0.000000", need: "1.361000", shortfall: "1.361000", reserved: "0.000000" }, message },
      null,
      2,
    );
    expect(fundOutputAsks(toolResult(out))).toEqual([{ usdc: "1.361000", address: WALLET }]);
    // The agent writes the text after the colon into its reply: the watcher's text path reads the same one ask.
    const said = relay.slice(relay.indexOf("): ") + 3);
    expect(parseFundingAsks(said)).toEqual([{ usdc: "1.361000", address: WALLET }]);
  });

  it("knows when the agent starts waiting for its human's USDC", () => {
    expect(waitsForUsdc(runs("ARENA_HOME=/h /x/bin/arena wallet --wait-for-usdc 1.361000 --timeout 100"))).toBe(true);
    expect(waitsForUsdc(runs("/x/bin/arena wallet"))).toBe(false);
    expect(waitsForUsdc(runs("/x/bin/arena fund --offer 0xab"))).toBe(false);
  });
});

describe("the human watcher's decision", () => {
  const ask = { usdc: "1.35", address: WALLET };
  const paid = (usdc: string): LedgerEntry => ({ t: "t", kind: "pay", usdc, address: WALLET });

  it("pays the agent's own wallet, once per ask", () => {
    expect(decide(ask, WALLET.toUpperCase().replace("0X", "0x"), [], "3")).toEqual({ pay: true });
    expect(decide(ask, WALLET, [paid("1.35")], "3")).toMatchObject({ pay: false, why: "already paid this ask" });
  });

  it("refuses another address, more than 3 USDC at once, and anything past the budget", () => {
    expect(decide({ usdc: "1", address: OWNER }, WALLET, [], "3")).toMatchObject({ pay: false });
    expect(decide({ usdc: "3.01", address: WALLET }, WALLET, [], "10")).toMatchObject({ pay: false });
    expect(decide({ usdc: "1.7", address: WALLET }, WALLET, [paid("1.35")], "3")).toMatchObject({ pay: false });
    expect(decide({ usdc: "1.65", address: WALLET }, WALLET, [paid("1.35")], "3")).toEqual({ pay: true });
  });

  it("retries only the helper's refusal before sending, never a send whose fate it could not see", () => {
    expect(isRefusalBeforeSend("testnet: refusing: the deployer has a pending transaction (nonce latest 7, pending 8)")).toBe(true);
    expect(isRefusalBeforeSend("testnet: the send failed and 0x3dc0 is not on the chain: Transaction creation failed.")).toBe(false);
    expect(isRefusalBeforeSend("pay: no receipt within 180s; do not resend until 0xab confirms or drops")).toBe(false);
    expect(isRefusalBeforeSend("refusing: the deployer holds 2.1 USDC; sending 1 would leave it under 2 USDC")).toBe(false);
  });

  it("does budget arithmetic in exact micro-USDC", () => {
    expect(microUsdc("1.351234")).toBe(1_351_234n);
    expect(microUsdc("3")).toBe(3_000_000n);
    expect(microUsdc("0.1")).toBe(100_000n);
  });
});
