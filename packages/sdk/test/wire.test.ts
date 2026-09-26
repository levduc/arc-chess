import { describe, expect, it } from "vitest";
import { keccak256, toHex, type Address } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  buildParams,
  checkMatchParams,
  fromWire,
  offerId,
  signAcceptance,
  signOffer,
  toWire,
  verifyAcceptance,
  verifyOffer,
  type Acceptance,
  type MatchTerms,
  type Offer,
} from "../src/index.js";

const ALICE: Address = "0x00000000000000000000000000000000000000a1";
const BOB: Address = "0x00000000000000000000000000000000000000b2";
const TERMS: MatchTerms = {
  rules: "0x00000000000000000000000000000000000000e5",
  feeRecipient: "0x00000000000000000000000000000000000000f6",
  feePerPlayer: 5_000n,
  fundingWindow: 3600n,
};

function offerFor(key: `0x${string}`): Offer {
  return {
    template: "chess",
    player: ALICE,
    signer: privateKeyToAccount(key).address,
    deposit: 1_000_000n,
    stakePerGame: 100_000n,
    challengeTimeout: 600n,
    expiresAt: 2_000_000_000n,
    nonce: keccak256(toHex("n1")),
  };
}

describe("wire", () => {
  it("round-trips bigints through the JSON codec", () => {
    const v = { a: 1n, b: [2n, { c: 3n }], d: "x", e: null, f: 7 };
    expect(fromWire(toWire(v))).toEqual(v);
    expect(toWire({ a: 10n })).toBe('{"a":{"$bigint":"10"}}');
  });

  it("signs and verifies offers and acceptances by their session keys", async () => {
    const aKey = generatePrivateKey();
    const bKey = generatePrivateKey();
    const offer = offerFor(aKey);
    const so = { offer, sig: await signOffer(aKey, offer) };
    expect(await verifyOffer(so)).toBe(true);
    expect(await verifyOffer({ ...so, offer: { ...offer, deposit: 2n } })).toBe(false);
    expect(await verifyOffer({ offer, sig: await signOffer(bKey, offer) })).toBe(false);

    const acc: Acceptance = { offerId: offerId(offer), player: BOB, signer: privateKeyToAccount(bKey).address, nonce: keccak256(toHex("n2")) };
    expect(await verifyAcceptance({ acceptance: acc, sig: await signAcceptance(bKey, acc) })).toBe(true);
    expect(await verifyAcceptance({ acceptance: { ...acc, player: ALICE }, sig: await signAcceptance(bKey, acc) })).toBe(false);
  });

  it("builds params and checks them from each side", async () => {
    const aKey = generatePrivateKey();
    const bKey = generatePrivateKey();
    const offer = offerFor(aKey);
    const acc: Acceptance = { offerId: offerId(offer), player: BOB, signer: privateKeyToAccount(bKey).address, nonce: keccak256(toHex("n2")) };
    const p = buildParams(offer, acc, TERMS, 1_000n);
    expect(p.participants).toEqual([ALICE, BOB]);
    expect(p.signers).toEqual([offer.signer, acc.signer]);
    expect(p.fundingDeadline).toBe(4_600n);
    expect(p.salt).toMatch(/^0x[0-9a-f]{64}$/);

    const base = {
      rules: TERMS.rules,
      deposit: offer.deposit,
      stakePerGame: offer.stakePerGame,
      challengeTimeout: offer.challengeTimeout,
      feeRecipient: TERMS.feeRecipient,
      minFeePerPlayer: 5_000n,
      maxFeePerPlayer: 10_000n,
      now: 1_000n,
      maxFundingWindow: 7_200n,
    };
    expect(checkMatchParams(p, { ...base, me: 0, player: ALICE, signer: offer.signer })).toBeNull();
    expect(checkMatchParams(p, { ...base, me: 1, player: BOB, signer: acc.signer })).toBeNull();
    expect(checkMatchParams(p, { ...base, me: 1, player: BOB, signer: offer.signer })).toMatch(/session key/);
    expect(checkMatchParams({ ...p, rules: BOB }, { ...base, me: 0, player: ALICE, signer: offer.signer })).toMatch(/rules/);
    expect(checkMatchParams({ ...p, feePerPlayer: 20_000n }, { ...base, me: 0, player: ALICE, signer: offer.signer })).toMatch(/fee/);
    expect(checkMatchParams({ ...p, deposit: 1n }, { ...base, me: 0, player: ALICE, signer: offer.signer })).toMatch(/amount/);
    expect(checkMatchParams({ ...p, fundingDeadline: 1_000n }, { ...base, me: 0, player: ALICE, signer: offer.signer })).toMatch(
      /funding deadline/,
    );
    expect(
      checkMatchParams({ ...p, fundingDeadline: 1_000n + 7_201n }, { ...base, me: 0, player: ALICE, signer: offer.signer }),
    ).toMatch(/funding deadline/);
    expect(
      checkMatchParams({ ...p, fundingDeadline: 8_200n }, { ...base, me: 0, player: ALICE, signer: offer.signer }),
    ).toBeNull();
  });

  it("rejects malformed $bigint payloads", () => {
    expect(() => fromWire('{"a":{"$bigint":"12a"}}')).toThrow("invalid $bigint");
    expect(() => fromWire(`{"a":{"$bigint":"${"1".repeat(81)}"}}`)).toThrow("invalid $bigint");
  });
});
