/**
 * Model-based property tests for ChannelSession (Plan 4.5 Task 6).
 *
 * Two honest ChannelSessions (MemoryStore) exchange messages over a simulated network that drops, duplicates,
 * reorders and delays them, while a random honest policy drives each side through the public API only (moves with
 * and without draw offers, resign, accept draw, claim stalemate, new-game proposal/countersignature, Close,
 * crash + restore from the same store, reconnect re-sends as the daemon does them, and on-chain challenges that
 * the other side ingests). After every step an oracle checks the safety properties of spec §4.3/§12; a second
 * property checks that the pair converges once the network stops dropping messages.
 *
 * Action descriptors are state-independent (indices are resolved modulo whatever is available when the action
 * runs), keys and params are constant, and viem signs with RFC 6979, so every run replays exactly from its seed
 * and fast-check can shrink a failing action list.
 *
 * `MODEL_RUNS` overrides the run count (default 200) and `MODEL_SEED` the seed.
 */
import { afterAll, describe, expect, it } from "vitest";
import fc from "fast-check";
import type { Address, Hex } from "viem";
import { keccak256, toHex } from "viem";
import {
  ArenaProtocolError,
  ChannelSession,
  MemoryStore,
  STATUS,
  channelId,
  hashState,
  initialState,
  isCheckpoint,
  isGameOver,
  legalMoves,
  mover,
  recoverCloseSigner,
  recoverStateSigner,
  statusOf,
  successor,
  type ArenaDomain,
  type CloseSignature,
  type CloseTransaction,
  type Params,
  type PlayerIndex,
  type Proof,
  type SessionConfig,
  type SessionSnapshot,
  type SignedState,
  type State,
} from "../src/index.js";
import { makeParams } from "./helpers/fixtures.js";

const NUM_RUNS = Number(process.env.MODEL_RUNS ?? 200);
const SEED = Number(process.env.MODEL_SEED ?? 0x5eed4a6);
/** Generous per-test timeout so `MODEL_RUNS=5000` is not cut short; the default 200 runs stay well under 60 s. */
const TIMEOUT = Math.max(60_000, NUM_RUNS * 1_000);

const domain: ArenaDomain = { chainId: 31337, hub: "0x000000000000000000000000000000000000beef" };
const KEYS = [keccak256(toHex("arena-model-key-a")), keccak256(toHex("arena-model-key-b"))] as const;
const NO_SIG: Hex = "0x";

function paramsFor(deposit: bigint): Params {
  return makeParams({
    participants: ["0x00000000000000000000000000000000000000a1", "0x00000000000000000000000000000000000000b2"],
    sessionKeys: KEYS,
    rules: "0x00000000000000000000000000000000000000e5" as Address,
    feeRecipient: "0x00000000000000000000000000000000000000f6" as Address,
    fundingDeadline: 2_000_000_000n,
    deposit,
  });
}

// ------------------------------------------------------------------------------------------------ actions

/** 2 = "whichever player is on move" (a no-op if neither is), so turn-bound actions are not mostly wasted. */
type Actor = 0 | 1 | 2;
type Action =
  | { t: "move"; who: Actor; pick: number; offerDraw: boolean }
  | { t: "resign"; who: Actor }
  | { t: "acceptDraw"; who: Actor }
  | { t: "claimStalemate"; who: Actor }
  | { t: "propose"; who: PlayerIndex }
  | { t: "countersign"; who: PlayerIndex }
  | { t: "signClose"; who: PlayerIndex }
  | { t: "deliver"; pick: number }
  | { t: "drop"; pick: number }
  | { t: "duplicate"; pick: number }
  | { t: "crash"; who: PlayerIndex }
  | { t: "resend"; who: PlayerIndex }
  | { t: "challenge"; who: PlayerIndex };

const player = fc.constantFrom<PlayerIndex>(0, 1);
const actor = fc.constantFrom<Actor>(0, 1, 2, 2, 2, 2, 2, 2);
const pick = fc.nat({ max: 1_000 });

const actionArb: fc.Arbitrary<Action> = fc.oneof(
  {
    weight: 25,
    arbitrary: fc.record({
      t: fc.constant("move" as const),
      who: actor,
      pick,
      offerDraw: fc.integer({ min: 0, max: 4 }).map((n) => n === 0), // 20%
    }),
  },
  { weight: 6, arbitrary: fc.record({ t: fc.constant("resign" as const), who: actor }) },
  { weight: 6, arbitrary: fc.record({ t: fc.constant("acceptDraw" as const), who: actor }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant("claimStalemate" as const), who: actor }) },
  { weight: 8, arbitrary: fc.record({ t: fc.constant("propose" as const), who: player }) },
  { weight: 6, arbitrary: fc.record({ t: fc.constant("countersign" as const), who: player }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant("signClose" as const), who: player }) },
  { weight: 35, arbitrary: fc.record({ t: fc.constant("deliver" as const), pick }) },
  { weight: 3, arbitrary: fc.record({ t: fc.constant("drop" as const), pick }) },
  { weight: 3, arbitrary: fc.record({ t: fc.constant("duplicate" as const), pick }) },
  { weight: 3, arbitrary: fc.record({ t: fc.constant("crash" as const), who: player }) },
  { weight: 4, arbitrary: fc.record({ t: fc.constant("resend" as const), who: player }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant("challenge" as const), who: player }) },
);

/** deposit == stake (a single loss blocks the next game), a few games, or many games. */
const depositArb = fc.constantFrom(100_000n, 300_000n, 1_000_000n);

// ------------------------------------------------------------------------------------------------ stats

const stats = {
  runs: 0,
  steps: 0,
  signatures: 0,
  closeSignatures: 0,
  closeTxPairs: 0,
  maxGameIndex: 0,
  newGamesCompleted: 0,
  crashes: 0,
  ingestAccepted: 0,
  r4Adoptions: 0,
  livenessRounds: [0, 0, 0, 0] as number[],
  results: new Map<string, number>(),
  errors: new Map<string, number>(),
};
function bump(m: Map<string, number>, k: string): void {
  m.set(k, (m.get(k) ?? 0) + 1);
}

/**
 * Errors two honest sessions must never produce against each other: an equivocation attempt stopped by the
 * guard, a conflicting state at an already-held turn, or a Close refused because something later was signed.
 */
const FORBIDDEN = [/conflicting state for turn/, /refusing to sign turn/, /already signed a later state/];

// ------------------------------------------------------------------------------------------------ oracle

class Violation extends Error {
  constructor(message: string) {
    super(`INVARIANT: ${message}`);
    this.name = "Violation";
  }
}

const bigintJson = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? `${x}n` : x));

function sameState(a: State, b: State): boolean {
  return (
    a.channelId === b.channelId &&
    a.turnNum === b.turnNum &&
    a.prevHash === b.prevHash &&
    a.balanceA === b.balanceA &&
    a.balanceB === b.balanceB &&
    a.gameIndex === b.gameIndex &&
    a.move === b.move &&
    a.board === b.board &&
    a.meta === b.meta
  );
}

/**
 * Global view of every signature any session of this run ever produced, collected from every snapshot either
 * session persisted (persist-before-return means every signature, including R4's co-signature made inside
 * `receive`, lands in its signer's store before it can leave the session).
 */
class Oracle {
  readonly id: Hex;
  private readonly openingHash: Hex;
  /** state signature -> the state it signs (a signature is never re-paired with another state). */
  private readonly bySig = new Map<Hex, State>();
  /** `${signer}:${channelId}:${turnNum}` -> the one state hash that signer signed for that turn. */
  private readonly byTurn = new Map<string, Hex>();
  private readonly recovered = new Map<string, string>();
  private readonly closeSeen = new Set<string>();
  /** A player's own Close signature has been persisted: no new state signature by it may appear afterwards. */
  private readonly frozen: [boolean, boolean] = [false, false];
  private readonly cursor: [number, number] = [0, 0];
  private readonly maxTurn: [bigint, bigint] = [0n, 0n];
  private readonly proofChecked: [string, string] = ["", ""];

  constructor(readonly params: Params) {
    this.id = channelId(domain.chainId, domain.hub, params);
    this.openingHash = hashState(initialState(this.id, params), domain);
  }

  private async stateSigner(s: State, h: Hex, sig: Hex): Promise<string> {
    const key = `${h}:${sig}`;
    let who = this.recovered.get(key);
    if (who === undefined) {
      try {
        who = (await recoverStateSigner(s, sig, domain)).toLowerCase();
      } catch {
        who = "bad";
      }
      this.recovered.set(key, who);
    }
    return who;
  }

  private signedBy(p: PlayerIndex, s: State, h: Hex, sig: Hex): Promise<boolean> {
    if (sig === NO_SIG) return Promise.resolve(false);
    return this.stateSigner(s, h, sig).then((w) => w === this.params.signers[p].toLowerCase());
  }

  /** Records every signature on `ss`; checks slot/signer match, equivocation, conservation and post-Close freeze. */
  private async logSigned(ss: SignedState | null, where: string): Promise<void> {
    if (!ss) return;
    for (const slot of [0, 1] as const) {
      const sig = slot === 0 ? ss.sigA : ss.sigB;
      if (sig === NO_SIG) continue;
      const known = this.bySig.get(sig);
      if (known) {
        if (!sameState(known, ss.state)) throw new Violation(`${where}: a signature re-paired with another state`);
        continue;
      }
      const h = hashState(ss.state, domain);
      if (!(await this.signedBy(slot, ss.state, h, sig))) {
        throw new Violation(`${where}: sig${slot === 0 ? "A" : "B"} is not signers[${slot}]'s signature on its state`);
      }
      const key = `${slot}:${ss.state.channelId}:${ss.state.turnNum}`;
      const earlier = this.byTurn.get(key);
      if (earlier !== undefined && earlier !== h) {
        throw new Violation(`${where}: player ${slot} signed two different states for turn ${ss.state.turnNum}`);
      }
      if (ss.state.balanceA + ss.state.balanceB !== 2n * this.params.deposit) {
        throw new Violation(`${where}: signed state at turn ${ss.state.turnNum} breaks conservation`);
      }
      if (this.frozen[slot]) {
        throw new Violation(`${where}: player ${slot} signed turn ${ss.state.turnNum} after signing Close`);
      }
      this.byTurn.set(key, h);
      this.bySig.set(sig, structuredClone(ss.state));
      stats.signatures++;
      stats.maxGameIndex = Math.max(stats.maxGameIndex, ss.state.gameIndex);
    }
  }

  private async closeSignedBy(p: PlayerIndex, s: State, sig: Hex): Promise<boolean> {
    try {
      return (await recoverCloseSigner(s, sig, domain)).toLowerCase() === this.params.signers[p].toLowerCase();
    } catch {
      return false;
    }
  }

  /** Close signatures in a snapshot: only on terminal states, only by the right signer, for the recorded target. */
  private async checkCloseSigs(me: PlayerIndex, snap: SessionSnapshot, where: string): Promise<void> {
    for (const p of [0, 1] as const) {
      const sig = snap.closeSigs[p];
      if (sig === NO_SIG) continue;
      const key = `${p}:${sig}:${snap.closeSigTargets[p]}`;
      if (this.closeSeen.has(key)) continue;
      // Own signature: signed for closeState. Opponent's: verified against (closeState ?? latest) on receipt,
      // and cleared whenever latest moves, so the snapshot where it first appears still holds that target.
      const target = p === me ? snap.closeState : (snap.closeState ?? snap.latest);
      if (!target) throw new Violation(`${where}: own Close signature without closeState`);
      if (!isGameOver(target.state)) {
        throw new Violation(`${where}: player ${p}'s Close signature is for a non-terminal state`);
      }
      if (snap.closeSigTargets[p] !== hashState(target.state, domain)) {
        throw new Violation(`${where}: closeSigTargets[${p}] is not the hash of the state it was checked against`);
      }
      if (!(await this.closeSignedBy(p, target.state, sig))) {
        throw new Violation(`${where}: player ${p}'s Close signature does not verify`);
      }
      this.closeSeen.add(key);
      if (p === me) stats.closeSignatures++;
    }
    if (snap.closeSigs[me] !== NO_SIG) this.frozen[me] = true;
  }

  /** Mirrors ChannelHub._supported (ChannelHub.sol), minus the registered-state branch. Returns a reason or null. */
  async hubRejects(proof: Proof): Promise<string | null> {
    const s = proof.latest.state;
    const p = this.params;
    if (s.channelId !== this.id) return "wrong channel";
    if (s.balanceA + s.balanceB !== 2n * p.deposit) return "BalanceMismatch";
    const h = hashState(s, domain);
    if (!proof.hasPrev) {
      if (s.turnNum === 0n && h === this.openingHash) return null;
      if (
        (await this.signedBy(0, s, h, proof.latest.sigA)) &&
        (await this.signedBy(1, s, h, proof.latest.sigB))
      ) {
        return null;
      }
      return "Unsupported (no prev)";
    }
    const prev = proof.prev.state;
    if (prev.channelId !== this.id || isCheckpoint(s)) return "Unsupported (checkpoint latest with prev)";
    const ph = hashState(prev, domain);
    if (s.prevHash !== ph || s.turnNum !== prev.turnNum + 1n) return "Unsupported (does not chain)";
    const m = mover(prev);
    if (!(await this.signedBy(m, s, h, m === 0 ? proof.latest.sigA : proof.latest.sigB))) return "BadSignature";
    const t = successor(prev, s.move, p);
    if (!t.ok || hashState({ ...t.next, prevHash: s.prevHash }, domain) !== h) return "InvalidTransition";
    const other = (1 - m) as PlayerIndex;
    const prevEndorsed =
      (prev.turnNum === 0n && ph === this.openingHash) ||
      ((await this.signedBy(0, prev, ph, proof.prev.sigA)) && (await this.signedBy(1, prev, ph, proof.prev.sigB))) ||
      (!isCheckpoint(prev) && (await this.signedBy(other, prev, ph, other === 0 ? proof.prev.sigA : proof.prev.sigB)));
    return prevEndorsed ? null : "Unsupported (prev not endorsed)";
  }

  /** Runs every safety check against the current pair of sessions and their stores. */
  async check(w: World, where: string): Promise<void> {
    for (const p of [0, 1] as const) {
      const snaps = w.stores[p].snapshots;
      for (let i = this.cursor[p]; i < snaps.length; i++) {
        const snap = snaps[i];
        const at = `${where} [store ${p}#${i}]`;
        for (const ss of [snap.latest, snap.prev, snap.pendingCheckpoint, snap.incomingCheckpoint, snap.closeState]) {
          await this.logSigned(ss, at);
        }
        await this.checkCloseSigs(p, snap, at);
      }
      this.cursor[p] = snaps.length;
    }
    const cts: (CloseTransaction | null)[] = [];
    for (const p of [0, 1] as const) {
      const s = w.s[p];
      const latest = s.latest;
      if (latest.state.turnNum < this.maxTurn[p]) {
        throw new Violation(`${where}: player ${p}'s latest.turnNum went back to ${latest.state.turnNum}`);
      }
      this.maxTurn[p] = latest.state.turnNum;

      // Re-check the proof whenever latest or prev changes (prev changes alone on checkpoint-repaired).
      const prev = s.snapshot().prev;
      const fp = `${latest.state.turnNum}:${latest.sigA}:${latest.sigB}:${prev?.sigA}:${prev?.sigB}`;
      if (fp !== this.proofChecked[p]) {
        let proof: Proof;
        try {
          proof = s.challengeProof();
        } catch (err) {
          throw new Violation(`${where}: player ${p}'s challengeProof() threw: ${(err as Error).message}`);
        }
        const why = await this.hubRejects(proof);
        if (why) throw new Violation(`${where}: player ${p}'s challengeProof() would be rejected: ${why}`);
        this.proofChecked[p] = fp;
      }

      const ct = s.closeTransaction();
      const snap = s.snapshot();
      if (snap.closeSigs[0] !== NO_SIG && snap.closeSigs[1] !== NO_SIG && ct === null) {
        throw new Violation(`${where}: player ${p} holds both Close signatures but closeTransaction() is null`);
      }
      if (ct) {
        if (!isGameOver(ct.state)) throw new Violation(`${where}: closeTransaction() on a non-terminal state`);
        if (!(await this.closeSignedBy(0, ct.state, ct.sigA)) || !(await this.closeSignedBy(1, ct.state, ct.sigB))) {
          throw new Violation(`${where}: player ${p}'s closeTransaction() carries an invalid Close signature`);
        }
      }
      cts.push(ct);
    }
    if (cts[0] && cts[1]) {
      if (bigintJson(cts[0]) !== bigintJson(cts[1])) {
        throw new Violation(`${where}: the two sides' closeTransaction() differ`);
      }
      stats.closeTxPairs++;
    }
  }
}

// ------------------------------------------------------------------------------------------------ world

type Msg =
  | { to: PlayerIndex; kind: "state"; signed: SignedState }
  | { to: PlayerIndex; kind: "close"; cs: CloseSignature };

class World {
  readonly stores: [MemoryStore, MemoryStore] = [new MemoryStore(), new MemoryStore()];
  readonly cfg: [SessionConfig & { store: MemoryStore }, SessionConfig & { store: MemoryStore }];
  s!: [ChannelSession, ChannelSession];
  net: Msg[] = [];

  constructor(readonly params: Params) {
    const cfg = (me: PlayerIndex) => ({ params, me, sessionKey: KEYS[me], domain, store: this.stores[me] });
    this.cfg = [cfg(0), cfg(1)];
  }

  async init(): Promise<void> {
    this.s = [await ChannelSession.open(this.cfg[0]), await ChannelSession.open(this.cfg[1])];
  }

  /** Resolves an actor; null when it is "whoever is on move" and neither side is (waiting on the network). */
  private actor(who: Actor): PlayerIndex | null {
    if (who !== 2) return who;
    return this.s[0].isMyTurn() ? 0 : this.s[1].isMyTurn() ? 1 : null;
  }

  /** Runs an honest public-API call; an ArenaProtocolError is an expected refusal, anything else fails the run. */
  private async attempt<T>(label: string, fn: () => Promise<T> | T): Promise<T | undefined> {
    try {
      return await fn();
    } catch (err) {
      if (!(err instanceof ArenaProtocolError)) throw err;
      const msg = err.message;
      if (FORBIDDEN.some((re) => re.test(msg))) throw new Violation(`${label}: honest run hit "${msg}"`);
      bump(stats.errors, `${label}: ${msg.replace(/\d+/g, "N")}`);
      return undefined;
    }
  }

  private sendState(from: PlayerIndex, signed: SignedState | undefined): void {
    if (signed) this.net.push({ to: (1 - from) as PlayerIndex, kind: "state", signed: structuredClone(signed) });
  }

  private sendClose(from: PlayerIndex, cs: CloseSignature | undefined): void {
    if (cs) this.net.push({ to: (1 - from) as PlayerIndex, kind: "close", cs: structuredClone(cs) });
  }

  async deliver(m: Msg): Promise<void> {
    const s = this.s[m.to];
    if (m.kind === "close") {
      await this.attempt(`receiveClose@${m.to}`, () => s.receiveClose(m.cs));
      return;
    }
    const hadPending = s.snapshot().pendingCheckpoint !== null;
    const r = await this.attempt(`receive@${m.to}`, () => s.receive(m.signed));
    if (r) {
      bump(stats.results, r);
      if (r === "checkpoint-complete") stats.newGamesCompleted++;
      if (r === "move" && hadPending && s.snapshot().pendingCheckpoint === null) stats.r4Adoptions++;
    }
  }

  /** Daemon `onJoined` (§7 reconnect): latest own-signed state, pending own proposal, own Close signature. */
  resend(p: PlayerIndex): void {
    const snap = this.s[p].snapshot();
    const mine = p === 0 ? snap.latest.sigA : snap.latest.sigB;
    if (snap.latest.state.turnNum > 0n && mine !== NO_SIG) this.sendState(p, snap.latest);
    if (snap.pendingCheckpoint) this.sendState(p, snap.pendingCheckpoint);
    const sig = snap.closeSigs[p];
    if (sig !== NO_SIG) {
      const target = snap.closeSigTargets[p];
      this.sendClose(p, { stateHash: target, by: p, sig });
    }
  }

  async step(a: Action, oracle: Oracle): Promise<void> {
    stats.steps++;
    switch (a.t) {
      case "move": {
        const p = this.actor(a.who);
        if (p === null) return;
        const s = this.s[p];
        // Off-turn, fall back to the position's legal moves so the "not your turn" guard is exercised too.
        const moves = s.isMyTurn() ? s.legalMoves() : legalMoves(s.latest.state);
        if (moves.length === 0) return;
        const mv = moves[a.pick % moves.length];
        this.sendState(p, await this.attempt(`move@${p}`, () => s.move(mv, { offerDraw: a.offerDraw })));
        return;
      }
      case "resign": {
        const p = this.actor(a.who);
        if (p === null) return;
        this.sendState(p, await this.attempt(`resign@${p}`, () => this.s[p].resign()));
        return;
      }
      case "acceptDraw": {
        const p = this.actor(a.who);
        if (p === null) return;
        if (statusOf(this.s[p].latest.state) !== STATUS.DRAW_OFFERED) return; // honest: only when offered
        this.sendState(p, await this.attempt(`acceptDraw@${p}`, () => this.s[p].acceptDraw()));
        return;
      }
      case "claimStalemate": {
        const p = this.actor(a.who);
        if (p === null) return;
        this.sendState(p, await this.attempt(`claimStalemate@${p}`, () => this.s[p].claimStalemate()));
        return;
      }
      case "propose":
        this.sendState(a.who, await this.attempt(`propose@${a.who}`, () => this.s[a.who].proposeNewGame()));
        return;
      case "countersign":
        this.sendState(a.who, await this.attempt(`countersign@${a.who}`, () => this.s[a.who].countersignNewGame()));
        return;
      case "signClose":
        this.sendClose(a.who, await this.attempt(`signClose@${a.who}`, () => this.s[a.who].signClose()));
        return;
      case "deliver": {
        if (this.net.length === 0) return;
        const [m] = this.net.splice(a.pick % this.net.length, 1);
        await this.deliver(m);
        return;
      }
      case "drop":
        if (this.net.length > 0) this.net.splice(a.pick % this.net.length, 1);
        return;
      case "duplicate":
        if (this.net.length > 0) this.net.push(structuredClone(this.net[a.pick % this.net.length]));
        return;
      case "crash":
        // The daemon restores exactly like this: a fresh instance over the same store.
        this.s[a.who] = await ChannelSession.open(this.cfg[a.who]);
        stats.crashes++;
        return;
      case "resend":
        this.resend(a.who);
        return;
      case "challenge": {
        // `who` registers its challengeProof() on-chain (the hub must accept it); the other side's watchtower
        // ingests the registered state.
        const proof = await this.attempt(`challengeProof@${a.who}`, () => this.s[a.who].challengeProof());
        if (!proof) return;
        const why = await oracle.hubRejects(proof);
        if (why) throw new Violation(`challenge@${a.who}: hub would reject the proof: ${why}`);
        const other = (1 - a.who) as PlayerIndex;
        const ok = await this.attempt(`ingestOnChain@${other}`, () => this.s[other].ingestOnChain(proof.latest));
        if (ok) stats.ingestAccepted++;
        return;
      }
    }
  }
}

async function runSafety(deposit: bigint, actions: Action[]): Promise<{ w: World; oracle: Oracle }> {
  const params = paramsFor(deposit);
  const w = new World(params);
  const oracle = new Oracle(params);
  await w.init();
  await oracle.check(w, "init");
  for (let i = 0; i < actions.length; i++) {
    await w.step(actions[i], oracle);
    await oracle.check(w, `step ${i} ${actions[i].t}`);
  }
  return { w, oracle };
}

const LIVENESS_ROUNDS = 3;

// ------------------------------------------------------------------------------------------------ tests

describe("ChannelSession model (fast-check)", () => {
  afterAll(() => {
    const top = (m: Map<string, number>) =>
      [...m.entries()]
        .sort((x, y) => y[1] - x[1])
        .map(([k, v]) => `    ${v}\t${k}`)
        .join("\n");
    const { results, errors, ...rest } = stats;
    console.log(
      `model stats (runs=${NUM_RUNS}, seed=${SEED}):\n  ${JSON.stringify(rest)}\n  receive results:\n${top(results)}\n  refusals:\n${top(errors)}`,
    );
  });

  it(
    "safety: no equivocation, conservation, Close only on terminal states and freezes signing, monotone turns, " +
      "hub-valid proofs, matching close transactions",
    async () => {
      await fc.assert(
        fc.asyncProperty(depositArb, fc.array(actionArb, { maxLength: 150, size: "max" }), async (deposit, actions) => {
          stats.runs++;
          await runSafety(deposit, actions);
        }),
        { numRuns: NUM_RUNS, seed: SEED },
      );
    },
    TIMEOUT,
  );

  /**
   * Shrunk counterexamples the model produced against deliberately broken copies of session.ts (Close on a
   * non-terminal state, a proof without its predecessor, R4 without the co-signature, no freeze after Close).
   * The real session must pass each of them; they pin the scenarios that prove the oracle can see those bugs.
   */
  it.each<[string, bigint, Action[]]>([
    ["Close at the opening", 100_000n, [{ t: "signClose", who: 0 }]],
    ["proof for a lone first move", 100_000n, [{ t: "move", who: 0, pick: 0, offerDraw: true }]],
    [
      "simultaneous proposals, then a move-1 resignation on the merged checkpoint",
      1_000_000n,
      [
        { t: "resign", who: 0 },
        { t: "deliver", pick: 0 },
        { t: "propose", who: 0 },
        { t: "propose", who: 1 },
        { t: "deliver", pick: 0 },
        { t: "resign", who: 2 },
        { t: "deliver", pick: 313 },
      ],
    ],
    [
      "R4: a move on an uncountersigned checkpoint whose countersignature is still in flight",
      300_000n,
      [
        { t: "resign", who: 0 },
        { t: "propose", who: 0 },
        { t: "deliver", pick: 0 },
        { t: "deliver", pick: 0 },
        { t: "countersign", who: 1 },
        { t: "move", who: 2, pick: 0, offerDraw: true },
        { t: "deliver", pick: 75 },
      ],
    ],
    [
      "propose after signing Close on a DRAW",
      100_000n,
      [
        { t: "move", who: 0, pick: 0, offerDraw: true },
        { t: "deliver", pick: 0 },
        { t: "acceptDraw", who: 2 },
        { t: "deliver", pick: 0 },
        { t: "signClose", who: 0 },
        { t: "propose", who: 0 },
      ],
    ],
  ])("pinned scenario: %s", async (_name, deposit, actions) => {
    await runSafety(deposit, actions);
  });

  it(
    "liveness: once the network stops dropping, both sides converge within a bounded number of re-send rounds",
    async () => {
      await fc.assert(
        fc.asyncProperty(depositArb, fc.array(actionArb, { maxLength: 100, size: "max" }), async (deposit, actions) => {
          stats.runs++;
          const { w, oracle } = await runSafety(deposit, actions);
          // From here on nothing is dropped: every round both daemons reconnect (re-send), and the relay delivers
          // everything in flight in the order it was sent.
          let converged = false;
          for (let round = 0; round < LIVENESS_ROUNDS && !converged; round++) {
            w.resend(0);
            w.resend(1);
            while (w.net.length > 0) {
              await w.deliver(w.net.shift()!);
              await oracle.check(w, `liveness round ${round}`);
            }
            converged = convergedPair(w);
            if (converged) stats.livenessRounds[round]++;
          }
          if (!converged) stats.livenessRounds[LIVENESS_ROUNDS]++;
          expect(describePair(w), "did not converge").toBe("converged");
        }),
        { numRuns: NUM_RUNS, seed: SEED + 1 },
      );
    },
    TIMEOUT,
  );
});

function h(ss: SignedState | null): Hex | null {
  return ss ? hashState(ss.state, domain) : null;
}

/**
 * Converged: the same `latest`; each side's own pending new-game proposal is held by the other as an incoming
 * proposal (the other side is then clearly the one to act: countersign) unless that side is closing; and when
 * both signed Close on the same state, both hold the same close transaction.
 */
function describePair(w: World): string {
  const [a, b] = [w.s[0].snapshot(), w.s[1].snapshot()];
  if (h(a.latest) !== h(b.latest)) {
    return `latest differs: A turn ${a.latest.state.turnNum}, B turn ${b.latest.state.turnNum}`;
  }
  for (const [me, other, name] of [
    [a, b, "A"],
    [b, a, "B"],
  ] as const) {
    if (me.pendingCheckpoint && other.closeState === null && h(other.incomingCheckpoint) !== h(me.pendingCheckpoint)) {
      return `${name}'s new-game proposal never reached the other side`;
    }
  }
  if (a.closeState && b.closeState && h(a.closeState) === h(b.closeState)) {
    const [ca, cb] = [w.s[0].closeTransaction(), w.s[1].closeTransaction()];
    if (!ca || !cb || bigintJson(ca) !== bigintJson(cb)) return "both signed Close but close transactions differ";
  }
  return "converged";
}

function convergedPair(w: World): boolean {
  return describePair(w) === "converged";
}
