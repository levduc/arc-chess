import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { EMPTY_SIGNED, channelId, unsigned } from "./abiCodec.js";
import { initialState, isCheckpoint, isGameOver, legalMoves, mover, parseMove, successor } from "./chess.js";
import { KIND, ZERO_HASH } from "./constants.js";
import { encodeMove } from "./encoding.js";
import {
  hashState,
  recoverCloseSigner,
  recoverStateSigner,
  signClose,
  signState,
  type ArenaDomain,
} from "./eip712.js";
import type { LoadableSessionStore, SessionSnapshot, SessionStore } from "./store.js";
import type { CloseTransaction, Params, PlayerIndex, Proof, SignedState, State } from "./types.js";

export class ArenaProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArenaProtocolError";
  }
}

export type CloseSignature = { stateHash: Hex; by: PlayerIndex; sig: Hex };

export type SessionConfig = {
  params: Params;
  me: PlayerIndex;
  sessionKey: Hex;
  domain: ArenaDomain;
  store: SessionStore;
};

const NO_SIG: Hex = "0x";

/** Deep-cloned, deeply frozen Params (including the participants/signers tuples). */
function frozenParams(p: Params): Params {
  const c = structuredClone(p);
  return Object.freeze({
    ...c,
    participants: Object.freeze([...c.participants]) as unknown as Params["participants"],
    signers: Object.freeze([...c.signers]) as unknown as Params["signers"],
  });
}
const CLOSING_MESSAGE = "channel is closing; no further states are signed or accepted";

/** True for any 0x-hex string, including the empty "0x" used for an absent signature. */
function isHexString(x: unknown): x is Hex {
  return typeof x === "string" && /^0x[0-9a-fA-F]*$/.test(x);
}

/**
 * Rebuilds a State from untrusted input with every field checked against its exact canonical type — unlike the
 * instance method `canonicalState` (used for on-chain data that viem has already decoded to the right JS type),
 * this never coerces: a `turnNum` of `"0"` or `0` is rejected, only an actual `bigint` is accepted. Throws a plain
 * `Error` (wrapped by the caller) on any mismatch.
 */
function strictState(v: unknown): State {
  if (typeof v !== "object" || v === null) throw new Error("state must be an object");
  const o = v as Record<string, unknown>;
  const hex = (x: unknown): Hex => {
    if (!isHexString(x)) throw new Error("not a 0x-hex string");
    return x;
  };
  const big = (x: unknown): bigint => {
    if (typeof x !== "bigint") throw new Error("not a bigint");
    return x;
  };
  const int = (x: unknown): number => {
    if (typeof x !== "number" || !Number.isSafeInteger(x) || x < 0) throw new Error("not a non-negative integer");
    return x;
  };
  return {
    channelId: hex(o.channelId),
    turnNum: big(o.turnNum),
    prevHash: hex(o.prevHash),
    balanceA: big(o.balanceA),
    balanceB: big(o.balanceB),
    gameIndex: int(o.gameIndex),
    move: int(o.move),
    board: big(o.board),
    meta: big(o.meta),
  };
}

/** True for a SignedState whose `state` passes `strictState` and whose signatures are 0x-hex strings. */
function isStrictSignedState(x: unknown): x is SignedState {
  if (typeof x !== "object" || x === null) return false;
  const o = x as Record<string, unknown>;
  if (!isHexString(o.sigA) || !isHexString(o.sigB)) return false;
  try {
    strictState(o.state);
  } catch {
    return false;
  }
  return true;
}

/** True for `null` or a value that passes `isStrictSignedState` — the shape of every nullable snapshot field. */
function isNullableSigned(x: unknown): boolean {
  return x === null || isStrictSignedState(x);
}

/** True for a two-element array of 0x-hex strings — the shape of `closeSigs`/`closeSigTargets`. */
function isHexPair(x: unknown): x is [Hex, Hex] {
  return Array.isArray(x) && x.length === 2 && isHexString(x[0]) && isHexString(x[1]);
}

/** Validates a snapshot read from storage and fills fields added after it was written. Throws on malformed data. */
function normalizeSnapshot(raw: SessionSnapshot): SessionSnapshot {
  if (typeof raw !== "object" || raw === null) throw new ArenaProtocolError("malformed session snapshot");
  const s = structuredClone(raw) as Partial<SessionSnapshot>;
  const ok =
    isHexString(s.channelId) &&
    isStrictSignedState(s.latest) &&
    isNullableSigned(s.prev) &&
    isNullableSigned(s.pendingCheckpoint) &&
    isNullableSigned(s.incomingCheckpoint) &&
    (s.lastSignedTurn === null || typeof s.lastSignedTurn === "bigint") &&
    (s.closeState === null || isStrictSignedState(s.closeState)) &&
    isHexPair(s.closeSigs);
  if (!ok) throw new ArenaProtocolError("malformed session snapshot");
  if (s.closeSigTargets === undefined) {
    // Added after some snapshots were written (see the field's own doc comment); default rather than reject.
    s.closeSigTargets = [ZERO_HASH, ZERO_HASH];
  } else if (!isHexPair(s.closeSigTargets)) {
    throw new ArenaProtocolError("malformed session snapshot");
  }
  return s as SessionSnapshot;
}

/**
 * One player's view of one channel. Validates every incoming state exactly as the hub would, signs only through
 * an equivocation guard, and persists before any signature is returned (spec §7, §12).
 *
 * Every mutating method runs under a per-instance promise-chain mutex (`lock`) so concurrent calls never race
 * against the same committed snapshot, and every mutation is built as a copy-on-write draft that is persisted
 * before `this.data` is ever replaced — a failed `store.save` leaves the session exactly as it was, releasing no
 * signature.
 */
export class ChannelSession {
  readonly params: Params;
  readonly me: PlayerIndex;
  readonly opponent: PlayerIndex;
  readonly id: Hex;
  private readonly domain: ArenaDomain;
  private readonly key: Hex;
  private readonly store: SessionStore;
  private data: SessionSnapshot;
  /** Promise-chain mutex: always resolved, so a rejected mutation never breaks the chain for later calls. */
  private mutex: Promise<void> = Promise.resolve();

  private constructor(cfg: SessionConfig, data: SessionSnapshot) {
    // Private frozen copies: a caller mutating its own params/domain objects later must not change which
    // signatures this session accepts or produces.
    const params = frozenParams(cfg.params);
    const domain: ArenaDomain = Object.freeze(structuredClone(cfg.domain));
    if (privateKeyToAccount(cfg.sessionKey).address.toLowerCase() !== params.signers[cfg.me].toLowerCase()) {
      throw new ArenaProtocolError("session key does not match params.signers[me]");
    }
    this.params = params;
    this.me = cfg.me;
    this.opponent = cfg.me === 0 ? 1 : 0;
    this.domain = domain;
    this.key = cfg.sessionKey;
    this.store = cfg.store;
    this.id = data.channelId;
    this.data = data;
  }

  static async create(cfg: SessionConfig): Promise<ChannelSession> {
    const id = channelId(cfg.domain.chainId, cfg.domain.hub, cfg.params);
    const session = new ChannelSession(cfg, {
      channelId: id,
      latest: unsigned(initialState(id, cfg.params)),
      prev: null,
      pendingCheckpoint: null,
      incomingCheckpoint: null,
      lastSignedTurn: null,
      closeState: null,
      closeSigs: [NO_SIG, NO_SIG],
      closeSigTargets: [ZERO_HASH, ZERO_HASH],
    });
    await session.store.save(session.data);
    return session;
  }

  /** Restores this channel's session from `store` if it has a snapshot, otherwise creates it (crash-safe start). */
  static async open(cfg: SessionConfig & { store: LoadableSessionStore }): Promise<ChannelSession> {
    const snapshot = await cfg.store.load();
    if (!snapshot) return ChannelSession.create(cfg);
    const session = ChannelSession.restore(cfg, snapshot);
    await session.dropUnverifiedSignatures();
    return session;
  }

  /**
   * Plan 6 hardening H1 (audit-contracts I1): a snapshot written before `verifyOnChainState` stored only verified
   * signatures may hold an event's unchecked bytes in `latest` or `prev` -- the slots `challengeProof()` reads.
   * Each non-empty slot there is checked against its signer; one that does not verify is emptied (and the result
   * saved), so a restored session builds a proof the hub accepts. A snapshot with nothing to drop is left as it is,
   * unsaved.
   */
  private dropUnverifiedSignatures(): Promise<void> {
    return this.lock(async () => {
      const draft = structuredClone(this.data);
      let dropped = false;
      const clean = async (ss: SignedState): Promise<SignedState> => {
        const out = { ...ss };
        if (out.sigA !== NO_SIG && !(await this.signedBy(0, out.state, out.sigA))) {
          out.sigA = NO_SIG;
          dropped = true;
        }
        if (out.sigB !== NO_SIG && !(await this.signedBy(1, out.state, out.sigB))) {
          out.sigB = NO_SIG;
          dropped = true;
        }
        return out;
      };
      draft.latest = await clean(draft.latest);
      if (draft.prev) draft.prev = await clean(draft.prev);
      if (!dropped) return;
      await this.store.save(draft);
      this.data = draft;
    });
  }

  static restore(cfg: SessionConfig, snapshot: SessionSnapshot): ChannelSession {
    const expected = channelId(cfg.domain.chainId, cfg.domain.hub, cfg.params);
    const data = normalizeSnapshot(snapshot);
    if (data.channelId !== expected) {
      throw new ArenaProtocolError("snapshot channelId does not match params/domain");
    }
    return new ChannelSession(cfg, data);
  }

  get latest(): SignedState {
    return structuredClone(this.data.latest);
  }

  get isClosing(): boolean {
    return this.data.closeState !== null;
  }

  snapshot(): SessionSnapshot {
    return structuredClone(this.data);
  }

  isMyTurn(): boolean {
    return this.turnCheck(this.data);
  }

  legalMoves(): string[] {
    return this.isMyTurn() ? legalMoves(this.data.latest.state) : [];
  }

  move(input: string, opts: { offerDraw?: boolean } = {}): Promise<SignedState> {
    return this.lock(async () => {
      const draft = structuredClone(this.data);
      this.requireMyTurn(draft);
      const kind = opts.offerDraw ? KIND.NORMAL_OFFER_DRAW : KIND.NORMAL;
      let encoded: number;
      try {
        encoded = parseMove(draft.latest.state, input, kind);
      } catch (err) {
        throw new ArenaProtocolError((err as Error).message);
      }
      return this.applyMove(draft, encoded);
    });
  }

  resign(): Promise<SignedState> {
    return this.lock(async () => {
      const draft = structuredClone(this.data);
      this.requireMyTurn(draft);
      return this.applyMove(draft, encodeMove(0, 0, 0, KIND.RESIGN));
    });
  }

  acceptDraw(): Promise<SignedState> {
    return this.lock(async () => {
      const draft = structuredClone(this.data);
      this.requireMyTurn(draft);
      return this.applyMove(draft, encodeMove(0, 0, 0, KIND.ACCEPT_DRAW));
    });
  }

  claimStalemate(): Promise<SignedState> {
    return this.lock(async () => {
      const draft = structuredClone(this.data);
      this.requireMyTurn(draft);
      return this.applyMove(draft, encodeMove(0, 0, 0, KIND.CLAIM_STALEMATE));
    });
  }

  proposeNewGame(): Promise<SignedState> {
    return this.lock(async () => {
      const draft = structuredClone(this.data);
      if (draft.closeState !== null) throw new ArenaProtocolError(CLOSING_MESSAGE);
      if (draft.pendingCheckpoint) return structuredClone(draft.pendingCheckpoint);
      if (draft.incomingCheckpoint) return this.applyCountersign(draft);
      if (!isGameOver(draft.latest.state)) throw new ArenaProtocolError("the game is still in progress");
      const state = this.successorFrom(draft.latest.state, encodeMove(0, 0, 0, KIND.NEW_GAME));
      const signed = await this.signInto(draft, state);
      draft.pendingCheckpoint = signed;
      await this.store.save(draft);
      this.data = draft;
      return structuredClone(signed);
    });
  }

  countersignNewGame(): Promise<SignedState> {
    return this.lock(async () => {
      const draft = structuredClone(this.data);
      if (draft.closeState !== null) throw new ArenaProtocolError(CLOSING_MESSAGE);
      return this.applyCountersign(draft);
    });
  }

  /**
   * Validates and records an opponent message (a move, or a NEW_GAME proposal/countersignature). "duplicate" and
   * "stale" (M5) mean a relay re-send this player already accounted for; neither changes anything.
   */
  receive(
    msg: SignedState,
  ): Promise<"move" | "checkpoint-proposed" | "checkpoint-complete" | "checkpoint-repaired" | "duplicate" | "stale"> {
    return this.lock(async () => {
      const draft = structuredClone(this.data);
      const repeat = await this.asProtocolError(async () => this.classifyRepeat(draft, msg));
      if (repeat === "duplicate" || repeat === "stale") return repeat;
      if (draft.closeState !== null) throw new ArenaProtocolError(CLOSING_MESSAGE);
      // classifyIncoming only reads `draft` except when it adopts a move on this player's own pending checkpoint
      // (R4): there it also signs with `draft` (equivocation guard + lastSignedTurn), same as every other write
      // below — none of it is visible outside this method until `store.save(draft)` below succeeds and swaps in.
      const v = await this.asProtocolError(() => this.classifyIncoming(draft, msg));
      switch (v.kind) {
        case "on-pending":
          this.adoptMoveOnPending(draft, v.pending, v.signed);
          break;
        case "checkpoint-complete":
          this.advanceLatest(draft, v.signed);
          draft.pendingCheckpoint = null;
          break;
        case "checkpoint-proposed":
          draft.incomingCheckpoint = v.signed;
          break;
        case "checkpoint-repaired":
          draft.prev = v.signed;
          break;
        case "move":
          this.advanceLatest(draft, v.signed);
          break;
      }
      await this.store.save(draft);
      this.data = draft;
      return v.kind === "on-pending" ? "move" : v.kind;
    });
  }

  /**
   * Checks an incoming message against `draft` and returns what to record. It leaves `draft` unchanged except in
   * one case: the opponent's first move on this player's own pending checkpoint (R4), where `moveOnPending`
   * co-signs that move through `signInto`, which writes the equivocation guard (`lastSignedTurn`) into `draft`.
   * `draft` is only a copy — nothing is visible until the caller's `store.save(draft)` succeeds.
   */
  private async classifyIncoming(
    draft: SessionSnapshot,
    msg: SignedState,
  ): Promise<
    | { kind: "on-pending"; pending: SignedState; signed: SignedState }
    | { kind: "checkpoint-complete" | "checkpoint-proposed" | "move" | "checkpoint-repaired"; signed: SignedState }
  > {
    const clonedMsg = structuredClone(msg);
    const sigA = this.asHexSig(clonedMsg.sigA);
    const sigB = this.asHexSig(clonedMsg.sigB);
    const s = clonedMsg.state;
    const latest = draft.latest.state;
    if (s.channelId !== this.id) throw new ArenaProtocolError("wrong channel");
    const prevSigned = draft.prev;
    if (
      prevSigned &&
      isCheckpoint(prevSigned.state) &&
      !this.endorsed(prevSigned) &&
      s.turnNum === prevSigned.state.turnNum &&
      hashState(s, this.domain) === hashState(prevSigned.state, this.domain)
    ) {
      // A late countersignature for the checkpoint this player adopted a move on (R9): repair `prev`.
      const oppSig = this.opponent === 0 ? sigA : sigB;
      if (!(await this.signedBy(this.opponent, prevSigned.state, oppSig))) {
        throw new ArenaProtocolError("missing or invalid opponent signature");
      }
      const repaired: SignedState =
        this.opponent === 0 ? { ...prevSigned, sigA: oppSig } : { ...prevSigned, sigB: oppSig };
      return { kind: "checkpoint-repaired", signed: repaired };
    }
    const pending = draft.pendingCheckpoint;
    if (pending && s.turnNum === pending.state.turnNum + 1n) {
      // R9/R4: the opponent's first move on the checkpoint this player proposed. Their signature on a move that
      // commits to the checkpoint endorses it (spec §4.3 rule 2), even if their countersignature never arrived;
      // this player also co-signs the move itself (inside moveOnPending), so it adopts fully signed and needs no
      // predecessor to be provable — including when it is a terminal state (was the N1 refusal; see its docstring).
      const r = await this.moveOnPending(draft, pending, s, sigA, sigB);
      if (!r.ok) throw new ArenaProtocolError(r.reason);
      return { kind: "on-pending", pending, signed: r.signed };
    }
    if (s.turnNum !== latest.turnNum + 1n) {
      throw new ArenaProtocolError(`unexpected turn ${s.turnNum}; expected ${latest.turnNum + 1n}`);
    }
    // Never trust the received state object itself — recompute it locally from our own canonical predecessor
    // and only accept the message if it hashes identically. Everything stored from here on is `expected`
    // (locally computed, canonical types), never `s` (guards against type confusion in received fields).
    const expected = this.successorFrom(latest, s.move);
    if (hashState(expected, this.domain) !== hashState(s, this.domain)) {
      throw new ArenaProtocolError("state does not match the rules");
    }
    const oppSig = this.opponent === 0 ? sigA : sigB;
    if (!(await this.signedBy(this.opponent, expected, oppSig))) {
      throw new ArenaProtocolError("missing or invalid opponent signature");
    }

    if (isCheckpoint(expected)) {
      if (pending && hashState(pending.state, this.domain) === hashState(expected, this.domain)) {
        const merged: SignedState = {
          state: expected,
          sigA: pending.sigA !== NO_SIG ? pending.sigA : sigA,
          sigB: pending.sigB !== NO_SIG ? pending.sigB : sigB,
        };
        return { kind: "checkpoint-complete", signed: merged };
      }
      return { kind: "checkpoint-proposed", signed: this.withOnly(this.opponent, expected, oppSig) };
    }

    if (!this.endorsed(draft.latest)) throw new ArenaProtocolError("the new-game checkpoint is not fully signed");
    if (mover(latest) !== this.opponent) throw new ArenaProtocolError("it is not the opponent's turn");
    return { kind: "move", signed: this.withOnly(this.opponent, expected, oppSig) };
  }

  /**
   * M5: a message this player already holds, or one older than its latest, arrives again after a relay reconnect
   * (both daemons re-send their latest). Neither changes anything, so neither is an error. A different, unverified
   * state at the latest turn is refused here (not treated as evidence -- no signature is checked in this method;
   * it is just not the state this player already has for that turn). Returns null for everything else, which then
   * takes the normal path, including the late-countersignature repair of `prev`, which must win over "stale".
   */
  private classifyRepeat(data: SessionSnapshot, msg: SignedState): "duplicate" | "stale" | null {
    let s: State;
    try {
      s = this.canonicalState(structuredClone(msg).state);
    } catch {
      return null;
    }
    if (s.channelId !== this.id) return null;
    const prev = data.prev;
    if (prev && isCheckpoint(prev.state) && !this.endorsed(prev) && s.turnNum === prev.state.turnNum) return null;
    const latest = data.latest.state;
    const h = hashState(s, this.domain);
    if (s.turnNum < latest.turnNum) return "stale";
    if (s.turnNum === latest.turnNum) {
      if (h === hashState(latest, this.domain)) return "duplicate";
      throw new ArenaProtocolError(`conflicting state for turn ${s.turnNum}`);
    }
    const incoming = data.incomingCheckpoint;
    if (incoming && s.turnNum === incoming.state.turnNum && h === hashState(incoming.state, this.domain)) {
      return "duplicate";
    }
    return null;
  }

  /**
   * Signs Close for the latest state, and only when that state is terminal (spec §12 R8). Closing on the opening
   * or on a checkpoint is never safe: the opponent can keep the Close signature, challenge the same state (which
   * the hub supports without this player's help), and let `timeout` forfeit the frozen closer's stake. On a
   * terminal state `timeout` settles balances as-is, so a withheld counter-signature costs nothing.
   * To exit between games, close on the terminal state instead of proposing the next game; to exit before
   * game 0, play a move with `offerDraw`, let the opponent accept, and close on the DRAW state.
   */
  signClose(): Promise<CloseSignature> {
    return this.lock(async () => {
      const draft = structuredClone(this.data);
      const current = draft.latest;
      const s = current.state;
      if (draft.closeState) {
        if (hashState(draft.closeState.state, this.domain) !== hashState(s, this.domain)) {
          throw new ArenaProtocolError("already signed Close for another state");
        }
        return { stateHash: hashState(s, this.domain), by: this.me, sig: draft.closeSigs[this.me] };
      }
      if (draft.pendingCheckpoint) {
        throw new ArenaProtocolError(
          "a new-game proposal is pending; close only once the next game is finished, or challenge",
        );
      }
      if (!isGameOver(s)) throw new ArenaProtocolError("can only close on a finished game");
      if (draft.lastSignedTurn !== null && draft.lastSignedTurn > s.turnNum) {
        throw new ArenaProtocolError("already signed a later state");
      }
      const sig = await signClose(this.key, s, this.domain);
      draft.closeState = current;
      draft.closeSigs[this.me] = sig;
      draft.closeSigTargets[this.me] = hashState(s, this.domain);
      await this.store.save(draft);
      this.data = draft;
      return { stateHash: hashState(s, this.domain), by: this.me, sig };
    });
  }

  receiveClose(cs: CloseSignature): Promise<void> {
    return this.lock(async () => {
      const draft = structuredClone(this.data);
      const target = (draft.closeState ?? draft.latest).state;
      // M5: an opponent Close signature this player already recorded, re-sent after a relay reconnect, is a
      // no-op -- not re-verified, not re-saved.
      if (
        typeof cs === "object" &&
        cs !== null &&
        cs.by === this.opponent &&
        draft.closeSigs[this.opponent] !== NO_SIG &&
        draft.closeSigs[this.opponent] === cs.sig &&
        draft.closeSigTargets[this.opponent] === cs.stateHash
      ) {
        return;
      }
      const sig = await this.asProtocolError(async () => {
        const clonedCs = structuredClone(cs);
        if (clonedCs.by !== this.opponent) throw new ArenaProtocolError("close signature is not from the opponent");
        const cloneSig = this.asHexSig(clonedCs.sig);
        if (clonedCs.stateHash !== hashState(target, this.domain)) {
          throw new ArenaProtocolError("close signature is for a different state");
        }
        // I2: this player can only close on a finished game (see signClose), so recording an opponent's Close
        // signature on anything else only produces a close request that can never be honoured — and, in the
        // daemon, a `close-requested` attention that wakes the agent forever. Refuse it outright.
        if (!isGameOver(target)) {
          throw new ArenaProtocolError("close signature for a state that is not a finished game");
        }
        let signer: string;
        try {
          signer = await recoverCloseSigner(target, cloneSig, this.domain);
        } catch {
          throw new ArenaProtocolError("invalid close signature");
        }
        if (signer.toLowerCase() !== this.params.signers[this.opponent].toLowerCase()) {
          throw new ArenaProtocolError("invalid close signature");
        }
        return cloneSig;
      });
      draft.closeSigs[this.opponent] = sig;
      draft.closeSigTargets[this.opponent] = hashState(target, this.domain);
      await this.store.save(draft);
      this.data = draft;
    });
  }

  /**
   * The SignedState to pass to ChannelHub.closeCooperative once both Close signatures exist for `closeState`.
   * Re-checks (synchronously, from data recorded when each signature was stored) that both signatures were
   * verified against the exact state closeTransaction is about to return — a signature captured against a state
   * that stopped being current (see `closeSigTargets`) never gets paired with the wrong `closeState`.
   */
  closeTransaction(): CloseTransaction | null {
    const target = this.data.closeState;
    const [sigA, sigB] = this.data.closeSigs;
    const [targetA, targetB] = this.data.closeSigTargets;
    if (!target || sigA === NO_SIG || sigB === NO_SIG) return null;
    const wanted = hashState(target.state, this.domain);
    if (targetA !== wanted || targetB !== wanted) return null;
    return structuredClone({ kind: "close", state: target.state, sigA, sigB });
  }

  /** Proof that the latest state is supported (spec §4.3), for challenge() or respond(). */
  challengeProof(): Proof {
    const latest = this.data.latest;
    const fullySigned = latest.sigA !== NO_SIG && latest.sigB !== NO_SIG;
    if (fullySigned) return structuredClone({ hasPrev: false, prev: EMPTY_SIGNED, latest });
    if (latest.state.turnNum === 0n) {
      // The hub supports the opening with both slots empty, or both valid (audit I1). A lone signature -- which a
      // snapshot or event from the pre-I1 hub can leave -- is left out, so the proof is never one the hub refuses.
      return structuredClone({ hasPrev: false, prev: EMPTY_SIGNED, latest: unsigned(latest.state) });
    }
    const prev = this.data.prev;
    if (!prev) throw new ArenaProtocolError("no endorsed predecessor for the latest state");
    if (isCheckpoint(prev.state) && !this.endorsed(prev)) {
      // Defensive: R4 co-signs every adopted move on this player's own pending checkpoint, so `latest` is fully
      // signed and this branch is not reachable from that path any more; kept as a guard for any other path that
      // might still leave `prev` a lone-signed checkpoint. Does not assume a move is possible from here.
      throw new ArenaProtocolError(
        "the new-game checkpoint before the latest state lacks the opponent's countersignature; wait for the countersignature before challenging on this predecessor",
      );
    }
    return structuredClone({ hasPrev: true, prev, latest });
  }

  /**
   * Adopts a state registered on-chain (Challenged/Responded event). Returns false if not newer. Accepts a
   * state only if it is independently verifiable — the opening state, a state with both signatures valid, a
   * state that is exactly the canonical successor of `latest` carrying a valid signature by `latest`'s mover
   * (both signatures if it is a checkpoint), or (R9) the opponent's signed move on this player's pending
   * new-game checkpoint — never a state trusted merely because an RPC produced it.
   */
  ingestOnChain(signed: SignedState): Promise<boolean> {
    return this.lock(async () => {
      const draft = structuredClone(this.data);
      const pending = draft.pendingCheckpoint;
      let repaired = false;
      const accepted = await this.asProtocolError(async () => {
        const clonedSigned = structuredClone(signed);
        if (clonedSigned.state.channelId !== this.id) throw new ArenaProtocolError("wrong channel");
        let turnNum: bigint;
        try {
          turnNum = this.canonicalState(clonedSigned.state).turnNum; // malformed fields fail even when stale
        } catch {
          throw new ArenaProtocolError("unverifiable on-chain state");
        }
        if (turnNum <= draft.latest.state.turnNum) {
          // H1 fix round 1 (review I-1(b)): an event for a state this session already holds -- typically one it
          // adopted unsigned from the hub's storage (`adoptRegistered`) -- may carry the signature it lacks.
          repaired = await this.repairFromEvent(draft, clonedSigned);
          return null;
        }
        return this.verifyOnChainState(draft, clonedSigned);
      });
      if (accepted === null) {
        if (repaired) {
          await this.store.save(draft);
          this.data = draft;
        }
        return false;
      }

      if (accepted.onPending && pending) {
        this.adoptMoveOnPending(draft, pending, accepted.signed);
      } else {
        draft.pendingCheckpoint = null;
        draft.incomingCheckpoint = null;
        this.ingestLatest(draft, accepted.signed);
      }
      await this.store.save(draft);
      this.data = draft;
      return true;
    });
  }

  /**
   * H1 fix round 1 (review I-1(b)): adopts the hub's *registered* state, read from contract storage, when its event
   * cannot be read -- an oversized `Challenged` event whose `getLogs` response the RPC refuses. Without it, the dispute
   * pass holds nothing newer than its latest, cannot answer, and the challenger's `timeout` forfeits this player's
   * current game. The hub endorses a `prev` whose hash is `registeredHash` with no signature at all
   * (`ChannelHub._supported`), so a move made on the adopted state can answer the challenge.
   *
   * Accepted only as the canonical successor of `latest`: exactly the next turn, chaining from it, recomputed by the
   * rules, not a checkpoint, the opponent's move, and hashing to `registeredHash` (which the caller reads from the
   * hub). It is stored with no signature -- none was verified -- so it is provable only while it is registered:
   * after this player's respond, a later challenge needs the opponent's signature. The hub verifies ECDSA only, so
   * the event that registered the move carries that signature in a form this SDK verifies, and once it can be read
   * `ingestOnChain` repairs the state. An RPC that lies about both reads can make this player sign a move no proof
   * accepts: a liveness cost, or at worst the current game, as an RPC that hides a challenge already can (h1-rereview
   * N-1). Returns false, changing nothing, for anything else.
   */
  adoptRegistered(state: State, registeredHash: Hex): Promise<boolean> {
    return this.lock(async () => {
      const draft = structuredClone(this.data);
      if (draft.closeState !== null) return false;
      let canonical: State;
      try {
        canonical = this.canonicalState(structuredClone(state));
      } catch {
        return false;
      }
      const latest = draft.latest.state;
      if (canonical.channelId !== this.id || canonical.turnNum !== latest.turnNum + 1n) return false;
      if (canonical.prevHash !== hashState(latest, this.domain)) return false;
      if (!this.endorsed(draft.latest) || mover(latest) !== this.opponent) return false;
      let expected: State;
      try {
        expected = this.successorFrom(latest, canonical.move);
      } catch {
        return false;
      }
      const h = hashState(expected, this.domain);
      if (h !== hashState(canonical, this.domain) || h !== registeredHash || isCheckpoint(expected)) return false;
      draft.pendingCheckpoint = null;
      draft.incomingCheckpoint = null;
      this.ingestLatest(draft, unsigned(expected));
      await this.store.save(draft);
      this.data = draft;
      return true;
    });
  }

  /** H1 fix round 1: fills an empty signature slot of `latest` or `prev` from an on-chain event for the same state,
   *  when the event's signature for that slot verifies. Returns whether anything was filled. Never throws. */
  private async repairFromEvent(draft: SessionSnapshot, msg: SignedState): Promise<boolean> {
    let state: State;
    let sigs: [Hex, Hex];
    try {
      state = this.canonicalState(msg.state);
      sigs = [this.asHexSig(msg.sigA), this.asHexSig(msg.sigB)];
    } catch {
      return false;
    }
    const h = hashState(state, this.domain);
    let filled = false;
    for (const slot of ["latest", "prev"] as const) {
      const ss = draft[slot];
      if (!ss || hashState(ss.state, this.domain) !== h) continue;
      const out = { ...ss };
      for (const p of [0, 1] as const) {
        const key = p === 0 ? "sigA" : "sigB";
        if (out[key] === NO_SIG && (await this.signedBy(p, ss.state, sigs[p]))) {
          out[key] = sigs[p];
          filled = true;
        }
      }
      draft[slot] = out;
    }
    return filled;
  }

  /**
   * Runs validation of untrusted input and reports any failure as an ArenaProtocolError: malformed fields (a
   * non-bigint or NaN number, a bad move type, a non-object message) otherwise surface as raw TypeError /
   * RangeError / viem errors from comparison, hashing or signature recovery. Only wraps validation — never
   * `store.save`, whose errors callers must see unchanged.
   */
  private async asProtocolError<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof ArenaProtocolError) throw err;
      const detail = err instanceof Error ? err.message.split("\n")[0] : String(err);
      throw new ArenaProtocolError(`malformed message: ${detail}`);
    }
  }

  /** Serializes every mutating call through a promise chain; a rejection never blocks the next call. */
  private lock<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.mutex.then(fn);
    this.mutex = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** M3: a closing session reports "closing" rather than "not your turn", so callers can tell the two apart. */
  private requireMyTurn(d: SessionSnapshot): void {
    if (d.closeState !== null) throw new ArenaProtocolError(CLOSING_MESSAGE);
    if (!this.turnCheck(d)) throw new ArenaProtocolError("not your turn");
  }

  private turnCheck(d: SessionSnapshot): boolean {
    const s = d.latest.state;
    return d.closeState === null && !isGameOver(s) && this.endorsed(d.latest) && mover(s) === this.me;
  }

  private async applyMove(draft: SessionSnapshot, move: number): Promise<SignedState> {
    const state = this.successorFrom(draft.latest.state, move);
    const signed = await this.signInto(draft, state);
    this.advanceLatest(draft, signed);
    await this.store.save(draft);
    this.data = draft;
    return structuredClone(signed);
  }

  private async applyCountersign(draft: SessionSnapshot): Promise<SignedState> {
    const incoming = draft.incomingCheckpoint;
    if (!incoming) throw new ArenaProtocolError("no new-game proposal to countersign");
    const signed = await this.signInto(draft, incoming.state, incoming);
    this.advanceLatest(draft, signed);
    draft.incomingCheckpoint = null;
    await this.store.save(draft);
    this.data = draft;
    return structuredClone(signed);
  }

  /** Canonical successor of `prevState` with prevHash set. Throws if the move is illegal. */
  private successorFrom(prevState: State, move: number): State {
    const r = successor(prevState, move, this.params);
    if (!r.ok) throw new ArenaProtocolError(`illegal: ${r.reason}`);
    return { ...r.next, prevHash: hashState(prevState, this.domain) };
  }

  private async signInto(draft: SessionSnapshot, state: State, base?: SignedState): Promise<SignedState> {
    if (draft.closeState !== null) throw new ArenaProtocolError(CLOSING_MESSAGE);
    const last = draft.lastSignedTurn;
    if (last !== null && state.turnNum <= last) {
      throw new ArenaProtocolError(`refusing to sign turn ${state.turnNum}: already signed turn ${last}`);
    }
    const sig = await signState(this.key, state, this.domain);
    draft.lastSignedTurn = state.turnNum;
    const out: SignedState = base ? { ...base, state } : unsigned(state);
    if (this.me === 0) out.sigA = sig;
    else out.sigB = sig;
    return out;
  }

  /** Advances `latest` for the normal protocol path (every new state directly extends the old one). */
  private advanceLatest(draft: SessionSnapshot, next: SignedState): void {
    draft.prev = draft.latest;
    draft.latest = next;
    this.invalidateOpponentClose(draft);
  }

  /** Advances `latest` for an on-chain ingest, which may jump ahead without a direct chain to the old latest. */
  private ingestLatest(draft: SessionSnapshot, next: SignedState): void {
    const chains = hashState(draft.latest.state, this.domain) === next.state.prevHash;
    draft.prev = chains ? draft.latest : null;
    draft.latest = next;
    this.invalidateOpponentClose(draft);
  }

  /**
   * R9: checks that `s` is the opponent's move on this player's pending NEW_GAME checkpoint — the next turn,
   * committing to the checkpoint's hash, exactly the canonical successor, not itself a checkpoint, and signed by
   * the checkpoint's mover (who must be the opponent). R4: once verified, this player ALSO signs the move itself
   * through the normal equivocation-guarded path (`signInto`, written into `draft`) — the opponent's signature on
   * a state committing to the checkpoint already endorses the checkpoint (spec §4.3 rule 2), so nothing is lost by
   * also co-signing the move; doing so makes the adopted state fully signed and provable with no predecessor,
   * closing the liveness gap where a terminal C+1 left `prev` a checkpoint only this player had signed (N1).
   * Returns the canonical, fully-signed state, never the received object.
   */
  private async moveOnPending(
    draft: SessionSnapshot,
    pending: SignedState,
    s: State,
    sigA: Hex,
    sigB: Hex,
  ): Promise<{ ok: true; signed: SignedState } | { ok: false; reason: string }> {
    const base = pending.state;
    if (s.turnNum !== base.turnNum + 1n || s.prevHash !== hashState(base, this.domain)) {
      return { ok: false, reason: "state does not extend the pending new-game checkpoint" };
    }
    if (mover(base) !== this.opponent) return { ok: false, reason: "it is not the opponent's turn" };
    let expected: State;
    try {
      expected = this.successorFrom(base, s.move);
    } catch (err) {
      return { ok: false, reason: (err as Error).message };
    }
    if (hashState(expected, this.domain) !== hashState(s, this.domain) || isCheckpoint(expected)) {
      return { ok: false, reason: "state does not match the rules" };
    }
    const oppSig = this.opponent === 0 ? sigA : sigB;
    if (!(await this.signedBy(this.opponent, expected, oppSig))) {
      return { ok: false, reason: "missing or invalid opponent signature" };
    }
    const signed = await this.signInto(draft, expected, this.withOnly(this.opponent, expected, oppSig));
    return { ok: true, signed };
  }

  /**
   * R9/R4: adopts the opponent's move on the pending checkpoint, already co-signed by this player (see
   * `moveOnPending`). `latest` becomes that fully-signed move — provable on its own, `challengeProof` returns
   * `hasPrev: false` for it — and `prev` becomes the checkpoint, still carrying only this player's signature; a
   * countersignature that arrives later repairs it (harmless, since `latest` no longer depends on it).
   */
  private adoptMoveOnPending(draft: SessionSnapshot, pending: SignedState, move: SignedState): void {
    draft.prev = pending;
    draft.latest = move;
    draft.pendingCheckpoint = null;
    draft.incomingCheckpoint = null;
    this.invalidateOpponentClose(draft);
  }

  /** Minor 5: a Close signature captured against a state that is no longer `latest` must never be reused. */
  private invalidateOpponentClose(draft: SessionSnapshot): void {
    draft.closeSigs[this.opponent] = NO_SIG;
    draft.closeSigTargets[this.opponent] = ZERO_HASH;
  }

  private endorsed(ss: SignedState): boolean {
    return !isCheckpoint(ss.state) || (ss.sigA !== NO_SIG && ss.sigB !== NO_SIG);
  }

  private withOnly(player: PlayerIndex, state: State, sig: Hex): SignedState {
    return player === 0 ? { state, sigA: sig, sigB: NO_SIG } : { state, sigA: NO_SIG, sigB: sig };
  }

  private async signedBy(player: PlayerIndex, state: State, sig: Hex): Promise<boolean> {
    if (sig === NO_SIG) return false;
    try {
      const who = await recoverStateSigner(state, sig, this.domain);
      return who.toLowerCase() === this.params.signers[player].toLowerCase();
    } catch {
      return false;
    }
  }

  /** I3 / Minor: signatures taken from an untrusted message must be well-formed 0x-hex before use. */
  private asHexSig(x: unknown): Hex {
    if (typeof x !== "string" || !/^0x[0-9a-fA-F]*$/.test(x)) {
      throw new ArenaProtocolError("signature must be a 0x-hex string");
    }
    return x as Hex;
  }

  /** Defensively rebuilds a State with each field coerced to its canonical type, or throws. */
  private canonicalState(s: State): State {
    const hex = (v: unknown): Hex => {
      if (typeof v !== "string" || !/^0x[0-9a-fA-F]*$/.test(v)) throw new Error("not a 0x-hex string");
      return v as Hex;
    };
    const int = (v: unknown): number => {
      const n = Number(v);
      if (!Number.isSafeInteger(n) || n < 0) throw new Error("not a non-negative integer");
      return n;
    };
    return {
      channelId: hex(s.channelId),
      turnNum: BigInt(s.turnNum as unknown as bigint),
      prevHash: hex(s.prevHash),
      balanceA: BigInt(s.balanceA as unknown as bigint),
      balanceB: BigInt(s.balanceB as unknown as bigint),
      gameIndex: int(s.gameIndex),
      move: int(s.move),
      board: BigInt(s.board as unknown as bigint),
      meta: BigInt(s.meta as unknown as bigint),
    };
  }

  /**
   * I4: accept an on-chain state only if it is independently verifiable; otherwise "unverifiable on-chain state".
   *
   * Plan 6 hardening H1 (audit-contracts I1): what is returned carries only signatures this method verified. The hub
   * checks only the mover's slot of a `hasPrev` proof (and neither slot of the opening state), and re-emits the whole
   * `proof.latest` in `Challenged`/`Responded` -- so the other slot of an event can hold any bytes a griefer chose.
   * Stored as-is, a non-empty junk slot made `challengeProof()` take the state for fully signed (`hasPrev: false`),
   * a proof the hub rejects (`Unsupported`) on every try, leaving this player no exit of its own. So: the opening
   * state is stored unsigned; a state both of whose signatures verify keeps both; a canonical successor keeps only
   * its mover's (both, for a checkpoint, where both are verified); R9's adopted move is re-signed by this player.
   * Unverified bytes are dropped, never stored, so the proof this session builds is always one the hub accepts.
   */
  private async verifyOnChainState(
    draft: SessionSnapshot,
    msg: SignedState,
  ): Promise<{ signed: SignedState; onPending: boolean }> {
    const unverifiable = () => new ArenaProtocolError("unverifiable on-chain state");
    let sigA: Hex;
    let sigB: Hex;
    let canonical: State;
    try {
      sigA = this.asHexSig(msg.sigA);
      sigB = this.asHexSig(msg.sigB);
      canonical = this.canonicalState(msg.state);
    } catch {
      throw unverifiable();
    }

    // (i) the opening state is always self-evidently the channel's start. The hub reads neither slot for it, so
    // neither is kept (H1, audit-contracts I1): the opening needs no signature to be proven.
    if (canonical.turnNum === 0n) return { signed: unsigned(canonical), onPending: false };

    // (ii) any state with both signatures valid is supported regardless of how far ahead it is.
    const bothSigned =
      sigA !== NO_SIG &&
      sigB !== NO_SIG &&
      (await this.signedBy(0, canonical, sigA)) &&
      (await this.signedBy(1, canonical, sigB));
    if (bothSigned) return { signed: { state: canonical, sigA, sigB }, onPending: false };

    // (iii) a state that is exactly the canonical successor of `latest`, signed by latest's mover (both
    // signatures if it is a checkpoint).
    const latest = draft.latest.state;
    if (canonical.turnNum === latest.turnNum + 1n && canonical.prevHash === hashState(latest, this.domain)) {
      let expected: State;
      try {
        expected = this.successorFrom(latest, canonical.move);
      } catch {
        throw unverifiable();
      }
      if (hashState(expected, this.domain) === hashState(canonical, this.domain)) {
        const moverIdx = mover(latest);
        const moverSig = moverIdx === 0 ? sigA : sigB;
        const moverOk = await this.signedBy(moverIdx, expected, moverSig);
        const checkpoint = isCheckpoint(expected);
        const checkpointOk =
          !checkpoint || ((await this.signedBy(0, expected, sigA)) && (await this.signedBy(1, expected, sigB)));
        if (moverOk && checkpointOk) {
          // H1 (audit-contracts I1): only what was verified -- both slots for a checkpoint, else the mover's alone.
          // The other slot of a move is never read by the hub, so the event's bytes there prove nothing.
          const signed = checkpoint ? { state: expected, sigA, sigB } : this.withOnly(moverIdx, expected, moverSig);
          return { signed, onPending: false };
        }
      }
    }

    // (iv) R9/R4: the opponent's move on this player's pending NEW_GAME checkpoint (e.g. registered by a challenge
    // after their countersignature was withheld or lost), co-signed by this player (see moveOnPending).
    const pending = draft.pendingCheckpoint;
    if (pending) {
      const r = await this.moveOnPending(draft, pending, canonical, sigA, sigB);
      if (r.ok) return { signed: r.signed, onPending: true };
    }

    throw unverifiable();
  }
}
