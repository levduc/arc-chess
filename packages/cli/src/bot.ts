import { Chess } from "chess.js";
import { erc20Abi, type Address, type Hex } from "viem";
import type { ArenaDaemon } from "./daemon.js";
import type { ChannelStatus } from "./status.js";

/** Injectable randomness, so the strategy and the loop are deterministic under test. `Math.random` in production. */
export type Rng = () => number;

const errorText = (err: unknown): string => (err instanceof Error ? err.message.split("\n")[0] : String(err));

const PIECE_VALUE: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

function pickOne<T>(items: readonly T[], rng: Rng): T {
  const idx = Math.min(items.length - 1, Math.max(0, Math.floor(rng() * items.length)));
  return items[idx];
}

/**
 * Plan 5.5 Task 2: the house bot's chess strategy -- a pure function of the position (`fen`) and a source of
 * randomness, so it is unit-testable with no daemon or chain involved.
 *
 * In order: mate in one; else the most valuable capture of a piece worth at least as much as the capturing piece
 * (ties broken by `rng`); else, 50% of the time, a move giving check; else, 60% of the time, any capture; else a
 * random legal move. Returns the move in UCI (chess.js's `lan`, e.g. "e7e8q") -- `ChannelSession.move`'s
 * `parseMove` matches the UCI regex before ever falling back to SAN, so this never hits chess.js's own
 * disambiguation (same board, loaded fresh) a second time.
 */
export function pickMove(fen: string, rng: Rng = Math.random): string {
  const game = new Chess(fen);
  const moves = game.moves({ verbose: true });
  if (moves.length === 0) throw new Error("pickMove: no legal moves in this position");

  const mates = moves.filter((m) => {
    const probe = new Chess(fen);
    probe.move(m.san);
    return probe.isCheckmate();
  });
  if (mates.length > 0) return pickOne(mates, rng).lan;

  const captures = moves.filter((m) => m.captured !== undefined);
  const qualifying = captures.filter((m) => PIECE_VALUE[m.captured!] >= PIECE_VALUE[m.piece]);
  if (qualifying.length > 0) {
    const bestValue = Math.max(...qualifying.map((m) => PIECE_VALUE[m.captured!]));
    return pickOne(qualifying.filter((m) => PIECE_VALUE[m.captured!] === bestValue), rng).lan;
  }

  const checks = moves.filter((m) => m.san.includes("+"));
  if (checks.length > 0 && rng() < 0.5) return pickOne(checks, rng).lan;

  if (captures.length > 0 && rng() < 0.6) return pickOne(captures, rng).lan;

  return pickOne(moves, rng).lan;
}

export type BotOptions = {
  /** The token this daemon's wallet is funded in -- read directly (not through `daemon.hub`) for the standing-offer
   *  funds check. */
  usdc: Address;
  /** Base units (6 decimals). */
  deposit: bigint;
  /** Base units (6 decimals). */
  stake: bigint;
  /** How many open standing offers this bot keeps posted at once. */
  offers: number;
  /** Omitted: the daemon's own default (`minChallengeTimeoutOf`). */
  offerTimeout?: bigint;
  /** Wall-clock ms a finished game is left for the opponent to propose a next game or request a close, before this
   *  bot requests the close itself. Default 120_000 (spec); configurable so tests can shorten it. */
  idleCloseMs?: number;
  /** Wall-clock ms between standing-offer top-ups. Default 15_000. */
  offerRecheckMs?: number;
  /** Wall-clock ms `daemon.wait()` is given per call. Default 15_000. */
  waitTimeoutMs?: number;
  /** Wall-clock ms the bot pauses before playing a move it owes ("after a 500 ms beat"). Default 500. */
  moveDelayMs?: number;
  /** Fix round (critical 1): the challenge-retry back-off's first wait, doubling up to `challengeBackoffMaxMs`.
   *  Default `CHALLENGE_BACKOFF_START_MS` (30 s); overridable so tests don't wait out the real schedule. */
  challengeBackoffStartMs?: number;
  /** Fix round (critical 1): the challenge-retry back-off's cap. Default `CHALLENGE_BACKOFF_MAX_MS` (5 min). */
  challengeBackoffMaxMs?: number;
  rng?: Rng;
  log?: (line: string) => void;
  /** Aborting stops the loop (and any in-flight `sleep`/`wait`) promptly; see `runBot`'s own docstring. */
  signal?: AbortSignal;
};

/** Resolves once `signal` aborts (immediately if it already has); never, if there is no signal. */
function abortSignal(signal: AbortSignal | undefined): Promise<void> {
  if (!signal) return new Promise(() => {});
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
}

/** `ms` of real time, or sooner if `signal` aborts. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return Promise.race([new Promise<void>((resolve) => setTimeout(resolve, ms)), abortSignal(signal)]);
}

/** Plan 5.5 Task 2 (Standing offers): tops up this bot's open offers to `opts.offers`, refusing to post one it
 *  cannot afford. "Afford" means the wallet's current USDC balance covers `deposit + fee` for every offer this
 *  bot already has open, every channel of its own still unfunded (phase `None`/`Funding` -- a conservative,
 *  over-counting proxy: once a channel funds, the committed amount has left the wallet for real, but it is never
 *  under-counted this way), *and* the new offer about to be posted. Logs once on a shortfall (not on every pass)
 *  and resumes silently once the balance recovers.
 */
async function maintainOffers(
  daemon: ArenaDaemon,
  opts: Pick<BotOptions, "usdc" | "deposit" | "stake" | "offers" | "offerTimeout">,
  log: (line: string) => void,
  state: { fundsShort: boolean },
): Promise<void> {
  const [offers, channels, fee] = await Promise.all([daemon.listOffers(), daemon.channels(), daemon.hub.feeConfig()]);
  const mine = offers.filter((o) => o.mine).length;
  const need = opts.offers - mine;
  const unfundedMatches = channels.filter((c) => !("degraded" in c) && (c.phase === "None" || c.phase === "Funding")).length;
  const perOffer = opts.deposit + fee.feePerPlayer;
  const committed = BigInt(mine + unfundedMatches) * perOffer;
  if (need <= 0) {
    state.fundsShort = false;
    return;
  }
  const balance = await daemon.client.readContract({
    address: opts.usdc,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [daemon.wallet.address],
  });
  let posted = 0;
  for (let i = 0; i < need; i++) {
    const projected = committed + BigInt(posted + 1) * perOffer;
    if (balance < projected) {
      if (!state.fundsShort) {
        log(
          `bot: USDC balance (${balance}) is too low to post another standing offer (needs ${projected} total ` +
            `for ${mine + unfundedMatches + posted + 1} open/unfunded commitment(s)); pausing until funds recover`,
        );
        state.fundsShort = true;
      }
      return;
    }
    await daemon.createOffer({ deposit: opts.deposit, stakePerGame: opts.stake, challengeTimeout: opts.offerTimeout });
    posted++;
  }
  if (posted > 0 && state.fundsShort) {
    log("bot: USDC balance recovered; posting standing offers again");
  }
  if (posted > 0) state.fundsShort = false;
}

type GameOverMark = { gameIndex: number; since: number };

/** Elapsed ms since `channelId` was first seen game-over *for this `gameIndex`* -- a later game (a new gameIndex)
 *  always gets a fresh idle-close window. */
function gameOverElapsedMs(marks: Map<Hex, GameOverMark>, channelId: Hex, gameIndex: number): number {
  const prev = marks.get(channelId);
  if (!prev || prev.gameIndex !== gameIndex) {
    marks.set(channelId, { gameIndex, since: Date.now() });
    return 0;
  }
  return Date.now() - prev.since;
}

/** Fix round (critical 1): a per-channel retry schedule -- `attempts` so far, and the wall-clock ms before which
 *  the next attempt is skipped entirely (0 = try now). Shared shape for every per-channel back-off in this file. */
type Backoff = { attempts: number; nextAttemptAt: number };

/** Fix round (critical 1): first failure waits `startMs`, doubling on each further failure, capped at `maxMs`. */
function backoffDelayMs(attempts: number, startMs: number, maxMs: number): number {
  return Math.min(maxMs, startMs * 2 ** (attempts - 1));
}

/** Fix round (critical 1): default challenge-retry schedule (spec: "30 s, doubling, up to 5 min") -- exported so
 *  a test can assert against the real production numbers, not just whatever it happens to override them to. */
export const CHALLENGE_BACKOFF_START_MS = 30_000;
export const CHALLENGE_BACKOFF_MAX_MS = 300_000;

type ActCtx = {
  rng: Rng;
  log: (line: string) => void;
  idleCloseMs: number;
  moveDelayMs: number;
  challengeBackoffStartMs: number;
  challengeBackoffMaxMs: number;
  gameOverSince: Map<Hex, GameOverMark>;
  /** Fix round (critical 1): replaces the old one-shot `Set<Hex>` -- a failed challenge (an RPC blip, a
   *  transient revert, an `InCooldown` refusal) must not permanently stop this channel from ever being
   *  challenged again, and a *second* silence episode (after an earlier dispute cycle resolved) must be
   *  challenged again too. Cleared whenever a status for this channel is no longer `opponent-silent` (see
   *  `actOnChannel`), so a fresh episode always starts a fresh schedule. */
  challengeAttempts: Map<Hex, Backoff>;
  signal?: AbortSignal;
};

/** Fix round (critical 1): decides and, if it's time, makes one challenge attempt for a channel whose attention
 *  is `opponent-silent`. Returns false without calling `daemon.challenge` at all when: a prior failure's
 *  back-off (`CHALLENGE_BACKOFF_START_MS`, doubling to `CHALLENGE_BACKOFF_MAX_MS`) hasn't elapsed yet, or this
 *  bot is still in the hub's post-`respond` cooldown for this channel (`status.cooldown.meSeconds`, read fresh
 *  from `st` -- not guessed from an `InCooldown` error message) -- in which case the next attempt is scheduled
 *  for exactly when that cooldown clears, rather than hammering `challenge()` into a revert on every pass.
 */
async function attemptChallenge(daemon: ArenaDaemon, st: ChannelStatus, ctx: ActCtx): Promise<boolean> {
  const id = st.channelId;
  const now = Date.now();
  const prev = ctx.challengeAttempts.get(id);
  if (prev && now < prev.nextAttemptAt) return false;
  if (st.cooldown.meSeconds > 0) {
    ctx.challengeAttempts.set(id, { attempts: prev?.attempts ?? 0, nextAttemptAt: now + st.cooldown.meSeconds * 1000 });
    return false;
  }
  try {
    await daemon.challenge(id, "agent");
    ctx.challengeAttempts.delete(id);
    return true;
  } catch (err) {
    const attempts = (prev?.attempts ?? 0) + 1;
    const wait = backoffDelayMs(attempts, ctx.challengeBackoffStartMs, ctx.challengeBackoffMaxMs);
    ctx.challengeAttempts.set(id, { attempts, nextAttemptAt: now + wait });
    ctx.log(`bot: challenge on ${id} failed (attempt ${attempts}, retrying in ${Math.round(wait / 1000)}s): ${errorText(err)}`);
    return false;
  }
}

/** Acts on one agent-controlled channel's current status. Returns true if it took an action that actually
 *  succeeded (so the loop's own idle back-off, see `runBot`, is skipped for this pass only on real progress --
 *  a caught failure returns false, same as "nothing to do"). Every daemon call is caught and logged: a
 *  transient 409 (a turn race, a close already submitted by the relay path, ...) must never kill the bot. */
async function actOnChannel(daemon: ArenaDaemon, st: ChannelStatus, ctx: ActCtx): Promise<boolean> {
  const id = st.channelId;
  // Fix round (critical 1): a fresh episode always starts a fresh challenge-retry schedule.
  if (st.attention !== "opponent-silent") ctx.challengeAttempts.delete(id);
  switch (st.attention) {
    case "your-turn": {
      await sleep(ctx.moveDelayMs, ctx.signal);
      if (ctx.signal?.aborted) return true;
      const move = pickMove(st.fen, ctx.rng);
      await daemon.move(id, move, { actor: "agent" }).catch((err) => ctx.log(`bot: move ${move} on ${id} failed: ${errorText(err)}`));
      return true;
    }
    case "new-game-proposed":
      await daemon.nextGame(id, "agent").catch((err) => ctx.log(`bot: next-game on ${id} failed: ${errorText(err)}`));
      return true;
    case "close-requested":
      await daemon.close(id, "agent").catch((err) => ctx.log(`bot: close on ${id} failed: ${errorText(err)}`));
      return true;
    case "game-over": {
      const elapsed = gameOverElapsedMs(ctx.gameOverSince, id, st.gameIndex);
      if (elapsed < ctx.idleCloseMs) return false;
      await daemon.close(id, "agent").catch((err) => ctx.log(`bot: idle-close on ${id} failed: ${errorText(err)}`));
      return true;
    }
    case "opponent-silent":
      return attemptChallenge(daemon, st, ctx);
    default:
      return false; // session-gas-low (the daemon refills on its own), settled, human-must-move, or nothing to do
  }
}

/**
 * Plan 5.5 Task 2: the house bot's long-lived play loop. Drives `daemon` directly (no HTTP hop): keeps `--offers`
 * standing offers posted, and on every agent-controlled channel, moves on `your-turn`, accepts `new-game-proposed`,
 * co-signs `close-requested`, idle-closes a `game-over` channel the opponent never answers, and challenges a
 * silent opponent. Never offers or accepts a draw, and never resigns on its own -- only the daemon's own
 * auto-resign (mate) and auto-claim (stalemate) apply.
 *
 * Resolves once `opts.signal` aborts (checked at every blocking point, so shutdown is prompt rather than waiting
 * out a `wait()` call already in flight). Never throws: a failure in one pass is logged and the loop continues.
 */
export async function runBot(daemon: ArenaDaemon, opts: BotOptions): Promise<void> {
  const log = opts.log ?? (() => {});
  const rng = opts.rng ?? Math.random;
  const idleCloseMs = opts.idleCloseMs ?? 120_000;
  const offerRecheckMs = opts.offerRecheckMs ?? 15_000;
  const waitTimeoutMs = opts.waitTimeoutMs ?? 15_000;
  const moveDelayMs = opts.moveDelayMs ?? 500;
  const challengeBackoffStartMs = opts.challengeBackoffStartMs ?? CHALLENGE_BACKOFF_START_MS;
  const challengeBackoffMaxMs = opts.challengeBackoffMaxMs ?? CHALLENGE_BACKOFF_MAX_MS;
  const signal = opts.signal;

  const ctx: ActCtx = {
    rng,
    log,
    idleCloseMs,
    moveDelayMs,
    challengeBackoffStartMs,
    challengeBackoffMaxMs,
    gameOverSince: new Map(),
    challengeAttempts: new Map(),
    signal,
  };
  const offerState = { fundsShort: false };
  let lastOfferCheck = 0;

  while (!signal?.aborted) {
    if (Date.now() - lastOfferCheck >= offerRecheckMs) {
      lastOfferCheck = Date.now();
      await maintainOffers(daemon, opts, log, offerState).catch((err) => log(`bot: standing-offer check failed: ${errorText(err)}`));
      if (signal?.aborted) break;
    }

    await Promise.race([daemon.wait({ timeoutMs: waitTimeoutMs }), abortSignal(signal)]);
    if (signal?.aborted) break;

    let acted = false;
    const statuses = await daemon.channels().catch((err) => {
      log(`bot: channels() failed: ${errorText(err)}`);
      return [] as Awaited<ReturnType<ArenaDaemon["channels"]>>;
    });
    for (const st of statuses) {
      if ("degraded" in st) continue;
      if (st.controller !== "agent") continue;
      const did = await actOnChannel(daemon, st, ctx).catch((err) => {
        log(`bot: acting on ${st.channelId} failed: ${errorText(err)}`);
        return true; // don't hot-loop on a repeatedly-failing action either
      });
      acted = acted || did;
    }
    if (!acted && !signal?.aborted) await sleep(1_000, signal);
  }
}
