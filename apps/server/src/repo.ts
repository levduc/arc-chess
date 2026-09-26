import { DatabaseSync } from "node:sqlite";
import type { Address, Hex } from "viem";
import { fromWire, toWire } from "@arena/sdk";
import type {
  MatchEvent,
  Params,
  PlayerIndex,
  RelayMessage,
  SignedAcceptance,
  SignedOffer,
  SignedState,
} from "@arena/sdk";

export type ChannelRow = {
  channelId: Hex; params: Params;
  phase: "Funding" | "Open" | "Challenged" | "Finalized" | "Reclaimed";
  createdBlock: bigint;
  challenges: [number, number]; answered: [number, number];
  pendingChallenger: PlayerIndex | null; registered: SignedState | null;
  timeoutLoser: PlayerIndex | null; balances: [bigint, bigint] | null;
  /** The last hub event applied to this row (block, logIndex) -- lets `Indexer.apply` ignore an event it has
   *  already folded in when a partially-processed chunk is re-scanned. Optional so older/hand-built rows
   *  (e.g. the foundation test's literal) still round-trip. */
  lastEvent?: { block: bigint; logIndex: number };
  /** Set when the indexer applies `Finalized`/`Reclaimed`: the relay's verified latest state and the games count
   *  derived from it, kept so reputation and `/api/channels` survive the relay cache being pruned. */
  games?: number;
  finalState?: SignedState | null;
  /** Wall-clock ms at which the indexer applied `Finalized`/`Reclaimed`; the relay cache is pruned a day later. */
  finalizedAt?: number;
};

export type OfferEntry = { signed: SignedOffer; acceptance: SignedAcceptance | null; match: MatchEvent | null };

export interface Repo {
  insertOffer(offerId: Hex, so: SignedOffer, ip: string): boolean;
  offer(offerId: Hex): OfferEntry | null;
  openOffers(now: bigint): SignedOffer[];
  /** Open, unexpired offers posted from this IP -- the anti-spam key (I2 review): `offer.player` is unauthenticated
   *  and free to mint, so keying the cap on it lets anyone burn a stranger's slots or dodge the cap with a fresh
   *  address. The IP is what actually costs the poster something. */
  openOfferCount(ip: string, now: bigint): number;
  /** Total open, unexpired offers -- a single SQL COUNT(*), not a full deserialize-and-.length like `openOffers`. */
  openOfferTotal(now: bigint): number;
  /** `channelId` is `channelId(chainId, hub, m.params)`, computed by the caller (the repo has no domain). */
  recordMatch(offerId: Hex, sa: SignedAcceptance, m: MatchEvent, channelId: Hex): boolean;
  pruneOffers(now: bigint): number;
  /** The relay's join gate: whether this host matched the channel in its lobby or has indexed it on-chain, and it
   *  is not settled (an indexer row in `Finalized`/`Reclaimed` makes it unknown again). */
  knownChannel(channelId: Hex): boolean;
  /** Keeps up to `RELAY_STATE_DEPTH` `state` messages per (channel, sender) -- the highest turns -- plus the latest
   *  `close`. A same-turn state replaces the held one; a lower turn never evicts a higher one. */
  cacheRelay(channelId: Hex, sender: PlayerIndex, message: RelayMessage): void;
  /** Cached messages for a channel, states in ascending `turnNum` order. */
  cachedRelay(channelId: Hex): Array<{ sender: PlayerIndex; message: RelayMessage }>;
  /** Deletes the relay cache of every channel finalized more than a day before `nowMs`; returns channels pruned. */
  pruneRelayCache(nowMs: number): number;
  cursor(): bigint | null;
  setCursor(block: bigint): void;
  channelRow(id: Hex): ChannelRow | null;
  saveChannelRow(row: ChannelRow): void;
  channelRowsFor(player: Address): ChannelRow[];
  recentChannels(limit: number): ChannelRow[];
  close(): void;
}

const ONE_DAY_SECONDS = 86_400n;
const ONE_DAY_MS = 86_400_000;
/** How many `state` messages the relay cache keeps per (channel, sender): enough that a game-ending state survives
 *  the same player's next-game checkpoint (and a re-send or two) until the peer rejoins. */
export const RELAY_STATE_DEPTH = 4;
// sorts below every padded turn, so a sender's close never collides with its states
const CLOSE_TURN = "-1";

/** Zero-pads a non-negative bigint to 20 decimal digits so plain text comparison ("<", ">") orders correctly. */
function padSeconds(n: bigint): string {
  const clamped = n < 0n ? 0n : n;
  return clamped.toString().padStart(20, "0");
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS offers (
  offer_id TEXT PRIMARY KEY,
  player TEXT NOT NULL,
  ip TEXT NOT NULL DEFAULT '',
  expires_at TEXT NOT NULL,
  body TEXT NOT NULL,
  acceptance TEXT,
  match TEXT,
  created_ms INTEGER NOT NULL,
  channel_id TEXT,
  funding_deadline TEXT
);
CREATE TABLE IF NOT EXISTS relay_cache (
  channel_id TEXT NOT NULL,
  sender INTEGER NOT NULL,
  kind TEXT NOT NULL,
  turn TEXT NOT NULL,
  body TEXT NOT NULL,
  PRIMARY KEY (channel_id, sender, kind, turn)
);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS channels (
  channel_id TEXT PRIMARY KEY,
  a TEXT NOT NULL,
  b TEXT NOT NULL,
  created_block TEXT NOT NULL,
  body TEXT NOT NULL,
  prune_at INTEGER
);
`;

// run after the migration below has added any missing columns to an older database
const INDEXES = `
CREATE INDEX IF NOT EXISTS offers_ip_match_expires ON offers(ip, match, expires_at);
CREATE INDEX IF NOT EXISTS offers_match_expires ON offers(match, expires_at);
CREATE INDEX IF NOT EXISTS offers_channel ON offers(channel_id);
CREATE INDEX IF NOT EXISTS channels_a ON channels(a);
CREATE INDEX IF NOT EXISTS channels_b ON channels(b);
CREATE INDEX IF NOT EXISTS channels_prune_at ON channels(prune_at) WHERE prune_at IS NOT NULL;
`;

/** The `turn` key a cached message is stored under: the zero-padded turnNum for a state (text, so any uint64
 *  orders correctly), `CLOSE_TURN` for a close. */
function turnKey(message: RelayMessage): string {
  return message.type === "state" ? padSeconds(message.signed.state.turnNum) : CLOSE_TURN;
}

export class SqliteRepo implements Repo {
  private readonly db: DatabaseSync;

  /** `channelIdOf` backfills `offers.channel_id` for matches recorded by an older schema; without it such rows
   *  stay unknown to the relay until the indexer sees the channel on-chain. */
  constructor(path: string, channelIdOf?: (p: Params) => Hex) {
    this.db = new DatabaseSync(path);
    if (path !== ":memory:") this.db.exec("PRAGMA journal_mode=WAL");
    this.migrate(channelIdOf);
  }

  private columns(table: string): Set<string> {
    const rows = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    return new Set(rows.map((r) => r.name));
  }

  /** Brings a database written by an older schema up to date: `CREATE TABLE IF NOT EXISTS` alone never alters an
   *  existing table. Idempotent, and a no-op on a fresh database. */
  private migrate(channelIdOf?: (p: Params) => Hex): void {
    // one transaction (SQLite DDL is transactional): a crash mid-migration leaves the old schema intact
    this.db.exec("BEGIN");
    try {
      this.migrateSteps(channelIdOf);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  private migrateSteps(channelIdOf?: (p: Params) => Hex): void {
    const oldCache = this.columns("relay_cache");
    let carried: Array<{ channel_id: string; sender: number; kind: string; body: string }> = [];
    if (oldCache.size > 0 && !oldCache.has("turn")) {
      // the primary key gains `turn`, which SQLite cannot alter in place: rebuild the table, keeping its rows
      carried = this.db.prepare("SELECT channel_id, sender, kind, body FROM relay_cache").all() as typeof carried;
      this.db.exec("DROP TABLE relay_cache");
    }
    this.db.exec(SCHEMA);
    // the old key held at most one row per (channel, sender, kind), so these can never collide
    const insert = this.db.prepare("INSERT INTO relay_cache (channel_id, sender, kind, turn, body) VALUES (?, ?, ?, ?, ?)");
    for (const r of carried) {
      insert.run(r.channel_id, r.sender, r.kind, turnKey(fromWire<RelayMessage>(r.body)), r.body);
    }
    const offers = this.columns("offers");
    if (!offers.has("channel_id")) this.db.exec("ALTER TABLE offers ADD COLUMN channel_id TEXT");
    if (!offers.has("funding_deadline")) this.db.exec("ALTER TABLE offers ADD COLUMN funding_deadline TEXT");
    if (!this.columns("channels").has("prune_at")) this.db.exec("ALTER TABLE channels ADD COLUMN prune_at INTEGER");
    this.db.exec(INDEXES);

    const stale = this.db
      .prepare("SELECT offer_id, match FROM offers WHERE match IS NOT NULL AND funding_deadline IS NULL")
      .all() as Array<{ offer_id: string; match: string }>;
    const update = this.db.prepare(
      "UPDATE offers SET funding_deadline = ?, channel_id = COALESCE(channel_id, ?) WHERE offer_id = ?",
    );
    for (const r of stale) {
      const m = fromWire<MatchEvent>(r.match);
      update.run(padSeconds(m.params.fundingDeadline), channelIdOf ? channelIdOf(m.params) : null, r.offer_id);
    }
  }

  insertOffer(offerId: Hex, so: SignedOffer, ip: string): boolean {
    const result = this.db
      .prepare(
        "INSERT INTO offers (offer_id, player, ip, expires_at, body, created_ms) VALUES (?, ?, ?, ?, ?, ?) " +
          "ON CONFLICT(offer_id) DO NOTHING",
      )
      .run(offerId, so.offer.player.toLowerCase(), ip, padSeconds(so.offer.expiresAt), toWire(so), Date.now());
    return Number(result.changes) === 1; // 0 changes means offer_id already existed and was skipped
  }

  offer(offerId: Hex): OfferEntry | null {
    const row = this.db.prepare("SELECT body, acceptance, match FROM offers WHERE offer_id = ?").get(offerId) as
      | { body: string; acceptance: string | null; match: string | null }
      | undefined;
    if (!row) return null;
    return {
      signed: fromWire<SignedOffer>(row.body),
      acceptance: row.acceptance === null ? null : fromWire<SignedAcceptance>(row.acceptance),
      match: row.match === null ? null : fromWire<MatchEvent>(row.match),
    };
  }

  openOffers(now: bigint): SignedOffer[] {
    const rows = this.db
      .prepare("SELECT body FROM offers WHERE match IS NULL AND expires_at > ? ORDER BY created_ms ASC, offer_id ASC")
      .all(padSeconds(now)) as Array<{ body: string }>;
    return rows.map((r) => fromWire<SignedOffer>(r.body));
  }

  openOfferCount(ip: string, now: bigint): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM offers WHERE ip = ? AND match IS NULL AND expires_at > ?")
      .get(ip, padSeconds(now)) as { n: number | bigint };
    return Number(row.n);
  }

  openOfferTotal(now: bigint): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM offers WHERE match IS NULL AND expires_at > ?")
      .get(padSeconds(now)) as { n: number | bigint };
    return Number(row.n);
  }

  recordMatch(offerId: Hex, sa: SignedAcceptance, m: MatchEvent, channelId: Hex): boolean {
    const result = this.db
      .prepare(
        "UPDATE offers SET acceptance = ?, match = ?, channel_id = ?, funding_deadline = ? " +
          "WHERE offer_id = ? AND match IS NULL",
      )
      .run(toWire(sa), toWire(m), channelId.toLowerCase(), padSeconds(m.params.fundingDeadline), offerId);
    return Number(result.changes) === 1;
  }

  pruneOffers(now: bigint): number {
    const threshold = padSeconds(now - ONE_DAY_SECONDS);
    this.db.exec("BEGIN");
    try {
      const unmatched = this.db.prepare("DELETE FROM offers WHERE match IS NULL AND expires_at <= ?").run(threshold);
      // A never-funded channel has no indexer row, so nothing else would ever prune its relay cache: drop it
      // with the match that made it joinable (a settled channel's cache goes through pruneRelayCache instead).
      this.db
        .prepare(
          "DELETE FROM relay_cache WHERE channel_id IN (SELECT channel_id FROM offers WHERE match IS NOT NULL " +
            "AND funding_deadline < ? AND NOT EXISTS (SELECT 1 FROM channels c WHERE c.channel_id = offers.channel_id))",
        )
        .run(threshold);
      // a day past its funding deadline a match can no longer be funded, so it is only worth keeping while it
      // still identifies a live channel for the relay's join gate (an indexer row that is not settled yet)
      const matched = this.db
        .prepare(
          "DELETE FROM offers WHERE match IS NOT NULL AND funding_deadline < ? AND (" +
            "NOT EXISTS (SELECT 1 FROM channels c WHERE c.channel_id = offers.channel_id) OR " +
            "EXISTS (SELECT 1 FROM channels c WHERE c.channel_id = offers.channel_id " +
            "AND json_extract(c.body, '$.phase') IN ('Finalized', 'Reclaimed')))",
        )
        .run(threshold);
      this.db.exec("COMMIT");
      return Number(unmatched.changes) + Number(matched.changes);
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  knownChannel(channelId: Hex): boolean {
    const id = channelId.toLowerCase();
    const indexed = this.db
      .prepare("SELECT json_extract(body, '$.phase') AS phase FROM channels WHERE channel_id = ?")
      .get(id) as { phase: string } | undefined;
    // a settled channel is never joinable again, so its pruned cache cannot be refilled
    if (indexed) return indexed.phase !== "Finalized" && indexed.phase !== "Reclaimed";
    return this.db.prepare("SELECT 1 AS k FROM offers WHERE channel_id = ? LIMIT 1").get(id) !== undefined;
  }

  cacheRelay(channelId: Hex, sender: PlayerIndex, message: RelayMessage): void {
    const turn = turnKey(message);
    const body = toWire(message);
    const upsert = this.db.prepare(
      "INSERT INTO relay_cache (channel_id, sender, kind, turn, body) VALUES (?, ?, ?, ?, ?) " +
        "ON CONFLICT(channel_id, sender, kind, turn) DO UPDATE SET body = excluded.body",
    );
    if (message.type === "close") {
      this.db.prepare("DELETE FROM relay_cache WHERE channel_id = ? AND sender = ? AND kind = 'close'").run(
        channelId,
        sender,
      );
      upsert.run(channelId, sender, "close", turn, body);
      return;
    }
    this.db.exec("BEGIN");
    try {
      const held = this.db
        .prepare(
          "SELECT COUNT(*) AS n, MIN(turn) AS low, SUM(turn = ?) AS same FROM relay_cache " +
            "WHERE channel_id = ? AND sender = ? AND kind = 'state'",
        )
        .get(turn, channelId, sender) as { n: number | bigint; low: string | null; same: number | bigint | null };
      const full = Number(held.n) >= RELAY_STATE_DEPTH;
      if (Number(held.same ?? 0) === 0 && full && held.low !== null && turn <= held.low) {
        this.db.exec("COMMIT"); // lower than everything held and no room: never evicts a higher turn
        return;
      }
      upsert.run(channelId, sender, "state", turn, body);
      this.db
        .prepare(
          "DELETE FROM relay_cache WHERE channel_id = ? AND sender = ? AND kind = 'state' AND turn NOT IN (" +
            "SELECT turn FROM relay_cache WHERE channel_id = ? AND sender = ? AND kind = 'state' " +
            "ORDER BY turn DESC LIMIT ?)",
        )
        .run(channelId, sender, channelId, sender, RELAY_STATE_DEPTH);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  cachedRelay(channelId: Hex): Array<{ sender: PlayerIndex; message: RelayMessage }> {
    const rows = this.db
      .prepare("SELECT sender, body FROM relay_cache WHERE channel_id = ? ORDER BY sender ASC, kind DESC, turn ASC")
      .all(channelId) as Array<{ sender: number; body: string }>;
    return rows.map((r) => ({ sender: r.sender as PlayerIndex, message: fromWire<RelayMessage>(r.body) }));
  }

  pruneRelayCache(nowMs: number): number {
    const due = this.db
      .prepare("SELECT channel_id FROM channels WHERE prune_at IS NOT NULL AND prune_at <= ?")
      .all(nowMs) as Array<{ channel_id: string }>;
    if (due.length === 0) return 0;
    const del = this.db.prepare("DELETE FROM relay_cache WHERE channel_id = ?");
    const done = this.db.prepare("UPDATE channels SET prune_at = NULL WHERE channel_id = ?");
    this.db.exec("BEGIN");
    try {
      for (const { channel_id } of due) {
        del.run(channel_id);
        done.run(channel_id);
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    return due.length;
  }

  cursor(): bigint | null {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = 'cursor'").get() as
      | { value: string }
      | undefined;
    return row ? BigInt(row.value) : null;
  }

  setCursor(block: bigint): void {
    this.db
      .prepare(
        "INSERT INTO meta (key, value) VALUES ('cursor', ?) " + "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(block.toString());
  }

  channelRow(id: Hex): ChannelRow | null {
    const row = this.db.prepare("SELECT body FROM channels WHERE channel_id = ?").get(id) as
      | { body: string }
      | undefined;
    return row ? fromWire<ChannelRow>(row.body) : null;
  }

  saveChannelRow(row: ChannelRow): void {
    const [a, b] = row.params.participants;
    const pruneAt = row.finalizedAt === undefined ? null : row.finalizedAt + ONE_DAY_MS;
    this.db
      .prepare(
        "INSERT INTO channels (channel_id, a, b, created_block, body, prune_at) VALUES (?, ?, ?, ?, ?, ?) " +
          "ON CONFLICT(channel_id) DO UPDATE SET " +
          "a = excluded.a, b = excluded.b, created_block = excluded.created_block, body = excluded.body, " +
          "prune_at = excluded.prune_at",
      )
      .run(row.channelId, a.toLowerCase(), b.toLowerCase(), row.createdBlock.toString(), toWire(row), pruneAt);
  }

  channelRowsFor(player: Address): ChannelRow[] {
    const p = player.toLowerCase();
    const rows = this.db.prepare("SELECT body FROM channels WHERE a = ? OR b = ?").all(p, p) as Array<{ body: string }>;
    return rows.map((r) => fromWire<ChannelRow>(r.body));
  }

  recentChannels(limit: number): ChannelRow[] {
    const rows = this.db
      .prepare("SELECT body FROM channels ORDER BY CAST(created_block AS INTEGER) DESC LIMIT ?")
      .all(limit) as Array<{ body: string }>;
    return rows.map((r) => fromWire<ChannelRow>(r.body));
  }

  close(): void {
    this.db.close();
  }
}
