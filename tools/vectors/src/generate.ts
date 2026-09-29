import { Chess } from "chess.js";
import { encodeAbiParameters } from "viem";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import {
  STATUS,
  FIFTY_MOVE_HALFMOVES,
  MAX_PLY,
  KIND,
  ZERO_HASH,
  encodeMove,
  unpackMeta,
  successor as sdkSuccessor,
  type Params as SdkParams,
  type State as SdkState,
} from "@arena/sdk";
import { encodeFen, squareIndex, PROMO } from "./encode.js";
import { CURATED_FENS } from "./curated.js";

const DEEP = process.argv.includes("--deep");
const FORCE = process.argv.includes("--force");

// Default (CI) mode: unchanged in size (only the curated set grew, by design; see task-5-report.md).
const CHUNKS = 10; // must match ChessDifferentialTest's test_chunk0..9
const GAMES = Number(process.env.VECTOR_GAMES ?? (DEEP ? 20_000 : 60));
const SAMPLES_PER_GAME = Number(process.env.VECTOR_SAMPLES ?? (DEEP ? 1 : 10));
// Deep mode samples a large fraction of its 20,000 games (biased toward each game's final position) so it
// gathers >=10,000 positions in reasonable time; see task-5-report.md for the size/timing this produces and
// for why this is now well over the tool's earlier ~50MB rule of thumb (flagged there for the controller).
const DEEP_KEEP_PROB = Number(process.env.VECTOR_KEEP_PROB ?? (DEEP ? 0.55 : 1));
// Random games almost never end on their own (checkmate/stalemate/insufficient material/repetition/50-move
// are all rare under uniformly-random move choice) and instead run to this artificial cap. It only bounds how
// far a *single simulated game* wanders — real on-chain games are still capped at MAX_PLY (300) by ChessRules
// regardless of this constant. Deep mode uses a much smaller cap than the default/CI set purely for
// throughput: see task-5-report.md's profiling (chess.js's per-ply legal-move generation, not position
// analysis, is the dominant cost of `pnpm vectors:deep`, so fewer plies per game is the lever that matters).
const GAME_PLY_CAP = Number(process.env.VECTOR_MAX_PLIES ?? (DEEP ? 90 : 250));
const DEEP_POSITIONS_PER_CHUNK = 150;
// ChessDifferentialDeepTest (contracts/test/ChessDifferentialDeep.t.sol) declares exactly 200 test_chunkN
// functions (test_chunk0..test_chunk199), one per chunk so each gets its own gas/memory budget. If deep mode
// ever produced more chunks than that, the extra ones would silently go unchecked, so writeDeep() throws
// instead. Keep this in sync with that file's function count if it's ever regenerated with more/larger chunks.
const DEEP_CHUNK_CEILING = 200;
const ILLEGAL_PER_POSITION = 12;
const SEED = Number(process.env.VECTOR_SEED ?? 20260924);
const OUT_DIR = resolve(import.meta.dirname, `../../../contracts/test/${DEEP ? "vectors-deep" : "vectors"}`);
const STAMP_PATH = resolve(OUT_DIR, ".generation-stamp.json");
const SDK_SRC_DIR = resolve(import.meta.dirname, "../../../packages/sdk/src");

/**
 * Deep generation is slow (20,000 random games, ~13 minutes; see task-5-report.md), so `pnpm vectors:deep`
 * caches its output: a stamp file records a hash of the generator sources (this package, plus the `@arena/sdk`
 * modules it calls into for the three-way status check below) plus the parameters that affect the output
 * (seed, game count, sampling). Re-running with the same sources and parameters is a no-op unless `--force`
 * is passed. Only deep mode caches — the default/CI set is fast enough that it isn't worth it, and
 * `pnpm test:contracts` should always reflect the current sources.
 */
function generationFingerprint(): string {
  const sources = [
    ...["generate.ts", "curated.ts", "encode.ts"].map((f) => resolve(import.meta.dirname, f)),
    ...["constants.ts", "encoding.ts", "chess.ts"].map((f) => resolve(SDK_SRC_DIR, f)),
  ]
    .map((f) => readFileSync(f, "utf8"))
    .join("\0");
  const params = JSON.stringify({
    SEED,
    GAMES,
    SAMPLES_PER_GAME,
    DEEP_KEEP_PROB,
    GAME_PLY_CAP,
    ILLEGAL_PER_POSITION,
    DEEP_POSITIONS_PER_CHUNK,
  });
  return createHash("sha256").update(sources).update("\0").update(params).digest("hex");
}

function cachedGenerationIsFresh(fingerprint: string): boolean {
  if (!existsSync(STAMP_PATH)) return false;
  try {
    const stamp = JSON.parse(readFileSync(STAMP_PATH, "utf8"));
    return stamp.fingerprint === fingerprint && existsSync(resolve(OUT_DIR, "chunk-0.hex"));
  } catch {
    return false;
  }
}

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
          // Status ChessRules.successor would record for this move played as KIND_NORMAL: PLAYING unless
          // insufficient material, or the fifty-move/ply cap is hit (draw, or win if it's also checkmate).
          { name: "status", type: "uint8" },
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
  // `moves()` (SAN strings) is used instead of `moves({ verbose: true })`: chess.js's verbose Move objects
  // eagerly compute a before/after FEN and long-algebraic form for *every candidate move*, not just the one
  // played, which measured ~5-6x slower per ply for no benefit here (only the resulting FEN after the played
  // move is ever used) — see task-5-report.md's profiling.
  for (let i = 0; i < GAME_PLY_CAP && !game.isGameOver(); i++) {
    const moves = game.moves();
    const san = moves[Math.floor(rand() * moves.length)];
    game.move(san);
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

/** The status ChessRules.successor would record after playing this move as KIND_NORMAL from `fen`. */
function statusAfter(after: Chess, moverWasWhite: boolean): number {
  if (after.isInsufficientMaterial()) return STATUS.DRAW;
  const { meta } = encodeFen(after.fen());
  const halfmove = Number((meta >> 24n) & 0xffffn);
  const ply = Number((meta >> 40n) & 0xffffn);
  if (halfmove >= FIFTY_MOVE_HALFMOVES || ply >= MAX_PLY) {
    // The side that just moved delivered mate and wins outright; otherwise the limit draws the game.
    if (after.inCheck() && after.moves().length === 0) return moverWasWhite ? STATUS.WHITE_WON : STATUS.BLACK_WON;
    return STATUS.DRAW;
  }
  return STATUS.PLAYING;
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;
// Only board/meta and the move matter for the status oracle below; balances just need to be large enough that
// NEW_GAME's stake check (irrelevant here — every call below plays KIND.NORMAL) could never be the reason a
// move is rejected. Mirrors the Params ChessDifferentialBase.sol's tests construct.
const SDK_PARAMS: SdkParams = {
  participants: [ZERO_ADDRESS, ZERO_ADDRESS],
  signers: [ZERO_ADDRESS, ZERO_ADDRESS],
  rules: ZERO_ADDRESS,
  feeRecipient: ZERO_ADDRESS,
  feePerPlayer: 0n,
  deposit: (1n << 128n) - 1n,
  stakePerGame: 1n,
  challengeTimeout: 0n,
  fundingDeadline: 0n,
  salt: ZERO_HASH,
};

/**
 * The status `@arena/sdk`'s `successor()` records after playing this move as KIND_NORMAL from (board, meta).
 * This is a second, independent-of-chess.js-internals oracle for the same fact `statusAfter` computes above
 * (per the task-5 ruling): `statusAfter` is built from chess.js primitives plus the protocol's own limit
 * constants, while this one runs the actual `successor()` the SDK ships (which itself mirrors
 * ChessRules.sol). Callers compare the two and throw on disagreement — see `positionCase`.
 */
function sdkStatusAfter(board: bigint, meta: bigint, from: number, to: number, promo: number): number {
  const prev: SdkState = {
    channelId: ZERO_HASH,
    turnNum: 0n,
    prevHash: ZERO_HASH,
    balanceA: SDK_PARAMS.deposit,
    balanceB: SDK_PARAMS.deposit,
    gameIndex: 0,
    move: 0,
    board,
    meta,
  };
  const t = sdkSuccessor(prev, encodeMove(from, to, promo, KIND.NORMAL), SDK_PARAMS);
  if (!t.ok) throw new Error(`__SDK_REJECTED__:${t.reason}`);
  return unpackMeta(t.next.meta).status;
}

function positionCase(fen: string, rand: () => number) {
  const game = new Chess(fen);
  const { board, meta } = encodeFen(fen);
  const moves = game.moves({ verbose: true });
  const turnIsWhite = game.turn() === "w";
  const legal = moves.map((m) => {
    const after = new Chess(fen);
    after.move({ from: m.from, to: m.to, promotion: m.promotion });
    const enc = encodeFen(after.fen());
    const from = squareIndex(m.from);
    const to = squareIndex(m.to);
    const promo = m.promotion ? PROMO[m.promotion] : 0;
    const uci = `${m.from}${m.to}${m.promotion ?? ""}`;
    const chessJsStatus = statusAfter(after, turnIsWhite);
    let sdkStatus: number;
    try {
      sdkStatus = sdkStatusAfter(board, meta, from, to, promo);
    } catch (e) {
      const reason = e instanceof Error ? e.message.replace(/^__SDK_REJECTED__:/, "") : String(e);
      throw new Error(
        `three-way status oracle disagreement at ${fen} for move ${uci}: chess.js says the move is legal ` +
          `with status ${chessJsStatus}, but @arena/sdk's successor() rejected it: ${reason}`,
      );
    }
    if (sdkStatus !== chessJsStatus) {
      throw new Error(
        `three-way status oracle disagreement at ${fen} for move ${uci}: chess.js says status ${chessJsStatus}, ` +
          `@arena/sdk's successor() says status ${sdkStatus}`,
      );
    }
    return {
      from,
      to,
      promo,
      board: enc.board,
      side: Number(enc.meta & 0xffn),
      castling: Number((enc.meta >> 8n) & 0xffn),
      halfmove: Number((enc.meta >> 24n) & 0xffffn),
      ply: Number((enc.meta >> 40n) & 0xffffn),
      status: chessJsStatus,
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

/**
 * A hand-authored FEN can accidentally describe an impossible position (e.g. the side NOT to move already
 * in check), which chess.js does not validate on load. Its move generator then offers a "capture" of that
 * king, a pseudo-move no real ChessRules/chess.js disagreement test should ever see. Catch that here instead
 * of shipping it as a false differential mismatch.
 */
function assertNoCuratedFenCapturesAKing(): void {
  for (const fen of CURATED_FENS) {
    const bad = new Chess(fen).moves({ verbose: true }).filter((m) => m.captured === "k" || m.captured === "K");
    if (bad.length > 0) {
      throw new Error(`curated FEN describes an impossible position (a king is capturable): ${fen} -> ${bad.map((m) => m.san).join(", ")}`);
    }
  }
}

function collectFens(rand: () => number): string[] {
  assertNoCuratedFenCapturesAKing();
  const fens = [...CURATED_FENS];
  for (let g = 0; g < GAMES; g++) {
    const gameFens = randomGameFens(rand);
    if (DEEP && rand() >= DEEP_KEEP_PROB) continue; // deep mode: sample a fraction of games to bound file size
    fens.push(...sample(gameFens, rand));
  }
  return fens;
}

function writeDefault(cases: ReturnType<typeof positionCase>[]) {
  const chunks: ReturnType<typeof positionCase>[][] = Array.from({ length: CHUNKS }, () => []);
  cases.forEach((c, i) => chunks[i % CHUNKS].push(c));
  chunks.forEach((chunk, i) => writeFileSync(resolve(OUT_DIR, `chunk-${i}.hex`), encodeAbiParameters(CASES_ABI, [chunk])));
  return chunks.length;
}

function writeDeep(cases: ReturnType<typeof positionCase>[]) {
  const chunkCount = Math.max(1, Math.ceil(cases.length / DEEP_POSITIONS_PER_CHUNK));
  if (chunkCount > DEEP_CHUNK_CEILING) {
    throw new Error(
      `deep vectors would need ${chunkCount} chunks, but ChessDifferentialDeepTest only defines ` +
        `test_chunk0..test_chunk${DEEP_CHUNK_CEILING - 1} (DEEP_CHUNK_CEILING=${DEEP_CHUNK_CEILING}). ` +
        `Raise DEEP_POSITIONS_PER_CHUNK, lower the position target, or add more test_chunkN functions to ` +
        `contracts/test/ChessDifferentialDeep.t.sol and bump DEEP_CHUNK_CEILING to match.`,
    );
  }
  for (let i = 0; i < chunkCount; i++) {
    const chunk = cases.slice(i * DEEP_POSITIONS_PER_CHUNK, (i + 1) * DEEP_POSITIONS_PER_CHUNK);
    writeFileSync(resolve(OUT_DIR, `chunk-${i}.hex`), encodeAbiParameters(CASES_ABI, [chunk]));
  }
  return chunkCount;
}

function main() {
  if (DEEP && !FORCE) {
    const fingerprint = generationFingerprint();
    if (cachedGenerationIsFresh(fingerprint)) {
      const stamp = JSON.parse(readFileSync(STAMP_PATH, "utf8"));
      console.log(
        `deep vectors already up to date (cached ${stamp.generatedAt}): ${stamp.positions} positions, ` +
          `${stamp.moves} move checks, ${stamp.chunks} chunks, ${stamp.bytes} bytes in ${OUT_DIR}. ` +
          `Pass --force to regenerate.`,
      );
      return;
    }
  }

  mkdirSync(OUT_DIR, { recursive: true });
  // Clear any stale chunk files from a previous run before writing (deep mode's chunk count is dynamic).
  for (const f of readdirSync(OUT_DIR)) {
    if (/^chunk-\d+\.hex$/.test(f)) rmSync(resolve(OUT_DIR, f));
  }

  const rand = mulberry32(SEED);
  const fens = collectFens(rand);
  const cases = fens.map((fen) => positionCase(fen, rand));
  const chunkCount = DEEP ? writeDeep(cases) : writeDefault(cases);
  const moves = cases.reduce((n, c) => n + c.legal.length + c.illegal.length, 0);
  let totalBytes = 0;
  for (let i = 0; i < chunkCount; i++) totalBytes += statSync(resolve(OUT_DIR, `chunk-${i}.hex`)).size;
  console.log(
    `wrote ${fens.length} positions, ${moves} move checks, ${chunkCount} chunks, ${totalBytes} bytes to ${OUT_DIR}`,
  );

  if (DEEP) {
    writeFileSync(
      STAMP_PATH,
      JSON.stringify(
        {
          fingerprint: generationFingerprint(),
          generatedAt: new Date().toISOString(),
          positions: fens.length,
          moves,
          chunks: chunkCount,
          bytes: totalBytes,
        },
        null,
        2,
      ),
    );
  }
}

main();
