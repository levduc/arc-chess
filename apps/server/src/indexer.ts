import type { Address, Hex } from "viem";
import { chunkRanges, isGameOver, isRangeRefusal, mover } from "@arena/sdk";
import type { HubEvent, PlayerIndex, SignedState, State } from "@arena/sdk";
import type { ChainReader } from "./chain.js";
import type { ServerConfig } from "./config.js";
import type { Relay } from "./relay.js";
import type { ChannelRow, Repo, UndoEntry } from "./repo.js";

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

/** Plan 6 hardening H1 (review m-11): the most `hubEvents` reads one poll makes -- its chunks plus the halves of any
 *  range the RPC refused (each split adds one). */
export const INDEXER_READS_PER_POLL = 64;

/** H1 (review m-11): the only hub events whose size a caller controls -- a proof's signature bytes, which the hub
 *  re-emits unchecked -- and every other kind, which is read on its own when a range is refused. */
const DISPUTE_KINDS: readonly HubEvent["kind"][] = ["Challenged", "Responded"];
const OTHER_KINDS: readonly HubEvent["kind"][] = ["ChannelCreated", "Deposited", "Opened", "Finalized", "Reclaimed"];

/** H1 (review m-11): a block whose events the RPC refuses on this many polls in a row, while it serves the block's
 *  other events alone, has its `Challenged`/`Responded` events skipped (see `Indexer.poll`). */
export const INDEXER_UNREADABLE_POLLS = 3;

/** Every poll re-reads this many blocks behind the cursor, as the daemons' dispute scan does: a lagging or
 *  load-balanced RPC can report a head its `getLogs` index has not caught up with yet. `apply` is idempotent
 *  (`lastEvent`), so re-reading is harmless. */
export const INDEXER_RESCAN_BLOCKS = 32n;

/** Games played in a channel whose latest state is `s`: every finished game before `gameIndex`, plus the current
 *  one once it has a move. */
export function gamesOf(s: State): number {
  return s.gameIndex + (s.turnNum > 0n ? 1 : 0);
}

function eventKey(e: HubEvent): { block: bigint; logIndex: number; blockHash?: Hex } {
  return e.blockHash === undefined
    ? { block: e.blockNumber, logIndex: e.logIndex }
    : { block: e.blockNumber, logIndex: e.logIndex, blockHash: e.blockHash };
}

/** A row as an undo snapshot: without its own undo log (entries never nest). */
function snapshotOf(row: ChannelRow): ChannelRow {
  const { undo: _undo, ...rest } = row;
  return rest;
}

/** Whether the chain still returns the event an undo entry recorded: same channel, position and kind, and (when both
 *  sides know it) the same block hash -- the same position in a replaced block is a different event. */
function stillThere(u: UndoEntry, id: Hex, events: HubEvent[]): boolean {
  return events.some(
    (e) =>
      e.channelId === id &&
      e.blockNumber === u.block &&
      e.logIndex === u.logIndex &&
      e.kind === u.kind &&
      (u.blockHash === undefined || e.blockHash === undefined || e.blockHash === u.blockHash),
  );
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
  /** H1 (review m-11): the one block whose events the RPC refused on consecutive polls, and how many in a row. */
  private unreadable: { block: bigint; tries: number } | null = null;
  /** H1 (review m-11): blocks whose `Challenged`/`Responded` events were skipped (in memory, oldest first). */
  private readonly skipped: bigint[] = [];

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
      if (cursor > head) {
        // The chunk range below (from just past the cursor to head) is then empty, so this poll silently does
        // nothing -- which looks identical to "fully caught up" on /metrics unless this is logged. The usual
        // cause is a database left over from a different chain instance (a redeployed local Anvil, a chain
        // reset) reusing a cursor that no longer makes sense; `startServer`'s chain-identity check now refuses
        // to start in that situation for a *new* config, but a long-lived process whose underlying chain was
        // reset out from under it (without a restart) still needs this warning.
        this.log(`indexer: cursor (${cursor}) is ahead of the chain head (${head}) -- indexing is stalled until the chain catches up`);
      }
      const rescan = cursor + 1n - INDEXER_RESCAN_BLOCKS;
      const from = rescan > this.cfg.indexer.startBlock ? rescan : this.cfg.indexer.startBlock;
      // Undo entries behind the window are final: this poll never re-reads their blocks.
      this.pruneUndo(from);
      // A stack, so a split range's halves are read next, in chain order.
      const pending = chunkRanges(from, head, BigInt(this.cfg.indexer.chunkBlocks)).slice(0, MAX_CHUNKS_PER_POLL).reverse();
      let contentRefused = false;
      for (let reads = 0; pending.length > 0 && reads < INDEXER_READS_PER_POLL; reads++) {
        const r = pending.pop()!;
        let events: HubEvent[];
        let partial = false;
        try {
          events = await this.chain.hubEvents(r.fromBlock, r.toBlock);
          this.readable(r.fromBlock, r.toBlock);
        } catch (err) {
          // H1 (review m-11): the hub re-emits a proof's unchecked signature bytes, so a griefer can make a range's
          // response larger than an RPC serves -- and before this, that one range stopped the indexer for good. If
          // the RPC serves the range's other events (so it is up, and the dispute events are what it refuses), the
          // range is split down to one block; a block refused on INDEXER_UNREADABLE_POLLS polls in a row then has
          // its dispute events skipped, and its other events (creations, deposits, settlements) are applied. An RPC
          // that refuses those too is down, or caps the range itself: the poll stops, as before.
          const msg = err instanceof Error ? err.message : String(err);
          // H3: only a refusal of the query itself (`isRangeRefusal`) may split the range or count toward a skip. A
          // rate limit, a timeout, a 5xx -- anything else -- stops the poll here, uncounted and unprobed: the next poll
          // reads the same range again. Before, a rate-limited read whose probe slipped through was split, and a block
          // rate-limited on three polls had its dispute events skipped.
          if (!isRangeRefusal(err)) {
            this.log(`indexer: ${msg}`);
            return;
          }
          if (r.fromBlock < r.toBlock) {
            if (!contentRefused) {
              try {
                await this.chain.hubEvents(r.fromBlock, r.toBlock, { kinds: OTHER_KINDS });
              } catch {
                this.log(`indexer: ${msg}`);
                return;
              }
              contentRefused = true;
            }
            const mid = r.fromBlock + (r.toBlock - r.fromBlock) / 2n;
            pending.push({ fromBlock: mid + 1n, toBlock: r.toBlock }, { fromBlock: r.fromBlock, toBlock: mid });
            continue;
          }
          const b = r.fromBlock;
          let others: HubEvent[];
          try {
            others = await this.chain.hubEvents(b, b, { kinds: OTHER_KINDS });
          } catch {
            this.log(`indexer: ${msg}`);
            return;
          }
          if (!this.skipped.includes(b)) {
            const tries = this.unreadable?.block === b ? this.unreadable.tries + 1 : 1;
            if (tries < INDEXER_UNREADABLE_POLLS) {
              this.unreadable = { block: b, tries };
              this.log(`indexer: block ${b}: the RPC refuses its events (${msg}) but serves the block's others; retried next poll`);
              return;
            }
            this.unreadable = null;
            this.skipped.push(b);
            this.log(
              `indexer: skipping the ${DISPUTE_KINDS.join("/")} events of block ${b}: the RPC refused its events ${tries} ` +
                `polls in a row (${msg}) while serving its other events, which are applied. Its channels' challenge counters ` +
                "and registered states may be stale until a later event; use an RPC that serves larger getLogs responses",
            );
          }
          events = others;
          partial = true;
        }
        // Before folding in this chunk, unwind any row whose already-applied events in these (already indexed)
        // blocks are gone -- reorged out -- so the events the chain has now are applied to the row as it was. Not for
        // a block read without its dispute events: their absence there is the RPC's refusal, not a reorg.
        if (!partial && r.fromBlock <= cursor) await this.unwind(events, r.fromBlock, r.toBlock < cursor ? r.toBlock : cursor);
        for (const e of events) this.apply(e);
        if (r.toBlock > cursor) this.repo.setCursor(r.toBlock); // a rescanned chunk never moves the cursor back
      }
    } catch (err) {
      this.log(`indexer: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** H1 (review m-11): the blocks whose `Challenged`/`Responded` events the indexer skipped because the RPC refused
   *  to serve them (oldest first), for operators and `/metrics`. A block leaves the list once a later read of it
   *  succeeds (within the rescan window). */
  skippedBlocks(): readonly bigint[] {
    return [...this.skipped];
  }

  /** H1 (review m-11): `[from, to]` read in full: a block in it is neither counting toward a skip nor skipped. */
  private readable(from: bigint, to: bigint): void {
    if (this.unreadable !== null && this.unreadable.block >= from && this.unreadable.block <= to) this.unreadable = null;
    for (let i = this.skipped.length - 1; i >= 0; i--) {
      const b = this.skipped[i];
      if (b < from || b > to) continue;
      this.skipped.splice(i, 1);
      this.log(`indexer: block ${b}, skipped earlier, was read in full`);
    }
  }

  /** Drops undo entries older than `from` (final: no later poll re-reads their blocks) and forgets rows left with
   *  none. */
  private pruneUndo(from: bigint): void {
    const watch = this.repo.reorgWatch();
    if (watch.length === 0) return;
    const keep: Hex[] = [];
    for (const id of watch) {
      const row = this.repo.channelRow(id);
      if (!row?.undo?.length) continue;
      const undo = row.undo.filter((u) => u.block >= from);
      if (undo.length !== row.undo.length) this.repo.saveChannelRow({ ...row, undo });
      if (undo.length > 0) keep.push(id);
    }
    if (keep.length !== watch.length) this.repo.setReorgWatch(keep);
  }

  /**
   * Plan 4.5 Task 10 (reorgs): for every watched row, checks the undo entries in `[from, to]` against `events`, the
   * chain's current events for those blocks. The first entry whose event is gone rolls the row back to how it was
   * before that event (a vanished `ChannelCreated` deletes the row); `apply` then re-applies whatever the chain
   * still has after it. An event can also be missing because the RPC's log index lags its head, not because of a
   * reorg: when the entry carries a block hash and the chain reader can look one up, the row is only unwound if
   * the block at that height has actually been replaced.
   */
  private async unwind(events: HubEvent[], from: bigint, to: bigint): Promise<void> {
    const watch = this.repo.reorgWatch();
    let changed = false;
    for (const id of watch) {
      const row = this.repo.channelRow(id);
      if (!row?.undo?.length) continue;
      const i = row.undo.findIndex((u) => u.block >= from && u.block <= to && !stillThere(u, id, events));
      if (i < 0) continue;
      const gone = row.undo[i];
      if (gone.blockHash !== undefined && this.chain.blockHash) {
        const now = await this.chain.blockHash(gone.block);
        if (now === gone.blockHash) continue; // same block: a lagging log index, not a reorg -- retried next poll
      }
      this.log(`indexer: reorg: ${gone.kind} of channel ${id} at block ${gone.block} is gone; rolling the row back`);
      if (gone.before === null) {
        this.repo.deleteChannelRow(id);
        changed = true;
      } else {
        this.repo.saveChannelRow({ ...gone.before, undo: row.undo.slice(0, i) });
      }
    }
    if (changed) this.repo.setReorgWatch(watch.filter((id) => this.repo.channelRow(id) !== null));
  }

  /** Records that `e` was applied to a row that was `before` (null: `e` created it), for `unwind`. */
  private withUndo(next: ChannelRow, e: HubEvent, before: ChannelRow | null): ChannelRow {
    const entry: UndoEntry = { block: e.blockNumber, logIndex: e.logIndex, kind: e.kind, before: before && snapshotOf(before) };
    if (e.blockHash !== undefined) entry.blockHash = e.blockHash;
    const watch = this.repo.reorgWatch();
    if (!watch.includes(e.channelId)) this.repo.setReorgWatch([...watch, e.channelId]);
    return { ...next, undo: [...(before?.undo ?? []), entry] };
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
      this.repo.saveChannelRow(this.withUndo(row, e, null));
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
    this.repo.saveChannelRow(this.withUndo(next, e, row));
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
