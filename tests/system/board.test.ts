/**
 * Plan 5 Task 4: the web board end-to-end, in a real headless Chrome driven by playwright-core, against real `arena
 * daemon` processes, the real host server and a real chain (Anvil). It proves the human-agent handoff works (spec
 * §1 success criterion 4) and that the board's security holds (the plan's Review Focus 1-5).
 *
 * Every wait is on observable state: a DOM condition through Playwright's own waiting, a daemon status poll
 * (`waitStatus`), or an on-chain read. There are no fixed sleeps. Balances are exact on-chain `balanceOf` reads.
 *
 * Two stacks keep the file inside its runtime budget:
 * - scenario 1 (handoff round trip) runs on its own channel, closes it, and then checks the session-gas sweep of
 *   that same channel (scenario 7);
 * - scenarios 2 to 5 share a second channel, in order: controller boundary (agent in control), a challenge the
 *   human answers, an XSS note, then the hostile-origin and DNS-rebinding checks.
 * Token hygiene (scenario 6) is asserted on every board session the file opens (`expectTokenHygiene`). Final fix wave
 * (M1): `arena board` prints a one-time code, never the token; the board trades it for the token (POST
 * /board/session) and keeps the token in memory. Scenario 8 reads Chrome's own History database to prove the token
 * never lands there.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, request as httpRequest, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { createPublicClient, http, type Hex, type PublicClient } from "viem";
import { foundry } from "viem/chains";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { HubClient, type SessionSnapshot } from "@arena/sdk";
import { readJson, type ChannelRecord } from "@arena/cli";
import { runCli, startStack, usdcBalanceOf, type Player, type Stack } from "./harness.js";
import { playLine, waitStatus, type Status } from "./bot.js";
import { launchChrome, launchChromeWithProfile, NO_CHROME_MESSAGE, skipIfNoChrome } from "./browser.js";

const SCHOLARS_MATE = ["e2e4", "e7e5", "d1h5", "b8c6", "f1c4", "g8f6", "h5f7"];

const DEPOSIT = 1_000_000n;
const STAKE = 100_000n;
const START = 10_000_000n;
const FEE = 5_000n;
const TIMEOUT = 60; // the hub's MIN_TIMEOUT

// Per-scenario wall-clock times, printed at the end of the file.
const times: Array<{ name: string; ms: number }> = [];
afterAll(() => {
  for (const t of times) console.log(`[board timing] ${(t.ms / 1000).toFixed(1)}s  ${t.name}`);
});
function timed(name: string, fn: () => Promise<void>, ms: number): void {
  it(
    name,
    async () => {
      const t0 = Date.now();
      try {
        await fn();
      } finally {
        times.push({ name, ms: Date.now() - t0 });
      }
    },
    ms,
  );
}

// Every test launches its own browser; the suite's afterEach always closes it, pass or fail.
let browser: Browser | undefined;

// ------------------------------------------------------------------------------------------------ chain helpers

function hubOf(s: Stack): { pub: PublicClient; hub: HubClient } {
  const pub = createPublicClient({ chain: foundry, transport: http(s.rpcUrl) }) as PublicClient;
  return { pub, hub: new HubClient(s.hub, pub) };
}

async function waitFor<T>(
  fn: () => Promise<T> | T,
  ms = 20_000,
  what = "condition",
): Promise<Exclude<T, undefined | null | false>> {
  const end = Date.now() + ms;
  let last: unknown;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v as Exclude<T, undefined | null | false>;
    } catch (err) {
      last = err;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out after ${ms}ms waiting for ${what}${last ? `: ${String(last)}` : ""}`);
}

async function waitPhase(hub: HubClient, id: Hex, phase: string, ms = 20_000): Promise<void> {
  await waitFor(async () => (await hub.channelInfo(id)).phase === phase, ms, `on-chain phase ${phase}`);
}

/** Alice offers (challengeTimeout 60 s, the hub's minimum), Bob accepts, and both daemons see the channel Open. */
async function matchAndOpen(alice: Player, bob: Player): Promise<Hex> {
  const { offerId } = await alice.api("POST", "/offers", {
    deposit: DEPOSIT.toString(),
    stakePerGame: STAKE.toString(),
    challengeTimeout: String(TIMEOUT),
  });
  await bob.api("POST", "/offers/accept", { offerId });
  const id = await waitFor(async () => {
    const channels = (await bob.api("GET", "/channels")) as Array<{ channelId: Hex }>;
    return channels[0]?.channelId;
  }, 20_000, "bob's channel");
  await waitStatus(alice, (s) => s.phase === "Open", 30_000, id);
  await waitStatus(bob, (s) => s.phase === "Open", 30_000, id);
  return id;
}

/** Cooperative close from both sides of a finished game, then waits for Finalized on chain and in both daemons. */
async function closeBoth(a: Player, b: Player, id: Hex, hub: HubClient): Promise<void> {
  const aStatus = (await a.api("GET", `/status?channel=${id}`)) as Status;
  await waitStatus(b, (s) => s.turnNum === aStatus.turnNum, 15_000, id);
  await a.api("POST", "/close", { channel: id });
  await waitStatus(b, (s) => s.opponentWantsToClose === true, 15_000, id);
  await b.api("POST", "/close", { channel: id });
  await waitPhase(hub, id, "Finalized");
  await waitStatus(a, (s) => s.phase === "Finalized", 20_000, id);
  await waitStatus(b, (s) => s.phase === "Finalized", 20_000, id);
}

async function expectBalances(s: Stack, want: Array<[Player | "host", bigint]>): Promise<void> {
  for (const [who, amount] of want) {
    const addr = who === "host" ? s.host : who.address;
    expect(await usdcBalanceOf(s, addr), `${who === "host" ? "host" : who.name}'s USDC`).toBe(amount);
  }
}

async function expectNoErrors(...players: Player[]): Promise<void> {
  for (const p of players) {
    const chs = (await p.api("GET", "/channels")) as Array<{ channelId: Hex; lastError: string | null }>;
    for (const c of chs) expect(c.lastError, `${p.name}'s lastError on ${c.channelId}`).toBeNull();
  }
}

function sessionSnapshot(p: Player, id: Hex): SessionSnapshot {
  const snap = readJson<SessionSnapshot>(join(p.home, "channels", id, "session.json"));
  if (!snap) throw new Error(`${p.name} has no session.json for ${id}`);
  return snap;
}

// ------------------------------------------------------------------------------------------------ board helpers

type BoardSession = {
  page: Page;
  token: string;
  /** The link `arena board` printed, and the one-time code in its fragment. */
  link: string;
  code: string;
  /** Every request the page made: its URL, its Referer, and whether it carried the token as a bearer header. */
  requests: Array<{ url: string; referer: string | undefined; bearer: boolean }>;
  pageErrors: string[];
  cspViolations: string[];
};

/** The link `arena board` prints for `p`: `<api>/board#code=<one-time code>` (final fix wave M1), never the token. */
async function boardLink(p: Player): Promise<{ link: string; code: string }> {
  const printed = await runCli(["board"], p.home);
  expect(printed.status).toBe(0);
  const link = printed.stdout.trim();
  expect(link).not.toContain(p.token);
  const code = link.startsWith(`${p.apiUrl}/board#code=`) ? link.slice(`${p.apiUrl}/board#code=`.length) : "";
  expect(code, `the printed link ${link}`).toMatch(/^[A-Za-z0-9_-]{22}$/);
  return { link, code };
}

/** Opens `p`'s board from the link `arena board` prints, recording every request. */
async function openBoard(b: Browser | BrowserContext, p: Player): Promise<BoardSession> {
  const { link, code } = await boardLink(p);
  const page = await b.newPage();
  const session: BoardSession = { page, token: p.token, link, code, requests: [], pageErrors: [], cspViolations: [] };
  page.on("request", (r) => {
    const headers = r.headers();
    const bearer = headers["authorization"] === `Bearer ${p.token}`;
    session.requests.push({ url: r.url(), referer: headers["referer"], bearer });
  });
  page.on("pageerror", (err) => session.pageErrors.push(String(err)));
  page.on("console", (m) => {
    if (/content security policy/i.test(m.text())) session.cspViolations.push(m.text());
  });
  await page.goto(link);
  // The app traded the code for the token and booted: the app shell is shown, the gate is not.
  await page.locator("#app").waitFor({ state: "visible" });
  expect(await page.getByTestId("missing-token").isHidden()).toBe(true);
  // Scenario 6: the board removed the code from the address bar (the browser's history still keeps the link it
  // opened -- which is why that link carries a single-use code, not the token; scenario 8 reads that history).
  expect(await page.evaluate(() => (globalThis as any).location.hash)).toBe("");
  expect(page.url()).toBe(`${p.apiUrl}/board`);
  return session;
}

/**
 * Scenario 6 (token hygiene): the token is in no request URL (Playwright reports the navigation without its
 * fragment, as it goes on the wire) and no Referer, while the API calls, `/events` included, do carry it as a bearer
 * header -- so the check is not vacuous. Also: no uncaught page error and no CSP violation during the whole session.
 */
function expectTokenHygiene(s: BoardSession): void {
  // The token came from the one-time code exchange, not from the link.
  expect(s.requests.some((r) => new URL(r.url).pathname === "/board/session" && !r.bearer)).toBe(true);
  expect(s.requests.filter((r) => r.bearer).length).toBeGreaterThan(1);
  expect(s.requests.some((r) => r.bearer && new URL(r.url).pathname === "/events")).toBe(true);
  for (const r of s.requests) {
    expect(r.url, "a request URL").not.toContain(s.token);
    expect(r.referer ?? "", "a Referer header").not.toContain(s.token);
  }
  expect(s.pageErrors).toEqual([]);
  expect(s.cspViolations).toEqual([]);
}

/** Waits until the element with `data-testid=testid` has exactly `want` as its text. */
async function waitText(page: Page, testid: string, want: string, timeout = 15_000): Promise<void> {
  try {
    await page.waitForFunction(
      ([id, text]) => (globalThis as any).document.querySelector(`[data-testid="${id}"]`)?.textContent === text,
      [testid, want] as const,
      { timeout },
    );
  } catch (err) {
    const now = await page.getByTestId(testid).textContent().catch(() => "(unreadable)");
    throw new Error(
      `waiting for ${testid} to read ${JSON.stringify(want)}; it reads ${JSON.stringify(now)}: ${String(err)}`,
    );
  }
}

/** Plays `from`-`to` by clicking, the way a person does: the piece (once the board offers it), then the target. */
async function clickMove(page: Page, from: string, to: string): Promise<void> {
  await page.locator(`[data-testid="square-${from}"].is-movable`).waitFor({ timeout: 15_000 });
  await page.getByTestId(`square-${from}`).click();
  await page.locator(`[data-testid="square-${to}"]:is(.is-target, .is-capture)`).waitFor({ timeout: 5_000 });
  await page.getByTestId(`square-${to}`).click();
}

/** "m:ss" or "h:mm:ss" to seconds. */
function countdownSeconds(text: string | null): number {
  return (text ?? "").split(":").reduce((acc, part) => acc * 60 + Number(part), 0);
}

// -------------------------------------------------------------------------------------------------- node helpers

/** One raw HTTP request to the daemon's port with an explicit Host header (fetch() cannot set one). */
function rawRequest(
  port: number,
  opts: { method?: string; path: string; host: string; headers?: Record<string, string> },
): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const headers = { host: opts.host, ...(opts.headers ?? {}) };
    const req = httpRequest(
      { host: "127.0.0.1", port, method: opts.method ?? "GET", path: opts.path, headers },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.once("error", reject);
    req.end();
  });
}

function listen(server: Server, port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve((server.address() as AddressInfo).port));
  });
}

// ---------------------------------------------------------------------------------------------------- scenarios

if (skipIfNoChrome) console.log(`[board] ${NO_CHROME_MESSAGE}`);
const suite = skipIfNoChrome ? describe.skip : describe;

suite(
  skipIfNoChrome
    ? `web board end-to-end (${NO_CHROME_MESSAGE})`
    : "web board end-to-end (real Chrome, real daemons, real chain)",
  () => {
    // Every scenario runs on its own fresh stack and channel, so one failing never cascades into the next. The
    // browser closes first, so no page is left talking to a daemon that is shutting down.
    let stack: Stack | undefined;
    afterEach(async () => {
      await browser?.close().catch(() => undefined);
      browser = undefined;
      await stack?.stop();
      stack = undefined;
    }, 30_000);

    /** A fresh stack, Alice and Bob, and one Open channel between them (Alice is white in game 0). */
    type Fresh = { s: Stack; alice: Player; bob: Player; hub: HubClient; pub: PublicClient; id: Hex };
    async function freshChannel(): Promise<Fresh> {
      const s = await startStack();
      stack = s;
      const alice = await s.player("alice");
      const bob = await s.player("bob");
      const { hub, pub } = hubOf(s);
      const id = await matchAndOpen(alice, bob);
      return { s, alice, bob, hub, pub, id };
    }

    timed(
      "1. the agent hands the seat to a human, the human plays by clicking and hands back, the agent mates and closes (+ 6 token hygiene, 7 settle and sweep)",
      async () => {
        const { s, alice, bob, hub, pub, id } = await freshChannel();

        // The agents play one move each.
        await playLine(alice, bob, id, SCHOLARS_MATE.slice(0, 2));

        // Alice's agent hands the seat to her human.
        const NOTE = "your move, try the Italian";
        const handed = (await alice.api("POST", "/handoff", { channel: id, to: "human", note: NOTE })) as Status;
        expect(handed.controller).toBe("human");

        browser = await launchChrome();
        const board = await openBoard(browser, alice);
        const { page } = board;
        await waitText(page, "controller-badge", "Human");
        await waitText(page, "handoff-note", NOTE);

        // The human plays Qh5 by clicking; Bob's daemon receives it.
        await clickMove(page, "d1", "h5");
        await waitStatus(bob, (s) => s.turnNum === "3", 15_000, id);
        const afterHuman = (await alice.api("GET", `/status?channel=${id}`)) as Status & {
          lastMove: { from: string; to: string } | null;
        };
        expect(afterHuman.lastMove).toMatchObject({ from: "d1", to: "h5" });
        await page.locator('[data-testid="square-h5"][data-piece="Q"]').waitFor();

        // While the human holds the seat the agent's own move is refused, and nothing is signed.
        const signedBefore = sessionSnapshot(alice, id).lastSignedTurn;
        await expect(alice.api("POST", "/move", { channel: id, move: "f1c4" })).rejects.toThrow(
          /-> 409: the human is in control/,
        );
        expect(sessionSnapshot(alice, id).lastSignedTurn).toBe(signedBefore);

        // Bob's agent answers; it is Alice's (the human's) turn again.
        await playLine(alice, bob, id, ["b8c6"]);
        await waitStatus(alice, (s) => s.myTurn && s.turnNum === "4", 15_000, id);

        // The agent's long-poll is in flight before the human hands back. The status round trip after it is only
        // there to let the wait's request reach the daemon first; the wait must still be pending once it is back.
        let waitSettled = false;
        const waiting = alice.api("GET", `/wait?channel=${id}&timeout=60`).finally(() => (waitSettled = true));
        await alice.api("GET", `/status?channel=${id}`);
        expect(waitSettled).toBe(false);

        const BACK = "back to you: Bc4 next, then mate on f7";
        await page.getByTestId("hand-back-note").fill(BACK);
        await page.getByTestId("hand-back").click();
        expect(await waiting).toEqual({ channelId: id, reason: "control-changed" });
        await waitText(page, "controller-badge", "Agent");
        const resumed = (await alice.api("GET", `/status?channel=${id}`)) as Status;
        expect(resumed.controller).toBe("agent");
        expect(resumed.note).toBe(BACK);

        // The agent plays on to mate; Bob's daemon auto-resigns the mated position. Alice's board follows along.
        await playLine(alice, bob, id, SCHOLARS_MATE.slice(4));
        await waitStatus(alice, (s) => s.gameStatus === "white_won", 15_000, id);
        await waitStatus(bob, (s) => s.gameStatus === "white_won", 15_000, id);
        await page.locator('[data-testid="square-f7"][data-piece="Q"]').waitFor();

        await closeBoth(alice, bob, id, hub);
        await expectBalances(s, [
          [alice, START + STAKE - FEE],
          [bob, START - STAKE - FEE],
          ["host", 2n * FEE],
        ]);
        await expectNoErrors(alice, bob);
        await page.locator("#fact-phase", { hasText: /^Finalized$/ }).waitFor();

        // 7. Settle and sweep: Alice's session-key gas goes back to her wallet.
        const swept = await waitStatus(alice, (s) => s.swept === true, 30_000, id);
        const sweptAmount = BigInt(swept.sweptAmount as string);
        const sweptTx = swept.sweptTx as Hex;
        expect(sweptAmount).toBeGreaterThan(0n);
        const record = readJson<ChannelRecord>(join(alice.home, "channels", id, "record.json"))!;
        const sessionKey = record.params.signers[record.me];
        const tx = await pub.getTransaction({ hash: sweptTx });
        const receipt = await pub.getTransactionReceipt({ hash: sweptTx });
        expect(receipt.status).toBe("success");
        expect(tx.from.toLowerCase()).toBe(sessionKey.toLowerCase());
        expect(tx.to?.toLowerCase()).toBe(alice.address.toLowerCase());
        expect(tx.value).toBe(sweptAmount);

        // The wallet rose by exactly the swept amount across the sweep's block, less its own gas for anything it
        // sent in that same block (Anvil automines one transaction per block, so normally nothing).
        const n = receipt.blockNumber;
        const block = await pub.getBlock({ blockNumber: n, includeTransactions: true });
        let walletGas = 0n;
        for (const t of block.transactions) {
          if (t.from.toLowerCase() !== alice.address.toLowerCase()) continue;
          const r = await pub.getTransactionReceipt({ hash: t.hash });
          walletGas += r.gasUsed * r.effectiveGasPrice;
        }
        const walletBefore = await pub.getBalance({ address: alice.address, blockNumber: n - 1n });
        const walletAfter = await pub.getBalance({ address: alice.address, blockNumber: n });
        expect(walletAfter - walletBefore).toBe(sweptAmount - walletGas);
        expect(walletAfter).toBeGreaterThan(walletBefore);

        // The session key: exact conservation across the sweep, nothing after it, and what is left is at most
        // gas x F x 1.3 (the sweep's own fee reserve, F its fee per gas).
        const sessionBefore = await pub.getBalance({ address: sessionKey, blockNumber: n - 1n });
        const sessionAt = await pub.getBalance({ address: sessionKey, blockNumber: n });
        expect(sessionAt).toBe(sessionBefore - tx.value - receipt.gasUsed * receipt.effectiveGasPrice);
        const residual = await pub.getBalance({ address: sessionKey });
        expect(residual).toBe(sessionAt);
        const feePerGas = tx.maxFeePerGas ?? tx.gasPrice ?? 0n;
        expect(feePerGas).toBeGreaterThan(0n);
        expect(residual).toBeLessThanOrEqual((tx.gas * feePerGas * 13n) / 10n);
        console.log(`[board] sweep: ${sweptAmount} wei back to the wallet; ${residual} wei left on the session key`);

        expectTokenHygiene(board);
      },
      150_000,
    );

    timed(
      "2. controller boundary: with the agent in control, a click shows no targets and a forced human move gets 409 with no signature",
      async () => {
        const { alice, bob, id } = await freshChannel();
        const st0 = await waitStatus(alice, (s) => s.phase === "Open" && s.myTurn, 15_000, id);
        expect(st0.controller).toBe("agent");
        expect(st0.turnNum).toBe("0");

        browser = await launchChrome();
        const board = await openBoard(browser, alice);
        const { page } = board;
        await waitText(page, "controller-badge", "Agent");
        await page.locator('[data-testid="square-e2"][data-piece="P"]').waitFor();

        // The board is disabled for the human (aria-disabled, so Playwright's own actionability check refuses a
        // normal click). A forced click on one of the human's own pieces, on the human's own turn, still selects and
        // targets nothing.
        expect(await page.getByTestId("square-e2").isEnabled()).toBe(false);
        await page.getByTestId("square-e2").click({ force: true });
        expect(await page.locator("#board :is(.is-selected, .is-target, .is-capture, .is-movable)").count()).toBe(0);
        expect(await page.locator("#board").getAttribute("aria-disabled")).toBe("true");
        expect(await page.getByTestId("take-over").isVisible()).toBe(true);

        // A forced move straight through the API as the human: refused, and nothing is signed or sent.
        const before = sessionSnapshot(alice, id);
        await expect(alice.api("POST", "/move", { channel: id, move: "e2e4" }, "human")).rejects.toThrow(
          /-> 409: the agent is in control/,
        );
        await expect(alice.api("POST", "/resign", { channel: id }, "human")).rejects.toThrow(
          /-> 409: the agent is in control/,
        );
        const after = sessionSnapshot(alice, id);
        expect(after.lastSignedTurn).toBe(before.lastSignedTurn);
        expect(after.latest.state.turnNum).toBe(before.latest.state.turnNum);
        expect(((await bob.api("GET", `/status?channel=${id}`)) as Status).turnNum).toBe("0");

        // The same move from the controller (the agent) goes through: the refusal was about who, not what.
        await playLine(alice, bob, id, ["e2e4"]);
        await page.locator('[data-testid="square-e4"][data-piece="P"]').waitFor();
        expect(sessionSnapshot(alice, id).lastSignedTurn).toBe(1n);

        expectTokenHygiene(board);
      },
      60_000,
    );

    timed(
      "3. challenge while the human holds the seat: mustMove banner, a countdown that runs down, and the clicked move lands via respond",
      async () => {
        const { alice, bob, hub, pub, id } = await freshChannel();
        await playLine(alice, bob, id, ["e2e4", "e7e5"]); // turn 2: Alice (white) to move
        const note = "Bob may challenge: answer on the board";
        await alice.api("POST", "/handoff", { channel: id, to: "human", note });

        browser = await launchChrome();
        const board = await openBoard(browser, alice);
        const { page } = board;
        await waitText(page, "controller-badge", "Human");
        await page.locator('[data-testid="square-g1"].is-movable').waitFor();

        await bob.api("POST", "/challenge", { channel: id });
        await waitPhase(hub, id, "Challenged");
        await page.getByTestId("must-move-banner").waitFor({ state: "visible", timeout: 15_000 });
        const countdown = page.getByTestId("countdown");
        await countdown.waitFor({ state: "visible" });
        const first = countdownSeconds(await countdown.textContent());
        expect(first).toBeGreaterThan(0);
        expect(first).toBeLessThanOrEqual(TIMEOUT);
        // It runs down between chain blocks (Anvil mines none while nothing is sent).
        await page.waitForFunction(
          (limit) => {
            const node = (globalThis as any).document.querySelector('[data-testid="countdown"]');
            const text: string = node?.textContent ?? "";
            const left = text.split(":").reduce((acc, part) => acc * 60 + Number(part), 0);
            return text !== "" && left < limit;
          },
          first,
          { timeout: 5_000 },
        );

        // The human answers by clicking Nf3; the daemon submits it on-chain through respond.
        await clickMove(page, "g1", "f3");
        await waitPhase(hub, id, "Open", 30_000);
        const responded = (await hub.disputeEvents(id)).filter((e) => e.kind === "Responded");
        expect(responded).toHaveLength(1);
        expect((await hub.registeredState(id)).turnNum).toBe(3n);
        await waitStatus(alice, (s) => s.phase === "Open" && s.turnNum === "3" && s.challenge === null, 15_000, id);
        await waitStatus(bob, (s) => s.phase === "Open" && s.turnNum === "3" && s.myTurn, 15_000, id);
        await page.getByTestId("must-move-banner").waitFor({ state: "hidden", timeout: 15_000 });
        await page.getByTestId("countdown").waitFor({ state: "hidden", timeout: 15_000 });
        // Informational: either daemon may land the respond (Bob's watchtower also holds turn 3 once it is relayed).
        const tx = await pub.getTransaction({ hash: responded[0].transactionHash });
        const params = await hub.channelParams(id);
        const responder = tx.from.toLowerCase() === params.signers[0].toLowerCase() ? "alice" : "bob";
        console.log(`[board] respond submitted by ${responder}'s session key`);
        await expectNoErrors(alice, bob);

        expectTokenHygiene(board);
      },
      60_000,
    );

    timed(
      "4. XSS: a handoff note carrying HTML and an inline handler renders as inert text",
      async () => {
        const { alice, id } = await freshChannel();
        const XSS = "<img src=x onerror=window.__pwned=1><b>x</b>";
        await alice.api("POST", "/handoff", { channel: id, to: "human", note: XSS });

        browser = await launchChrome();
        const board = await openBoard(browser, alice);
        const { page } = board;
        await waitText(page, "handoff-note", XSS);
        expect(await page.locator('[data-testid="handoff-note"] *').count()).toBe(0);
        expect(await page.locator("img").count()).toBe(0);
        expect(await page.evaluate(() => (globalThis as any).__pwned)).toBeUndefined();

        // The other direction: HTML the human types into the hand-back note reaches the agent verbatim.
        const TYPED = "<script>alert(1)</script> keep the queen";
        await page.getByTestId("hand-back-note").fill(TYPED);
        await page.getByTestId("hand-back").click();
        await waitText(page, "controller-badge", "Agent");
        await waitText(page, "handoff-note", TYPED);
        expect(((await alice.api("GET", `/status?channel=${id}`)) as Status).note).toBe(TYPED);
        expect(await page.locator('[data-testid="handoff-note"] *').count()).toBe(0);
        expect(await page.evaluate(() => (globalThis as any).__pwned)).toBeUndefined();

        expectTokenHygiene(board);
      },
      60_000,
    );

    timed(
      "5. hostile origin and DNS rebinding: another origin reads nothing, a foreign Host gets 421, the board loads only on the exact host",
      async () => {
        const { alice, id } = await freshChannel();
        const port = Number(new URL(alice.apiUrl).port);
        // A hostile page on another loopback address. Chrome resolves attacker.example to it, and rebind.example to
        // the daemon's own address: the state of the world right after a DNS-rebinding attack's switch.
        const hostile = createServer((_req, res) => {
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          res.end("<!doctype html><title>totally harmless</title><p>nothing to see here</p>");
        });
        const hostilePort = await listen(hostile, 0, "127.0.0.2");
        try {
          browser = await launchChrome({
            args: ["--host-resolver-rules=MAP attacker.example 127.0.0.2, MAP rebind.example 127.0.0.1"],
          });
          const page = await browser.newPage();
          // The daemon logs no requests, so its answers are read off the wire through the DevTools protocol:
          // responseReceivedExtraInfo carries the real status even for a response CORS then hides from the page.
          const cdp = await page.context().newCDPSession(page);
          await cdp.send("Network.enable");
          const daemonRequests = new Map<string, string>();
          const daemonStatuses = new Map<string, number>();
          cdp.on("Network.requestWillBeSent", (e) => {
            if (new URL(e.request.url).port !== String(port)) return;
            daemonRequests.set(e.requestId, `${e.request.method} ${e.request.url}`);
          });
          cdp.on("Network.responseReceivedExtraInfo", (e) => daemonStatuses.set(e.requestId, e.statusCode));

          await page.goto(`http://attacker.example:${hostilePort}/`);
          type Attempt = { error?: string; type?: string; status?: number; body?: string };
          const results: Record<string, Attempt> = await page.evaluate(async (base: string) => {
            const attempt = async (path: string, init?: RequestInit) => {
              try {
                const r = await fetch(`${base}${path}`, init);
                return { type: r.type, status: r.status, body: await r.text() };
              } catch (err) {
                return { error: String(err) };
              }
            };
            return {
              plain: await attempt("/channels"),
              noCors: await attempt("/channels", { mode: "no-cors" }),
              guessedToken: await attempt("/channels", { headers: { authorization: "Bearer guessed" } }),
              // A "simple" cross-origin POST (text/plain, so no preflight): the classic CSRF shape.
              csrf: await attempt("/handoff", {
                method: "POST",
                headers: { "content-type": "text/plain" },
                body: '{"to":"human"}',
              }),
            };
          }, `http://127.0.0.1:${port}`);
          expect(results.plain).toEqual({ error: "TypeError: Failed to fetch" });
          expect(results.noCors).toEqual({ type: "opaque", status: 0, body: "" });
          expect(results.guessedToken).toEqual({ error: "TypeError: Failed to fetch" });
          expect(results.csrf).toEqual({ error: "TypeError: Failed to fetch" });
          // On the wire: 401 for everything that reached a route (no token) and 405 for the one preflight; the
          // guessed-token GET behind that failed preflight never went out at all. Never a 2xx.
          const answered = () => [...daemonRequests.keys()].filter((k) => daemonStatuses.has(k));
          await waitFor(() => answered().length >= 4, 5_000, "the daemon's four answers on the wire");
          const onWire = answered().map((k) => daemonStatuses.get(k)!);
          expect(onWire.sort()).toEqual([401, 401, 401, 405]);
          expect([...daemonRequests.values()].filter((r) => r.startsWith("OPTIONS "))).toHaveLength(1);
          // The CSRF POST changed nothing.
          expect(((await alice.api("GET", `/status?channel=${id}`)) as Status).controller).toBe("agent");

          // After the rebinding switch, the attacker's own name points at the daemon: 421, even for the board.
          // (Chrome then shows its own error page, which is why each navigation below gets a fresh tab.)
          const rebindPage = await browser.newPage();
          const rebound = rebindPage.waitForResponse((r) => r.url().startsWith(`http://rebind.example:${port}/`));
          await rebindPage.goto(`http://rebind.example:${port}/board`).catch(() => undefined);
          expect((await rebound).status()).toBe(421);

          // The exact host still serves the static board (with no code in this link: the gate).
          const exactPage = await browser.newPage();
          const ok = await exactPage.goto(`http://127.0.0.1:${port}/board`);
          expect(ok?.status()).toBe(200);
          await exactPage.getByTestId("missing-token").waitFor({ state: "visible" });

          // Final fix wave (M1): an old `#token=` link is no longer accepted, even with the right token -- the board
          // shows the expired-link gate and never uses it.
          const legacyPage = await browser.newPage();
          const legacyBearer: string[] = [];
          legacyPage.on("request", (r) => {
            if (r.headers()["authorization"]) legacyBearer.push(r.url());
          });
          await legacyPage.goto(`http://127.0.0.1:${port}/board#token=${alice.token}`);
          await legacyPage.getByTestId("missing-token").waitFor({ state: "visible" });
          await waitText(legacyPage, "gate-reason", "This link has expired — run `arena board` again");
          expect(legacyPage.url()).toBe(`http://127.0.0.1:${port}/board`);
          expect(legacyBearer).toEqual([]);
        } finally {
          await new Promise<void>((r) => hostile.close(() => r()));
        }

        // Node side: the Host guard, with and without the right token.
        const host = `127.0.0.1:${port}`;
        expect((await rawRequest(port, { path: "/board", host: `attacker.example:${port}` })).status).toBe(421);
        const withToken = await rawRequest(port, {
          path: "/channels",
          host: `attacker.example:${port}`,
          headers: { authorization: `Bearer ${alice.token}` },
        });
        expect(withToken.status).toBe(421);
        expect(withToken.body).toBe("");
        expect((await rawRequest(port, { path: "/board", host })).status).toBe(200);
        expect((await rawRequest(port, { path: "/board", host: `localhost:${port}` })).status).toBe(200);
        const origin = "http://attacker.example";
        const noToken = await rawRequest(port, { path: "/channels", host, headers: { origin } });
        expect(noToken.status).toBe(401);
        expect(noToken.body).not.toContain(id.slice(2));
        const preflight = await rawRequest(port, {
          method: "OPTIONS",
          path: "/channels",
          host,
          headers: { origin, "access-control-request-method": "GET" },
        });
        expect(preflight.status).toBe(405);
        for (const r of [noToken, preflight]) {
          expect(Object.keys(r.headers).filter((k) => k.startsWith("access-control-"))).toEqual([]);
        }
      },
      60_000,
    );

    timed(
      "8. browser history (final fix wave M1): Chrome's own History database never holds the token, only the dead one-time code",
      async () => {
        const s = await startStack();
        stack = s;
        const alice = await s.player("alice");
        const profile = mkdtempSync(join(tmpdir(), "arena-board-profile-"));
        try {
          const printed = await runCli(["board"], alice.home);
          expect(printed.status).toBe(0);
          const link = printed.stdout.trim();
          const fragment = new URL(link).hash.replace(/^#/, "");
          const secret = new URLSearchParams(fragment).values().next().value ?? "";
          expect(secret).not.toBe("");
          const context = await launchChromeWithProfile(profile);
          try {
            const page = await context.newPage();
            await page.goto(link);
            await page.locator("#app").waitFor({ state: "visible" });
            await page.locator("#conn", { hasText: /^Live$/ }).waitFor(); // the /events stream is up: the token works
            expect(page.url()).toBe(`${alice.apiUrl}/board`);
          } finally {
            await context.close();
          }
          // Chrome writes its History database under the profile; read it once the browser has closed it.
          const db = new DatabaseSync(join(profile, "Default", "History"), { readOnly: true });
          let urls: string[];
          try {
            urls = (db.prepare("SELECT url FROM urls").all() as Array<{ url: string }>).map((r) => String(r.url));
          } finally {
            db.close();
          }
          console.log(`[board] history: ${urls.length} URL(s) recorded: ${urls.join(" | ")}`);
          // Not vacuous: the history did record the link it opened, fragment and all.
          expect(urls.some((u) => u.includes(secret))).toBe(true);
          for (const u of urls) expect(u, "a History URL").not.toContain(alice.token);

          // And what it holds is dead: the code is single-use, so the very same link opened again is refused.
          browser = await launchChrome();
          const again = await browser.newPage();
          await again.goto(link);
          await waitText(again, "gate-reason", "This link has expired — run `arena board` again");
        } finally {
          rmSync(profile, { recursive: true, force: true });
        }
      },
      60_000,
    );
  },
);
