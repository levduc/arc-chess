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
  /** Fix round (important 3): how long `maintainOffers` backs off entirely after the hub itself refuses a
   *  `createOffer` (paused, or its escrow cap). Default `OFFER_BLOCK_BACKOFF_MS` (60 s). */
  offerBlockBackoffMs?: number;
  rng?: Rng;
  log?: (line: string) => void;
  /** Aborting stops the loop (and any in-flight `sleep`/`wait`) promptly; see `runBot`'s own docstring. */
  signal?: AbortSignal;
  /** Plan 5.7 Task 4: logged once, before the loop starts, when the host configured XMTP but this daemon ended
   *  up without the fallback (the SDK missing, a wrong version, or a broken install) -- computed by the caller
   *  (`cli.ts`'s `bot` command, which already knows `config.xmtp` and the daemon's own `fallback`), since
   *  `runBot` has no `home` directory to check this itself. `undefined` logs nothing; the bot runs exactly as it
   *  would with no xmtp at all either way (the daemon already fell back to the host relay alone). */
  xmtpEnableHint?: string;
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

/** Fix round (important 3): how long `maintainOffers` backs off reposting entirely once the hub itself refuses
 *  `createOffer` (paused, or its escrow cap) -- a condition the next `offerRecheckMs` pass alone can't fix, so
 *  there's no point retrying that often. */
export const OFFER_BLOCK_BACKOFF_MS = 60_000;

/** Fix round (important 3): matched against `createOffer`'s own `DaemonError` messages (`checkDepositAllowed`
 *  in daemon.ts) to tell a known, recoverable hub-level refusal from anything else (which still propagates, so
 *  it isn't silently swallowed). */
const HUB_PAUSED_RE = /hub is paused/;
const ESCROW_CAP_RE = /escrow cap/;

type OfferState = {
  fundsShort: boolean;
  /** Fix round (important 3): the hub's own reason the last `createOffer` attempt failed for (paused, or the
   *  escrow cap), while it keeps failing for that same reason; `null` once it's posting again. Dedupes the log
   *  exactly like `fundsShort` (one line when it starts, one when it clears) instead of logging every pass. */
  blockedReason: string | null;
  /** Fix round (important 3): wall-clock ms before which `maintainOffers` doesn't even try `createOffer` again
   *  while `blockedReason` is set. */
  blockedUntil: number;
};

/** Plan 5.5 Task 2 (Standing offers): tops up this bot's open offers to `opts.offers`, refusing to post one it
 *  cannot afford. "Afford" means the wallet's current USDC balance covers `deposit + fee` for every offer this
 *  bot already has open, every channel of its own still unfunded (phase `None`/`Funding` -- a conservative,
 *  over-counting proxy: once a channel funds, the committed amount has left the wallet for real, but it is never
 *  under-counted this way), *and* the new offer about to be posted. Logs once on a shortfall (not on every pass)
 *  and resumes silently once the balance recovers. Fix round (important 3): a hub-level refusal (paused, or its
 *  escrow cap) gets the same one-line-each-way treatment, plus its own `OFFER_BLOCK_BACKOFF_MS` back-off.
 */
async function maintainOffers(
  daemon: ArenaDaemon,
  opts: Pick<BotOptions, "usdc" | "deposit" | "stake" | "offers" | "offerTimeout">,
  log: (line: string) => void,
  state: OfferState,
  offerBlockBackoffMs: number,
): Promise<void> {
  const now = Date.now();
  if (state.blockedReason && now < state.blockedUntil) return;
  const [offers, channels, fee] = await Promise.all([daemon.listOffers(), daemon.channels(), daemon.hub.feeConfig()]);
  const mine = offers.filter((o) => o.mine).length;
  const need = opts.offers - mine;
  const unfundedMatches = channels.filter((c) => !("degraded" in c) && (c.phase === "None" || c.phase === "Funding")).length;
  const perOffer = opts.deposit + fee.feePerPlayer;
  const committed = BigInt(mine + unfundedMatches) * perOffer;
  if (need <= 0) {
    state.fundsShort = false;
    state.blockedReason = null;
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
    try {
      await daemon.createOffer({ deposit: opts.deposit, stakePerGame: opts.stake, challengeTimeout: opts.offerTimeout });
      posted++;
    } catch (err) {
      const message = errorText(err);
      const reason = HUB_PAUSED_RE.test(message)
        ? "the hub is paused"
        : ESCROW_CAP_RE.test(message)
          ? "the hub's escrow cap is reached"
          : null;
      if (!reason) throw err; // not a known, recoverable hub-level refusal -- let it surface normally
      if (state.blockedReason !== reason) {
        log(`bot: cannot post a standing offer: ${reason}; backing off for ${Math.round(offerBlockBackoffMs / 1000)}s`);
      }
      state.blockedReason = reason;
      state.blockedUntil = now + offerBlockBackoffMs;
      return;
    }
  }
  if (posted > 0) {
    if (state.fundsShort) log("bot: USDC balance recovered; posting standing offers again");
    if (state.blockedReason) log(`bot: standing offers resumed (${state.blockedReason} cleared)`);
    state.fundsShort = false;
    state.blockedReason = null;
  }
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

/** Fix round (important 2): the routine-action retry schedule (move/next-game/close/idle-close) -- much faster
 *  than the challenge one above, since these are ordinary turn-taking actions, not disputes. */
export const ACTION_BACKOFF_START_MS = 1_000;
export const ACTION_BACKOFF_MAX_MS = 30_000;

/** Fix round (important 2): runs `fn` (one daemon call for channel `id`) unless an earlier failure's back-off
 *  (`ACTION_BACKOFF_START_MS`, doubling to `ACTION_BACKOFF_MAX_MS`) hasn't elapsed yet, in which case it's
 *  skipped entirely -- returns false, same as "nothing to do", so `runBot`'s own idle sleep applies and this
 *  channel never gets hammered on every single pass. On success the record is cleared (the next distinct
 *  failure starts counting from 1 again); on failure it grows and this still returns false -- a persistently
 *  failing action (a stuck 409, an RPC blip) never reports as "acted" and so never skips the outer idle sleep
 *  either, closing the hot loop the plain `return true` after every `.catch` used to leave open. One shared map
 *  per channel across move/next-game/close/idle-close: they're mutually exclusive attention states in practice,
 *  so sharing keeps this simple without meaningfully weakening the back-off. */
async function runWithBackoff(
  backoffs: Map<Hex, Backoff>,
  id: Hex,
  log: (line: string) => void,
  label: string,
  fn: () => Promise<void>,
): Promise<boolean> {
  const now = Date.now();
  const prev = backoffs.get(id);
  if (prev && now < prev.nextAttemptAt) return false;
  try {
    await fn();
    backoffs.delete(id);
    return true;
  } catch (err) {
    const attempts = (prev?.attempts ?? 0) + 1;
    const wait = backoffDelayMs(attempts, ACTION_BACKOFF_START_MS, ACTION_BACKOFF_MAX_MS);
    backoffs.set(id, { attempts, nextAttemptAt: now + wait });
    log(`bot: ${label} on ${id} failed (attempt ${attempts}, retrying in ${Math.round(wait / 1000)}s): ${errorText(err)}`);
    return false;
  }
}

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
  /** Fix round (important 2): the generic back-off `runWithBackoff` uses for move/next-game/close/idle-close. */
  actionBackoff: Map<Hex, Backoff>;
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
      if (ctx.signal?.aborted) return false;
      const move = pickMove(st.fen, ctx.rng);
      return runWithBackoff(ctx.actionBackoff, id, ctx.log, `move ${move}`, () => daemon.move(id, move, { actor: "agent" }));
    }
    case "new-game-proposed":
      return runWithBackoff(ctx.actionBackoff, id, ctx.log, "next-game", () => daemon.nextGame(id, "agent"));
    case "close-requested":
      return runWithBackoff(ctx.actionBackoff, id, ctx.log, "close", () => daemon.close(id, "agent"));
    case "game-over": {
      const elapsed = gameOverElapsedMs(ctx.gameOverSince, id, st.gameIndex);
      if (elapsed < ctx.idleCloseMs) return false;
      return runWithBackoff(ctx.actionBackoff, id, ctx.log, "idle-close", () => daemon.close(id, "agent"));
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
  const offerBlockBackoffMs = opts.offerBlockBackoffMs ?? OFFER_BLOCK_BACKOFF_MS;
  const signal = opts.signal;

  // Plan 5.7 Task 4: once, at startup -- the bot still runs its normal loop below either way.
  if (opts.xmtpEnableHint) log(opts.xmtpEnableHint);

  const ctx: ActCtx = {
    rng,
    log,
    idleCloseMs,
    moveDelayMs,
    challengeBackoffStartMs,
    challengeBackoffMaxMs,
    gameOverSince: new Map(),
    challengeAttempts: new Map(),
    actionBackoff: new Map(),
    signal,
  };
  const offerState: OfferState = { fundsShort: false, blockedReason: null, blockedUntil: 0 };
  let lastOfferCheck = 0;

  while (!signal?.aborted) {
    if (Date.now() - lastOfferCheck >= offerRecheckMs) {
      lastOfferCheck = Date.now();
      await maintainOffers(daemon, opts, log, offerState, offerBlockBackoffMs).catch((err) =>
        log(`bot: standing-offer check failed: ${errorText(err)}`),
      );
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
