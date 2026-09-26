import { describe, expect, it } from "vitest";
import type { Address, Hex } from "viem";
import { keccak256, toHex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  ArenaProtocolError,
  ChannelSession,
  KIND,
  MemoryStore,
  STATUS,
  encodeMove,
  hashState,
  isGameOver,
  parseMove,
  recoverCloseSigner,
  recoverStateSigner,
  signClose,
  signState,
  statusOf,
  successor,
  withStatus,
  type ArenaDomain,
  type CloseSignature,
  type SessionConfig,
  type SessionSnapshot,
  type SessionStore,
  type SignedState,
} from "../src/index.js";
import { SCHOLARS_MATE, makeParams } from "./helpers/fixtures.js";

const domain: ArenaDomain = { chainId: 31337, hub: "0x000000000000000000000000000000000000beef" };

async function setup(deposit?: bigint, storeA?: SessionStore) {
  const keys = [generatePrivateKey(), generatePrivateKey()] as const;
  const params = makeParams({
    participants: ["0x00000000000000000000000000000000000000a1", "0x00000000000000000000000000000000000000b2"],
    sessionKeys: keys,
    rules: "0x00000000000000000000000000000000000000e5" as Address,
    feeRecipient: "0x00000000000000000000000000000000000000f6" as Address,
    fundingDeadline: 2_000_000_000n,
    deposit,
  });
  const cfg = (me: 0 | 1): SessionConfig => ({
    params,
    me,
    sessionKey: keys[me],
    domain,
    store: me === 0 ? (storeA ?? new MemoryStore()) : new MemoryStore(),
  });
  const cfgA = cfg(0);
  const cfgB = cfg(1);
  const a = await ChannelSession.create(cfgA);
  const b = await ChannelSession.create(cfgB);
  return { a, b, cfgA, cfgB, keys, params };
}

/** A store whose `save` throws exactly while `.fail` is true, for exercising I2 persist-before-return. */
function flakyStore(): SessionStore & { fail: boolean; saved: SessionSnapshot[] } {
  const saved: SessionSnapshot[] = [];
  const flaky = {
    fail: false,
    saved,
    async save(s: SessionSnapshot) {
      if (flaky.fail) throw new Error("disk full");
      saved.push(structuredClone(s));
    },
  };
  return flaky;
}

async function play(a: ChannelSession, b: ChannelSession, moves: string[]) {
  for (const m of moves) {
    const [mover, other] = a.isMyTurn() ? [a, b] : [b, a];
    await other.receive(await mover.move(m));
  }
}

async function finishGame(a: ChannelSession, b: ChannelSession) {
  await play(a, b, SCHOLARS_MATE);
  const [loser, winner] = a.isMyTurn() ? [a, b] : [b, a];
  await winner.receive(await loser.resign());
}

async function newGame(a: ChannelSession, b: ChannelSession) {
  const proposal = await a.proposeNewGame();
  expect(await b.receive(proposal)).toBe("checkpoint-proposed");
  const full = await b.countersignNewGame();
  expect(await a.receive(full)).toBe("checkpoint-complete");
}

describe("ChannelSession", () => {
  it("alternates turns and rejects moving out of turn or illegally", async () => {
    const { a, b } = await setup();
    await expect(b.move("e7e5")).rejects.toThrow(/not your turn/);
    await expect(a.move("e2e5")).rejects.toThrow(ArenaProtocolError);
    expect(await b.receive(await a.move("e4"))).toBe("move");
    expect(b.isMyTurn()).toBe(true);
    expect(a.isMyTurn()).toBe(false);
    expect(b.legalMoves()).toHaveLength(20);
  });

  it("rejects messages with a wrong signature, a rule violation or a skipped turn", async () => {
    const { a, b, keys } = await setup();
    const msg = await a.move("e2e4");
    await expect(b.receive({ ...msg, sigA: await signState(keys[1], msg.state, domain) })).rejects.toThrow(/signature/);
    const cheat = { ...msg.state, board: msg.state.board ^ 1n };
    await expect(b.receive({ state: cheat, sigA: await signState(keys[0], cheat, domain), sigB: "0x" })).rejects.toThrow(
      /does not match the rules/,
    );
    const skipped = { ...msg.state, turnNum: 2n };
    await expect(b.receive({ state: skipped, sigA: await signState(keys[0], skipped, domain), sigB: "0x" })).rejects.toThrow(
      /unexpected turn/,
    );
    await expect(b.receive(msg)).resolves.toBe("move");
  });

  it("persists before returning a signature", async () => {
    const { a, cfgA } = await setup();
    const msg = await a.move("e2e4");
    const store = cfgA.store as MemoryStore;
    expect(store.last?.latest).toEqual(msg);
    expect(store.last?.lastSignedTurn).toBe(1n);
  });

  it("never signs twice for the same turn after restoring a stale snapshot", async () => {
    const { a, cfgA } = await setup();
    const stale = structuredClone((cfgA.store as MemoryStore).snapshots[0]);
    await a.move("e2e4");
    const restored = ChannelSession.restore(cfgA, { ...stale, lastSignedTurn: 1n });
    await expect(restored.move("d2d4")).rejects.toThrow(/refusing to sign turn 1/);
  });

  it("offers and accepts draws; resignation shifts the stake", async () => {
    const { a, b, params } = await setup();
    await b.receive(await a.move("e2e4", { offerDraw: true }));
    await a.receive(await b.acceptDraw());
    expect(statusOf(a.latest.state)).toBe(STATUS.DRAW);
    expect(isGameOver(b.latest.state)).toBe(true);

    const s = await setup();
    await s.b.receive(await s.a.move("e2e4"));
    await s.a.receive(await s.b.resign());
    expect([s.a.latest.state.balanceA, s.a.latest.state.balanceB]).toEqual([
      params.deposit + params.stakePerGame,
      params.deposit - params.stakePerGame,
    ]);
  });

  it("needs both signatures on a new game before its first move", async () => {
    const { a, b } = await setup();
    await finishGame(a, b);
    const proposal = await a.proposeNewGame();
    await b.receive(proposal);
    expect(b.isMyTurn()).toBe(false); // B is white in game 1 but the checkpoint is not countersigned yet
    await expect(b.move("e2e4")).rejects.toThrow(/not your turn/);
    // (R9 changed the A side of this test: a B-signed move on A's own pending checkpoint is now accepted, because
    // B's move endorses the checkpoint — see "R9: accepts the opponent's move on this player's pending
    // checkpoint". A move on a checkpoint A did NOT propose is still refused until it is countersigned.)
    const { a: a2, b: b2, keys: keys2, params: params2 } = await setup();
    await finishGame(a2, b2);
    await a2.receive(await b2.proposeNewGame()); // B proposes; A holds it without countersigning
    const inc = a2.snapshot().incomingCheckpoint!.state;
    const r = successor(inc, parseMove(inc, "e2e4"), params2);
    if (!r.ok) throw new Error(r.reason);
    const early = { ...r.next, prevHash: hashState(inc, domain) };
    await expect(a2.receive({ state: early, sigA: "0x", sigB: await signState(keys2[1], early, domain) })).rejects.toThrow(
      /unexpected turn/,
    );
    const full = await b.countersignNewGame();
    expect(await a.receive(full)).toBe("checkpoint-complete");
    expect(b.isMyTurn()).toBe(true);
    expect(await a.receive(await b.move("e2e4"))).toBe("move");
  });

  it("completes simultaneous new-game proposals without extra signatures", async () => {
    const { a, b } = await setup();
    await finishGame(a, b);
    const pa = await a.proposeNewGame();
    const pb = await b.proposeNewGame();
    expect(await a.receive(pb)).toBe("checkpoint-complete");
    expect(await b.receive(pa)).toBe("checkpoint-complete");
    expect(a.latest).toEqual(b.latest);
    expect(a.latest.sigA).not.toBe("0x");
    expect(a.latest.sigB).not.toBe("0x");
  });

  it("closes only between games, then freezes signing", async () => {
    const { a, b, params } = await setup();
    await b.receive(await a.move("e2e4"));
    await expect(a.signClose()).rejects.toThrow(/can only close on a finished game/);
    await a.receive(await b.resign());
    const ca = await a.signClose();
    await expect(a.proposeNewGame()).rejects.toThrow(/closing/);
    await expect(b.receiveClose({ ...ca, stateHash: `0x${"00".repeat(32)}` as Hex })).rejects.toThrow(/different state/);
    await b.receiveClose(ca);
    expect(b.closeTransaction()).toBeNull();
    const cb = await b.signClose();
    await a.receiveClose(cb);
    const tx = a.closeTransaction();
    expect(tx).not.toBeNull();
    expect(tx).toEqual(b.closeTransaction());
    expect(await recoverCloseSigner(tx!.state, tx!.sigA, domain)).toBe(params.signers[0]);
    expect(await recoverCloseSigner(tx!.state, tx!.sigB, domain)).toBe(params.signers[1]);
    await expect(a.receive(a.latest)).rejects.toThrow(/closing/);
  });

  it("refuses to close while its own new-game proposal is outstanding", async () => {
    const { a, b } = await setup();
    await finishGame(a, b);
    await a.proposeNewGame();
    await expect(a.signClose()).rejects.toThrow(/pending/);
  });

  it("builds challenge proofs the hub accepts", async () => {
    const { a, b } = await setup();
    expect(a.challengeProof().hasPrev).toBe(false); // opening state
    const e4 = await a.move("e2e4");
    let proof = a.challengeProof();
    expect(proof.hasPrev).toBe(true);
    expect(proof.prev.state.turnNum).toBe(0n);
    expect(proof.latest).toEqual(e4);
    await b.receive(e4);
    const e5 = await b.move("e7e5");
    await a.receive(e5);
    proof = a.challengeProof();
    expect(proof.prev).toEqual(e4); // prev carries A's signature
    expect(proof.latest).toEqual(e5); // latest carries B's signature
    await b.receive(await a.resign());
    await newGame(a, b);
    proof = b.challengeProof();
    expect(proof.hasPrev).toBe(false); // fully signed checkpoint
  });

  it("ingests an on-chain state and continues from it", async () => {
    const { a, b } = await setup();
    await b.receive(await a.move("e2e4"));
    const e5 = await b.move("e7e5"); // never delivered off-chain
    expect(await a.ingestOnChain(e5)).toBe(true);
    expect(a.isMyTurn()).toBe(true);
    expect(await a.ingestOnChain(e5)).toBe(false);
    expect(await b.receive(await a.move("g1f3"))).toBe("move");
    expect(a.challengeProof().prev).toEqual(e5);
  });

  it("rejects moves for another channel and kind NONE", async () => {
    const { a, b } = await setup();
    const other = await setup();
    await expect(b.receive(await other.a.move("e2e4"))).rejects.toThrow(/wrong channel/);
    await expect(a.receive({ ...a.latest })).rejects.toThrow();
    expect(encodeMove(0, 0, 0, KIND.NONE)).toBe(0);
  });

  // --- Fix round 1 -----------------------------------------------------------------------------------------

  it("I1: serializes concurrent move() calls; exactly one signs turn 1", async () => {
    const { a } = await setup();
    const [r1, r2] = await Promise.allSettled([a.move("e2e4"), a.move("d2d4")]);
    const fulfilled = [r1, r2].filter((r) => r.status === "fulfilled");
    const rejected = [r1, r2].filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(ArenaProtocolError);
    // Only one turn-1 signature ever exists, and challengeProof() is still well-formed.
    const proof = a.challengeProof();
    expect(proof.latest.state.turnNum).toBe(1n);
    expect(proof.hasPrev).toBe(true);
    expect(proof.prev.state.turnNum).toBe(0n);
  });

  it("I1: racing signClose() against proposeNewGame() releases at most one kind of signature", async () => {
    const { a, b } = await setup();
    await finishGame(a, b);
    const [closeRes, proposeRes] = await Promise.allSettled([a.signClose(), a.proposeNewGame()]);
    const closed = closeRes.status === "fulfilled";
    const proposed = proposeRes.status === "fulfilled";
    // Never both: the loser of the race sees the winner's guard (closing, or a pending proposal) and rejects.
    expect(closed && proposed).toBe(false);
    expect(closed || proposed).toBe(true);
  });

  it("I2: a failed persist leaves move() unsigned and unretained; retry signs and persists", async () => {
    const store = flakyStore();
    const { a } = await setup(undefined, store);
    store.fail = true;
    await expect(a.move("e2e4")).rejects.toThrow("disk full");
    expect(a.latest.state.turnNum).toBe(0n);
    expect(a.snapshot().lastSignedTurn).toBeNull();
    expect(a.challengeProof().hasPrev).toBe(false);
    store.fail = false;
    const signed = await a.move("e2e4");
    expect(a.latest).toEqual(signed);
    expect(store.saved.at(-1)?.latest).toEqual(signed);
    expect(store.saved.at(-1)?.lastSignedTurn).toBe(1n);
  });

  it("I2: signClose retries cleanly after a failed persist", async () => {
    const store = flakyStore();
    const { a, b } = await setup(undefined, store);
    await finishGame(a, b); // a wins; a.latest is terminal
    store.fail = true;
    await expect(a.signClose()).rejects.toThrow("disk full");
    expect(a.isClosing).toBe(false);
    expect(store.saved.at(-1)?.closeState ?? null).toBeNull();
    store.fail = false;
    const cs = await a.signClose();
    expect(a.isClosing).toBe(true);
    expect(store.saved.at(-1)?.closeState).not.toBeNull();
    expect(store.saved.at(-1)?.closeSigs[0]).toBe(cs.sig);
  });

  it("I2: proposeNewGame retries cleanly after a failed persist", async () => {
    const store = flakyStore();
    const { a, b } = await setup(undefined, store);
    await finishGame(a, b);
    store.fail = true;
    await expect(a.proposeNewGame()).rejects.toThrow("disk full");
    expect(a.snapshot().pendingCheckpoint).toBeNull();
    store.fail = false;
    const proposal = await a.proposeNewGame();
    expect(a.snapshot().pendingCheckpoint).toEqual(proposal);
    expect(store.saved.at(-1)?.pendingCheckpoint).toEqual(proposal);
  });

  it("I3: never wedges on a state with non-canonical (number) field types", async () => {
    const { a, b } = await setup();
    const msg = await a.move("e2e4");

    // meta as a JS number hashes identically to the bigint value, so it is accepted -- but must be stored as the
    // locally computed canonical (bigint) state, never the received object, so the session keeps working.
    const evilMeta = { ...msg, state: { ...msg.state, meta: Number(msg.state.meta) as unknown as bigint } };
    const outcome = await b.receive(evilMeta);
    expect(outcome).toBe("move");
    expect(typeof b.latest.state.meta).toBe("bigint");
    expect(b.isMyTurn()).toBe(true);
    expect(b.legalMoves()).toHaveLength(20);
    await expect(b.move("e7e5")).resolves.toBeDefined();

    // turnNum as a JS number is never equal (`!==`) to the expected bigint turn, so it is rejected outright --
    // and rejection must not wedge the session either.
    const { a: a2, b: b2 } = await setup();
    const msg2 = await a2.move("e2e4");
    const evilTurn = { ...msg2, state: { ...msg2.state, turnNum: Number(msg2.state.turnNum) as unknown as bigint } };
    await expect(b2.receive(evilTurn)).rejects.toThrow(/unexpected turn/);
    expect(() => b2.isMyTurn()).not.toThrow();
    expect(() => b2.legalMoves()).not.toThrow();
    expect(b2.latest.state.turnNum).toBe(0n);
    await expect(b2.receive(msg2)).resolves.toBe("move");
  });

  it("I4: ingestOnChain accepts only cryptographically verifiable on-chain states", async () => {
    const { a, b, params } = await setup();
    await b.receive(await a.move("e2e4"));
    const L = a.latest.state;
    const forged = {
      ...L,
      turnNum: L.turnNum + 5n,
      balanceA: 0n,
      balanceB: 2n * params.deposit,
      meta: withStatus(L.meta, STATUS.BLACK_WON),
      prevHash: `0x${"11".repeat(32)}` as Hex,
    };
    await expect(a.ingestOnChain({ state: forged, sigA: "0x", sigB: "0x" })).rejects.toThrow(/unverifiable/);

    const wedge = { ...L, turnNum: 2n ** 64n - 1n };
    await expect(a.ingestOnChain({ state: wedge, sigA: "0x", sigB: "0x" })).rejects.toThrow(/unverifiable/);

    const e5 = await b.move("e7e5"); // never delivered off-chain; only carries B's signature
    expect(await a.ingestOnChain(e5)).toBe(true);
    expect(a.isMyTurn()).toBe(true);
    expect(await a.ingestOnChain(e5)).toBe(false);

    // A both-signed checkpoint also ingests, for a fresh session that never saw the game.
    const { a: c, b: d, keys: keysCD, params: paramsCD } = await setup();
    await finishGame(c, d);
    const proposal = await c.proposeNewGame();
    await d.receive(proposal);
    const full = await d.countersignNewGame();
    const fresh = await ChannelSession.create({ params: paramsCD, me: 0, sessionKey: keysCD[0], domain, store: new MemoryStore() });
    expect(await fresh.ingestOnChain(full)).toBe(true);
    expect(fresh.latest).toEqual(full);
  });

  it("Minor 5: clears a stale opponent Close signature once latest moves past it", async () => {
    const { a, b, keys } = await setup();
    await finishGame(a, b); // G1 terminal for both
    // B's real key signs Close for G1 directly (as the hub would see it), without freezing b's own session --
    // mirrors receiving a genuine Close signature out of band, before b's session itself decides to close.
    const G1 = a.latest.state;
    const cb1 = { stateHash: hashState(G1, domain), by: 1 as const, sig: await signClose(keys[1], G1, domain) };
    await a.receiveClose(cb1); // a holds b's Close signature for G1; a has not signed yet
    expect(a.closeTransaction()).toBeNull();

    await newGame(a, b); // advances latest past G1 -> the stale opponent signature must be cleared
    await finishGame(a, b); // resolves the new game to a fresh terminal state G2

    const ca2 = await a.signClose();
    expect(ca2.stateHash).not.toBe(cb1.stateHash);
    expect(a.closeTransaction()).toBeNull(); // b has not (yet) closed G2; the stale G1 signature must not count

    const cb2 = await b.signClose();
    await a.receiveClose(cb2);
    const tx = a.closeTransaction();
    expect(tx).not.toBeNull();
    expect(tx!.state.gameIndex).toBe(1);
  });

  it("Minor 6: does not alias returned or received objects with internal state", async () => {
    const { a, b } = await setup();
    const msg = await a.move("e2e4");
    (msg as { sigA: string }).sigA = "0xdead";
    expect(a.latest.sigA).not.toBe("0xdead");

    const proof = a.challengeProof();
    (proof.latest as { sigA: string }).sigA = "0xdead";
    expect(a.latest.sigA).not.toBe("0xdead");

    const s = await setup();
    const m2 = await s.a.move("e2e4");
    await s.b.receive(m2);
    (m2.state as { balanceB: bigint }).balanceB = 0n;
    expect(s.b.latest.state.balanceB).not.toBe(0n);
  });

  it("Minor 7: restore() rejects a snapshot from a different channel", async () => {
    const { a, cfgA, params } = await setup();
    const snap = a.snapshot();
    const otherParams = { ...params, salt: keccak256(toHex("different-salt")) };
    const otherCfg: SessionConfig = { ...cfgA, params: otherParams };
    expect(() => ChannelSession.restore(otherCfg, snap)).toThrow(ArenaProtocolError);
  });

  // --- R8 (replaces R7): Close only on terminal states --------------------------------------------------
  // R7 allowed the player on move to sign Close at the opening / a both-signed checkpoint. PoC1a/PoC1b showed
  // the opponent can keep that signature, challenge the same state and have `timeout` forfeit the frozen closer,
  // so both players must now be refused there; the positive cases move to terminal states.

  it("R8: refuses Close at the opening for both players", async () => {
    const { a, b } = await setup();
    await expect(a.signClose()).rejects.toThrow(/can only close on a finished game/); // on move (white)
    await expect(b.signClose()).rejects.toThrow(/can only close on a finished game/);
    expect(a.isClosing).toBe(false);
    expect(b.isClosing).toBe(false);
    expect(a.isMyTurn()).toBe(true); // nothing was frozen
  });

  it("R8: refuses Close on a both-signed checkpoint for both players", async () => {
    const { a, b } = await setup();
    await finishGame(a, b);
    await newGame(a, b); // gameIndex 1: white = (1 % 2) = B, so B is on move
    await expect(b.signClose()).rejects.toThrow(/can only close on a finished game/); // on move
    await expect(a.signClose()).rejects.toThrow(/can only close on a finished game/);
    expect(a.isClosing || b.isClosing).toBe(false);
    expect(b.isMyTurn()).toBe(true);
  });

  it("R8: allows Close for both players on terminal states (win and draw)", async () => {
    const { a, b } = await setup();
    await finishGame(a, b); // A mates, B resigns: terminal
    const ca = await a.signClose();
    const cb = await b.signClose();
    expect([ca.by, cb.by]).toEqual([0, 1]);
    expect(ca.stateHash).toBe(cb.stateHash);

    const s = await setup();
    await s.b.receive(await s.a.move("e2e4", { offerDraw: true }));
    await s.a.receive(await s.b.acceptDraw());
    // The second signer here is the player who is *not* on move — also fine on a terminal state.
    expect((await s.b.signClose()).by).toBe(1);
    expect((await s.a.signClose()).by).toBe(0);
  });

  it("R8: exits before game 0 via a draw offer, accepted, then Close on the DRAW state", async () => {
    const { a, b, params } = await setup();
    await b.receive(await a.move("e2e4", { offerDraw: true }));
    await a.receive(await b.acceptDraw());
    expect(statusOf(a.latest.state)).toBe(STATUS.DRAW);
    await b.receiveClose(await a.signClose());
    await a.receiveClose(await b.signClose());
    const tx = a.closeTransaction();
    expect(tx).not.toBeNull();
    expect(tx).toEqual(b.closeTransaction());
    expect(tx!.state.turnNum).toBe(2n);
    expect([tx!.state.balanceA, tx!.state.balanceB]).toEqual([params.deposit, params.deposit]); // unchanged
  });

  // --- R9: a move that chains from this player's pending checkpoint --------------------------------------

  it("R9/R4: accepts the opponent's move on this player's pending checkpoint, co-signing it itself", async () => {
    const { a, b } = await setup();
    await finishGame(a, b); // game 0 over; game 1 has B as white
    const proposal = await a.proposeNewGame();
    expect(await b.receive(proposal)).toBe("checkpoint-proposed");
    const full = await b.countersignNewGame(); // never delivered to A
    const e4 = await b.move("e2e4");
    expect(a.isMyTurn()).toBe(false);

    expect(await a.receive(e4)).toBe("move");
    const snap = a.snapshot();
    expect(snap.pendingCheckpoint).toBeNull();
    expect(snap.prev).toEqual(proposal); // the checkpoint, still only with A's own signature
    // R4: A also signs the adopted move itself (equivocation-guarded), so `latest` ends up fully signed and
    // needs no predecessor to be provable — closing the liveness gap the N1 refusal used to guard against.
    expect(snap.latest.state).toEqual(e4.state);
    expect(snap.latest.sigA).not.toBe("0x");
    expect(snap.latest.sigB).toBe(e4.sigB);
    expect(typeof snap.latest.state.meta).toBe("bigint");
    expect(a.challengeProof().hasPrev).toBe(false);
    expect(a.isMyTurn()).toBe(true);

    const e5 = await a.move("e7e5");
    const proof = a.challengeProof();
    expect(proof.hasPrev).toBe(true);
    expect(proof.prev.state).toEqual(e4.state);
    expect(proof.prev.sigA).not.toBe("0x"); // R4: A's own signature on the now-`prev` state
    expect(proof.prev.sigB).toBe(e4.sigB);
    expect(proof.latest).toEqual(e5);
    expect(await b.receive(e5)).toBe("move");
    // The late countersignature is now stale and harmless.
    await expect(a.receive(full)).rejects.toThrow(/unexpected turn/);
  });

  it("R9: refuses a move on the pending checkpoint that is wrongly signed, illegal or does not chain", async () => {
    const { a, b, keys, params } = await setup();
    await finishGame(a, b);
    const proposal = await a.proposeNewGame();
    await b.receive(proposal);
    await b.countersignNewGame();
    const e4 = await b.move("e2e4");
    // Signed by A's own key instead of the opponent's.
    await expect(a.receive({ ...e4, sigB: await signState(keys[0], e4.state, domain) })).rejects.toThrow(/signature/);
    // A board that does not follow the rules.
    const cheat = { ...e4.state, board: e4.state.board ^ 1n };
    await expect(a.receive({ state: cheat, sigA: "0x", sigB: await signState(keys[1], cheat, domain) })).rejects.toThrow(
      /does not match the rules/,
    );
    // Right turn number, but committing to another predecessor.
    const other = { ...e4.state, prevHash: `0x${"22".repeat(32)}` as Hex };
    await expect(a.receive({ state: other, sigA: "0x", sigB: await signState(keys[1], other, domain) })).rejects.toThrow(
      /does not extend the pending/,
    );
    // An illegal move on the checkpoint.
    const r = successor(proposal.state, parseMove(proposal.state, "e2e4"), params);
    if (!r.ok) throw new Error(r.reason);
    const illegal = { ...r.next, move: encodeMove(12, 36, 0, KIND.NORMAL), prevHash: hashState(proposal.state, domain) };
    await expect(a.receive({ state: illegal, sigA: "0x", sigB: await signState(keys[1], illegal, domain) })).rejects.toThrow(
      /illegal/,
    );
    expect(a.snapshot().pendingCheckpoint).toEqual(proposal);
    expect(await a.receive(e4)).toBe("move");
  });

  it("R9: refuses a chained move when this player, not the opponent, is white in the proposed game", async () => {
    const { a, b, keys, params } = await setup();
    await finishGame(a, b);
    await newGame(a, b); // game 1: B white
    await play(a, b, SCHOLARS_MATE); // B mates
    await b.receive(await a.resign()); // game 1 over
    const proposal = await a.proposeNewGame(); // game 2: A white, A is the checkpoint's mover
    const r = successor(proposal.state, parseMove(proposal.state, "e2e4"), params);
    if (!r.ok) throw new Error(r.reason);
    const forged = { ...r.next, prevHash: hashState(proposal.state, domain) };
    await expect(a.receive({ state: forged, sigA: "0x", sigB: await signState(keys[1], forged, domain) })).rejects.toThrow(
      /not the opponent's turn/,
    );
    await expect(a.ingestOnChain({ state: forged, sigA: "0x", sigB: await signState(keys[1], forged, domain) })).rejects.toThrow(
      /unverifiable/,
    );
  });

  it("R9: ingestOnChain adopts the opponent's move on the pending checkpoint", async () => {
    const { a, b } = await setup();
    await finishGame(a, b);
    const proposal = await a.proposeNewGame();
    await b.receive(proposal);
    await b.countersignNewGame(); // withheld
    const e4 = await b.move("e2e4");
    expect(await a.ingestOnChain(e4)).toBe(true);
    expect(a.snapshot().prev).toEqual(proposal);
    expect(a.snapshot().pendingCheckpoint).toBeNull();
    expect(a.isMyTurn()).toBe(true);
    expect(await b.receive(await a.move("e7e5"))).toBe("move");
  });

  // --- Final-review minors ---------------------------------------------------------------------------------

  it("M3: a closing session refuses moves with a 'closing' error, not 'not your turn'", async () => {
    const { a, b } = await setup();
    await finishGame(a, b);
    await a.signClose();
    for (const call of [() => a.move("e2e4"), () => a.resign(), () => a.acceptDraw(), () => a.claimStalemate()]) {
      await expect(call()).rejects.toThrow(/closing/);
    }
    expect(a.isMyTurn()).toBe(false);

    // A closing snapshot on a non-terminal state (e.g. one written before R8) where A would otherwise be on move.
    const fresh = await setup();
    const snap = fresh.a.snapshot();
    const closing = ChannelSession.restore(fresh.cfgA, { ...snap, closeState: snap.latest });
    expect(closing.isMyTurn()).toBe(false);
    expect(closing.legalMoves()).toEqual([]);
    await expect(closing.move("e2e4")).rejects.toThrow(/closing/);
    await expect(closing.resign()).rejects.toThrow(/closing/);
  });

  it("M5: closeTransaction() is tagged kind 'close'", async () => {
    const { a, b } = await setup();
    await finishGame(a, b);
    await b.receiveClose(await a.signClose());
    await a.receiveClose(await b.signClose());
    const tx = a.closeTransaction();
    expect(tx?.kind).toBe("close");
    expect(Object.keys(tx!).sort()).toEqual(["kind", "sigA", "sigB", "state"]);
  });

  it("T5: two concurrent receive() calls of the same valid move apply it exactly once", async () => {
    const { a, b } = await setup();
    const e4 = await a.move("e2e4");
    const results = await Promise.allSettled([b.receive(e4), b.receive(structuredClone(e4))]);
    const fulfilled = results.filter((r) => r.status === "fulfilled") as PromiseFulfilledResult<string>[];
    const rejected = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(fulfilled.map((r) => r.value)).toEqual(["move"]);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(ArenaProtocolError);
    expect(String(rejected[0].reason.message)).toMatch(/unexpected turn/);
    expect(b.latest.state.turnNum).toBe(1n);
    expect(b.latest).toEqual(e4);
  });

  it("Errors: malformed input to receive/ingestOnChain/receiveClose rejects with ArenaProtocolError", async () => {
    const { a, b } = await setup();
    const e4 = await a.move("e2e4");
    const bad = (patch: Record<string, unknown>) => ({ ...e4, state: { ...e4.state, ...patch } }) as unknown as SignedState;
    const malformed: unknown[] = [
      null,
      42,
      { sigA: e4.sigA, sigB: "0x" }, // no state
      bad({ board: Number.NaN }),
      bad({ balanceA: "lots" }),
      bad({ meta: Symbol("meta") }),
      bad({ move: BigInt(e4.state.move) }), // bigint move mixes with number bit operations
      bad({ move: "e2e4" }),
      bad({ move: { from: 12, to: 28 } }),
      bad({ turnNum: Number.NaN }),
    ];
    for (const m of malformed) {
      await expect(b.receive(m as SignedState)).rejects.toBeInstanceOf(ArenaProtocolError);
    }
    // ingestOnChain coerces value-preserving types (a bigint `move` equal to the number is well-formed, and a
    // stale well-formed state simply returns false), so it is probed with states that cannot be coerced.
    const onChainMalformed = [
      ...malformed.filter((_, i) => i !== 6),
      bad({ turnNum: 5n, board: Number.NaN }),
      bad({ turnNum: 5n, move: 1.5 }),
      bad({ turnNum: 5n, gameIndex: -1 }),
      bad({ turnNum: 5n, prevHash: 12 }),
    ];
    for (const m of onChainMalformed) {
      await expect(a.ingestOnChain(m as SignedState)).rejects.toBeInstanceOf(ArenaProtocolError);
    }
    // Nothing was recorded, and the genuine message still goes through.
    expect(b.latest.state.turnNum).toBe(0n);
    expect(await b.receive(e4)).toBe("move");

    await a.receive(await b.resign());
    const ca = await a.signClose();
    const closeMalformed: unknown[] = [
      null,
      { ...ca, by: 1, sig: "0x1234" }, // wrong length
      { ...ca, by: 1, sig: `0x${"ff".repeat(65)}` }, // unrecoverable
      { ...ca, by: 1, stateHash: 7n },
      { ...ca, by: "1" },
    ];
    for (const c of closeMalformed) {
      await expect(b.receiveClose(c as CloseSignature)).rejects.toBeInstanceOf(ArenaProtocolError);
    }
    await b.receiveClose(ca);
  });

  it("Errors: store failures are not rewrapped as protocol errors", async () => {
    const store = flakyStore();
    const { a, b } = await setup(undefined, store);
    await b.receive(await a.move("e2e4"));
    const e5 = await b.move("e7e5");
    store.fail = true;
    const err = await a.receive(e5).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(ArenaProtocolError);
    expect((err as Error).message).toBe("disk full");
    store.fail = false;
    expect(await a.receive(e5)).toBe("move");
  });

  it("Params: caller mutation of params/domain after construction changes nothing the session accepts", async () => {
    const keys = [generatePrivateKey(), generatePrivateKey()] as const;
    const params = makeParams({
      participants: ["0x00000000000000000000000000000000000000a1", "0x00000000000000000000000000000000000000b2"],
      sessionKeys: keys,
      rules: "0x00000000000000000000000000000000000000e5" as Address,
      feeRecipient: "0x00000000000000000000000000000000000000f6" as Address,
      fundingDeadline: 2_000_000_000n,
    });
    const dom: ArenaDomain = { chainId: 31337, hub: "0x000000000000000000000000000000000000beef" };
    const a = await ChannelSession.create({ params, me: 0, sessionKey: keys[0], domain: dom, store: new MemoryStore() });
    const b = await ChannelSession.create({
      params: structuredClone(params),
      me: 1,
      sessionKey: keys[1],
      domain: { ...dom },
      store: new MemoryStore(),
    });
    const e4 = await a.move("e2e4");
    await b.receive(e4);
    const e5 = await b.move("e7e5");

    // The caller now rewires its own objects: an attacker's key as B's signer, a bigger stake, another chain.
    const attacker = generatePrivateKey();
    (params.signers as unknown as Address[])[1] = privateKeyToAccount(attacker).address;
    (params as { stakePerGame: bigint }).stakePerGame = 1n;
    dom.chainId = 1;

    expect(a.params.signers[1]).toBe(privateKeyToAccount(keys[1]).address);
    expect(a.params.stakePerGame).toBe(100_000n);
    expect(Object.isFrozen(a.params)).toBe(true);
    expect(Object.isFrozen(a.params.signers)).toBe(true);
    expect(() => {
      (a.params.signers as unknown as Address[])[1] = privateKeyToAccount(attacker).address;
    }).toThrow(TypeError);

    // A move signed by the attacker is still refused; B's genuine move (original domain) is still accepted.
    const forged = { ...e5, sigB: await signState(attacker, e5.state, domain) };
    await expect(a.receive(forged)).rejects.toThrow(/signature/);
    expect(await a.receive(e5)).toBe("move");
  });

  // N1 (Plan 2 review) was: refuse to adopt a finished game on an uncountersigned checkpoint, since the adopted
  // state would leave `prev` a checkpoint only this player had signed — a proof the hub rejects, with no further
  // move able to repair it. R4 (Plan 3 fix round 1) replaces that refusal: the adopted state is co-signed by this
  // player too (see `moveOnPending`), so it is fully signed and needs no `prev` to be provable, whether or not it
  // is terminal — closing the liveness gap for real rather than declining to enter it.
  it("R4 (was N1): adopts and co-signs the opponent's move-1 resignation on an uncountersigned checkpoint", async () => {
    const { a, b, keys } = await setup();
    await finishGame(a, b); // A white wins game 0
    const proposal = await a.proposeNewGame();
    await b.receive(proposal);
    const full = await b.countersignNewGame(); // withheld from A for now
    const resign = await b.resign(); // B is white in game 1 and resigns on move 1
    expect(await a.receive(resign)).toBe("move");
    const proof = a.challengeProof();
    expect(proof.hasPrev).toBe(false); // fully signed: no predecessor needed
    expect(proof.latest.state).toEqual(resign.state);
    expect(proof.latest.sigA).not.toBe("0x");
    expect(proof.latest.sigB).not.toBe("0x");
    // The co-signature really does recover to A's own signer, not just a non-empty placeholder.
    expect((await recoverStateSigner(proof.latest.state, proof.latest.sigA, domain)).toLowerCase()).toBe(
      privateKeyToAccount(keys[0]).address.toLowerCase(),
    );
    // Fully signed and terminal: A can close cooperatively without waiting on B at all.
    await expect(a.signClose()).resolves.toBeDefined();
    // Once closing, even a legitimate late countersignature for the (now-moot) checkpoint is refused.
    await expect(a.receive(full)).rejects.toThrow(/closing/);
  });

  it("repairs prev with a late countersignature after adopting a move on its own checkpoint (harmless post-R4)", async () => {
    const { a, b } = await setup();
    await finishGame(a, b);
    await b.receive(await a.proposeNewGame());
    const full = await b.countersignNewGame(); // withheld
    const e4 = await b.move("e2e4");
    expect(await a.receive(e4)).toBe("move"); // R9 adoption; R4: A co-signs e4 itself
    // R4: the adopted move is already fully signed, so it is provable with no predecessor.
    const proofBefore = a.challengeProof();
    expect(proofBefore.hasPrev).toBe(false);
    expect(proofBefore.latest.state).toEqual(e4.state);
    expect(proofBefore.latest.sigA).not.toBe("0x");
    expect(proofBefore.latest.sigB).not.toBe("0x");
    // `prev` (the checkpoint C) is still only self-signed; a late countersignature still repairs it (harmless).
    expect(a.snapshot().prev?.sigB).toBe("0x"); // opponent is B
    expect(await a.receive(full)).toBe("checkpoint-repaired");
    expect(a.snapshot().prev?.sigB).not.toBe("0x");
    // The repair changes nothing about what is provable: the proof is identical before and after.
    expect(a.challengeProof()).toEqual(proofBefore);
  });

  it("opens from a loadable store: create first, restore afterwards", async () => {
    const { cfgA } = await setup();
    const store = new MemoryStore();
    const first = await ChannelSession.open({ ...cfgA, store });
    await first.move("e2e4");
    const second = await ChannelSession.open({ ...cfgA, store });
    expect(second.latest).toEqual(first.latest);
    expect(second.snapshot().lastSignedTurn).toBe(1n);
    await expect(second.move("d2d4")).rejects.toThrow(/not your turn/);
  });

  it("restores snapshots without closeSigTargets and rejects malformed ones", async () => {
    const { a, cfgA } = await setup();
    const snap = a.snapshot() as Partial<ReturnType<typeof a.snapshot>>;
    delete snap.closeSigTargets;
    const restored = ChannelSession.restore(cfgA, snap as ReturnType<typeof a.snapshot>);
    await expect(restored.move("e2e4")).resolves.toBeDefined();
    const bad = { ...a.snapshot(), lastSignedTurn: "1" as unknown as bigint };
    expect(() => ChannelSession.restore(cfgA, bad)).toThrow(ArenaProtocolError);
  });

  // R5 (Plan 3 fix round 1, I2): normalizeSnapshot must reject nested type confusion, not just missing top-level
  // fields — a string `turnNum` used to slip through and let `move()` release a signature over `turnNum: "01"`.
  it("rejects a snapshot with type-confused nested fields (I2)", async () => {
    const { a, cfgA } = await setup();
    const good = a.snapshot();

    const stringTurnNum = structuredClone(good);
    (stringTurnNum.latest.state as unknown as { turnNum: string }).turnNum = "0";
    expect(() => ChannelSession.restore(cfgA, stringTurnNum)).toThrow(ArenaProtocolError);

    const nonObjectState = structuredClone(good);
    (nonObjectState.latest as unknown as { state: number }).state = 5;
    expect(() => ChannelSession.restore(cfgA, nonObjectState)).toThrow(ArenaProtocolError);

    const badCloseSigs = structuredClone(good);
    (badCloseSigs as unknown as { closeSigs: unknown[] }).closeSigs = [1, 2];
    expect(() => ChannelSession.restore(cfgA, badCloseSigs)).toThrow(ArenaProtocolError);

    const missingSigB = structuredClone(good);
    delete (missingSigB.latest as unknown as Partial<SignedState>).sigB;
    expect(() => ChannelSession.restore(cfgA, missingSigB)).toThrow(ArenaProtocolError);

    const badCloseSigTargets = structuredClone(good);
    (badCloseSigTargets as unknown as { closeSigTargets: unknown[] }).closeSigTargets = ["not-hex", "0x"];
    expect(() => ChannelSession.restore(cfgA, badCloseSigTargets)).toThrow(ArenaProtocolError);

    // Sanity: the untouched clone still restores fine.
    expect(() => ChannelSession.restore(cfgA, good)).not.toThrow();
  });

  it("rejects a null or non-object snapshot", async () => {
    const { cfgA } = await setup();
    expect(() => ChannelSession.restore(cfgA, null as unknown as SessionSnapshot)).toThrow(ArenaProtocolError);
    expect(() => ChannelSession.restore(cfgA, 5 as unknown as SessionSnapshot)).toThrow(ArenaProtocolError);
    expect(() => ChannelSession.restore(cfgA, "nope" as unknown as SessionSnapshot)).toThrow(ArenaProtocolError);
  });
});
