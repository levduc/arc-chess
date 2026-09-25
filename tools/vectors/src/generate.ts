import { Chess } from "chess.js";
import { encodeAbiParameters } from "viem";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { encodeFen, squareIndex, PROMO } from "./encode.js";
import { CURATED_FENS } from "./curated.js";

const CHUNKS = 10; // must match ChessDifferentialTest
const GAMES = Number(process.env.VECTOR_GAMES ?? 60);
const SAMPLES_PER_GAME = Number(process.env.VECTOR_SAMPLES ?? 10);
const ILLEGAL_PER_POSITION = 12;
const SEED = Number(process.env.VECTOR_SEED ?? 20260924);
const OUT_DIR = resolve(import.meta.dirname, "../../../contracts/test/vectors");

const CASES_ABI = [
  {
    type: "tuple[]",
    components: [
      { name: "fen", type: "string" },
      { name: "board", type: "uint256" },
      { name: "meta", type: "uint256" },
      { name: "inCheck", type: "bool" },
      { name: "hasLegalMove", type: "bool" },
      { name: "insufficient", type: "bool" },
      {
        name: "legal",
        type: "tuple[]",
        components: [
          { name: "from", type: "uint8" },
          { name: "to", type: "uint8" },
          { name: "promo", type: "uint8" },
          { name: "board", type: "uint256" },
          { name: "side", type: "uint8" },
          { name: "castling", type: "uint8" },
          { name: "halfmove", type: "uint16" },
          { name: "ply", type: "uint16" },
        ],
      },
      {
        name: "illegal",
        type: "tuple[]",
        components: [
          { name: "from", type: "uint8" },
          { name: "to", type: "uint8" },
          { name: "promo", type: "uint8" },
        ],
      },
    ],
  },
] as const;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomGameFens(rand: () => number): string[] {
  const game = new Chess();
  const fens = [game.fen()];
  for (let i = 0; i < 250 && !game.isGameOver(); i++) {
    const moves = game.moves({ verbose: true });
    const m = moves[Math.floor(rand() * moves.length)];
    game.move({ from: m.from, to: m.to, promotion: m.promotion });
    fens.push(game.fen());
  }
  return fens;
}

function sample(fens: string[], rand: () => number): string[] {
  const picked = new Set<string>([fens[fens.length - 1]]); // always keep the final (often terminal) position
  while (picked.size < Math.min(SAMPLES_PER_GAME, fens.length)) {
    picked.add(fens[Math.floor(rand() * fens.length)]);
  }
  return [...picked];
}

function positionCase(fen: string, rand: () => number) {
  const game = new Chess(fen);
  const { board, meta } = encodeFen(fen);
  const moves = game.moves({ verbose: true });
  const legal = moves.map((m) => {
    const after = new Chess(fen);
    after.move({ from: m.from, to: m.to, promotion: m.promotion });
    const enc = encodeFen(after.fen());
    return {
      from: squareIndex(m.from),
      to: squareIndex(m.to),
      promo: m.promotion ? PROMO[m.promotion] : 0,
      board: enc.board,
      side: Number(enc.meta & 0xffn),
      castling: Number((enc.meta >> 8n) & 0xffn),
      halfmove: Number((enc.meta >> 24n) & 0xffffn),
      ply: Number((enc.meta >> 40n) & 0xffffn),
    };
  });
  const key = (f: number, t: number, p: number) => `${f}-${t}-${p}`;
  const legalKeys = new Set(legal.map((l) => key(l.from, l.to, l.promo)));
  const illegal: { from: number; to: number; promo: number }[] = [];

  // Wrong promotion variants of legal moves are the subtlest illegal inputs.
  for (const l of legal) {
    const variant = l.promo === 0 ? 5 : 0;
    if (!legalKeys.has(key(l.from, l.to, variant)) && rand() < 0.2) illegal.push({ from: l.from, to: l.to, promo: variant });
  }
  const ownSquares: number[] = [];
  const turnIsWhite = game.turn() === "w";
  for (let s = 0; s < 64; s++) {
    const piece = Number((board >> BigInt(s * 4)) & 0xfn);
    if (piece !== 0 && (piece & 8) === (turnIsWhite ? 0 : 8)) ownSquares.push(s);
  }
  let guard = 0;
  while (illegal.length < ILLEGAL_PER_POSITION && guard++ < 2000) {
    const from = rand() < 0.8 && ownSquares.length > 0 ? ownSquares[Math.floor(rand() * ownSquares.length)] : Math.floor(rand() * 64);
    const to = Math.floor(rand() * 64);
    const promo = rand() < 0.1 ? 2 + Math.floor(rand() * 4) : 0;
    if (!legalKeys.has(key(from, to, promo))) illegal.push({ from, to, promo });
  }
  return {
    fen,
    board,
    meta,
    inCheck: game.inCheck(),
    hasLegalMove: moves.length > 0,
    insufficient: game.isInsufficientMaterial(),
    legal,
    illegal,
  };
}

function main() {
  const rand = mulberry32(SEED);
  const fens = [...CURATED_FENS];
  for (let g = 0; g < GAMES; g++) fens.push(...sample(randomGameFens(rand), rand));
  const chunks: ReturnType<typeof positionCase>[][] = Array.from({ length: CHUNKS }, () => []);
  fens.forEach((fen, i) => chunks[i % CHUNKS].push(positionCase(fen, rand)));
  mkdirSync(OUT_DIR, { recursive: true });
  let moves = 0;
  chunks.forEach((cases, i) => {
    moves += cases.reduce((n, c) => n + c.legal.length + c.illegal.length, 0);
    writeFileSync(resolve(OUT_DIR, `chunk-${i}.hex`), encodeAbiParameters(CASES_ABI, [cases]));
  });
  console.log(`wrote ${fens.length} positions, ${moves} move checks, ${CHUNKS} chunks to ${OUT_DIR}`);
}

main();
