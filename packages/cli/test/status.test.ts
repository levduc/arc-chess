import { describe, expect, it } from "vitest";
import type { Hex } from "viem";
import { generatePrivateKey } from "viem/accounts";
import { ChannelSession, MemoryStore, signClose, type ArenaDomain } from "@arena/sdk";
import { buildStatus, type ChainView, type ChannelRecord } from "../src/index.js";
import { makeParams, SCHOLARS_MATE } from "../../sdk/test/helpers/fixtures.js";

const domain: ArenaDomain = { chainId: 31337, hub: "0x000000000000000000000000000000000000beef" };

async function sessions() {
  const keys = [generatePrivateKey(), generatePrivateKey()] as const;
  const params = makeParams({
    participants: ["0x00000000000000000000000000000000000000a1", "0x00000000000000000000000000000000000000b2"],
    sessionKeys: keys,
    rules: "0x00000000000000000000000000000000000000e5",
    feeRecipient: "0x00000000000000000000000000000000000000f6",
    fundingDeadline: 2_000_000_000n,
  });
  const a = await ChannelSession.create({ params, me: 0, sessionKey: keys[0], domain, store: new MemoryStore() });
  const b = await ChannelSession.create({ params, me: 1, sessionKey: keys[1], domain, store: new MemoryStore() });
  const rec = (me: 0 | 1): ChannelRecord => ({
    channelId: a.id,
    params,
    me,
    sessionKey: keys[me],
    offerId: a.id,
    createdBlock: 0n,
    controller: "agent",
    note: "",
    finalized: false,
  });
  return { a, b, rec, keys };
}

const OPEN: ChainView = {
  phase: "Open",
  funded: [true, true],
  deadline: 0n,
  challenger: 0,
  registeredTurn: null,
  cooldownUntil: [0n, 0n],
  now: 1000n,
};
const view = (s: ChannelSession, record: ChannelRecord, chain = OPEN, lastProgressAt: bigint | null = null) =>
  buildStatus({ record, snapshot: s.snapshot(), myTurn: s.isMyTurn(), chain, lastError: null, lastProgressAt });

async function finished() {
  const x = await sessions();
  for (const m of SCHOLARS_MATE) {
    const [mover, other] = x.a.isMyTurn() ? [x.a, x.b] : [x.b, x.a];
    await other.receive(await mover.move(m));
  }
  await x.a.receive(await x.b.resign()); // game 0 over: white (a) won
  return x;
}

describe("buildStatus", () => {
  it("describes the opening for both sides", async () => {
    const { a, b, rec } = await sessions();
    const sa = view(a, rec(0));
    expect(sa.color).toBe("white");
    expect(sa.myTurn).toBe(true);
    expect(sa.legalMoves).toContain("e4");
    expect(sa.legalMoves).toHaveLength(20);
    expect(sa.attention).toBe("your-turn");
    expect(sa.balances).toEqual({ me: "1.000000", opponent: "1.000000" });
    expect(sa.board).toContain("r  n  b  q  k  b  n  r");
    expect(sa.cooldown).toEqual({ meSeconds: 0, opponentSeconds: 0 });
    expect(sa.suggestedActions.some((x) => x.startsWith("arena move"))).toBe(true);
    const sb = view(b, rec(1));
    expect(sb.color).toBe("black");
    expect(sb.myTurn).toBe(false);
    expect(sb.legalMoves).toEqual([]);
    expect(sb.attention).toBeNull();
  });

  it("reports game over, new-game proposals and close requests", async () => {
    const { a, b, rec } = await sessions();
    for (const m of SCHOLARS_MATE) {
      const [mover, other] = a.isMyTurn() ? [a, b] : [b, a];
      await other.receive(await mover.move(m));
    }
    await a.receive(await b.resign());
    const over = view(a, rec(0));
    expect(over.gameStatus).toBe("white_won");
    expect(over.attention).toBe("game-over");
    expect(over.balances).toEqual({ me: "1.100000", opponent: "0.900000" });
    expect(over.suggestedActions).toEqual(expect.arrayContaining(["arena next-game", "arena close"]));

    await b.receive(await a.proposeNewGame());
    expect(view(b, rec(1)).newGame).toBe("proposed_by_opponent");
    expect(view(b, rec(1)).attention).toBe("new-game-proposed");
    expect(view(a, rec(0)).newGame).toBe("proposed_by_me");
  });

  it("flags a challenge that needs this player's move", async () => {
    const { a, b, rec } = await sessions();
    await b.receive(await a.move("e2e4"));
    const s = view(b, rec(1), {
      ...OPEN,
      phase: "Challenged",
      deadline: 1600n,
      challenger: 0,
      registeredTurn: 1n,
      cooldownUntil: [1900n, 1300n],
    });
    expect(s.challenge).toEqual({ deadline: "1600", secondsLeft: 600, mustMove: true, challenger: "opponent" });
    expect(s.attention).toBe("your-turn");
    expect(s.cooldown).toEqual({ meSeconds: 300, opponentSeconds: 900 });
  });

  it("stays quiet while a human controls the channel", async () => {
    const { a, rec } = await sessions();
    const s = view(a, { ...rec(0), controller: "human", note: "mine now" });
    expect(s.attention).toBeNull();
    expect(s.note).toBe("mine now");
  });

  it("I2(a): suggests arena challenge after arena wait while the opponent is on move", async () => {
    const { a, b, rec } = await sessions();
    await b.receive(await a.move("e2e4"));
    const s = view(a, rec(0));
    expect(s.attention).toBeNull();
    expect(s.suggestedActions).toEqual(["arena wait", "arena challenge   (if the opponent stops responding)"]);
    // Already Challenged: the escalation is under way, so it is not suggested again.
    const c = view(a, rec(0), { ...OPEN, phase: "Challenged", deadline: 1600n, registeredTurn: 1n });
    expect(c.suggestedActions).toEqual(["arena wait"]);
  });

  it("I2(b): with our new-game proposal unanswered, suggests challenge and never arena close", async () => {
    const { a, b, rec } = await finished();
    await b.receive(await a.proposeNewGame());
    const s = view(a, rec(0));
    expect(s.newGame).toBe("proposed_by_me");
    expect(s.attention).toBeNull();
    expect(s.suggestedActions).not.toContain("arena close");
    expect(s.suggestedActions).toEqual([
      "wait: new game proposed",
      "arena challenge   (settles the finished game on-chain if the opponent never answers)",
    ]);
  });

  it("I2(c): after signing Close, suggests challenge while the opponent's Close signature is missing", async () => {
    const { a, b, rec } = await finished();
    await b.receiveClose(await a.signClose());
    const s = view(a, rec(0));
    expect(s.closing).toBe(true);
    expect(s.suggestedActions).toEqual([
      "wait: close signed; waiting for the opponent's close signature",
      "arena challenge   (settles the finished game on-chain if they never sign)",
    ]);
  });

  it("I2: close-requested only for a finished game with nothing pending and while we are not closing", async () => {
    const { a, b, rec, keys } = await finished();
    // An opponent Close signature on the finished game is a request we can honour. (Signed with b's raw key, so
    // b's own session is not frozen and can still receive a proposal below.)
    const close = { sig: await signClose(keys[1], a.latest.state, domain) };
    const oppClosed = { ...a.snapshot(), closeSigs: ["0x", close.sig] as [Hex, Hex] };
    const req = buildStatus({ record: rec(0), snapshot: oppClosed, myTurn: false, chain: OPEN, lastError: null });
    expect(req.attention).toBe("close-requested");
    // A Close signature recorded against a non-terminal latest (as a snapshot written before the SDK refused them
    // could hold) must not raise close-requested: `arena close` would always fail there.
    const fresh = await sessions();
    await fresh.b.receive(await fresh.a.move("e2e4"));
    const early = { ...fresh.a.snapshot(), closeSigs: ["0x", `0x${"11".repeat(65)}`] as [Hex, Hex] };
    const e = buildStatus({ record: fresh.rec(0), snapshot: early, myTurn: false, chain: OPEN, lastError: null });
    expect(e.opponentWantsToClose).toBe(true);
    expect(e.attention).toBeNull();
    // Nor while a new-game proposal is pending either way.
    const proposal = await a.proposeNewGame();
    const pendingMine = { ...a.snapshot(), closeSigs: ["0x", close.sig] as [Hex, Hex] };
    expect(buildStatus({ record: rec(0), snapshot: pendingMine, myTurn: false, chain: OPEN, lastError: null }).attention).toBeNull();
    await b.receive(proposal);
    const pendingTheirs = { ...b.snapshot(), closeSigs: [close.sig, "0x"] as [Hex, Hex] };
    expect(buildStatus({ record: rec(1), snapshot: pendingTheirs, myTurn: false, chain: OPEN, lastError: null }).attention).toBe(
      "new-game-proposed",
    );
  });

  it("I2: raises opponent-silent once the opponent has not progressed for more than challengeTimeout", async () => {
    const { a, b, rec } = await sessions();
    await b.receive(await a.move("e2e4")); // a waits on b's move
    // Exactly challengeTimeout (600 s) of silence is not yet "more than".
    expect(view(a, rec(0), OPEN, OPEN.now - 600n).attention).toBeNull();
    const s = view(a, rec(0), OPEN, OPEN.now - 601n);
    expect(s.attention).toBe("opponent-silent");
    expect(s.suggestedActions[0]).toMatch(/^arena challenge .*no progress for over 600s/);
    expect(s.suggestedActions).toContain("arena wait");
    expect(s.suggestedActions.filter((x) => x.startsWith("arena challenge"))).toHaveLength(1);
    // Unknown progress time, a human in control, our own turn, or an ongoing challenge: no opponent-silent.
    expect(view(a, rec(0), OPEN, null).attention).toBeNull();
    expect(view(a, { ...rec(0), controller: "human" }, OPEN, OPEN.now - 601n).attention).toBeNull();
    expect(view(b, rec(1), OPEN, OPEN.now - 601n).attention).toBe("your-turn");
    expect(view(a, rec(0), { ...OPEN, phase: "Challenged", deadline: 1600n, registeredTurn: 1n }, OPEN.now - 601n).attention).toBeNull();
  });

  it("Plan 5 Task 3 fix round: humanAttention raises opponent-silent for a human in control, leaving attention (and so wait) unchanged", async () => {
    const { a, b, rec } = await sessions();
    await b.receive(await a.move("e2e4")); // a waits on b's move
    const human = { ...rec(0), controller: "human" as const };
    const s = view(a, human, OPEN, OPEN.now - 601n);
    // The agent's channel: attention stays null while the human holds the seat, so `wait` stays quiet.
    expect(s.attention).toBeNull();
    expect(s.humanAttention).toBe("opponent-silent");
    expect(s.suggestedActions[0]).toMatch(/^arena challenge .*no progress for over 600s/);
    // Not yet silent, the agent in control, or an ongoing challenge: no humanAttention.
    expect(view(a, human, OPEN, OPEN.now - 600n).humanAttention).toBeNull();
    expect(view(a, human, OPEN, null).humanAttention).toBeNull();
    const agent = view(a, rec(0), OPEN, OPEN.now - 601n);
    expect(agent.attention).toBe("opponent-silent");
    expect(agent.humanAttention).toBeNull();
    expect(view(a, human, { ...OPEN, phase: "Challenged", deadline: 1600n, registeredTurn: 1n }, OPEN.now - 601n).humanAttention).toBeNull();
  });

  it("I2: opponent-silent also covers an unanswered proposal and a withheld Close, but not our own game-over decision", async () => {
    const x = await finished();
    expect(view(x.a, x.rec(0), OPEN, OPEN.now - 601n).attention).toBe("game-over"); // our call, not their silence
    await x.b.receive(await x.a.proposeNewGame());
    expect(view(x.a, x.rec(0), OPEN, OPEN.now - 601n).attention).toBe("opponent-silent");
    const y = await finished();
    await y.a.signClose();
    expect(view(y.a, y.rec(0), OPEN, OPEN.now - 601n).attention).toBe("opponent-silent");
  });

  it("Plan 5 Task 2: legalMovesUci mirrors legalMoves (UCI strings), only on my turn", async () => {
    const { a, b, rec } = await sessions();
    const sa = view(a, rec(0));
    expect(sa.legalMovesUci).toContain("e2e4");
    expect(sa.legalMovesUci).toHaveLength(20);
    expect(view(b, rec(1)).legalMovesUci).toEqual([]);
  });

  it("Plan 5 Task 2: orientation matches color", async () => {
    const { a, b, rec } = await sessions();
    expect(view(a, rec(0)).orientation).toBe("white");
    expect(view(b, rec(1)).orientation).toBe("black");
  });

  it("Plan 5 Task 2: lastMove is null at the start of a game, and {from, to, san} right after a move", async () => {
    const { a, b, rec } = await sessions();
    expect(view(a, rec(0)).lastMove).toBeNull();
    expect(view(b, rec(1)).lastMove).toBeNull();
    await b.receive(await a.move("e2e4"));
    expect(view(a, rec(0)).lastMove).toEqual({ from: "e2", to: "e4", san: "e4" });
    expect(view(b, rec(1)).lastMove).toEqual({ from: "e2", to: "e4", san: "e4" });
    await a.receive(await b.move("g8f6")); // Nf6 -- exercises a piece move's SAN, not just a pawn push
    expect(view(a, rec(0)).lastMove).toEqual({ from: "g8", to: "f6", san: "Nf6" });
  });

  it("Plan 5 Task 2: lastMove is null for a non-move kind (resign)", async () => {
    const x = await finished(); // x.a's latest is b's RESIGN, not a move
    expect(view(x.a, x.rec(0)).lastMove).toBeNull();
  });

  it("Plan 5 Task 2: handoff carries controller/note/since -- since is null until handoffAt is set", async () => {
    const { a, rec } = await sessions();
    expect(view(a, rec(0)).handoff).toEqual({ controller: "agent", note: "", since: null });
    const handoffAt = 1_700_000_000_000;
    const s = view(a, { ...rec(0), controller: "human", note: "mine now", handoffAt });
    expect(s.handoff).toEqual({ controller: "human", note: "mine now", since: new Date(handoffAt).toISOString() });
  });

  it("I4: a channel retired unfunded reports done instead of waiting for funding", async () => {
    const { a, rec } = await sessions();
    const none: ChainView = { ...OPEN, phase: "None", funded: [false, false] };
    expect(view(a, rec(0), none).suggestedActions).toEqual(["wait: the channel is being funded"]);
    expect(view(a, { ...rec(0), finalized: true }, none).suggestedActions[0]).toMatch(/^done: the funding window closed/);
  });
});
