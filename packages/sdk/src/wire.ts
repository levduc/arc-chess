import { encodeAbiParameters, keccak256, recoverMessageAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { CloseSignature } from "./session.js";
import type { Params, PlayerIndex, SignedState } from "./types.js";

// ---------------------------------------------------------------- JSON codec

/** JSON with bigints encoded as {"$bigint":"<decimal>"} so protocol values survive the wire and disk. */
export function toWire(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? { $bigint: v.toString() } : v));
}

const BIGINT_RE = /^-?[0-9]+$/;

export function fromWire<T>(text: string): T {
  return JSON.parse(text, (_k, v) => {
    if (v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 1 && typeof v.$bigint === "string") {
      if (v.$bigint.length > 80 || !BIGINT_RE.test(v.$bigint)) throw new Error("invalid $bigint");
      return BigInt(v.$bigint);
    }
    return v;
  }) as T;
}

// -------------------------------------------------------------- offers

export type Offer = {
  template: "chess";
  player: Address;
  signer: Address;
  deposit: bigint;
  stakePerGame: bigint;
  challengeTimeout: bigint;
  expiresAt: bigint;
  nonce: Hex;
};
export type SignedOffer = { offer: Offer; sig: Hex };

export type Acceptance = { offerId: Hex; player: Address; signer: Address; nonce: Hex };
export type SignedAcceptance = { acceptance: Acceptance; sig: Hex };

export function offerId(o: Offer): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "string" },
        { type: "address" },
        { type: "address" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "uint64" },
        { type: "uint64" },
        { type: "bytes32" },
      ],
      [o.template, o.player, o.signer, o.deposit, o.stakePerGame, o.challengeTimeout, o.expiresAt, o.nonce],
    ),
  );
}

export function acceptanceDigest(a: Acceptance): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "address" }, { type: "address" }, { type: "bytes32" }],
      [a.offerId, a.player, a.signer, a.nonce],
    ),
  );
}

/** Signed by the offer's session key (EIP-191 over offerId), proving the offerer controls `signer`. */
export function signOffer(key: Hex, o: Offer): Promise<Hex> {
  return privateKeyToAccount(key).signMessage({ message: { raw: offerId(o) } });
}

export async function verifyOffer(so: SignedOffer): Promise<boolean> {
  try {
    const who = await recoverMessageAddress({ message: { raw: offerId(so.offer) }, signature: so.sig });
    return who.toLowerCase() === so.offer.signer.toLowerCase();
  } catch {
    return false;
  }
}

export function signAcceptance(key: Hex, a: Acceptance): Promise<Hex> {
  return privateKeyToAccount(key).signMessage({ message: { raw: acceptanceDigest(a) } });
}

export async function verifyAcceptance(sa: SignedAcceptance): Promise<boolean> {
  try {
    const who = await recoverMessageAddress({ message: { raw: acceptanceDigest(sa.acceptance) }, signature: sa.sig });
    return who.toLowerCase() === sa.acceptance.signer.toLowerCase();
  } catch {
    return false;
  }
}

// -------------------------------------------------------------- matching

export type MatchTerms = { rules: Address; feeRecipient: Address; feePerPlayer: bigint; fundingWindow: bigint };

/** The host's matching rule (spec §5): offerer is participants[0] and deposits first. */
export function buildParams(o: Offer, a: Acceptance, terms: MatchTerms, now: bigint): Params {
  return {
    participants: [o.player, a.player],
    signers: [o.signer, a.signer],
    rules: terms.rules,
    feeRecipient: terms.feeRecipient,
    feePerPlayer: terms.feePerPlayer,
    deposit: o.deposit,
    stakePerGame: o.stakePerGame,
    challengeTimeout: o.challengeTimeout,
    fundingDeadline: now + terms.fundingWindow,
    salt: keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }], [a.offerId, a.nonce])),
  };
}

export type MatchExpectation = {
  me: PlayerIndex;
  player: Address;
  signer: Address;
  rules: Address;
  deposit: bigint;
  stakePerGame: bigint;
  challengeTimeout: bigint;
  feeRecipient: Address;
  minFeePerPlayer: bigint;
  maxFeePerPlayer: bigint;
  now: bigint;
  maxFundingWindow: bigint;
  /**
   * The other side's wallet and session key, when this player already knows them -- the accepter does: it accepted
   * one specific signed offer. Without it, the other side is not bound (the offerer's case: any accepter may match),
   * and a host could seat anyone opposite this player on the same terms (Plan 4.5 Task 9).
   */
  opponent?: { player: Address; signer: Address };
};

const same = (x: string, y: string) => x.toLowerCase() === y.toLowerCase();

/** Returns why these params must not be funded by the expecting player, or null if they are acceptable. */
export function checkMatchParams(p: Params, e: MatchExpectation): string | null {
  if (!same(p.participants[e.me], e.player)) return "params do not name this player's wallet";
  if (!same(p.signers[e.me], e.signer)) return "params do not name this player's session key";
  if (same(p.participants[0], p.participants[1]) || same(p.signers[0], p.signers[1])) return "participants or signers repeat";
  if (e.opponent) {
    const other = e.me === 0 ? 1 : 0;
    if (!same(p.participants[other], e.opponent.player)) return "params do not name the expected opponent's wallet";
    if (!same(p.signers[other], e.opponent.signer)) return "params do not name the expected opponent's session key";
  }
  if (!same(p.rules, e.rules)) return "unexpected rules contract";
  if (p.deposit !== e.deposit || p.stakePerGame !== e.stakePerGame || p.challengeTimeout !== e.challengeTimeout) {
    return "amounts differ from the agreed offer";
  }
  if (p.fundingDeadline <= e.now || p.fundingDeadline > e.now + e.maxFundingWindow) return "unexpected funding deadline";
  if (!same(p.feeRecipient, e.feeRecipient)) return "unexpected fee recipient";
  if (p.feePerPlayer < e.minFeePerPlayer || p.feePerPlayer > e.maxFeePerPlayer) return "unexpected fee";
  return null;
}

// -------------------------------------------------------------- messages and transports

export type RelayMessage =
  | { type: "state"; channelId: Hex; signed: SignedState }
  | { type: "close"; channelId: Hex; close: CloseSignature };

export type MatchEvent = { offerId: Hex; params: Params };

export type RelaySigner = { readonly address: Address; signMessage(args: { message: { raw: Hex } }): Promise<Hex> };

/** What a session key signs to join a channel on the relay: bound to the channel and to this connection's nonce. */
export function relayJoinDigest(channelId: Hex, nonce: Hex): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "string" }, { type: "bytes32" }, { type: "bytes32" }],
      ["arena-relay-join", channelId, nonce],
    ),
  );
}

export function signRelayJoin(signer: RelaySigner, channelId: Hex, nonce: Hex): Promise<Hex> {
  return signer.signMessage({ message: { raw: relayJoinDigest(channelId, nonce) } });
}

export async function verifyRelayJoin(channelId: Hex, nonce: Hex, signer: Address, sig: Hex): Promise<boolean> {
  try {
    const who = await recoverMessageAddress({ message: { raw: relayJoinDigest(channelId, nonce) }, signature: sig });
    return who.toLowerCase() === signer.toLowerCase();
  } catch {
    return false;
  }
}

/** Lobby side of the host. Plan 4 implements it in packages/cli/src/host.ts. */
export interface LobbyClient {
  postOffer(so: SignedOffer): Promise<Hex>;
  listOffers(): Promise<SignedOffer[]>;
  accept(sa: SignedAcceptance): Promise<void>;
  onMatch(handler: (m: MatchEvent) => void): () => void;
  /** Ask the host to deliver match events for these offers, including ones matched while this client was away. */
  watch(offerIds: Hex[]): void;
  /** Stop watching these offers (expired or settled), freeing their slots on the host connection. */
  unwatch(offerIds: Hex[]): void;
  /** Fires when the host refuses a subscribe (e.g. "too many watched offers" -- this connection's watch-slot
   *  cap): a sign that some offer this client cares about is not being watched, so an agent/operator can see it
   *  instead of silently missing a match. Plan 4.5 Task 11 fix round: the load-bearing leak (a matched offer that
   *  was never unwatched) means a long-lived daemon could eventually hit this even so -- this is the backstop. */
  onWatchRefused(handler: (message: string) => void): () => void;
}

/** Relay side of the host: forwards signed messages between a channel's two session keys. Plan 4 implements it in
 *  packages/cli/src/host.ts. */
export interface RelayClient {
  /** Joins the channel as `signer` (one of params.signers). The private key never reaches the transport (I5). */
  join(channelId: Hex, params: Params, signer: RelaySigner): Promise<void>;
  send(msg: RelayMessage): Promise<void>;
  onMessage(handler: (msg: RelayMessage) => void): () => void;
  /** Fires every time the host confirms membership of a channel: after the first join and after each reconnect. */
  onJoined(handler: (channelId: Hex) => void): () => void;
  /** Leaves the channel for good (it is settled): it is no longer re-joined on reconnect, and the host frees its
   *  per-connection slot. */
  leave(channelId: Hex): void;
}
