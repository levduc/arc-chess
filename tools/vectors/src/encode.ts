// FEN → the packed (board, meta) encoding defined in the contracts plan's Global Constraints.
export const PIECE: Record<string, number> = {
  P: 1, N: 2, B: 3, R: 4, Q: 5, K: 6,
  p: 9, n: 10, b: 11, r: 12, q: 13, k: 14,
};

export const PROMO: Record<string, number> = { n: 2, b: 3, r: 4, q: 5 };

export const INITIAL_BOARD = 0xcabedbac99999999000000000000000000000000000000001111111142365324n;
export const INITIAL_META = 0xff0f00n;

export function squareIndex(sq: string): number {
  return sq.charCodeAt(0) - 97 + (sq.charCodeAt(1) - 49) * 8;
}

export function encodeFen(fen: string): { board: bigint; meta: bigint } {
  const [placement, side, castling, ep, half, full] = fen.split(" ");
  let board = 0n;
  placement.split("/").forEach((row, i) => {
    const rank = 7 - i;
    let file = 0;
    for (const ch of row) {
      if (ch >= "1" && ch <= "8") {
        file += Number(ch);
      } else {
        board |= BigInt(PIECE[ch]) << BigInt((rank * 8 + file) * 4);
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
  const epSq = ep === "-" ? 255 : squareIndex(ep);
  const ply = (Number(full) - 1) * 2 + sideN;
  const meta =
    BigInt(sideN) |
    (BigInt(rights) << 8n) |
    (BigInt(epSq) << 16n) |
    (BigInt(Number(half)) << 24n) |
    (BigInt(ply) << 40n);
  return { board, meta };
}
