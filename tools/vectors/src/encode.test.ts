import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeFen, squareIndex, INITIAL_BOARD, INITIAL_META } from "./encode.js";

test("squareIndex maps a1=0, h1=7, a8=56, h8=63", () => {
  assert.equal(squareIndex("a1"), 0);
  assert.equal(squareIndex("h1"), 7);
  assert.equal(squareIndex("a8"), 56);
  assert.equal(squareIndex("h8"), 63);
  assert.equal(squareIndex("e4"), 28);
});

test("start position encodes to the Solidity constants", () => {
  const { board, meta } = encodeFen("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1");
  assert.equal(board, INITIAL_BOARD);
  assert.equal(meta, INITIAL_META);
});

test("side, castling, ep, halfmove and ply are packed at the documented offsets", () => {
  const { meta } = encodeFen("r3k2r/8/8/3pP3/8/8/8/R3K2R w Kq d6 7 20");
  // side w=0, castling K|q = 1|8 = 9, ep d6 = 43, halfmove 7, ply (20-1)*2+0 = 38
  assert.equal(meta, (9n << 8n) | (43n << 16n) | (7n << 24n) | (38n << 40n));
  const black = encodeFen("8/8/8/8/8/8/8/k6K b - - 0 5").meta;
  assert.equal(black & 0xffn, 1n);
  assert.equal((black >> 40n) & 0xffffn, 9n);
  assert.equal((black >> 16n) & 0xffn, 255n);
});
