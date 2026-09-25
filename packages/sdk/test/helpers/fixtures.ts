import { keccak256, toHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Params } from "../../src/index.js";

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
