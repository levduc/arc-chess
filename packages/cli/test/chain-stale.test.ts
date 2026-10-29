/**
 * Board rate-limit fix (owner: "in the take over. there is this rpc limit. that i have to run arena board again and
 * again to move"). The board renders a game by polling `GET /status` and `GET /channels`. Both refreshed the chain
 * first and failed outright when that refresh failed, so a rate-limited public RPC turned every board read into a 503
 * -- although the position, the turn and the legal moves are this daemon's own session state. Now a read whose chain
 * refresh fails answers the last known view with `chainStale` and the reason, as H3's action routes already did; a
 * `DaemonError` (no such channel) is still an error.
 */
import { HttpRequestError, LimitExceededRpcError, createPublicClient, type Hex, type PublicClient } from "viem";
import { afterEach, describe, expect, it } from "vitest";
import { HubClient, rpcTransport } from "@arena/sdk";
import { DaemonError, loadToken, startApi, type ArenaDaemon } from "../src/index.js";
import { RPC } from "../../sdk/test/helpers/chain.js";
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

    // The RPC answers again: the next read is fresh, with no chainStale at all.
    rpc.limited = false;
    const fresh = await call("GET", "/status");
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

  it("one channel's failed refresh marks that channel stale and leaves the other fresh; a rate limit spares the RPC the rest", async () => {
    const { d, first, second, reads, fail } = await twoChannels();
    // A 502 from the RPC on the first channel's read only. Before: channels() threw, and the whole list was a 500.
    fail.on.set(first, () => new HttpRequestError({ url: RPC, status: 502, body: {} }));
    const list = await d.channels();
    expect(list.map((c) => c.channelId)).toEqual([first, second]);
    expect(list[0]).toMatchObject({ channelId: first, chainStale: true, chainStaleReason: "HTTP 502", phase: "Open" });
    expect((list[1] as { chainStale?: true }).chainStale).toBeUndefined();
    expect(reads.get(second)).toBe(1); // the other channel was still refreshed
    // status() answers the same way for each.
    expect(await d.status(first)).toMatchObject({ chainStale: true, chainStaleReason: "HTTP 502" });
    expect((await d.status(second)).chainStale).toBeUndefined();

    // A rate limit on the first channel's read: the second channel is not read at all (a limited RPC only gets worse
    // with more reads) and is served from its last read, stale for the same reason.
    reads.clear();
    fail.on.set(first, () => new LimitExceededRpcError(new Error("rate limit exceeded")));
    const limited = await d.channels();
    const reason = 'the RPC is rate-limiting (-32005 "rate limit exceeded")';
    expect(limited).toHaveLength(2);
    expect(limited[0]).toMatchObject({ channelId: first, chainStale: true, chainStaleReason: reason });
    expect(limited[1]).toMatchObject({ channelId: second, chainStale: true, chainStaleReason: reason, phase: "Open" });
    expect(reads.get(first)).toBe(1);
    expect(reads.get(second)).toBeUndefined();

    fail.on.clear();
    const fresh = await d.channels();
    expect(fresh.every((c) => (c as { chainStale?: true }).chainStale === undefined)).toBe(true);
  });

  it("the one block read for every channel failing marks them all stale, with no per-channel read", async () => {
    const { d, first, second, reads } = await twoChannels();
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
    // status() reads its own block: stale too.
    expect(await d.status(first)).toMatchObject({ chainStale: true });
    limit.on = false;
    expect((await d.status(first)).chainStale).toBeUndefined();
    expect((await d.channels()).every((c) => (c as { chainStale?: true }).chainStale === undefined)).toBe(true);
  });

  it("a DaemonError is still thrown: an unknown channel, and no channel named with several live", async () => {
    const { d, fail, first } = await twoChannels();
    fail.on.set(first, () => new LimitExceededRpcError(new Error("rate limit exceeded")));
    await expect(d.status(`0x${"de".repeat(32)}`)).rejects.toBeInstanceOf(DaemonError);
    await expect(d.status()).rejects.toThrow(/several channels are active/);
  });
});
