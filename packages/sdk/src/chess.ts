import { Chess } from "chess.js";
import type { Hex } from "viem";
import {
  FIFTY_MOVE_HALFMOVES,
  INITIAL_BOARD,
  INITIAL_META,
  KIND,
  MAX_PLY,
  NO_EP,
  PROMO,
  PROMO_LETTER,
  SIDE,
  STATUS,
  ZERO_HASH,
} from "./constants.js";
import {
  decodeMove,
  encodeMove,
  fenToPosition,
  packMeta,
  positionToFen,
  squareIndex,
  squareName,
  unpackMeta,
  withStatus,
  type Meta,
} from "./encoding.js";
import type { Params, PlayerIndex, State } from "./types.js";

/** Result of applying a move; mirrors ChessRules.successor (ok flag + canonical next state). */
export type Transition = { ok: true; next: State } | { ok: false; reason: string };

const UCI = /^([a-h][1-8])([a-h][1-8])([nbrq])?$/;

export function initialState(channelId: Hex, p: Params): State {
  return {
    channelId,
    turnNum: 0n,
    prevHash: ZERO_HASH,
    balanceA: p.deposit,
    balanceB: p.deposit,
    gameIndex: 0,
    move: 0,
    board: INITIAL_BOARD,
    meta: INITIAL_META,
  };
}

export function statusOf(s: State): number {
  return unpackMeta(s.meta).status;
}

export function isCheckpoint(s: State): boolean {
  return decodeMove(s.move).kind === KIND.NEW_GAME;
}

export function isGameOver(s: State): boolean {
  const st = statusOf(s);
  return st === STATUS.WHITE_WON || st === STATUS.BLACK_WON || st === STATUS.DRAW;
}

export function playerOnMove(gameIndex: number, meta: bigint): PlayerIndex {
  const white = (gameIndex % 2) as PlayerIndex;
  return unpackMeta(meta).side === SIDE.WHITE ? white : ((1 - white) as PlayerIndex);
}

/** The player who signs the move state that follows `prev`. */
export function mover(prev: State): PlayerIndex {
  return playerOnMove(prev.gameIndex, prev.meta);
}

export function forfeitBalances(s: State, p: Params): [bigint, bigint] {
  return shiftStake(s.balanceA, s.balanceB, mover(s), p.stakePerGame);
}

export function fenOf(s: State): string {
  return positionToFen(s.board, s.meta);
}

/** Legal moves for the side to move, as UCI strings (e.g. "e2e4", "a7a8q"). */
export function legalMoves(s: State): string[] {
  const game = load(s);
  if (!game) return [];
  return game.moves({ verbose: true }).map((m) => `${m.from}${m.to}${m.promotion ?? ""}`);
}

/** Encodes a UCI or SAN move for the side to move in `s`. Throws if it cannot be parsed. */
export function parseMove(s: State, input: string, kind: number = KIND.NORMAL): number {
  const trimmed = input.trim();
  const u = UCI.exec(trimmed);
  if (u) return encodeMove(squareIndex(u[1]), squareIndex(u[2]), u[3] ? PROMO[u[3]] : 0, kind);
  const game = load(s);
  if (!game) throw new Error("position cannot be loaded");
  try {
    const m = game.move(trimmed);
    return encodeMove(squareIndex(m.from), squareIndex(m.to), m.promotion ? PROMO[m.promotion] : 0, kind);
  } catch {
    throw new Error(`unrecognised or illegal move: ${input}`);
  }
}

/** Mirrors ChessRules.successor exactly (see contracts/src/chess/ChessRules.sol). */
export function successor(prev: State, move: number, p: Params): Transition {
  const next: State = { ...prev, turnNum: prev.turnNum + 1n, prevHash: ZERO_HASH, move };
  const { kind } = decodeMove(move);
  const st = statusOf(prev);
  const inProgress = st === STATUS.PLAYING || st === STATUS.DRAW_OFFERED;

  if (kind === KIND.NEW_GAME) {
    if (inProgress || move !== encodeMove(0, 0, 0, KIND.NEW_GAME)) return fail("new game only after a finished game");
    if (prev.balanceA < p.stakePerGame || prev.balanceB < p.stakePerGame) return fail("a balance is below the stake");
    return ok({ ...next, gameIndex: prev.gameIndex + 1, board: INITIAL_BOARD, meta: INITIAL_META });
  }
  if (!inProgress) return fail("the game is over");
  if (kind === KIND.NORMAL || kind === KIND.NORMAL_OFFER_DRAW) return normalMove(prev, move, kind, p, next);
  if (move !== encodeMove(0, 0, 0, kind)) return fail("non-canonical move encoding");
  if (kind === KIND.RESIGN) {
    const whiteResigns = unpackMeta(prev.meta).side === SIDE.WHITE;
    const [balanceA, balanceB] = shiftStake(prev.balanceA, prev.balanceB, mover(prev), p.stakePerGame);
    return ok({
      ...next,
      meta: withStatus(prev.meta, whiteResigns ? STATUS.BLACK_WON : STATUS.WHITE_WON),
      balanceA,
      balanceB,
    });
  }
  if (kind === KIND.ACCEPT_DRAW) {
    if (st !== STATUS.DRAW_OFFERED) return fail("no draw offer to accept");
    return ok({ ...next, meta: withStatus(prev.meta, STATUS.DRAW) });
  }
  if (kind === KIND.CLAIM_STALEMATE) {
    const game = load(prev);
    if (!game || game.inCheck() || game.moves().length > 0) return fail("not a stalemate");
    return ok({ ...next, meta: withStatus(prev.meta, STATUS.DRAW) });
  }
  return fail("unknown move kind");
}

function normalMove(prev: State, move: number, kind: number, p: Params, next: State): Transition {
  const { from, to, promo } = decodeMove(move);
  if (move !== encodeMove(from, to, promo, kind)) return fail("non-canonical move encoding");
  if (promo === 1 || promo > 5) return fail("bad promotion piece");
  const game = load(prev);
  if (!game) return fail("position cannot be loaded");
  let played;
  try {
    played = game.move({ from: squareName(from), to: squareName(to), ...(promo ? { promotion: PROMO_LETTER[promo] } : {}) });
  } catch {
    return fail("illegal move");
  }
  // chess.js ignores a promotion suffix on a non-promotion move; the contract rejects it.
  if ((promo !== 0) !== (played.promotion !== undefined)) return fail("promotion does not match the move");

  const prevMeta = unpackMeta(prev.meta);
  const afterMeta = unpackMeta(fenToPosition(game.fen()).meta);
  const meta: Meta = {
    side: prevMeta.side === SIDE.WHITE ? SIDE.BLACK : SIDE.WHITE,
    castling: afterMeta.castling,
    // The contract always records the skipped square after a double push; chess.js omits it when no capture exists.
    ep: played.flags.includes("b") ? (from + to) / 2 : NO_EP,
    halfmove: afterMeta.halfmove,
    ply: prevMeta.ply + 1,
    status: kind === KIND.NORMAL_OFFER_DRAW ? STATUS.DRAW_OFFERED : STATUS.PLAYING,
  };
  let { balanceA, balanceB } = prev;
  if (game.isInsufficientMaterial()) {
    meta.status = STATUS.DRAW;
  } else if (meta.halfmove >= FIFTY_MOVE_HALFMOVES || meta.ply >= MAX_PLY) {
    // A checkmate delivered by the limiting move still wins; otherwise the game is drawn.
    if (game.inCheck() && game.moves().length === 0) {
      meta.status = prevMeta.side === SIDE.WHITE ? STATUS.WHITE_WON : STATUS.BLACK_WON;
      [balanceA, balanceB] = shiftStake(prev.balanceA, prev.balanceB, playerOnMove(prev.gameIndex, packMeta(meta)), p.stakePerGame);
    } else {
      meta.status = STATUS.DRAW;
    }
  }
  return ok({ ...next, board: fenToPosition(game.fen()).board, meta: packMeta(meta), balanceA, balanceB });
}

function load(s: State): Chess | null {
  try {
    return new Chess(positionToFen(s.board, s.meta));
  } catch {
    return null;
  }
}

function shiftStake(a: bigint, b: bigint, loser: PlayerIndex, stake: bigint): [bigint, bigint] {
  if (loser === 0) {
    const x = stake < a ? stake : a;
    return [a - x, b + x];
  }
  const y = stake < b ? stake : b;
  return [a + y, b - y];
}

function ok(next: State): Transition {
  return { ok: true, next };
}

function fail(reason: string): Transition {
  return { ok: false, reason };
}
