import { decodeAbiParameters, encodeAbiParameters, keccak256, type Address, type Hex } from "viem";
import { ZERO_HASH } from "./constants.js";
import type { Params, Proof, SignedState, State } from "./types.js";

const PARAMS = [
  { name: "participants", type: "address[2]" },
  { name: "signers", type: "address[2]" },
  { name: "rules", type: "address" },
  { name: "feeRecipient", type: "address" },
  { name: "feePerPlayer", type: "uint256" },
  { name: "deposit", type: "uint256" },
  { name: "stakePerGame", type: "uint256" },
  { name: "challengeTimeout", type: "uint64" },
  { name: "fundingDeadline", type: "uint64" },
  { name: "salt", type: "bytes32" },
] as const;

const STATE = [
  { name: "channelId", type: "bytes32" },
  { name: "turnNum", type: "uint64" },
  { name: "prevHash", type: "bytes32" },
  { name: "balanceA", type: "uint256" },
  { name: "balanceB", type: "uint256" },
  { name: "gameIndex", type: "uint32" },
  { name: "move", type: "uint32" },
  { name: "board", type: "uint256" },
  { name: "meta", type: "uint256" },
] as const;

const SIGNED = [
  { name: "state", type: "tuple", components: STATE },
  { name: "sigA", type: "bytes" },
  { name: "sigB", type: "bytes" },
] as const;

const PROOF = [
  { name: "hasPrev", type: "bool" },
  { name: "prev", type: "tuple", components: SIGNED },
  { name: "latest", type: "tuple", components: SIGNED },
] as const;

const EMPTY_STATE: State = {
  channelId: ZERO_HASH,
  turnNum: 0n,
  prevHash: ZERO_HASH,
  balanceA: 0n,
  balanceB: 0n,
  gameIndex: 0,
  move: 0,
  board: 0n,
  meta: 0n,
};

/** Placeholder for Proof.prev when hasPrev is false. */
export const EMPTY_SIGNED: SignedState = { state: EMPTY_STATE, sigA: "0x", sigB: "0x" };

export function unsigned(state: State): SignedState {
  return { state, sigA: "0x", sigB: "0x" };
}

/** abi.encode(params) — the payload of ChannelHub.deposit(bytes). */
export function encodeParams(p: Params): Hex {
  return encodeAbiParameters([{ type: "tuple", components: PARAMS }], [p]);
}

/** keccak256(abi.encode(chainId, hub, params)) — ChannelHub.channelId. */
export function channelId(chainId: number, hub: Address, p: Params): Hex {
  return keccak256(
    encodeAbiParameters([{ type: "uint256" }, { type: "address" }, { type: "tuple", components: PARAMS }], [
      BigInt(chainId),
      hub,
      p,
    ]),
  );
}

export function encodeSignedState(ss: SignedState): Hex {
  return encodeAbiParameters([{ type: "tuple", components: SIGNED }], [ss]);
}

export function decodeSignedState(data: Hex): SignedState {
  const [ss] = decodeAbiParameters([{ type: "tuple", components: SIGNED }], data);
  return { state: { ...ss.state }, sigA: ss.sigA, sigB: ss.sigB };
}

export function decodeParams(data: Hex): Params {
  const [p] = decodeAbiParameters([{ type: "tuple", components: PARAMS }], data);
  return { ...p, participants: [p.participants[0], p.participants[1]], signers: [p.signers[0], p.signers[1]] };
}

export function encodeProof(proof: Proof): Hex {
  return encodeAbiParameters([{ type: "tuple", components: PROOF }], [proof]);
}

export function decodeProof(data: Hex): Proof {
  const [p] = decodeAbiParameters([{ type: "tuple", components: PROOF }], data);
  const toSigned = (x: typeof p.prev): SignedState => ({ state: { ...x.state }, sigA: x.sigA, sigB: x.sigB });
  return { hasPrev: p.hasPrev, prev: toSigned(p.prev), latest: toSigned(p.latest) };
}
