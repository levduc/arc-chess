/** Move-driving helpers for system tests. Everything goes through `Player.api`, i.e. the daemon's local HTTP
 *  API -- the same surface an agent (or a human via `arena move`) uses. Nothing here reaches into daemon
 *  internals. */
import type { Hex } from "viem";
import type { Player } from "./harness.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export type Status = {
  channelId: Hex;
  phase: string;
  myTurn: boolean;
  turnNum: string;
  gameStatus: "playing" | "draw_offered" | "white_won" | "black_won" | "draw";
  legalMoves: string[];
  attention: string | null;
  [key: string]: unknown;
};

function statusPath(channelId?: Hex): string {
  return channelId ? `/status?channel=${channelId}` : "/status";
}

/** Polls `player`'s `/status` until `predicate` is true, or throws (with the last status seen) after `ms`. */
export async function waitStatus(
  player: Player,
  predicate: (s: Status) => boolean,
  ms = 20_000,
  channelId?: Hex,
): Promise<Status> {
  const end = Date.now() + ms;
  let last: Status | undefined;
  while (Date.now() < end) {
    last = (await player.api("GET", statusPath(channelId))) as Status;
    if (predicate(last)) return last;
    await sleep(100);
  }
  throw new Error(`waitStatus timed out after ${ms}ms; last status: ${JSON.stringify(last)}`);
}

/** Plays an exact sequence of moves, alternating between `white` and `black` based on whose turn it actually is
 *  (so it also works mid-game, e.g. after a restart). Waits for each move to reach the other side before sending
 *  the next one. */
export async function playLine(white: Player, black: Player, channelId: Hex, moves: string[], ms = 10_000): Promise<void> {
  for (const m of moves) {
    const whiteStatus = (await white.api("GET", statusPath(channelId))) as Status;
    const [mover, other] = whiteStatus.myTurn ? [white, black] : [black, white];
    const moverStatus = (await mover.api("POST", "/move", { move: m, channel: channelId })) as Status;
    await waitStatus(other, (s) => s.turnNum === moverStatus.turnNum || s.gameStatus !== "playing", ms, channelId);
  }
}

/** Deterministic PRNG (mulberry32), copied from packages/sdk/test/helpers/fixtures.ts, so random games are
 *  reproducible from a seed without depending on the sdk package's test helpers at runtime. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Plays uniformly-random legal moves from `white`'s and `black`'s own `legalMoves` until the game ends (or
 *  `maxMoves` half-moves have been played, as a safety valve against a rules bug that never ends a game). */
export async function playRandomGame(
  white: Player,
  black: Player,
  opts: { channelId: Hex; seed?: number; maxMoves?: number; ms?: number },
): Promise<Status> {
  const rand = mulberry32(opts.seed ?? 1);
  const maxMoves = opts.maxMoves ?? 300;
  const ms = opts.ms ?? 10_000;
  for (let i = 0; i < maxMoves; i++) {
    const whiteStatus = (await white.api("GET", statusPath(opts.channelId))) as Status;
    if (whiteStatus.gameStatus !== "playing" && whiteStatus.gameStatus !== "draw_offered") return whiteStatus;
    const [mover, other] = whiteStatus.myTurn ? [white, black] : [black, white];
    const moverStatus = whiteStatus.myTurn ? whiteStatus : ((await black.api("GET", statusPath(opts.channelId))) as Status);
    if (moverStatus.legalMoves.length === 0) return moverStatus;
    const move = moverStatus.legalMoves[Math.floor(rand() * moverStatus.legalMoves.length)];
    const resultStatus = (await mover.api("POST", "/move", { move, channel: opts.channelId })) as Status;
    if (resultStatus.gameStatus !== "playing" && resultStatus.gameStatus !== "draw_offered") return resultStatus;
    await waitStatus(other, (s) => s.turnNum === resultStatus.turnNum || s.gameStatus !== "playing", ms, opts.channelId);
  }
  throw new Error(`playRandomGame: game did not end within ${maxMoves} half-moves`);
}
