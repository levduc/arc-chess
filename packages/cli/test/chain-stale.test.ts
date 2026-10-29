/**
 * Board rate-limit fix (owner: "in the take over. there is this rpc limit. that i have to run arena board again and
 * again to move"). The board renders a game by polling `GET /status` and `GET /channels`. Both refreshed the chain
 * first and failed outright when that refresh failed, so a rate-limited public RPC turned every board read into a 503
 * -- although the position, the turn and the legal moves are this daemon's own session state. Now a read whose chain
 * refresh fails answers the last known view with `chainStale` and the reason, as H3's action routes already did; a
 * `DaemonError` (no such channel) is still an error.
 */
import type { Server } from "node:http";
import { HttpRequestError, LimitExceededRpcError, createPublicClient, type Hex, type PublicClient } from "viem";
import { afterEach, describe, expect, it } from "vitest";
import { HubClient, rpcTransport } from "@arena/sdk";
import { CHAIN_VIEW_MAX_AGE_MS, DaemonError, READ_BACKOFF_MS, loadToken, startApi, type ArenaDaemon, type ChannelHandle } from "../src/index.js";
import { RPC, increaseTime } from "../../sdk/test/helpers/chain.js";
import { startPair, waitFor } from "./helpers/harness.js";

let stop: (() => Promise<void>) | undefined;
afterEach(async () => {
  await stop?.();
  stop = undefined;
});

/** Stops the daemon's periodic passes, so only the test reads the chain through it. */
async function parked(daemon: ArenaDaemon) {
  clearInterval((daemon as unknown as { timer?: NodeJS.Timeout }).timer);
  await daemon.idle();
}

/** Fix round 1 (I2): the read routes' daemon-wide rate-limit back-off. */
type ReadState = { readBackoff: { until: number; err: unknown } | null };

/** Fix round 1 (I2): drops every channel's chain view from the read routes' 5 s cache, so the next read goes to the
 *  chain -- as if the last refresh were older than `CHAIN_VIEW_MAX_AGE_MS`. */
function cold(d: ArenaDaemon) {
  for (const id of d.channelIds()) d.handle(id).chainReadAt = 0;
}

/** Fix round 1 (I2): ends the read routes' rate-limit back-off now, as `READ_BACKOFF_MS` running out would. */
function backoffOver(d: ArenaDaemon) {
  const s = d as unknown as ReadState;
  if (s.readBackoff) s.readBackoff.until = 0;
}

/**
 * Routes `daemon`'s `channelInfo` reads through viem's real HTTP transport (`rpcTransport`, retries shortened) over a
 * fake fetch in front of Anvil, which answers every request with an HTTP 429 while `limited` -- as Arc's public RPC
 * does under a modest load (rehearsal §8.2).
 */
function rateLimitChannelInfo(daemon: ArenaDaemon, hub: Hex) {
  const state = { limited: false, refused: 0 };
  const fetchFn = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    if (state.limited) {
      state.refused++;
      return new Response("Too Many Requests", { status: 429 });
    }
    return fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: init?.body });
  };
  const client = createPublicClient({ transport: rpcTransport(RPC, { fetchFn, retryDelay: 1 }) }) as PublicClient;
  const fake = new HubClient(hub, client);
  daemon.hub.channelInfo = fake.channelInfo.bind(fake);
  return state;
}

describe("board rate-limit fix: GET /status and GET /channels answer the game while the chain refresh is rate-limited", () => {
  it("a human who took over sees their own move and the opponent's reply (chainStale), and a fresh view once the RPC answers", async () => {
    const pair = await startPair();
    const { alice, bob, env } = pair;
    const token = loadToken(alice.home);
    const { server, url } = await startApi(alice.daemon, { port: 0, token });
    stop = async () => {
      server.close();
      await pair.cleanup();
    };
    // The board's own requests: the bearer token and the human actor.
    const call = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
      const res = await fetch(`${url}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-arena-actor": "human" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: res.status, body: await res.json() };
    };
    const { offerId } = await alice.daemon.createOffer({ deposit: 1_000_000n, stakePerGame: 100_000n, challengeTimeout: 600n });
    await bob.daemon.acceptOffer(offerId);
    const id = await waitFor(() => alice.daemon.channelIds()[0], 20_000, "match");
    await waitFor(async () => (await call("GET", "/status")).body.phase === "Open", 30_000, "open");
    expect((await call("POST", "/handoff", { to: "human", note: "" })).body.controller).toBe("human");

    const rpc = rateLimitChannelInfo(alice.daemon, env.hub);
    rpc.limited = true;
    cold(alice.daemon); // fix round 1: past the read routes' 5 s cache of the watchtower's last good read
    // The move route already rode the limit out (H3): the move is signed and relayed.
    const moved = await call("POST", "/move", { move: "e2e4" });
    expect(moved.status).toBe(200);
    expect(moved.body.chainStale).toBe(true);
    expect(moved.body.turnNum).toBe("1");

    // The human's own move, read back the way the board reads it. Before: a 503 ("the RPC is rate-limiting (HTTP 429):
    // wait a few seconds, then retry"), on every poll, for as long as the limit lasted.
    const mine = await call("GET", "/status");
    expect(mine.status).toBe(200);
    expect(mine.body.chainStale).toBe(true);
    expect(mine.body.chainStaleReason).toBe("the RPC is rate-limiting (HTTP 429)");
    expect(mine.body.turnNum).toBe("1");
    expect(mine.body.lastMove).toEqual({ from: "e2", to: "e4", san: "e4" });
    expect(mine.body.myTurn).toBe(false);
    expect(mine.body.phase).toBe("Open"); // the last phase read
    expect(mine.body.controller).toBe("human");
    // Fix round 1 (I1): it says to re-check the chain, and when the view was read (never, since the cache was dropped).
    expect(mine.body.suggestedActions.at(-1)).toBe("arena status   (the chain view is stale: re-check before any challenge)");
    expect(mine.body.chainReadAt).toBeNull();

    // The opponent's reply arrives over the relay -- no chain read is needed to see it.
    await waitFor(() => bob.daemon.handle(id).session.isMyTurn(), 10_000, "bob's turn");
    await bob.daemon.move(id, "e5", { actor: "agent" });
    await waitFor(() => alice.daemon.handle(id).session.isMyTurn(), 10_000, "the reply reaches alice");
    const reply = await call("GET", "/status");
    expect(reply.status).toBe(200);
    expect(reply.body.chainStale).toBe(true);
    expect(reply.body.turnNum).toBe("2");
    expect(reply.body.lastMove).toEqual({ from: "e7", to: "e5", san: "e5" });
    expect(reply.body.myTurn).toBe(true);
    expect(reply.body.legalMovesUci).toContain("g1f3"); // the board can offer the human its next move
    expect(reply.body.fen).toMatch(/^rnbqkbnr\/pppp1ppp\/8\/4p3\/4P3\/8\/PPPP1PPP\/RNBQKBNR w /);

    // The channel list the board polls, too. Before: a 503 for the whole list.
    const list = await call("GET", "/channels");
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0]).toMatchObject({ channelId: id, chainStale: true, chainStaleReason: "the RPC is rate-limiting (HTTP 429)", turnNum: "2" });
    expect(rpc.refused).toBeGreaterThan(0);

    // And the human's next move, still under the limit.
    const next = await call("POST", "/move", { move: "g1f3" });
    expect(next.status).toBe(200);
    expect((await call("GET", "/status")).body).toMatchObject({ chainStale: true, turnNum: "3", myTurn: false });

    // The RPC answers again: once the watchtower's next pass reads the chain (it ends the read routes' back-off and
    // refreshes the view), the answer is fresh, with no chainStale at all.
    rpc.limited = false;
    const fresh = await waitFor(async () => {
      const r = await call("GET", "/status");
      return r.body.chainStale === undefined ? r : null;
    }, 15_000, "a fresh status");
    expect(fresh.status).toBe(200);
    expect(fresh.body.chainStale).toBeUndefined();
    expect(fresh.body.chainStaleReason).toBeUndefined();
    expect(fresh.body.turnNum).toBe("3");
    const freshList = await call("GET", "/channels");
    expect(freshList.status).toBe(200);
    expect(freshList.body[0].chainStale).toBeUndefined();
    // A channel that does not exist is still an error, limited or not.
    rpc.limited = true;
    expect((await call("GET", `/status?channel=0x${"de".repeat(32)}`)).status).toBe(404);
  });
});

describe("board rate-limit fix: channels() degrades per channel", () => {
  async function twoChannels() {
    const pair = await startPair();
    stop = pair.cleanup;
    const { alice, bob } = pair;
    for (let i = 0; i < 2; i++) {
      const { offerId } = await alice.daemon.createOffer({ deposit: 1_000_000n, stakePerGame: 100_000n, challengeTimeout: 600n });
      await bob.daemon.acceptOffer(offerId);
    }
    const ids = await waitFor(() => (alice.daemon.channelIds().length === 2 ? alice.daemon.channelIds() : null), 30_000, "two matches");
    for (const id of ids) await waitFor(async () => (await alice.daemon.hub.channelInfo(id)).phase === "Open", 30_000, "open");
    await waitFor(async () => (await alice.daemon.channels()).every((c) => "phase" in c && c.phase === "Open"), 10_000, "both read Open");
    await parked(alice.daemon);
    const d = alice.daemon;
    // channels() lists live channels in the order the daemon holds them.
    const [first, second] = (await d.channels()).map((c) => c.channelId as Hex);
    const reads = new Map<string, number>();
    const realInfo = d.hub.channelInfo.bind(d.hub);
    const fail = { on: new Map<string, () => Error>() };
    d.hub.channelInfo = async (cid: Hex) => {
      reads.set(cid, (reads.get(cid) ?? 0) + 1);
      const make = fail.on.get(cid);
      if (make) throw make();
      return realInfo(cid);
    };
    return { ...pair, d, first, second, reads, fail };
  }

  it("one channel's failed refresh marks it stale; the channels after it are not read but served stale for the same reason", async () => {
    const { d, first, second, reads, fail } = await twoChannels();
    cold(d);
    // A 502 from the RPC on the first channel's read. Before this fix: channels() threw, and the whole list was a 500.
    // Fix round 1 (m2): an RPC that fails one read fails the next as likely, and each failed read can wait out the
    // daemon's 20 s retry budget, so the second channel is not read either -- whatever the failure.
    fail.on.set(first, () => new HttpRequestError({ url: RPC, status: 502, body: {} }));
    const list = await d.channels();
    expect(list.map((c) => c.channelId)).toEqual([first, second]);
    expect(list[0]).toMatchObject({ channelId: first, chainStale: true, chainStaleReason: "HTTP 502", phase: "Open" });
    expect(list[1]).toMatchObject({ channelId: second, chainStale: true, chainStaleReason: "HTTP 502", phase: "Open" });
    expect(reads.get(first)).toBe(1);
    expect(reads.get(second)).toBeUndefined();
    // A 502 is not a rate limit: no back-off, so status() reads each channel itself.
    expect((d as unknown as ReadState).readBackoff).toBeNull();
    expect(await d.status(first)).toMatchObject({ chainStale: true, chainStaleReason: "HTTP 502" });
    expect((await d.status(second)).chainStale).toBeUndefined();
    expect(reads.get(second)).toBe(1);

    // A rate limit on the first channel's read: the same, and the read routes' back-off starts.
    reads.clear();
    cold(d);
    fail.on.set(first, () => new LimitExceededRpcError(new Error("rate limit exceeded")));
    const limited = await d.channels();
    const reason = 'the RPC is rate-limiting (-32005 "rate limit exceeded")';
    expect(limited).toHaveLength(2);
    expect(limited[0]).toMatchObject({ channelId: first, chainStale: true, chainStaleReason: reason });
    expect(limited[1]).toMatchObject({ channelId: second, chainStale: true, chainStaleReason: reason, phase: "Open" });
    expect(reads.get(first)).toBe(1);
    expect(reads.get(second)).toBeUndefined();
    expect((d as unknown as ReadState).readBackoff).not.toBeNull();

    fail.on.clear();
    backoffOver(d);
    const fresh = await d.channels();
    expect(fresh.every((c) => (c as { chainStale?: true }).chainStale === undefined)).toBe(true);
  });

  it("the one block read for every channel failing marks them all stale, with no per-channel read", async () => {
    const { d, first, second, reads } = await twoChannels();
    cold(d);
    const realBlock = d.client.getBlock.bind(d.client);
    const limit = { on: true };
    d.client.getBlock = (async (...args: Parameters<typeof realBlock>) => {
      if (limit.on) throw new LimitExceededRpcError(new Error("rate limit exceeded"));
      return realBlock(...args);
    }) as typeof realBlock;
    // Before: channels() threw on this read, before any channel was listed.
    const list = await d.channels();
    expect(list.map((c) => c.channelId)).toEqual([first, second]);
    for (const c of list) expect(c).toMatchObject({ chainStale: true, chainStaleReason: 'the RPC is rate-limiting (-32005 "rate limit exceeded")' });
    expect(reads.size).toBe(0);
    // status() answers stale too (from the back-off that read started, fix round 1).
    expect(await d.status(first)).toMatchObject({ chainStale: true });
    limit.on = false;
    backoffOver(d);
    expect((await d.status(first)).chainStale).toBeUndefined();
    cold(d);
    expect((await d.channels()).every((c) => (c as { chainStale?: true }).chainStale === undefined)).toBe(true);
  });

  it("a DaemonError is still thrown: an unknown channel, and no channel named with several live", async () => {
    const { d, fail, first } = await twoChannels();
    fail.on.set(first, () => new LimitExceededRpcError(new Error("rate limit exceeded")));
    await expect(d.status(`0x${"de".repeat(32)}`)).rejects.toBeInstanceOf(DaemonError);
    await expect(d.status()).rejects.toThrow(/several channels are active/);
  });
});

/**
 * Board fix round 1 (review I2): the board polled `GET /status` about once a second (one per change event), each a
 * chain refresh of what the watchtower had read at most one pass earlier -- +44% on one daemon's RPC rate, on an RPC the
 * project's own Arc notes say status polling helps limit. Under a persistent limit each such read also waited out the
 * daemon's 20 s retry budget before answering stale. The read routes now serve a view refreshed within
 * `CHAIN_VIEW_MAX_AGE_MS` (5 s) without a read, and after a rate-limited read answer stale at once, for
 * `READ_BACKOFF_MS` (10 s) or until any refresh succeeds. Dispute logic never reads that cache nor honours the back-off.
 */
describe("board fix round 1 (I2): the read routes' chain-view cache and rate-limit back-off", () => {
  const REASON = 'the RPC is rate-limiting (-32005 "rate limit exceeded")';

  /** One Open channel, Alice's daemon parked; counts her `channelInfo` and `getBlock` reads and limits both on demand. */
  async function oneChannel(opts: { api?: boolean } = {}) {
    const pair = await startPair();
    const { alice, bob } = pair;
    const token = loadToken(alice.home);
    let server: Server | undefined;
    let url = "";
    if (opts.api) ({ server, url } = await startApi(alice.daemon, { port: 0, token }));
    stop = async () => {
      server?.close();
      await pair.cleanup();
    };
    const { offerId } = await alice.daemon.createOffer({ deposit: 1_000_000n, stakePerGame: 100_000n, challengeTimeout: 600n });
    await bob.daemon.acceptOffer(offerId);
    const id = await waitFor(() => alice.daemon.channelIds()[0], 20_000, "match");
    await waitFor(async () => (await alice.daemon.hub.channelInfo(id)).phase === "Open", 30_000, "open");
    await waitFor(async () => (await alice.daemon.status(id)).phase === "Open", 10_000, "alice reads Open");
    await parked(alice.daemon);
    const d = alice.daemon;
    const l: ChannelHandle = d.handle(id);
    const count = { info: 0, block: 0 };
    const limit = { on: false };
    const limited = () => new LimitExceededRpcError(new Error("rate limit exceeded"));
    const realInfo = d.hub.channelInfo.bind(d.hub);
    d.hub.channelInfo = async (cid: Hex) => {
      count.info++;
      if (limit.on) throw limited();
      return realInfo(cid);
    };
    const realBlock = d.client.getBlock.bind(d.client);
    d.client.getBlock = (async (...args: Parameters<typeof realBlock>) => {
      count.block++;
      if (limit.on) throw limited();
      return realBlock(...args);
    }) as typeof realBlock;
    const settleCheck = () => (d as unknown as { settleCheck(l: ChannelHandle): Promise<void> }).settleCheck(l);
    return { ...pair, d, id, l, count, limit, url, token, settleCheck };
  }

  it("within 5 s of the watchtower's own refresh, status() and channels() read nothing; older, they read; statusAfterAction always reads", async () => {
    expect(CHAIN_VIEW_MAX_AGE_MS).toBe(5_000);
    const { d, id, l, count, settleCheck } = await oneChannel();
    await settleCheck(); // the main pass's own refresh of this channel
    const [info0, block0] = [count.info, count.block];
    // The board's polling. Before: a channelInfo and a getBlock read each, about once a second.
    for (let i = 0; i < 5; i++) expect((await d.status(id)).chainStale).toBeUndefined();
    expect((await d.channels())[0]).not.toHaveProperty("chainStale");
    expect([count.info - info0, count.block - block0]).toEqual([0, 0]);
    // An action route's status reads: the action may have written the chain (a challenge, a close, a respond).
    await d.statusAfterAction(id);
    expect(count.info - info0).toBe(1);
    // A view older than the cache's limit is read again, and that read re-stamps it.
    l.chainReadAt = Date.now() - CHAIN_VIEW_MAX_AGE_MS - 1;
    await d.status(id);
    expect(count.info - info0).toBe(2);
    await d.status(id);
    expect(count.info - info0).toBe(2);
    expect(Date.now() - l.chainReadAt).toBeLessThan(CHAIN_VIEW_MAX_AGE_MS);
  });

  it("a rate-limited read starts a 10 s back-off for the read routes: they answer stale at once, unread -- the dispute pass, the main pass and respondIfChallenged still read", async () => {
    expect(READ_BACKOFF_MS).toBe(10_000);
    const { d, id, l, count, limit, settleCheck } = await oneChannel();
    limit.on = true;
    cold(d);
    const info0 = count.info;
    expect(await d.status(id)).toMatchObject({ chainStale: true, chainStaleReason: REASON });
    expect(count.info - info0).toBe(1);
    const backoff = (d as unknown as ReadState).readBackoff;
    expect(backoff).not.toBeNull();
    expect(backoff!.until - Date.now()).toBeGreaterThan(READ_BACKOFF_MS - 2_000);

    // Within the back-off: no read at all. Before: each GET /status read again, waiting out the 20 s retry budget.
    const [info1, block1] = [count.info, count.block];
    expect(await d.status(id)).toMatchObject({ chainStale: true, chainStaleReason: REASON });
    expect((await d.channels())[0]).toMatchObject({ chainStale: true, chainStaleReason: REASON });
    expect(await d.statusAfterAction(id)).toMatchObject({ chainStale: true }); // after a move, resign, handoff, …
    expect([count.info - info1, count.block - block1]).toEqual([0, 0]);
    // After a challenge, reclaim or close (the action wrote the chain): one read, back-off or not.
    expect(await d.statusAfterAction(id, {}, { chainWrite: true })).toMatchObject({ chainStale: true });
    expect(count.info - info1).toBe(1);

    // Dispute logic never honours it: each still reads the chain itself.
    const info2 = count.info;
    await d.disputePass();
    expect(count.info - info2).toBeGreaterThanOrEqual(1);
    const info3 = count.info;
    await d.mainPass();
    expect(count.info - info3).toBeGreaterThanOrEqual(1);
    const info4 = count.info;
    await (d as unknown as { respondIfChallenged(l: ChannelHandle): Promise<void> }).respondIfChallenged(l).catch(() => undefined);
    expect(count.info - info4).toBe(1);

    // Any refresh that succeeds -- the watchtower's own included -- ends it early and warms the view.
    limit.on = false;
    await settleCheck();
    expect((d as unknown as ReadState).readBackoff).toBeNull();
    const info5 = count.info;
    expect((await d.status(id)).chainStale).toBeUndefined();
    expect(count.info - info5).toBe(0);

    // Otherwise it runs out after READ_BACKOFF_MS, and the next read goes to the chain again.
    limit.on = true;
    cold(d);
    await d.status(id);
    backoffOver(d);
    const info6 = count.info;
    await d.status(id);
    expect(count.info - info6).toBe(1);
  });

  it("the action routes: under the back-off POST /move and /handoff answer unread; POST /challenge, /reclaim and /close read once each", async () => {
    const { d, id, count, limit, url, token } = await oneChannel({ api: true });
    // The actions themselves are stubbed: only the status each route answers with is under test.
    d.move = async () => undefined;
    d.challenge = async () => ({});
    d.reclaim = async () => ({});
    d.close = async () => undefined;
    limit.on = true;
    cold(d);
    await d.status(id); // a rate-limited read: the back-off starts
    const post = async (path: string, body: unknown) => {
      const before = count.info;
      const res = await fetch(`${url}${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-arena-actor": "agent" },
        body: JSON.stringify(body),
      });
      const json = (await res.json()) as { chainStale?: true };
      return { status: res.status, stale: json.chainStale, reads: count.info - before };
    };
    expect(await post("/move", { move: "e2e4" })).toEqual({ status: 200, stale: true, reads: 0 });
    expect(await post("/handoff", { to: "agent", note: "" })).toEqual({ status: 200, stale: true, reads: 0 });
    expect(await post("/challenge", {})).toEqual({ status: 200, stale: true, reads: 1 });
    expect(await post("/reclaim", {})).toEqual({ status: 200, stale: true, reads: 1 });
    expect(await post("/close", {})).toEqual({ status: 200, stale: true, reads: 1 });
  });

  it("I1 end to end: a stale view of a silent opponent suggests no challenge and raises no humanAttention; it says when it was read", async () => {
    const { d, id, l, limit } = await oneChannel();
    d.handoff(id, "human", "");
    await d.move(id, "e4", { actor: "human" }); // now Alice waits on Bob, who never answers
    cold(d);
    await d.status(id); // a fresh read sees the progress
    await increaseTime(601); // more than the 600 s challengeTimeout of silence, on chain time
    cold(d);
    const fresh = await d.status(id);
    expect(fresh.humanAttention).toBe("opponent-silent");
    expect(fresh.suggestedActions[0]).toMatch(/^arena challenge /);
    const readAt = l.chainReadAt;
    limit.on = true;
    l.chainReadAt = readAt - CHAIN_VIEW_MAX_AGE_MS; // past the cache, but still a real time the view was read
    const st = await d.status(id);
    expect(st.chainStale).toBe(true);
    expect(st.humanAttention).toBeNull();
    expect(st.suggestedActions.some((a) => a.startsWith("arena challenge") || a.startsWith("arena reclaim"))).toBe(false);
    expect(st.suggestedActions.at(-1)).toBe("arena status   (the chain view is stale: re-check before any challenge)");
    expect(st.chainReadAt).toBe(new Date(readAt - CHAIN_VIEW_MAX_AGE_MS).toISOString());
  });

  it("this daemon's own chain write (a challenge, a reclaim, a close submission, a respond) drops the cached view: the next read goes to the chain", async () => {
    const { d, id, l, count, settleCheck } = await oneChannel();
    // The transactions themselves are stubbed: only what each write leaves in the cache is under test.
    const internal = d as unknown as { respondIfChallenged(l: ChannelHandle): Promise<void>; submitClose(l: ChannelHandle): Promise<void> };
    d.hub.challenge = (async () => ({})) as unknown as typeof d.hub.challenge;
    d.hub.reclaim = (async () => ({})) as unknown as typeof d.hub.reclaim;
    d.hub.respond = (async () => ({})) as unknown as typeof d.hub.respond;
    d.hub.closeCooperative = (async () => ({})) as unknown as typeof d.hub.closeCooperative;
    /** The respond path, on a channel that reads Challenged on a registered state older than ours. */
    const respond = async () => {
      const [info, registered] = [d.hub.channelInfo, d.hub.registeredState];
      d.hub.channelInfo = async (cid: Hex) => ({ ...(await info(cid)), phase: "Challenged", deadline: 2n ** 40n });
      d.hub.registeredState = (async () => ({ turnNum: -1n })) as unknown as typeof d.hub.registeredState;
      try {
        await internal.respondIfChallenged(l);
      } finally {
        [d.hub.channelInfo, d.hub.registeredState] = [info, registered];
      }
    };
    /** The close submission, with a fully signed close in hand. */
    const submitClose = async () => {
      const real = l.session.closeTransaction.bind(l.session);
      l.session.closeTransaction = (() => ({})) as unknown as typeof l.session.closeTransaction;
      try {
        await internal.submitClose(l);
      } finally {
        l.session.closeTransaction = real;
      }
    };
    for (const write of [() => d.challenge(id, "agent"), () => d.reclaim(id), respond, submitClose]) {
      await settleCheck(); // warm
      const before = count.info;
      await d.status(id);
      expect(count.info - before).toBe(0);
      await write();
      // Before: a status() within 5 s answered the view from before the write (a bot re-challenged on it).
      const at = count.info;
      await d.status(id);
      expect(count.info - at).toBe(1);
    }
  });

  it("re-review r1: a read in flight across our own chain write does not re-stamp its pre-write view as fresh", async () => {
    const { d, id, count, settleCheck } = await oneChannel();
    d.hub.challenge = (async () => ({})) as unknown as typeof d.hub.challenge;
    cold(d);
    // A status read that has read the channel and waits (a slow, retried read under a limit) ...
    const counted = d.hub.channelInfo;
    let entered!: () => void;
    const inFlight = new Promise<void>((r) => (entered = r));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let armed = true;
    d.hub.channelInfo = async (cid: Hex) => {
      const info = await counted(cid);
      if (armed) {
        armed = false;
        entered();
        await gate;
      }
      return info;
    };
    const pending = d.status(id);
    await inFlight;
    // ... while this daemon challenges; then the read lands.
    await d.challenge(id, "agent");
    release();
    await pending;
    // Before: the landed read stamped the cache, and this answered the pre-challenge view as fresh with 0 reads.
    const at = count.info;
    expect((await d.status(id)).chainStale).toBeUndefined();
    expect(count.info - at).toBe(1);
    // Our own write no longer forgets when the view was read (fix round 1's concern 4): a stale answer right after it
    // still says when, and its countdowns still run on.
    await settleCheck();
    const readAt = d.handle(id).chainReadAt;
    expect(readAt).toBeGreaterThan(0);
    await d.challenge(id, "agent");
    d.hub.channelInfo = async () => {
      throw new LimitExceededRpcError(new Error("rate limit exceeded"));
    };
    const st = await d.status(id);
    expect(st.chainStale).toBe(true);
    expect(st.chainReadAt).toBe(new Date(readAt).toISOString());
  });

  it("progress in this session since the cached read (a move, a relayed move, a signature) makes the next read go to the chain", async () => {
    const { d, bob, id, l, count, settleCheck } = await oneChannel();
    await settleCheck(); // warm
    const before = count.info;
    await d.status(id);
    expect(count.info - before).toBe(0);
    // Our own move: the session progressed since the view was read. Silence is judged on progress observed at a read
    // (`lastProgressAt`), so a cached view would let it be observed late -- or not before a silence alarm.
    const t0 = Date.now();
    await d.move(id, "e4", { actor: "agent" });
    const at = count.info;
    await d.status(id);
    expect(count.info - at).toBe(1);
    expect(l.lastProgressAt).not.toBeNull();
    expect(l.chainReadAt).toBeGreaterThanOrEqual(t0);
    await d.status(id); // nothing new since that read: cached again
    expect(count.info - at).toBe(1);
    // The opponent's move, relayed (no chain involved): the same.
    await waitFor(() => bob.daemon.handle(id).session.isMyTurn(), 10_000, "bob's turn");
    await bob.daemon.move(id, "e5", { actor: "agent" });
    await waitFor(() => l.session.isMyTurn(), 10_000, "the reply reaches alice");
    const relayed = count.info;
    expect((await d.channels())[0]).toMatchObject({ turnNum: "2" });
    expect(count.info - relayed).toBe(1);
  });

  it("m3: a refresh that fails on no RPC error is answered stale too, logged once per distinct reason, and starts no back-off", async () => {
    const { d, id } = await oneChannel();
    const logs: string[] = [];
    (d as unknown as { opts: { log?: (line: string) => void } }).opts.log = (line) => logs.push(line);
    d.hub.channelInfo = async () => {
      throw new TypeError("x is not a function");
    };
    for (let i = 0; i < 3; i++) {
      cold(d);
      expect(await d.status(id)).toMatchObject({ chainStale: true, chainStaleReason: "x is not a function" });
    }
    // Before: the same "chain RPC is busy" answer for a bug, with no trace of it anywhere.
    expect(logs.filter((line) => line.includes("x is not a function"))).toHaveLength(1);
    expect((d as unknown as ReadState).readBackoff).toBeNull();
  });
});
