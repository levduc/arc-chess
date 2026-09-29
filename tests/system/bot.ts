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

/** Plan 4.5 Task 11: right after a match, the accepter's own daemon has already created its channel record (that's
 *  how its channel id was found), but the offerer's daemon learns of the match asynchronously (a lobby event
 *  delivered over its host connection, processed by `onMatch`) -- so a `/status` poll can land in the brief window
 *  before the record exists, which the API reports as a 404 "unknown channel". That is a transient "not ready yet",
 *  not a real failure, so it is retried like a false predicate, but only for a short grace window (see
 *  UNKNOWN_CHANNEL_GRACE_MS) -- a benign async-delivery window is sub-second in practice. Anything else (a killed
 *  daemon refusing the connection, a 500, a malformed response) still fails immediately -- unlike a missing-channel
 *  race, those never resolve themselves.
 *
 *  Correction (found during Task 11 review, see scratchpad/review-task11.md): a first version of this comment, and
 *  soak.ts's OP_TIMEOUT_MS/ws-frame-limit changes made alongside it, attributed a much longer version of this same
 *  404 (tens of seconds to minutes) to load contention -- GC pauses, Anvil/RPC saturation, event-loop lag, or the
 *  server's ws-frame rate limit. That was wrong. The real cause was a daemon bug (now fixed, packages/cli/src/
 *  daemon.ts's onMatch): a matched offer was never unwatched, so a long-lived daemon's host connection eventually
 *  hit the server's per-connection watch-slot cap (`maxWatchedOffers`, default 256) and permanently stopped
 *  learning of new matches as an offerer -- a silent, one-way liveness failure, not a transient delay. Once that
 *  leak is fixed, this grace window only ever needs to cover the genuine, brief async-delivery race described
 *  above. */
function isUnknownChannelError(err: unknown): boolean {
  return err instanceof Error && /-> 404: unknown channel/.test(err.message);
}

/** How long a persistent "unknown channel" 404 is tolerated as "not ready yet" before it is treated as a real
 *  failure. Deliberately short: with the watched-offer leak fixed (see isUnknownChannelError's docstring), a
 *  match's delivery to the offerer is sub-second in practice, so a 404 that outlives this window is a genuine bug,
 *  not load -- and a short window here means such a bug fails fast and loud instead of silently eating the
 *  caller's whole `ms` budget (which is how the leak went unnoticed in the first place: a 20-90s `ms` made a
 *  permanently-broken match look like "still waiting", not "stalled"). */
const UNKNOWN_CHANNEL_GRACE_MS = 10_000;

/** Polls `player`'s `/status` until `predicate` is true, or throws (with the last status/error seen) after `ms`. */
export async function waitStatus(
  player: Player,
  predicate: (s: Status) => boolean,
  ms = 20_000,
  channelId?: Hex,
): Promise<Status> {
  const end = Date.now() + ms;
  let last: Status | undefined;
  let lastErr: unknown;
  let unknownSince: number | null = null;
  while (Date.now() < end) {
    try {
      last = (await player.api("GET", statusPath(channelId))) as Status;
      lastErr = undefined;
      unknownSince = null;
      if (predicate(last)) return last;
    } catch (err) {
      if (!isUnknownChannelError(err)) throw err;
      lastErr = err;
      unknownSince ??= Date.now();
      if (Date.now() - unknownSince > UNKNOWN_CHANNEL_GRACE_MS) throw err;
    }
    await sleep(100);
  }
  throw new Error(
    `waitStatus timed out after ${ms}ms; last status: ${JSON.stringify(last)}` +
      (lastErr ? `; last error: ${String(lastErr)}` : ""),
  );
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

/**
 * Like `playRandomGame`, but never throws on hitting the ply cap (Plan 4.5 Task 11's load/soak harnesses): on the
 * last allowed half-move the mover's move is sent with `offerDraw: true`, and the other side accepts it, so every
 * game reaches a terminal state (a natural checkmate/stalemate/draw earlier than the cap still returns early, same
 * as `playRandomGame`). Callers should still `waitStatus` for a terminal `gameStatus` afterward: a mate/stalemate
 * detected before a move is sent (the mover has no legal move) is left for the daemon's own auto-resign/claim, just
 * as in `playRandomGame`.
 */
export async function playRandomGameCapped(
  white: Player,
  black: Player,
  opts: { channelId: Hex; seed?: number; maxMoves?: number; ms?: number },
): Promise<Status> {
  const rand = mulberry32(opts.seed ?? 1);
  const maxMoves = opts.maxMoves ?? 40;
  const ms = opts.ms ?? 10_000;
  for (let i = 0; i < maxMoves; i++) {
    const whiteStatus = (await white.api("GET", statusPath(opts.channelId))) as Status;
    if (whiteStatus.gameStatus !== "playing" && whiteStatus.gameStatus !== "draw_offered") return whiteStatus;
    const [mover, other] = whiteStatus.myTurn ? [white, black] : [black, white];
    const moverStatus = whiteStatus.myTurn ? whiteStatus : ((await black.api("GET", statusPath(opts.channelId))) as Status);
    if (moverStatus.legalMoves.length === 0) return moverStatus;
    const lastPly = i === maxMoves - 1;
    const move = moverStatus.legalMoves[Math.floor(rand() * moverStatus.legalMoves.length)];
    const resultStatus = (await mover.api("POST", "/move", { move, channel: opts.channelId, offerDraw: lastPly })) as Status;
    if (resultStatus.gameStatus !== "playing" && resultStatus.gameStatus !== "draw_offered") return resultStatus;
    await waitStatus(other, (s) => s.turnNum === resultStatus.turnNum || s.gameStatus !== "playing", ms, opts.channelId);
    if (lastPly) {
      // The capping move's `offerDraw` flag doesn't stop it from also being a mate: the daemon never computes
      // checkmate/stalemate at move-application time (a state's status is only ever PLAYING or, with the flag,
      // DRAW_OFFERED -- see chess.ts's normalMove), but `other`'s own daemon re-evaluates the position on its next
      // tick regardless of that flag and auto-resigns/claims if it is actually mated (spec §6.3), which can race
      // ahead of this poll ever observing "draw_offered" at all. Wait for *any* non-playing result, not
      // specifically "draw_offered": a decisive result here is a real terminal state too, and needs no draw.
      const otherStatus = await waitStatus(other, (s) => s.gameStatus !== "playing", ms, opts.channelId);
      if (otherStatus.gameStatus !== "draw_offered") return otherStatus;
      await other.api("POST", "/accept-draw", { channel: opts.channelId });
      return await waitStatus(mover, (s) => s.gameStatus === "draw", ms, opts.channelId);
    }
  }
  throw new Error(`playRandomGameCapped: exhausted ${maxMoves} half-moves without reaching a terminal state`);
}
