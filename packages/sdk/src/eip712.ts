import { hashTypedData, recoverTypedDataAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { State } from "./types.js";

export type ArenaDomain = { chainId: number; hub: Address };

export const STATE_TYPES = {
  State: [
    { name: "channelId", type: "bytes32" },
    { name: "turnNum", type: "uint64" },
    { name: "prevHash", type: "bytes32" },
    { name: "balanceA", type: "uint256" },
    { name: "balanceB", type: "uint256" },
    { name: "gameIndex", type: "uint32" },
    { name: "move", type: "uint32" },
    { name: "board", type: "uint256" },
    { name: "meta", type: "uint256" },
  ],
} as const;

export const CLOSE_TYPES = {
  Close: [
    { name: "channelId", type: "bytes32" },
    { name: "stateHash", type: "bytes32" },
  ],
} as const;

function domain(d: ArenaDomain) {
  return { name: "AgentArena", version: "1", chainId: d.chainId, verifyingContract: d.hub } as const;
}

function closeMessage(s: State, d: ArenaDomain) {
  return { channelId: s.channelId, stateHash: hashState(s, d) };
}

/** Full EIP-712 digest of a state — also the value of the next state's prevHash. */
export function hashState(s: State, d: ArenaDomain): Hex {
  return hashTypedData({ domain: domain(d), types: STATE_TYPES, primaryType: "State", message: s });
}

/** Digest both players sign to close cooperatively on `s` (ChannelHub.hashClose). */
export function hashClose(s: State, d: ArenaDomain): Hex {
  return hashTypedData({ domain: domain(d), types: CLOSE_TYPES, primaryType: "Close", message: closeMessage(s, d) });
}

export function signState(key: Hex, s: State, d: ArenaDomain): Promise<Hex> {
  return privateKeyToAccount(key).signTypedData({ domain: domain(d), types: STATE_TYPES, primaryType: "State", message: s });
}

export function signClose(key: Hex, s: State, d: ArenaDomain): Promise<Hex> {
  return privateKeyToAccount(key).signTypedData({
    domain: domain(d),
    types: CLOSE_TYPES,
    primaryType: "Close",
    message: closeMessage(s, d),
  });
}

export function recoverStateSigner(s: State, sig: Hex, d: ArenaDomain): Promise<Address> {
  return recoverTypedDataAddress({ domain: domain(d), types: STATE_TYPES, primaryType: "State", message: s, signature: sig });
}

export function recoverCloseSigner(s: State, sig: Hex, d: ArenaDomain): Promise<Address> {
  return recoverTypedDataAddress({
    domain: domain(d),
    types: CLOSE_TYPES,
    primaryType: "Close",
    message: closeMessage(s, d),
    signature: sig,
  });
}
