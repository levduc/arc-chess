import { describe, expect, it } from "vitest";
import type { Hex } from "viem";
import {
  KIND,
  STATUS,
  encodeMove,
  fenOf,
  fenToPosition,
  forfeitBalances,
  initialState,
  isCheckpoint,
  isGameOver,
  legalMoves,
  mover,
  parseMove,
  squareIndex,
  statusOf,
  successor,
  unpackMeta,
  type Params,
  type State,
} from "../src/index.js";

const ID = `0x${"11".repeat(32)}` as Hex;
const D = 1_000_000n;
const S = 100_000n;
const P: Params = {
  participants: ["0x00000000000000000000000000000000000000a1", "0x00000000000000000000000000000000000000b2"],
  signers: ["0x00000000000000000000000000000000000000c3", "0x00000000000000000000000000000000000000d4"],
  rules: "0x00000000000000000000000000000000000000e5",
  feeRecipient: "0x00000000000000000000000000000000000000f6",
  feePerPlayer: 5_000n,
  deposit: D,
  stakePerGame: S,
  challengeTimeout: 600n,
  fundingDeadline: 2_000_000_000n,
  salt: `0x${"22".repeat(32)}`,
};

function step(prev: State, move: number, p: Params = P): State {
  const r = successor(prev, move, p);
  if (!r.ok) throw new Error(r.reason);
  return r.next;
}
const uci = (s: State, m: string, kind: number = KIND.NORMAL) => parseMove(s, m, kind);
const kind = (k: number) => encodeMove(0, 0, 0, k);
function at(fen: string, turnNum = 10n): State {
  const { board, meta } = fenToPosition(fen);
  return { ...initialState(ID, P), turnNum, board, meta };
}

describe("chess mirror of ChessRules", () => {
  it("builds the opening state", () => {
    const s0 = initialState(ID, P);
    expect(s0.turnNum).toBe(0n);
    expect(s0.balanceA).toBe(D);
    expect(fenOf(s0)).toBe("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1");
    expect(mover(s0)).toBe(0);
    expect(legalMoves(s0)).toHaveLength(20);
  });

  it("applies a double pawn push with ep, side, halfmove and ply", () => {
    const s1 = step(initialState(ID, P), uci(initialState(ID, P), "e2e4"));
    const m = unpackMeta(s1.meta);
    expect(s1.turnNum).toBe(1n);
    expect(m).toEqual({ side: 1, castling: 15, ep: squareIndex("e3"), halfmove: 0, ply: 1, status: STATUS.PLAYING });
    expect(mover(s1)).toBe(1);
  });

  it("parses SAN and UCI to the same encoding", () => {
    const s0 = initialState(ID, P);
    expect(parseMove(s0, "Nf3")).toBe(parseMove(s0, "g1f3"));
    expect(parseMove(s0, "e4", KIND.NORMAL_OFFER_DRAW)).toBe(encodeMove(12, 28, 0, KIND.NORMAL_OFFER_DRAW));
    expect(() => parseMove(s0, "Qh5")).toThrow();
  });

  it("rejects illegal moves, non-canonical encodings and a promotion suffix on a non-promotion move", () => {
    const s0 = initialState(ID, P);
    expect(successor(s0, encodeMove(12, 36, 0, KIND.NORMAL), P).ok).toBe(false); // e2e5
    expect(successor(s0, uci(s0, "e2e4") | (1 << 25), P).ok).toBe(false);
    expect(successor(s0, encodeMove(12, 28, 5, KIND.NORMAL), P).ok).toBe(false); // e2e4 "q"
    expect(successor(s0, encodeMove(12, 28, 1, KIND.NORMAL), P).ok).toBe(false);
  });

  it("requires a promotion piece on the last rank", () => {
    const s = at("8/P7/8/8/8/8/8/k6K w - - 0 1");
    expect(successor(s, encodeMove(48, 56, 0, KIND.NORMAL), P).ok).toBe(false);
    expect(successor(s, encodeMove(48, 56, 5, KIND.NORMAL), P).ok).toBe(true);
  });

  it("offers, declines and accepts draws", () => {
    const s1 = step(initialState(ID, P), uci(initialState(ID, P), "e2e4", KIND.NORMAL_OFFER_DRAW));
    expect(statusOf(s1)).toBe(STATUS.DRAW_OFFERED);
    expect(statusOf(step(s1, uci(s1, "e7e5")))).toBe(STATUS.PLAYING);
    const d = step(s1, kind(KIND.ACCEPT_DRAW));
    expect(statusOf(d)).toBe(STATUS.DRAW);
    expect(isGameOver(d)).toBe(true);
    expect(d.board).toBe(s1.board);
    const plain = step(initialState(ID, P), uci(initialState(ID, P), "e2e4"));
    expect(successor(plain, kind(KIND.ACCEPT_DRAW), P).ok).toBe(false);
  });

  it("resignation moves the stake from the player on move", () => {
    const s1 = step(initialState(ID, P), uci(initialState(ID, P), "e2e4"));
    const r = step(s1, kind(KIND.RESIGN));
    expect(statusOf(r)).toBe(STATUS.WHITE_WON);
    expect([r.balanceA, r.balanceB]).toEqual([D + S, D - S]);
    expect(successor(r, uci(s1, "e7e5"), P).ok).toBe(false);
    expect(successor(r, kind(KIND.RESIGN), P).ok).toBe(false);
  });

  it("starts a new game only after a finished game, swapping colours", () => {
    const s1 = step(initialState(ID, P), uci(initialState(ID, P), "e2e4"));
    expect(successor(s1, kind(KIND.NEW_GAME), P).ok).toBe(false);
    const ng = step(step(s1, kind(KIND.RESIGN)), kind(KIND.NEW_GAME));
    expect(isCheckpoint(ng)).toBe(true);
    expect(ng.gameIndex).toBe(1);
    expect(fenOf(ng)).toBe("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1");
    expect(mover(ng)).toBe(1);
    const poor: Params = { ...P, deposit: S };
    const r = step(step(initialState(ID, poor), uci(initialState(ID, poor), "e2e4"), poor), kind(KIND.RESIGN), poor);
    expect(r.balanceB).toBe(0n);
    expect(successor(r, kind(KIND.NEW_GAME), poor).ok).toBe(false);
  });

  it("claims stalemate only in stalemate", () => {
    const st = at("7k/5Q2/6K1/8/8/8/8/8 b - - 0 21");
    expect(statusOf(step(st, kind(KIND.CLAIM_STALEMATE)))).toBe(STATUS.DRAW);
    expect(successor(initialState(ID, P), kind(KIND.CLAIM_STALEMATE), P).ok).toBe(false);
    const mated = at("7k/6Q1/6K1/8/8/8/8/8 b - - 0 21");
    expect(successor(mated, kind(KIND.CLAIM_STALEMATE), P).ok).toBe(false);
  });

  it("draws on insufficient material, the fifty-move rule and the ply cap", () => {
    const n = at("7k/8/8/4p3/8/5N2/8/K7 w - - 10 31");
    expect(statusOf(step(n, uci(n, "f3e5")))).toBe(STATUS.DRAW);
    const fifty = at("7k/8/8/8/3R4/8/8/K7 w - - 99 76");
    expect(statusOf(step(fifty, uci(fifty, "d4d5")))).toBe(STATUS.DRAW);
    const cap = at("7k/8/8/8/3R4/8/8/K7 w - - 0 150"); // ply 298
    const cap299 = step(cap, uci(cap, "d4d5")); // ply 299, black to move
    expect(statusOf(step(cap299, uci(cap299, "h8g8")))).toBe(STATUS.DRAW); // ply 300
  });

  it("scores a mate on the fifty-move limit as a win", () => {
    const s = at("7k/Q7/6K1/8/8/8/8/8 w - - 99 76");
    const w = step(s, uci(s, "a7g7"));
    expect(statusOf(w)).toBe(STATUS.WHITE_WON);
    expect([w.balanceA, w.balanceB]).toEqual([D + S, D - S]);
  });

  it("forfeits the player on move", () => {
    const s0 = initialState(ID, P);
    expect(forfeitBalances(s0, P)).toEqual([D - S, D + S]);
    expect(forfeitBalances(step(s0, uci(s0, "e2e4")), P)).toEqual([D + S, D - S]);
  });

  it("never accepts kind NONE or kinds 7-15", () => {
    const s0 = initialState(ID, P);
    expect(successor(s0, 0, P).ok).toBe(false);
    for (let k = 7; k < 16; k++) expect(successor(s0, kind(k), P).ok).toBe(false);
  });
});
