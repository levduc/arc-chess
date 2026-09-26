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

  it("limits open offers per player (429 after maxOpenOffersPerPlayer)", async () => {
    const chain = new FakeChain();
    server = await startServer(testConfig({ limits: { ...DEFAULT_LIMITS, maxOpenOffersPerPlayer: 2 } }), { chain });
    const playerKey = generatePrivateKey();
    const signerKey = generatePrivateKey();
    const player = privateKeyToAccount(playerKey).address;
    const signer = privateKeyToAccount(signerKey).address;

    const post = async () => {
      const { so } = await makeOffer(chain, { player, signer, nonce: randomNonce() }, signerKey);
      return postOffer(server!, so);
    };
    expect((await post()).status).toBe(201);
    expect((await post()).status).toBe(201);
    const third = await post();
    expect(third.status).toBe(429);
    expect(third.body.error).toMatch(/open offers/);
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
  });

  it("caps watched offers per connection", async () => {
    const chain = new FakeChain();
    server = await startServer(testConfig({ limits: { ...DEFAULT_LIMITS, maxWatchedOffers: 3 } }), { chain });

    const ids: Hex[] = [];
    for (let i = 0; i < 5; i++) {
      const { offer, so } = await makeOffer(chain, { nonce: randomNonce() });
      await postOffer(server, so);
      ids.push(computeOfferId(offer));
    }
    // one offer inside the cap and one beyond it get matched *before* the subscribe, to prove which ones replay
    const { sa: saIn } = await makeAcceptance(ids[0]);
    await acceptOffer(server, ids[0], saIn);
    const { sa: saOut } = await makeAcceptance(ids[4]);
    await acceptOffer(server, ids[4], saOut);

    const c = await wsConnect(server.url);
    c.send({ type: "subscribe", offerIds: ids });
    expect((await c.next((f) => f.type === "error")).error).toMatch(/too many watched offers/);
    const replay = await c.next((f) => f.type === "match");
    expect(replay.event.offerId).toBe(ids[0]);
    await expect(c.next((f) => f.type === "match", 300)).rejects.toThrow(/no matching frame/); // ids[4] was never added
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

  it("refuses more than wsPerIp connections from one IP", async () => {
    const chain = new FakeChain();
    server = await startServer(testConfig({ limits: { ...DEFAULT_LIMITS, wsPerIp: 2 } }), { chain });
    await wsConnect(server.url);
    await wsConnect(server.url);
    await expect(wsConnect(server.url)).rejects.toThrow();
  });
});
