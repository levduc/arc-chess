import type { Address, Hex } from "viem";
import type { CloseSignature } from "./session.js";
import type { Params, PlayerIndex, SignedState, State } from "./types.js";
import { fromWire } from "./wire.js";
import type { Acceptance, MatchEvent, Offer, RelayMessage, SignedAcceptance, SignedOffer } from "./wire.js";

/** Untrusted wire input that fails to decode into a known protocol shape; the message names the offending field. */
export class WireFormatError extends Error {}

/** `fromWire` (the JSON+bigint codec), with every failure -- bad JSON, a malformed $bigint, a non-string input --
 *  normalized to WireFormatError. */
export function decodeWire(text: string): unknown {
  if (typeof text !== "string") throw new WireFormatError("message must be a string");
  try {
    return fromWire<unknown>(text);
  } catch (err) {
    throw new WireFormatError(`invalid wire payload: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const HEX32_RE = /^0x[0-9a-f]{64}$/i;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const SIG_RE = /^0x([0-9a-fA-F]{2}){0,1024}$/;

function object(v: unknown, path: string): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new WireFormatError(`${path} must be an object`);
  return v as Record<string, unknown>;
}

/** A 32-byte 0x-hex string, lower-cased -- the shape of every id used as a key (offerId, channelId, stateHash,
 *  salt, nonce, prevHash). */
function hex32(v: unknown, path: string): Hex {
  if (typeof v !== "string" || !HEX32_RE.test(v)) throw new WireFormatError(`${path} must be a 32-byte 0x-hex string`);
  return v.toLowerCase() as Hex;
}

function address(v: unknown, path: string): Address {
  if (typeof v !== "string" || !ADDRESS_RE.test(v)) throw new WireFormatError(`${path} must be an address`);
  return v as Address;
}

function sig(v: unknown, path: string): Hex {
  if (typeof v !== "string" || !SIG_RE.test(v)) throw new WireFormatError(`${path} must be a signature`);
  return v as Hex;
}

function uint(v: unknown, path: string): bigint {
  if (typeof v !== "bigint" || v < 0n || v >= 2n ** 256n) throw new WireFormatError(`${path} must be a bigint`);
  return v;
}

function uint64(v: unknown, path: string): bigint {
  if (typeof v !== "bigint" || v < 0n || v >= 2n ** 64n) throw new WireFormatError(`${path} must be a uint64 bigint`);
  return v;
}

/** A safe non-negative integer number (gameIndex, move), bounded to fit uint32. */
function small(v: unknown, path: string): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0 || v > 2 ** 32 - 1) {
    throw new WireFormatError(`${path} must be a small non-negative integer`);
  }
  return v;
}

function pair(v: unknown, path: string): [unknown, unknown] {
  if (!Array.isArray(v) || v.length !== 2) throw new WireFormatError(`${path} must be a pair`);
  return [v[0], v[1]];
}

export function parseState(x: unknown, path = "state"): State {
  const o = object(x, path);
  return {
    channelId: hex32(o.channelId, `${path}.channelId`),
    turnNum: uint64(o.turnNum, `${path}.turnNum`),
    prevHash: hex32(o.prevHash, `${path}.prevHash`),
    balanceA: uint(o.balanceA, `${path}.balanceA`),
    balanceB: uint(o.balanceB, `${path}.balanceB`),
    gameIndex: small(o.gameIndex, `${path}.gameIndex`),
    move: small(o.move, `${path}.move`),
    board: uint(o.board, `${path}.board`),
    meta: uint(o.meta, `${path}.meta`),
  };
}

export function parseSignedState(x: unknown, path = "signed"): SignedState {
  const o = object(x, path);
  return {
    state: parseState(o.state, `${path}.state`),
    sigA: sig(o.sigA, `${path}.sigA`),
    sigB: sig(o.sigB, `${path}.sigB`),
  };
}

export function parseParams(x: unknown, path = "params"): Params {
  const o = object(x, path);
  const [p0, p1] = pair(o.participants, `${path}.participants`);
  const [s0, s1] = pair(o.signers, `${path}.signers`);
  return {
    participants: [address(p0, `${path}.participants[0]`), address(p1, `${path}.participants[1]`)],
    signers: [address(s0, `${path}.signers[0]`), address(s1, `${path}.signers[1]`)],
    rules: address(o.rules, `${path}.rules`),
    feeRecipient: address(o.feeRecipient, `${path}.feeRecipient`),
    feePerPlayer: uint(o.feePerPlayer, `${path}.feePerPlayer`),
    deposit: uint(o.deposit, `${path}.deposit`),
    stakePerGame: uint(o.stakePerGame, `${path}.stakePerGame`),
    challengeTimeout: uint64(o.challengeTimeout, `${path}.challengeTimeout`),
    fundingDeadline: uint64(o.fundingDeadline, `${path}.fundingDeadline`),
    salt: hex32(o.salt, `${path}.salt`),
  };
}

export function parseCloseSignature(x: unknown, path = "close"): CloseSignature {
  const o = object(x, path);
  if (o.by !== 0 && o.by !== 1) throw new WireFormatError(`${path}.by must be 0 or 1`);
  return {
    stateHash: hex32(o.stateHash, `${path}.stateHash`),
    by: o.by as PlayerIndex,
    sig: sig(o.sig, `${path}.sig`),
  };
}

export function parseRelayMessage(x: unknown): RelayMessage {
  const o = object(x, "message");
  if (o.type === "state") {
    const channelId = hex32(o.channelId, "channelId");
    const signed = parseSignedState(o.signed, "signed");
    if (signed.state.channelId !== channelId) throw new WireFormatError("signed.state.channelId must match channelId");
    return { type: "state", channelId, signed };
  }
  if (o.type === "close") {
    return { type: "close", channelId: hex32(o.channelId, "channelId"), close: parseCloseSignature(o.close, "close") };
  }
  throw new WireFormatError('type must be "state" or "close"');
}

export function parseMatchEvent(x: unknown): MatchEvent {
  const o = object(x, "event");
  return { offerId: hex32(o.offerId, "offerId"), params: parseParams(o.params, "params") };
}

export function parseSignedOffer(x: unknown): SignedOffer {
  const o = object(x, "signedOffer");
  const of = object(o.offer, "offer");
  if (of.template !== "chess") throw new WireFormatError('offer.template must be "chess"');
  const offer: Offer = {
    template: "chess",
    player: address(of.player, "offer.player"),
    signer: address(of.signer, "offer.signer"),
    deposit: uint(of.deposit, "offer.deposit"),
    stakePerGame: uint(of.stakePerGame, "offer.stakePerGame"),
    challengeTimeout: uint64(of.challengeTimeout, "offer.challengeTimeout"),
    expiresAt: uint64(of.expiresAt, "offer.expiresAt"),
    nonce: hex32(of.nonce, "offer.nonce"),
  };
  return { offer, sig: sig(o.sig, "sig") };
}

export function parseSignedAcceptance(x: unknown): SignedAcceptance {
  const o = object(x, "signedAcceptance");
  const ac = object(o.acceptance, "acceptance");
  const acceptance: Acceptance = {
    offerId: hex32(ac.offerId, "acceptance.offerId"),
    player: address(ac.player, "acceptance.player"),
    signer: address(ac.signer, "acceptance.signer"),
    nonce: hex32(ac.nonce, "acceptance.nonce"),
  };
  return { acceptance, sig: sig(o.sig, "sig") };
}
