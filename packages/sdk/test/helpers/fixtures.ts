import { keccak256, toHex, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { channelId, initialState, signState } from "../../src/index.js";
import type { ArenaDomain, Params, SignedState } from "../../src/index.js";

export const SCHOLARS_MATE = ["e2e4", "e7e5", "d1h5", "b8c6", "f1c4", "g8f6", "h5f7"];

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function makeParams(opts: {
  participants: readonly [Address, Address];
  sessionKeys: readonly [Hex, Hex];
  rules: Address;
  feeRecipient: Address;
  fundingDeadline: bigint;
  deposit?: bigint;
  salt?: string;
}): Params {
  return {
    participants: opts.participants,
    signers: [privateKeyToAccount(opts.sessionKeys[0]).address, privateKeyToAccount(opts.sessionKeys[1]).address],
    rules: opts.rules,
    feeRecipient: opts.feeRecipient,
    feePerPlayer: 5_000n,
    deposit: opts.deposit ?? 1_000_000n,
    stakePerGame: 100_000n,
    challengeTimeout: 600n,
    fundingDeadline: opts.fundingDeadline,
    salt: keccak256(toHex(opts.salt ?? "salt")),
  };
}

// -------------------------------------------------------------- validate.test.ts fixtures

const SAMPLE_HUB: Address = "0x000000000000000000000000000000000000beef";
const SAMPLE_DOMAIN: ArenaDomain = { chainId: 31337, hub: SAMPLE_HUB };
const sampleSignerKeys = [generatePrivateKey(), generatePrivateKey()] as const;

/** A Params with two distinct random participants and signers, for validator round-trip tests. */
export const sampleParams: Params = makeParams({
  participants: [
    privateKeyToAccount(generatePrivateKey()).address,
    privateKeyToAccount(generatePrivateKey()).address,
  ],
  sessionKeys: sampleSignerKeys,
  rules: "0x00000000000000000000000000000000000000e5" as Address,
  feeRecipient: "0x00000000000000000000000000000000000000f6" as Address,
  fundingDeadline: 2_000_000_000n,
});

const sampleChannelId = channelId(SAMPLE_DOMAIN.chainId, SAMPLE_DOMAIN.hub, sampleParams);
const sampleOpeningState = initialState(sampleChannelId, sampleParams);

/** The opening state of a channel with `sampleParams`, signed by signers[0]. */
export const sampleSignedState: SignedState = {
  state: sampleOpeningState,
  sigA: await signState(sampleSignerKeys[0], sampleOpeningState, SAMPLE_DOMAIN),
  sigB: "0x",
};
