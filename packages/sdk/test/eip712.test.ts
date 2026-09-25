import { describe, expect, it } from "vitest";
import type { Address, Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  EMPTY_SIGNED,
  channelId,
  decodeProof,
  decodeSignedState,
  encodeParams,
  encodeProof,
  encodeSignedState,
  hashClose,
  hashState,
  initialState,
  recoverCloseSigner,
  recoverStateSigner,
  signClose,
  signState,
  unsigned,
  type Params,
} from "../src/index.js";

const HUB: Address = "0x000000000000000000000000000000000000beef";
const D = { chainId: 31337, hub: HUB };
const P: Params = {
  participants: ["0x00000000000000000000000000000000000000a1", "0x00000000000000000000000000000000000000b2"],
  signers: ["0x00000000000000000000000000000000000000c3", "0x00000000000000000000000000000000000000d4"],
  rules: "0x00000000000000000000000000000000000000e5",
  feeRecipient: "0x00000000000000000000000000000000000000f6",
  feePerPlayer: 5_000n,
  deposit: 1_000_000n,
  stakePerGame: 100_000n,
  challengeTimeout: 600n,
  fundingDeadline: 2_000_000_000n,
  salt: `0x${"22".repeat(32)}` as Hex,
};

describe("eip712 and abi codecs", () => {
  it("signs and recovers State and Close with distinct digests", async () => {
    const key = generatePrivateKey();
    const who = privateKeyToAccount(key).address;
    const s = initialState(channelId(D.chainId, HUB, P), P);
    expect(hashClose(s, D)).not.toBe(hashState(s, D));
    expect(await recoverStateSigner(s, await signState(key, s, D), D)).toBe(who);
    expect(await recoverCloseSigner(s, await signClose(key, s, D), D)).toBe(who);
    // A state signature is not a close signature.
    expect(await recoverCloseSigner(s, await signState(key, s, D), D)).not.toBe(who);
  });

  it("binds the digest to chain and hub", () => {
    const s = initialState(channelId(D.chainId, HUB, P), P);
    expect(hashState(s, { chainId: 1, hub: HUB })).not.toBe(hashState(s, D));
    expect(hashState(s, { chainId: 31337, hub: "0x000000000000000000000000000000000000cafe" })).not.toBe(
      hashState(s, D),
    );
  });

  it("derives channel ids from chain, hub and params", () => {
    const id = channelId(D.chainId, HUB, P);
    expect(id).toMatch(/^0x[0-9a-f]{64}$/);
    expect(channelId(D.chainId, HUB, P)).toBe(id);
    expect(channelId(1, HUB, P)).not.toBe(id);
    expect(channelId(D.chainId, HUB, { ...P, salt: `0x${"33".repeat(32)}` })).not.toBe(id);
  });

  it("encodes params as a static 12-word tuple", () => {
    expect((encodeParams(P).length - 2) / 2).toBe(12 * 32);
  });

  it("round-trips signed states and proofs", async () => {
    const key = generatePrivateKey();
    const s = initialState(channelId(D.chainId, HUB, P), P);
    const ss = { ...unsigned(s), sigA: await signState(key, s, D) };
    expect(decodeSignedState(encodeSignedState(ss))).toEqual(ss);
    const proof = { hasPrev: false, prev: EMPTY_SIGNED, latest: ss };
    expect(decodeProof(encodeProof(proof))).toEqual(proof);
  });
});
