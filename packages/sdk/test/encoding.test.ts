import { describe, expect, it } from "vitest";
import {
  INITIAL_BOARD,
  INITIAL_META,
  KIND,
  NO_EP,
  PIECE,
  STATUS,
  decodeMove,
  encodeMove,
  fenToPosition,
  packMeta,
  pieceAt,
  positionToFen,
  setPiece,
  squareIndex,
  squareName,
  unpackMeta,
  withStatus,
} from "../src/index.js";

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

describe("encoding", () => {
  it("maps squares a1=0, h1=7, a8=56, h8=63 both ways", () => {
    expect([squareIndex("a1"), squareIndex("h1"), squareIndex("a8"), squareIndex("h8"), squareIndex("e4")]).toEqual([
      0, 7, 56, 63, 28,
    ]);
    expect([squareName(0), squareName(28), squareName(63)]).toEqual(["a1", "e4", "h8"]);
    expect(() => squareIndex("i9")).toThrow();
  });

  it("encodes the start position to the Solidity constants", () => {
    expect(fenToPosition(START)).toEqual({ board: INITIAL_BOARD, meta: INITIAL_META });
    expect(positionToFen(INITIAL_BOARD, INITIAL_META)).toBe(START);
  });

  it("reads and writes single squares", () => {
    expect(pieceAt(INITIAL_BOARD, squareIndex("e1"))).toBe(PIECE.KING);
    expect(pieceAt(INITIAL_BOARD, squareIndex("d8"))).toBe(PIECE.QUEEN | PIECE.BLACK);
    const b = setPiece(setPiece(INITIAL_BOARD, squareIndex("e2"), PIECE.EMPTY), squareIndex("e4"), PIECE.PAWN);
    expect(pieceAt(b, squareIndex("e2"))).toBe(PIECE.EMPTY);
    expect(pieceAt(b, squareIndex("e4"))).toBe(PIECE.PAWN);
    expect(pieceAt(b, squareIndex("d2"))).toBe(PIECE.PAWN);
  });

  it("packs meta at the documented offsets", () => {
    const m = { side: 1, castling: 9, ep: 43, halfmove: 77, ply: 301, status: STATUS.DRAW_OFFERED };
    const packed = packMeta(m);
    expect(packed).toBe(1n | (9n << 8n) | (43n << 16n) | (77n << 24n) | (301n << 40n) | (1n << 56n));
    expect(unpackMeta(packed)).toEqual(m);
    expect(unpackMeta(withStatus(packed, STATUS.WHITE_WON)).status).toBe(STATUS.WHITE_WON);
    expect(withStatus(withStatus(packed, STATUS.WHITE_WON), STATUS.DRAW_OFFERED)).toBe(packed);
  });

  it("encodes moves at the documented offsets", () => {
    const m = encodeMove(52, 60, PIECE.QUEEN, KIND.NORMAL_OFFER_DRAW);
    expect(m).toBe(52 | (60 << 6) | (5 << 12) | (2 << 15));
    expect(decodeMove(m)).toEqual({ from: 52, to: 60, promo: 5, kind: 2 });
    expect(encodeMove(0, 0, 0, KIND.NEW_GAME)).toBe(6 << 15);
  });

  it("round-trips FENs with side, castling, ep, halfmove and ply", () => {
    for (const fen of [
      START,
      "r3k2r/8/8/3pP3/8/8/8/R3K2R w Kq d6 7 20",
      "8/8/8/8/8/8/8/k6K b - - 0 5",
      "rnbqkbnr/ppp1p1pp/8/3pPp2/8/8/PPPP1PPP/RNBQKBNR w KQkq f6 0 3",
    ]) {
      const { board, meta } = fenToPosition(fen);
      expect(positionToFen(board, meta)).toBe(fen);
    }
    const { meta } = fenToPosition("r3k2r/8/8/3pP3/8/8/8/R3K2R w Kq d6 7 20");
    expect(unpackMeta(meta)).toEqual({ side: 0, castling: 9, ep: 43, halfmove: 7, ply: 38, status: STATUS.PLAYING });
  });

  it("writes no en-passant square for out-of-range ep values", () => {
    const meta = packMeta({ side: 0, castling: 0, ep: 64, halfmove: 0, ply: 0, status: 0 });
    expect(positionToFen(INITIAL_BOARD, meta).split(" ")[3]).toBe("-");
    expect(NO_EP).toBe(255);
  });
});
