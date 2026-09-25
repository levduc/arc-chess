import { beforeAll, describe, expect, it } from "vitest";
import { generatePrivateKey } from "viem/accounts";
import {
  KIND,
  channelHubAbi,
  channelId,
  chessRulesAbi,
  encodeMove,
  fenToPosition,
  hashClose,
  hashState,
  initialState,
  isGameOver,
  legalMoves,
  parseMove,
  successor,
  HubClient,
  LocalKeyTxSender,
  type Params,
  type State,
} from "../src/index.js";
import { ANVIL_KEYS, CHAIN, RPC, deployArena, mintUsdc, now } from "./helpers/chain.js";
import { makeParams, mulberry32 } from "./helpers/fixtures.js";

let env: Awaited<ReturnType<typeof deployArena>>;
let p: Params;

async function expectSame(prev: State, move: number): Promise<boolean> {
  const ts = successor(prev, move, p);
  const [ok, next] = await env.pub.readContract({
    address: env.rules,
    abi: chessRulesAbi,
    functionName: "successor",
    args: [prev, move, p],
  });
  expect(ts.ok, `ok flag for move ${move} from ${prev.turnNum}`).toBe(ok);
  if (ts.ok && ok) expect({ ...next }).toEqual(ts.next);
  return ok;
}

describe("SDK agrees with the deployed contracts", () => {
  beforeAll(async () => {
    env = await deployArena();
    const alice = new LocalKeyTxSender(ANVIL_KEYS[1], RPC, CHAIN).address;
    const bob = new LocalKeyTxSender(ANVIL_KEYS[2], RPC, CHAIN).address;
    p = makeParams({
      participants: [alice, bob],
      sessionKeys: [generatePrivateKey(), generatePrivateKey()],
      rules: env.rules,
      feeRecipient: env.host,
      fundingDeadline: (await now()) + 3600n,
    });
  });

  it("successor matches ChessRules over random games, illegal moves and terminal kinds", async () => {
    const rand = mulberry32(7);
    const id = channelId(CHAIN.id, env.hub, p);
    for (let g = 0; g < 8; g++) {
      let s = initialState(id, p);
      for (let ply = 0; ply < 80 && !isGameOver(s); ply++) {
        const legal = legalMoves(s);
        if (legal.length === 0) break;
        const kind = rand() < 0.1 ? KIND.NORMAL_OFFER_DRAW : KIND.NORMAL;
        const mv = parseMove(s, legal[Math.floor(rand() * legal.length)], kind);
        await expectSame(s, encodeMove(Math.floor(rand() * 64), Math.floor(rand() * 64), rand() < 0.2 ? 5 : 0, KIND.NORMAL));
        await expectSame(s, mv | (5 << 12)); // promotion suffix on the chosen move
        expect(await expectSame(s, mv)).toBe(true);
        const r = successor(s, mv, p);
        if (!r.ok) throw new Error(r.reason);
        s = r.next;
      }
      for (const k of [KIND.RESIGN, KIND.ACCEPT_DRAW, KIND.CLAIM_STALEMATE, KIND.NEW_GAME, 0, 9]) {
        await expectSame(s, encodeMove(0, 0, 0, k));
      }
    }
  });

  it("successor matches on limit, stalemate and material positions", async () => {
    const id = channelId(CHAIN.id, env.hub, p);
    // [fen, move, intended ok, gameIndex?] — `ok` is the intended legality, so a case that silently stops
    // exercising the branch it was written for (e.g. becomes illegal for an unrelated reason) fails here.
    const cases: Array<[string, string | number, boolean, number?]> = [
      ["7k/Q7/6K1/8/8/8/8/8 w - - 99 76", "a7g7", true], // mate on the fifty-move limit
      ["7k/8/8/8/3R4/8/8/K7 w - - 99 76", "d4d5", true], // fifty-move draw
      ["7k/8/8/8/3R4/8/8/K7 b - - 0 150", "h8g8", true], // ply cap
      ["7k/8/8/4p3/8/5N2/8/K7 w - - 10 31", "f3e5", true], // insufficient material
      ["7k/5Q2/6K1/8/8/8/8/8 b - - 0 21", encodeMove(0, 0, 0, KIND.CLAIM_STALEMATE), true], // real stalemate
      ["7k/6Q1/6K1/8/8/8/8/8 b - - 0 21", encodeMove(0, 0, 0, KIND.CLAIM_STALEMATE), false], // checkmate, not stalemate
      ["8/P7/8/8/8/8/8/k6K w - - 0 1", encodeMove(48, 56, 0, KIND.NORMAL), false], // last-rank push without promotion
      ["8/P7/8/8/8/8/8/k6K w - - 0 1", "a7a8n", true], // under-promotion
      ["rnbqkbnr/ppp1p1pp/8/3pPp2/8/8/PPPP1PPP/RNBQKBNR w KQkq f6 0 3", "e5f6", true], // en passant
      ["r3k2r/8/8/8/8/5q2/8/R3K2R w KQkq - 0 1", encodeMove(4, 6, 0, KIND.NORMAL), false], // castling through check
      // (a) mate delivered by the move that reaches the fifty-move limit, in an ODD game (B is white).
      ["7k/Q7/6K1/8/8/8/8/8 w - - 99 76", "a7g7", true, 1],
      // (b) black mate delivered by the move that reaches the ply cap (299 -> 300); fullmove 150,
      // side b => ply = (150-1)*2+1 = 299. Checked in game 0 and game 1 so the stake shifts to the
      // player the contract's gameIndex/side mapping actually assigns as the winner.
      ["8/8/8/1q6/8/2k5/8/K7 b - - 0 150", "b5b2", true, 0],
      ["8/8/8/1q6/8/2k5/8/K7 b - - 0 150", "b5b2", true, 1],
      // (d) castling-rights loss after a rook is captured on its home square (black loses queenside rights).
      ["r3k2r/8/1N6/8/8/8/8/4K2R w Kkq - 0 5", "b6a8", true],
      // (e) a promotion that captures.
      ["r6k/1P6/8/8/8/8/8/K7 w - - 0 1", "b7a8q", true],
    ];
    for (const [fen, mv, intended, gameIndex] of cases) {
      const { board, meta } = fenToPosition(fen);
      const s: State = { ...initialState(id, p), turnNum: 10n, board, meta, ...(gameIndex !== undefined ? { gameIndex } : {}) };
      expect(await expectSame(s, typeof mv === "number" ? mv : parseMove(s, mv)), `intended ok for ${fen} ${mv}`).toBe(intended);
    }

    // (c) en-passant capture where the ep square was recorded by the contract itself after a double push,
    // not synthesised from a FEN: play the double push through `successor`, then capture en passant.
    {
      const { board, meta } = fenToPosition("7k/8/8/8/3p4/8/4P3/K7 w - - 0 1");
      const base: State = { ...initialState(id, p), turnNum: 10n, board, meta };
      expect(await expectSame(base, parseMove(base, "e2e4"))).toBe(true);
      const pushed = successor(base, parseMove(base, "e2e4"), p);
      if (!pushed.ok) throw new Error(pushed.reason);
      expect(await expectSame(pushed.next, parseMove(pushed.next, "d4e3"))).toBe(true);
    }
  });

  it("hashState, hashClose and channelId match the hub, and the hub accepts encodeParams", async () => {
    const id = channelId(CHAIN.id, env.hub, p);
    const s0 = initialState(id, p);
    const s1 = successor(s0, parseMove(s0, "e2e4"), p);
    if (!s1.ok) throw new Error(s1.reason);
    const read = (functionName: "hashState" | "hashClose", s: State) =>
      env.pub.readContract({ address: env.hub, abi: channelHubAbi, functionName, args: [s] });
    for (const s of [s0, { ...s1.next, prevHash: hashState(s0, env.domain) }]) {
      expect(await read("hashState", s)).toBe(hashState(s, env.domain));
      expect(await read("hashClose", s)).toBe(hashClose(s, env.domain));
    }
    expect(await env.pub.readContract({ address: env.hub, abi: channelHubAbi, functionName: "channelId", args: [p] })).toBe(id);

    const alice = new LocalKeyTxSender(ANVIL_KEYS[1], RPC, CHAIN);
    const hub = new HubClient(env.hub, env.pub);
    await mintUsdc(env.usdc, alice.address, 10_000_000n);
    await hub.approve(alice, env.usdc, 2n ** 255n);
    await hub.deposit(alice, p);
    expect(await hub.channelParams(id)).toEqual({ ...p, participants: [...p.participants], signers: [...p.signers] });
    const info = await hub.channelInfo(id);
    expect(info.phase).toBe("Funding");
    expect(info.funded).toEqual([true, false]);
  });
});
