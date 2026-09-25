import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { EMPTY_SIGNED, channelId, unsigned } from "./abiCodec.js";
import { initialState, isCheckpoint, isGameOver, legalMoves, mover, parseMove, successor } from "./chess.js";
import { KIND } from "./constants.js";
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

/**
 * One player's view of one channel. Validates every incoming state exactly as the hub would, signs only through
 * an equivocation guard, and persists before any signature is returned (spec §7, §12).
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
    });
    await session.persist();
    return session;
  }

  static restore(cfg: SessionConfig, snapshot: SessionSnapshot): ChannelSession {
    return new ChannelSession(cfg, structuredClone(snapshot));
  }

  get latest(): SignedState {
    return this.data.latest;
  }

  get isClosing(): boolean {
    return this.data.closeState !== null;
  }

  snapshot(): SessionSnapshot {
    return structuredClone(this.data);
  }

  isMyTurn(): boolean {
    const s = this.data.latest.state;
    return !this.isClosing && !isGameOver(s) && this.endorsed(this.data.latest) && mover(s) === this.me;
  }

  legalMoves(): string[] {
    return this.isMyTurn() ? legalMoves(this.data.latest.state) : [];
  }

  move(input: string, opts: { offerDraw?: boolean } = {}): Promise<SignedState> {
    if (!this.isMyTurn()) return Promise.reject(new ArenaProtocolError("not your turn"));
    const kind = opts.offerDraw ? KIND.NORMAL_OFFER_DRAW : KIND.NORMAL;
    let encoded: number;
    try {
      encoded = parseMove(this.data.latest.state, input, kind);
    } catch (err) {
      return Promise.reject(new ArenaProtocolError((err as Error).message));
    }
    return this.act(encoded);
  }

  resign(): Promise<SignedState> {
    return this.act(encodeMove(0, 0, 0, KIND.RESIGN));
  }

  acceptDraw(): Promise<SignedState> {
    return this.act(encodeMove(0, 0, 0, KIND.ACCEPT_DRAW));
  }

  claimStalemate(): Promise<SignedState> {
    return this.act(encodeMove(0, 0, 0, KIND.CLAIM_STALEMATE));
  }

  async proposeNewGame(): Promise<SignedState> {
    this.assertNotClosing();
    if (this.data.pendingCheckpoint) return this.data.pendingCheckpoint;
    if (this.data.incomingCheckpoint) return this.countersignNewGame();
    if (!isGameOver(this.data.latest.state)) throw new ArenaProtocolError("the game is still in progress");
    const signed = await this.signAsMe(this.next(encodeMove(0, 0, 0, KIND.NEW_GAME)));
    this.data.pendingCheckpoint = signed;
    await this.persist();
    return signed;
  }

  async countersignNewGame(): Promise<SignedState> {
    const incoming = this.data.incomingCheckpoint;
    if (!incoming) throw new ArenaProtocolError("no new-game proposal to countersign");
    const signed = await this.signAsMe(incoming.state, incoming);
    this.advance(signed);
    this.data.incomingCheckpoint = null;
    await this.persist();
    return signed;
  }

  /** Validates and records an opponent message (a move, or a NEW_GAME proposal/countersignature). */
  async receive(msg: SignedState): Promise<"move" | "checkpoint-proposed" | "checkpoint-complete"> {
    this.assertNotClosing();
    const s = msg.state;
    const latest = this.data.latest.state;
    if (s.channelId !== this.id) throw new ArenaProtocolError("wrong channel");
    if (s.turnNum !== latest.turnNum + 1n) {
      throw new ArenaProtocolError(`unexpected turn ${s.turnNum}; expected ${latest.turnNum + 1n}`);
    }
    const expected = this.next(s.move);
    if (hashState(expected, this.domain) !== hashState(s, this.domain)) {
      throw new ArenaProtocolError("state does not match the rules");
    }
    const oppSig = this.opponent === 0 ? msg.sigA : msg.sigB;
    if (!(await this.signedBy(this.opponent, s, oppSig))) {
      throw new ArenaProtocolError("missing or invalid opponent signature");
    }

    if (isCheckpoint(s)) {
      const pending = this.data.pendingCheckpoint;
      if (pending && hashState(pending.state, this.domain) === hashState(s, this.domain)) {
        this.advance({
          state: s,
          sigA: pending.sigA !== NO_SIG ? pending.sigA : msg.sigA,
          sigB: pending.sigB !== NO_SIG ? pending.sigB : msg.sigB,
        });
        this.data.pendingCheckpoint = null;
        await this.persist();
        return "checkpoint-complete";
      }
      this.data.incomingCheckpoint = this.withOnly(this.opponent, s, oppSig);
      await this.persist();
      return "checkpoint-proposed";
    }

    if (!this.endorsed(this.data.latest)) throw new ArenaProtocolError("the new-game checkpoint is not fully signed");
    if (mover(latest) !== this.opponent) throw new ArenaProtocolError("it is not the opponent's turn");
    this.advance(this.withOnly(this.opponent, s, oppSig));
    await this.persist();
    return "move";
  }

  /** Signs Close for the latest state. Only between games; afterwards this session signs nothing else. */
  async signClose(): Promise<CloseSignature> {
    const current = this.data.latest;
    const s = current.state;
    if (this.data.closeState) {
      if (hashState(this.data.closeState.state, this.domain) !== hashState(s, this.domain)) {
        throw new ArenaProtocolError("already signed Close for another state");
      }
      return { stateHash: hashState(s, this.domain), by: this.me, sig: this.data.closeSigs[this.me] };
    }
    if (this.data.pendingCheckpoint) {
      throw new ArenaProtocolError("a new-game proposal is pending; close on the checkpoint once countersigned, or challenge");
    }
    const betweenGames = s.turnNum === 0n || (isCheckpoint(s) && this.endorsed(current)) || isGameOver(s);
    if (!betweenGames) throw new ArenaProtocolError("can only close between games");
    if (this.data.lastSignedTurn !== null && this.data.lastSignedTurn > s.turnNum) {
      throw new ArenaProtocolError("already signed a later state");
    }
    const sig = await signClose(this.key, s, this.domain);
    this.data.closeState = current;
    this.data.closeSigs[this.me] = sig;
    await this.persist();
    return { stateHash: hashState(s, this.domain), by: this.me, sig };
  }

  async receiveClose(cs: CloseSignature): Promise<void> {
    if (cs.by !== this.opponent) throw new ArenaProtocolError("close signature is not from the opponent");
    const target = (this.data.closeState ?? this.data.latest).state;
    if (cs.stateHash !== hashState(target, this.domain)) {
      throw new ArenaProtocolError("close signature is for a different state");
    }
    const signer = await recoverCloseSigner(target, cs.sig, this.domain);
    if (signer.toLowerCase() !== this.params.signers[this.opponent].toLowerCase()) {
      throw new ArenaProtocolError("invalid close signature");
    }
    this.data.closeSigs[this.opponent] = cs.sig;
    await this.persist();
  }

  /** The SignedState to pass to ChannelHub.closeCooperative once both Close signatures exist. */
  closeTransaction(): SignedState | null {
    const target = this.data.closeState;
    const [sigA, sigB] = this.data.closeSigs;
    if (!target || sigA === NO_SIG || sigB === NO_SIG) return null;
    return { state: target.state, sigA, sigB };
  }

  /** Proof that the latest state is supported (spec §4.3), for challenge() or respond(). */
  challengeProof(): Proof {
    const latest = this.data.latest;
    const fullySigned = latest.sigA !== NO_SIG && latest.sigB !== NO_SIG;
    if (latest.state.turnNum === 0n || fullySigned) return { hasPrev: false, prev: EMPTY_SIGNED, latest };
    if (!this.data.prev) throw new ArenaProtocolError("no endorsed predecessor for the latest state");
    return { hasPrev: true, prev: this.data.prev, latest };
  }

  /** Adopts a newer state registered on-chain (Challenged/Responded event). Returns false if not newer. */
  async ingestOnChain(signed: SignedState): Promise<boolean> {
    if (signed.state.channelId !== this.id) throw new ArenaProtocolError("wrong channel");
    if (signed.state.turnNum <= this.data.latest.state.turnNum) return false;
    const chains = hashState(this.data.latest.state, this.domain) === signed.state.prevHash;
    this.data.prev = chains ? this.data.latest : null;
    this.data.latest = signed;
    this.data.pendingCheckpoint = null;
    this.data.incomingCheckpoint = null;
    await this.persist();
    return true;
  }

  private async act(move: number): Promise<SignedState> {
    if (!this.isMyTurn()) throw new ArenaProtocolError("not your turn");
    const signed = await this.signAsMe(this.next(move));
    this.advance(signed);
    await this.persist();
    return signed;
  }

  /** Canonical successor of the latest state with prevHash set. Throws if the move is illegal. */
  private next(move: number): State {
    const r = successor(this.data.latest.state, move, this.params);
    if (!r.ok) throw new ArenaProtocolError(`illegal: ${r.reason}`);
    return { ...r.next, prevHash: hashState(this.data.latest.state, this.domain) };
  }

  private async signAsMe(state: State, base?: SignedState): Promise<SignedState> {
    this.assertNotClosing();
    const last = this.data.lastSignedTurn;
    if (last !== null && state.turnNum <= last) {
      throw new ArenaProtocolError(`refusing to sign turn ${state.turnNum}: already signed turn ${last}`);
    }
    const sig = await signState(this.key, state, this.domain);
    this.data.lastSignedTurn = state.turnNum;
    const out: SignedState = base ? { ...base, state } : unsigned(state);
    if (this.me === 0) out.sigA = sig;
    else out.sigB = sig;
    return out;
  }

  private advance(next: SignedState): void {
    this.data.prev = this.data.latest;
    this.data.latest = next;
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

  private assertNotClosing(): void {
    if (this.isClosing) throw new ArenaProtocolError("channel is closing; no further states are signed or accepted");
  }

  private async persist(): Promise<void> {
    await this.store.save(this.data);
  }
}
