import { randomBytes } from "node:crypto";
import type { Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, it } from "vitest";
import { buildParams, offerId as computeOfferId, type MatchEvent, type SignedOffer } from "@arena/sdk";
import type { ArenaDaemon } from "../src/index.js";
import { now, usdcBalance } from "../../sdk/test/helpers/chain.js";
import { START, startPair, waitFor } from "./helpers/harness.js";

/** Test-only escape hatch: onMatch/records are private/protected, but these regressions craft host events. */
type Internals = {
  onMatch(m: MatchEvent): Promise<void>;
  records: { saveOffer(r: unknown): void; offer(id: Hex): unknown };
};
const internals = (d: ArenaDaemon): Internals => d as unknown as Internals;
const randomNonce = (): Hex => `0x${randomBytes(32).toString("hex")}`;

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

async function offered() {
  const pair = await startPair();
  cleanup = pair.cleanup;
  const { offerId } = await pair.alice.daemon.createOffer({ deposit: 1_000_000n, stakePerGame: 100_000n, challengeTimeout: 600n });
  const so = (await pair.alice.client.lobby.listOffers()).find((o) => computeOfferId(o.offer) === offerId) as SignedOffer;
  const t = await now();
  const terms = { rules: pair.env.rules, feeRecipient: pair.env.host, feePerPlayer: 5_000n, fundingWindow: 3600n };
  // A host-crafted match for this offer: a fresh (sybil) accepter signer and nonce, so every event yields a new channelId.
  const event = (id: string): MatchEvent => ({
    offerId: id as Hex,
    params: buildParams(
      so.offer,
      { offerId, player: pair.bob.address, signer: privateKeyToAccount(generatePrivateKey()).address, nonce: randomNonce() },
      terms,
      t,
    ),
  });
  return { ...pair, offerId, so, event };
}

describe("C1: host-supplied offerId aliasing", () => {
  it("P3 regression: X and './' + X delivered concurrently open and fund exactly one channel", async () => {
    const { alice, env, offerId, event } = await offered();
    await Promise.all([internals(alice.daemon).onMatch(event(offerId)), internals(alice.daemon).onMatch(event(`./${offerId}`))]);
    expect(alice.daemon.channelIds()).toHaveLength(1);
    const [id] = alice.daemon.channelIds();
    await waitFor(async () => (await alice.daemon.hub.channelInfo(id)).funded[0], 30_000, "alice funded");
    // Give any (wrongly) opened second channel several ticks to fund before counting USDC.
    await new Promise((r) => setTimeout(r, 1_000));
    expect(alice.daemon.channelIds()).toHaveLength(1);
    expect(START - (await usdcBalance(env.usdc, alice.address))).toBe(1_000_000n + 5_000n);
  });

  it("ignores every non-canonical spelling of the offerId, even when it resolves to the offer file", async () => {
    const { alice, offerId, event } = await offered();
    for (const alias of [`./${offerId}`, `.//${offerId}`, `offers/../offers/${offerId}`, offerId.toUpperCase().replace("0X", "0x"), `${offerId} `, "../wallet"]) {
      await internals(alice.daemon).onMatch(event(alias));
    }
    expect(alice.daemon.channelIds()).toEqual([]);
    // The genuine id still works afterwards: nothing above consumed the offer.
    await internals(alice.daemon).onMatch(event(offerId));
    expect(alice.daemon.channelIds()).toHaveLength(1);
  });

  it("rejects a match whose canonical offerId names a stored offer that hashes differently", async () => {
    const { alice, offerId, so, event } = await offered();
    const rec = internals(alice.daemon).records.offer(offerId) as { sessionKey: Hex };
    // Same file name, different offer inside (e.g. a stale or tampered record): it must never be funded.
    internals(alice.daemon).records.saveOffer({ offerId, offer: { ...so.offer, nonce: randomNonce() }, sessionKey: rec.sessionKey, role: "offerer" });
    await internals(alice.daemon).onMatch(event(offerId));
    expect(alice.daemon.channelIds()).toEqual([]);
  });

  it("rejects a second match for an offer that already has a channel record", async () => {
    const { alice, env, offerId, event } = await offered();
    const rec = internals(alice.daemon).records.offer(offerId);
    await internals(alice.daemon).onMatch(event(offerId));
    expect(alice.daemon.channelIds()).toHaveLength(1);
    const [id] = alice.daemon.channelIds();
    // Simulate removeOffer() having failed (or a crash right after saveChannel): the offer record is back.
    internals(alice.daemon).records.saveOffer(rec);
    await internals(alice.daemon).onMatch(event(offerId));
    expect(alice.daemon.channelIds()).toEqual([id]);
    await waitFor(async () => (await alice.daemon.hub.channelInfo(id)).funded[0], 30_000, "alice funded");
    await new Promise((r) => setTimeout(r, 500));
    expect(START - (await usdcBalance(env.usdc, alice.address))).toBe(1_000_000n + 5_000n);
  });
});
