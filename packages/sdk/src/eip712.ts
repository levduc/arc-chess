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

/** secp256k1's group order, halved: OpenZeppelin's `ECDSA.tryRecover` refuses any larger `s`. */
const HALF_ORDER = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;

/**
 * Throws unless `sig` has the one form the hub's ECDSA check (OpenZeppelin `ECDSA.tryRecover`) accepts: 65 bytes,
 * `v` 27 or 28, and a low `s`. viem also recovers the high-`s` twin of a signature and a `v` of 0 or 1, both of which
 * the hub refuses: a signature checked by viem alone could be stored as verified and then sink every proof that
 * carries it. Every signature the SDK itself makes already has this form.
 */
function assertHubForm(sig: Hex): void {
  if (!/^0x[0-9a-fA-F]{130}$/.test(sig)) throw new Error("signature must be 65 bytes");
  const v = Number.parseInt(sig.slice(130), 16);
  if ((v !== 27 && v !== 28) || BigInt(`0x${sig.slice(66, 130)}`) > HALF_ORDER) {
    throw new Error("signature is not in the form the hub accepts (v 27 or 28, low s)");
  }
}

/** The state's signer, for a signature the hub would also accept; throws otherwise (see `assertHubForm`). */
export async function recoverStateSigner(s: State, sig: Hex, d: ArenaDomain): Promise<Address> {
  assertHubForm(sig);
  return recoverTypedDataAddress({ domain: domain(d), types: STATE_TYPES, primaryType: "State", message: s, signature: sig });
}

/** The Close intent's signer, for a signature the hub would also accept; throws otherwise. */
export async function recoverCloseSigner(s: State, sig: Hex, d: ArenaDomain): Promise<Address> {
  assertHubForm(sig);
  return recoverTypedDataAddress({
    domain: domain(d),
    types: CLOSE_TYPES,
    primaryType: "Close",
    message: closeMessage(s, d),
    signature: sig,
  });
}
