import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import { createPublicClient, defineChain, erc20Abi, EstimateGasExecutionError, http, type Chain, type Hex, type PublicClient } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  ArenaProtocolError,
  ChannelSession,
  HubClient,
  HubRevertError,
  LocalKeyTxSender,
  MemoryStore,
  NO_FEE_CEILING,
  RECEIPT_TIMEOUT_MS,
  SerialTxSender,
  TxDroppedError,
  TxFeeCapError,
  TxInsufficientFundsError,
  TxNonceUsedError,
  TxReceiptMissingError,
  ZERO_HASH,
  channelId as computeChannelId,
  chunkRanges,
  checkMatchParams,
  hashState,
  isGameOver,
  mover,
  offerId as computeOfferId,
  outcome,
  signAcceptance,
  signOffer,
  verifyOffer,
  waitOrReplace,
  type ArenaDomain,
  type LobbyClient,
  type MatchEvent,
  type Offer,
  type RelayClient,
  type RelayMessage,
  type SignedState,
} from "@arena/sdk";
import {
  arenaPaths,
  isCanonicalId,
  minChallengeTimeoutOf,
  sessionGasFloorOf,
  DEFAULT_LOG_CHUNK_BLOCKS,
  type ArenaConfig,
} from "./config.js";
import { FileSessionStore } from "./fileStore.js";
import { RecordStore, type ChannelRecord, type Controller } from "./records.js";
import { buildStatus, type ChannelStatus } from "./status.js";

export type Actor = "agent" | "human";

export class DaemonError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = "DaemonError";
  }
}

/** Plan 5 fix round ("a failed fee estimate also raises session-gas-low"): thrown by `topUpSession` when its own
 *  `estimateFeesPerGas` pre-check fails, so `ensureSessionGas` can classify it unambiguously -- rather than a
 *  refill's failed fee estimate surfacing as some other, harder-to-classify error shape from deep inside the
 *  sender's own send path. */
export class SessionGasEstimateError extends Error {
  constructor(cause?: unknown) {
    super(`fee estimate failed: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.name = "SessionGasEstimateError";
  }
}

export type ChainView = {
  phase: string;
  funded: readonly [boolean, boolean];
  deadline: bigint;
  challenger: number;
  registeredTurn: bigint | null;
  cooldownUntil: readonly [bigint, bigint];
  now: bigint;
};

export type ChannelHandle = {
  record: ChannelRecord;
  session: ChannelSession;
  sessionSender: SerialTxSender;
  processedEvents: number;
  chain: ChainView | null;
  lastError: string | null;
  /** R9/3b, Plan 4.5 Task 10 re-review (M3): count the dispute-pass and main-pass attempts for this channel, apart --
   *  lets tests confirm an explicit `tick()` (or a pass) actually ran, rather than being swallowed by an in-flight
   *  guard, and tell which pass it was. */
  disputePasses: number;
  mainPasses: number;
  /** I2: chain time of the last observed progress on this channel (in memory only; set on the first refresh after start). */
  lastProgressAt: bigint | null;
  /** I2: fingerprint of the session/phase at `lastProgressAt`; any change counts as progress. */
  progressKey: string | null;
  /** M-c: set while an autoPlay (relay- or tick-driven) runs, so the two never both try to resign the same mate. */
  autoPlaying: boolean;
  /** Task 2 (spec §13): chain time until which `watch()` skips `fund()` for this channel, set after a funding
   *  revert caused by the hub's launch limits (Paused/DepositTooLarge/EscrowCapReached) -- so the watchtower
   *  backs off instead of retrying the same revert on every tick. Null once funding succeeds. */
  fundBlockedUntil: bigint | null;
  /** Plan 4.5 Task 10: set while a cooperative-close submission runs, so the relay path, the close API and the
   *  watchtower's retry never submit the same close twice at once. */
  submittingClose: boolean;
  /** Plan 4.5 Task 10 review: wall-clock ms before which the watchtower does not retry the cooperative close,
   *  set after a submission reverted (the same close would most likely revert again). 0 = no back-off. */
  closeRetryAt: number;
  /** Plan 4.5 Task 10 re-review (I2): set while this channel's dispute work runs, so it never runs twice at once.
   *  Round 4: the move path's respond takes it too, so it never answers beside the dispute pass. */
  disputeBusy: boolean;
  /** Plan 4.5 Task 10 round 4: set while the main pass or the reclaim API works on this channel, so a reclaim is
   *  never sent by both at once. */
  mainBusy: boolean;
  /** Final review C1: the session-key refill in flight, if any -- shared by the main pass, the dispute pass and
   *  funding, so two of them never both see a low balance and both send a refill. */
  refilling: Promise<void> | null;
  /** Final review C1: session-key refills sent for this channel after funding (for logs, tests and tooling). */
  refills: number;
  /** Final review C1: set while the session key is below `sessionGasFloor` and the wallet could not refill it
   *  (the reason); drives the `session-gas-low` attention. Null otherwise. */
  sessionGasLow: string | null;
  /** Plan 5 Task 1 (mainnet gates: refill back-off): wall-clock ms before which `ensureSessionGas` does not retry
   *  a refill for this channel, set after a failed refill. 0 = no back-off in effect. */
  refillBlockedUntil: number;
  /** Plan 5 Task 1: the current refill back-off episode's duration in ms (0 = no episode): 30s on the first
   *  failure, doubled on each one after, capped at 5 minutes; reset to 0 on a successful refill or once the
   *  wallet's balance rises above `refillLastWalletBalance`. */
  refillBackoffMs: number;
  /** Plan 5 Task 1: the wallet's native balance as last observed by the refill back-off gate, or null before the
   *  first observation -- a rise above this ends the back-off early (the wallet may have just been funded). */
  refillLastWalletBalance: bigint | null;
  /** Final review C1: `wait()` has already woken for the current `sessionGasLow` episode (so it does not return at
   *  once on every call while the wallet stays empty). */
  sessionGasLowWoken: boolean;
  /** Final review m4: this channel settled (Finalized or Reclaimed) while this daemon watched it, and no `wait()` has
   *  woken for it yet: drives the one-shot `settled` attention. */
  settledWake: boolean;
  /** Final review I3: chain time at which the main pass first saw this channel settled; it is evicted from `live`
   *  `SETTLED_GRACE_SECONDS` later. */
  settledAt: bigint | null;
  /** Plan 5 fix round (rules 1-5, I8): this channel's sweep back-off state -- `blockedUntil`/`backoffMs` mirror
   *  the refill back-off's shape (wall-clock ms; 0 = no episode); `attempts` counts consecutive failures and
   *  drives `SWEEP_ABANDON_ATTEMPTS`. Passed by reference to `runSweepAttempt`, shared with the sweep queue's
   *  identically-shaped per-entry state (see `SweepQueueEntry`). */
  sweep: { blockedUntil: number; backoffMs: number; attempts: number };
};

/** I1: a channel whose files could not be loaded; reported by `channels()`, ignored by `pick()` and the watchtower. */
export type DegradedChannel = { channelId: string; degraded: true; error: string };

/** Plan 5 fix round (I2): a finalized-but-unswept channel found at `start()` (a restart, or a record written
 *  before this feature existed) -- never opened into `live` (no session, no relay join: it's settled, there is
 *  nothing left to watch), just a session sender and the same back-off shape `ChannelHandle.sweep` uses, so the
 *  main pass can sweep it without a full `openChannel`. Removed from the queue once `record.swept` is set. */
type SweepQueueEntry = {
  record: ChannelRecord;
  sender: SerialTxSender;
  sweep: { blockedUntil: number; backoffMs: number; attempts: number };
  /** True while either the queue's own pass or a manual `sweep()` call is working on this entry, so the two never
   *  send at once (I1's busy-wait pattern, mirrored from `reclaim()`/`l.mainBusy`). */
  busy: boolean;
};

/** Plan 5 fix round: what one sweep attempt on a session key resolved to. `"skipped"` covers every reason the
 *  attempt never actually ran (not yet confirmed settled on-chain, a concurrent send in flight, back-off still in
 *  effect) -- the record is unchanged and the caller simply tries again on a later pass. */
type SweepAttemptResult =
  | { kind: "swept"; record: ChannelRecord; amount: bigint; hash: Hex }
  | { kind: "dust"; record: ChannelRecord }
  | { kind: "abandoned"; record: ChannelRecord }
  | { kind: "skipped"; record: ChannelRecord }
  | { kind: "error"; record: ChannelRecord; error: unknown };

export type DaemonOptions = {
  home: string;
  config: ArenaConfig;
  walletKey: Hex;
  lobby: LobbyClient;
  relay: RelayClient;
  log?: (line: string) => void;
};

const errorText = (err: unknown) => (err instanceof Error ? err.message.split("\n")[0] : String(err));


/**
 * I3: on every scan, re-read this many blocks behind the persisted cursor, not just forward from it. A
 * load-balanced RPC's `blockNumber()` can outrun its own `getLogs` index (or, on a real chain, a shallow reorg
 * can drop and re-mine a block), so trusting a single pass at a reported head can permanently skip an event
 * that was there all along. `ingestOnChain` is idempotent for a state it already holds, so re-reading is safe.
 */
export const DISPUTE_RESCAN_BLOCKS = 32n;

/** The furthest out a funding deadline may be set from match time (`checkMatchParams`' `maxFundingWindow`): an
 *  offer this long past its expiry can no longer produce a fundable match. Distinct from, and must stay well
 *  under, the SDK's `MAX_FUNDING_WINDOW` (86400n): the hub's own hard cap on `fundingDeadline`. */
export const MAX_FUNDING_WINDOW = 7200n;

/** Task 2 (spec §13): once `fund()` reverts for one of these reasons, `watch()` backs off funding this channel
 *  for at least this many seconds of chain time, instead of retrying the same revert on every tick. */
export const FUND_BACKOFF_SECONDS = 30n;

/** Plan 4.5 Task 10 review: after a cooperative-close submission reverts, the watchtower waits this long before
 *  retrying it (the close API and the relay path still submit at once). */
export const CLOSE_RETRY_BACKOFF_MS = 30_000;

/** Plan 4.5 Task 10 round 4: how long the reclaim API waits for the main pass to release a channel before it
 *  answers 409 (the main pass may be in a bounded receipt wait on that channel). */
export const RECLAIM_BUSY_WAIT_MS = 2_000;

/** Final review I3: a settled (Finalized, Reclaimed or retired) channel stays in `live` -- with its session, its
 *  senders and their clients -- this long in chain time after the main pass first sees it settled, then only its
 *  final status is kept (`settled`), so a long-lived daemon's memory does not grow with every channel it has ever
 *  settled. */
export const SETTLED_GRACE_SECONDS = 600n;

/** Final review I3: at most this many evicted channels' final statuses are kept in memory; older ones are served
 *  from disk (`status`), and no longer listed by `channels()`. */
export const SETTLED_CACHE_MAX = 1000;

/** Plan 5 Task 1 (mainnet gates: refill and sweep back-off): the first back-off, in wall-clock ms, after a failed
 *  refill or sweep -- doubled on each further failure, up to `BACKOFF_MAX_MS`. */
export const BACKOFF_START_MS = 30_000;
/** Plan 5 Task 1: the refill/sweep back-off never grows past this. */
export const BACKOFF_MAX_MS = 300_000;

/** Plan 5 fix round (I8): after this many failed sweep attempts (the back-off has long since reached its cap by
 *  then), the channel's session gas is written off -- `swept: "abandoned"` -- so eviction can proceed instead of
 *  a permanently-stuck channel occupying memory forever over gas that will apparently never sweep. */
export const SWEEP_ABANDON_ATTEMPTS = 12;

/** Plan 5 fix round (rule 3): the value a sweep sends reserves `gas * ceil(feePerGas * SWEEP_HEADROOM_NUM /
 *  SWEEP_HEADROOM_DEN)` for gas, so a single 12.5% same-nonce replacement bump still fits the balance bound
 *  (`SerialTxSender.affordable`) -- sending exactly `gas * feePerGas` would leave a same-nonce replacement unable
 *  to afford any bump at all. 13/10 = 1.3x. */
export const SWEEP_HEADROOM_NUM = 13n;
export const SWEEP_HEADROOM_DEN = 10n;

/** Plan 4.5 Task 10 re-review (M5): a recorded channel that fails to open this many times on a match retry is
 *  marked degraded (reported by channels(), never picked or watched) instead of being retried forever. */
export const MAX_OPEN_ATTEMPTS = 5;

/** The hub error names that mean "this deposit cannot go through right now because of a launch limit" (spec §13),
 *  as opposed to a bug or an unrelated chain error. */
const LIMIT_REVERTS = new Set(["Paused", "DepositTooLarge", "EscrowCapReached"]);

export class ArenaDaemon {
  readonly client: PublicClient;
  readonly hub: HubClient;
  readonly wallet: SerialTxSender;
  protected readonly chain: Chain;
  protected readonly domain: ArenaDomain;
  protected readonly records: RecordStore;
  protected readonly live = new Map<Hex, ChannelHandle>();
  /** Final review I3 / Plan 5 fix round (I4): the final status of each settled channel evicted from `live` (or
   *  loaded at `start()`), keyed with its `settledAt` (wall-clock ms) so `insertSettled` can trim by settle time
   *  rather than insertion order once the map exceeds `SETTLED_CACHE_MAX`. */
  protected readonly settled = new Map<Hex, { status: ChannelStatus; settledAt: number }>();
  /** I1: channel entries that could not be loaded at start(), by directory name, with the reason. Never watched or picked. */
  protected readonly degraded = new Map<string, string>();
  /** Plan 5 fix round (I2): finalized-but-unswept channels found at `start()`, processed by the main pass. See
   *  `SweepQueueEntry`. */
  protected readonly sweepQueue = new Map<Hex, SweepQueueEntry>();
  /** Plan 5 fix round (I5): `sweep()` is single-flight -- a concurrent call is refused with 409. */
  private sweeping = false;
  protected readonly changes = new EventEmitter();
  private timer: NodeJS.Timeout | undefined;
  private unsubscribers: Array<() => void> = [];
  /** Plan 4.5 Task 10 review: the watchtower runs as two independent passes, each with its own in-flight guard
   *  (see `disputePass` / `mainPass`), so a stall in one never delays the other. */
  private mainTicking = false;
  private get ticking(): boolean {
    return this.mainTicking || [...this.live.values()].some((l) => l.disputeBusy || l.mainBusy);
  }
  /** M1: set by stop(); every handler checks this before any side effect (open/join/fund) it hasn't started yet. */
  private stopped = false;
  /** I3: offerIds currently being turned into a channel — guards against two match events racing the same offer. */
  private readonly claiming = new Set<Hex>();
  /** Guards against two concurrent acceptOffer calls for the same offerId both going through. */
  private readonly accepting = new Set<Hex>();
  /** Plan 4.5 Task 10: match events whose handling failed on an error (an RPC blip), by offerId -- retried on the
   *  next tick. The host sends a match once per subscription, so without a retry one failed read at match time
   *  left the channel unopened (and unfunded) for good. Explicit rejections are never retried. */
  private readonly retryMatches = new Map<Hex, MatchEvent>();
  private readonly aborter = new AbortController();
  /** Plan 4.5 Task 10 re-review (M5): failed attempts to open a recorded channel, by channel id. */
  private readonly openFailures = new Map<Hex, number>();
  /** Plan 4.5 Task 11 fix round (I1/M4): offerId (canonical lower-case) -> channelId, maintained on save
   *  (start()'s initial scan, and onMatch's new-record write) so `channelForOffer` never has to re-scan every
   *  record.json on disk -- that scan ran twice per match and once per acceptOffer, and its cost grows with the
   *  daemon's lifetime channel count. */
  private readonly offerIdIndex = new Map<Hex, Hex>();
  /** Plan 4.5 Task 11 fix round (C2): the most recent "too many watched offers" (or other subscribe-refusal)
   *  message from the host, if any. Sticky until this process restarts: only a restart clears the underlying
   *  cause (the host connection's watch-slot cap was hit), so there is nothing to un-set it. Exposed via
   *  ChannelStatus.lobbyError, and blocks new createOffer/acceptOffer calls (checkLobbyHealthy) so a silent,
   *  permanent loss of match notifications is never mistaken for a healthy 200. */
  private lobbyError: string | null = null;

  constructor(protected readonly opts: DaemonOptions) {
    const c = opts.config;
    this.chain = defineChain({
      id: c.chainId,
      name: `arena-${c.chainId}`,
      nativeCurrency: { name: "Native", symbol: "NATIVE", decimals: 18 },
      rpcUrls: { default: { http: [c.rpcUrl] } },
    });
    this.client = createPublicClient({ chain: this.chain, transport: http(c.rpcUrl) });
    // Plan 4.5 Task 10 re-review 2: stop() aborts every receipt wait in flight (rather than waiting out a 30 s round).
    this.hub = new HubClient(c.hub, this.client, { signal: this.aborter.signal });
    // Tracking senders (Plan 4.5 Task 10 round 4): each manages its key's nonces, read via this.client.
    // Round 4: every fee the wallet pays is capped at max(4 x the node's estimate, feeCeilingWei) and what it can pay.
    this.wallet = new SerialTxSender(new LocalKeyTxSender(opts.walletKey, c.rpcUrl, this.chain), this.client, {
      feeCeiling: c.feeCeilingWei,
    });
    this.domain = { chainId: c.chainId, hub: c.hub };
    this.records = new RecordStore(opts.home);
    this.changes.setMaxListeners(0);
  }

  // ------------------------------------------------------------------ lifecycle

  /** Starts the daemon. Plan 4.5 Task 10 round 4 (M5): a daemon cannot be restarted once stopped -- stop() aborts
   *  its receipt waits for good -- so a restart creates a new ArenaDaemon on the same home. */
  async start(): Promise<void> {
    if (this.stopped) throw new Error("a stopped ArenaDaemon cannot be restarted: create a new one on the same home");
    this.unsubscribers.push(this.opts.lobby.onMatch((m) => void this.onMatch(m)));
    this.unsubscribers.push(this.opts.relay.onMessage((m) => void this.onRelay(m)));
    this.unsubscribers.push(this.opts.relay.onJoined((id) => void this.onJoined(id)));
    // Plan 4.5 Task 11 fix round (C2): make a subscribe refusal visible instead of a silent, permanent loss of
    // match notifications. Sticky (see `lobbyError`'s docstring): this daemon refuses new offers/accepts from
    // here on, and every channel's status carries the message, until it is restarted.
    this.unsubscribers.push(
      this.opts.lobby.onWatchRefused((msg) => {
        this.lobbyError = msg;
        this.log(`lobby: ${msg} -- this daemon will not learn of new matches as an offerer until it is restarted`);
        this.notify();
      }),
    );
    // I1: every channel entry is loaded in isolation. A corrupt record or session file, or a record that does not
    // match this hub/chain, is logged and reported as degraded (see channels()) instead of aborting start() —
    // which would leave every other channel, including ones mid-dispute, unwatched.
    // Plan 5 Task 1 (mainnet gates: settled index): finalized records collected here, loaded into `this.settled`
    // (and, fix round I2, `this.sweepQueue`) below (once the whole scan is done, so the index can be sorted by
    // settle time and capped first).
    const finalizedRecords: ChannelRecord[] = [];
    for (const entry of this.records.scanChannels()) {
      if (this.stopped) break;
      if (entry.record === null) {
        this.markDegraded(entry.channelId, entry.error);
        continue;
      }
      // I1/M4: indexed regardless of `finalized` -- channelForOffer must still find a settled channel (the
      // dedup check in onMatch relies on it), it just never needs opening again.
      if (typeof entry.record.offerId === "string") {
        this.offerIdIndex.set(entry.record.offerId.toLowerCase() as Hex, entry.record.channelId);
      }
      if (entry.record.finalized) {
        finalizedRecords.push(entry.record);
        continue;
      }
      try {
        await this.openChannel(entry.record);
      } catch (err) {
        // only a session that failed to load gets here: a relay join failure is recorded as the channel's
        // lastError by openChannel itself, without holding up this loop
        this.markDegraded(entry.channelId, errorText(err));
      }
    }
    if (this.stopped) return;
    // Plan 4.5 Task 10 re-review (C1): the timer is armed before anything else can wait. start() used to await a
    // first full tick first -- so a main pass stalled on a receipt wait right after a restart held back every
    // dispute pass (and start() itself, with the API behind it) until it finished. Re-review 2 (minor 7): before
    // offer pruning too, which reads the chain and could hang on a slow RPC. Plan 5 fix round (minor): also before
    // the settled index/sweep queue loads just below -- a home with a lot of settled history must not hold up the
    // first dispute pass on a restart either.
    // The two passes are started independently: a dispute pass never waits for a main pass still in flight.
    this.timer = setInterval(() => {
      void this.disputePass();
      void this.mainPass();
    }, this.opts.config.pollMs);
    // Plan 5 Task 1: the settled index -- newest `SETTLED_CACHE_MAX` finalized channels by `settledAt` (a record
    // with none, written before this field existed, sorts as the oldest). Older ones are still served from disk
    // by `status`/`settledStatus`, just not listed by `channels()`.
    finalizedRecords.sort((a, b) => (b.settledAt ?? 0) - (a.settledAt ?? 0));
    for (const record of finalizedRecords.slice(0, SETTLED_CACHE_MAX)) {
      if (this.stopped) return;
      const status = await this.loadSettledStatus(record).catch(() => null);
      if (status) this.insertSettled(record.channelId, status, record.settledAt ?? 0);
    }
    // Plan 5 fix round (I2): every finalized record still unswept (unset only -- "abandoned" ones wait for an
    // explicit `arena sweep`, not an automatic retry) is queued for the main pass to sweep, without a full
    // openChannel: a settled channel has nothing else left to watch (no session, no relay join needed).
    for (const record of finalizedRecords) {
      if (this.stopped) return;
      if (record.swept !== undefined) continue;
      this.sweepQueue.set(record.channelId, {
        record,
        sender: new SerialTxSender(new LocalKeyTxSender(record.sessionKey, this.opts.config.rpcUrl, this.chain), this.client, {
          feeCeiling: NO_FEE_CEILING,
        }),
        sweep: { blockedUntil: 0, backoffMs: 0, attempts: 0 },
        busy: false,
      });
    }
    // Records that can no longer produce a fundable match go first, so they are never subscribed at all.
    if (!this.stopped) await this.pruneOffers();
    // Replays match events for offers this daemon posted/accepted while it was down.
    this.opts.lobby.watch(this.records.offers().map((o) => o.offerId));
    if (this.stopped) return;
    // R8.3: populate `chain` for restored channels immediately, so status()/channels()/wait() can see attention
    // right after a restart instead of waiting up to pollMs -- with reads only, never a transaction. I1: skips
    // Finalized/Reclaimed channels -- their on-chain state is terminal and was already captured before they were
    // marked finalized (see settleCheck), so refreshing them again here is a pure cost that grows with a
    // long-lived daemon's lifetime channel count.
    for (const l of this.live.values()) {
      if (this.stopped) return;
      if (l.record.finalized) continue;
      await this.refreshChain(l).catch((err: unknown) => this.log(`channel ${l.record.channelId}: first refresh failed: ${errorText(err)}`));
    }
    // The first round starts now, without start() waiting for it.
    if (!this.stopped) void this.tick();
  }

  /** Stops the daemon. Bounded by the transport timeouts of RPC calls already in flight (round 5, m3). */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    // Receipt waits in flight end now (TxWaitAbortedError); the senders release their transactions. stop() is then
    // bounded by the RPC calls already in flight (viem's transport timeout and retries), not by any receipt wait.
    this.aborter.abort();
    for (const u of this.unsubscribers) u();
    this.unsubscribers = [];
    while (this.ticking) await new Promise((r) => setTimeout(r, 10));
    this.changes.removeAllListeners();
  }

  /** R9/3b: resolves once no tick is currently in flight — call before an explicit `tick()` in a test that needs it deterministic, so that call isn't a no-op against the periodic timer's own concurrent tick. */
  async idle(): Promise<void> {
    while (this.ticking) await new Promise((r) => setTimeout(r, 5));
  }

  channelIds(): Hex[] {
    return [...this.live.keys()];
  }

  /** Direct access to a channel's session and senders — for tests and tooling, not for the agent API. */
  handle(id: Hex): ChannelHandle {
    const l = this.live.get(id);
    if (!l) throw new DaemonError(404, `unknown channel ${id}`);
    return l;
  }

  // ------------------------------------------------------------------ lobby

  /**
   * Task 2 (spec §13): refuses a deposit the hub would refuse right now -- paused (checked first, mirroring
   * `ChannelHub.deposit`'s own check order) or over `maxDepositPerPlayer` -- before any funds move or any
   * signature is produced. Shared by `createOffer`, `acceptOffer` and `onMatch`.
   *
   * Final review I1/m9: with `escrow`, also the total commitment cap -- `committedEscrow + 2 * (deposit + fee)` must
   * fit under `maxCommittedEscrow`, where `fee` is the hub's current `feePerPlayer`. Only `createOffer` and
   * `acceptOffer` pass it: the commitment changes with every channel on the hub, so at match time the hub itself
   * decides (a refused deposit backs off, see `fund`).
   */
  private async checkDepositAllowed(deposit: bigint, opts: { escrow?: boolean } = {}): Promise<void> {
    const limits = await this.hub.limits();
    if (limits.paused) throw new DaemonError(409, "the hub is paused: no new channels");
    if (deposit > limits.maxDepositPerPlayer) {
      throw new DaemonError(
        400,
        `deposit exceeds the hub's per-player cap of ${limits.maxDepositPerPlayer} base units`,
      );
    }
    if (opts.escrow) {
      const { feePerPlayer } = await this.hub.feeConfig();
      const needed = 2n * (deposit + feePerPlayer);
      if (limits.committedEscrow + needed > limits.maxCommittedEscrow) {
        throw new DaemonError(
          409,
          `the hub's escrow cap is reached: this channel would commit ${needed} base units, and only ${
            limits.maxCommittedEscrow > limits.committedEscrow ? limits.maxCommittedEscrow - limits.committedEscrow : 0n
          } of the ${limits.maxCommittedEscrow} cap are free`,
        );
      }
    }
  }

  /** Final review I4: refuses a `challengeTimeout` under this daemon's `minChallengeTimeout`. Missing a challenge
   *  deadline can cost more than one stake (the challenger may time out on an old state), and a daemon restart, an
   *  RPC outage or an agent that must move under a challenge can all take longer than the hub's 60 s minimum. */
  private checkChallengeTimeout(challengeTimeout: bigint): void {
    const min = minChallengeTimeoutOf(this.opts.config);
    if (challengeTimeout < min) {
      throw new DaemonError(
        400,
        `challengeTimeout ${challengeTimeout}s is below this daemon's minimum of ${min}s (minChallengeTimeout): a shorter window risks missing a challenge deadline`,
      );
    }
  }

  async createOffer(o: { deposit: bigint; stakePerGame: bigint; challengeTimeout?: bigint }): Promise<{ offerId: Hex }> {
    // Plan 4.5 Task 11 fix round (C2): once the host has refused a subscribe, this connection's match delivery is
    // broken until restart -- a new offer would post fine (200) and then silently never learn of its match if it
    // is the offerer. Refuse up front instead of returning a false 200.
    this.checkLobbyHealthy();
    // I4: refuse offers the hub would never let anyone fund (ChannelHub rejects these params on deposit), so a
    // matched channel can never sit unfundable while its deposit reverts on every tick.
    if (o.stakePerGame <= 0n) throw new DaemonError(400, "stakePerGame must be greater than 0");
    if (o.deposit < o.stakePerGame) throw new DaemonError(400, "deposit must be at least stakePerGame");
    // Plan 5 Task 1 (mainnet gates: offer default timeout): an omitted challengeTimeout takes this daemon's own
    // minChallengeTimeout -- always at or above the floor `checkChallengeTimeout` enforces just below, so this
    // daemon's own default offer is always accepted by itself and by any peer at the same floor.
    const challengeTimeout = o.challengeTimeout ?? minChallengeTimeoutOf(this.opts.config);
    const bounds = await this.hub.timeoutBounds();
    if (challengeTimeout < bounds.min || challengeTimeout > bounds.max) {
      throw new DaemonError(400, `challengeTimeout must be between ${bounds.min} and ${bounds.max} seconds`);
    }
    this.checkChallengeTimeout(challengeTimeout);
    await this.checkDepositAllowed(o.deposit, { escrow: true });
    const sessionKey = generatePrivateKey();
    // R1 deviation (Task 7 review): expiresAt must be measured on the same clock `onMatch` checks it against
    // (the chain's block timestamp), not wall-clock Date.now() — a test (or a real deployment) that has moved
    // the chain clock away from wall-clock time via increaseTime/other activity would otherwise mint offers
    // that read as already expired the instant they're matched.
    const chainNow = (await this.client.getBlock()).timestamp;
    const offer: Offer = {
      template: "chess",
      player: this.wallet.address,
      signer: privateKeyToAccount(sessionKey).address,
      deposit: o.deposit,
      stakePerGame: o.stakePerGame,
      challengeTimeout,
      expiresAt: chainNow + 3600n,
      nonce: `0x${randomBytes(32).toString("hex")}`,
    };
    const id = computeOfferId(offer);
    this.records.saveOffer({ offerId: id, offer, sessionKey, role: "offerer" });
    try {
      await this.opts.lobby.postOffer({ offer, sig: await signOffer(sessionKey, offer) });
    } catch (err) {
      // M12: an offer the host refused can never be matched; a record left behind would be watched forever
      this.records.removeOffer(id);
      throw err;
    }
    // M5: `postOffer` above already calls `watch([id])` on success -- a second call here was a harmless but
    // pointless duplicate subscribe frame.
    return { offerId: id };
  }

  async listOffers(): Promise<Array<{ offerId: Hex; offer: Offer; mine: boolean }>> {
    const offers = await this.opts.lobby.listOffers();
    return offers.map((so) => ({
      offerId: computeOfferId(so.offer),
      offer: so.offer,
      mine: so.offer.player.toLowerCase() === this.wallet.address.toLowerCase(),
    }));
  }

  async acceptOffer(offerIdInput: Hex): Promise<void> {
    // Plan 4.5 Task 11 fix round (C2): see createOffer's identical guard.
    this.checkLobbyHealthy();
    const offerId = (typeof offerIdInput === "string" ? offerIdInput.toLowerCase() : "") as Hex;
    if (!isCanonicalId(offerId)) throw new DaemonError(400, "offerId must be 0x followed by 64 hex characters");
    // Guards against two concurrent acceptOffer calls for the same offer both reaching the host (M-carry):
    // the loser fails fast here instead of racing the winner through listOffers()/sign/accept below.
    if (this.accepting.has(offerId)) throw new DaemonError(409, `offer ${offerId} is already being accepted`);
    this.accepting.add(offerId);
    try {
      // M-d: accepting is idempotent — an existing acceptance is never replaced by one under a new session key
      // (the host may already have matched the first one; a new key would make this daemon reject that match).
      const channel = this.channelForOffer(offerId);
      if (channel) throw new DaemonError(409, `offer ${offerId} was already accepted (channel ${channel})`);
      const existing = this.records.offer(offerId);
      if (existing) {
        if (existing.role !== "accepter") throw new DaemonError(400, "cannot accept your own offer");
        if (!existing.acceptance) throw new DaemonError(409, `offer ${offerId} was already accepted`);
        // A retry re-sends the stored acceptance: same session key, same signature.
        try {
          await this.opts.lobby.accept(existing.acceptance);
        } catch (err) {
          throw new DaemonError(409, `offer ${offerId} was already accepted; the host did not take it again: ${errorText(err)}`);
        }
        // M5: `accept` above already calls `watch([offerId])` on success.
        return;
      }
      const so = (await this.opts.lobby.listOffers()).find((o) => computeOfferId(o.offer) === offerId);
      if (!so) throw new DaemonError(404, `offer ${offerId} not found`);
      // Final review m6: the offer comes from the host's list. Its signature must be the offerer's session key's
      // before anything is recorded or signed: the opponent binding (checkMatchParams' `opponent`) then binds to a
      // seat the offerer really asked for, not to whatever the host says.
      if (!(await verifyOffer(so))) {
        throw new DaemonError(409, `offer ${offerId}: its signature does not verify (the host served an offer its signer never signed)`);
      }
      if (so.offer.player.toLowerCase() === this.wallet.address.toLowerCase()) {
        throw new DaemonError(400, "cannot accept your own offer");
      }
      // Final review I4: the offerer picks the timeout; a hostile 60 s one must not be accepted.
      this.checkChallengeTimeout(so.offer.challengeTimeout);
      // Task 2 (spec §13): before generating a session key or signing anything.
      await this.checkDepositAllowed(so.offer.deposit, { escrow: true });
      const sessionKey = generatePrivateKey();
      const acceptance = {
        offerId,
        player: this.wallet.address,
        signer: privateKeyToAccount(sessionKey).address,
        nonce: `0x${randomBytes(32).toString("hex")}` as Hex,
      };
      const signed = { acceptance, sig: await signAcceptance(sessionKey, acceptance) };
      // Crash ordering: the record (with the signed acceptance) is on disk before the acceptance leaves.
      this.records.saveOffer({ offerId, offer: so.offer, sessionKey, role: "accepter", acceptance: signed });
      await this.opts.lobby.accept(signed);
      // M5: `accept` above already calls `watch([offerId])` on success.
    } finally {
      this.accepting.delete(offerId);
    }
  }

  private async onMatch(m: MatchEvent): Promise<void> {
    if (this.stopped) return;
    // C1: `m.offerId` comes from the host and serves both as the claim key below and as a file name. Accept only
    // the canonical form, so an alias (`./0x…`, `.//0x…`, upper-case hex, …) can neither slip past the claim nor
    // resolve, via path joining, to the same offer file as the canonical id.
    const offerId = m.offerId;
    if (!isCanonicalId(offerId)) {
      this.log(`ignoring match: malformed offerId ${JSON.stringify(String(offerId)).slice(0, 80)}`);
      return;
    }
    // Plan 4.5 Task 11 fix round (C2, the load-bearing fix): an offer matches at most once, ever (C1's invariant
    // below), so any match event for it -- opened, already open, refused for any reason, even a malformed or
    // duplicate one -- means its watch slot will never be needed again. Unwatch unconditionally and first, before
    // any branch below, so no path (including one this daemon ultimately ignores) can leak it. Leaving a matched
    // offer watched forever is exactly what exhausted the host connection's per-connection watch-slot cap and
    // left this daemon permanently unable to hear of new matches as an offerer -- see the Task 11 report.
    this.opts.lobby.unwatch([offerId]);
    // I3: claim the offerId synchronously, before any await, so a second match event for the same offer
    // (concurrent or back-to-back) bails here instead of racing this call to open a second channel.
    if (this.claiming.has(offerId)) return;
    this.claiming.add(offerId);
    // I3: released on every path that does not end in removeOffer() below (i.e. every rejection or error),
    // so a later, corrected match event for the same offer can still be considered.
    let claimed = true;
    const release = () => {
      if (claimed) {
        this.claiming.delete(offerId);
        claimed = false;
      }
    };
    try {
      // Plan 4.5 Task 10 review: a retried match whose channel record is already on disk but not live (openChannel
      // failed after the record was saved) opens that channel now, instead of being ignored as a duplicate.
      const recorded = this.channelForOffer(offerId);
      if (recorded && !this.live.has(recorded)) {
        const r = this.records.channel(recorded);
        if (r && !r.finalized && !this.degraded.has(recorded)) {
          try {
            await this.openChannel(r);
            this.openFailures.delete(recorded);
          } catch (err) {
            // Plan 4.5 Task 10 re-review (M5): a channel that keeps failing to open is reported as degraded (like one
            // that fails to load at start()) instead of being retried on every tick forever.
            const failures = (this.openFailures.get(recorded) ?? 0) + 1;
            if (failures < MAX_OPEN_ATTEMPTS) {
              this.openFailures.set(recorded, failures);
              throw err; // retried on the next tick
            }
            this.openFailures.delete(recorded);
            this.markDegraded(recorded, `could not be opened after ${failures} attempts: ${errorText(err)}`);
            return release();
          }
          this.notify();
          void this.tick();
        }
        return release();
      }
      const rec = this.records.offer(offerId);
      if (!rec) return release();
      // C1: the stored offer must be the one this id names (a record filed under the wrong name is never used).
      if (computeOfferId(rec.offer) !== offerId) {
        this.log(`ignoring match for offer ${offerId}: the stored offer does not hash to this id`);
        return release();
      }
      // C1: one offer funds at most one channel. Also covers a crash (or fs failure) between saveChannel and
      // removeOffer below, which would otherwise leave the offer record behind for a second match.
      const existing = this.channelForOffer(offerId);
      if (existing) {
        this.log(`ignoring match for offer ${offerId}: channel ${existing} already exists for it`);
        return release();
      }
      // I2: never trust the host's participant/signer ordering in m.params — derive `me` from which role this
      // player took when it created or accepted the offer, so a host that swaps indices is caught below by
      // checkMatchParams (params[me] no longer names this player's wallet/signer) rather than trusted.
      const me = rec.role === "offerer" ? 0 : 1;
      const signer = privateKeyToAccount(rec.sessionKey).address;
      const fee = await this.hub.feeConfig();
      if (this.stopped) return release();
      const now = (await this.client.getBlock()).timestamp;
      // M4/I5: an offer the host matched after it expired must never be funded. Judged at match time, not now: the
      // host sets fundingDeadline = matchTime + fundingWindow (at most MAX_FUNDING_WINDOW), so a deadline beyond
      // expiresAt + MAX_FUNDING_WINDOW proves a late match, while an offerer who comes back after expiresAt to a
      // match made in time still funds (checkMatchParams below still requires fundingDeadline > now).
      if (m.params.fundingDeadline > rec.offer.expiresAt + MAX_FUNDING_WINDOW) {
        this.log(`ignoring match for offer ${offerId}: it was matched after the offer expired`);
        return release();
      }
      // M3: fee equality — accept only the hub's current fee, and only if it is within this player's ceiling.
      const maxFeePerPlayer = fee.feePerPlayer < this.opts.config.maxFeePerPlayer ? fee.feePerPlayer : this.opts.config.maxFeePerPlayer;
      const problem = checkMatchParams(m.params, {
        me,
        player: this.wallet.address,
        signer,
        rules: this.opts.config.rules,
        deposit: rec.offer.deposit,
        stakePerGame: rec.offer.stakePerGame,
        challengeTimeout: rec.offer.challengeTimeout,
        feeRecipient: fee.feeRecipient,
        minFeePerPlayer: fee.feePerPlayer,
        maxFeePerPlayer,
        now,
        maxFundingWindow: MAX_FUNDING_WINDOW,
        // Plan 4.5 Task 9: the accepter accepted one specific signed offer, so it also binds the offerer's seat to
        // that offer's wallet and session key -- a host must not be able to seat someone else opposite it (who
        // would then fund first, exactly as the watchtower waits for). The offerer cannot know its accepter in
        // advance: any accepter may match its open offer.
        opponent: rec.role === "accepter" ? { player: rec.offer.player, signer: rec.offer.signer } : undefined,
      });
      if (problem) {
        this.log(`ignoring match for offer ${offerId}: ${problem}`);
        return release();
      }
      // Final review I4: createOffer/acceptOffer refuse a short timeout, but the floor may have been raised since
      // (a restart with a new config): a match below it is never funded.
      if (m.params.challengeTimeout < minChallengeTimeoutOf(this.opts.config)) {
        this.log(
          `ignoring match for offer ${offerId}: challengeTimeout ${m.params.challengeTimeout}s is below this daemon's minChallengeTimeout (${minChallengeTimeoutOf(this.opts.config)}s)`,
        );
        return release();
      }
      // Task 2 (spec §13): a match the hub would now refuse to fund (paused, or the offer's deposit is now over
      // the per-player cap) can never open -- ignore it rather than create an unfundable channel record.
      try {
        await this.checkDepositAllowed(m.params.deposit);
      } catch (err) {
        // Only a limit refusal is "ignored" here; any other failure (e.g. an RPC blip in hub.limits()) falls
        // through to the outer catch below, which logs it as a match-handling failure, not a hub refusal.
        if (!(err instanceof DaemonError)) throw err;
        this.log(`ignoring match for offer ${offerId}: ${err.message}`);
        return release();
      }
      const id = computeChannelId(this.domain.chainId, this.domain.hub, m.params);
      if (this.live.has(id)) return release();
      if (this.stopped) return release();
      const record: ChannelRecord = {
        channelId: id,
        params: m.params,
        me,
        sessionKey: rec.sessionKey,
        offerId,
        createdBlock: await this.client.getBlockNumber(),
        controller: "agent",
        note: "",
        finalized: false,
      };
      this.records.saveChannel(record);
      this.offerIdIndex.set(offerId, record.channelId);
      this.records.removeOffer(offerId);
      // The offer record is gone and a channel record carries this offerId: a duplicate match event now bails at
      // `!rec` or `channelForOffer` above, so the claim can be released.
      release();
      if (this.stopped) return;
      await this.openChannel(record);
      this.notify();
      void this.tick();
    } catch (err) {
      release();
      if (!this.stopped) this.retryMatches.set(offerId, m);
      this.log(`match handling failed (retried on the next tick): ${errorText(err)}`);
    }
  }

  /** C1: the id of a channel (live, or recorded on disk) that was opened for `offerId`, if any. Plan 4.5 Task 11
   *  fix round (I1/M4): an in-memory lookup (`offerIdIndex`), not a synchronous full disk scan -- see the index's
   *  docstring. */
  private channelForOffer(offerId: Hex): Hex | null {
    return this.offerIdIndex.get(offerId.toLowerCase() as Hex) ?? null;
  }

  /** Plan 4.5 Task 11 fix round (C2): throws if a prior subscribe refusal means this connection can no longer be
   *  trusted to deliver a future match notification -- see `lobbyError`'s docstring. */
  private checkLobbyHealthy(): void {
    if (this.lobbyError) {
      throw new DaemonError(
        503,
        `the host refused this connection's last subscribe (${this.lobbyError}); restart this daemon to recover`,
      );
    }
  }

  private async openChannel(record: ChannelRecord): Promise<void> {
    if (this.stopped) return;
    // I1: a record whose params do not hash to its channelId under this hub/chain (e.g. `arena init` re-run
    // against another deployment) must not be watched under the wrong id — checked before the session store is
    // touched, so no snapshot for another channel is ever written into this channel's directory.
    const expected = computeChannelId(this.domain.chainId, this.domain.hub, record.params);
    if (expected !== record.channelId) {
      throw new Error(`record ${record.channelId} does not match this hub and chain (its params give ${expected})`);
    }
    const store = new FileSessionStore(arenaPaths(this.opts.home).channelSession(record.channelId));
    const session = await ChannelSession.open({
      params: record.params,
      me: record.me,
      sessionKey: record.sessionKey,
      domain: this.domain,
      store,
    });
    // I3/M1: re-check immediately before mutating `live` — the await above is a window another call (or a
    // stop()) could have used to already open this same channel, or to stop the daemon.
    if (this.stopped || this.live.has(record.channelId)) return;
    const sessionSender = new SerialTxSender(
      new LocalKeyTxSender(record.sessionKey, this.opts.config.rpcUrl, this.chain),
      this.client,
      // Round 5: dispute transactions are never refused by a fee ceiling -- only what the session key can pay
      // (its balance) bounds them. The wallet keeps the configured ceiling.
      { feeCeiling: NO_FEE_CEILING },
    );
    const signer = privateKeyToAccount(record.sessionKey);
    const l: ChannelHandle = {
      record,
      session,
      sessionSender,
      processedEvents: 0,
      chain: null,
      lastError: null,
      disputePasses: 0,
      mainPasses: 0,
      lastProgressAt: null,
      progressKey: null,
      autoPlaying: false,
      fundBlockedUntil: null,
      submittingClose: false,
      closeRetryAt: 0,
      disputeBusy: false,
      mainBusy: false,
      refilling: null,
      refills: 0,
      sessionGasLow: null,
      refillBlockedUntil: 0,
      refillBackoffMs: 0,
      refillLastWalletBalance: null,
      sessionGasLowWoken: false,
      settledWake: false,
      settledAt: null,
      sweep: { blockedUntil: 0, backoffMs: 0, attempts: 0 },
    };
    this.live.set(record.channelId, l);
    // Crash recovery / relay reconnect (§7): the re-send of our latest own state and any Close signature is
    // handled uniformly by onJoined() for the first join and for every later reconnect.
    // I4: not awaited -- a slow or silent host must never hold up start() and with it the watchtower.
    this.opts.relay.join(record.channelId, record.params, signer).catch((err: unknown) => {
      if (l.record.finalized) return; // leave() rejected a join still in flight: nothing to report on a settled channel
      l.lastError = `relay: ${errorText(err)}`;
      this.log(`channel ${record.channelId}: ${l.lastError}`);
    });
  }

  /**
   * §7 relay reconnect: re-send this player's latest own-signed state, any pending own checkpoint proposal (the
   * opponent may have missed it), and its Close signature, if any — so a message lost while disconnected (or
   * before the very first join completed) is delivered once the relay confirms membership. Fires on the first
   * join and again on every later reconnect.
   */
  private async onJoined(id: Hex): Promise<void> {
    if (this.stopped) return;
    const l = this.live.get(id);
    if (!l || l.record.finalized) return;
    const snap = l.session.snapshot();
    const me = l.record.me;
    const latest = snap.latest;
    const mine = me === 0 ? latest.sigA : latest.sigB;
    try {
      if (latest.state.turnNum > 0n && mine !== "0x") {
        await this.opts.relay.send({ type: "state", channelId: id, signed: latest });
      }
      if (this.stopped) return;
      if (snap.pendingCheckpoint) {
        await this.opts.relay.send({ type: "state", channelId: id, signed: snap.pendingCheckpoint });
      }
      if (this.stopped) return;
      const closeSig = snap.closeSigs[me];
      if (closeSig !== "0x") {
        // Older snapshots (written before closeSigTargets existed) default that field to the zero hash on
        // load — recompute the hash from closeState rather than re-send a target that can no longer verify.
        const target = snap.closeSigTargets[me];
        const stateHash =
          target !== ZERO_HASH ? target : hashState((snap.closeState ?? snap.latest).state, this.domain);
        await this.opts.relay.send({ type: "close", channelId: id, close: { stateHash, by: me, sig: closeSig } });
      }
      // A join failure recorded here earlier (e.g. the first join at start(), or a previous reconnect) no
      // longer applies once a re-send round trips successfully.
      if (l.lastError?.startsWith("relay:")) l.lastError = null;
    } catch (err) {
      l.lastError = `relay: ${errorText(err)}`;
    }
  }

  /** Approve this deposit, give the session key gas for disputes, then deposit (spec §3.1, §5). */
  protected async fund(l: ChannelHandle): Promise<void> {
    if (this.stopped) return;
    const p = l.record.params;
    // Plan 4.5 Task 10: read the allowance every time instead of remembering "approved" in memory -- a reorg can
    // drop the approve transaction (and a wallet owner can revoke it), after which a remembered flag would make
    // every later deposit revert on the allowance until the daemon restarts. fund() only runs while this player
    // still owes a deposit, so the extra read is rare.
    const allowance = await this.client.readContract({
      address: this.opts.config.usdc,
      abi: erc20Abi,
      functionName: "allowance",
      args: [this.wallet.address, this.opts.config.hub],
    });
    if (allowance < p.deposit + p.feePerPlayer) {
      if (this.stopped) return;
      // Final review I2: exactly what this deposit pulls, never an unlimited allowance. The hub address may come from
      // the host's /templates; a wrong or hostile "hub" given maxUint256 could take the whole wallet, not one deposit.
      // Costs one approve per channel.
      await this.hub.approve(this.wallet, this.opts.config.usdc, p.deposit + p.feePerPlayer);
    }
    if (this.stopped) return;
    // I1: top up only the shortfall, and only while the session key is actually below the target -- otherwise a
    // deposit that keeps reverting (e.g. insufficient USDC) tops up the session key on every tick forever. Shared
    // with the refill (final review C1), so the two never both send one.
    await this.sharedTopUp(l, () => this.topUpSession(l));
    if (this.stopped) return;
    try {
      await this.hub.deposit(this.wallet, p);
    } catch (err) {
      // Task 2 (spec §13): a revert caused by a launch limit is not a bug -- it can resolve itself (the owner
      // raises a cap or unpauses) or never resolve (reclaim after the deadline). Either way, retrying it on every
      // tick is a hot loop against the RPC/chain for no benefit, so back off instead of rethrowing.
      if (err instanceof HubRevertError && err.errorName && LIMIT_REVERTS.has(err.errorName)) {
        l.lastError = `funding: ${err.errorName}`;
        const chainNow = (await this.client.getBlock()).timestamp;
        l.fundBlockedUntil = chainNow + FUND_BACKOFF_SECONDS;
        return;
      }
      throw err;
    }
    l.fundBlockedUntil = null;
    if (l.lastError?.startsWith("funding:")) l.lastError = null;
  }

  /** Runs `work` as this channel's one session-key top-up at a time (final review C1): a caller that finds one in
   *  flight waits for it instead of starting its own. */
  private sharedTopUp(l: ChannelHandle, work: () => Promise<unknown>): Promise<void> {
    if (!l.refilling) {
      l.refilling = work()
        .then(() => undefined)
        .finally(() => {
          l.refilling = null;
        });
    }
    return l.refilling;
  }

  /**
   * Sends the session key the shortfall up to `sessionGasWei` from the wallet, if it is below it. The balance is read
   * afresh right before the send (a resend after a reported drop included), so a top-up that landed after all is
   * never paid twice, and a resend replaces the dropped attempt at its nonce. Resolves true if it sent one.
   */
  private async topUpSession(l: ChannelHandle): Promise<boolean> {
    const target = this.opts.config.sessionGasWei;
    if (target <= 0n || this.stopped) return false;
    const balance = await this.client.getBalance({ address: l.sessionSender.address });
    if (balance >= target || this.stopped) return false;
    const req = { to: l.sessionSender.address, data: "0x" as Hex, value: target - balance };
    // The wallet's sender tracks its nonces (Plan 4.5 Task 10 round 4): a top-up re-sent after an earlier wait gave
    // up (dropped or stuck) replaces it at its nonce, and one whose nonce turns out used is not re-sent, so it is
    // paid at most once.
    const hash = await this.wallet.send(req);
    // Plan 4.5 Task 10 review: bounded, with drop detection and same-nonce replacement, like every hub write.
    await waitOrReplace(this.client, this.wallet, req, hash, { signal: this.aborter.signal });
    return true;
  }

  /**
   * Final review C1: keeps the session key able to pay for dispute transactions. The key is funded once at funding,
   * and every respond an opponent forces spends from it; a key that can no longer pay cannot answer a stale
   * challenge, and an unanswered one lets the challenger time out on an old state (every game since erased, plus a
   * forfeit). So while the channel is Open or Challenged, a balance below `sessionGasFloor` is refilled from the
   * wallet up to `sessionGasWei`. If the wallet cannot, the channel raises `session-gas-low`. Never throws.
   */
  protected async ensureSessionGas(l: ChannelHandle): Promise<void> {
    if (this.opts.config.sessionGasWei <= 0n || this.stopped || l.record.finalized) return;
    // Plan 5 Task 1 (mainnet gates: refill back-off): back off retrying a channel whose refills keep failing,
    // unless the wallet's own balance has just risen (it may have just been funded) -- checked before the shared
    // top-up below so a blocked channel costs nothing beyond one balance read per pass.
    if (!(await this.refillBackoffGate(l))) return;
    // (A funding top-up in flight that fails is fund()'s to report, not this caller's.)
    await this.sharedTopUp(l, async () => {
      const floor = sessionGasFloorOf(this.opts.config);
      let balance: bigint;
      try {
        balance = await this.client.getBalance({ address: l.sessionSender.address });
      } catch (err) {
        this.log(`channel ${l.record.channelId}: session gas check failed (retried on the next pass): ${errorText(err)}`);
        return;
      }
      if (balance >= floor) {
        this.clearSessionGasLow(l);
        this.endRefillBackoff(l);
        return;
      }
      try {
        if (await this.topUpSession(l)) {
          l.refills++;
          this.log(`channel ${l.record.channelId}: refilled the session key's dispute gas (it was at ${balance} wei, floor ${floor})`);
        }
        this.clearSessionGasLow(l);
        this.endRefillBackoff(l);
      } catch (err) {
        if (this.stopped) return;
        // Plan 5 Task 1 (mainnet gates: session-gas-low precision): raised only when the wallet itself cannot pay
        // (insufficient funds, over its fee cap) or a gas/fee estimate for the refill failed outright -- every
        // other refill error (a nonce race, a dropped/stuck/aborted send, a missing receipt) is transient and
        // re-evaluated on the next pass without alarming the agent over something the daemon may resolve on its own.
        if (
          err instanceof TxInsufficientFundsError ||
          err instanceof TxFeeCapError ||
          err instanceof EstimateGasExecutionError
        ) {
          const first = l.sessionGasLow === null;
          l.sessionGasLow = `the session key holds ${balance} wei, below the floor of ${floor}, and the wallet could not refill it: ${errorText(err)}`;
          this.log(`channel ${l.record.channelId}: ${l.sessionGasLow}`);
          if (first) this.notify();
        } else {
          const name = err instanceof Error ? err.name : "Error";
          this.log(`channel ${l.record.channelId}: refill failed, ${name}: ${errorText(err)} (re-evaluated on the next pass)`);
        }
        this.startOrBumpRefillBackoff(l);
      }
    }).catch(() => undefined);
  }

  /** Plan 5 Task 1: true if `ensureSessionGas` may attempt a refill for `l` right now. False while a prior
   *  failure's back-off has not yet elapsed -- unless the wallet's own balance has risen since it was last
   *  observed, which ends the back-off early (the wallet may have just been topped up). A failed balance read
   *  never blocks the attempt (the back-off is about the refill itself, not about reading the wallet). */
  private async refillBackoffGate(l: ChannelHandle): Promise<boolean> {
    const balance = await this.client.getBalance({ address: this.wallet.address }).catch(() => null);
    if (balance !== null) {
      if (l.refillLastWalletBalance !== null && balance > l.refillLastWalletBalance) this.endRefillBackoff(l);
      l.refillLastWalletBalance = balance;
    }
    return !(l.refillBlockedUntil > 0 && Date.now() < l.refillBlockedUntil);
  }

  /** Plan 5 Task 1: starts (30 s) or doubles (up to 5 min) this channel's refill back-off; logs once, on the
   *  episode's first failure. */
  private startOrBumpRefillBackoff(l: ChannelHandle): void {
    const starting = l.refillBackoffMs === 0;
    l.refillBackoffMs = starting ? BACKOFF_START_MS : Math.min(l.refillBackoffMs * 2, BACKOFF_MAX_MS);
    l.refillBlockedUntil = Date.now() + l.refillBackoffMs;
    if (starting) {
      this.log(`channel ${l.record.channelId}: refill back-off started (retrying in ${l.refillBackoffMs / 1000}s)`);
    }
  }

  /** Plan 5 Task 1: ends this channel's refill back-off episode, if one is running (a successful refill, a
   *  balance already at/above the floor, or the wallet's balance rising); logs once, when it actually ends. */
  private endRefillBackoff(l: ChannelHandle): void {
    if (l.refillBackoffMs === 0) return;
    l.refillBackoffMs = 0;
    l.refillBlockedUntil = 0;
    this.log(`channel ${l.record.channelId}: refill back-off ended`);
  }

  private clearSessionGasLow(l: ChannelHandle): void {
    if (l.sessionGasLow === null) return;
    l.sessionGasLow = null;
    l.sessionGasLowWoken = false;
    this.notify();
  }

  // ------------------------------------------------------------------ sweep (Plan 5 Task 1)

  /** Cached once (round 4, m7): whether `this.wallet.address` holds contract code, so `performSweep` doesn't read
   *  it again for every channel it sweeps. `undefined` = not yet read. */
  private walletHasCode: boolean | undefined;

  private async gasForSweep(sender: SerialTxSender): Promise<bigint> {
    if (this.walletHasCode === undefined) {
      const code = await this.client.getCode({ address: this.wallet.address });
      this.walletHasCode = code !== undefined && code !== "0x";
    }
    // A plain transfer to an EOA always costs exactly 21000 gas; a contract wallet may run more logic (a proxy, a
    // multisig's fallback), so its cost is estimated instead of assumed.
    if (!this.walletHasCode) return 21_000n;
    return this.client.estimateGas({ account: sender.address, to: this.wallet.address, value: 1n });
  }

  private async currentFeePerGas(): Promise<bigint> {
    try {
      const fees = (await this.client.estimateFeesPerGas()) as { maxFeePerGas?: bigint };
      if (fees.maxFeePerGas !== undefined) return fees.maxFeePerGas;
    } catch {
      // fall through to the legacy estimate below
    }
    const legacy = (await this.client.estimateFeesPerGas({ type: "legacy" } as Parameters<PublicClient["estimateFeesPerGas"]>[0])) as {
      gasPrice?: bigint;
    };
    return legacy.gasPrice ?? 0n;
  }

  /**
   * Fix round rule 1: a channel's session gas is only ever swept once a *fresh* on-chain read confirms it is
   * actually settled -- Finalized/Reclaimed, or an unfunded channel (`!funded[record.me]`) past its funding
   * deadline (retired -- see `watch`'s None/Funding branch). `record.finalized` (a local flag, set the moment
   * *this* daemon last observed it) is not enough on its own to authorize sending: it is what the reviewer's
   * repro exploited to make the old `performSweep` operate against a session key another in-flight transaction
   * (a stale respond) still owned.
   */
  private async isSweepable(record: ChannelRecord): Promise<boolean> {
    const info = await this.hub.channelInfo(record.channelId);
    if (info.phase === "Finalized" || info.phase === "Reclaimed") return true;
    if ((info.phase === "None" || info.phase === "Funding") && !info.funded[record.me]) {
      const now = (await this.client.getBlock()).timestamp;
      return now > record.params.fundingDeadline;
    }
    return false;
  }

  /**
   * Fix round rules 2-4, I7: sends `sender`'s whole balance, minus reserved gas headroom, to this daemon's
   * wallet. **Rule 2**: once the channel is confirmed settled (the caller has already checked `isSweepable`), any
   * pending or released transaction on `sender`'s key is a dead intent -- respond/challenge/timeout would all now
   * revert -- so this always sends through `sender.send(req)`, never `waitOrReplace` on a hash it did not just get
   * back from `send`: the nonce manager's own "replace the lowest released entry" path (or "adopt a pool nonce")
   * does the right thing on its own, and a genuine race with something that lands first at that nonce surfaces as
   * `TxNonceUsedError`, not a false success (the reviewer's scenario B: waiting on a stale respond's hash reported
   * that respond's own receipt as if it were the sweep). **Rule 3**: reserves `gas * ceil(feePerGas *
   * SWEEP_HEADROOM_NUM/DEN)` (1.3x), so a single 12.5% same-nonce replacement bump still fits the balance bound;
   * dust if that leaves `<= gas * feePerGas`. Throws if the fee estimate is 0 (nothing reliable to reserve a bump
   * against). **Rule 4**: success requires the mined receipt's `status` to be `"success"` -- a reverted send (a
   * contract-wallet recipient that rejects it) must never be recorded as swept -- and its hash is, structurally,
   * always one this call's own `send`/its replacements produced (waitOrReplace only ever follows the entry seeded
   * by *this* `hash`). **I7**: at most one immediate retry, with fresh reads, on `TxInsufficientFundsError`.
   */
  private async performSweep(sender: SerialTxSender): Promise<{ status: "dust" } | { status: "swept"; amount: bigint; hash: Hex }> {
    for (let attempt = 0; ; attempt++) {
      if (this.stopped) throw new Error("stopped");
      const balance = await this.client.getBalance({ address: sender.address });
      const gasLimit = await this.gasForSweep(sender);
      const feePerGas = await this.currentFeePerGas();
      if (feePerGas === 0n) throw new Error("the fee estimate is 0: refusing to sweep without a reliable fee to reserve a bump against");
      const reservePerGas = (feePerGas * SWEEP_HEADROOM_NUM + (SWEEP_HEADROOM_DEN - 1n)) / SWEEP_HEADROOM_DEN;
      const value = balance - gasLimit * reservePerGas;
      if (value <= gasLimit * feePerGas) return { status: "dust" };
      const req = { to: this.wallet.address, data: "0x" as Hex, value, gas: gasLimit };
      let hash: Hex;
      try {
        hash = await sender.send(req);
      } catch (err) {
        if (err instanceof TxInsufficientFundsError && attempt === 0) continue; // I7: one immediate retry
        throw err;
      }
      const receipt = await waitOrReplace(this.client, sender, req, hash, { signal: this.aborter.signal });
      if (receipt.status !== "success") throw new Error(`sweep transaction ${receipt.transactionHash} reverted`);
      return { status: "swept", amount: value, hash: receipt.transactionHash };
    }
  }

  /**
   * Runs one sweep attempt for `record` through `isSweepable` (rule 1) and `performSweep` (rules 2-4, I7),
   * updating `record`/`backoff` and persisting via `save` on every outcome but a skip. `force` (fix round I5, a
   * manual `arena sweep`/`POST /sweep`) bypasses the back-off's own timing, never the concurrency checks. Never
   * throws.
   */
  private async runSweepAttempt(
    record: ChannelRecord,
    sender: SerialTxSender,
    backoff: { blockedUntil: number; backoffMs: number; attempts: number },
    save: (r: ChannelRecord) => void,
    opts: { force?: boolean } = {},
  ): Promise<SweepAttemptResult> {
    if (this.stopped || record.swept !== undefined) return { kind: "skipped", record };
    if (!opts.force && backoff.blockedUntil > 0 && Date.now() < backoff.blockedUntil) return { kind: "skipped", record };
    // Rule 1: never beside a transaction actively being waited on elsewhere on this same session key.
    if (sender.tracked().some((t) => t.state === "waiting")) return { kind: "skipped", record };
    try {
      if (!(await this.isSweepable(record))) return { kind: "skipped", record };
      const outcome = await this.performSweep(sender);
      if (outcome.status === "dust") {
        const updated: ChannelRecord = { ...record, swept: "dust" };
        save(updated);
        this.endSweepBackoff(record.channelId, backoff);
        return { kind: "dust", record: updated };
      }
      const updated: ChannelRecord = { ...record, swept: true, sweptAmount: outcome.amount, sweptTx: outcome.hash };
      save(updated);
      this.endSweepBackoff(record.channelId, backoff);
      return { kind: "swept", record: updated, amount: outcome.amount, hash: outcome.hash };
    } catch (err) {
      if (this.stopped) return { kind: "skipped", record };
      if (err instanceof TxNonceUsedError) {
        // Rule 4: a foreign transaction landed at that nonce first -- not a failure of ours, just stale info; the
        // next pass re-reads the chain and, if still unswept, tries again fresh. No back-off, no attempt charged.
        this.log(`channel ${record.channelId}: sweep: a foreign transaction landed at that nonce; re-evaluated on the next pass`);
        return { kind: "skipped", record };
      }
      this.log(`channel ${record.channelId}: sweep failed (retried with back-off): ${errorText(err)}`);
      backoff.attempts++;
      if (backoff.attempts >= SWEEP_ABANDON_ATTEMPTS) {
        const updated: ChannelRecord = { ...record, swept: "abandoned" };
        save(updated);
        this.log(`channel ${record.channelId}: sweep abandoned after ${backoff.attempts} failed attempts: its session gas is written off`);
        return { kind: "abandoned", record: updated };
      }
      const starting = backoff.backoffMs === 0;
      backoff.backoffMs = starting ? BACKOFF_START_MS : Math.min(backoff.backoffMs * 2, BACKOFF_MAX_MS);
      backoff.blockedUntil = Date.now() + backoff.backoffMs;
      if (starting) this.log(`channel ${record.channelId}: sweep back-off started (retrying in ${backoff.backoffMs / 1000}s)`);
      return { kind: "error", record, error: err };
    }
  }

  private endSweepBackoff(channelId: Hex, backoff: { blockedUntil: number; backoffMs: number; attempts: number }): void {
    const wasBackedOff = backoff.backoffMs !== 0;
    backoff.backoffMs = 0;
    backoff.blockedUntil = 0;
    backoff.attempts = 0;
    if (wasBackedOff) this.log(`channel ${channelId}: sweep back-off ended`);
  }

  /** The main pass's own sweep of one live, finalized, not-yet-swept channel -- never sets `lastError` (the
   *  channel is already settled; nothing would ever clear it again -- see `markFinalized`'s own note on the same
   *  point). Rule 1: skipped (no attempt, no back-off charged) while a refill or the dispute pass is still
   *  working this channel's session key. */
  protected async sweepChannel(l: ChannelHandle): Promise<void> {
    if (this.stopped || l.record.swept !== undefined) return;
    if (l.refilling || l.disputeBusy) return;
    const result = await this.runSweepAttempt(l.record, l.sessionSender, l.sweep, (r) => this.records.saveChannel(r));
    l.record = result.record;
  }

  /** Plan 5 fix round (I2): the sweep queue -- finalized-but-unswept records found at start() (a restart, or a
   *  record written before this feature existed), never opened into `live`. Removed once swept. A separate,
   *  protected method (like `sweepChannel`) so a test can stub it out, e.g. to keep a manual `sweep()` call from
   *  racing the periodic main pass's own processing of the very record it is about to sweep. */
  protected async sweepQueuePass(): Promise<void> {
    for (const [qid, entry] of [...this.sweepQueue]) {
      if (this.stopped) break;
      if (entry.busy) continue;
      entry.busy = true;
      try {
        const result = await this.runSweepAttempt(entry.record, entry.sender, entry.sweep, (r) => this.records.saveChannel(r));
        entry.record = result.record;
        if (entry.record.swept !== undefined) {
          this.sweepQueue.delete(qid);
          // The settled index cached a status for this record at start() (before it was swept); refresh it in
          // place so `status`/`channels()` show the outcome without waiting for a restart.
          const cached = this.settled.get(qid);
          if (cached) {
            cached.status = {
              ...cached.status,
              swept: entry.record.swept ?? null,
              sweptAmount: entry.record.sweptAmount?.toString() ?? null,
              sweptTx: entry.record.sweptTx ?? null,
            };
          }
        }
      } finally {
        entry.busy = false;
      }
    }
  }

  /**
   * `arena sweep` / `POST /sweep`: sweeps every settled channel whose record has `swept` unset -- live ones (using
   * their existing session sender/back-off) and legacy ones no longer in `live` (a fresh sender built from the
   * record's `sessionKey`), including records written before this feature existed. `ref`, if given, narrows to
   * channel ids starting with it (as `pick` does). Never throws for one channel's own failure -- each result
   * reports its own outcome, `"error: …"` included.
   */
  async sweep(ref?: string): Promise<Array<{ channelId: Hex; swept: string }>> {
    const want = ref?.toLowerCase();
    const records = this.records.channels().filter((r) => r.finalized && r.swept === undefined);
    const targets = want ? records.filter((r) => r.channelId.toLowerCase().startsWith(want)) : records;
    if (want && targets.length === 0) throw new DaemonError(404, `no settled, unswept channel matches ${ref}`);
    const results: Array<{ channelId: Hex; swept: string }> = [];
    for (const record of targets) {
      const l = this.live.get(record.channelId);
      // Fix round I2: a queued (restart-time) record shares the queue's own sender/back-off, rather than a fresh
      // `SerialTxSender` on the same key that knows nothing of what the queue's own pass may have already sent.
      const queued = this.sweepQueue.get(record.channelId);
      const sender =
        l?.sessionSender ??
        queued?.sender ??
        new SerialTxSender(new LocalKeyTxSender(record.sessionKey, this.opts.config.rpcUrl, this.chain), this.client, {
          feeCeiling: NO_FEE_CEILING,
        });
      const backoff = l?.sweep ?? queued?.sweep ?? { blockedUntil: 0, backoffMs: 0, attempts: 0 };
      const result = await this.runSweepAttempt(record, sender, backoff, (r) => this.records.saveChannel(r), { force: true });
      if (l) l.record = result.record;
      if (queued) {
        queued.record = result.record;
        if (queued.record.swept !== undefined) this.sweepQueue.delete(record.channelId);
      }
      results.push(this.sweepResultToString(record.channelId, result));
    }
    return results;
  }

  private sweepResultToString(id: Hex, result: SweepAttemptResult): { channelId: Hex; swept: string } {
    switch (result.kind) {
      case "swept":
        return { channelId: id, swept: `0x${result.amount.toString(16)}` };
      case "dust":
        return { channelId: id, swept: "dust" };
      case "abandoned":
        return { channelId: id, swept: "abandoned" };
      case "error":
        return { channelId: id, swept: `error: ${errorText(result.error)}` };
      case "skipped":
        return {
          channelId: id,
          swept: "error: not sweepable yet (on-chain state doesn't show it settled, or another send is in flight): retry shortly",
        };
    }
  }

  // ------------------------------------------------------------------ relay

  private async onRelay(msg: RelayMessage): Promise<void> {
    if (this.stopped) return;
    const l = this.live.get(msg.channelId);
    if (!l) return;
    let closeReceived = false;
    try {
      if (msg.type === "state") {
        // A re-send after a reconnect (§7) can land as "duplicate" (we already hold it) or "stale" (we've moved
        // past it): both are success, not an error, and neither needs an autoPlay pass.
        const result = await l.session.receive(msg.signed);
        if (this.stopped) return;
        if (result !== "duplicate" && result !== "stale") await this.autoPlay(l);
      } else {
        await l.session.receiveClose(msg.close);
        closeReceived = true;
      }
      l.lastError = null;
    } catch (err) {
      l.lastError = errorText(err);
      this.log(`channel ${msg.channelId}: ${l.lastError}`);
    }
    if (this.stopped) return;
    // A failed submission is recorded as `close:` by trySubmitClose and retried by the watchtower.
    if (closeReceived) await this.trySubmitClose(l).catch(() => undefined);
    if (this.stopped) return;
    this.notify();
  }

  /** Spec §6.3: sign RESIGN when checkmated and CLAIM_STALEMATE when stalemated, regardless of controller. */
  /** `inDispute`: called by the dispute pass, which already holds the channel's `disputeBusy`. */
  protected async autoPlay(l: ChannelHandle, inDispute = false): Promise<void> {
    if (l.autoPlaying) return; // the run in progress will finish the job
    l.autoPlaying = true;
    try {
      if (!l.session.isMyTurn()) return;
      const o = outcome(l.session.latest.state);
      if (o === "checkmate") await this.sendState(l, await l.session.resign(), inDispute);
      else if (o === "stalemate") await this.sendState(l, await l.session.claimStalemate(), inDispute);
    } finally {
      l.autoPlaying = false;
    }
  }

  protected async sendState(l: ChannelHandle, signed: SignedState, inDispute = false): Promise<void> {
    await this.opts.relay.send({ type: "state", channelId: l.record.channelId, signed }).catch((err) => {
      l.lastError = `relay: ${errorText(err)}`;
    });
    // Plan 4.5 Task 10: the state is signed, persisted and relayed by now, so a failure of the follow-up
    // "is a challenge pending?" read (an RPC blip) must not fail the move, resign or accept that produced it -- an
    // agent told its move failed retries it and gets "not your turn". The watchtower's Challenged branch answers
    // any pending challenge on its next pass; a failed respond transaction still sets `respond:` (in
    // respondIfChallenged), only the chain reads around it are logged here instead.
    // Plan 4.5 Task 10 round 4: one respond per channel at a time. While the dispute pass works on this channel, it
    // answers any pending challenge itself (on this pass or its next one), so the move path does not.
    if (!inDispute && l.disputeBusy) {
      this.log(`channel ${l.record.channelId}: the dispute pass is working on this channel; it answers any challenge`);
      return;
    }
    if (!inDispute) l.disputeBusy = true;
    try {
      await this.respondIfChallenged(l);
    } catch (err) {
      this.log(`channel ${l.record.channelId}: challenge check after sending turn ${signed.state.turnNum} failed (the watchtower retries): ${errorText(err)}`);
    } finally {
      if (!inDispute) l.disputeBusy = false;
    }
  }

  /** If a challenge is pending and we now hold a newer supported state, answer it on-chain from the session key. */
  protected async respondIfChallenged(l: ChannelHandle): Promise<void> {
    const id = l.record.channelId;
    const info = await this.hub.channelInfo(id);
    if (info.phase !== "Challenged") return;
    const registered = await this.hub.registeredState(id);
    if (l.session.latest.state.turnNum <= registered.turnNum) return;
    const now = (await this.client.getBlock()).timestamp;
    // Plan 4.5 Task 10 re-review (I2): past the deadline a respond can no longer help, so its wait stops there.
    const giveUpAt = Date.now() + Number(info.deadline > now ? info.deadline - now : 0n) * 1000;
    try {
      // A respond whose wait gave up is released by the session key's sender: the next dispute transaction (this
      // respond again, or a timeout) replaces it at its nonce with higher fees (Plan 4.5 Task 10 round 4).
      await this.hub.respond(l.sessionSender, l.session.challengeProof(), {
        receiptTimeoutMs: this.disputeReceiptTimeoutMs(info.deadline, now),
        giveUpAt,
      });
    } catch (err) {
      // Plan 4.5 Task 8: both players' daemons can answer the same challenge (the mover right after its move, the
      // challenger's own watchtower once the relay delivers that move), and the loser's respond reverts because the
      // winner's already returned the channel to Open. The challenge is answered either way, so a hub revert on a
      // channel that is Open again is not surfaced as lastError (nothing would clear it on a quiet channel) -- but
      // it is always logged, with both turns, because the registered state can legitimately be older than ours
      // (the winner answered with the state it held), which also means a genuinely bad proof of ours would only
      // show up here. A failure that is not a hub revert (transport, our own gas) is always this daemon's problem.
      // A respond reported dropped, whose nonce turned out used (an earlier transaction of this session key landed
      // there), or mined with its receipt unreadable, may have answered the challenge after all -- the same check
      // applies (Plan 4.5 Task 10 round 4).
      const after =
        err instanceof HubRevertError ||
        err instanceof TxDroppedError ||
        err instanceof TxNonceUsedError ||
        err instanceof TxReceiptMissingError
          ? await this.hub.channelInfo(id).catch(() => null)
          : null;
      if (after?.phase !== "Open") {
        l.lastError = `respond: ${errorText(err)}`;
        return;
      }
      const reg = await this.hub.registeredState(id).then(
        (s) => s.turnNum.toString(),
        () => "unknown",
      );
      this.log(
        `channel ${id}: respond reverted but the challenge was already answered (registered turn ${reg}, ours ${l.session.latest.state.turnNum}): ${errorText(err)}`,
      );
    }
    if (l.lastError?.startsWith("respond:")) l.lastError = null;
  }

  /**
   * Submits the cooperative close once this player holds both Close signatures. Called when the second signature
   * arrives (relay or the close API) and, Plan 4.5 Task 10, again on every watchtower pass while the channel is
   * still Open/Challenged -- so a submission that failed on a transient error (an RPC blip on both sides at once)
   * is retried instead of leaving a fully co-signed close unsubmitted until someone runs `arena close` again. A
   * failure is recorded as a `close:` lastError (cleared once a submission goes through) and rethrown.
   */
  private async trySubmitClose(l: ChannelHandle): Promise<void> {
    if (!l.session.closeTransaction() || l.submittingClose) return;
    l.submittingClose = true;
    try {
      await this.submitClose(l);
      l.closeRetryAt = 0;
      if (l.lastError?.startsWith("close:")) l.lastError = null;
    } catch (err) {
      if (err instanceof HubRevertError) l.closeRetryAt = Date.now() + CLOSE_RETRY_BACKOFF_MS;
      // Once settled (the watchtower may have marked it meanwhile), nothing would ever clear the error again.
      if (!l.record.finalized) l.lastError = `close: ${errorText(err)}`;
      this.log(`channel ${l.record.channelId}: submitting the cooperative close failed (the watchtower retries): ${errorText(err)}`);
      throw err;
    } finally {
      l.submittingClose = false;
    }
  }

  private async submitClose(l: ChannelHandle): Promise<void> {
    const tx = l.session.closeTransaction();
    if (!tx) return;
    const info = await this.hub.channelInfo(l.record.channelId);
    if (info.phase !== "Open" && info.phase !== "Challenged") return;
    try {
      await this.hub.closeCooperative(this.wallet, tx);
    } catch (err) {
      // Both sides race to submit the same cooperative close once they hold both signatures (each one's own
      // call, and the other's relayed close message, land within the same window). The loser's simulate can
      // still see phase "Open" (the winner hasn't mined yet), so it only reverts once mined — a status revert
      // with no decodable reason, unlike the (rarer) already-stale-simulate case that decodes as "WrongPhase".
      // Plan 4.5 Task 10: a transport failure is no different -- the transaction may have been sent and mined
      // before the RPC failed (e.g. while waiting for the receipt), or the other side's close landed meanwhile.
      // Either way, once the channel is no longer Open/Challenged, the close already went through: not an error.
      if (err instanceof HubRevertError && err.errorName === "WrongPhase") return;
      const after = await this.hub.channelInfo(l.record.channelId).catch(() => null);
      if (after && after.phase !== "Open" && after.phase !== "Challenged") return;
      throw err;
    }
  }

  // ------------------------------------------------------------------ actions

  async move(ref: string | undefined, input: string, opts: { offerDraw?: boolean; actor: Actor }): Promise<void> {
    const l = this.pick(ref);
    this.requireController(l, opts.actor);
    await this.sendState(l, await this.guard(() => l.session.move(input, { offerDraw: opts.offerDraw })));
    this.notify();
  }

  async resign(ref: string | undefined, actor: Actor): Promise<void> {
    const l = this.pick(ref);
    this.requireController(l, actor);
    await this.sendState(l, await this.guard(() => l.session.resign()));
    this.notify();
  }

  async acceptDraw(ref: string | undefined, actor: Actor): Promise<void> {
    const l = this.pick(ref);
    this.requireController(l, actor);
    await this.sendState(l, await this.guard(() => l.session.acceptDraw()));
    this.notify();
  }

  async nextGame(ref: string | undefined, actor: Actor): Promise<void> {
    const l = this.pick(ref);
    this.requireController(l, actor);
    await this.sendState(l, await this.guard(() => l.session.proposeNewGame()));
    this.notify();
  }

  async close(ref: string | undefined, actor: Actor): Promise<void> {
    const l = this.pick(ref);
    this.requireController(l, actor);
    const cs = await this.guard(() => l.session.signClose());
    await this.opts.relay.send({ type: "close", channelId: l.record.channelId, close: cs }).catch((err) => {
      l.lastError = `relay: ${errorText(err)}`;
    });
    await this.guard(() => this.trySubmitClose(l));
    this.notify();
  }

  async challenge(ref: string | undefined, actor: Actor): Promise<void> {
    const l = this.pick(ref);
    this.requireController(l, actor);
    await this.guard(() => this.hub.challenge(l.sessionSender, l.session.challengeProof()));
    this.notify();
  }

  async reclaim(ref: string | undefined): Promise<void> {
    const l = this.pick(ref);
    // Plan 4.5 Task 10 round 4: never beside the main pass (which reclaims after the funding deadline itself). A main
    // pass visits every channel briefly, so the API waits for it a little before refusing.
    const until = Date.now() + RECLAIM_BUSY_WAIT_MS;
    while (l.mainBusy && Date.now() < until && !this.stopped) await new Promise((r) => setTimeout(r, 20));
    if (l.mainBusy) throw new DaemonError(409, "the watchtower is working on this channel: retry shortly");
    l.mainBusy = true;
    try {
      // R9/I1: dispute operations go through the session key (spec §3.1), so they keep working after the
      // Circle session backing the wallet key has expired.
      await this.guard(() => this.hub.reclaim(l.sessionSender, l.record.channelId));
    } finally {
      l.mainBusy = false;
    }
    this.notify();
  }

  async handoff(ref: string | undefined, to: Controller, note: string): Promise<void> {
    const l = this.pick(ref);
    l.record = { ...l.record, controller: to, note };
    this.records.saveChannel(l.record);
    this.notify();
  }

  // ------------------------------------------------------------------ watchtower (Task 6)

  /** One full watchtower round: the dispute pass, then the main pass (an explicit call, e.g. from a test, runs both
   *  in order; the periodic timer starts them independently). */
  async tick(): Promise<void> {
    await this.disputePass();
    await this.mainPass();
  }

  /**
   * Plan 4.5 Task 10 review -- pass 1, dispute work first: respond, timeout and autoPlay for every channel whose
   * on-chain phase is Challenged, and nothing else. It is started on its own by the timer and guarded per channel,
   * so neither a main pass stalled on a slow funding or close transaction (up to its bounded receipt wait) nor
   * another channel's stuck respond delays answering a challenge before its deadline.
   */
  async disputePass(): Promise<void> {
    if (this.stopped) return;
    // Plan 4.5 Task 10 re-review (I2): channels are handled concurrently -- each has its own session-key sender
    // (its own nonces), so one channel's stuck respond never delays another's -- and there is no pass-wide guard:
    // a channel still busy from an earlier pass is skipped (its per-channel flag), every other one starts now.
    const started: Array<Promise<void>> = [];
    for (const l of this.live.values()) {
      if (l.record.finalized || l.disputeBusy) continue;
      l.disputeBusy = true;
      started.push(
        this.runWatch(l, "disputePasses", () => this.watchDispute(l)).finally(() => {
          l.disputeBusy = false;
        }),
      );
    }
    await Promise.all(started);
    if (!this.stopped) this.notify();
  }

  /** Pass 2: everything else -- offer pruning, funding, reclaim, dispute scans and self-heal for channels that are not
   *  Challenged, the cooperative-close retry -- then the match retries. */
  async mainPass(): Promise<void> {
    if (this.stopped || this.mainTicking) return;
    this.mainTicking = true;
    try {
      // Final review C1: a Challenged channel's session key is refilled first, ahead of all other main-pass work
      // (its respond may be waiting on it). `chain` is the phase as last read; `watch` checks every channel again.
      for (const l of this.live.values()) {
        if (this.stopped) break;
        if (!l.record.finalized && l.chain?.phase === "Challenged") await this.ensureSessionGas(l);
      }
      await this.pruneOffers();
      for (const l of this.live.values()) {
        if (this.stopped) break;
        // Round 4: a channel the reclaim API is working on is skipped (the next pass picks it up).
        if (l.record.finalized || l.mainBusy) continue;
        l.mainBusy = true;
        try {
          await this.runWatch(l, "mainPasses", () => this.watch(l));
        } finally {
          l.mainBusy = false;
        }
      }
      for (const m of [...this.retryMatches.values()]) {
        if (this.stopped) break;
        this.retryMatches.delete(m.offerId);
        await this.onMatch(m);
      }
      // Plan 5 Task 1 (mainnet gates: session-gas sweep): every settled channel not yet swept, before eviction --
      // eviction waits on `swept` being set (see evictSettled), so this must run first in the same pass a channel
      // is first seen settled for the sweep to have a chance to complete inside the grace period.
      for (const l of this.live.values()) {
        if (this.stopped) break;
        if (!l.record.finalized || l.record.swept !== undefined || l.mainBusy) continue;
        l.mainBusy = true;
        try {
          await this.sweepChannel(l);
        } finally {
          l.mainBusy = false;
        }
      }
      await this.sweepQueuePass();
      if (!this.stopped) await this.evictSettled();
    } finally {
      this.mainTicking = false;
      if (!this.stopped) this.notify();
    }
  }

  /**
   * Final review I3: drops settled channels from `live` once they have been settled for `SETTLED_GRACE_SECONDS` of
   * chain time, keeping only their final status. Every handle holds a session, two senders and their viem clients,
   * so without this a long-lived daemon's memory grew with every channel it had ever settled. A channel something is
   * still working on is left for a later pass.
   */
  private async evictSettled(): Promise<void> {
    const done = [...this.live.values()].filter((l) => l.record.finalized);
    if (done.length === 0) return;
    let now: bigint;
    try {
      now = (await this.client.getBlock()).timestamp;
    } catch (err) {
      this.log(`settled-channel eviction skipped (retried on the next pass): ${errorText(err)}`);
      return;
    }
    for (const l of done) {
      if (l.settledAt === null) {
        l.settledAt = now;
        continue;
      }
      if (now - l.settledAt < SETTLED_GRACE_SECONDS) continue;
      // Plan 5 Task 1: eviction waits until the sweep is done (`swept: true`) or declined as dust (`"dust"`) --
      // a channel still unswept (e.g. its sweep is back-off-blocked) is left for a later pass instead of losing
      // its session key (and the gas still on it) with no chance to sweep it again.
      if (l.record.swept === undefined) continue;
      if (l.disputeBusy || l.mainBusy || l.autoPlaying || l.submittingClose || l.refilling) continue;
      const id = l.record.channelId;
      // An unconsumed `settled` wake is dropped with the handle: an agent that has not waited in ten minutes of chain
      // time reads the final phase from status.
      this.insertSettled(id, { ...this.statusOf(l), attention: null }, l.record.settledAt ?? 0);
      this.live.delete(id);
    }
  }

  /** Plan 5 fix round (I4): inserts `status` for `id`, keyed with `settledAt` (wall-clock ms), then trims the
   *  index down to `SETTLED_CACHE_MAX` by dropping the SMALLEST `settledAt` entries -- not insertion order, which
   *  no longer tracks settle time once eviction timing varies (a channel something was still busy with, evicted
   *  later than one that settled after it, would otherwise be the one kept). Protected so a test can exercise the
   *  trim at scale without needing thousands of real channels. */
  protected insertSettled(id: Hex, status: ChannelStatus, settledAt: number): void {
    this.settled.set(id, { status, settledAt });
    while (this.settled.size > SETTLED_CACHE_MAX) {
      let oldestId: Hex | undefined;
      let oldestAt = Infinity;
      for (const [k, v] of this.settled) {
        if (v.settledAt < oldestAt) {
          oldestAt = v.settledAt;
          oldestId = k;
        }
      }
      if (oldestId === undefined) break;
      this.settled.delete(oldestId);
    }
  }

  /** Final review I3 / Plan 5 Task 1: rebuilds a finalized channel's status from its files on disk (no chain
   *  reads) -- used both by `settledStatus`'s disk fallback and by `start()`'s settled index. Null for a record
   *  with no session snapshot, or one for another hub/chain (see `openChannel`'s identical check). */
  private async loadSettledStatus(record: ChannelRecord): Promise<ChannelStatus | null> {
    // Read only: restored into a memory store (open() would create a session file if there were none).
    const snapshot = await new FileSessionStore(arenaPaths(this.opts.home).channelSession(record.channelId)).load();
    if (!snapshot) return null;
    let session: ChannelSession;
    try {
      session = ChannelSession.restore(
        { params: record.params, me: record.me, sessionKey: record.sessionKey, domain: this.domain, store: new MemoryStore() },
        snapshot,
      );
    } catch {
      return null; // a record for another hub or chain (see openChannel)
    }
    const chain: ChainView | null = record.finalPhase
      ? {
          phase: record.finalPhase,
          funded: [false, false],
          deadline: 0n,
          challenger: 0,
          registeredTurn: null,
          cooldownUntil: [0n, 0n],
          now: 0n,
        }
      : null;
    return buildStatus({ record, snapshot: session.snapshot(), myTurn: session.isMyTurn(), chain, lastError: null });
  }

  /** Final review I3: the status of a settled channel no longer in `live` -- its cached final status, or, for one
   *  evicted before this process started (or pushed out of the cache), rebuilt from its files on disk. */
  private async settledStatus(ref: string): Promise<ChannelStatus | null> {
    const want = ref.toLowerCase();
    const cached = [...this.settled.values()].map((v) => v.status).filter((st) => st.channelId.toLowerCase().startsWith(want));
    if (cached.length === 1) return cached[0];
    if (cached.length > 1) throw new DaemonError(400, `ambiguous channel ${ref}`);
    const recs = this.records.channels().filter((r) => r.finalized && r.channelId.toLowerCase().startsWith(want));
    if (recs.length !== 1) {
      if (recs.length > 1) throw new DaemonError(400, `ambiguous channel ${ref}`);
      return null;
    }
    return this.loadSettledStatus(recs[0]);
  }

  /** Runs one pass over one channel. `pass` resolves true when it did that channel's full work for its phase. */
  private async runWatch(l: ChannelHandle, counter: "disputePasses" | "mainPasses", pass: () => Promise<boolean>): Promise<void> {
    l[counter]++;
    try {
      // Plan 4.5 Task 10: a pass that got all the way through means an earlier pass's failure (an RPC blip) no
      // longer applies. Without this, a quiet channel kept that error in lastError indefinitely.
      if ((await pass()) && l.lastError?.startsWith("watch:")) l.lastError = null;
    } catch (err) {
      // A pass that settled the channel and then failed on its final bookkeeping read (refreshChain) leaves
      // nothing to retry: the channel is never watched again, so the error would stick. Logged instead.
      if (l.record.finalized) this.log(`channel ${l.record.channelId}: settled; a read after settling failed: ${errorText(err)}`);
      else l.lastError = `watch: ${errorText(err)}`;
      // Round 4: the nonce manager's own outcomes are logged by kind; each is re-evaluated on the next pass (a used
      // nonce or a missing receipt: the chain is re-read; the fee cap or the balance: nothing was sent).
      if (
        err instanceof TxNonceUsedError ||
        err instanceof TxFeeCapError ||
        err instanceof TxInsufficientFundsError ||
        err instanceof TxReceiptMissingError
      ) {
        this.log(`channel ${l.record.channelId}: ${err.name}: ${errorText(err)} (re-evaluated on the next pass)`);
      }
    }
  }

  /** Plan 4.5 Task 10 review: how long a dispute transaction may wait for its receipt before `waitOrReplace` checks
   *  whether it was dropped or must be replaced -- min(30 s, a third of the time left to the deadline), never under
   *  10 s -- so a stuck respond still gets replaced with higher fees in time. */
  private disputeReceiptTimeoutMs(deadline: bigint, now: bigint): number {
    const leftMs = Number(deadline > now ? deadline - now : 0n) * 1000;
    return Math.max(10_000, Math.min(RECEIPT_TIMEOUT_MS, Math.floor(leftMs / 3)));
  }

  /**
   * I3: drops offer records that can no longer produce a fundable match (`expiresAt + MAX_FUNDING_WINDOW` is past)
   * and stops watching them, so expired offers never pile up against the host's per-connection watch limit.
   */
  private async pruneOffers(): Promise<void> {
    try {
      const recs = this.records.offers();
      if (recs.length === 0) return;
      const now = (await this.client.getBlock()).timestamp;
      const dead = recs.filter((r) => r.offer.expiresAt + MAX_FUNDING_WINDOW < now && !this.claiming.has(r.offerId));
      if (dead.length === 0) return;
      for (const r of dead) this.records.removeOffer(r.offerId);
      this.opts.lobby.unwatch(dead.map((r) => r.offerId));
    } catch (err) {
      this.log(`offer pruning failed: ${errorText(err)}`);
    }
  }

  /** Marks a channel settled or retired, persists it, and leaves its relay channel: nothing is sent on it again,
   *  and its slot on the host connection is freed (I2). Idempotent. */
  private markFinalized(l: ChannelHandle, phase: string): void {
    // Transient failures no longer matter once the channel is settled -- a failed close submission (the other
    // side's went through), a failed pass or dispute scan -- and a settled channel is never watched again, so
    // nothing else would ever clear them.
    if (/^(close|watch|events):/.test(l.lastError ?? "")) l.lastError = null;
    if (l.record.finalized) return;
    // Final review m4: an agent waiting after its close (or on a dispute) is woken once by the settlement. A channel
    // retired without our deposit (None/Funding) never opened: nothing to report.
    if (phase === "Finalized" || phase === "Reclaimed") l.settledWake = true;
    // Plan 5 Task 1 (mainnet gates: settled index): recorded so the index start() loads can sort by settle time.
    l.record = { ...l.record, finalized: true, finalPhase: phase, settledAt: Date.now() };
    this.records.saveChannel(l.record);
    this.opts.relay.leave(l.record.channelId);
  }

  /** The main pass for one channel (spec §6.3), regardless of the controller. A Challenged channel belongs to the
   *  dispute pass (`watchDispute`); here it only gets the cooperative-close retry. Resolves true when it did the
   *  channel's full work. */
  protected async watch(l: ChannelHandle): Promise<boolean> {
    const id = l.record.channelId;
    const p = l.record.params;
    const info = await this.hub.channelInfo(id);
    // Final review C1: dispute gas first, whenever the channel can still be disputed.
    if (info.phase === "Open" || info.phase === "Challenged") await this.ensureSessionGas(l);
    if (info.phase === "Challenged") {
      if (l.session.closeTransaction() && Date.now() >= l.closeRetryAt) {
        await this.trySubmitClose(l).catch(() => undefined); // recorded as `close:`
      }
      return false;
    }
    const now = (await this.client.getBlock()).timestamp;
    const me = l.record.me;

    // 1. Funding in order (spec §5), or reclaim after the deadline if this player already funded.
    if (now <= p.fundingDeadline) {
      const wantsToFund =
        (info.phase === "None" && me === 0) ||
        (info.phase === "Funding" && !info.funded[me] && (me === 0 || info.funded[0]));
      // Task 2 (spec §13): a prior funding revert caused by a launch limit backs off for FUND_BACKOFF_SECONDS of
      // chain time -- skip fund() entirely rather than repeat the same revert on every tick.
      const fundBlocked = l.fundBlockedUntil !== null && now < l.fundBlockedUntil;
      if (wantsToFund && !fundBlocked) await this.fund(l);
    } else if (info.phase === "Funding" && info.funded[me]) {
      if (this.stopped) return true;
      // R9/I1: dispute operations go through the session key (spec §3.1), not the wallet.
      await this.hub.reclaim(l.sessionSender, id);
      // Bug fix (Task 6 review): reclaim() always finalizes to "Reclaimed" in the same transaction (see
      // ChannelHub.sol) — mark it here, synchronously with our own confirmed tx, instead of only via the
      // "after" re-read below, which loses a race against a test's own direct-RPC poll under load.
      this.markFinalized(l, "Reclaimed");
    } else if (info.phase === "None" || (info.phase === "Funding" && !info.funded[me])) {
      // I4: the funding window closed and none of our money is in the channel (nobody funded, or only the
      // opponent did — theirs is theirs to reclaim). The channel can never open: retire it (abandoned), so it
      // stops being polled and leaves pick()'s active set. `info` was read before `now`, so confirm on a fresh
      // read taken after the deadline (no deposit can land after it) that ours really is not in — a retired
      // channel is never reclaimed by this daemon.
      if (this.stopped) return true;
      const fresh = await this.hub.channelInfo(id);
      if (!(fresh.phase === "None" || (fresh.phase === "Funding" && !fresh.funded[me]))) return true;
      this.log(`channel ${id}: funding window closed without our deposit; retiring it`);
      this.markFinalized(l, fresh.phase);
      await this.refreshChain(l);
      return true;
    }

    // 2. Adopt on-chain states from dispute events (I3): scan forward from the persisted cursor in bounded chunks
    // (real RPCs cap getLogs ranges), ingest in order, and never move the cursor past an event that failed to
    // ingest. ingestOnChain ignores states it already holds, so re-reading a partly ingested block is harmless.
    if (this.stopped) return true;
    await this.scanDisputes(l);

    // 3. Self-heal (the Challenged branch is the dispute pass's).
    if (this.stopped) return true;
    if (info.phase === "Open") {
      // M-c: self-heal a crash between receiving a mating (or stalemating) move and answering it — the relay
      // path that normally calls autoPlay will not see that move again.
      await this.autoPlay(l);
    }

    // Plan 4.5 Task 10: a fully co-signed close whose submission failed earlier is retried here.
    if (this.stopped) return true;
    if (info.phase === "Open" && l.session.closeTransaction() && Date.now() >= l.closeRetryAt) {
      await this.trySubmitClose(l).catch(() => undefined); // recorded as `close:`; retried on the next pass
    }

    // 4. Settled channels are done.
    if (this.stopped) return true;
    await this.settleCheck(l);
    return true;
  }

  private async settleCheck(l: ChannelHandle): Promise<void> {
    const after = await this.hub.channelInfo(l.record.channelId);
    if (after.phase === "Finalized" || after.phase === "Reclaimed") this.markFinalized(l, after.phase);
    await this.refreshChain(l);
  }

  /** The dispute pass for one channel (spec §6.3): only a Challenged channel -- adopt on-chain states, then respond,
   *  auto-resign/claim, or time out a silent opponent. Resolves false (and does nothing) for any other phase. */
  protected async watchDispute(l: ChannelHandle): Promise<boolean> {
    const id = l.record.channelId;
    const info = await this.hub.channelInfo(id);
    if (info.phase !== "Challenged") return false;
    const now = (await this.client.getBlock()).timestamp;
    const me = l.record.me;
    // The challenge may register a state this player has not seen (e.g. the opponent's move relayed nowhere else).
    if (this.stopped) return true;
    await this.scanDisputes(l);
    if (this.stopped) return true;
    const registered = await this.hub.registeredState(id);
    const latest = l.session.latest.state;
    if (now < info.deadline && latest.turnNum > registered.turnNum) {
      // Stale challenge, and there is still time to answer it: we hold a newer supported state.
      await this.respondIfChallenged(l);
    } else if (latest.turnNum === registered.turnNum && !isGameOver(latest) && mover(latest) === me) {
      // We are on move in the registered state: auto-resign if checkmated, auto-claim if stalemated,
      // otherwise leave it for the controller (status shows mustMove).
      await this.autoPlay(l, true);
    } else if (now >= info.deadline && (isGameOver(registered) || mover(registered) !== me)) {
      // R9/I2: past the deadline, a newer state we hold is no longer answerable (respond would revert
      // DeadlinePassed), so this is the fallback once the respond branch above is no longer available.
      // Never call timeout while we are on move in the registered state — that would forfeit our own
      // stake — so this only fires when the opponent is on move there, or the registered game is over.
      if (this.stopped) return true;
      // R9/I1: dispute operations go through the session key (spec §3.1), not the wallet.
      await this.hub.timeout(l.sessionSender, id, { receiptTimeoutMs: this.disputeReceiptTimeoutMs(info.deadline, now) });
      // Bug fix (Task 6 review): timeout() always finalizes in the same transaction (see ChannelHub.sol) —
      // mark it here, synchronously with our own confirmed tx, rather than waiting for the next tick's
      // re-read below. This narrows, but cannot close, the window for a caller polling the chain directly:
      // `timeout()` itself only resolves one RPC round trip after Anvil mines the tx and flips the on-chain
      // phase, so a direct on-chain read can still observe "Finalized" fractionally before this line runs.
      this.markFinalized(l, "Finalized");
    }
    // Final review C1: the dispute pass refills too (after its own transaction, so a respond it can still pay for
    // is never delayed by the refill's receipt wait): the next challenge must find the key able to pay.
    if (this.stopped) return true;
    if (!l.record.finalized) await this.ensureSessionGas(l);
    if (this.stopped) return true;
    await this.settleCheck(l);
    return true;
  }

  /**
   * I3: scans dispute events forward from the persisted cursor (`record.scannedBlock`, or `createdBlock - 1n`
   * for a channel never scanned before) in chunks of at most `logChunkBlocks` blocks — real RPCs cap the range
   * a single `getLogs` call may cover. Ingests events in order and never advances the cursor past one that
   * failed to ingest (R9/4): it is retried, unskipped, on the next pass. Every scan also re-reads the trailing
   * `DISPUTE_RESCAN_BLOCKS` blocks behind the cursor (never before `createdBlock`), so a `getLogs` result that
   * silently omitted an event on an earlier pass — a load-balanced RPC whose head outran its own log index, or
   * a shallow reorg — still gets a later chance; `ingestOnChain` ignores a state it already holds, so the
   * overlap is harmless.
   */
  private async scanDisputes(l: ChannelHandle): Promise<void> {
    const id = l.record.channelId;
    const size = BigInt(this.opts.config.logChunkBlocks ?? DEFAULT_LOG_CHUNK_BLOCKS);
    const scanned = l.record.scannedBlock ?? l.record.createdBlock - 1n;
    const rescanFrom = scanned + 1n - DISPUTE_RESCAN_BLOCKS;
    const start = rescanFrom > l.record.createdBlock ? rescanFrom : l.record.createdBlock;
    let cursor = scanned; // only moves forward as chunks succeed; a scan with nothing new leaves it unchanged
    try {
      const head = await this.hub.blockNumber();
      // At most 50 chunks per tick, so a long-dormant channel catches up over a few ticks without starving the others.
      for (const r of chunkRanges(start, head, size).slice(0, 50)) {
        if (this.stopped) break;
        const events = await this.hub.disputeEvents(id, r.fromBlock, r.toBlock);
        for (const e of events) {
          try {
            await l.session.ingestOnChain(e.signed);
            l.processedEvents++;
          } catch (err) {
            l.lastError = `ingest: ${errorText(err)}`;
            this.saveCursor(l, e.blockNumber - 1n);
            return;
          }
        }
        cursor = r.toBlock;
      }
      // Saved once for the whole pass (not per chunk): every ingest above already succeeded (or the loop
      // returned early on the first failure), so this is the real, fully-ingested scanned head.
      this.saveCursor(l, cursor);
      if (l.lastError?.startsWith("events:") || l.lastError?.startsWith("ingest:")) l.lastError = null;
    } catch (err) {
      l.lastError = `events: ${errorText(err)}`;
    }
  }

  private saveCursor(l: ChannelHandle, block: bigint): void {
    if (l.record.scannedBlock === block) return;
    l.record = { ...l.record, scannedBlock: block };
    this.records.saveChannel(l.record);
  }

  // ------------------------------------------------------------------ status

  async status(ref?: string): Promise<ChannelStatus> {
    let l: ChannelHandle;
    try {
      l = this.pick(ref);
    } catch (err) {
      // Final review I3: a settled channel no longer watched is still served (from its cached final status or disk).
      if (ref && err instanceof DaemonError && (err.code === 404 || err.code === 409)) {
        const st = await this.settledStatus(ref);
        if (st) return st;
      }
      throw err;
    }
    // I1: a Finalized/Reclaimed channel's on-chain state is terminal and was already captured (see settleCheck)
    // before it was marked finalized -- refreshing it again on every status call is a pure, avoidable RPC cost.
    if (!l.record.finalized) await this.refreshChain(l);
    return this.statusOf(l);
  }

  /** Every live channel's status, followed by the channels that could not be loaded (I1). Plan 4.5 Task 11 fix
   *  round: skips the chain refresh entirely for Finalized/Reclaimed channels (see `status`'s comment), and reads
   *  the current block once for the whole call rather than once per channel -- both used to make this call's
   *  cost grow with the daemon's *lifetime* channel count, not just its currently-open ones. */
  async channels(): Promise<Array<ChannelStatus | DegradedChannel>> {
    const out: Array<ChannelStatus | DegradedChannel> = [];
    let now: bigint | undefined;
    for (const l of this.live.values()) {
      if (!l.record.finalized) {
        now ??= (await this.client.getBlock()).timestamp;
        await this.refreshChain(l, now);
      }
      out.push(this.statusOf(l));
    }
    // Final review I3: settled channels no longer watched, from their cached final status.
    for (const v of this.settled.values()) out.push(v.status);
    for (const [channelId, error] of this.degraded) out.push({ channelId, degraded: true, error });
    return out;
  }

  /**
   * Long-poll: resolves as soon as a watched channel needs the agent, its controller changes (R8.2 — a
   * handoff that produces no `attention` must still wake a waiter), or after `timeoutMs`.
   */
  async wait(opts: { ref?: string; timeoutMs: number }): Promise<{ channelId: Hex | null; reason: string }> {
    const end = Date.now() + opts.timeoutMs;
    // Controllers seen per channel so far: recorded the first time each channel is observed (whether that's at
    // entry, or later if `opts.ref` is unset and a new channel joins `live` mid-wait), so a fresh sighting never
    // trips a spurious control-changed, but a real change on any watched channel does.
    const controllers = new Map<Hex, Controller>();
    for (;;) {
      let targets: ChannelHandle[];
      if (opts.ref) {
        try {
          targets = [this.pick(opts.ref)];
        } catch (err) {
          // Plan 5 Task 1 (mainnet gates: wait on evicted channels): a settled channel this daemon has already
          // let go of (evicted from `live` after SETTLED_GRACE_SECONDS) is not an error to wait for -- it
          // resolves with reason "settled" at once, the same way status()/channels() already serve it, instead
          // of surfacing pick()'s 409. Re-checked inside the loop: a channel can be evicted mid-wait too.
          if (err instanceof DaemonError && (err.code === 404 || err.code === 409)) {
            const st = await this.settledStatus(opts.ref);
            if (st) return { channelId: st.channelId, reason: "settled" };
          }
          throw err;
        }
      } else {
        targets = [...this.live.values()];
      }
      for (const l of targets) {
        const id = l.record.channelId;
        const prev = controllers.get(id);
        if (prev === undefined) controllers.set(id, l.record.controller);
        else if (prev !== l.record.controller) return { channelId: id, reason: "control-changed" };
        let st = this.statusOf(l);
        if (st.attention === "session-gas-low") {
          // Final review C1: one wake per low-gas episode. While the wallet stays empty, later waits see the
          // channel's other attention instead of returning at once on every call (status keeps showing it).
          if (!l.sessionGasLowWoken) {
            l.sessionGasLowWoken = true;
            return { channelId: id, reason: st.attention };
          }
          st = this.statusOf(l, { ignoreSessionGasLow: true });
        }
        // Final review m4: `settled` wakes one wait, then is gone.
        if (st.attention === "settled") l.settledWake = false;
        if (st.attention) return { channelId: id, reason: st.attention };
      }
      const left = end - Date.now();
      if (left <= 0) return { channelId: null, reason: "timeout" };
      await this.nextChange(Math.min(left, 1000));
    }
  }

  private statusOf(l: ChannelHandle, opts: { ignoreSessionGasLow?: boolean } = {}): ChannelStatus {
    return buildStatus({
      record: l.record,
      snapshot: l.session.snapshot(),
      myTurn: l.session.isMyTurn(),
      chain: l.chain,
      lastError: l.lastError,
      lastProgressAt: l.lastProgressAt,
      lobbyError: this.lobbyError,
      sessionGasLow: opts.ignoreSessionGasLow ? null : l.sessionGasLow,
      settled: l.settledWake,
    });
  }

  /** `now`, when given, is a block timestamp already read by the caller this call, so this channel's read skips
   *  its own `getBlock()` (Plan 4.5 Task 11 fix round I1: `channels()` reads it once for every channel it
   *  refreshes, not once each). */
  private async refreshChain(l: ChannelHandle, now?: bigint): Promise<void> {
    const id = l.record.channelId;
    let info: Awaited<ReturnType<HubClient["channelInfo"]>>;
    let blockNow: bigint;
    if (now !== undefined) {
      info = await this.hub.channelInfo(id);
      blockNow = now;
    } else {
      const [i, block] = await Promise.all([this.hub.channelInfo(id), this.client.getBlock()]);
      info = i;
      blockNow = block.timestamp;
    }
    const registeredTurn = info.hasRegistered ? (await this.hub.registeredState(id)).turnNum : null;
    l.chain = {
      phase: info.phase,
      funded: info.funded,
      deadline: info.deadline,
      challenger: info.challenger,
      registeredTurn,
      cooldownUntil: info.cooldownUntil,
      now: blockNow,
    };
    // I2: progress is any change to the states and signatures held (our move, a received move, a checkpoint
    // proposed or completed, a Close signature either way, an on-chain adoption) or to the phase (the channel
    // opening, a challenge being answered). Observed here — every tick and every status call — on chain time.
    const snap = l.session.snapshot();
    const sig = (x: Hex) => (x === "0x" ? "-" : "s");
    const key = [
      info.phase,
      snap.latest.state.turnNum,
      sig(snap.latest.sigA) + sig(snap.latest.sigB),
      snap.pendingCheckpoint ? "p" : "-",
      snap.incomingCheckpoint ? "i" : "-",
      snap.closeState ? "c" : "-",
      sig(snap.closeSigs[0]) + sig(snap.closeSigs[1]),
    ].join("|");
    if (key !== l.progressKey) {
      l.progressKey = key;
      l.lastProgressAt = blockNow;
    }
  }

  private nextChange(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.changes.off("change", done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.changes.on("change", done);
    });
  }

  // ------------------------------------------------------------------ helpers

  protected pick(ref: string | undefined): ChannelHandle {
    const active = [...this.live.values()].filter((l) => !l.record.finalized);
    if (ref) {
      const hits = [...this.live.values()].filter((l) => l.record.channelId.toLowerCase().startsWith(ref.toLowerCase()));
      if (hits.length === 1) return hits[0];
      // I1: degraded channels are never picked, but naming one explains why instead of "unknown channel".
      const broken = hits.length === 0 ? [...this.degraded].filter(([id]) => id.toLowerCase().startsWith(ref.toLowerCase())) : [];
      if (broken.length === 1) throw new DaemonError(409, `channel ${broken[0][0]} could not be loaded: ${broken[0][1]}`);
      // Final review I3: a settled channel the daemon has let go of (status still serves it).
      const done =
        hits.length === 0 ? [...this.settled.values()].map((v) => v.status).filter((st) => st.channelId.toLowerCase().startsWith(ref.toLowerCase())) : [];
      if (done.length === 1) throw new DaemonError(409, `channel ${done[0].channelId} is settled (${done[0].phase}): nothing more can be done on it`);
      throw new DaemonError(hits.length === 0 ? 404 : 400, hits.length === 0 ? `unknown channel ${ref}` : `ambiguous channel ${ref}`);
    }
    if (active.length === 1) return active[0];
    throw new DaemonError(400, active.length === 0 ? "no active channel" : "several channels are active: pass --channel");
  }

  protected requireController(l: ChannelHandle, actor: Actor): void {
    if (actor !== l.record.controller) {
      throw new DaemonError(409, `the ${l.record.controller} is in control of this channel (use "arena handoff")`);
    }
  }

  protected async guard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof ArenaProtocolError || err instanceof HubRevertError) throw new DaemonError(409, err.message);
      throw err;
    }
  }

  protected notify(): void {
    try {
      this.changes.emit("change");
    } catch {
      // M8: a throwing listener must never break the caller (a move, a relay message, a tick).
    }
  }

  private markDegraded(channelId: string, error: string): void {
    this.degraded.set(channelId, error);
    this.log(`channel ${channelId} is degraded and not watched: ${error}`);
  }

  protected log(line: string): void {
    (this.opts.log ?? (() => undefined))(line);
  }
}
