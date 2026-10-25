import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import {
  createPublicClient,
  defineChain,
  erc20Abi,
  parseEventLogs,
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
  type Address,
  type Chain,
  type Hex,
  type Log,
  type PublicClient,
} from "viem";
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
  TxStuckError,
  TxWaitAbortedError,
  ZERO_HASH,
  channelId as computeChannelId,
  chunkRanges,
  checkMatchParams,
  hashState,
  isGameOver,
  isInsufficientFundsError,
  isRangeRefusal,
  isRateLimited,
  mover,
  offerId as computeOfferId,
  outcome,
  rpcErrorSummary,
  rpcTransport,
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
  autoReturnOnChallengeOf,
  autoReturnSecondsOf,
  isCanonicalId,
  minChallengeTimeoutOf,
  feeCeilingOf,
  pinnedDeploymentRefusals,
  sessionGasFloorOf,
  DEFAULT_LOG_CHUNK_BLOCKS,
  type ArenaConfig,
} from "./config.js";
import { chainProfile, weiToUsdc6Up, type ChainProfile } from "./chains.js";
import { FileSessionStore } from "./fileStore.js";
import { readJson, writeJsonAtomic } from "./jsonfile.js";
import { FUND_TX_GAS_UNITS, formatUsdc6, oneBalanceOpenNeed } from "./funding.js";
import { forbiddenOwners, noOwnerMessage, readRecordedOwner, validateOwner } from "./owner.js";
import { RecordStore, type ChannelRecord, type Controller } from "./records.js";
import { buildStatus, type ChannelStatus, type SessionGasLowCause } from "./status.js";
import { selfCommand } from "./version.js";

export type Actor = "agent" | "human";

export class DaemonError extends Error {
  constructor(
    readonly code: number,
    message: string,
    /** Final fix wave B (I-1): the transactions a failed withdraw may have sent, answered as the body's `hashes`. */
    readonly hashes?: Hex[],
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
  /** Plan 6 Task 2: `what` is `"gas"` when the top-up's own `estimateGas` failed -- the top-up is then not sent at
   *  all, never with a guessed gas limit. */
  constructor(cause?: unknown, what: "fee" | "gas" = "fee") {
    super(`${what} estimate failed: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.name = "SessionGasEstimateError";
  }
}

/** Plan 6 Task 2 (audit-daemon I-1): a session-key top-up was mined but reverted -- nothing reached the key. It is
 *  never counted as a refill: the refill raises `session-gas-low` and backs off, and `fund()` backs off funding,
 *  so a top-up that keeps reverting is not re-sent (and paid for) on every pass. */
export class TopUpRevertedError extends Error {
  constructor(readonly hash: Hex) {
    super(`the session-key top-up ${hash} was mined but reverted: nothing reached the key`);
    this.name = "TopUpRevertedError";
  }
}

/** Plan 6 Task 2 (spec §2.2): a session-key top-up's gas limit is the node's estimate plus 20 % (rounded up) plus
 *  5,000. A value transfer costs 21,000 on Arc today (arc-facts.md, corrected 2026-10-24) -- this is hardening, and
 *  the gas a transaction does not use is refunded. */
export const TOP_UP_GAS_MARGIN_PERCENT = 20n;
export const TOP_UP_GAS_MARGIN_FIXED = 5_000n;
export function topUpGasLimit(estimate: bigint): bigint {
  return estimate + (estimate * TOP_UP_GAS_MARGIN_PERCENT + 99n) / 100n + TOP_UP_GAS_MARGIN_FIXED;
}

/** H1 (Task 2 review Minor-2): the `session-gas-low` cause of a refill error that raises it at once (see
 *  `SessionGasLowCause`), or null for a transient one (logged, counted toward `REFILL_TRANSIENT_FAILURES_ALERT`). */
export function refillFailureCause(err: unknown): SessionGasLowCause | null {
  if (err instanceof TxInsufficientFundsError) return { kind: "funds" };
  if (err instanceof TxFeeCapError) return { kind: "fee-cap" };
  if (err instanceof SessionGasEstimateError) return { kind: "estimate" };
  if (err instanceof TopUpRevertedError) return { kind: "reverted", txHash: err.hash };
  return null;
}

/** Final fix wave (M4): a chain read a sweep attempt makes before it sends anything (the on-chain settled check,
 *  the key's nonce, balance and fees, the wallet's code) failed. An RPC blip, not a failure of the sweep itself:
 *  backed off like any failure, but never counted toward `SWEEP_ABANDON_ATTEMPTS`. */
export class SweepReadError extends Error {
  constructor(cause?: unknown) {
    super(`a read failed before anything was sent: ${cause instanceof Error ? cause.message.split("\n")[0] : String(cause)}`, { cause });
    this.name = "SweepReadError";
  }
}

/** H3 (Arc testnet rehearsal §8.4): a sweep may have gone out, and then could not be confirmed in a way that says
 *  nothing about the transaction itself -- a rate-limited receipt read, a failed replacement send, or (fix round 1,
 *  review M2) a send whose response was lost. `hashes`, the sweep's own transaction and every replacement of it, may
 *  still land (or have landed): the next attempt checks them before it reads the key's balance, so a landed sweep is
 *  never recorded as `"dust"`. */
export class SweepWaitError extends Error {
  constructor(
    readonly hashes: Hex[],
    cause: unknown,
  ) {
    super(`sweep ${hashes.at(-1)} may have gone out, but could not be confirmed: ${cause instanceof Error ? cause.message.split("\n")[0] : String(cause)}`, { cause });
    this.name = "SweepWaitError";
  }
}

/** H3 fix round 1 (review M4): what an action adds to the status its route answers with -- `unconfirmed` when its
 *  transaction was mined but its receipt could not be read (the status then carries `chainStale`). */
export type ActionOutcome = { unconfirmed?: string };

/** H3 fix round 1 (review M4): a `TxReceiptMissingError` -- the node reports the transaction mined, its receipt
 *  unreadable -- is an action that went through, unconfirmed; any other error is rethrown. */
function minedUnconfirmed(what: string, err: unknown): ActionOutcome {
  if (!(err instanceof TxReceiptMissingError)) throw err;
  // Fix round 2 (re-review M-e): mined is not succeeded -- a race the simulate did not see can revert it.
  return {
    unconfirmed:
      `the ${what} transaction ${err.hash} was mined (block ${err.blockNumber}), but its receipt could not be read: ` +
      "whether it succeeded is not known yet; check status",
  };
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
  /** H1 (Task 2 review Minor-2, audit-daemon M-5): what kind of failure `sessionGasLow` reports -- the status action
   *  names its remedy from it. Null with `sessionGasLow`. */
  sessionGasLowCause: SessionGasLowCause | null;
  /** H1 (audit-daemon M-5): refills in a row that failed in transit (dropped, stuck, no receipt, a nonce race). At
   *  `REFILL_TRANSIENT_FAILURES_ALERT` the channel raises `session-gas-low` (cause `failing`). 0 after any refill
   *  that goes through, or a key already at its floor. */
  refillTransientFailures: number;
  /** H1 (audit-daemon M-8, Task 2 review Minor-2): set while the refill back-off episode was caused by the wallet's
   *  own balance (`TxInsufficientFundsError`): the wallet balance that covers the refill (its value plus its gas at
   *  the wallet's fee ceiling). Only then does a rise in the wallet's balance end the back-off early, and only a rise
   *  to at least this. Null for every other cause -- a reverted top-up, a fee cap, a failed estimate, a send lost in
   *  transit -- which funding the wallet does not fix. */
  refillNeedWei: bigint | null;
  /** H3 (Arc testnet rehearsal §8.2): wall-clock ms before which `ensureSessionGas` does not read the session key's
   *  balance again after that read failed (0 = now), and the back-off it waited last (0 = no episode). */
  gasCheckRetryAt: number;
  gasCheckBackoffMs: number;
  /** Final review m4: this channel settled (Finalized or Reclaimed) while this daemon watched it, and no `wait()` has
   *  woken for it yet: drives the one-shot `settled` attention. */
  settledWake: boolean;
  /** Final fix wave (I1): the deadline of the challenge whose `human-must-move` a `wait()` has already woken for
   *  (one wake per challenge), or null. Cleared when a human takes the seat again. */
  humanMustMoveWoken: string | null;
  /** Final review I3: chain time at which the main pass first saw this channel settled; it is evicted from `live`
   *  `SETTLED_GRACE_SECONDS` later. */
  settledAt: bigint | null;
  /** Plan 5 fix round (rules 1-5, I8): this channel's sweep back-off state -- `blockedUntil`/`backoffMs` mirror
   *  the refill back-off's shape (wall-clock ms; 0 = no episode); `attempts` counts consecutive failures and
   *  drives `SWEEP_ABANDON_ATTEMPTS`. Passed by reference to `runSweepAttempt`, shared with the sweep queue's
   *  identically-shaped per-entry state (see `SweepQueueEntry`). */
  sweep: SweepBackoff;
  /** Plan 5.7 (K3): the highest XMTP drop count seen for this channel, so its status keeps it once the relay has
   *  forgotten the channel (at finalization). */
  xmtpDropped?: number;
  /** H1 ("oversized events"): the one block whose dispute events the RPC refused on consecutive scans while it was up,
   *  and how many scans in a row -- skipped at `UNREADABLE_BLOCK_PASSES` (see `skipUnreadableBlock`). In memory. */
  unreadableBlock: { block: bigint; tries: number } | null;
  /** H1: wall-clock ms before which `retrySkippedEventBlock` does not re-read a skipped block. 0 = now. */
  skippedRetryAt: number;
  /** H1 fix round 1 (review m-1): which skipped block `retrySkippedEventBlock` tries next (rotating). */
  skippedRetryIndex: number;
  /** H1 fix round 1 (review I-1): set while the channel is Challenged on a registered state newer than this session's
   *  latest -- its event not (yet) ingested. `passes` counts dispute passes that found it; `raised` once the
   *  `challenge-unseen` attention is up. Keyed by the challenge (its deadline and registered turn). */
  unseenRegistered: { key: string; turn: bigint; deadline: bigint; passes: number; raised: boolean } | null;
  /** H1 fix round 1: `wait()` has already woken for this `challenge-unseen` (keyed like `unseenRegistered`). */
  challengeUnseenWoken: string | null;
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
  sweep: SweepBackoff;
  /** True while either the queue's own pass or a manual `sweep()` call is working on this entry, so the two never
   *  send at once (I1's busy-wait pattern, mirrored from `reclaim()`/`l.mainBusy`). */
  busy: boolean;
};

/** Shared shape of a channel's (or sweep-queue entry's) sweep back-off state. `pendingTx` (fix round 2, minor 2;
 *  fix round 3, I-1(c): a list, not one hash) is set when a sweep attempt's own `waitOrReplace` gave up on a
 *  transaction it cannot fully rule out having landed anyway -- `TxReceiptMissingError` (the node stopped serving
 *  a receipt after treating it as mined), `TxStuckError` or `TxWaitAbortedError` (the wait gave up -- on
 *  `giveUpAt`, or `stop()` -- while the transaction, or one of its fee-bumped replacements, could still land
 *  later). Every hash `waitOrReplace` ever sent for that one intent (the original plus every replacement) is
 *  kept, since any one of them, not just the last, could be the one that mines. The *next* attempt reads all of
 *  their receipts first -- before doing anything else -- and recovers a swept amount/tx from whichever one
 *  succeeded, rather than losing track of money that already arrived (and, worse, sending again or recording a
 *  spurious "dust"). */
type SweepBackoff = {
  blockedUntil: number;
  backoffMs: number;
  attempts: number;
  pendingTx?: Hex[];
  /** Final fix wave (M3): how many probes of `pendingTx` in a row found it still pending. */
  pendingProbes?: number;
  /** H1 (audit-daemon M-4): how many probes of `pendingTx` in a row found it mined with no receipt to read. */
  receiptlessProbes?: number;
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

/** True once a record's sweep is done (either way). Wrapped in a function (fix round 2, important 3) rather than
 *  an inline `swept === true || swept === "dust"` so re-checking it a second time, after an `await`, is never
 *  narrowed by TypeScript against the first check -- `l.record`/`queued.record` really can change in between. */
function isSweptDone(swept: ChannelRecord["swept"]): boolean {
  return swept === true || swept === "dust";
}

/** H1 ("oversized events"): `ranges` with every block in `skip` left out, each range split around it; in order. */
export function withoutBlocks(
  ranges: Array<{ fromBlock: bigint; toBlock: bigint }>,
  skip: readonly bigint[],
): Array<{ fromBlock: bigint; toBlock: bigint }> {
  if (skip.length === 0) return ranges;
  const sorted = [...new Set(skip)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const out: Array<{ fromBlock: bigint; toBlock: bigint }> = [];
  for (const r of ranges) {
    let from = r.fromBlock;
    for (const b of sorted) {
      if (b < from || b > r.toBlock) continue;
      if (b > from) out.push({ fromBlock: from, toBlock: b - 1n });
      from = b + 1n;
    }
    if (from <= r.toBlock) out.push({ fromBlock: from, toBlock: r.toBlock });
  }
  return out;
}

/** Fix round 3, M-4: a fresh `ChannelRecord` with `swept: true`, `sweptAmount`/`sweptTx` set to this sweep (kept
 *  for compatibility -- the latest entry), and `amount`/`tx` appended to `sweeps`, oldest first. A channel's
 *  session key can be swept for real more than once in its lifetime -- a late top-up re-checked and swept again
 *  (minor 4), or an "abandoned" channel `arena sweep` retries successfully (important 1) -- and `sweptAmount`/
 *  `sweptTx` alone, overwritten each time, only ever showed the latest one. */
function appendSweep(record: ChannelRecord, amount: bigint, tx: Hex): ChannelRecord {
  return {
    ...record,
    swept: true,
    sweptAmount: amount,
    sweptTx: tx,
    sweeps: [...(record.sweeps ?? []), { amount, tx, at: Date.now() }],
    sweepPending: undefined, // final fix wave (M5): resolved
  };
}

/** Fix round 2, important 5: the fee per gas a set of fees (`SerialTxSender`'s own `Fees` shape) asks for, in the
 *  same style `tx.ts`'s own internal `feeOf` reads it (not exported). */
function feePerGasOf(f: { maxFeePerGas?: bigint; gasPrice?: bigint }): bigint {
  return f.maxFeePerGas ?? f.gasPrice ?? 0n;
}

/** True once a fee set names an actual value (as opposed to `{}`, e.g. an adopted-after-restart entry whose fees
 *  were never observed). Mirrors `tx.ts`'s own internal `hasFees` (not exported). */
function hasKnownFee(f: { maxFeePerGas?: bigint; gasPrice?: bigint }): boolean {
  return f.maxFeePerGas !== undefined || f.gasPrice !== undefined;
}

/** Fix round 2, important 5: the same "raise a fee by at least 12.5%, rounded up" rule `SerialTxSender`'s own
 *  same-nonce replacement path uses internally (`tx.ts`'s `bump`, not exported) -- needed here to size the
 *  sweep's reserve against a dead entry's own last fee, not just the current market estimate. */
function bumpFeePerGas(x: bigint): bigint {
  const raised = (x * 1125n + 999n) / 1000n;
  return raised > x ? raised : x + 1n;
}

export type DaemonOptions = {
  home: string;
  config: ArenaConfig;
  walletKey: Hex;
  lobby: LobbyClient;
  relay: RelayClient;
  log?: (line: string) => void;
  /** Plan 5.7: where `relay` sends this channel's messages now (`ChannelStatus.transport`). `run.ts` passes the
   *  host relay's or `FallbackRelay`'s; without it, a live channel reports `"relay"`. */
  transportOf?: (channelId: Hex) => ChannelStatus["transport"];
  /** Plan 5.7: whether `relay` falls back to XMTP (the daemon's start line). Default `"off"`. */
  fallback?: "xmtp" | "off";
  /** Plan 5.7 (spec §3): called when the session rejects a relayed message. True means the relay has counted it as
   *  dropped -- an XMTP message whose sender could not be determined, a stranger's as likely as not -- so it sets no
   *  `lastError` and logs nothing. `run.ts` passes `FallbackRelay`'s; without it every rejection is reported. */
  relayRejected?: (msg: RelayMessage) => boolean;
  /** Plan 5.7 (spec §3): whether a relayed message is such an XMTP message. A stale or duplicate one then leaves
   *  `lastError` as it was. `run.ts` passes `FallbackRelay`'s; without it nothing changes. */
  relayUndetermined?: (msg: RelayMessage) => boolean;
  /** Plan 5.7 (spec §3, I-1): called on every chain refresh of a channel that is Open (or Challenged) on chain --
   *  both deposits in -- and not finalized: the relay starts the channel's XMTP client then, never at match time.
   *  Idempotent. `run.ts` passes `FallbackRelay.arm`; without it nothing happens. */
  armFallback?: (channelId: Hex) => void;
  /** Plan 5.7 (K3): the channel's XMTP drop count (`ChannelStatus.xmtpDropped`). Without it, 0. */
  xmtpDroppedOf?: (channelId: Hex) => number;
  /** Plan 5.7 (I-2): why `fallback` is `"off"` -- not configured, the SDK failed to load, or an invalid `xmtp` in
   *  config.json -- for `GET /fallback`. */
  fallbackReason?: string;
};

const errorText = (err: unknown) => (err instanceof Error ? err.message.split("\n")[0] : String(err));


/**
 * I3: on every scan, re-read this many blocks behind the persisted cursor, not just forward from it. A
 * load-balanced RPC's `blockNumber()` can outrun its own `getLogs` index (or, on a real chain, a shallow reorg
 * can drop and re-mine a block), so trusting a single pass at a reported head can permanently skip an event
 * that was there all along. `ingestOnChain` is idempotent for a state it already holds, so re-reading is safe.
 */
export const DISPUTE_RESCAN_BLOCKS = 32n;

/** H1 (audit-contracts I1, "oversized events"): the most `getLogs` reads one dispute scan of one channel makes -- its
 *  chunks plus the halves of any range the RPC refused (each split adds one read). */
export const DISPUTE_SCAN_READS_PER_PASS = 64;

/** H1 fix round 1 (review I-1): a registered state newer than this session's latest is left to the scan for this
 *  many dispute passes -- after any opponent move by challenge it is, for a pass or two, until the event is ingested
 *  -- before the daemon adopts it from storage or raises `challenge-unseen`. At once when a block was skipped. */
export const UNSEEN_REGISTERED_PASSES = 3;

/** H1: a single block whose dispute events for a channel the RPC refuses on this many passes in a row, while it
 *  serves the same query for no channel, is skipped (see `skipUnreadableBlock`). */
export const UNREADABLE_BLOCK_PASSES = 3;

/** The furthest out a funding deadline may be set from match time (`checkMatchParams`' `maxFundingWindow`): an
 *  offer this long past its expiry can no longer produce a fundable match. Distinct from, and must stay well
 *  under, the SDK's `MAX_FUNDING_WINDOW` (86400n): the hub's own hard cap on `fundingDeadline`. */
export const MAX_FUNDING_WINDOW = 7200n;

/** How long an offer stays matchable by default: its signed `expiresAt` is chain time at posting plus this. The most
 *  `offer --ttl` may ask for, too. */
export const OFFER_TTL_SECONDS = 3600n;
/** H1 (`offer --ttl`): the shortest offer lifetime `createOffer` accepts. */
export const MIN_OFFER_TTL_SECONDS = 60n;

/** Task 2 (spec §13): once `fund()` reverts for one of these reasons, `watch()` backs off funding this channel
 *  for at least this many seconds of chain time, instead of retrying the same revert on every tick. */
export const FUND_BACKOFF_SECONDS = 30n;

/** Plan 4.5 Task 10 review: after a cooperative-close submission reverts, the watchtower waits this long before
 *  retrying it (the close API and the relay path still submit at once). */
export const CLOSE_RETRY_BACKOFF_MS = 30_000;

/** H1 (audit-daemon M-11): when the opponent's Close signature completes a close on this side (the relay path), the
 *  watchtower submits it no sooner than this, plus up to `CLOSE_RELAY_JITTER_MS` -- the opponent, who signed second,
 *  submits it at once, and two submissions race (the loser's transaction reverts on-chain). */
export const CLOSE_RELAY_DEFER_MS = 2_000;
export const CLOSE_RELAY_JITTER_MS = 3_000;

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

/** H1 (audit-daemon M-5): after this many refills in a row fail in transit -- each one logged and retried as
 *  transient -- the channel raises `session-gas-low` (cause `failing`), so the agent is told. On Arc, a top-up from
 *  or to a blocklisted address is included without a receipt, so it never fails any other way. */
export const REFILL_TRANSIENT_FAILURES_ALERT = 3;

/** Plan 5 Task 1 (mainnet gates: refill and sweep back-off): the first back-off, in wall-clock ms, after a failed
 *  refill or sweep -- doubled on each further failure, up to `BACKOFF_MAX_MS`. */
export const BACKOFF_START_MS = 30_000;
/** Plan 5 Task 1: the refill/sweep back-off never grows past this. */
export const BACKOFF_MAX_MS = 300_000;

/** H3 fix round 1 (review M8): the daemon's per-attempt RPC timeout (viem's default is 10 s). */
export const DAEMON_RPC_TIMEOUT_MS = 5_000;

/** H3 fix round 2 (re-review I-a): the most one request on the daemon's client takes, every attempt and back-off
 *  included (`rpcTransport`'s `totalTimeoutMs`). A respond makes about 11 requests one after another before its send
 *  (`h3-ratelimit.test.ts` counts them), and the send is one attempt of at most 10 s: 11 x 20 s + 10 s = 230 s, inside
 *  `autoReturnSecondsOf` (300 s at the 900 s default window). Before, a request could take 6 x 5 s + 15.5 s = 45.5 s,
 *  about 510 s for the respond. A plain rate limit still gets its full 15.5 s back-off (6 attempts). With a
 *  `Retry-After` (honoured up to 4 s a retry), the cap leaves 5 attempts and 16 s of waiting (final fix wave B, m-12). */
export const DAEMON_RPC_TOTAL_TIMEOUT_MS = 20_000;

/** H3 fix round 2 (re-review M-g): a respond is not sent at or after its give-up time plus this. Why it never holds back
 *  a respond that can still land: the give-up time is the read time plus (deadline - the latest block's timestamp),
 *  and that block is no newer than the chain's clock at the read, so the give-up time is no earlier than the last
 *  moment a block could still take the respond (the hub needs `block.timestamp < deadline`). A send past it could
 *  only revert, paying gas. Final fix wave B (m-6, h3 M-h): 15 s, not 3 s -- the costs are lopsided: a respond held
 *  back that would have landed forfeits the game, and one sent too late costs about 200k gas x 40 gwei = 0.008 USDC.
 *  The margin covers Arc's 1 s timestamps, a proposer clock running ahead, and this machine's wall clock (`giveUpAt`
 *  and the sender's `notAfter` are both `Date.now()`) stepping forward by up to 15 s between the read and the send; a
 *  larger step is out of the model. Measuring both on a monotonic clock is the follow-up (both at once, or they
 *  disagree). */
export const RESPOND_SEND_MARGIN_MS = 15_000;

/** H3 (Arc testnet rehearsal §8.2): after a failed read of a session key's balance, the session-gas check waits this
 *  long (wall-clock ms) before it reads again -- doubled on each further failure, up to `GAS_CHECK_BACKOFF_MAX_MS`.
 *  Before, it re-read on every pass, from three call sites per pass: 208 failures in 24 minutes from two daemons on
 *  a rate-limited RPC, every one of them adding to the load that limited it. */
export const GAS_CHECK_BACKOFF_START_MS = 5_000;
/** H3: the session-gas check's back-off never grows past this. A refill is at most this late. */
export const GAS_CHECK_BACKOFF_MAX_MS = 60_000;

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

/** Plan 5 fix round (I5): the wall-clock budget one `sweep()` call (with no `--channel`) spends attempting
 *  records before returning, reporting `remaining` for whatever is left rather than hanging the caller. */
export const SWEEP_TIME_BUDGET_MS = 60_000;

/** Fix round 3, M-2: the most one record's own receipt wait (`giveUpAt`, threaded down to `waitOrReplace`) may
 *  claim out of `SWEEP_TIME_BUDGET_MS`, even when the budget has much more of it left -- so one record stuck
 *  replacing a dead entry cannot eat the whole budget (or, for `--channel`, the whole of a much larger
 *  `budgetMs`) and starve every other record a bulk sweep would otherwise have gotten through. */
export const SWEEP_PER_RECORD_TIMEOUT_MS = 20_000;

/** Final fix wave (I2): the most sweep-queue records one main pass attempts. The next pass continues with the
 *  records after them (round-robin), so one pass never serializes the whole queue. */
export const SWEEP_QUEUE_PER_PASS = 3;

/** Final fix wave (M3): after this many probes find a sweep transaction still pending (each after the sweep
 *  back-off), the next attempt goes ahead: its send replaces the released entry at the same nonce with raised
 *  fees, so a transaction priced under a base fee that stays high is not waited on forever. */
export const SWEEP_PENDING_PROBES = 3;

/** Plan 4.5 Task 10 re-review (M5): a recorded channel that fails to open this many times on a match retry is
 *  marked degraded (reported by channels(), never picked or watched) instead of being retried forever. */
export const MAX_OPEN_ATTEMPTS = 5;

/** Plan 5.6 Task 3 fix round 4 (N3): a match whose handling fails this many times in a row (`retryMatches`) is
 *  dropped, with one log line, instead of being retried -- and holding every withdraw at 409 -- for the daemon's
 *  lifetime. Retries run once per main pass, so 20 is at least 40 s of failures at the default 2 s `pollMs`, and
 *  minutes when each attempt waits out RPC timeouts: long enough to ride out an RPC blip. What still fails after
 *  that (a corrupt offer record, a full disk, a dead RPC) is not fixed by retrying. Dropping loses nothing: the
 *  offer record stays on disk, the next `start()` watches it again and the host replays the match. That is why the
 *  withdraw 409 says to restart the daemon if it persists. Only failures count; a match deferred by a withdraw in
 *  flight is not a failure. Like `MAX_OPEN_ATTEMPTS`, which degrades a channel that keeps failing to open (an
 *  `openChannel` failure counts here too, so that cap is reached first). */
export const MAX_MATCH_RETRIES = 20;

/** The hub error names that mean "this deposit cannot go through right now because of a launch limit" (spec §13),
 *  as opposed to a bug or an unrelated chain error. */
const LIMIT_REVERTS = new Set(["Paused", "DepositTooLarge", "EscrowCapReached"]);

/** Plan 6: what `withdrawReserve` is computed from. */
export type WithdrawReserveInput = {
  /** The chain's built-in profile (`chainProfile(config.chainId)`); undefined for a chain without one. */
  profile: ChainProfile | undefined;
  /** This daemon's channels that are not finalized: each one's session key may still need a refill. */
  unsettledChannels: number;
  sessionGasWei: bigint;
  /** The wallet sender's fee ceiling per gas (`SerialTxSender.feeCeiling`). */
  feeCeilingWei: bigint;
};

/**
 * Plan 5.6 Task 3 (spec §4.4): the USDC (6 decimals) `withdraw()` always leaves in the wallet.
 * - **0** with no input, or on a chain whose gas is native (no profile, or one without `nativeIsUsdc`):
 *   `withdraw --all` empties the wallet's USDC, as before.
 * - Plan 6 (spec §2.1, Review Focus 1): on a `nativeIsUsdc` chain (Arc), gas is paid from the same USDC balance,
 *   and every unsettled channel's session key is refilled from this wallet (`ensureSessionGas`). So the reserve is
 *   `unsettledChannels x sessionGasWei + FUND_TX_GAS_UNITS x feeCeilingWei` (wei), converted to 6 decimals rounded
 *   UP: a full refill per channel, so `withdraw --all` never strands a channel's dispute gas, plus the wallet's own
 *   transactions, the withdraw itself included.
 */
export function withdrawReserve(input?: WithdrawReserveInput): bigint {
  if (input === undefined || input.profile?.nativeIsUsdc !== true) return 0n;
  if (input.unsettledChannels < 0 || !Number.isInteger(input.unsettledChannels)) {
    throw new RangeError("unsettledChannels must be a non-negative integer");
  }
  return weiToUsdc6Up(BigInt(input.unsettledChannels) * input.sessionGasWei + FUND_TX_GAS_UNITS * input.feeCeilingWei);
}

/**
 * Plan 5.6 Task 3 fix round 4 (N4, N5; spec §4.4): true when `logs` -- a transfer's receipt logs -- hold an ERC-20
 * `Transfer(from, to, amount)` emitted by `token`. It is the one proof `withdraw()` accepts that the money moved. A
 * token whose `transfer` returns `false` emits no such log. A log from any other emitter, with any other party or
 * amount, or that does not decode as the ERC-20 event (an ERC-721 `Transfer` indexes its third field), never counts.
 * Other logs in the same receipt, such as USDC reaching the wallet in the same transaction, change nothing.
 */
export function confirmsTransfer(logs: Log[], t: { token: Address; from: Address; to: Address; amount: bigint }): boolean {
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  return parseEventLogs({ abi: erc20Abi, eventName: "Transfer", logs }).some(
    (l) => same(l.address, t.token) && same(l.args.from, t.from) && same(l.args.to, t.to) && l.args.value === t.amount,
  );
}

/**
 * H1 (audit-daemon M-6): what `withdraw()` reports when its transfer's receipt wait ended without a receipt. Each
 * of these leaves the transfer possibly landed, so it is a 502 naming every hash sent, with the same "check it
 * before retrying" as an unconfirmed transfer -- never a bare 500, which reads as "nothing happened" and invites a
 * second `--amount X` that pays the owner twice if the first one landed:
 * - `TxReceiptMissingError`: the node reports it mined; its nonce is used, so a retry is a fresh, second transfer.
 * - `TxStuckError` / `TxDroppedError`: still pending, or no longer known to this node; a retry replaces it at the
 *   same nonce (at most one of the two lands), but it may land first.
 * - `TxWaitAbortedError`: the daemon is stopping (503); the transaction may still land.
 * Final fix wave B (I-1): any other error, when `sent` -- the transactions this wallet's sender started tracking
 * during the withdraw -- is not empty: the transfer went out (or may have) and its wait failed for a reason that
 * says nothing about it (a rate-limited or timed-out receipt read, a 5xx). A 502 naming them, never H3's 503 "retry".
 * An error with nothing sent happened before the send, and is returned unchanged. Every 502 and 503 here carries its
 * hashes (`DaemonError.hashes`), and `withdraw()` holds the next withdraw back until they are resolved.
 */
export function withdrawWaitError(err: unknown, amount: bigint, owner: Address, sent: Hex[] = []): unknown {
  const what = `the transfer of ${formatUsdc6(amount)} USDC to ${owner}`;
  const check = `check the owner's balance, an explorer or "${selfCommand()} wallet" before retrying: a retry can pay the owner twice`;
  const all = (hashes: Hex[]) => [...new Set([...hashes, ...sent])];
  if (err instanceof TxReceiptMissingError) {
    const hashes = all([err.hash]);
    return new DaemonError(502, `${what} was mined (tx ${err.hash}, block ${err.blockNumber}) but its receipt could not be read; ${check}`, hashes);
  }
  if (err instanceof TxStuckError) {
    const hashes = all(err.hashes);
    return new DaemonError(502, `${what} is still pending (tx ${hashes.join(", ")}); it may still land: ${check}`, hashes);
  }
  if (err instanceof TxDroppedError) {
    const hashes = all([err.hash]);
    return new DaemonError(502, `${what} (tx ${hashes.join(", ")}) is no longer known to the RPC and was not seen mined; it may still land: ${check}`, hashes);
  }
  if (err instanceof TxWaitAbortedError) {
    const hashes = all(err.hashes);
    return new DaemonError(503, `the daemon is stopping: ${what} (tx ${hashes.join(", ")}) was sent and may still land; ${check}`, hashes);
  }
  if (sent.length > 0) {
    const why = isRateLimited(err) ? `the RPC is rate-limiting (${rpcErrorSummary(err)})` : rpcErrorSummary(err);
    return new DaemonError(502, `${what} may have been sent (tx ${sent.join(", ")}), but could not be confirmed (${why}); ${check}`, sent);
  }
  return err;
}

/** Final fix wave B (I-1): how long, in wall-clock ms after it was sent, a withdraw that may have gone out unconfirmed
 *  (`PendingWithdraw`) holds back the next one -- unless that one is resolved first. Persisted, so a fresh in-process
 *  daemon (`arena withdraw` with no daemon running) holds back too. After it, the next send from this wallet replaces
 *  a transfer still pending at its nonce (the sender adopts a pending nonce it did not send, on an RPC whose pending
 *  count shows it), so at most one of the two lands. */
export const WITHDRAW_UNCONFIRMED_HOLD_MS = 10 * 60_000;

/** Final fix wave B (I-1): `<home>/withdraw-pending.json` -- a withdraw answered 502/503 with its `hashes`. Each tx's
 *  `nonce` is the wallet nonce it was sent at, when known. */
export type PendingWithdraw = { to: Address; amount: bigint; at: number; txs: Array<{ hash: Hex; nonce?: number }> };

/** Plan 5 Task 2 fix round, minor 4: the longest handoff note `handoff()` accepts. A note is untrusted text the
 *  board renders for a human (Global Constraints); an unbounded one is a denial-of-service/UI surface, not just
 *  cosmetic. */
export const MAX_HANDOFF_NOTE_LENGTH = 1024;

/** Final fix wave (I1): the handoff note the daemon leaves when it hands a human-held seat back to the agent because
 *  a challenge deadline is near. */
export const AUTO_RETURN_NOTE = "auto-returned: challenge deadline approaching";

/**
 * Plan 5 Task 2 fix round, minor 4: every character class a handoff note refuses, beyond the length cap above --
 * C0 controls other than tab (U+0009) and newline (U+000A), DEL (U+007F), C1 controls (U+0080-U+009F), and the
 * bidi-override/isolate formatting characters (U+202A-U+202E, U+2066-U+2069) that can make rendered text read in
 * an order different from its bytes. The board shows this note as plain text (never innerHTML, per Global
 * Constraints), so this is not an XSS defense -- it's aimed at a note that would otherwise corrupt the terminal
 * or the board's own layout (a bidi override flips visual order; C0/C1 controls include things like backspace,
 * form feed, or an ANSI escape's own controls) rather than at markup, which plain-text rendering already defeats.
 */
const FORBIDDEN_NOTE_CHARS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F‪-‮⁦-⁩]/;

function checkHandoffNote(note: string): void {
  if (note.length > MAX_HANDOFF_NOTE_LENGTH) {
    throw new DaemonError(400, `note must be at most ${MAX_HANDOFF_NOTE_LENGTH} characters (got ${note.length})`);
  }
  if (FORBIDDEN_NOTE_CHARS.test(note)) {
    throw new DaemonError(400, "note contains a disallowed control or bidi-override character");
  }
}

/** The chain view of a settled channel whose full on-chain state is not (or no longer) at hand: only its final
 *  phase matters to `buildStatus` once the record is finalized. */
function finalChainView(phase: string): ChainView {
  return { phase, funded: [false, false], deadline: 0n, challenger: 0, registeredTurn: null, cooldownUntil: [0n, 0n], now: 0n };
}

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
  /** Plan 5.6 Task 3: `withdraw()` is single-flight too -- two concurrent `--all`s would both read the same
   *  balance and race to send it. A concurrent call is refused with 409. */
  private withdrawing = false;
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
  /** Fix round 4 (N3): consecutive failed attempts to handle a match, by offerId -- capped at `MAX_MATCH_RETRIES`.
   *  Cleared by any attempt that does not fail. */
  private readonly matchFailures = new Map<Hex, number>();
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
    // H3: a rate-limited read is retried with back-off (`rpcTransport`; Arc testnet rehearsal §8.2). Sends never are.
    // Fix round 1 (review M8): a per-attempt timeout of DAEMON_RPC_TIMEOUT_MS; fix round 2 (re-review I-a): and at most
    // DAEMON_RPC_TOTAL_TIMEOUT_MS per request, retries included.
    this.client = createPublicClient({
      chain: this.chain,
      transport: rpcTransport(c.rpcUrl, { timeout: DAEMON_RPC_TIMEOUT_MS, totalTimeoutMs: DAEMON_RPC_TOTAL_TIMEOUT_MS }),
    });
    // Plan 4.5 Task 10 re-review 2: stop() aborts every receipt wait in flight (rather than waiting out a 30 s round).
    this.hub = new HubClient(c.hub, this.client, { signal: this.aborter.signal });
    // Tracking senders (Plan 4.5 Task 10 round 4): each manages its key's nonces, read via this.client.
    // Round 4: every fee the wallet pays is capped at max(4 x the node's estimate, feeCeilingWei) and what it can pay.
    // Plan 6 (spec §2.3, §2.4): on a chain with a profile, the ceiling defaults to the profile's (`feeCeilingOf`), and
    // every fee is at least the chain's floor -- under it, Arc drops the transaction without a word.
    this.wallet = new SerialTxSender(new LocalKeyTxSender(opts.walletKey, c.rpcUrl, this.chain), this.client, {
      feeCeiling: feeCeilingOf(c),
      minFeePerGas: chainProfile(c.chainId)?.minFeePerGas,
    });
    this.domain = { chainId: c.chainId, hub: c.hub };
    this.records = new RecordStore(opts.home);
    this.changes.setMaxListeners(0);
  }

  /** A tracking sender for one channel's session key. Round 5: dispute transactions are never refused by a fee
   *  ceiling -- only what the key can pay (its balance) bounds them; the wallet keeps the configured ceiling. Plan 6
   *  (spec §2.3): but never under the chain profile's fee floor, which a key that cannot pay it is refused at. */
  private sessionSenderFor(sessionKey: Hex): SerialTxSender {
    return new SerialTxSender(new LocalKeyTxSender(sessionKey, this.opts.config.rpcUrl, this.chain), this.client, {
      feeCeiling: NO_FEE_CEILING,
      minFeePerGas: chainProfile(this.opts.config.chainId)?.minFeePerGas,
    });
  }

  /** Plan 5.7 (spec §2): whether this daemon's relay falls back to XMTP -- the start line's `fallback`. */
  get fallback(): "xmtp" | "off" {
    return this.opts.fallback ?? "off";
  }

  /** Plan 5.7 (I-2): what this running daemon loaded, for `GET /fallback` (and so `arena xmtp status`): `"xmtp"`, or
   *  `"off"` with the reason. The SDK is loaded once, at start: an `xmtp enable` after that needs a daemon restart. */
  fallbackInfo(): { fallback: "xmtp" | "off"; reason?: string } {
    if (this.fallback === "xmtp") return { fallback: "xmtp" };
    return { fallback: "off", reason: this.opts.fallbackReason ?? "the XMTP fallback is not configured (config.json has no xmtp)" };
  }

  // ------------------------------------------------------------------ lifecycle

  /** Starts the daemon. Plan 4.5 Task 10 round 4 (M5): a daemon cannot be restarted once stopped -- stop() aborts
   *  its receipt waits for good -- so a restart creates a new ArenaDaemon on the same home. */
  async start(): Promise<void> {
    if (this.stopped) throw new Error("a stopped ArenaDaemon cannot be restarted: create a new one on the same home");
    // Plan 6 fix round 1 (m-1, spec §2.5): `init` refuses a non-pinned USDC, hub or rules on a chain with a profile,
    // but config.json can be edited by hand, or written before the chain's deployment was pinned. Re-checked here,
    // before anything subscribes or reads the chain: on such a chain this daemon deposits only to the pinned hub.
    // Final fix wave B (I-2): `--detach`, `withdraw` and `bot` show this to the agent, so it is the human's to act on.
    // The likely cause is a CLI release that pinned a newer hub, not a hand edit: restoring the pinned addresses would
    // read this home's channels on the wrong hub (and retire them), and a fresh home would leave this wallet's funds
    // behind. The release that set the home up can still settle and withdraw.
    const c = this.opts.config;
    const pinned = pinnedDeploymentRefusals(c.chainId, { hub: c.hub, rules: c.rules, usdc: c.usdc });
    if (pinned.length > 0) {
      const name = chainProfile(c.chainId)?.name ?? `chain ${c.chainId}`;
      throw new Error(
        `refusing to start on ${name} (chain ${c.chainId}): ${arenaPaths(this.opts.home).config} names contracts this CLI does ` +
          `not accept there: ${pinned.join("; ")}. Tell your human: this daemon's config names contracts the CLI does not ` +
          `pin for chain ${c.chainId} (most likely this home was set up by another CLI release); they decide what happens ` +
          "next. Do not edit config.json yourself, and do not start a new ARENA_HOME while a channel of this one is " +
          "unsettled: the CLI release that set it up can still settle its channels and withdraw (withdraw needs this daemon too)",
      );
    }
    this.unsubscribers.push(this.opts.lobby.onMatch((m) => this.fireAndForget("onMatch", this.onMatch(m))));
    this.unsubscribers.push(this.opts.relay.onMessage((m) => this.fireAndForget("onRelay", this.onRelay(m))));
    this.unsubscribers.push(this.opts.relay.onJoined((id) => this.fireAndForget("onJoined", this.onJoined(id))));
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
      this.fireAndForget("disputePass", this.disputePass());
      this.fireAndForget("mainPass", this.mainPass());
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
        sender: this.sessionSenderFor(record.sessionKey),
        // Final fix wave (M5): a sweep transaction the last run gave up on is checked first.
        sweep: { blockedUntil: 0, backoffMs: 0, attempts: 0, pendingTx: record.sweepPending },
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
    if (!this.stopped) this.fireAndForget("tick", this.tick());
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
    // Plan 5 Task 2: told before the listeners it's about for are dropped -- the SSE feed's onStop subscriber
    // ends its open responses here; removeAllListeners() alone would just silently drop that subscriber, leaving
    // its HTTP response open forever with nothing left to ever write to or close it.
    try {
      this.changes.emit("stop");
    } catch {
      // M8 (see notify()): a throwing listener must never break stop().
    }
    this.changes.removeAllListeners();
  }

  /** Plan 5 Task 2: subscribes to every `notify()` (a new state, a tick, a handoff, …) -- used by the SSE feed
   *  (`GET /events`). `changes` is protected; this is the one public door onto it. Returns an unsubscribe
   *  function. */
  onChange(listener: () => void): () => void {
    this.changes.on("change", listener);
    return () => this.changes.off("change", listener);
  }

  /** Plan 5 Task 2: subscribes to this daemon stopping (see `stop()`) -- the SSE feed closes its streams then,
   *  since `changes.removeAllListeners()` alone would silently drop the "change" listener without ending the
   *  open HTTP response. Returns an unsubscribe function. */
  onStop(listener: () => void): () => void {
    this.changes.on("stop", listener);
    return () => this.changes.off("stop", listener);
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

  // ------------------------------------------------------------------ wallet: withdraw (Plan 5.6 Task 3)

  /**
   * Plan 5.6 Task 3 (spec §4.4): sends `amount` USDC (or, with `all`, everything above `withdrawReserve()`) from
   * this wallet to the owner recorded in `<home>/config.json` -- re-read on every call, so `arena owner set` needs
   * no restart, and re-validated, so a hand-edited owner that is malformed, the zero address, this wallet, the hub,
   * the token, the rules contract or a session key is refused rather than paid. The destination is never a
   * parameter. Sent through `this.wallet`, the same `SerialTxSender` every deposit and refill uses, so it takes its
   * place in the wallet's one nonce sequence. Refused (409) while any channel still awaits this wallet's own
   * deposit (`channelsAwaitingOwnDeposit`, Review Focus 4), so it never starves a deposit the daemon is about to make.
   */
  async withdraw(
    req: { amount: bigint } | { all: true },
  ): Promise<{ to: Address; amount: bigint; txHash: Hex; usdcAfter: bigint | null; note?: string; openOffers?: Hex[] }> {
    if (this.stopped) throw new DaemonError(503, "the daemon is stopping");
    if (this.withdrawing) throw new DaemonError(409, "a withdraw is already in progress: retry shortly");
    this.withdrawing = true;
    try {
      const owner = this.recordedOwner();
      if ("amount" in req && req.amount <= 0n) throw new DaemonError(400, "amount must be greater than 0");

      const awaiting = await this.channelsAwaitingOwnDeposit();
      if (awaiting.reasons.length > 0) {
        throw new DaemonError(
          409,
          `${awaiting.reasons.join("; ")} -- a withdraw now could leave it without the USDC to deposit. Retry once it is ` +
            "funded, or once its funding window has closed" +
            // Fix round 4 (N3): a retried match that keeps failing holds withdraws up until MAX_MATCH_RETRIES drops it.
            // Final fix wave B (m-5): `daemon stop` refuses while a channel is live, so the restart waits for that.
            (awaiting.retriedMatches > 0 ? ". If this persists, restart the daemon once no channel is live (otherwise tell your human)." : ""),
        );
      }

      const usdc = this.opts.config.usdc;
      await this.resolvePendingWithdraw(usdc);
      const balance = await this.usdcBalance(usdc);
      // Plan 6 (spec §2.1, Review Focus 1): 0 on a native-gas chain; on Arc, the USDC gas every unsettled channel and
      // this wallet's own transactions may still need.
      const profile = chainProfile(this.opts.config.chainId);
      const unsettledChannels = profile?.nativeIsUsdc === true ? this.unsettledChannelCount() : 0;
      const reserve = withdrawReserve({
        profile,
        unsettledChannels,
        sessionGasWei: this.opts.config.sessionGasWei,
        feeCeilingWei: this.wallet.feeCeiling,
      });
      const withdrawable = balance > reserve ? balance - reserve : 0n;
      const amount = "all" in req ? withdrawable : req.amount;
      const closeFirst =
        `funds escrowed in channels are not in the wallet: close open channels first (${selfCommand()} close), then withdraw`;
      // Only when there is a reserve: on every other chain, these messages are exactly as before.
      const reserveNote =
        reserve > 0n
          ? ` -- ${formatUsdc6(reserve)} USDC of it is the gas reserve, which always stays in the wallet: gas on ` +
            `${profile?.name ?? `chain ${this.opts.config.chainId}`} is paid in USDC, for the session gas of ${unsettledChannels} ` +
            "unsettled channel(s) and this wallet's own transactions"
          : "";
      if (amount <= 0n) {
        throw new DaemonError(400, `nothing to withdraw: this wallet holds ${formatUsdc6(balance)} USDC${reserveNote}; ${closeFirst}`);
      }
      if (amount > withdrawable) {
        throw new DaemonError(
          400,
          `${formatUsdc6(amount)} USDC is more than this wallet can withdraw (${formatUsdc6(withdrawable)} USDC)${reserveNote}; ${closeFirst}`,
        );
      }
      if (this.stopped) throw new DaemonError(503, "the daemon is stopping");
      // Final fix wave B (I-1), as the sweep does: every hash the wallet's sender already tracks, so a failed wait
      // below names only what was sent during this withdraw. A raw failure of the wait (a rate-limited receipt read)
      // releases the transfer's entry, hash kept; a refill or deposit sent meanwhile is named too, which errs safe.
      const earlier = new Set(this.wallet.tracked().flatMap((t) => t.hashes));
      let receipt: Awaited<ReturnType<HubClient["transfer"]>>;
      try {
        receipt = await this.hub.transfer(this.wallet, usdc, owner, amount);
      } catch (err) {
        if (err instanceof HubRevertError) throw new DaemonError(409, `the USDC transfer to ${owner} was refused: ${err.message}`);
        const nonces = new Map<Hex, number>();
        for (const t of this.wallet.tracked()) for (const h of t.hashes) if (!earlier.has(h)) nonces.set(h, t.nonce);
        const mapped = withdrawWaitError(err, amount, owner, [...nonces.keys()]);
        if (mapped instanceof DaemonError && mapped.hashes !== undefined) {
          const typedNonce = (err as { nonce?: unknown }).nonce;
          const txs = mapped.hashes.map((hash) => {
            const nonce = nonces.get(hash) ?? (typeof typedNonce === "number" ? typedNonce : undefined);
            return nonce !== undefined ? { hash, nonce } : { hash };
          });
          this.savePendingWithdraw({ to: owner, amount, at: Date.now(), txs });
        }
        throw mapped;
      }
      const txHash = receipt.transactionHash;
      // Task 3 fix round 4 (N4, N5; spec §4.4): a mined, successful transfer is not proof the money moved -- a token
      // can return `false` (as a blocklisted recipient may) without reverting. Success is the receipt's own
      // Transfer(wallet -> owner, amount) log from the configured USDC, never a balance delta: a same-block inflow (a
      // settlement payout, a top-up) or, on Arc, USDC gas skews those both ways (fix round 1's M3 check, replaced).
      if (!confirmsTransfer(receipt.logs, { token: usdc, from: this.wallet.address, to: owner, amount })) {
        throw new DaemonError(502, `could not confirm the transfer in tx ${txHash}; check it before retrying`, [txHash]);
      }
      this.log(`withdrew ${formatUsdc6(amount)} USDC to the owner ${owner} (tx ${txHash})`);
      // For display only: the transfer is confirmed, so a read that fails now (an RPC blip) must not turn it into an
      // error that invites a second withdraw.
      let usdcAfter: bigint | null = null;
      let note: string | undefined;
      try {
        usdcAfter = await this.usdcBalance(usdc);
      } catch {
        note = `sent in tx ${txHash}; the balance could not be read`;
      }
      // M1: this wallet's open offers (posted, or accepted and not yet matched) are not refused -- they hold no funds
      // yet -- but one matched now may find the wallet short, so they are reported for the caller to warn about.
      const openOffers = this.records.offers().map((r) => r.offerId);
      return {
        to: owner,
        amount,
        txHash,
        usdcAfter,
        ...(note !== undefined ? { note } : {}),
        ...(openOffers.length > 0 ? { openOffers } : {}),
      };
    } finally {
      this.withdrawing = false;
    }
  }

  /**
   * Plan 6 (spec §2.1): the channels whose session keys this wallet may still have to refill -- every channel record
   * that is not finalized, whether live or recorded on disk and not yet opened (degraded ones excluded: they are
   * never watched). The same candidates `channelsAwaitingOwnDeposit` reads. Fix round 1 (I-5): `exclude` leaves out
   * the channel being funded.
   */
  private unsettledChannelCount(exclude?: Hex): number {
    const ids = new Set<Hex>();
    for (const l of this.live.values()) if (!l.record.finalized) ids.add(l.record.channelId);
    for (const r of this.records.channels()) {
      if (!r.finalized && !this.degraded.has(r.channelId) && !this.live.has(r.channelId)) ids.add(r.channelId);
    }
    if (exclude !== undefined) ids.delete(exclude);
    return ids.size;
  }

  /** The wallet's USDC balance at the latest block. */
  private usdcBalance(usdc: Address): Promise<bigint> {
    return this.client.readContract({ address: usdc, abi: erc20Abi, functionName: "balanceOf", args: [this.wallet.address] });
  }

  /** Final fix wave B (I-1): records a withdraw that may have gone out unconfirmed. A failed write is logged: the
   *  502 still names the hashes. */
  private savePendingWithdraw(p: PendingWithdraw): void {
    try {
      writeJsonAtomic(arenaPaths(this.opts.home).withdrawPending, p);
    } catch (err) {
      this.log(`withdraw: could not record the unconfirmed transfer (tx ${p.txs.map((t) => t.hash).join(", ")}): ${errorText(err)}`);
    }
  }

  /**
   * Final fix wave B (I-1): before a withdraw sends anything, an earlier one that may have gone out unconfirmed
   * (`PendingWithdraw`) is resolved from the chain:
   * - one of its transactions mined with the Transfer to the owner: it landed. Cleared, and this withdraw is refused
   *   (409), so a retry of it is never a second payment; the next withdraw goes ahead;
   * - every one of them mined without that Transfer, or never mined while its nonce has been used by another one:
   *   none can pay. Cleared, and this withdraw goes ahead;
   * - otherwise (still pending, unknown with its nonce free, or mined with its receipt unreadable): refused (409),
   *   kept -- until the hold is over: then cleared, and this withdraw goes ahead (its send replaces a transfer still
   *   pending at its nonce). A landed one is reported whatever its age.
   * A read that fails is a 503: retry shortly. An unreadable file is ignored (logged).
   */
  private async resolvePendingWithdraw(usdc: Address): Promise<void> {
    const path = arenaPaths(this.opts.home).withdrawPending;
    let p: PendingWithdraw | null;
    try {
      p = readJson<PendingWithdraw>(path);
    } catch (err) {
      this.log(`withdraw: ignoring an unreadable ${path}: ${errorText(err)}`);
      return;
    }
    if (p === null) return;
    const clear = () => rmSync(path, { force: true });
    const ageMs = Date.now() - p.at;
    const hashes = p.txs.map((t) => t.hash);
    const what = `an earlier withdraw of ${formatUsdc6(p.amount)} USDC to ${p.to}`;
    const unresolved: Hex[] = [];
    try {
      let latest: number | undefined;
      for (const t of p.txs) {
        const receipt = await this.client.getTransactionReceipt({ hash: t.hash }).catch((err: unknown) => {
          if (err instanceof TransactionReceiptNotFoundError) return null;
          throw err;
        });
        if (receipt !== null) {
          const paid =
            receipt.status === "success" &&
            confirmsTransfer(receipt.logs, { token: usdc, from: this.wallet.address, to: p.to, amount: p.amount });
          if (paid) {
            clear();
            throw new DaemonError(
              409,
              `${what} landed (tx ${t.hash}, block ${receipt.blockNumber}): the owner has been paid, so nothing was sent ` +
                "now. Run withdraw again only to send more",
              [t.hash],
            );
          }
          continue; // mined, and paid nothing: its nonce is used
        }
        const tx = await this.client.getTransaction({ hash: t.hash }).catch((err: unknown) => {
          if (err instanceof TransactionNotFoundError) return null;
          throw err;
        });
        if (tx !== null && tx.blockNumber !== null) {
          unresolved.push(t.hash); // mined, its receipt not readable yet
          continue;
        }
        latest ??= await this.client.getTransactionCount({ address: this.wallet.address, blockTag: "latest" });
        if (t.nonce !== undefined && latest > t.nonce) continue; // another transaction took its nonce: it can never land
        unresolved.push(t.hash);
      }
    } catch (err) {
      if (err instanceof DaemonError) throw err;
      throw new DaemonError(
        503,
        `${what} (tx ${hashes.join(", ")}) may have been sent, and it could not be checked (${rpcErrorSummary(err)}): nothing ` +
          "was sent now; retry in a few seconds",
        hashes,
      );
    }
    if (unresolved.length === 0) return clear();
    if (!(ageMs < WITHDRAW_UNCONFIRMED_HOLD_MS)) {
      this.log(`withdraw: ${what} (tx ${unresolved.join(", ")}) is still not confirmed, past its hold: sending`);
      return clear();
    }
    throw new DaemonError(
      409,
      `${what} was sent ${Math.round(ageMs / 1000)} s ago (tx ${unresolved.join(", ")}) and is not confirmed: it may still land, ` +
        `so nothing was sent now. Check the owner's balance, an explorer or "${selfCommand()} wallet". The next withdraw says ` +
        `so if it landed, and sends once it can no longer land, or ${WITHDRAW_UNCONFIRMED_HOLD_MS / 60_000} minutes after it was sent`,
      unresolved,
    );
  }

  /** The owner `withdraw()` pays, read from config.json now (never from `opts.config`, which is the config at
   *  start) and checked against the same rules `arena owner set` applies. */
  private recordedOwner(): Address {
    let raw: string | null;
    try {
      raw = readRecordedOwner(this.opts.home);
    } catch (err) {
      throw new DaemonError(500, errorText(err));
    }
    if (raw === null) throw new DaemonError(400, noOwnerMessage(selfCommand()));
    try {
      return validateOwner(raw, forbiddenOwners(this.opts.home, this.opts.config, this.wallet.address));
    } catch (err) {
      throw new DaemonError(400, `the owner recorded in config.json cannot be paid: ${errorText(err)}`);
    }
  }

  /**
   * Plan 5.6 Task 3 (Review Focus 4): every channel that still awaits this wallet's own deposit, each described
   * in one phrase naming its id -- empty when none does. A channel awaits it when it is not finalized (live, or
   * recorded on disk and not degraded) and, read from the chain now, its phase is `None` or `Funding`, this
   * player's side is not funded, and the funding deadline has not passed. That is every state from which the
   * main pass (`watch`) will still call `fund()` -- not only `wantsToFund`'s "fund on this tick": an accepter
   * (player 1) waiting for the offerer's deposit deposits the moment it lands. A channel past its deadline never
   * gets this wallet's deposit (it is retired, or reclaimed), so it does not hold a withdraw up. A match being
   * turned into a channel record right now (`claiming`), or waiting in `retryMatches` for the next pass (fix round
   * 1, M1), is about to become such a channel, so it counts too -- but only while this home still holds an offer
   * record or a channel record for it (fix round 4, N3). `retriedMatches` counts those.
   * A chain read that fails throws: whether a deposit is pending must be known, not assumed.
   */
  protected async channelsAwaitingOwnDeposit(): Promise<{ reasons: string[]; retriedMatches: number }> {
    const candidates = new Map<Hex, ChannelRecord>();
    for (const l of this.live.values()) if (!l.record.finalized) candidates.set(l.record.channelId, l.record);
    for (const r of this.records.channels()) {
      if (!r.finalized && !candidates.has(r.channelId) && !this.degraded.has(r.channelId) && !this.live.has(r.channelId)) {
        candidates.set(r.channelId, r);
      }
    }
    const out: string[] = [];
    if (candidates.size > 0) {
      let now: bigint;
      try {
        now = (await this.client.getBlock()).timestamp;
      } catch (err) {
        throw new DaemonError(503, `could not read the chain to check for pending deposits: ${errorText(err)}`);
      }
      for (const r of candidates.values()) {
        let info: Awaited<ReturnType<HubClient["channelInfo"]>>;
        try {
          info = await this.hub.channelInfo(r.channelId);
        } catch (err) {
          throw new DaemonError(503, `could not read channel ${r.channelId} to check for a pending deposit: ${errorText(err)}`);
        }
        if ((info.phase === "None" || info.phase === "Funding") && !info.funded[r.me] && now <= r.params.fundingDeadline) {
          out.push(`channel ${r.channelId} still awaits this wallet's deposit (funding deadline ${r.params.fundingDeadline})`);
        }
      }
    }
    for (const offerId of this.claiming) out.push(`offer ${offerId} is being matched into a channel that will await this wallet's deposit`);
    // Task 3 fix round 1 (M1): a match whose handling failed (or was deferred by a withdraw) and is retried on the
    // next pass is just as close to becoming such a channel. Fix round 4 (N3): only if this home can still turn it
    // into one. A match the host pushed for an offer this home never posted is deferred too (the deferral comes
    // before onMatch's own record check), and is dropped on the next pass: it must not hold a withdraw up.
    let retriedMatches = 0;
    for (const offerId of this.retryMatches.keys()) {
      if (this.claiming.has(offerId) || !this.hasMatchRecord(offerId)) continue;
      retriedMatches++;
      out.push(`offer ${offerId} was matched and its channel, still being set up, will await this wallet's deposit`);
    }
    return { reasons: out, retriedMatches };
  }

  /** Fix round 4 (N3): true when this home holds a channel record or an offer record for `offerId`. An offer record
   *  that cannot be read counts: it is still this home's offer, and `MAX_MATCH_RETRIES` bounds how long its match
   *  is retried. `offerId` is canonical here (`onMatch` checks it before deferring), so it is a safe file name. */
  private hasMatchRecord(offerId: Hex): boolean {
    if (this.channelForOffer(offerId) !== null) return true;
    try {
      return this.records.offer(offerId) !== null;
    } catch {
      return true;
    }
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

  /**
   * Plan 6 fix round 1 (spec §2.1 as amended, audit-daemon I-5): on a `nativeIsUsdc` chain, deposits, top-ups and
   * refills all draw on one USDC balance, so opening or funding a channel must leave the other unsettled channels'
   * `withdrawReserve` in the wallet. Returns why this wallet cannot pay `deposit` + fee + `ownGasWei` of session gas on
   * top of that reserve (`oneBalanceOpenNeed`), or null when it can -- and always null, with no chain read at all, on
   * a chain whose gas is native. `exclude` is the channel being funded, which is not one of the "others". The balance
   * is the ERC-20 `balanceOf`, the figure `withdraw()` uses (on Arc, the native balance rounded down).
   */
  private async openingShortfall(o: { deposit: bigint; feePerPlayer?: bigint; ownGasWei: bigint; exclude?: Hex }): Promise<string | null> {
    const profile = chainProfile(this.opts.config.chainId);
    if (profile?.nativeIsUsdc !== true) return null;
    const feePerPlayer = o.feePerPlayer ?? (await this.hub.feeConfig()).feePerPlayer;
    const others = this.unsettledChannelCount(o.exclude);
    const gas = { sessionGasWei: this.opts.config.sessionGasWei, feeCeilingWei: this.wallet.feeCeiling };
    const need = oneBalanceOpenNeed({ deposit: o.deposit, feePerPlayer, ownGasWei: o.ownGasWei, otherChannels: others, ...gas });
    const balance = await this.usdcBalance(this.opts.config.usdc);
    if (balance >= need) return null;
    const reserve = withdrawReserve({ profile, unsettledChannels: others, ...gas });
    return (
      `this wallet holds ${formatUsdc6(balance)} USDC, ${formatUsdc6(need - balance)} USDC short of the ${formatUsdc6(need)} USDC ` +
      `this channel needs: its deposit of ${formatUsdc6(o.deposit)} USDC and fee of ${formatUsdc6(feePerPlayer)} USDC, its ` +
      `session gas, and the ${formatUsdc6(reserve)} USDC gas reserve that always stays in the wallet (gas on ${profile.name} ` +
      `is paid in USDC, for the session gas of ${others} other unsettled channel(s) and this wallet's own transactions)`
    );
  }

  /** Plan 6 fix round 1 (I-5): `createOffer` and `acceptOffer` refuse (409) a channel this wallet could not fund
   *  without spending the other channels' reserve -- so a matched channel never sits unfundable until its deadline. */
  private async checkOpeningAffordable(deposit: bigint, what: "offer" | "accept"): Promise<void> {
    const why = await this.openingShortfall({ deposit, ownGasWei: this.opts.config.sessionGasWei });
    if (why !== null) {
      throw new DaemonError(
        409,
        `cannot ${what === "offer" ? "post this offer" : "accept this offer"}: ${why}. Run "${selfCommand()} fund" for what to ask your human for`,
      );
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

  /**
   * Posts an offer. H1 (ledger ruling, `offer --ttl`): `ttlSeconds` sets its signed `expiresAt` to chain time now plus
   * it, between `MIN_OFFER_TTL_SECONDS` and `OFFER_TTL_SECONDS` (the default, unchanged) -- so an agent that waits a
   * bounded time for a match can post an offer that cannot be matched after it has stopped waiting.
   */
  async createOffer(o: { deposit: bigint; stakePerGame: bigint; challengeTimeout?: bigint; ttlSeconds?: bigint }): Promise<{ offerId: Hex }> {
    // Plan 4.5 Task 11 fix round (C2): once the host has refused a subscribe, this connection's match delivery is
    // broken until restart -- a new offer would post fine (200) and then silently never learn of its match if it
    // is the offerer. Refuse up front instead of returning a false 200.
    this.checkLobbyHealthy();
    // I4: refuse offers the hub would never let anyone fund (ChannelHub rejects these params on deposit), so a
    // matched channel can never sit unfundable while its deposit reverts on every tick.
    if (o.stakePerGame <= 0n) throw new DaemonError(400, "stakePerGame must be greater than 0");
    if (o.deposit < o.stakePerGame) throw new DaemonError(400, "deposit must be at least stakePerGame");
    const ttl = o.ttlSeconds ?? OFFER_TTL_SECONDS;
    if (ttl < MIN_OFFER_TTL_SECONDS || ttl > OFFER_TTL_SECONDS) {
      throw new DaemonError(400, `ttl must be between ${MIN_OFFER_TTL_SECONDS} and ${OFFER_TTL_SECONDS} seconds (got ${ttl})`);
    }
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
    // Plan 6 fix round 1 (I-5): on a one-balance chain, never an offer whose channel would spend the others' reserve.
    await this.checkOpeningAffordable(o.deposit, "offer");
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
      expiresAt: chainNow + ttl,
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
      // Plan 6 fix round 1 (I-5): see createOffer.
      await this.checkOpeningAffordable(so.offer.deposit, "accept");
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
    // Task 3 fix round 1 (M1): a withdraw in flight is moving this wallet's USDC. A match handled now could open a
    // channel whose deposit then finds the wallet short, so it waits for the next pass (`retryMatches`), after the
    // transfer. Synchronous with the check above: no await separates the two, so a retried match is re-deferred
    // atomically. withdraw()'s 409 check counts deferred matches, so a later withdraw waits for them in turn.
    if (this.withdrawing) {
      this.retryMatches.set(offerId, m);
      return;
    }
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
    let failed = false;
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
          this.fireAndForget("tick", this.tick());
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
      this.fireAndForget("tick", this.tick());
    } catch (err) {
      failed = true;
      release();
      // Fix round 4 (N3): retried on the next pass, but not forever -- see MAX_MATCH_RETRIES.
      const failures = (this.matchFailures.get(offerId) ?? 0) + 1;
      if (failures >= MAX_MATCH_RETRIES) {
        this.matchFailures.delete(offerId);
        this.retryMatches.delete(offerId);
        this.log(
          `giving up on the match for offer ${offerId} after ${failures} failed attempts: ${errorText(err)} ` +
            "(a daemon restart watches its offer again, and the host replays the match)",
        );
        return;
      }
      this.matchFailures.set(offerId, failures);
      if (!this.stopped) this.retryMatches.set(offerId, m);
      this.log(`match handling failed (retried on the next tick): ${errorText(err)}`);
    } finally {
      if (!failed) this.matchFailures.delete(offerId);
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
        `the host refused this connection's last subscribe (${this.lobbyError}); restart this daemon to recover, once no ` +
          "channel is live (otherwise tell your human)",
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
    const sessionSender = this.sessionSenderFor(record.sessionKey);
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
      sessionGasLowCause: null,
      refillTransientFailures: 0,
      refillNeedWei: null,
      gasCheckRetryAt: 0,
      gasCheckBackoffMs: 0,
      settledWake: false,
      humanMustMoveWoken: null,
      settledAt: null,
      sweep: { blockedUntil: 0, backoffMs: 0, attempts: 0, pendingTx: record.sweepPending },
      unreadableBlock: null,
      skippedRetryAt: 0,
      skippedRetryIndex: 0,
      unseenRegistered: null,
      challengeUnseenWoken: null,
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
    // Plan 6 fix round 1 (spec §2.1 as amended, audit-daemon I-5): on a one-balance chain, neither the approve, the
    // top-up nor the deposit goes out while the wallet cannot pay them on top of the other channels' reserve. The
    // channel backs off like a launch-limit revert below, and is retired at its deadline if it never can: an
    // unfunded side costs nothing to leave. A no-op (no read) on a chain whose gas is native.
    if (chainProfile(this.opts.config.chainId)?.nativeIsUsdc === true) {
      const target = this.opts.config.sessionGasWei;
      const keyBalance = target > 0n ? await this.client.getBalance({ address: l.sessionSender.address }) : 0n;
      const why = await this.openingShortfall({
        deposit: p.deposit,
        feePerPlayer: p.feePerPlayer,
        ownGasWei: keyBalance < target ? target - keyBalance : 0n,
        exclude: l.record.channelId,
      });
      if (why !== null) return this.backOffFunding(l, `funding: ${why}`, { log: true });
    }
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
    try {
      await this.sharedTopUp(l, () => this.topUpSession(l));
    } catch (err) {
      // Plan 6 Task 2 (audit-daemon I-1): a top-up mined and reverted reached nothing, and the next pass would send
      // (and pay for) the same revert: funding backs off like a launch-limit revert below, and no deposit goes in
      // for a channel whose key holds no dispute gas.
      if (err instanceof TopUpRevertedError) return this.backOffFunding(l, `funding: ${err.message}`, { log: true });
      throw err;
    }
    if (this.stopped) return;
    try {
      await this.hub.deposit(this.wallet, p);
    } catch (err) {
      // Task 2 (spec §13): a revert caused by a launch limit is not a bug -- it can resolve itself (the owner
      // raises a cap or unpauses) or never resolve (reclaim after the deadline). Either way, retrying it on every
      // tick is a hot loop against the RPC/chain for no benefit, so back off instead of rethrowing.
      if (err instanceof HubRevertError && err.errorName && LIMIT_REVERTS.has(err.errorName)) {
        return this.backOffFunding(l, `funding: ${err.errorName}`, { log: false });
      }
      throw err;
    }
    l.fundBlockedUntil = null;
    if (l.lastError?.startsWith("funding:")) l.lastError = null;
  }

  /** Backs `fund()` off for `FUND_BACKOFF_SECONDS` of chain time, with `message` as the channel's `lastError`. H1
   *  (Task 4 report, concern on `fund()`): the block is read first, so `lastError` and `fundBlockedUntil` are set
   *  together -- a status read in between never shows the reason without the back-off -- and a failed read sets
   *  neither (the error reaches the watch pass, which records it; the next pass retries). */
  private async backOffFunding(l: ChannelHandle, message: string, opts: { log: boolean }): Promise<void> {
    const until = (await this.client.getBlock()).timestamp + FUND_BACKOFF_SECONDS;
    if (opts.log && l.lastError !== message) {
      this.log(`channel ${l.record.channelId}: ${message} (retried in ${FUND_BACKOFF_SECONDS}s of chain time)`);
    }
    l.lastError = message;
    l.fundBlockedUntil = until;
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
    // Fix round (minor, "a failed fee estimate also raises session-gas-low"): checked as its own step, so a
    // failure here is unambiguously a `SessionGasEstimateError` -- rather than some other, harder-to-classify
    // error shape surfacing from deep inside the sender's own send path (`SerialTxSender.sendFresh`'s internal
    // `estimateFees` call, whose failure would otherwise propagate as a raw, unclassified error).
    try {
      await this.client.estimateFeesPerGas();
    } catch (err) {
      throw new SessionGasEstimateError(err);
    }
    const value = target - balance;
    // Plan 6 Task 2 (spec §2.2): the gas limit is the node's estimate plus a margin (`topUpGasLimit`), not a fixed
    // 21000. A plain value transfer costs 21000 on Arc too, so this is hardening against a chain whose transfer costs
    // more. A failed estimate sends nothing -- never a guessed limit -- and raises `session-gas-low` like a failed
    // fee estimate. One whose cause is the wallet's balance is reported as exactly that.
    let estimated: bigint;
    try {
      estimated = await this.valueTransferGas(this.wallet.address, l.sessionSender.address, value);
    } catch (err) {
      if (isInsufficientFundsError(err)) throw new TxInsufficientFundsError(this.wallet.address, err);
      throw new SessionGasEstimateError(err, "gas");
    }
    if (this.stopped) return false;
    const req = { to: l.sessionSender.address, data: "0x" as Hex, value, gas: topUpGasLimit(estimated) };
    // The wallet's sender tracks its nonces (Plan 4.5 Task 10 round 4): a top-up re-sent after an earlier wait gave
    // up (dropped or stuck) replaces it at its nonce, and one whose nonce turns out used is not re-sent, so it is
    // paid at most once.
    const hash = await this.wallet.send(req);
    // Plan 4.5 Task 10 review: bounded, with drop detection and same-nonce replacement, like every hub write.
    const receipt = await waitOrReplace(this.client, this.wallet, req, hash, { signal: this.aborter.signal });
    // Plan 6 Task 2 (audit-daemon I-1): a mined revert moved nothing. Before, it was counted as a refill, cleared the
    // back-off and was sent again on the next pass. The receipt may be a replacement's: it is named by its own hash.
    if (receipt.status !== "success") throw new TopUpRevertedError(receipt.transactionHash);
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
    // H3: a balance read that failed is not retried before its back-off is over.
    if (Date.now() < l.gasCheckRetryAt) return;
    if (!(await this.refillBackoffGate(l))) return;
    // (A funding top-up in flight that fails is fund()'s to report, not this caller's.)
    await this.sharedTopUp(l, async () => {
      const floor = sessionGasFloorOf(this.opts.config);
      let balance: bigint;
      try {
        balance = await this.client.getBalance({ address: l.sessionSender.address });
      } catch (err) {
        const starting = l.gasCheckBackoffMs === 0;
        l.gasCheckBackoffMs = starting ? GAS_CHECK_BACKOFF_START_MS : Math.min(l.gasCheckBackoffMs * 2, GAS_CHECK_BACKOFF_MAX_MS);
        l.gasCheckRetryAt = Date.now() + l.gasCheckBackoffMs;
        if (starting || l.gasCheckBackoffMs === GAS_CHECK_BACKOFF_MAX_MS) {
          this.log(
            `channel ${l.record.channelId}: session gas check failed (retried in ${l.gasCheckBackoffMs / 1000}s): ${errorText(err)}`,
          );
        }
        return;
      }
      if (l.gasCheckBackoffMs !== 0) this.log(`channel ${l.record.channelId}: session gas check read the balance again`);
      l.gasCheckBackoffMs = 0;
      l.gasCheckRetryAt = 0;
      if (balance >= floor) {
        l.refillTransientFailures = 0;
        this.clearSessionGasLow(l);
        this.endRefillBackoff(l);
        return;
      }
      try {
        if (await this.topUpSession(l)) {
          l.refills++;
          this.log(`channel ${l.record.channelId}: refilled the session key's dispute gas (it was at ${balance} wei, floor ${floor})`);
        }
        l.refillTransientFailures = 0;
        this.clearSessionGasLow(l);
        this.endRefillBackoff(l);
      } catch (err) {
        if (this.stopped) return;
        // Plan 5 Task 1 (mainnet gates: session-gas-low precision): raised only when the wallet itself cannot pay
        // (insufficient funds, over its fee cap) or a gas/fee estimate for the refill failed outright -- every
        // other refill error (a nonce race, a dropped/stuck/aborted send, a missing receipt) is transient and
        // re-evaluated on the next pass without alarming the agent over something the daemon may resolve on its own.
        // Plan 6 Task 2 (audit-daemon I-1): so is a top-up that was mined and reverted -- it is not a refill (the
        // count and the back-off are left alone), and sending it again on the next pass would only pay for another
        // revert, so the back-off below holds it off.
        // H1 (audit-daemon M-5): transient failures are counted, and REFILL_TRANSIENT_FAILURES_ALERT of them in a row
        // raise it too. H1 (Task 2 review Minor-2): every raise carries its cause, which picks the status action.
        const cause = refillFailureCause(err);
        if (cause === null) {
          l.refillTransientFailures++;
          const name = err instanceof Error ? err.name : "Error";
          this.log(`channel ${l.record.channelId}: refill failed, ${name}: ${errorText(err)} (re-evaluated on the next pass)`);
        } else {
          l.refillTransientFailures = 0;
        }
        const raised: SessionGasLowCause | null =
          cause ?? (l.refillTransientFailures >= REFILL_TRANSIENT_FAILURES_ALERT ? { kind: "failing", failures: l.refillTransientFailures } : null);
        if (raised !== null) {
          const first = l.sessionGasLow === null;
          l.sessionGasLow =
            raised.kind === "failing"
              ? `the session key holds ${balance} wei, below the floor of ${floor}, and the last ${raised.failures} refills failed in transit: ${errorText(err)}`
              : `the session key holds ${balance} wei, below the floor of ${floor}, and the wallet could not refill it: ${errorText(err)}`;
          l.sessionGasLowCause = raised;
          this.log(`channel ${l.record.channelId}: ${l.sessionGasLow}`);
          if (first) this.notify();
        }
        // H1 (audit-daemon M-8): only a shortfall of the wallet's own may end the back-off on a balance rise, and only
        // on one that covers the refill: its value, plus its gas at the wallet's fee ceiling.
        l.refillNeedWei =
          cause?.kind === "funds" ? this.opts.config.sessionGasWei - balance + topUpGasLimit(21_000n) * this.wallet.feeCeiling : null;
        this.startOrBumpRefillBackoff(l);
      }
    }).catch(() => undefined);
  }

  /** Plan 5 Task 1: true if `ensureSessionGas` may attempt a refill for `l` right now. False while a prior
   *  failure's back-off has not yet elapsed -- unless the wallet's own balance has risen since it was last
   *  observed, which ends the back-off early (the wallet may have just been topped up). A failed balance read
   *  never blocks the attempt (the back-off is about the refill itself, not about reading the wallet). Fix round
   *  (minor): the wallet balance is only worth reading while a back-off is actually in effect -- there is nothing
   *  to reset otherwise, so the common (not backed off) case costs no RPC call at all. */
  private async refillBackoffGate(l: ChannelHandle): Promise<boolean> {
    if (!(l.refillBlockedUntil > 0)) return true;
    // H1 (audit-daemon M-8, Task 2 review Minor-2): on Arc every USDC inflow -- a payout, a sweep of another channel
    // -- raises the wallet's balance. Only a back-off the wallet's own shortfall caused ends on a rise, and only on a
    // rise that covers the refill (`refillNeedWei`); a reverted top-up, a fee cap, a failed estimate or a send lost
    // in transit waits its back-off out, and its balance is not even read.
    if (l.refillNeedWei !== null) {
      const balance = await this.client.getBalance({ address: this.wallet.address }).catch(() => null);
      if (balance !== null) {
        const rose = l.refillLastWalletBalance !== null && balance > l.refillLastWalletBalance;
        if (rose && balance >= l.refillNeedWei) this.endRefillBackoff(l);
        l.refillLastWalletBalance = balance;
      }
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
    l.refillNeedWei = null;
    if (l.sessionGasLow === null) return;
    l.sessionGasLow = null;
    l.sessionGasLowCause = null;
    l.sessionGasLowWoken = false;
    this.notify();
  }

  // ------------------------------------------------------------------ sweep (Plan 5 Task 1)

  /**
   * The gas limit of a sweep: the node's estimate of this very value transfer (the session key to the wallet). H1
   * (audit-daemon M-3): never a fixed 21,000. A plain transfer costs 21,000 on Arc today (arc-facts.md), but a chain
   * whose value transfers cost more would have made every sweep fail until it was abandoned, stranding the key's gas.
   * With the top-up (`valueTransferGas`), one helper for both value transfers. Unlike the top-up's limit, no margin:
   * a value transfer to an EOA costs exactly its estimate, and the sweep reserves `gas x fee` out of what it sends, so
   * a margin would only leave `margin x fee` in a retired key for good. (A contract wallet, which may run logic on
   * receipt, was always estimated.) The estimate is the sweep's own dry run, so its failure -- e.g. a wallet that
   * rejects the transfer, or a blocklisted address on Arc -- is charged like a failed send, not a read (M4).
   */
  private gasForSweep(sender: SerialTxSender): Promise<bigint> {
    return this.valueTransferGas(sender.address, this.wallet.address, 1n);
  }

  /** H1 (audit-daemon M-3): the node's gas estimate for a plain value transfer of `value` from `from` to `to` --
   *  shared by the top-up (which adds `topUpGasLimit`'s margin) and the sweep (which uses it as is). */
  private valueTransferGas(from: Address, to: Address, value: bigint): Promise<bigint> {
    return this.client.estimateGas({ account: from, to, data: "0x", value });
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
  /** Final fix wave (M4): runs one pre-send chain read of a sweep attempt, turning its failure into a
   *  `SweepReadError`. */
  private async sweepRead<T>(read: () => Promise<T>): Promise<T> {
    try {
      return await read();
    } catch (err) {
      throw new SweepReadError(err);
    }
  }

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
   * SWEEP_HEADROOM_NUM/DEN)` (1.3x) by default -- so a single 12.5% same-nonce replacement bump still fits the
   * balance bound; dust if that leaves `<= gas * feePerGas` *and* the key has no dead entry to answer for (see
   * important 5 below). Throws if the fee estimate is 0 (nothing reliable to reserve a bump against). **Rule 4**:
   * success requires the mined receipt's `status` to be `"success"` -- a reverted send (a contract-wallet
   * recipient that rejects it) must never be recorded as swept -- and its hash is, structurally, always one this
   * call's own `send`/its replacements produced (waitOrReplace only ever follows the entry seeded by *this*
   * `hash`). **I7**: at most one immediate retry, with fresh reads, on `TxInsufficientFundsError`.
   *
   * **Fix round 2, important 5**: a dead (released) entry already on this key -- there should be at most one,
   * since rule 1's gate above already refuses to run while any entry is still `"waiting"` -- needs its own last
   * fee bumped by at least 12.5% to be replaceable at all (`SerialTxSender.replaceReleased`'s own
   * `affordable(bumpFees(e.lastFees), room)` check). If that bump exceeds the normal 1.3x reserve, the sweep
   * reserves for it instead, or its own replacement send below could never afford to outbid it -- the channel
   * would just back off, retry, and fail the same way forever, eventually abandoning gas it could have swept.
   * When the reserve is elevated for this reason and the balance still can't clear it, this throws (backs off
   * and retries) rather than declining as dust: a low *value* here is about the dead entry, not a genuinely small
   * balance -- the one case `"dust"` is for.
   */
  private async performSweep(
    sender: SerialTxSender,
    giveUpAt?: number,
  ): Promise<{ status: "dust" } | { status: "swept"; amount: bigint; hash: Hex }> {
    for (let attempt = 0; ; attempt++) {
      if (this.stopped) throw new Error("stopped");
      // Fix round 3, I-1(a): tracked() alone never notices a released entry has since mined -- refresh() re-runs
      // the same prune() send() itself would, so a stale entry (probe E1/E2: released, then explicitly mined,
      // with nothing of ours ever reading it in between) is gone from tracked() below, not mistaken for a still-
      // live dead transaction that needs answering for.
      await this.sweepRead(() => sender.refresh());
      const balance = await this.sweepRead(() => this.client.getBalance({ address: sender.address }));
      // H1 (M-3): an empty key is dust before anything is estimated (the estimate sends 1 wei, which it cannot).
      if (balance === 0n) return { status: "dust" };
      const gasLimit = await this.gasForSweep(sender);
      // Plan 6 Task 2: never under the session sender's fee floor -- the send below is floored, so a reserve sized on
      // a lower estimate could not pay its own transaction, and every attempt would be refused until abandoned.
      const market = await this.sweepRead(() => this.currentFeePerGas());
      if (market === 0n) throw new Error("the fee estimate is 0: refusing to sweep without a reliable fee to reserve a bump against");
      const feePerGas = market > sender.minFeePerGas ? market : sender.minFeePerGas;
      const baseReserve = (feePerGas * SWEEP_HEADROOM_NUM + (SWEEP_HEADROOM_DEN - 1n)) / SWEEP_HEADROOM_DEN;
      // Fix round 3, I-1(b): dust is decided against the plain reserve first, regardless of any tracked entry --
      // a balance this low has nothing worth sending whether or not there is a dead transaction to answer for
      // (this is the regression Important 5 introduced: it threw/backed off forever here instead, even for a
      // balance that was independently already dust). Only once the plain reserve leaves it genuinely sweepable
      // does a stuck entry's own, possibly higher, reserve requirement get a say -- and only then, if *that*
      // alone pushes the value back down to the dust line, does this throw (back off, retry) rather than send.
      const plainValue = balance - gasLimit * baseReserve;
      if (plainValue <= gasLimit * feePerGas) return { status: "dust" };
      const stuck = sender
        .tracked()
        .filter((t) => t.state === "released")
        .sort((a, b) => a.nonce - b.nonce)[0];
      // An unknown-fee entry (e.g. adopted from a pending nonce after a restart) is replaced with `2 x` the
      // market estimate (`SerialTxSender.replaceReleased`'s own `doubled(estimate)` path, which skips the
      // `affordable` check but still prices the send there); a known one needs at least its own fee bumped.
      const stuckReserve = !stuck ? 0n : hasKnownFee(stuck.lastFees) ? bumpFeePerGas(feePerGasOf(stuck.lastFees)) : 2n * feePerGas;
      const reservePerGas = stuck && stuckReserve > baseReserve ? stuckReserve : baseReserve;
      const value = balance - gasLimit * reservePerGas;
      if (stuck && stuckReserve > baseReserve && value <= gasLimit * feePerGas) {
        throw new Error(
          `a dead transaction on this key (nonce ${stuck.nonce}, last fee ${feePerGasOf(stuck.lastFees)}) needs more reserve than this balance affords to replace`,
        );
      }
      const req = { to: this.wallet.address, data: "0x" as Hex, value, gas: gasLimit };
      // H3: every hash this key's sender already holds -- an earlier intent's -- so a failed wait below names only this
      // sweep's own transactions (the next attempt records whichever of them landed as the sweep).
      const earlier = new Set(sender.tracked().flatMap((t) => t.hashes));
      let hash: Hex;
      try {
        hash = await sender.send(req);
      } catch (err) {
        if (err instanceof TxInsufficientFundsError && attempt === 0) continue; // I7: one immediate retry
        // H3 fix round 1 (review M2): a send that failed ambiguously -- a lost response, a "nonce too low" whose hash
        // could not be read -- leaves its transaction's hash in the sender's entry (a send the node refused outright
        // leaves none). It may land: the next attempt checks it first, as after a failed receipt wait.
        const fresh = sender
          .tracked()
          .flatMap((t) => t.hashes)
          .filter((h) => !earlier.has(h));
        if (fresh.length > 0) throw new SweepWaitError(fresh, err);
        throw err;
      }
      let receipt: Awaited<ReturnType<typeof waitOrReplace>>;
      try {
        receipt = await waitOrReplace(this.client, sender, req, hash, { signal: this.aborter.signal, giveUpAt });
      } catch (err) {
        // These carry their own verdict on the transaction (and the hashes to check, where it may still land).
        if (
          err instanceof TxReceiptMissingError ||
          err instanceof TxDroppedError ||
          err instanceof TxStuckError ||
          err instanceof TxWaitAbortedError ||
          err instanceof TxNonceUsedError
        ) {
          throw err;
        }
        // H3 (rehearsal §8.4): anything else -- a rate-limited receipt read, most likely -- left the sweep sent and
        // unconfirmed. Before, its hash was dropped here, and the next attempt read the landed sweep's leftover as dust.
        const own = (sender.tracker?.entryOf(hash)?.hashes ?? []).filter((h) => h !== hash && !earlier.has(h));
        throw new SweepWaitError([hash, ...own], err);
      }
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
    input: ChannelRecord,
    sender: SerialTxSender,
    backoff: SweepBackoff,
    save: (r: ChannelRecord) => void,
    opts: {
      force?: boolean;
      // Minor 3: bounds this one record's own receipt wait (via `performSweep`), so it can never eat more than
      // its share of `sweep()`'s overall budget.
      giveUpAt?: number;
      // Minor 4: a re-check of an already-`isSweptDone` channel that `sweep()`'s `--channel` branch found a
      // non-dust balance sitting on -- lets this one call through the "already done" skip guard just below.
      recheck?: boolean;
    } = {},
  ): Promise<SweepAttemptResult> {
    let record = input;
    // Final fix wave (M5): `sweepPending` on disk mirrors `backoff.pendingTx`, so a restarted daemon resumes
    // checking the same hashes instead of reading a landed sweep's leftover balance as "dust".
    const persistPending = () => {
      const want = backoff.pendingTx !== undefined && backoff.pendingTx.length > 0 ? [...backoff.pendingTx] : undefined;
      if ((record.sweepPending ?? []).join() === (want ?? []).join()) return;
      record = { ...record, sweepPending: want };
      save(record);
    };
    // Fix round 2, important 1: a manual sweep (force) on an "abandoned" channel gets a fresh episode -- I8's own
    // write-off must never be permanent for `arena sweep`/`POST /sweep`, or every bulk sweep just reports every
    // abandoned channel as "not sweepable yet" forever. Computed before the try below (the catch block, at the
    // bottom, also reads `rechecking`) but does not itself do anything that can throw.
    const retryingAbandoned = opts.force === true && record.swept === "abandoned";
    if (retryingAbandoned) backoff.attempts = 0;
    const rechecking = opts.recheck === true && isSweptDone(record.swept);
    try {
      // Fix round 2, minor 2 (fix round 3, C-1: moved inside this try -- it used to sit before it, so any throw
      // out of `recoverPendingSweepTx` -- e.g. a `getTransaction` RPC blip -- escaped this method entirely; with
      // no catch anywhere above a timer-driven `void this.mainPass()`, that crashed the whole daemon process).
      // Checked first, before anything else below -- including the back-off gate just past this block -- since
      // the transaction may already have landed and there is nothing to gain by waiting the back-off out before
      // finding that out.
      // Final fix wave (M5): also when `arena sweep` retries an abandoned channel -- its last send may have landed.
      if (backoff.pendingTx !== undefined && (record.swept === undefined || retryingAbandoned)) {
        // Final fix wave (M3): the first probe is immediate, but once one has found the transaction still
        // pending, the next waits out the back-off like any other attempt instead of re-probing every pass.
        const probed = backoff.pendingProbes ?? 0;
        const receiptless = backoff.receiptlessProbes ?? 0;
        if ((probed > 0 || receiptless > 0) && !opts.force && backoff.blockedUntil > 0 && Date.now() < backoff.blockedUntil) {
          return { kind: "skipped", record };
        }
        const recovered = await this.recoverPendingSweepTx(backoff.pendingTx);
        // An RPC failure is retried on the next pass, not counted as a pending probe.
        if (recovered === "unknown") return { kind: "skipped", record };
        let giveUp = false;
        if (recovered === "receiptless") {
          // H1 (audit-daemon M-4): mined, but no receipt can be read. Arc documents exactly that for an included
          // revert (a blocklisted address), so it may never change: probed with the back-off, and after
          // SWEEP_PENDING_PROBES in a row it is charged as a failed attempt and the sweep goes on -- before, every
          // pass found "unknown" again, and the record was never re-sent, abandoned or evicted.
          backoff.receiptlessProbes = receiptless + 1;
          if (backoff.receiptlessProbes < SWEEP_PENDING_PROBES) {
            this.bumpSweepBackoff(record.channelId, backoff);
            return { kind: "skipped", record };
          }
          this.log(
            `channel ${record.channelId}: sweep transaction(s) ${backoff.pendingTx.join(", ")} mined with no readable receipt ` +
              `${backoff.receiptlessProbes} times in a row: counted as a failed attempt`,
          );
          giveUp = true;
        }
        if (giveUp) {
          backoff.pendingTx = undefined;
          backoff.pendingProbes = 0;
          backoff.receiptlessProbes = 0;
          persistPending();
          backoff.attempts++;
        } else if (recovered === "pending") {
          backoff.pendingProbes = probed + 1;
          // Not a failure (no attempt charged), but backed off. After SWEEP_PENDING_PROBES probes, fall through
          // to a normal attempt: its send replaces the released entry at the same nonce with raised fees (at
          // most one of them can land), and `pendingTx` is kept so a later probe still recognizes the old one.
          if (backoff.pendingProbes < SWEEP_PENDING_PROBES) {
            this.bumpSweepBackoff(record.channelId, backoff);
            return { kind: "skipped", record };
          }
        } else if (recovered !== "receiptless") {
          backoff.pendingTx = undefined;
          backoff.pendingProbes = 0;
          backoff.receiptlessProbes = 0;
          if (recovered !== "failed") {
            const updated = appendSweep(record, recovered.amount, recovered.hash);
            save(updated);
            this.endSweepBackoff(record.channelId, backoff);
            return { kind: "swept", record: updated, amount: recovered.amount, hash: recovered.hash };
          }
          // Fix round 3, I-2: confirmed gone (reverted, or the node no longer knows it at all) -- nothing to
          // recover. Charged as a failed attempt (this recovery slot found nothing, same as any other failure
          // would) and falls through to a fresh attempt below, within this same try -- never an early abandon
          // from this alone; the normal attempt just below decides that for itself if it also fails.
          persistPending();
          backoff.attempts++;
        }
      }
      if (this.stopped || (record.swept !== undefined && !retryingAbandoned && !rechecking)) return { kind: "skipped", record };
      if (!opts.force && backoff.blockedUntil > 0 && Date.now() < backoff.blockedUntil) return { kind: "skipped", record };
      // Rule 1: never beside a transaction actively being waited on elsewhere on this same session key.
      if (sender.tracked().some((t) => t.state === "waiting")) return { kind: "skipped", record };
      if (!(await this.sweepRead(() => this.isSweepable(record)))) return { kind: "skipped", record };
      const outcome = await this.performSweep(sender, opts.giveUpAt);
      if (outcome.status === "dust") {
        // Minor 4: a recheck of an already-done channel finding only dust residue (typically the previous
        // sweep's own untouched fee reserve, never truly zero) is not new information -- the record already
        // correctly reflects its prior state (`true`, with its real amount/tx, or already "dust"), and must
        // never be downgraded from a genuine `true` to "dust" just because what is left over now is small.
        if (rechecking) return { kind: "dust", record };
        // Final fix wave (M3): an attempt that went ahead past a still-pending transaction reads a near-zero
        // balance if that transaction landed in the meantime -- recognize it as the sweep instead of "dust".
        if (backoff.pendingTx !== undefined && backoff.pendingTx.length > 0) {
          const late = await this.recoverPendingSweepTx(backoff.pendingTx);
          if (typeof late === "object") {
            const swept = appendSweep(record, late.amount, late.hash);
            save(swept);
            this.endSweepBackoff(record.channelId, backoff);
            return { kind: "swept", record: swept, amount: late.amount, hash: late.hash };
          }
        }
        const updated: ChannelRecord = { ...record, swept: "dust", sweepPending: undefined };
        save(updated);
        this.endSweepBackoff(record.channelId, backoff);
        return { kind: "dust", record: updated };
      }
      const updated = appendSweep(record, outcome.amount, outcome.hash);
      save(updated);
      this.endSweepBackoff(record.channelId, backoff);
      return { kind: "swept", record: updated, amount: outcome.amount, hash: outcome.hash };
    } catch (err) {
      // Final fix wave (M3): merged with any hashes still remembered from before (an attempt that went ahead after
      // SWEEP_PENDING_PROBES replaces the old transaction at its nonce; either one may be the one that lands).
      const remember = (hashes: Hex[]) => {
        backoff.pendingTx = [...new Set([...(backoff.pendingTx ?? []), ...hashes])];
      };
      if (err instanceof TxReceiptMissingError || err instanceof TxDroppedError) {
        // Minor 2: remember this hash so the very next attempt (see the top of this method) checks it before
        // trying anything else -- the transaction is most likely already mined; only the receipt went missing.
        // H1 (audit-daemon M-12): a reported drop too. A load-balanced RPC can report a transaction dropped that
        // another of its nodes mines later; the next attempt's check records that as the sweep, not as "dust".
        remember([err.hash]);
      } else if (err instanceof SweepWaitError) {
        remember(err.hashes); // H3: sent, then its receipt wait failed -- it may have landed
      } else if (err instanceof TxStuckError || err instanceof TxWaitAbortedError) {
        // Fix round 3, I-1(c): probe E3 -- a sweep this wait gave up on (a tight giveUpAt, or stop()) can still
        // land later: any one of the original send or its fee-bumped replacements might mine after this daemon
        // stopped watching for it. Remembering all of them (not just the last) is what lets the next attempt
        // recognise whichever one actually wins, instead of reading a fresh, near-zero balance and recording a
        // spurious "dust" over what really was a successful, if late, sweep.
        remember(err.hashes);
      }
      // Final fix wave (M5): persisted before the stopped check -- a wait stop() aborted is exactly the case whose
      // transaction can land after this daemon is gone.
      persistPending();
      if (this.stopped) return { kind: "skipped", record };
      if (err instanceof TxNonceUsedError) {
        // Rule 4: a foreign transaction landed at that nonce first -- not a failure of ours, just stale info; the
        // next pass re-reads the chain and, if still unswept, tries again fresh. No back-off, no attempt charged.
        this.log(`channel ${record.channelId}: sweep: a foreign transaction landed at that nonce; re-evaluated on the next pass`);
        return { kind: "skipped", record };
      }
      if (err instanceof TxDroppedError) {
        // H1 (M-12): not charged here -- the next attempt checks the hash first, and charges the attempt if the
        // transaction is really gone (a "failed" recovery), or records the sweep if it landed after all.
        this.log(`channel ${record.channelId}: sweep transaction ${err.hash} was reported dropped; checked first on the next attempt`);
        this.bumpSweepBackoff(record.channelId, backoff);
        return { kind: "error", record, error: err };
      }
      if (err instanceof SweepWaitError) {
        // H3 (rehearsal §8.4): not charged, like a reported drop -- the next attempt checks the hashes first, and
        // charges the attempt if they are really gone, or records the sweep if one landed.
        this.log(`channel ${record.channelId}: ${errorText(err)}; its transaction(s) are checked first on the next attempt`);
        this.bumpSweepBackoff(record.channelId, backoff);
        return { kind: "error", record, error: err };
      }
      if (err instanceof SweepReadError) {
        // Final fix wave (M4): an RPC blip before anything was sent -- backed off, never charged, so an RPC outage
        // does not abandon every channel that settles during it.
        this.log(`channel ${record.channelId}: sweep: ${errorText(err)} (retried with back-off, not counted toward abandoning)`);
        this.bumpSweepBackoff(record.channelId, backoff);
        return { kind: "error", record, error: err };
      }
      this.log(`channel ${record.channelId}: sweep failed (retried with back-off): ${errorText(err)}`);
      backoff.attempts++;
      if (backoff.attempts >= SWEEP_ABANDON_ATTEMPTS) {
        // Minor 4: a recheck's own repeated failures (e.g. a stuck entry that turned up only after the channel
        // was already fully swept) must never downgrade an already-done record to "abandoned" -- same principle
        // as the dust case above.
        if (rechecking) return { kind: "error", record, error: err };
        const updated: ChannelRecord = { ...record, swept: "abandoned" };
        save(updated);
        this.log(`channel ${record.channelId}: sweep abandoned after ${backoff.attempts} failed attempts: its session gas is written off`);
        return { kind: "abandoned", record: updated };
      }
      this.bumpSweepBackoff(record.channelId, backoff);
      return { kind: "error", record, error: err };
    }
  }

  /** Starts (30 s) or doubles (up to 5 min) a sweep back-off; logs once, on the episode's first bump. */
  private bumpSweepBackoff(channelId: Hex, backoff: SweepBackoff): void {
    const starting = backoff.backoffMs === 0;
    backoff.backoffMs = starting ? BACKOFF_START_MS : Math.min(backoff.backoffMs * 2, BACKOFF_MAX_MS);
    backoff.blockedUntil = Date.now() + backoff.backoffMs;
    if (starting) this.log(`channel ${channelId}: sweep back-off started (retrying in ${backoff.backoffMs / 1000}s)`);
  }

  private endSweepBackoff(channelId: Hex, backoff: SweepBackoff): void {
    const wasBackedOff = backoff.backoffMs !== 0;
    backoff.backoffMs = 0;
    backoff.blockedUntil = 0;
    backoff.attempts = 0;
    backoff.pendingTx = undefined;
    backoff.pendingProbes = 0;
    backoff.receiptlessProbes = 0;
    if (wasBackedOff) this.log(`channel ${channelId}: sweep back-off ended`);
  }

  /** Fix round 2, minor 2: looks up a transaction this daemon lost track of (its receipt went missing after
   *  `waitOrReplace` treated it as mined). Returns `"pending"` if the receipt still cannot be read but the node
   *  still knows the transaction at all (try again next attempt), `"failed"` if a receipt was read but it did not
   *  succeed, *or* if no receipt exists and the node no longer knows the transaction either (fix round 3, I-2:
   *  genuinely gone -- charge the attempt and fall through to a fresh one, rather than skip forever), or the
   *  amount and hash to record as swept if it did succeed.
   *
   *  Fix round 3, C-1: the whole body is inside its own try/catch (in addition to `runSweepAttempt`'s own, which
   *  now also wraps this call -- see its own note) -- probe F1 found `getTransaction` throwing on a plain RPC
   *  blip (after a successful receipt read) escaping uncaught, all the way out of `runSweepAttempt`, which a
   *  timer-driven `void this.mainPass()` has no catch above; Node exits the whole process on that unhandled
   *  rejection. Any failure not otherwise classified below is treated as "unknown" -- try again next attempt --
   *  never charged as a failed attempt for what may just be a slow node.
   *
   *  Final fix wave (M3): `"pending"` now means the node reports the transaction unmined (in its mempool); a
   *  read failure, or a transaction the node reports mined but whose receipt could not be read, is `"unknown"`,
   *  so only a genuinely pending transaction counts toward `SWEEP_PENDING_PROBES`. */
  /** Fix round 3, I-1(c): `hashes` is the original send plus every fee-bumped replacement `waitOrReplace` sent
   *  for the one intent this backoff gave up on -- at most one of them can ever mine (they share a nonce), but
   *  it is never necessarily the last one this daemon happened to be watching when it gave up, so every one of
   *  them is checked. */
  /** H1 (audit-daemon M-4): `"receiptless"` (it was `"unknown"`) when a hash is reported mined but no receipt can be
   *  read for it; `"unknown"` is left to read failures. */
  private async recoverPendingSweepTx(
    hashes: Hex[],
  ): Promise<"pending" | "unknown" | "receiptless" | "failed" | { amount: bigint; hash: Hex }> {
    try {
      let anyPending = false;
      let anyMined = false;
      for (const hash of hashes) {
        let receipt: { status: "success" | "reverted" } | null;
        try {
          receipt = await this.client.getTransactionReceipt({ hash });
        } catch {
          receipt = null;
        }
        if (receipt) {
          if (receipt.status === "success") {
            const tx = await this.client.getTransaction({ hash });
            return { amount: tx.value, hash };
          }
          continue; // this one reverted (or never existed) -- another hash in the list may still have landed
        }
        // Fix round 3, I-2: probe F2 -- a receipt that will never exist (the transaction was replaced, or the
        // node's mempool simply forgot it) previously meant "pending" forever: every attempt from here on
        // skipped, the channel's session gas never swept, with no way out short of a restart. `getTransaction`
        // tells still-in-flight (worth trying again) apart from truly gone (nothing left to wait for).
        const known = await this.client.getTransaction({ hash }).catch((err: unknown) => {
          if (err instanceof TransactionNotFoundError) return null;
          throw err;
        });
        if (known) {
          if (known.blockNumber === null) anyPending = true;
          else anyMined = true; // mined, but its receipt could not be read just now
        }
      }
      if (anyMined) return "receiptless";
      return anyPending ? "pending" : "failed";
    } catch (err) {
      this.log(`sweep recovery: ${errorText(err)} looking up ${hashes.length} pending hash(es) (retried next attempt)`);
      return "unknown";
    }
  }

  /** Fix round 2 (important 3 + minors 1/6): merges only `swept`/`sweptAmount`/`sweptTx`/`sweeps` (fix round 3,
   *  M-4) from `updated` onto a fresh copy of `current`, so a concurrent change to anything else on the record (a
   *  `handoff()`, most notably) while the sweep's own async work was in flight is never clobbered by the sweep's
   *  -- possibly stale -- copy of the rest of it. */
  private applySweptFields(current: ChannelRecord, updated: ChannelRecord): ChannelRecord {
    return {
      ...current,
      swept: updated.swept,
      sweptAmount: updated.sweptAmount,
      sweptTx: updated.sweptTx,
      sweeps: updated.sweeps,
      sweepPending: updated.sweepPending, // final fix wave (M5)
    };
  }

  /** Fix round 2, minor 1: refreshes the settled-index cache entry for `id` (if any) with `record`'s current
   *  swept fields -- called at every site that dequeues a swept record from `this.sweepQueue`, so `status()`/
   *  `channels()` never keep serving the pre-sweep status `start()` cached for it. */
  private refreshSettledCache(id: Hex, record: ChannelRecord): void {
    const cached = this.settled.get(id);
    if (!cached) return;
    cached.status = {
      ...cached.status,
      swept: record.swept ?? null,
      sweptAmount: record.sweptAmount?.toString() ?? null,
      sweptTx: record.sweptTx ?? null,
      sweeps: (record.sweeps ?? []).map((s) => ({ amount: s.amount.toString(), tx: s.tx, at: s.at })),
    };
  }

  /** The main pass's own sweep of one live, finalized, not-yet-swept channel -- never sets `lastError` (the
   *  channel is already settled; nothing would ever clear it again -- see `markFinalized`'s own note on the same
   *  point). Rule 1: skipped (no attempt, no back-off charged) while a refill or the dispute pass is still
   *  working this channel's session key. */
  protected async sweepChannel(l: ChannelHandle): Promise<void> {
    if (this.stopped || l.record.swept !== undefined) return;
    if (l.refilling || l.disputeBusy) return;
    // Nit: `l.record` is updated inside the save callback itself, not only after runSweepAttempt returns (as
    // sweepQueuePass's own entry.record already did) -- so a concurrent reader sees the disk and the in-memory
    // handle update together, not disk first and l.record only once this whole call unwinds.
    // Final fix wave (I2): the receipt wait is bounded like a manual sweep's, so a stuck sweep holds the main
    // pass for at most SWEEP_PER_RECORD_TIMEOUT_MS, not waitOrReplace's own ~2 minutes.
    const result = await this.runSweepAttempt(
      l.record,
      l.sessionSender,
      l.sweep,
      (r) => {
        l.record = this.applySweptFields(l.record, r);
        this.records.saveChannel(l.record);
      },
      { giveUpAt: Date.now() + SWEEP_PER_RECORD_TIMEOUT_MS },
    );
    l.record = this.applySweptFields(l.record, result.record);
  }

  /** Plan 5 fix round (I2): the sweep queue -- finalized-but-unswept records found at start() (a restart, or a
   *  record written before this feature existed), never opened into `live`. Removed once swept. A separate,
   *  protected method (like `sweepChannel`) so a test can stub it out, e.g. to keep a manual `sweep()` call from
   *  racing the periodic main pass's own processing of the very record it is about to sweep. */
  protected async sweepQueuePass(): Promise<void> {
    // Final fix wave (I2): at most SWEEP_QUEUE_PER_PASS records per pass, each bounded to
    // SWEEP_PER_RECORD_TIMEOUT_MS. An attempted record moves to the back of the queue (Map order is insertion
    // order), so the next pass starts with the records this one did not reach.
    let attempted = 0;
    for (const [qid, entry] of [...this.sweepQueue]) {
      if (this.stopped || attempted >= SWEEP_QUEUE_PER_PASS) break;
      // Skipped if a manual sweep is on it, or already took it off the queue since the snapshot above.
      if (entry.busy || this.sweepQueue.get(qid) !== entry) continue;
      attempted++;
      this.sweepQueue.delete(qid);
      this.sweepQueue.set(qid, entry);
      entry.busy = true;
      try {
        const result = await this.runSweepAttempt(
          entry.record,
          entry.sender,
          entry.sweep,
          (r) => {
            entry.record = this.applySweptFields(entry.record, r);
            this.records.saveChannel(entry.record);
          },
          { giveUpAt: Date.now() + SWEEP_PER_RECORD_TIMEOUT_MS },
        );
        entry.record = this.applySweptFields(entry.record, result.record);
        if (entry.record.swept !== undefined) {
          this.sweepQueue.delete(qid);
          // The settled index cached a status for this record at start() (before it was swept); refresh it in
          // place so `status`/`channels()` show the outcome without waiting for a restart.
          this.refreshSettledCache(qid, entry.record);
        }
      } finally {
        entry.busy = false;
      }
    }
  }

  /**
   * `arena sweep` / `POST /sweep`: sweeps every settled channel whose record has `swept` unset or `"abandoned"`
   * (`true`/`"dust"` are done already) -- live ones (their existing session sender/back-off), queued ones (the
   * sweep queue's own sender/back-off), and legacy ones tracked in neither (a fresh, one-shot sender built from
   * the record's `sessionKey`). `ref`, if given, narrows to a single channel id starting with it, exactly as
   * `pick` does: none matching is 404, more than one is 400 (ambiguous); a channel already swept reports
   * `"already"` rather than an error. **I5**: single-flight -- a concurrent call is refused with 409 -- and
   * spends at most `SWEEP_TIME_BUDGET_MS` attempting records (with no `--channel`), reporting `remaining` for
   * whatever is left rather than hanging the caller. Never throws for one channel's own failure.
   */
  async sweep(
    ref?: string,
    // `budgetMs` is test-only (never set by the CLI/API): lets a test exercise the `remaining` mechanism without
    // waiting out the real SWEEP_TIME_BUDGET_MS.
    opts: { budgetMs?: number } = {},
  ): Promise<{ results: Array<{ channelId: Hex; swept: string; hash?: Hex }>; remaining: number }> {
    if (this.sweeping) throw new DaemonError(409, "a sweep is already in progress: retry shortly");
    this.sweeping = true;
    try {
      // Minor 3: this budget bounds every record's own wait too (via `giveUpAt`, threaded through
      // `sweepOneNow`/`runSweepAttempt`/`performSweep` down to `waitOrReplace`), not only how many records the
      // `--channel`-less bulk loop below gets through. Fix round 3, M-2: `giveUpAt` for any one record is
      // `min(deadline, its own start + SWEEP_PER_RECORD_TIMEOUT_MS)`, computed fresh per record below -- not
      // `deadline` itself, which one record stuck replacing a dead entry could otherwise still claim in full
      // (correcting an earlier version of this comment, which overclaimed exactly that: with a single shared
      // `giveUpAt`, one such record *could* eat the whole remaining budget, starving every record after it in
      // the same bulk sweep -- this bounds each one's own share instead).
      const deadline = Date.now() + (opts.budgetMs ?? SWEEP_TIME_BUDGET_MS);
      const perRecordDeadline = () => Math.min(deadline, Date.now() + SWEEP_PER_RECORD_TIMEOUT_MS);
      const want = ref?.toLowerCase();
      const allFinalized = this.records.channels().filter((r) => r.finalized);
      if (want) {
        const matches = allFinalized.filter((r) => r.channelId.toLowerCase().startsWith(want));
        if (matches.length === 0) throw new DaemonError(404, `no settled channel matches ${ref}`);
        if (matches.length > 1) throw new DaemonError(400, `ambiguous channel ${ref}`);
        const record = matches[0];
        if (isSweptDone(record.swept)) {
          // Minor 4: the wallet-side session key can receive money again after a sweep already reported "true"
          // or "dust" -- a refill that was in flight and landed late, a manual top-up, a slightly-off dust read.
          // `--channel` re-checks the key's current balance before answering "already"; anything above dust
          // falls through to a real attempt, which does the precise dust math itself (and may still, correctly,
          // decline it and record "dust" again).
          const balance = await this.client.getBalance({ address: this.senderFor(record.channelId, record).address });
          if (balance === 0n) return { results: [{ channelId: record.channelId, swept: "already" }], remaining: 0 };
          return { results: [await this.sweepOneNow(record, perRecordDeadline(), true)], remaining: 0 };
        }
        return { results: [await this.sweepOneNow(record, perRecordDeadline())], remaining: 0 };
      }
      const targets = allFinalized.filter((r) => r.swept !== true && r.swept !== "dust");
      const results: Array<{ channelId: Hex; swept: string; hash?: Hex }> = [];
      let processed = 0;
      for (const record of targets) {
        if (Date.now() >= deadline) break;
        processed++;
        results.push(await this.sweepOneNow(record, perRecordDeadline()));
      }
      return { results, remaining: targets.length - processed };
    } finally {
      this.sweeping = false;
    }
  }

  /**
   * One record's sweep, right now (`force`, bypassing the back-off's own timing) -- guarded by the same
   * busy-wait pattern `reclaim()` uses against the main pass (**I1**): a live channel's `mainBusy` (and, fix
   * round 2 important 2, `refilling`/`disputeBusy` -- the same rule-1 guards `sweepChannel` applies, which this
   * method must honour too since it calls `runSweepAttempt` directly), or a queued record's own `busy` flag, so
   * a manual sweep and the periodic pass never send on the same key at once.
   *
   * Fix round 2, important 3: `record` (the caller's snapshot -- `sweep()`'s bulk loop reads every record once
   * at the top) can go stale if the main pass's own queue/watch sweeps this same record before reaching it here,
   * including *during* the busy-wait below. For a live or queued record, `l.record`/`queued.record` -- the
   * shared, mutable copy the main pass itself updates in place -- is checked instead of `record`, both before
   * and after the wait; an orphan record (tracked in neither) is re-read from disk, since nothing else could be
   * racing it (another `sweep()` call cannot: this method is only ever reached while `sweep()` holds its own
   * single-flight lock).
   */
  /** Fix round 2, minor 4: the sender already associated with a channel id, if it is live or queued, otherwise a
   *  fresh one-shot sender built from the record's own session key -- never registered anywhere; used only to
   *  read a balance before deciding whether a re-check attempt is worth running at all. */
  private senderFor(id: Hex, record: ChannelRecord): SerialTxSender {
    return (
      this.live.get(id)?.sessionSender ??
      this.sweepQueue.get(id)?.sender ??
      this.sessionSenderFor(record.sessionKey)
    );
  }

  private async sweepOneNow(
    record: ChannelRecord,
    giveUpAt?: number,
    // Minor 4: `sweep()`'s `--channel` branch sets this once it has found a non-dust balance still sitting on an
    // already-`isSweptDone` channel's key -- bypasses every "already" short-circuit below (and, correspondingly,
    // `runSweepAttempt`'s own skip guard) for exactly this one call, so a real attempt actually runs; if there
    // turns out to be nothing worth sending after all, `performSweep`'s own precise dust math still declines it.
    recheck = false,
  ): Promise<{ channelId: Hex; swept: string; hash?: Hex }> {
    const id = record.channelId;
    const l = this.live.get(id);
    if (l) {
      if (isSweptDone(l.record.swept) && !recheck) return { channelId: id, swept: "already" };
      const wasAbandoned = l.record.swept === "abandoned";
      const busy = () => l.mainBusy || l.refilling || l.disputeBusy;
      const until = Date.now() + RECLAIM_BUSY_WAIT_MS;
      while (busy() && Date.now() < until && !this.stopped) await new Promise((r) => setTimeout(r, 20));
      if (busy()) return { channelId: id, swept: "error: the watchtower is working on this channel: retry shortly" };
      if (isSweptDone(l.record.swept) && !recheck) return { channelId: id, swept: "already" }; // settled while we waited
      l.mainBusy = true;
      try {
        // Nit: `l.record` is updated inside the save callback itself (matching sweepChannel and the queued
        // branch below), not only after runSweepAttempt returns.
        const result = await this.runSweepAttempt(
          l.record,
          l.sessionSender,
          l.sweep,
          (r) => {
            l.record = this.applySweptFields(l.record, r);
            this.records.saveChannel(l.record);
          },
          { force: true, giveUpAt, recheck },
        );
        l.record = this.applySweptFields(l.record, result.record);
        return this.sweepResultWithHash(id, result, wasAbandoned, recheck);
      } finally {
        l.mainBusy = false;
      }
    }
    const queued = this.sweepQueue.get(id);
    if (queued) {
      if (isSweptDone(queued.record.swept) && !recheck) return { channelId: id, swept: "already" };
      const wasAbandoned = queued.record.swept === "abandoned";
      const until = Date.now() + RECLAIM_BUSY_WAIT_MS;
      while (queued.busy && Date.now() < until && !this.stopped) await new Promise((r) => setTimeout(r, 20));
      if (queued.busy) return { channelId: id, swept: "error: a sweep pass is already working on this channel: retry shortly" };
      if (isSweptDone(queued.record.swept) && !recheck) return { channelId: id, swept: "already" }; // settled while we waited
      queued.busy = true;
      try {
        const result = await this.runSweepAttempt(
          queued.record,
          queued.sender,
          queued.sweep,
          (r) => {
            queued.record = this.applySweptFields(queued.record, r);
            this.records.saveChannel(queued.record);
          },
          { force: true, giveUpAt, recheck },
        );
        queued.record = this.applySweptFields(queued.record, result.record);
        if (queued.record.swept !== undefined) {
          this.sweepQueue.delete(id);
          this.refreshSettledCache(id, queued.record);
        }
        return this.sweepResultWithHash(id, result, wasAbandoned, recheck);
      } finally {
        queued.busy = false;
      }
    }
    // Not tracked anywhere in memory (a record from another process, or predating this daemon's own start()): a
    // fresh disk read, and a fresh, one-shot sender and back-off.
    const fresh = this.records.channel(id) ?? record;
    if (isSweptDone(fresh.swept) && !recheck) return { channelId: id, swept: "already" };
    const wasAbandoned = fresh.swept === "abandoned";
    const sender = this.sessionSenderFor(fresh.sessionKey);
    const backoff: SweepBackoff = { blockedUntil: 0, backoffMs: 0, attempts: 0, pendingTx: fresh.sweepPending };
    const result = await this.runSweepAttempt(fresh, sender, backoff, (r) => this.records.saveChannel(r), { force: true, giveUpAt, recheck });
    // Fix round 3, M-1: this record may already be in the settled-index cache (evicted from `live` some time
    // ago, or loaded straight into it at start() -- either way, never through `live`/`sweepQueue`, so neither of
    // those two paths' own `refreshSettledCache` calls above ever reach it). Without this, `status()`/`channels()`
    // for an evicted channel kept serving the pre-sweep (or pre-retry) cached status forever, even once the sweep
    // above genuinely landed -- e.g. an "abandoned" channel `arena sweep` retries successfully (important 1) still
    // read back as "abandoned" from the cache.
    if (result.record.swept !== undefined) this.refreshSettledCache(id, result.record);
    return this.sweepResultWithHash(id, result, wasAbandoned, recheck);
  }

  private sweepResultWithHash(
    id: Hex,
    result: SweepAttemptResult,
    wasAbandoned = false,
    recheck = false,
  ): { channelId: Hex; swept: string; hash?: Hex } {
    const base = this.sweepResultToString(id, result, wasAbandoned, recheck);
    return result.kind === "swept" ? { ...base, hash: result.hash } : base;
  }

  private sweepResultToString(id: Hex, result: SweepAttemptResult, wasAbandoned = false, recheck = false): { channelId: Hex; swept: string } {
    // Minor 4: a recheck finding only dust (the common case -- the prior sweep's own untouched reserve, not a
    // real top-up) reports the same "already" a caller would have seen without minor 4 at all: nothing new
    // happened, and `runSweepAttempt` deliberately left the record untouched (see the `rechecking` branch there).
    if (recheck && result.kind === "dust") return { channelId: id, swept: "already" };
    // Fix round 2, important 1: a manual retry of a previously-"abandoned" channel gets its own distinct result
    // string, so `arena sweep`'s output tells that case apart from an ordinary first-time sweep.
    const prefix = wasAbandoned ? "retried: " : "";
    switch (result.kind) {
      case "swept":
        return { channelId: id, swept: `${prefix}0x${result.amount.toString(16)}` };
      case "dust":
        return { channelId: id, swept: `${prefix}dust` };
      case "abandoned":
        return { channelId: id, swept: "abandoned" };
      case "error":
        return { channelId: id, swept: `${prefix}error: ${errorText(result.error)}` };
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
    let accepted = false;
    let keepError = false;
    try {
      if (msg.type === "state") {
        // A re-send after a reconnect (§7) can land as "duplicate" (we already hold it) or "stale" (we've moved
        // past it): both are success, not an error, and neither needs an autoPlay pass.
        const result = await l.session.receive(msg.signed);
        accepted = true;
        if (this.stopped) return;
        if (result !== "duplicate" && result !== "stale") await this.autoPlay(l);
        // Plan 5.7 (spec §3): a repeat from an undetermined XMTP sender, a stranger's replay as likely as not.
        else keepError = this.opts.relayUndetermined?.(msg) === true;
      } else {
        await l.session.receiveClose(msg.close);
        accepted = true;
        closeReceived = true;
      }
      if (!keepError) l.lastError = null;
    } catch (err) {
      // Plan 5.7 (spec §3): the relay counts a rejected message whose sender it could not determine; nothing changed.
      // Only a protocol rejection: any other failure (a failed store.save, say) is reported as before.
      if (!accepted && err instanceof ArenaProtocolError && this.opts.relayRejected?.(msg) === true) return;
      l.lastError = errorText(err);
      this.log(`channel ${msg.channelId}: ${l.lastError}`);
    }
    if (this.stopped) return;
    // H1 (audit-daemon M-11): the opponent's Close signature completed the close here. The opponent signed second,
    // so their own `close()` is submitting it right now; submitting it here as well raced theirs, and the loser's
    // transaction reverted on-chain (about 37k gas, paid for nothing). So this side leaves it to its watchtower after
    // a short, jittered delay (two sides that both completed it here are spread apart), and the watchtower's
    // `submitClose` reads the phase first: a close that went through meanwhile is never sent again. If theirs never
    // lands, this one does. The close API and every later retry are unchanged.
    if (closeReceived && l.session.closeTransaction()) {
      const defer = CLOSE_RELAY_DEFER_MS + Math.floor(Math.random() * CLOSE_RELAY_JITTER_MS);
      l.closeRetryAt = Math.max(l.closeRetryAt, Date.now() + defer);
    }
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
        // H3 fix round 2 (re-review M-g): nor is it sent past then -- after its pre-send reads -- since it would revert.
        notAfter: giveUpAt + RESPOND_SEND_MARGIN_MS,
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
    // Final review I2: a session signs Close only for its own latest signed state and then stops signing new
    // states (sdk/session.ts's signClose/receive) -- so a NEW_GAME proposed after the opponent's Close has
    // already arrived would wedge the channel: `proposeNewGame` itself only checks this player's own
    // `closeState` and would still succeed locally, but the opponent's `receive()` rejects the proposal
    // (CLOSING_MESSAGE) and this side's own later `signClose` then refuses too ("a new-game proposal is
    // pending"). Same check as status.ts's `opponentWantsToClose`, so this refusal and that attention agree.
    const opponent = l.record.me === 0 ? 1 : 0;
    if (l.session.snapshot().closeSigs[opponent] !== "0x") {
      throw new DaemonError(409, "the opponent has requested a close: run close, not next-game -- then find a new opponent for the remaining games");
    }
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
    // H3 fix round 1 (review M4): the Close is signed and relayed -- the action took effect. A submission that fails
    // on anything but the hub's own refusal (a rate-limited read, a lost receipt) is the watchtower's to retry, on
    // every pass, and is shown as the channel's `close:` lastError (trySubmitClose): not answered as a failure.
    await this.guard(() => this.trySubmitClose(l)).catch((err: unknown) => {
      if (err instanceof DaemonError) throw err;
    });
    this.notify();
  }

  async challenge(ref: string | undefined, actor: Actor): Promise<ActionOutcome> {
    const l = this.pick(ref);
    this.requireController(l, actor);
    const outcome = await this.guard(() => this.hub.challenge(l.sessionSender, l.session.challengeProof())).then(
      () => ({}),
      (err: unknown) => minedUnconfirmed("challenge", err),
    );
    this.notify();
    return outcome;
  }

  async reclaim(ref: string | undefined): Promise<ActionOutcome> {
    const l = this.pick(ref);
    // Plan 4.5 Task 10 round 4: never beside the main pass (which reclaims after the funding deadline itself). A main
    // pass visits every channel briefly, so the API waits for it a little before refusing.
    const until = Date.now() + RECLAIM_BUSY_WAIT_MS;
    while (l.mainBusy && Date.now() < until && !this.stopped) await new Promise((r) => setTimeout(r, 20));
    if (l.mainBusy) throw new DaemonError(409, "the watchtower is working on this channel: retry shortly");
    l.mainBusy = true;
    let outcome: ActionOutcome;
    try {
      // R9/I1: dispute operations go through the session key (spec §3.1), so they keep working after the
      // Circle session backing the wallet key has expired.
      outcome = await this.guard(() => this.hub.reclaim(l.sessionSender, l.record.channelId)).then(
        () => ({}),
        (err: unknown) => minedUnconfirmed("reclaim", err),
      );
    } finally {
      l.mainBusy = false;
    }
    this.notify();
    return outcome;
  }

  async handoff(ref: string | undefined, to: Controller, note: string): Promise<void> {
    // Plan 5 Task 2 fix round, minor 4: checked before touching the channel or the record, like every other
    // input validation in this class.
    checkHandoffNote(note);
    this.setController(this.pick(ref), to, note);
  }

  /** Sets a channel's controller and note, persists them, and tells every waiter. Plan 5 Task 2: handoffAt drives
   *  ChannelStatus.handoff.since -- set every time, even human -> human or agent -> agent, so the board can show
   *  "handed off just now" regardless of whether the controller actually changed. */
  private setController(l: ChannelHandle, to: Controller, note: string): void {
    l.record = { ...l.record, controller: to, note, handoffAt: Date.now() };
    this.records.saveChannel(l.record);
    // Final fix wave (I1): a human taking the seat (again) under a challenge earns the agent a fresh wake.
    if (to === "human") l.humanMustMoveWoken = null;
    this.notify();
  }

  /**
   * Final fix wave (I1): hands a human-held seat back to the agent when a challenge needs this seat's move and at
   * most `autoReturnSecondsOf(challengeTimeout)` of chain time is left before its deadline (and
   * `autoReturnOnChallenge` is on) -- so a forfeit never depends on a human who closed the board or walked away
   * (spec §3.1). Leaves `AUTO_RETURN_NOTE`; the agent's `wait` then sees `control-changed` or `your-turn`. Called by
   * the dispute pass, on move in the registered state, after autoPlay (which may already have resigned or claimed).
   */
  private autoReturnIfDeadlineNear(l: ChannelHandle, deadline: bigint, now: bigint): void {
    if (l.record.controller !== "human" || l.record.finalized || !autoReturnOnChallengeOf(this.opts.config)) return;
    const latest = l.session.latest.state;
    if (isGameOver(latest) || mover(latest) !== l.record.me) return; // resigned, claimed, or the human just moved
    const left = deadline > now ? deadline - now : 0n;
    if (left > BigInt(autoReturnSecondsOf(l.record.params.challengeTimeout))) return;
    this.setController(l, "agent", AUTO_RETURN_NOTE);
    this.log(`channel ${l.record.channelId}: a challenge needs this seat's move with ${left}s left: handed the seat back to the agent`);
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
        // Fix round 3, C-1, defense in depth: onMatch already catches its own errors internally, but this is
        // awaited directly inside mainPass()'s own try (no catch of its own) -- one more layer, in case that
        // ever changes, so a single bad retried match can never take the whole pass down with it.
        await this.onMatch(m).catch((err: unknown) => this.log(`retryMatches: onMatch failed for offer ${m.offerId}: ${errorText(err)}`));
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
    const chain: ChainView | null = record.finalPhase ? finalChainView(record.finalPhase) : null;
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
    // A settled channel's chain view is never refreshed again (status/channels skip it, I1), so it must carry the
    // final phase from this moment on: settleCheck's own refresh lands one RPC later (or fails), and the reclaim and
    // timeout paths never refresh at all -- without this, `status` kept reporting "Open"/"Challenged" for good.
    l.chain = l.chain ? { ...l.chain, phase } : finalChainView(phase);
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
    // H1 fix round 1 (review I-1): a registered state newer than anything this session holds, whose event the scan
    // could not read. Adopted from storage when it can be (then the branches below see it), else surfaced.
    await this.handleUnseenRegistered(l, info, registered);
    if (this.stopped) return true;
    const latest = l.session.latest.state;
    if (now < info.deadline && latest.turnNum > registered.turnNum) {
      // Stale challenge, and there is still time to answer it: we hold a newer supported state.
      await this.respondIfChallenged(l);
    } else if (latest.turnNum === registered.turnNum && !isGameOver(latest) && mover(latest) === me) {
      // We are on move in the registered state: auto-resign if checkmated, auto-claim if stalemated,
      // otherwise leave it for the controller (status shows mustMove) -- or, final fix wave (I1), return a
      // human-held seat to the agent once the deadline is near.
      await this.autoPlay(l, true);
      this.autoReturnIfDeadlineNear(l, info.deadline, now);
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
   * H1 fix round 1 (review I-1): the dispute pass found the channel Challenged on a registered state newer than this
   * session's latest. Normally that is the opponent's move by challenge whose event the scan ingests within a pass;
   * but if its event cannot be read (a griefer's oversized proof that the RPC refuses), this player cannot answer, and
   * the challenger's `timeout` forfeits the current game at the deadline -- silently, before this.
   *
   * After `UNSEEN_REGISTERED_PASSES` passes (at once if a block was skipped):
   * - (b) when the registered state is the very next turn, it is adopted from storage, unsigned
   *   (`ChannelSession.adoptRegistered`), checked against the hub's `registeredHash` on a fresh read. The player can
   *   then move, and the move answers the challenge: a lock at worst (a later challenge needs the opponent's
   *   signature, which a readable event repairs), never a forfeit.
   * - (c) otherwise, the `challenge-unseen` attention (status: switch RPC, and the deadline), once per challenge.
   * Never throws.
   */
  private async handleUnseenRegistered(
    l: ChannelHandle,
    info: Awaited<ReturnType<HubClient["channelInfo"]>>,
    registered: Awaited<ReturnType<HubClient["registeredState"]>>,
  ): Promise<void> {
    const latest = l.session.latest.state;
    if (registered.turnNum <= latest.turnNum) {
      if (l.unseenRegistered?.raised) this.notify();
      l.unseenRegistered = null;
      return;
    }
    const key = `${info.deadline}:${registered.turnNum}`;
    const u = l.unseenRegistered?.key === key ? l.unseenRegistered : { key, turn: registered.turnNum, deadline: info.deadline, passes: 0, raised: false };
    u.passes++;
    l.unseenRegistered = u;
    const skipped = (l.record.skippedEventBlocks?.length ?? 0) > 0;
    if (u.passes < UNSEEN_REGISTERED_PASSES && !skipped) return;
    const id = l.record.channelId;
    try {
      if (registered.turnNum === latest.turnNum + 1n) {
        const fresh = await this.hub.channelInfo(id);
        if (fresh.phase === "Challenged" && fresh.hasRegistered && (await l.session.adoptRegistered(registered, fresh.registeredHash))) {
          this.log(
            `channel ${id}: adopted the registered turn ${registered.turnNum} from the hub's storage: its event could not be ` +
              "read, and a move on it answers the challenge",
          );
          l.unseenRegistered = null;
          this.notify();
          return;
        }
      }
    } catch (err) {
      this.log(`channel ${id}: reading the registered state to adopt it failed (retried on the next pass): ${errorText(err)}`);
    }
    if (!u.raised) {
      u.raised = true;
      this.log(
        `channel ${id}: challenged on turn ${registered.turnNum}, newer than this daemon holds (turn ${latest.turnNum}), and ` +
          `its event could not be read: unanswered, the current game is forfeited at the deadline (${info.deadline})`,
      );
      this.notify();
    }
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
    // Only moves forward as ranges succeed (the trailing rescan reads blocks at or below it); a scan with nothing
    // new leaves it unchanged. Ranges are read in chain order, so every block up to it has been read and ingested.
    let cursor = scanned;
    const advance = (to: bigint) => {
      if (to > cursor) cursor = to;
    };
    let skipped: bigint | null = null;
    /** Set once a probe this pass showed the RPC up while it refused this channel's events in some range. */
    let contentRefused = false;
    try {
      const head = await this.hub.blockNumber();
      if (this.stopped) return;
      await this.retrySkippedEventBlock(l);
      // At most 50 chunks per tick, so a long-dormant channel catches up over a few ticks without starving the
      // others. A stack, so a split range's halves are read next, in order.
      // A block skipped earlier (`skipUnreadableBlock`) is left out of every range, not read and refused again.
      const pending = withoutBlocks(chunkRanges(start, head, size).slice(0, 50), l.record.skippedEventBlocks ?? []).reverse();
      for (let reads = 0; pending.length > 0 && reads < DISPUTE_SCAN_READS_PER_PASS; reads++) {
        if (this.stopped) break;
        const r = pending.pop()!;
        let events: Awaited<ReturnType<HubClient["disputeEvents"]>>;
        try {
          events = await this.hub.disputeEvents(id, r.fromBlock, r.toBlock);
        } catch (err) {
          // H3: only a refusal of the query itself (`isRangeRefusal`) may split the range or count toward a skip. A
          // rate limit, a timeout, a 5xx -- anything else -- ends this channel's scan for the pass, uncounted and
          // unprobed: the next pass reads the same range again. Before, a rate-limited read whose probe slipped
          // through was split, and a block rate-limited on three passes was skipped.
          if (!isRangeRefusal(err)) {
            this.saveCursor(l, cursor); // what was read before it stays read
            l.lastError = `events: ${errorText(err)}`;
            return;
          }
          // H1 (audit-contracts I1, "oversized events"): the hub re-emits a proof's unchecked signature bytes, so
          // a griefer can make a range's response larger than an RPC serves. If the RPC serves the same range for no
          // channel (so it is up, and this channel's events are what it refuses), the range is split, down to one
          // block: the ranges around a large event are still read, and the event itself is fetched alone. An RPC
          // that refuses the probe too is down (or caps the range itself): nothing more is read this pass.
          if (!contentRefused && !(await this.servesEmptyQuery(r.fromBlock, r.toBlock))) {
            this.saveCursor(l, cursor); // what was read before it stays read
            l.lastError = `events: ${errorText(err)}`;
            return;
          }
          contentRefused = true;
          if (r.fromBlock < r.toBlock) {
            const mid = r.fromBlock + (r.toBlock - r.fromBlock) / 2n;
            pending.push({ fromBlock: mid + 1n, toBlock: r.toBlock }, { fromBlock: r.fromBlock, toBlock: mid });
            continue;
          }
          if (!(await this.skipUnreadableBlock(l, r.fromBlock, err))) {
            this.saveCursor(l, cursor);
            return;
          }
          skipped = r.fromBlock;
          events = [];
        }
        // H1 fix round 1 (review m-3): "passes in a row" -- a block that reads is no longer counted toward a skip.
        const u = l.unreadableBlock;
        if (u !== null && skipped !== u.block && u.block >= r.fromBlock && u.block <= r.toBlock) l.unreadableBlock = null;
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
        advance(r.toBlock);
      }
      this.saveCursor(l, cursor);
      if (l.lastError?.startsWith("events:") || l.lastError?.startsWith("ingest:")) l.lastError = null;
      // H1 fix round 1 (review m-2): a skip is surfaced from `record.skippedEventBlocks` (status), not `lastError`.
      if (skipped !== null) this.notify();
    } catch (err) {
      l.lastError = `events: ${errorText(err)}`;
    }
  }

  /** H1: whether the RPC serves the dispute-event query on `[fromBlock, toBlock]` for a channel id that has no
   *  events (the zero hash) -- an empty response. Tells an RPC that is up but refuses one channel's (large) events
   *  apart from one that is down, or that caps the range itself. */
  private servesEmptyQuery(fromBlock: bigint, toBlock: bigint): Promise<boolean> {
    return this.hub.disputeEvents(ZERO_HASH, fromBlock, toBlock).then(
      () => true,
      () => false,
    );
  }

  /**
   * H1 (audit-contracts I1, "oversized events"): decides what the scan does with block `block`, whose dispute events
   * for this channel the RPC refused even on their own. A block it refuses while it serves the same query for no
   * channel -- the RPC is up, and this channel's events in that block are what it will not return (a griefer's
   * oversized proof) -- is retried for `UNREADABLE_BLOCK_PASSES` passes, then skipped: recorded in
   * `record.skippedEventBlocks`, logged, and retried later (`retrySkippedEventBlock`), so one block can never stop
   * every later event from being read. Spec §12 item 18's "never past an event that failed to ingest" still holds
   * for every event that was read. An RPC that also refuses the probe is down, not refusing the block: nothing is
   * skipped. Returns true when the block is skipped now.
   */
  private async skipUnreadableBlock(l: ChannelHandle, block: bigint, err: unknown): Promise<boolean> {
    if (!(await this.servesEmptyQuery(block, block))) {
      l.unreadableBlock = null;
      l.lastError = `events: ${errorText(err)}`;
      return false;
    }
    const tries = l.unreadableBlock?.block === block ? l.unreadableBlock.tries + 1 : 1;
    if (tries < UNREADABLE_BLOCK_PASSES) {
      l.unreadableBlock = { block, tries };
      l.lastError = `events: block ${block}: the RPC refuses this channel's dispute events in it (${errorText(err)}); retried on the next pass`;
      return false;
    }
    l.unreadableBlock = null;
    const already = l.record.skippedEventBlocks ?? [];
    if (!already.includes(block)) {
      l.record = { ...l.record, skippedEventBlocks: [...already, block] };
      this.records.saveChannel(l.record);
    }
    this.log(
      `channel ${l.record.channelId}: skipping block ${block}: the RPC refused its dispute events for this channel ` +
        `${tries} passes in a row (${errorText(err)}) while serving the same query for no channel; retried later`,
    );
    return true;
  }

  /** H1: re-reads a block the scan skipped (`skipUnreadableBlock`), at most one per pass and once per
   *  `BACKOFF_MAX_MS`. H1 fix round 1 (review m-1): the blocks are tried in turn, so a block that never reads (a
   *  griefer's) does not keep one refused only transiently from ever being re-read. Its events are ingested in order
   *  (an older state is not adopted, but a signature it carries for a state this session holds is: `ingestOnChain`);
   *  once it reads and ingests, it is no longer skipped. Never throws. */
  private async retrySkippedEventBlock(l: ChannelHandle): Promise<void> {
    const blocks = l.record.skippedEventBlocks ?? [];
    if (blocks.length === 0 || Date.now() < l.skippedRetryAt) return;
    const block = blocks[l.skippedRetryIndex % blocks.length];
    l.skippedRetryIndex++;
    l.skippedRetryAt = Date.now() + BACKOFF_MAX_MS;
    let events: Awaited<ReturnType<HubClient["disputeEvents"]>>;
    try {
      events = await this.hub.disputeEvents(l.record.channelId, block, block);
    } catch (err) {
      this.log(`channel ${l.record.channelId}: skipped block ${block} still cannot be read: ${errorText(err)}`);
      return;
    }
    try {
      for (const e of events) {
        await l.session.ingestOnChain(e.signed);
        l.processedEvents++;
      }
    } catch (err) {
      this.log(`channel ${l.record.channelId}: skipped block ${block} was read but an event in it failed to ingest: ${errorText(err)}`);
      return;
    }
    const rest = (l.record.skippedEventBlocks ?? []).filter((b) => b !== block);
    l.record = { ...l.record, skippedEventBlocks: rest.length > 0 ? rest : undefined };
    this.records.saveChannel(l.record);
    l.skippedRetryAt = 0;
    this.log(`channel ${l.record.channelId}: skipped block ${block} was read and ingested`);
    this.notify();
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

  /**
   * H3 (Arc testnet rehearsal §8.2): the status an action route (`POST /move`, `/close`, `/challenge`, ...) answers
   * with, once its action has taken effect. Its chain refresh can fail on its own -- a rate-limited RPC -- and that
   * must not turn a move that was signed and relayed into an error the agent may act on: the last known status is
   * returned instead, with `chainStale` and the reason. A `DaemonError` (no such channel) is thrown as by `status`.
   */
  async statusAfterAction(ref?: string, outcome: ActionOutcome = {}): Promise<ChannelStatus> {
    let st: ChannelStatus;
    try {
      st = await this.status(ref);
    } catch (err) {
      if (err instanceof DaemonError) throw err;
      let l: ChannelHandle;
      try {
        l = this.pick(ref);
      } catch {
        throw err;
      }
      // Fix round 1 (review M6): the RPC's own answer ("HTTP 429"), not viem's first line ("HTTP request failed.").
      const reason = isRateLimited(err) ? `the RPC is rate-limiting (${rpcErrorSummary(err)})` : rpcErrorSummary(err);
      st = { ...this.statusOf(l), chainStale: true, chainStaleReason: reason };
    }
    // Fix round 1 (review M4): a transaction mined with no readable receipt went through, but is unconfirmed.
    if (outcome.unconfirmed !== undefined) {
      st = { ...st, chainStale: true, chainStaleReason: [outcome.unconfirmed, st.chainStaleReason].filter(Boolean).join("; ") };
    }
    return st;
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
        // Final fix wave (M2): a settled channel waited on by name answers "settled" at once, whether or not its
        // one-shot wake is still pending -- the same answer it gets once evicted, rather than blocking for the
        // whole timeout until eviction. (Only here: an all-channels wait keeps the one-shot rule, or every
        // settled-but-not-evicted channel would wake it at once, forever.)
        const only = targets[0];
        if (only.record.finalized) {
          only.settledWake = false;
          return { channelId: only.record.channelId, reason: "settled" };
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
        let ignoreChallengeUnseen = false;
        if (st.attention === "challenge-unseen") {
          // H1 fix round 1 (review I-1): whoever holds the seat, one wake per challenge.
          const key = l.unseenRegistered?.key ?? "";
          if (l.challengeUnseenWoken !== key) {
            l.challengeUnseenWoken = key;
            return { channelId: id, reason: st.attention };
          }
          ignoreChallengeUnseen = true;
          st = this.statusOf(l, { ignoreChallengeUnseen });
        }
        let ignoreSessionGasLow = false;
        if (st.attention === "session-gas-low") {
          // Final review C1: one wake per low-gas episode. While the wallet stays empty, later waits see the
          // channel's other attention instead of returning at once on every call (status keeps showing it).
          if (!l.sessionGasLowWoken) {
            l.sessionGasLowWoken = true;
            return { channelId: id, reason: st.attention };
          }
          ignoreSessionGasLow = true;
          st = this.statusOf(l, { ignoreSessionGasLow, ignoreChallengeUnseen });
        }
        if (st.attention === "human-must-move") {
          // Final fix wave (I1): whoever holds the seat, one wake per challenge (keyed by its deadline).
          const deadline = st.challenge?.deadline ?? "";
          if (l.humanMustMoveWoken !== deadline) {
            l.humanMustMoveWoken = deadline;
            return { channelId: id, reason: st.attention };
          }
          st = this.statusOf(l, { ignoreSessionGasLow, ignoreHumanMustMove: true, ignoreChallengeUnseen });
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

  /** Plan 5.7 (K3): the channel's XMTP drop count (0 without the fallback), kept at its highest. */
  private xmtpDroppedOf(l: ChannelHandle): number {
    const now = this.opts.xmtpDroppedOf?.(l.record.channelId) ?? 0;
    l.xmtpDropped = Math.max(l.xmtpDropped ?? 0, now);
    return l.xmtpDropped;
  }

  private statusOf(
    l: ChannelHandle,
    opts: { ignoreSessionGasLow?: boolean; ignoreHumanMustMove?: boolean; ignoreChallengeUnseen?: boolean } = {},
  ): ChannelStatus {
    return buildStatus({
      record: l.record,
      snapshot: l.session.snapshot(),
      myTurn: l.session.isMyTurn(),
      chain: l.chain,
      lastError: l.lastError,
      lastProgressAt: l.lastProgressAt,
      lobbyError: this.lobbyError,
      sessionGasLow: opts.ignoreSessionGasLow ? null : l.sessionGasLow,
      sessionGasLowCause: l.sessionGasLowCause,
      unseenChallenge:
        l.unseenRegistered?.raised && !opts.ignoreChallengeUnseen
          ? { registeredTurn: l.unseenRegistered.turn, deadline: l.unseenRegistered.deadline }
          : null,
      // H2 (controller request): on a one-balance chain, the session-gas-low action names its amount in USDC.
      gasFunding: { chainId: this.opts.config.chainId, sessionGasWei: this.opts.config.sessionGasWei, feeCeilingWei: this.wallet.feeCeiling },
      settled: l.settledWake,
      autoReturnSeconds: autoReturnOnChallengeOf(this.opts.config) ? autoReturnSecondsOf(l.record.params.challengeTimeout) : null,
      ignoreHumanMustMove: opts.ignoreHumanMustMove,
      transport: l.record.finalized ? "none" : (this.opts.transportOf?.(l.record.channelId) ?? "relay"),
      xmtpDropped: this.xmtpDroppedOf(l),
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
    // Final fix wave (M1): a refresh started before the channel was finalized (a `status` that read "Challenged")
    // can land after `markFinalized` -- and nothing refreshes a finalized channel again, so its phase must stay the
    // final one rather than this read's older view.
    const finalPhase = l.record.finalized ? l.record.finalPhase : undefined;
    l.chain = {
      phase: finalPhase ?? info.phase,
      funded: info.funded,
      deadline: info.deadline,
      challenger: info.challenger,
      registeredTurn,
      cooldownUntil: info.cooldownUntil,
      now: blockNow,
    };
    // Plan 5.7 (spec §3, I-1): the XMTP fallback is armed only once the channel is Open on chain -- both deposits in --
    // never at match time, so an accept that costs nothing never starts an XMTP client here. Idempotent.
    if (!l.record.finalized && (info.phase === "Open" || info.phase === "Challenged")) this.opts.armFallback?.(id);
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
      throw new DaemonError(409, `the ${l.record.controller} is in control of this channel (use "${selfCommand()} handoff")`);
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

  /** Fix round 3, C-1, defense in depth: every timer-driven or fire-and-forget call in this class (the periodic
   *  timer's own dispute/main passes, the initial and post-match `tick()`s, the lobby/relay event subscriptions)
   *  goes through this instead of a bare `void this.foo()`. A single stray, uncaught rejection on one of these --
   *  probe F1 found one inside the sweep's own receipt-recovery path, since fixed at its source too -- reaches
   *  Node with no `.catch` anywhere above it; recent Node versions exit the process on an unhandled rejection.
   *  This is the backstop for every such call, present and future, not a substitute for fixing the source. */
  private fireAndForget(label: string, p: Promise<unknown>): void {
    p.catch((err: unknown) => this.log(`${label} failed (this daemon keeps running): ${errorText(err)}`));
  }

  private markDegraded(channelId: string, error: string): void {
    this.degraded.set(channelId, error);
    this.log(`channel ${channelId} is degraded and not watched: ${error}`);
  }

  /** Final fix wave B (m-4): the channels this daemon could not load and does not watch (`markDegraded`), for the
   *  authenticated `/health` -- so `daemon stop` names them, without a chain read. */
  degradedChannelIds(): string[] {
    return [...this.degraded.keys()];
  }

  protected log(line: string): void {
    (this.opts.log ?? (() => undefined))(line);
  }
}
