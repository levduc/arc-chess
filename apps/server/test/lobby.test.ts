import http from "node:http";
import { randomBytes } from "node:crypto";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildParams,
  decodeWire,
  offerId as computeOfferId,
  signAcceptance,
  signOffer,
  toWire,
  type Acceptance,
  type MatchEvent,
  type Offer,
  type SignedAcceptance,
  type SignedOffer,
} from "@arena/sdk";
import { DEFAULT_LIMITS } from "../src/config.js";
import { Lobby, LobbyError } from "../src/lobby.js";
import { SqliteRepo, type Repo } from "../src/repo.js";
import { startServer, type ArenaServer } from "../src/server.js";
import { FakeChain, testConfig } from "./helpers/fakeChain.js";
import { wsConnect } from "./helpers/wsClient.js";

let server: ArenaServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

function randomNonce(): Hex {
  return `0x${randomBytes(32).toString("hex")}` as Hex;
}

/** Builds a fully-signed offer. `over` is applied before signing, so a mutated field still carries a valid
 *  signature -- the validation under test, not signature verification, is what should reject it. */
async function makeOffer(chain: FakeChain, over: Partial<Offer> = {}, signerKey: Hex = generatePrivateKey()) {
  const playerKey = generatePrivateKey();
  const offer: Offer = {
    template: "chess",
    player: privateKeyToAccount(playerKey).address,
    signer: privateKeyToAccount(signerKey).address,
    deposit: 1_000_000n,
    stakePerGame: 100_000n,
    challengeTimeout: 600n,
    expiresAt: chain.time + 3600n,
    nonce: randomNonce(),
    ...over,
  };
  const sig = await signOffer(signerKey, offer);
  return { offer, so: { offer, sig } as SignedOffer, playerKey, signerKey };
}

async function makeAcceptance(offerId: Hex, over: Partial<Acceptance> = {}, signerKey: Hex = generatePrivateKey()) {
  const playerKey = generatePrivateKey();
  const acceptance: Acceptance = {
    offerId,
    player: privateKeyToAccount(playerKey).address,
    signer: privateKeyToAccount(signerKey).address,
    nonce: randomNonce(),
    ...over,
  };
  const sig = await signAcceptance(signerKey, acceptance);
  return { acceptance, sa: { acceptance, sig } as SignedAcceptance, playerKey, signerKey };
}

async function postOffer(s: ArenaServer, so: SignedOffer) {
  const res = await fetch(`${s.url}/offers`, { method: "POST", body: toWire(so) });
  const text = await res.text();
  return { status: res.status, body: (text ? decodeWire(text) : undefined) as any };
}

async function acceptOffer(s: ArenaServer, id: string, sa: SignedAcceptance) {
  const res = await fetch(`${s.url}/offers/${id}/accept`, { method: "POST", body: toWire(sa) });
  const text = await res.text();
  return { status: res.status, body: (text ? decodeWire(text) : undefined) as any };
}

async function listOffers(s: ArenaServer): Promise<SignedOffer[]> {
  const res = await fetch(`${s.url}/offers`);
  return decodeWire(await res.text()) as SignedOffer[];
}

describe("lobby http", () => {
  it("posts, lists and matches an offer; accept returns params the SDK agrees with", async () => {
    const chain = new FakeChain();
    const cfg = testConfig();
    server = await startServer(cfg, { chain });

    const { offer, so } = await makeOffer(chain);
    const posted = await postOffer(server, so);
    expect(posted.status).toBe(201);
    const id = posted.body.offerId as Hex;
    expect(id).toBe(computeOfferId(offer));

    expect(await listOffers(server)).toContainEqual(so);

    const { acceptance, sa } = await makeAcceptance(id);
    const accepted = await acceptOffer(server, id, sa);
    expect(accepted.status).toBe(200);
    const m = accepted.body as MatchEvent;
    const terms = {
      rules: cfg.rules,
      feeRecipient: chain.fee.feeRecipient,
      feePerPlayer: chain.fee.feePerPlayer,
      fundingWindow: 3600n,
    };
    expect(m.params).toEqual(buildParams(offer, acceptance, terms, chain.time));

    const after = await listOffers(server);
    expect(after.find((o) => computeOfferId(o.offer) === id)).toBeUndefined();
  });

  const invalidOfferCases: Array<[string, (chain: FakeChain) => Promise<SignedOffer>]> = [
    [
      "bad signature",
      async (chain) => {
        const { so } = await makeOffer(chain);
        return { ...so, sig: `0x${"00".repeat(65)}` as Hex };
      },
    ],
    ["stake 0", async (chain) => (await makeOffer(chain, { stakePerGame: 0n })).so],
    ["deposit < stake", async (chain) => (await makeOffer(chain, { deposit: 50_000n })).so],
    ["timeout out of bounds", async (chain) => (await makeOffer(chain, { challengeTimeout: 10n })).so],
    ["already expired", async (chain) => (await makeOffer(chain, { expiresAt: chain.time })).so],
    [
      "expires too far out",
      async (chain) => (await makeOffer(chain, { expiresAt: chain.time + testConfig().offerMaxLifetime + 1n })).so,
    ],
  ];

  it.each(invalidOfferCases)("rejects an offer with %s (400)", async (_label, build) => {
    const chain = new FakeChain();
    server = await startServer(testConfig(), { chain });
    const so = await build(chain);
    const res = await postOffer(server, so);
    expect(res.status).toBe(400);
    expect(typeof res.body.error).toBe("string");
  });

  it("limits open offers per IP (429 after maxOpenOffersPerIp), even from fresh player addresses", async () => {
    const chain = new FakeChain();
    server = await startServer(testConfig({ limits: { ...DEFAULT_LIMITS, maxOpenOffersPerIp: 2 } }), { chain });

    // every post below uses a brand-new player/signer key pair; only the IP (127.0.0.1, since this is a loopback
    // test client) repeats. A per-player cap would never trip here -- proving the cap is keyed by IP, not player.
    const post = async () => postOffer(server!, (await makeOffer(chain, { nonce: randomNonce() })).so);
    expect((await post()).status).toBe(201);
    expect((await post()).status).toBe(201);
    const third = await post();
    expect(third.status).toBe(429);
    expect(third.body.error).toMatch(/open offers/);
  });

  it("Task 2 (spec §13): rejects an offer over the hub's per-player deposit cap (400)", async () => {
    const chain = new FakeChain();
    chain.hubLimits = { ...chain.hubLimits, maxDepositPerPlayer: 500_000n };
    server = await startServer(testConfig(), { chain });
    const { so } = await makeOffer(chain); // deposit 1_000_000n > cap
    const res = await postOffer(server, so);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("deposit exceeds the hub's per-player cap of 500000 base units");
  });

  it("Task 2 (spec §13): rejects a posted offer while the hub is paused (409)", async () => {
    const chain = new FakeChain();
    chain.hubLimits = { ...chain.hubLimits, paused: true };
    server = await startServer(testConfig(), { chain });
    const { so } = await makeOffer(chain);
    const res = await postOffer(server, so);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("the hub is paused: no new channels");
  });

  it("Task 2 (spec §13): rejects posting when the chain is unavailable (503), not silently through", async () => {
    const chain = new FakeChain();
    chain.limitsError = new Error("rpc down");
    server = await startServer(testConfig(), { chain });
    const { so } = await makeOffer(chain);
    const res = await postOffer(server, so);
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("chain unavailable");
  });

  it("Task 2 (spec §13): rejects accepting while the hub is paused (409)", async () => {
    const chain = new FakeChain();
    server = await startServer(testConfig(), { chain });
    const { so } = await makeOffer(chain);
    const posted = await postOffer(server, so);
    const id = posted.body.offerId as Hex;
    chain.hubLimits = { ...chain.hubLimits, paused: true };
    const { sa } = await makeAcceptance(id);
    const res = await acceptOffer(server, id, sa);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("the hub is paused: no new channels");
  });

  it("Task 2 (spec §13): rejects accepting once it would push committedEscrow over the cap (409)", async () => {
    const chain = new FakeChain();
    server = await startServer(testConfig(), { chain });
    const { so } = await makeOffer(chain); // deposit 1_000_000n, fee 5_000n -> reserves 2_010_000n
    const posted = await postOffer(server, so);
    const id = posted.body.offerId as Hex;
    chain.hubLimits = { ...chain.hubLimits, maxCommittedEscrow: 2_000_000n };
    const { sa } = await makeAcceptance(id);
    const res = await acceptOffer(server, id, sa);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("the hub's escrow cap is reached");
  });

  it("Task 2 (spec §13): rejects accepting when the chain is unavailable (503), never as an accept", async () => {
    const chain = new FakeChain();
    server = await startServer(testConfig(), { chain });
    const { so } = await makeOffer(chain);
    const posted = await postOffer(server, so);
    const id = posted.body.offerId as Hex;
    chain.limitsError = new Error("rpc down");
    const { sa } = await makeAcceptance(id);
    const res = await acceptOffer(server, id, sa);
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("chain unavailable");
  });

  it("rejects a duplicate offer id (409)", async () => {
    const chain = new FakeChain();
    server = await startServer(testConfig(), { chain });
    const { so } = await makeOffer(chain);
    expect((await postOffer(server, so)).status).toBe(201);
    const dup = await postOffer(server, so);
    expect(dup.status).toBe(409);
  });

  it(
    "rejects accepting your own offer, an unknown offer (404), a path/body id mismatch (400), an expired offer (410)",
    async () => {
      const chain = new FakeChain();
      server = await startServer(testConfig(), { chain });

      // own offer: acceptance.player === offer.player
      const { offer, so } = await makeOffer(chain);
      const posted = await postOffer(server, so);
      const id = posted.body.offerId as Hex;
      const { sa: selfSa } = await makeAcceptance(id, { player: offer.player });
      const selfRes = await acceptOffer(server, id, selfSa);
      expect(selfRes.status).toBe(400);

      // unknown offer
      const unknownId = `0x${"ee".repeat(32)}`;
      const { sa: unknownSa } = await makeAcceptance(unknownId as Hex);
      const unknownRes = await acceptOffer(server, unknownId, unknownSa);
      expect(unknownRes.status).toBe(404);

      // path/body id mismatch
      const { sa: mismatchSa } = await makeAcceptance(unknownId as Hex);
      const mismatchRes = await acceptOffer(server, id, mismatchSa);
      expect(mismatchRes.status).toBe(400);

      // expired offer
      const { so: shortLived } = await makeOffer(chain, { expiresAt: chain.time + 5n, nonce: randomNonce() });
      const shortPosted = await postOffer(server, shortLived);
      const shortId = shortPosted.body.offerId as Hex;
      chain.time += 6n;
      const { sa: lateSa } = await makeAcceptance(shortId);
      const lateRes = await acceptOffer(server, shortId, lateSa);
      expect(lateRes.status).toBe(410);
    },
  );

  it(
    "a second, different acceptance of a matched offer gets 409; re-posting the same acceptance returns the same match",
    async () => {
      const chain = new FakeChain();
      server = await startServer(testConfig(), { chain });
      const { so } = await makeOffer(chain);
      const posted = await postOffer(server, so);
      const id = posted.body.offerId as Hex;

      const { sa: firstSa } = await makeAcceptance(id);
      const first = await acceptOffer(server, id, firstSa);
      expect(first.status).toBe(200);

      const { sa: otherSa } = await makeAcceptance(id);
      const other = await acceptOffer(server, id, otherSa);
      expect(other.status).toBe(409);

      const replay = await acceptOffer(server, id, firstSa);
      expect(replay.status).toBe(200);
      expect(replay.body).toEqual(first.body);

      // idempotency is checked before expiry: the same acceptance still returns the stored match once the offer
      // (and the acceptance's original submission window) is long past expired.
      chain.time = so.offer.expiresAt + 1n;
      const lateReplay = await acceptOffer(server, id, firstSa);
      expect(lateReplay.status).toBe(200);
      expect(lateReplay.body).toEqual(first.body);
    },
  );

  it("rejects an oversized body (413)", async () => {
    const chain = new FakeChain();
    server = await startServer(testConfig(), { chain });
    const res = await fetch(`${server.url}/offers`, { method: "POST", body: "x".repeat(70 * 1024) });
    expect(res.status).toBe(413);
  });

  it("closes the socket of a chunked request that keeps streaming past the cap", async () => {
    const chain = new FakeChain();
    server = await startServer(testConfig(), { chain });
    const url = new URL(server.url);

    let closed = false;
    const req = http.request({ hostname: url.hostname, port: url.port, path: "/offers", method: "POST" });
    req.on("error", () => {
      closed = true;
    });
    req.on("close", () => {
      closed = true;
    });
    req.flushHeaders();

    const chunk = Buffer.alloc(64 * 1024, "x"); // one write already exceeds the 64 KiB cap
    const start = Date.now();
    const writer = setInterval(() => {
      if (closed || req.destroyed) {
        clearInterval(writer);
        return;
      }
      req.write(chunk);
    }, 10);

    await new Promise<void>((resolve) => {
      const poll = setInterval(() => {
        if (closed || Date.now() - start > 5000) {
          clearInterval(poll);
          clearInterval(writer);
          resolve();
        }
      }, 25);
    });

    expect(closed).toBe(true);
    expect(Date.now() - start).toBeLessThan(5000); // closed well within "a couple of seconds", not left hanging
  });

  it("a losing concurrent accept goes through the recordMatch-false branch (forced race)", async () => {
    // Rather than relying on incidental event-loop interleaving of two real HTTP requests (which may or may not
    // land both `offer()` reads before either write), this drives `Lobby` directly against a `Repo` wrapper that
    // *guarantees* both accept() calls see `match: null` on their initial read, so neither can take the idempotent
    // "already matched" shortcut -- both must reach `recordMatch`, and exactly one of them must lose there.
    const chain = new FakeChain();
    const cfg = testConfig();
    const real = new SqliteRepo(":memory:");
    let offerReads = 0;
    const repo: Repo = {
      insertOffer: (offerId, so, ip) => real.insertOffer(offerId, so, ip),
      offer: (offerId) => {
        offerReads++;
        const entry = real.offer(offerId);
        return offerReads <= 2 && entry ? { ...entry, match: null, acceptance: null } : entry;
      },
      openOffers: (now) => real.openOffers(now),
      openOfferCount: (ip, now) => real.openOfferCount(ip, now),
      openOfferTotal: (now) => real.openOfferTotal(now),
      recordMatch: (offerId, sa, m, channelId) => real.recordMatch(offerId, sa, m, channelId),
      pruneOffers: (now) => real.pruneOffers(now),
      knownChannel: (channelId) => real.knownChannel(channelId),
      cacheRelay: (channelId, sender, message) => real.cacheRelay(channelId, sender, message),
      cachedRelay: (channelId) => real.cachedRelay(channelId),
      pruneRelayCache: (nowMs) => real.pruneRelayCache(nowMs),
      cursor: () => real.cursor(),
      setCursor: (block) => real.setCursor(block),
      identity: () => real.identity(),
      setIdentity: (identity) => real.setIdentity(identity),
      channelRow: (id) => real.channelRow(id),
      saveChannelRow: (row) => real.saveChannelRow(row),
      channelRowsFor: (player) => real.channelRowsFor(player),
      recentChannels: (limit) => real.recentChannels(limit),
      deleteChannelRow: (id) => real.deleteChannelRow(id),
      reorgWatch: () => real.reorgWatch(),
      setReorgWatch: (ids) => real.setReorgWatch(ids),
      close: () => real.close(),
    };

    const lobby = new Lobby(repo, chain, cfg);
    const { offer, so } = await makeOffer(chain);
    const id = computeOfferId(offer);
    real.insertOffer(id, so, "127.0.0.1");

    const { sa: saA } = await makeAcceptance(id);
    const { sa: saB } = await makeAcceptance(id);
    const results = await Promise.allSettled([lobby.accept(id, saA), lobby.accept(id, saB)]);
    const statuses = results.map((r) => (r.status === "fulfilled" ? 200 : (r.reason as LobbyError).status));
    expect(statuses.sort()).toEqual([200, 409]);
    real.close();
  });

  it("a throwing onMatch subscriber does not stop the match from being recorded and returned", async () => {
    const chain = new FakeChain();
    const cfg = testConfig();
    const repo = new SqliteRepo(":memory:");
    const lobby = new Lobby(repo, chain, cfg);
    const { offer, so } = await makeOffer(chain);
    const id = computeOfferId(offer);
    repo.insertOffer(id, so, "127.0.0.1");

    let sawEvent: MatchEvent | undefined;
    lobby.onMatch(() => {
      throw new Error("boom");
    });
    lobby.onMatch((m) => {
      sawEvent = m;
    });

    const { sa } = await makeAcceptance(id);
    const event = await lobby.accept(id, sa);
    expect(event.offerId).toBe(id);
    expect(sawEvent).toEqual(event); // the well-behaved handler still ran despite the throwing one ahead of it
    repo.close();
  });

  it("two concurrent accepts: exactly one wins", async () => {
    const chain = new FakeChain();
    server = await startServer(testConfig(), { chain });
    const { so } = await makeOffer(chain);
    const posted = await postOffer(server, so);
    const id = posted.body.offerId as Hex;

    const { sa: saA } = await makeAcceptance(id);
    const { sa: saB } = await makeAcceptance(id);
    const [ra, rb] = await Promise.all([acceptOffer(server, id, saA), acceptOffer(server, id, saB)]);
    expect([ra.status, rb.status].sort()).toEqual([200, 409]);
  });
});

describe("lobby over /ws", () => {
  it("pushes the match to a subscriber and replays it to a late subscriber (offerer offline)", async () => {
    const chain = new FakeChain();
    server = await startServer(testConfig(), { chain });
    const { so } = await makeOffer(chain);
    const posted = await postOffer(server, so);
    const id = posted.body.offerId as Hex;

    const early = await wsConnect(server.url);
    early.send({ type: "subscribe", offerIds: [id] });

    const { sa } = await makeAcceptance(id);
    const accepted = await acceptOffer(server, id, sa);
    expect(accepted.status).toBe(200);
    const match = accepted.body as MatchEvent;

    expect((await early.next((f) => f.type === "match")).event.offerId).toBe(id);

    const late = await wsConnect(server.url);
    late.send({ type: "subscribe", offerIds: [id] });
    expect((await late.next((f) => f.type === "match")).event.params).toEqual(match.params);
  });

  it("ignores malformed frames with an error frame and keeps the connection", async () => {
    const chain = new FakeChain();
    server = await startServer(testConfig(), { chain });
    const c = await wsConnect(server.url);
    c.ws.send("{");
    expect((await c.next((f) => f.type === "error")).error).toMatch(/malformed/);
    c.send({ type: "subscribe", offerIds: [`0x${"ab".repeat(32)}`] });
    await expect(c.next((f) => f.type === "error", 300)).rejects.toThrow(/no matching frame/);

    // the connection is still open and functional (a positive round trip), not just quietly not-closed
    const { offer, so } = await makeOffer(chain);
    await postOffer(server, so);
    const id = computeOfferId(offer);
    const { sa } = await makeAcceptance(id);
    await acceptOffer(server, id, sa);
    c.send({ type: "subscribe", offerIds: [id] });
    expect((await c.next((f) => f.type === "match")).event.offerId).toBe(id);
  });

  it(
    "accepts subscribe ids case-insensitively, normalizing them; adds none of a frame's ids when one is malformed",
    async () => {
      const chain = new FakeChain();
      server = await startServer(testConfig(), { chain });
      const { offer, so } = await makeOffer(chain);
      await postOffer(server, so);
      const id = computeOfferId(offer);

      const c = await wsConnect(server.url);
      const upper = id.toUpperCase().replace("0X", "0x") as Hex;
      c.send({ type: "subscribe", offerIds: [upper] });
      await expect(c.next((f) => f.type === "error", 300)).rejects.toThrow(/no matching frame/); // accepted

      const { sa } = await makeAcceptance(id);
      await acceptOffer(server, id, sa);
      // the uppercased id was normalized and watched: a later match still reaches this connection
      expect((await c.next((f) => f.type === "match")).event.offerId).toBe(id);

      // a second, fresh offer mixed with one malformed id: none of the frame's ids get added
      const { offer: offer2, so: so2 } = await makeOffer(chain, { nonce: randomNonce() });
      await postOffer(server, so2);
      const id2 = computeOfferId(offer2);
      c.send({ type: "subscribe", offerIds: [id2, "0xnothex"] });
      expect((await c.next((f) => f.type === "error")).error).toMatch(/malformed/);
      const { sa: sa2 } = await makeAcceptance(id2);
      await acceptOffer(server, id2, sa2);
      await expect(c.next((f) => f.type === "match", 300)).rejects.toThrow(/no matching frame/); // id2 never added
    },
  );

  it("caps watched offers per connection", async () => {
    const chain = new FakeChain();
    server = await startServer(testConfig({ limits: { ...DEFAULT_LIMITS, maxWatchedOffers: 3 } }), { chain });

    const ids: Hex[] = [];
    for (let i = 0; i < 4; i++) {
      const { offer, so } = await makeOffer(chain, { nonce: randomNonce() });
      await postOffer(server, so);
      ids.push(computeOfferId(offer));
    }

    const c = await wsConnect(server.url);
    // The first 3, all genuinely unmatched, fill the cap.
    c.send({ type: "subscribe", offerIds: ids.slice(0, 3) });
    await expect(c.next((f) => f.type === "error", 300)).rejects.toThrow(/no matching frame/); // room for all 3

    // A 4th unmatched offer is refused: the cap is full.
    c.send({ type: "subscribe", offerIds: [ids[3]] });
    expect((await c.next((f) => f.type === "error")).error).toMatch(/too many watched offers/);
  });

  it("Plan 4.5 Task 11 fix round (C2, server-side eviction): a match always replays and never occupies a watch " +
    "slot, even once the cap is full or the id was refused before it matched", async () => {
    const chain = new FakeChain();
    server = await startServer(testConfig({ limits: { ...DEFAULT_LIMITS, maxWatchedOffers: 3 } }), { chain });

    const ids: Hex[] = [];
    for (let i = 0; i < 4; i++) {
      const { offer, so } = await makeOffer(chain, { nonce: randomNonce() });
      await postOffer(server, so);
      ids.push(computeOfferId(offer));
    }

    const c = await wsConnect(server.url);
    c.send({ type: "subscribe", offerIds: ids.slice(0, 3) }); // fills the cap (3/3)
    await expect(c.next((f) => f.type === "error", 300)).rejects.toThrow(/no matching frame/);
    c.send({ type: "subscribe", offerIds: [ids[3]] }); // refused: the cap is full
    expect((await c.next((f) => f.type === "error")).error).toMatch(/too many watched offers/);

    // Match the refused offer, then subscribe to it again: it must always replay, exactly like the daemon's own
    // `onHello` re-subscribe would send after a reconnect -- a match must never be silently dropped just because
    // the connection's watch slots were full when it happened, or are still full now.
    const { sa } = await makeAcceptance(ids[3]);
    await acceptOffer(server, ids[3], sa);
    c.send({ type: "subscribe", offerIds: [ids[3]] });
    expect((await c.next((f) => f.type === "match")).event.offerId).toBe(ids[3]);

    // Matching one of the 3 that *did* occupy a slot frees it immediately (the eviction fix), without needing a
    // fresh subscribe to notice: the push itself is what frees it.
    const { sa: sa0 } = await makeAcceptance(ids[0]);
    await acceptOffer(server, ids[0], sa0);
    expect((await c.next((f) => f.type === "match")).event.offerId).toBe(ids[0]);
    const { offer: offer4, so: so4 } = await makeOffer(chain, { nonce: randomNonce() });
    await postOffer(server, so4);
    const id4 = computeOfferId(offer4);
    c.send({ type: "subscribe", offerIds: [id4] });
    await expect(c.next((f) => f.type === "error", 300)).rejects.toThrow(/no matching frame/); // room again
  });

  it("closes a connection that exceeds the frame rate (1008)", async () => {
    const chain = new FakeChain();
    const limits = { ...DEFAULT_LIMITS, wsFrameBurst: 5, wsFramePerSec: 0.001 };
    server = await startServer(testConfig({ limits }), { chain });
    const c = await wsConnect(server.url);
    for (let i = 0; i < 10; i++) c.ws.send(toWire({ type: "subscribe", offerIds: [] }));
    const closeEvent = (await c.closed) as { code: number };
    expect(closeEvent.code).toBe(1008);
  });

  it("final review m8: the default frame limits sustain a busy daemon (a 2000-frame burst is not closed)", async () => {
    const chain = new FakeChain();
    server = await startServer(testConfig(), { chain });
    const c = await wsConnect(server.url);
    let closed = false;
    void c.closed.then(() => (closed = true));
    for (let i = 0; i < 2000; i++) c.ws.send(toWire({ type: "subscribe", offerIds: [] }));
    await new Promise((r) => setTimeout(r, 500));
    expect(closed).toBe(false); // before: closed with 1008 after the 200th frame
    // The soak needed 2000 burst / 200 per s per connection (Task 11 report); the defaults carry a 2x margin.
    expect(DEFAULT_LIMITS.wsFrameBurst).toBe(4000);
    expect(DEFAULT_LIMITS.wsFramePerSec).toBe(400);
  });

  it("refuses more than wsPerIp connections from one IP, and frees the slot once one closes", async () => {
    const chain = new FakeChain();
    server = await startServer(testConfig({ limits: { ...DEFAULT_LIMITS, wsPerIp: 2 } }), { chain });
    const c1 = await wsConnect(server.url);
    await wsConnect(server.url);
    await expect(wsConnect(server.url)).rejects.toThrow();

    c1.ws.close();
    await c1.closed;
    await new Promise((r) => setTimeout(r, 50)); // let the server's socket "close" (decrement) catch up

    const c3 = await wsConnect(server.url); // the freed slot admits a new connection
    expect(c3.nonce).toMatch(/^0x[0-9a-f]{64}$/);
  });
});
