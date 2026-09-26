import { describe, expect, it } from "vitest";
import { generatePrivateKey } from "viem/accounts";
import { ChannelSession, MemoryStore, type ArenaDomain } from "@arena/sdk";
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
  return { a, b, rec };
}

const OPEN: ChainView = { phase: "Open", funded: [true, true], deadline: 0n, challenger: 0, registeredTurn: null, now: 1000n };
const view = (s: ChannelSession, record: ChannelRecord, chain = OPEN) =>
  buildStatus({ record, snapshot: s.snapshot(), myTurn: s.isMyTurn(), chain, lastError: null });

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
    const s = view(b, rec(1), { ...OPEN, phase: "Challenged", deadline: 1600n, challenger: 0, registeredTurn: 1n });
    expect(s.challenge).toEqual({ deadline: "1600", secondsLeft: 600, mustMove: true, challenger: "opponent" });
    expect(s.attention).toBe("your-turn");
  });

  it("stays quiet while a human controls the channel", async () => {
    const { a, rec } = await sessions();
    const s = view(a, { ...rec(0), controller: "human", note: "mine now" });
    expect(s.attention).toBeNull();
    expect(s.note).toBe("mine now");
  });
});
