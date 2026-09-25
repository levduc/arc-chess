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
import type { SessionSnapshot, SessionStore } from "./store.js";
import type { Params, PlayerIndex, Proof, SignedState, State } from "./types.js";

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
const CLOSING_MESSAGE = "channel is closing; no further states are signed or accepted";

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
    if (privateKeyToAccount(cfg.sessionKey).address.toLowerCase() !== cfg.params.signers[cfg.me].toLowerCase()) {
      throw new ArenaProtocolError("session key does not match params.signers[me]");
    }
    this.params = cfg.params;
    this.me = cfg.me;
    this.opponent = cfg.me === 0 ? 1 : 0;
    this.domain = cfg.domain;
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

  static restore(cfg: SessionConfig, snapshot: SessionSnapshot): ChannelSession {
    const expected = channelId(cfg.domain.chainId, cfg.domain.hub, cfg.params);
    if (snapshot.channelId !== expected) {
      throw new ArenaProtocolError("snapshot channelId does not match params/domain");
    }
    return new ChannelSession(cfg, structuredClone(snapshot));
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
      if (!this.turnCheck(draft)) throw new ArenaProtocolError("not your turn");
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
      if (!this.turnCheck(draft)) throw new ArenaProtocolError("not your turn");
      return this.applyMove(draft, encodeMove(0, 0, 0, KIND.RESIGN));
    });
  }

  acceptDraw(): Promise<SignedState> {
    return this.lock(async () => {
      const draft = structuredClone(this.data);
      if (!this.turnCheck(draft)) throw new ArenaProtocolError("not your turn");
      return this.applyMove(draft, encodeMove(0, 0, 0, KIND.ACCEPT_DRAW));
    });
  }

  claimStalemate(): Promise<SignedState> {
    return this.lock(async () => {
      const draft = structuredClone(this.data);
      if (!this.turnCheck(draft)) throw new ArenaProtocolError("not your turn");
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

  /** Validates and records an opponent message (a move, or a NEW_GAME proposal/countersignature). */
  receive(msg: SignedState): Promise<"move" | "checkpoint-proposed" | "checkpoint-complete"> {
    return this.lock(async () => {
      const draft = structuredClone(this.data);
      if (draft.closeState !== null) throw new ArenaProtocolError(CLOSING_MESSAGE);

      const clonedMsg = structuredClone(msg);
      const sigA = this.asHexSig(clonedMsg.sigA);
      const sigB = this.asHexSig(clonedMsg.sigB);
      const s = clonedMsg.state;
      const latest = draft.latest.state;
      if (s.channelId !== this.id) throw new ArenaProtocolError("wrong channel");
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
        const pending = draft.pendingCheckpoint;
        if (pending && hashState(pending.state, this.domain) === hashState(expected, this.domain)) {
          const merged: SignedState = {
            state: expected,
            sigA: pending.sigA !== NO_SIG ? pending.sigA : sigA,
            sigB: pending.sigB !== NO_SIG ? pending.sigB : sigB,
          };
          this.advanceLatest(draft, merged);
          draft.pendingCheckpoint = null;
          await this.store.save(draft);
          this.data = draft;
          return "checkpoint-complete";
        }
        draft.incomingCheckpoint = this.withOnly(this.opponent, expected, oppSig);
        await this.store.save(draft);
        this.data = draft;
        return "checkpoint-proposed";
      }

      if (!this.endorsed(draft.latest)) throw new ArenaProtocolError("the new-game checkpoint is not fully signed");
      if (mover(latest) !== this.opponent) throw new ArenaProtocolError("it is not the opponent's turn");
      this.advanceLatest(draft, this.withOnly(this.opponent, expected, oppSig));
      await this.store.save(draft);
      this.data = draft;
      return "move";
    });
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
      const clonedCs = structuredClone(cs);
      if (clonedCs.by !== this.opponent) throw new ArenaProtocolError("close signature is not from the opponent");
      const sig = this.asHexSig(clonedCs.sig);
      const target = (draft.closeState ?? draft.latest).state;
      if (clonedCs.stateHash !== hashState(target, this.domain)) {
        throw new ArenaProtocolError("close signature is for a different state");
      }
      const signer = await recoverCloseSigner(target, sig, this.domain);
      if (signer.toLowerCase() !== this.params.signers[this.opponent].toLowerCase()) {
        throw new ArenaProtocolError("invalid close signature");
      }
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
  closeTransaction(): SignedState | null {
    const target = this.data.closeState;
    const [sigA, sigB] = this.data.closeSigs;
    const [targetA, targetB] = this.data.closeSigTargets;
    if (!target || sigA === NO_SIG || sigB === NO_SIG) return null;
    const wanted = hashState(target.state, this.domain);
    if (targetA !== wanted || targetB !== wanted) return null;
    return structuredClone({ state: target.state, sigA, sigB });
  }

  /** Proof that the latest state is supported (spec §4.3), for challenge() or respond(). */
  challengeProof(): Proof {
    const latest = this.data.latest;
    const fullySigned = latest.sigA !== NO_SIG && latest.sigB !== NO_SIG;
    if (latest.state.turnNum === 0n || fullySigned) {
      return structuredClone({ hasPrev: false, prev: EMPTY_SIGNED, latest });
    }
    if (!this.data.prev) throw new ArenaProtocolError("no endorsed predecessor for the latest state");
    return structuredClone({ hasPrev: true, prev: this.data.prev, latest });
  }

  /**
   * Adopts a state registered on-chain (Challenged/Responded event). Returns false if not newer. Accepts a
   * state only if it is independently verifiable — the opening state, a state with both signatures valid, or a
   * state that is exactly the canonical successor of `latest` carrying a valid signature by `latest`'s mover
   * (both signatures if it is a checkpoint) — never a state trusted merely because an RPC produced it.
   */
  ingestOnChain(signed: SignedState): Promise<boolean> {
    return this.lock(async () => {
      const draft = structuredClone(this.data);
      const clonedSigned = structuredClone(signed);
      if (clonedSigned.state.channelId !== this.id) throw new ArenaProtocolError("wrong channel");
      if (clonedSigned.state.turnNum <= draft.latest.state.turnNum) return false;

      const accepted = await this.verifyOnChainState(draft, clonedSigned);

      draft.pendingCheckpoint = null;
      draft.incomingCheckpoint = null;
      this.ingestLatest(draft, accepted);
      await this.store.save(draft);
      this.data = draft;
      return true;
    });
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
    return {
      channelId: hex(s.channelId),
      turnNum: BigInt(s.turnNum as unknown as bigint),
      prevHash: hex(s.prevHash),
      balanceA: BigInt(s.balanceA as unknown as bigint),
      balanceB: BigInt(s.balanceB as unknown as bigint),
      gameIndex: Number(s.gameIndex),
      move: Number(s.move),
      board: BigInt(s.board as unknown as bigint),
      meta: BigInt(s.meta as unknown as bigint),
    };
  }

  /** I4: accept an on-chain state only if it is independently verifiable; otherwise "unverifiable on-chain state". */
  private async verifyOnChainState(draft: SessionSnapshot, msg: SignedState): Promise<SignedState> {
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

    // (i) the opening state is always self-evidently the channel's start.
    if (canonical.turnNum === 0n) return { state: canonical, sigA, sigB };

    // (ii) any state with both signatures valid is supported regardless of how far ahead it is.
    const bothSigned =
      sigA !== NO_SIG &&
      sigB !== NO_SIG &&
      (await this.signedBy(0, canonical, sigA)) &&
      (await this.signedBy(1, canonical, sigB));
    if (bothSigned) return { state: canonical, sigA, sigB };

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
        const checkpointOk =
          !isCheckpoint(expected) ||
          ((await this.signedBy(0, expected, sigA)) && (await this.signedBy(1, expected, sigB)));
        if (moverOk && checkpointOk) return { state: expected, sigA, sigB };
      }
    }

    throw unverifiable();
  }
}
