import type { Hex } from "viem";

export const PIECE = { EMPTY: 0, PAWN: 1, KNIGHT: 2, BISHOP: 3, ROOK: 4, QUEEN: 5, KING: 6, BLACK: 8 } as const;
export const SIDE = { WHITE: 0, BLACK: 1 } as const;
export const STATUS = { PLAYING: 0, DRAW_OFFERED: 1, WHITE_WON: 2, BLACK_WON: 3, DRAW: 4 } as const;
export const KIND = {
  NONE: 0,
  NORMAL: 1,
  NORMAL_OFFER_DRAW: 2,
  RESIGN: 3,
  ACCEPT_DRAW: 4,
  CLAIM_STALEMATE: 5,
  NEW_GAME: 6,
} as const;

/** Promotion letter (UCI / chess.js) → piece type code. */
export const PROMO: Record<string, number> = { n: 2, b: 3, r: 4, q: 5 };
/** Piece type code → promotion letter; index 0 and 1 are not promotions. */
export const PROMO_LETTER = ["", "", "n", "b", "r", "q"] as const;

export const NO_EP = 255;
export const INITIAL_BOARD = 0xcabedbac99999999000000000000000000000000000000001111111142365324n;
export const INITIAL_META = 0xff0f00n;
export const MAX_PLY = 300;
export const FIFTY_MOVE_HALFMOVES = 100;
export const ZERO_HASH: Hex = `0x${"00".repeat(32)}`;
