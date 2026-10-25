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
import { SCHOLARS_MATE, highSTwin, makeParams, vAsParity } from "./helpers/fixtures.js";

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

/** `setup()`, renamed to the alice/bob pair the M5 tests use; `bobStore` lets a test assert on save counts. */
async function openPair() {
  const { a: alice, b: bob, cfgB } = await setup();
  return { alice, bob, bobStore: cfgB.store as MemoryStore };
}

/**
 * M5: a second session signing with Alice's own key, over a copy of her store's snapshot taken before her first
 * move -- e.g. a stale client instance, or a compromised key signing behind the real session's back. It produces
 * an alternate (conflicting) state for the same turn Alice's real session later signs.
 */
async function openPairWithFork() {
  const { a: alice, b: bob, cfgA } = await setup();
  const aliceKeyedFork = ChannelSession.restore(
    { ...cfgA, store: new MemoryStore() },
    structuredClone(alice.snapshot()),
  );
  return { alice, bob, aliceKeyedFork };
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
    // M5: an exact duplicate of latest is a no-op even while closing -- classifyRepeat runs before the closing check.
    expect(await a.receive(a.latest)).toBe("duplicate");
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
    // M5: an exact duplicate of latest (here, the opening state) is a no-op, not an error.
    expect(await a.receive({ ...a.latest })).toBe("duplicate");
    expect(encodeMove(0, 0, 0, KIND.NONE)).toBe(0);
    // A genuinely new state (latest+1) encoding KIND.NONE is not a legal move and is rejected.
    const latest = a.latest.state;
    const noneMove = {
      ...latest,
      turnNum: latest.turnNum + 1n,
      prevHash: hashState(latest, domain),
      move: encodeMove(0, 0, 0, KIND.NONE),
    };
    await expect(a.receive({ state: noneMove, sigA: "0x", sigB: "0x" })).rejects.toThrow(ArenaProtocolError);
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

  it("I2: refuses an opponent Close signature on a state that is not a finished game", async () => {
    const { a, b, keys } = await setup();
    await b.receive(await a.move("e2e4")); // game in progress; b (black) is on move
    const s = a.latest.state;
    const early: CloseSignature = { stateHash: hashState(s, domain), by: 1, sig: await signClose(keys[1], s, domain) };
    await expect(a.receiveClose(early)).rejects.toThrow(ArenaProtocolError);
    await expect(a.receiveClose(early)).rejects.toThrow("close signature for a state that is not a finished game");
    expect(a.snapshot().closeSigs).toEqual(["0x", "0x"]); // nothing recorded
    // The same opponent signature on a finished game is still accepted.
    await a.receive(await b.resign());
    const done = a.latest.state;
    await a.receiveClose({ stateHash: hashState(done, domain), by: 1, sig: await signClose(keys[1], done, domain) });
    expect(a.snapshot().closeSigs[1]).not.toBe("0x");
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
    // M5: the late countersignature is now stale and harmless -- a no-op, not an error.
    expect(await a.receive(full)).toBe("stale");
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
    // The mutex serializes the two calls in call order, so the first genuinely applies the move; by the time the
    // second one runs, `latest` already is that move, and M5's classifyRepeat reports the resend as a duplicate
    // no-op rather than an "unexpected turn" error.
    const results = await Promise.allSettled([b.receive(e4), b.receive(structuredClone(e4))]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
    expect((results as PromiseFulfilledResult<string>[]).map((r) => r.value)).toEqual(["move", "duplicate"]);
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

  // --- M5: re-sent messages (a relay reconnect re-sends both daemons' latest) -------------------------------

  describe("re-sent messages (M5)", () => {
    it("an exact duplicate of latest is a no-op", async () => {
      const { alice, bob, bobStore } = await openPair();
      const m1 = await alice.move("e4");
      expect(await bob.receive(m1)).toBe("move");
      const before = bob.snapshot();
      const saves = bobStore.snapshots.length;
      expect(await bob.receive(m1)).toBe("duplicate");
      expect(bob.snapshot()).toEqual(before);
      expect(bobStore.snapshots.length).toBe(saves); // classifyRepeat returns before store.save
    });

    it("an older state is stale and ignored", async () => {
      const { alice, bob, bobStore } = await openPair();
      const m1 = await alice.move("e4");
      await bob.receive(m1);
      const m2 = await bob.move("e5");
      await alice.receive(m2);
      const m3 = await alice.move("Nf3");
      await bob.receive(m3);
      const saves = bobStore.snapshots.length;
      expect(await bob.receive(m1)).toBe("stale");
      expect(bobStore.snapshots.length).toBe(saves); // classifyRepeat returns before store.save
    });

    it("a different state for the latest turn is still an error", async () => {
      const { alice, bob, aliceKeyedFork } = await openPairWithFork();
      const m1 = await alice.move("e4");
      await bob.receive(m1);
      const conflicting = await aliceKeyedFork.move("d4");
      await expect(bob.receive(conflicting)).rejects.toThrow(/conflicting state for turn 1/);
    });

    it("a re-sent new-game proposal the player already holds is a duplicate", async () => {
      const { alice, bob, bobStore } = await openPair();
      await finishGame(alice, bob);
      const proposal = await alice.proposeNewGame();
      expect(await bob.receive(proposal)).toBe("checkpoint-proposed");
      const saves = bobStore.snapshots.length;
      expect(await bob.receive(proposal)).toBe("duplicate");
      expect(bobStore.snapshots.length).toBe(saves); // classifyRepeat returns before store.save
    });

    it("a duplicate is still a no-op after this player signed Close", async () => {
      const { alice, bob, bobStore } = await openPair();
      await finishGame(alice, bob); // terminal state, reached via resign; bob holds it as `latest`
      const resignState = bob.latest;
      await bob.signClose();
      const saves = bobStore.snapshots.length;
      expect(await bob.receive(resignState)).toBe("duplicate");
      expect(bobStore.snapshots.length).toBe(saves); // classifyRepeat returns before store.save
    });

    // Pins the ordering inside receive(): classifyRepeat runs first and only short-circuits duplicate/stale
    // messages; a message at a turn this player has never seen falls through to the closing check as before.
    it("a genuinely new message at latest+1 is still refused while closing", async () => {
      const { alice, bob } = await openPair();
      await finishGame(alice, bob);
      await bob.signClose();
      const proposal = await alice.proposeNewGame(); // never seen by bob: not "duplicate", not "stale"
      await expect(bob.receive(proposal)).rejects.toThrow(/closing/);
    });

    it("receiveClose of a signature this player already holds is a no-op", async () => {
      const { alice, bob, bobStore } = await openPair();
      await finishGame(alice, bob);
      const ca = await alice.signClose();
      await bob.receiveClose(ca);
      const before = bob.snapshot();
      const saves = bobStore.snapshots.length;
      await expect(bob.receiveClose(ca)).resolves.toBeUndefined();
      expect(bob.snapshot()).toEqual(before);
      expect(bobStore.snapshots.length).toBe(saves); // early return, not a re-verify + re-save
    });
  });
});

// Plan 6 hardening H1 (audit-contracts I1): the hub checks only the mover's slot of a `hasPrev` proof and re-emits
// the whole `proof.latest`, so an event's other slot can hold any bytes. A session stores only what it verified.
describe("H1: ingestOnChain stores only signatures it verified (audit-contracts I1)", () => {
  /** The audit's scenario: Alice (honest) plays e4 offering a draw and challenges on it; Bob answers on-chain with
   *  ACCEPT_DRAW and puts `junk` in Alice's slot, which the hub never reads. */
  async function junkResponse(junk: Hex) {
    const { a, b, cfgA } = await setup();
    const s1 = await a.move("e2e4", { offerDraw: true });
    await b.receive(s1);
    const s2 = await b.acceptDraw();
    return { a, cfgA, s1, s2, onChain: { state: s2.state, sigA: junk, sigB: s2.sigB } };
  }

  it("drops junk in the slot the hub never checks, and builds the proof the hub accepts", async () => {
    const { a, s1, s2, onChain } = await junkResponse("0x01");
    expect(await a.ingestOnChain(onChain)).toBe(true);
    expect(a.latest).toEqual({ state: s2.state, sigA: "0x", sigB: s2.sigB });
    const proof = a.challengeProof();
    // Before H1: `{hasPrev: false, latest: {sigA: "0x01", ...}}`, which the hub refuses (Unsupported) every time.
    expect(proof.hasPrev).toBe(true);
    expect(proof.prev).toEqual(s1); // Alice's own signature endorses the predecessor
    expect(proof.latest).toEqual({ state: s2.state, sigA: "0x", sigB: s2.sigB });
  });

  it("drops large junk too, and never echoes it into a later proof's prev", async () => {
    const big = `0x${"ab".repeat(200_000)}` as Hex;
    const { a, b } = await setup();
    await b.receive(await a.move("e2e4"));
    const e5 = await b.move("e7e5");
    expect(await a.ingestOnChain({ state: e5.state, sigA: big, sigB: e5.sigB })).toBe(true);
    expect(a.latest.sigA).toBe("0x");
    await a.move("g1f3");
    expect(a.challengeProof().prev).toEqual({ state: e5.state, sigA: "0x", sigB: e5.sigB });
  });

  it("keeps a valid second signature, and still refuses junk in the mover's own slot", async () => {
    const { a, b } = await setup();
    await b.receive(await a.move("e2e4"));
    const e5 = await b.move("e7e5");
    // The mover's slot is the one the hub checks: junk there is not a supported state at all.
    await expect(a.ingestOnChain({ state: e5.state, sigA: "0x", sigB: "0x01" })).rejects.toThrow(/unverifiable/);
    // A both-signed state keeps both signatures (case ii): each was verified.
    const { a: c, b: d, keys: keysCD, params: paramsCD } = await setup();
    await finishGame(c, d);
    await d.receive(await c.proposeNewGame());
    const full = await d.countersignNewGame();
    const fresh = await ChannelSession.create({ params: paramsCD, me: 0, sessionKey: keysCD[0], domain, store: new MemoryStore() });
    expect(await fresh.ingestOnChain(full)).toBe(true);
    expect(fresh.latest.sigA).toBe(full.sigA);
    expect(fresh.latest.sigB).toBe(full.sigB);
    expect(fresh.challengeProof().hasPrev).toBe(false);
  });

  it("open() drops an unverified signature a pre-H1 snapshot stored, and saves the result", async () => {
    const { a, cfgA, s1, s2 } = await junkResponse("0x01");
    // A snapshot as a pre-H1 session left it: the junk stored verbatim in latest.sigA.
    const legacy = structuredClone(a.snapshot());
    legacy.prev = structuredClone(s1);
    legacy.latest = { state: s2.state, sigA: "0x01", sigB: s2.sigB };
    const store = new MemoryStore();
    await store.save(legacy);
    const restored = await ChannelSession.open({ ...cfgA, store });
    expect(restored.latest).toEqual({ state: s2.state, sigA: "0x", sigB: s2.sigB });
    expect(store.snapshots.length).toBe(2); // saved once, with the junk dropped
    expect(store.last?.latest.sigA).toBe("0x");
    expect(restored.challengeProof()).toMatchObject({ hasPrev: true, prev: s1 });
    // A snapshot with nothing to drop is not re-saved.
    const again = await ChannelSession.open({ ...cfgA, store });
    expect(store.snapshots.length).toBe(2);
    expect(again.latest).toEqual(restored.latest);
  });
});

// H1 fix round 1 (review I-1(b)): a registered state whose event cannot be read is adopted from the hub's storage,
// unsigned, only as the canonical next move of the opponent with the hub's own registered hash.
describe("H1 fix round 1: adoptRegistered and the signature an event later supplies", () => {
  it("adopts the opponent's canonical next move with the matching hash; refuses anything else", async () => {
    const { a, b } = await setup();
    const e4 = await a.move("e2e4");
    await b.receive(e4);
    const e5 = await b.move("e7e5"); // never delivered to a
    const h = hashState(e5.state, domain);
    // A wrong hash, a state two turns ahead, a non-successor and a malformed state change nothing.
    expect(await a.adoptRegistered(e5.state, `0x${"00".repeat(32)}`)).toBe(false);
    expect(await a.adoptRegistered({ ...e5.state, turnNum: 3n }, h)).toBe(false);
    expect(await a.adoptRegistered({ ...e5.state, move: e5.state.move + 1 }, h)).toBe(false);
    expect(await a.adoptRegistered({ ...e5.state, board: 1n }, hashState({ ...e5.state, board: 1n }, domain))).toBe(false);
    expect(a.latest.state.turnNum).toBe(1n);
    // Its own move is never adopted from storage: a second session on the same key signs e4 behind c's back.
    const { a: c, cfgA: cfgC } = await setup();
    const fork = await ChannelSession.create({ ...cfgC, store: new MemoryStore() });
    const own = await fork.move("e2e4");
    expect(await c.adoptRegistered(own.state, hashState(own.state, domain))).toBe(false);
    expect(c.latest.state.turnNum).toBe(0n);
    // The real one: adopted unsigned, a's turn, and a move on it is provable with `prev` endorsed by the hub's hash.
    expect(await a.adoptRegistered(e5.state, h)).toBe(true);
    expect(a.latest).toEqual({ state: e5.state, sigA: "0x", sigB: "0x" });
    expect(a.isMyTurn()).toBe(true);
    const nf3 = await a.move("g1f3");
    const proof = a.challengeProof();
    expect(proof).toMatchObject({ hasPrev: true, prev: { state: e5.state, sigA: "0x", sigB: "0x" }, latest: nf3 });
    // Adopting again is a no-op (not the next turn any more).
    expect(await a.adoptRegistered(e5.state, h)).toBe(false);
  });

  it("an event for a state already held repairs its missing signature -- verified only -- and saves once", async () => {
    const { a, b, cfgA } = await setup();
    await b.receive(await a.move("e2e4"));
    const e5 = await b.move("e7e5");
    expect(await a.adoptRegistered(e5.state, hashState(e5.state, domain))).toBe(true);
    await a.move("g1f3");
    const store = cfgA.store as MemoryStore;
    const saves = store.snapshots.length;
    // Junk for the slot is refused; Bob's real signature on e5 fills `prev`, which the next proof carries.
    expect(await a.ingestOnChain({ state: e5.state, sigA: "0x01", sigB: "0x02" })).toBe(false);
    expect(a.snapshot().prev?.sigB).toBe("0x");
    expect(store.snapshots.length).toBe(saves);
    expect(await a.ingestOnChain({ state: e5.state, sigA: "0x01", sigB: e5.sigB })).toBe(false);
    expect(a.snapshot().prev).toEqual({ state: e5.state, sigA: "0x", sigB: e5.sigB });
    expect(store.snapshots.length).toBe(saves + 1);
    expect(a.challengeProof().prev.sigB).toBe(e5.sigB);
  });
});

// Final review A: the hub verifies ECDSA only, with OpenZeppelin's rules. A session stores a signature only in the form
// the hub accepts, so no signature it holds can sink a proof.
describe("final review A: signatures only in the hub's form", () => {
  it("refuses the opponent's move and Close signatures in a form the hub refuses", async () => {
    const { a, b } = await setup();
    const e4 = await a.move("e2e4");
    for (const sigA of [highSTwin(e4.sigA), vAsParity(e4.sigA)]) {
      await expect(b.receive({ ...e4, sigA })).rejects.toThrow(/missing or invalid opponent signature/);
    }
    expect(await b.receive(e4)).toBe("move");
    await a.receive(await b.resign());
    const ca = await a.signClose();
    await expect(b.receiveClose({ ...ca, sig: highSTwin(ca.sig) })).rejects.toThrow(/invalid close signature/);
    await b.receiveClose(ca);
  });

  it("m-3: challengeProof() leaves a lone opening signature out, as the hub supports the opening with none or both", async () => {
    const { a, cfgA, keys } = await setup();
    const opening = a.latest.state;
    const lone = { state: opening, sigA: "0x" as Hex, sigB: await signState(keys[1], opening, domain) };
    const store = new MemoryStore();
    await store.save({ ...structuredClone(a.snapshot()), latest: lone });
    const restored = await ChannelSession.open({ ...cfgA, store });
    expect(restored.latest).toEqual(lone); // a valid signature survives the restore
    expect(restored.challengeProof()).toMatchObject({ hasPrev: false, latest: { state: opening, sigA: "0x", sigB: "0x" } });
    // A co-signed opening keeps both: the hub's both-signed rule supports it.
    const both = { ...lone, sigA: await signState(keys[0], opening, domain) };
    const store2 = new MemoryStore();
    await store2.save({ ...structuredClone(a.snapshot()), latest: both });
    expect((await ChannelSession.open({ ...cfgA, store: store2 })).challengeProof().latest).toEqual(both);
  });
});
