/**
 * Plan 6 hardening H3 (rate-limit resilience): Arc's public RPC answers a modest load with `-32005 "rate limit
 * exceeded"` or an HTTP 429 (Arc testnet rehearsal §8.2). The daemon must ride that out without mistaking it for
 * anything else -- above all, never for a refused range (spec §12 item 18): a skip on a rate limit would hide a
 * dispute event.
 */
import { LimitExceededRpcError, createPublicClient, type Hex, type PublicClient } from "viem";
import { afterEach, describe, expect, it } from "vitest";
import {
  HubClient,
  RPC_RETRY_COUNT,
  RPC_RETRY_DELAY_MS,
  TxFeeCapError,
  TxInsufficientFundsError,
  TxReceiptMissingError,
  TxStuckError,
  ZERO_HASH,
  rpcTransport,
} from "@arena/sdk";
import type { ArenaDaemon } from "../src/index.js";
import {
  DAEMON_RPC_TIMEOUT_MS,
  DAEMON_RPC_TOTAL_TIMEOUT_MS,
  GAS_CHECK_BACKOFF_MAX_MS,
  GAS_CHECK_BACKOFF_START_MS,
  RESPOND_SEND_MARGIN_MS,
  UNREADABLE_BLOCK_PASSES,
} from "../src/daemon.js";
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

/** Bob (black) answers e4 with e5 and challenges on it, so Alice must move to answer. Alice's daemon is parked (the
 *  test drives her) and Bob's relay is cut (only Alice's respond can answer). Returns Alice's raw-send hook. */
async function challengedAlice() {
  const m = await matched();
  const { alice, bob, id } = m;
  await alice.daemon.move(id, "e4", { actor: "agent" });
  await waitFor(() => bob.daemon.handle(id).session.isMyTurn(), 10_000, "bob's turn");
  await bob.daemon.move(id, "e5", { actor: "agent" });
  await waitFor(() => alice.daemon.handle(id).session.isMyTurn(), 10_000, "alice's turn");
  await parked(alice.daemon);
  bob.client.disconnect();
  await bob.daemon.challenge(id, "agent");
  await parked(bob.daemon); // from here on, every RPC request in this process is Alice's
  expect((await alice.daemon.hub.channelInfo(id)).phase).toBe("Challenged");
  const l = alice.daemon.handle(id);
  const inner = (l.sessionSender as unknown as { inner: { sendRawTransaction(raw: Hex): Promise<Hex> } }).inner;
  const realRaw = inner.sendRawTransaction.bind(inner);
  const sent: { at?: number } = {};
  inner.sendRawTransaction = async (raw: Hex) => {
    sent.at ??= Date.now();
    return realRaw(raw);
  };
  return { ...m, l, sent };
}

describe("H3 fix round 2 (re-review I-a): a respond is broadcast inside the auto-return window, whatever the RPC does", () => {
  it("the daemon's client caps one request at 20 s, retries included, and attempts at 5 s", async () => {
    const { alice } = await matched();
    const t = alice.daemon.client.transport as { timeout?: number; retryCount?: number; retryDelay?: number; totalTimeoutMs?: number };
    expect(t.timeout).toBe(DAEMON_RPC_TIMEOUT_MS);
    expect(t.totalTimeoutMs).toBe(DAEMON_RPC_TOTAL_TIMEOUT_MS); // before: none -- 6 x 5 s + 15.5 s = 45.5 s a request
    expect([t.retryCount, t.retryDelay]).toEqual([RPC_RETRY_COUNT, RPC_RETRY_DELAY_MS]);
  });

  it("the real respond path (move -> respondIfChallenged -> hub.respond): its requests x 20 s + the send fit in 300 s", async () => {
    const { alice, id, sent } = await challengedAlice();
    const d = alice.daemon;
    // Counted at fetch: viem's actions are bound to the client it was built from, not to a patched `request`.
    const methods: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).startsWith(RPC) && sent.at === undefined) methods.push((JSON.parse(String(init?.body)) as { method: string }).method);
      return realFetch(input, init);
    }) as typeof fetch;
    try {
      await d.move(id, "Nf3", { actor: "agent" }); // the move answers the challenge
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(sent.at).toBeDefined();
    expect((await d.hub.channelInfo(id)).phase).toBe("Open");
    // Every request before the broadcast is one after another: at most DAEMON_RPC_TOTAL_TIMEOUT_MS each, and the send
    // itself is one attempt on LocalKeyTxSender's own client (viem's 10 s timeout, never retried).
    expect(methods.length).toBeGreaterThanOrEqual(8);
    const worstMs = methods.length * DAEMON_RPC_TOTAL_TIMEOUT_MS + 10_000;
    expect(worstMs).toBeLessThan(autoReturnSecondsOf(900n) * 1000);
    // Before the cap: each request up to 45.5 s.
    expect(methods.length * 45_500 + 10_000).toBeGreaterThan(autoReturnSecondsOf(900n) * 1000);
  });
});

describe("H3 fix round 2 (re-review M-g): a respond is never broadcast past its deadline, and never held back before it", () => {
  /** Makes the latest block read `secondsLeft` before the challenge deadline, and the respond's simulate take `ms`. */
  function skew(d: ArenaDaemon, deadline: bigint, secondsLeft: bigint, ms: number) {
    const realBlock = d.client.getBlock.bind(d.client);
    d.client.getBlock = (async (...args: Parameters<typeof realBlock>) => ({ ...(await realBlock(...args)), timestamp: deadline - secondsLeft })) as typeof realBlock;
    const realCall = d.client.call.bind(d.client);
    d.client.call = (async (...args: Parameters<typeof realCall>) => {
      await new Promise((r) => setTimeout(r, ms));
      return realCall(...args);
    }) as typeof realCall;
  }

  it("reads that end past the deadline (plus the margin): nothing is sent, and the respond error says so", async () => {
    const { alice, id, l, sent } = await challengedAlice();
    const { deadline } = await alice.daemon.hub.channelInfo(id);
    skew(alice.daemon, deadline, 1n, 1_000 + RESPOND_SEND_MARGIN_MS + 500); // give-up in 1 s, notAfter in 16 s
    await alice.daemon.move(id, "Nf3", { actor: "agent" });
    // Before: the respond went out regardless, to revert on-chain and burn gas.
    expect(sent.at).toBeUndefined();
    expect(l.lastError).toBe("respond: the transaction was ready only past its give-up time: not sent");
    expect((await alice.daemon.hub.channelInfo(id)).phase).toBe("Challenged");
  });

  it("final fix wave B (m-6, h3 M-i): reads that end past the give-up time but inside the 15 s margin: still sent", async () => {
    expect(RESPOND_SEND_MARGIN_MS).toBe(15_000);
    const { alice, id, sent } = await challengedAlice();
    const { deadline } = await alice.daemon.hub.channelInfo(id);
    // Give-up in 1 s; the reads end 8.5 s after them, 7.5 s past the give-up time and 7.5 s before notAfter. The block
    // time read is skewed only: on the chain the deadline is minutes away, so the respond lands. With the 3 s margin
    // of H3 fix round 2 it was held back; the costs are lopsided (a forfeit against about 0.008 USDC of gas).
    skew(alice.daemon, deadline, 1n, 8_500);
    await alice.daemon.move(id, "Nf3", { actor: "agent" });
    expect(sent.at).toBeDefined();
    expect((await alice.daemon.hub.channelInfo(id)).phase).toBe("Open");
  });

  it("reads that end before the deadline: the respond is sent and answers the challenge", async () => {
    const { alice, id, sent } = await challengedAlice();
    const { deadline } = await alice.daemon.hub.channelInfo(id);
    skew(alice.daemon, deadline, 30n, 1_000 + RESPOND_SEND_MARGIN_MS + 500); // the same delay, 30 s left
    await alice.daemon.move(id, "Nf3", { actor: "agent" });
    expect(sent.at).toBeDefined();
    expect((await alice.daemon.hub.channelInfo(id)).phase).toBe("Open");
  });
});

describe("final fix wave B (m-6 follow-up): a respond still pending at its give-up time, that then lands, is not reported stuck", () => {
  it("no receipt by the give-up time and the transaction pending (Arc, before its next block): TxStuckError -- the channel is Open, so no lastError", async () => {
    const { alice, id, l, sent } = await challengedAlice();
    const d = alice.daemon;
    const { deadline } = await d.hub.channelInfo(id);
    // The block the respond reads is 1 s before the deadline: its give-up time is 1 s away.
    const realBlock = d.client.getBlock.bind(d.client);
    d.client.getBlock = (async (...args: Parameters<typeof realBlock>) => ({ ...(await realBlock(...args)), timestamp: deadline - 1n })) as typeof realBlock;
    // The respond's own reads: no receipt, and its transaction reads as pending -- as on Arc until the next block. On
    // Anvil it is mined at once, so the challenge is answered.
    const fetchFn = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const req = JSON.parse(String(init?.body)) as { id: number; method: string };
      const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
      if (req.method === "eth_getTransactionReceipt") return json({ jsonrpc: "2.0", id: req.id, result: null });
      const upstream = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: init?.body });
      if (req.method !== "eth_getTransactionByHash") return upstream;
      const body = (await upstream.json()) as { result: Record<string, unknown> | null };
      if (body.result) body.result = { ...body.result, blockHash: null, blockNumber: null, transactionIndex: null };
      return json(body);
    };
    const client = createPublicClient({ transport: rpcTransport(RPC, { fetchFn, retryDelay: 1 }) }) as PublicClient;
    const fake = new HubClient(d.hub.hub, client);
    let failure: unknown;
    d.hub.respond = async (...args: Parameters<HubClient["respond"]>) =>
      fake.respond(...args).catch((err: unknown) => {
        failure = err;
        throw err;
      });
    await d.move(id, "Nf3", { actor: "agent" });
    expect(sent.at).toBeDefined();
    expect(failure).toBeInstanceOf(TxStuckError);
    expect((failure as TxStuckError).atDeadline).toBe(true);
    expect((await d.hub.channelInfo(id)).phase).toBe("Open"); // it landed and answered the challenge
    // Before: "respond: …" (the stuck transaction) stayed as lastError on a channel that respond had answered, and the
    // next pass, on a channel no longer Challenged, never cleared it.
    expect(l.lastError ?? "").not.toMatch(/^respond:/);
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
      unconfirmed: `the reclaim transaction ${hash} was mined (block 42), but its receipt could not be read: whether it succeeded is not known yet; check status`,
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

describe("final fix wave B (m-8, h3 M-d): a close the wallet cannot pay for names that cause", () => {
  it("close() still answers (the Close is signed and relayed); lastError says the wallet cannot pay, or the fee is over its ceiling", async () => {
    const { alice, bob, id } = await matched();
    await alice.daemon.move(id, "e4", { actor: "agent", offerDraw: true });
    await waitFor(() => bob.daemon.handle(id).session.isMyTurn(), 10_000, "bob's turn");
    await bob.daemon.acceptDraw(id, "agent");
    await waitFor(async () => (await alice.daemon.status(id)).attention === "game-over", 20_000, "draw seen");
    await bob.daemon.close(id, "agent");
    await waitFor(async () => (await alice.daemon.status(id)).attention === "close-requested", 10_000, "close requested");
    bob.client.disconnect(); // Bob never sees Alice's Close: only her own submission could settle it
    await parked(alice.daemon);
    const l = alice.daemon.handle(id);
    for (const [err, want] of [
      [new TxInsufficientFundsError(alice.daemon.wallet.address), /^close: this wallet cannot pay the close transaction's gas \(0x[0-9a-fA-F]{40} cannot pay/],
      [new TxFeeCapError(3, 40n), /^close: the close transaction's fee is over this wallet's fee ceiling \(replacing the transaction at nonce 3/],
    ] as const) {
      alice.daemon.hub.closeCooperative = async () => {
        throw err;
      };
      await alice.daemon.close(id, "agent"); // before and after: answered, not failed
      expect(l.lastError).toMatch(want);
      expect(l.lastError).toContain("the watchtower retries every pass, and the opponent can submit the close too");
    }
    expect((await alice.daemon.hub.channelInfo(id)).phase).toBe("Open");
  });
});
