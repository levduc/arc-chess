/**
 * Plan 6 hardening H3 (rate-limit resilience): Arc's public RPC answers a modest load with `-32005 "rate limit
 * exceeded"` or an HTTP 429 (Arc testnet rehearsal §8.2). The daemon must ride that out without mistaking it for
 * anything else -- above all, never for a refused range (spec §12 item 18): a skip on a rate limit would hide a
 * dispute event.
 */
import { LimitExceededRpcError, createPublicClient, type Hex, type PublicClient } from "viem";
import { afterEach, describe, expect, it } from "vitest";
import { HubClient, RPC_RETRY_COUNT, RPC_RETRY_DELAY_MS, TxReceiptMissingError, ZERO_HASH, rpcTransport } from "@arena/sdk";
import type { ArenaDaemon } from "../src/index.js";
import { DAEMON_RPC_TIMEOUT_MS, GAS_CHECK_BACKOFF_MAX_MS, GAS_CHECK_BACKOFF_START_MS, UNREADABLE_BLOCK_PASSES } from "../src/daemon.js";
import { autoReturnSecondsOf } from "../src/config.js";
import { RPC } from "../../sdk/test/helpers/chain.js";
import { startPair, waitFor } from "./helpers/harness.js";

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

async function matched() {
  const pair = await startPair();
  cleanup = pair.cleanup;
  const { offerId } = await pair.alice.daemon.createOffer({ deposit: 1_000_000n, stakePerGame: 100_000n, challengeTimeout: 600n });
  await pair.bob.daemon.acceptOffer(offerId);
  const id = await waitFor(async () => {
    const [a, b] = [pair.alice.daemon.channelIds(), pair.bob.daemon.channelIds()];
    return a.length === 1 && b.length === 1 && a[0] === b[0] ? a[0] : null;
  }, 20_000, "match");
  await waitFor(async () => (await pair.alice.daemon.hub.channelInfo(id)).phase === "Open", 20_000, "funding");
  return { ...pair, id };
}

/** Stops the daemon's periodic passes, so a test drives every scan itself. */
async function parked(daemon: ArenaDaemon) {
  clearInterval((daemon as unknown as { timer?: NodeJS.Timeout }).timer);
  await daemon.idle();
}

/**
 * Routes `daemon`'s dispute-event reads through viem's real HTTP transport (`rpcTransport`, retries shortened) over a
 * fake fetch in front of Anvil. While `limited`, every `eth_getLogs` for channel `id`'s events is answered `answer`.
 * The scan's probe -- the same query for the zero channel id -- is always served, as an intermittently rate-limited
 * RPC may serve it.
 */
function rateLimitScan(daemon: ArenaDaemon, hub: Hex, id: Hex, answer: "-32005" | "429") {
  const state = { limited: true, reads: [] as Array<[bigint, bigint]>, probes: 0 };
  const fetchFn = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const req = JSON.parse(String(init?.body)) as { id: number; method: string; params: Array<{ fromBlock: Hex; toBlock: Hex; topics?: unknown[] }> };
    if (req.method === "eth_getLogs") {
      const f = req.params[0];
      const topic1 = String(f.topics?.[1] ?? "").toLowerCase();
      if (topic1 === ZERO_HASH) state.probes++;
      else if (topic1 === id.toLowerCase()) {
        state.reads.push([BigInt(f.fromBlock), BigInt(f.toBlock)]);
        if (state.limited) {
          if (answer === "429") return new Response("Too Many Requests", { status: 429 });
          return new Response(JSON.stringify({ jsonrpc: "2.0", id: req.id, error: { code: -32005, message: "rate limit exceeded" } }), {
            headers: { "content-type": "application/json" },
          });
        }
      }
    }
    return fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: init?.body });
  };
  const client = createPublicClient({ transport: rpcTransport(RPC, { fetchFn, retryDelay: 1 }) }) as PublicClient;
  const fake = new HubClient(hub, client);
  daemon.hub.disputeEvents = fake.disputeEvents.bind(fake);
  return state;
}

describe("H3: a rate-limited dispute scan never splits a range nor skips a block", () => {
  for (const answer of ["-32005", "429"] as const) {
    it(`${answer}: the same range is read again on the next pass, uncounted and unprobed; then it is read`, async () => {
      const { alice, env, id } = await matched();
      await parked(alice.daemon);
      const l = alice.daemon.handle(id);
      const state = rateLimitScan(alice.daemon, env.hub, id, answer);
      const scan = () => (alice.daemon as unknown as { scanDisputes(l: unknown): Promise<void> }).scanDisputes(l);
      const before = l.record.scannedBlock;
      const head = await alice.daemon.hub.blockNumber();
      for (let i = 0; i <= UNREADABLE_BLOCK_PASSES; i++) await scan();
      // Before H3 each pass probed the range, split it down to one block and counted it: skipped at the third pass.
      expect(l.record.skippedEventBlocks).toBeUndefined();
      expect(l.unreadableBlock).toBeNull();
      expect(state.probes).toBe(0);
      expect(state.reads.length).toBeGreaterThan(0);
      expect(state.reads.every(([, to]) => to >= head)).toBe(true); // never a lower half
      expect(new Set(state.reads.map(([from]) => from)).size).toBe(1); // never an upper half
      expect(l.record.scannedBlock).toBe(before);
      expect(l.lastError).toMatch(answer === "429" ? /^events: HTTP request failed/ : /^events: Request exceeds defined limit/);
      state.limited = false;
      await scan();
      expect(l.lastError).toBeNull();
      expect(l.record.scannedBlock).toBeGreaterThanOrEqual(head);
      expect(l.record.skippedEventBlocks).toBeUndefined();
    });
  }
});

describe("H3: a rate-limited session-gas check backs off", () => {
  it("a failed balance read is not repeated before its back-off (5 s, doubling to 60 s); a read that succeeds ends it", async () => {
    const { alice, id } = await matched();
    await parked(alice.daemon);
    const d = alice.daemon;
    const l = d.handle(id);
    const key = l.sessionSender.address;
    const state = { limited: true, reads: 0 };
    const realBalance = d.client.getBalance.bind(d.client);
    d.client.getBalance = (async (args: { address: Hex }) => {
      if (args.address === key) {
        state.reads++;
        if (state.limited) throw new LimitExceededRpcError(new Error("rate limit exceeded"));
      }
      return realBalance(args);
    }) as typeof d.client.getBalance;
    const check = () => (d as unknown as { ensureSessionGas(l: unknown): Promise<void> }).ensureSessionGas(l);
    // Before H3 every call read again: the main pass, the dispute pass and funding each call it, every pass.
    for (let i = 0; i < 10; i++) await check();
    expect(state.reads).toBe(1);
    expect(l.gasCheckBackoffMs).toBe(GAS_CHECK_BACKOFF_START_MS);
    expect(l.gasCheckRetryAt).toBeGreaterThan(Date.now());
    const backoffs: number[] = [];
    for (let i = 0; i < 6; i++) {
      l.gasCheckRetryAt = 0; // its back-off is over
      await check();
      backoffs.push(l.gasCheckBackoffMs);
    }
    expect(state.reads).toBe(7);
    expect(backoffs).toEqual([10_000, 20_000, 40_000, GAS_CHECK_BACKOFF_MAX_MS, GAS_CHECK_BACKOFF_MAX_MS, GAS_CHECK_BACKOFF_MAX_MS]);
    state.limited = false;
    l.gasCheckRetryAt = 0;
    await check();
    expect(state.reads).toBe(8);
    expect(l.gasCheckBackoffMs).toBe(0);
    expect(l.gasCheckRetryAt).toBe(0);
    await check();
    expect(state.reads).toBe(9); // no back-off once a read succeeds
  });
});

describe("H3 fix round 1 (review M8): the daemon's reads fail well inside the auto-return window on a hung RPC", () => {
  it("its client times an attempt out after 5 s, so a read fails within ~45 s and a respond's reads within 300 s", async () => {
    const { alice } = await matched();
    const t = alice.daemon.client.transport as { timeout?: number; retryCount?: number; retryDelay?: number };
    expect(t.timeout).toBe(DAEMON_RPC_TIMEOUT_MS); // before: viem's 10 s default
    expect([t.retryCount, t.retryDelay]).toEqual([RPC_RETRY_COUNT, RPC_RETRY_DELAY_MS]);
    const perRead = (RPC_RETRY_COUNT + 1) * DAEMON_RPC_TIMEOUT_MS + RPC_RETRY_DELAY_MS * (2 ** RPC_RETRY_COUNT - 1);
    expect(perRead).toBe(45_500);
    expect(5 * perRead).toBeLessThan(autoReturnSecondsOf(900n) * 1000); // about 5 reads before a respond's send
  });
});

describe("H3 fix round 1 (review M4): a reclaim mined with no readable receipt went through", () => {
  it("reclaim() resolves, unconfirmed, instead of failing", async () => {
    const { alice, id } = await matched();
    const hash = `0x${"ab".repeat(32)}` as const;
    alice.daemon.hub.reclaim = async () => {
      throw new TxReceiptMissingError(hash, 42n);
    };
    // Before: the TxReceiptMissingError reached the route, a 500.
    expect(await alice.daemon.reclaim(id)).toEqual({
      unconfirmed: `the reclaim transaction ${hash} was mined (block 42), but its receipt could not be read`,
    });
    const st = await alice.daemon.statusAfterAction(id, await alice.daemon.reclaim(id));
    expect(st.chainStale).toBe(true);
    expect(st.chainStaleReason).toMatch(/^the reclaim transaction 0xab/);
    alice.daemon.hub.reclaim = async () => {
      throw new Error("execution reverted");
    };
    await expect(alice.daemon.reclaim(id)).rejects.toThrow(/execution reverted/); // any other failure still fails
  });
});
