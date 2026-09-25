import { describe, expect, it } from "vitest";
import type { Address, Hex } from "viem";
import { generatePrivateKey } from "viem/accounts";
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
  signState,
  statusOf,
  successor,
  type ArenaDomain,
  type SessionConfig,
} from "../src/index.js";
import { SCHOLARS_MATE, makeParams } from "./helpers/fixtures.js";

const domain: ArenaDomain = { chainId: 31337, hub: "0x000000000000000000000000000000000000beef" };

async function setup(deposit?: bigint) {
  const keys = [generatePrivateKey(), generatePrivateKey()] as const;
  const params = makeParams({
    participants: ["0x00000000000000000000000000000000000000a1", "0x00000000000000000000000000000000000000b2"],
    sessionKeys: keys,
    rules: "0x00000000000000000000000000000000000000e5" as Address,
    feeRecipient: "0x00000000000000000000000000000000000000f6" as Address,
    fundingDeadline: 2_000_000_000n,
    deposit,
  });
  const cfg = (me: 0 | 1): SessionConfig => ({ params, me, sessionKey: keys[me], domain, store: new MemoryStore() });
  const cfgA = cfg(0);
  const cfgB = cfg(1);
  const a = await ChannelSession.create(cfgA);
  const b = await ChannelSession.create(cfgB);
  return { a, b, cfgA, cfgB, keys, params };
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
    const { a, b, keys, params } = await setup();
    await finishGame(a, b);
    const proposal = await a.proposeNewGame();
    await b.receive(proposal);
    expect(b.isMyTurn()).toBe(false); // B is white in game 1 but the checkpoint is not countersigned yet
    await expect(b.move("e2e4")).rejects.toThrow(/not your turn/);
    // A move built on the single-signed checkpoint is not accepted by A either.
    const r = successor(proposal.state, parseMove(proposal.state, "e2e4"), params);
    if (!r.ok) throw new Error(r.reason);
    const early = { ...r.next, prevHash: hashState(proposal.state, domain) };
    await expect(a.receive({ state: early, sigA: "0x", sigB: await signState(keys[1], early, domain) })).rejects.toThrow(
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
    await expect(a.signClose()).rejects.toThrow(/between games/);
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
});
