import type { Address } from "viem";
import { chunkRanges, isGameOver, mover } from "@arena/sdk";
import type { HubEvent, PlayerIndex, SignedState, State } from "@arena/sdk";
import type { ChainReader } from "./chain.js";
import type { ServerConfig } from "./config.js";
import type { Relay } from "./relay.js";
import type { ChannelRow, Repo } from "./repo.js";

export type PlayerStats = {
  address: Address;
  channels: number;
  open: number;
  finalized: number;
  reclaimed: number;
  games: number;
  challengesInitiated: number;
  challengesAnswered: number;
  timeoutsLost: number;
};

// A catch-up pass never chews through more than this many chunks, so a very stale cursor doesn't turn one poll
// into an unbounded amount of RPC work; the next poll (on the same interval) picks up where this one left off.
const MAX_CHUNKS_PER_POLL = 50;

/** Every poll re-reads this many blocks behind the cursor, as the daemons' dispute scan does: a lagging or
 *  load-balanced RPC can report a head its `getLogs` index has not caught up with yet. `apply` is idempotent
 *  (`lastEvent`), so re-reading is harmless. */
export const INDEXER_RESCAN_BLOCKS = 32n;

/** Games played in a channel whose latest state is `s`: every finished game before `gameIndex`, plus the current
 *  one once it has a move. */
export function gamesOf(s: State): number {
  return s.gameIndex + (s.turnNum > 0n ? 1 : 0);
}

function eventKey(e: HubEvent): { block: bigint; logIndex: number } {
  return { block: e.blockNumber, logIndex: e.logIndex };
}

/** Whether `e` is strictly newer than the last event folded into a row -- used to make `apply` idempotent when a
 *  partially-processed chunk (one whose events were applied but whose cursor commit didn't happen, or was
 *  re-scanned) is applied again. */
function isNewer(e: HubEvent, last: { block: bigint; logIndex: number } | undefined): boolean {
  if (!last) return true;
  if (e.blockNumber !== last.block) return e.blockNumber > last.block;
  return e.logIndex > last.logIndex;
}

/** Follows the hub's events into `Repo`'s `channels` table (phase, balances, dispute counters) and advances the
 *  repo's cursor. Untrusted plumbing, same as `Relay`: it never verifies game rules, only folds in what the chain
 *  says happened. */
export class Indexer {
  private timer: ReturnType<typeof setInterval> | undefined;
  private polling = false;

  constructor(
    private readonly repo: Repo,
    private readonly chain: ChainReader,
    private readonly cfg: ServerConfig,
    private readonly log: (l: string) => void,
    private readonly relay?: Pick<Relay, "latestState">,
  ) {}

  /** One catch-up pass: reads the chain head, then works through at most `MAX_CHUNKS_PER_POLL` chunks of
   *  `cfg.indexer.chunkBlocks` blocks each, starting `INDEXER_RESCAN_BLOCKS` behind the cursor, applying every
   *  event in a chunk before advancing the cursor past it.
   *  Never throws -- any failure (head, or a chunk's `hubEvents`) is logged and the cursor is left exactly where
   *  the last successfully-committed chunk left it, so the next poll retries from there. */
  async poll(): Promise<void> {
    try {
      this.repo.pruneRelayCache(Date.now());
      const head = await this.chain.head();
      const cursor = this.repo.cursor() ?? this.cfg.indexer.startBlock - 1n;
      const rescan = cursor + 1n - INDEXER_RESCAN_BLOCKS;
      const from = rescan > this.cfg.indexer.startBlock ? rescan : this.cfg.indexer.startBlock;
      const ranges = chunkRanges(from, head, BigInt(this.cfg.indexer.chunkBlocks)).slice(0, MAX_CHUNKS_PER_POLL);
      for (const r of ranges) {
        let events: HubEvent[];
        try {
          events = await this.chain.hubEvents(r.fromBlock, r.toBlock);
        } catch (err) {
          this.log(`indexer: ${err instanceof Error ? err.message : String(err)}`);
          return;
        }
        for (const e of events) this.apply(e);
        if (r.toBlock > cursor) this.repo.setCursor(r.toBlock); // a rescanned chunk never moves the cursor back
      }
    } catch (err) {
      this.log(`indexer: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Pure state transition on a `ChannelRow`, exported for unit tests. Idempotent: an event at or before the
   *  row's `lastEvent` is ignored, so re-applying a chunk (e.g. after `poll` retried a later failing one) is
   *  safe. */
  apply(e: HubEvent): void {
    if (e.kind === "ChannelCreated") {
      if (this.repo.channelRow(e.channelId)) return; // already known: no-op (re-applied after a partial chunk)
      const row: ChannelRow = {
        channelId: e.channelId,
        params: e.params,
        phase: "Funding",
        createdBlock: e.blockNumber,
        challenges: [0, 0],
        answered: [0, 0],
        pendingChallenger: null,
        registered: null,
        timeoutLoser: null,
        balances: null,
        lastEvent: eventKey(e),
      };
      this.repo.saveChannelRow(row);
      return;
    }

    const row = this.repo.channelRow(e.channelId);
    if (!row) {
      this.log(`indexer: event for unknown channel ${e.channelId}`);
      return;
    }
    if (!isNewer(e, row.lastEvent)) return; // already folded in

    const next: ChannelRow = { ...row, lastEvent: eventKey(e) };
    switch (e.kind) {
      case "Deposited":
        break; // stays Funding
      case "Opened":
        next.phase = "Open";
        break;
      case "Challenged": {
        const challenges: [number, number] = [...next.challenges];
        challenges[e.challenger] += 1;
        next.challenges = challenges;
        next.phase = "Challenged";
        next.pendingChallenger = e.challenger;
        next.registered = e.signed;
        break;
      }
      case "Responded": {
        if (next.pendingChallenger !== null) {
          const answered: [number, number] = [...next.answered];
          const answerer = (1 - next.pendingChallenger) as PlayerIndex;
          answered[answerer] += 1;
          next.answered = answered;
        }
        next.pendingChallenger = null;
        next.registered = e.signed;
        next.phase = "Open";
        break;
      }
      case "Finalized": {
        next.phase = "Finalized";
        next.balances = [e.balanceA, e.balanceB];
        if (next.pendingChallenger !== null && next.registered && !isGameOver(next.registered.state)) {
          next.timeoutLoser = mover(next.registered.state);
        }
        this.recordSettlement(next);
        break;
      }
      case "Reclaimed":
        next.phase = "Reclaimed";
        this.recordSettlement(next);
        break;
    }
    this.repo.saveChannelRow(next);
  }

  /** Copies what reputation and `/api/channels` read from the relay cache into the row, so they outlive the
   *  cache, which `Repo.pruneRelayCache` drops a day after `finalizedAt`. */
  private recordSettlement(row: ChannelRow): void {
    const latest: SignedState | null = this.relay?.latestState(row.channelId) ?? null;
    row.finalState = latest;
    row.games = latest ? gamesOf(latest.state) : 0;
    row.finalizedAt = Date.now();
  }

  /** `head - cursor` (0 if no chunk has ever committed, per `startBlock`) -- for `/metrics`. */
  async lag(): Promise<bigint> {
    const head = await this.chain.head();
    const cursor = this.repo.cursor() ?? this.cfg.indexer.startBlock - 1n;
    return head - cursor;
  }

  /** Starts polling on `cfg.indexer.pollMs` (a no-op if it's <= 0). The interval is `unref`'d so it never keeps
   *  the process alive by itself, and a guard skips a tick that would overlap a still-running poll. */
  start(): void {
    if (this.cfg.indexer.pollMs <= 0) return;
    this.timer = setInterval(() => {
      if (this.polling) return;
      this.polling = true;
      this.poll()
        .catch((err: unknown) => {
          this.log(`indexer: ${err instanceof Error ? err.message : String(err)}`);
        })
        .finally(() => {
          this.polling = false;
        });
    }, this.cfg.indexer.pollMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}

/** Aggregates `address`'s reputation across every channel row it appears in. `games` for a channel comes from
 *  `relay.latestState` (the same verified cache the relay itself serves): the indexer only sees on-chain phase
 *  transitions, not off-chain moves. A settled channel whose cache has been pruned falls back to the count the
 *  indexer recorded at settlement. */
export function playerStats(repo: Repo, relay: Relay, address: Address): PlayerStats {
  const addr = address.toLowerCase();
  const rows = repo.channelRowsFor(address);
  let open = 0;
  let finalized = 0;
  let reclaimed = 0;
  let games = 0;
  let challengesInitiated = 0;
  let challengesAnswered = 0;
  let timeoutsLost = 0;

  for (const row of rows) {
    const idx: PlayerIndex = row.params.participants[0].toLowerCase() === addr ? 0 : 1;
    if (row.phase === "Open" || row.phase === "Challenged") open += 1;
    if (row.phase === "Finalized") finalized += 1;
    if (row.phase === "Reclaimed") reclaimed += 1;
    challengesInitiated += row.challenges[idx];
    challengesAnswered += row.answered[idx];
    if (row.timeoutLoser === idx) timeoutsLost += 1;

    const latest = relay.latestState(row.channelId);
    if (latest) games += gamesOf(latest.state);
    else if (row.games !== undefined) games += row.games;
  }

  return {
    address, channels: rows.length, open, finalized, reclaimed, games,
    challengesInitiated, challengesAnswered, timeoutsLost,
  };
}
