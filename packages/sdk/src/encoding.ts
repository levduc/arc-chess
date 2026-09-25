import { NO_EP, PIECE } from "./constants.js";

export type Meta = { side: number; castling: number; ep: number; halfmove: number; ply: number; status: number };
export type DecodedMove = { from: number; to: number; promo: number; kind: number };

const FEN_PIECE: Record<string, number> = {
  P: 1, N: 2, B: 3, R: 4, Q: 5, K: 6,
  p: 9, n: 10, b: 11, r: 12, q: 13, k: 14,
};
const PIECE_FEN = ".PNBRQK..pnbrqk.";

export function pieceAt(board: bigint, sq: number): number {
  return Number((board >> BigInt(sq * 4)) & 0xfn);
}

export function setPiece(board: bigint, sq: number, piece: number): bigint {
  const shift = BigInt(sq * 4);
  return (board & ~(0xfn << shift)) | (BigInt(piece) << shift);
}

export function unpackMeta(meta: bigint): Meta {
  return {
    side: Number(meta & 0xffn),
    castling: Number((meta >> 8n) & 0xffn),
    ep: Number((meta >> 16n) & 0xffn),
    halfmove: Number((meta >> 24n) & 0xffffn),
    ply: Number((meta >> 40n) & 0xffffn),
    status: Number((meta >> 56n) & 0xffn),
  };
}

export function packMeta(m: Meta): bigint {
  return (
    BigInt(m.side) |
    (BigInt(m.castling) << 8n) |
    (BigInt(m.ep) << 16n) |
    (BigInt(m.halfmove) << 24n) |
    (BigInt(m.ply) << 40n) |
    (BigInt(m.status) << 56n)
  );
}

export function withStatus(meta: bigint, status: number): bigint {
  return (meta & ~(0xffn << 56n)) | (BigInt(status) << 56n);
}

export function encodeMove(from: number, to: number, promo: number, kind: number): number {
  return (from | (to << 6) | (promo << 12) | (kind << 15)) >>> 0;
}

export function decodeMove(m: number): DecodedMove {
  return { from: m & 63, to: (m >>> 6) & 63, promo: (m >>> 12) & 7, kind: (m >>> 15) & 15 };
}

export function squareIndex(sq: string): number {
  if (!/^[a-h][1-8]$/.test(sq)) throw new Error(`not a square: ${sq}`);
  return sq.charCodeAt(0) - 97 + (sq.charCodeAt(1) - 49) * 8;
}

export function squareName(i: number): string {
  if (!Number.isInteger(i) || i < 0 || i > 63) throw new Error(`not a square index: ${i}`);
  return String.fromCharCode(97 + (i % 8)) + String.fromCharCode(49 + Math.floor(i / 8));
}

/** FEN → packed (board, meta) with status PLAYING; ply = (fullmove - 1) * 2 + side. */
export function fenToPosition(fen: string): { board: bigint; meta: bigint } {
  const [placement, side, castling, ep, half, full] = fen.split(" ");
  let board = 0n;
  placement.split("/").forEach((row, i) => {
    const rank = 7 - i;
    let file = 0;
    for (const ch of row) {
      if (ch >= "1" && ch <= "8") {
        file += Number(ch);
      } else {
        board |= BigInt(FEN_PIECE[ch]) << BigInt((rank * 8 + file) * 4);
        file++;
      }
    }
  });
  let rights = 0;
  if (castling.includes("K")) rights |= 1;
  if (castling.includes("Q")) rights |= 2;
  if (castling.includes("k")) rights |= 4;
  if (castling.includes("q")) rights |= 8;
  const sideN = side === "w" ? 0 : 1;
  const epSq = ep === "-" ? NO_EP : squareIndex(ep);
  const ply = (Number(full) - 1) * 2 + sideN;
  const meta =
    BigInt(sideN) |
    (BigInt(rights) << 8n) |
    (BigInt(epSq) << 16n) |
    (BigInt(Number(half)) << 24n) |
    (BigInt(ply) << 40n);
  return { board, meta };
}

/** Packed (board, meta) → FEN; fullmove = floor(ply / 2) + 1. */
export function positionToFen(board: bigint, meta: bigint): string {
  const m = unpackMeta(meta);
  const rows: string[] = [];
  for (let rank = 7; rank >= 0; rank--) {
    let row = "";
    let empty = 0;
    for (let file = 0; file < 8; file++) {
      const piece = pieceAt(board, rank * 8 + file);
      if (piece === PIECE.EMPTY) {
        empty++;
        continue;
      }
      if (empty > 0) {
        row += String(empty);
        empty = 0;
      }
      row += PIECE_FEN[piece];
    }
    if (empty > 0) row += String(empty);
    rows.push(row);
  }
  let castling = "";
  if (m.castling & 1) castling += "K";
  if (m.castling & 2) castling += "Q";
  if (m.castling & 4) castling += "k";
  if (m.castling & 8) castling += "q";
  const ep = m.ep < 64 ? squareName(m.ep) : "-";
  return `${rows.join("/")} ${m.side === 0 ? "w" : "b"} ${castling || "-"} ${ep} ${m.halfmove} ${Math.floor(m.ply / 2) + 1}`;
}
