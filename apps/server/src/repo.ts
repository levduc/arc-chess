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
  recordMatch(offerId: Hex, sa: SignedAcceptance, m: MatchEvent): boolean;
  pruneOffers(now: bigint): number;
  cacheRelay(channelId: Hex, sender: PlayerIndex, message: RelayMessage): void;
  cachedRelay(channelId: Hex): Array<{ sender: PlayerIndex; message: RelayMessage }>;
  cursor(): bigint | null;
  setCursor(block: bigint): void;
  channelRow(id: Hex): ChannelRow | null;
  saveChannelRow(row: ChannelRow): void;
  channelRowsFor(player: Address): ChannelRow[];
  recentChannels(limit: number): ChannelRow[];
  close(): void;
}

const ONE_DAY_SECONDS = 86_400n;

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
  created_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS relay_cache (
  channel_id TEXT NOT NULL,
  sender INTEGER NOT NULL,
  kind TEXT NOT NULL,
  body TEXT NOT NULL,
  PRIMARY KEY (channel_id, sender, kind)
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
  body TEXT NOT NULL
);
`;

export class SqliteRepo implements Repo {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    if (path !== ":memory:") this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec(SCHEMA);
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

  recordMatch(offerId: Hex, sa: SignedAcceptance, m: MatchEvent): boolean {
    const result = this.db
      .prepare("UPDATE offers SET acceptance = ?, match = ? WHERE offer_id = ? AND match IS NULL")
      .run(toWire(sa), toWire(m), offerId);
    return Number(result.changes) === 1;
  }

  pruneOffers(now: bigint): number {
    const threshold = now - ONE_DAY_SECONDS;
    const result = this.db
      .prepare("DELETE FROM offers WHERE match IS NULL AND expires_at <= ?")
      .run(padSeconds(threshold));
    return Number(result.changes);
  }

  cacheRelay(channelId: Hex, sender: PlayerIndex, message: RelayMessage): void {
    this.db
      .prepare(
        "INSERT INTO relay_cache (channel_id, sender, kind, body) VALUES (?, ?, ?, ?) " +
          "ON CONFLICT(channel_id, sender, kind) DO UPDATE SET body = excluded.body",
      )
      .run(channelId, sender, message.type, toWire(message));
  }

  cachedRelay(channelId: Hex): Array<{ sender: PlayerIndex; message: RelayMessage }> {
    const rows = this.db.prepare("SELECT sender, body FROM relay_cache WHERE channel_id = ?").all(channelId) as Array<{
      sender: number;
      body: string;
    }>;
    return rows.map((r) => ({ sender: r.sender as PlayerIndex, message: fromWire<RelayMessage>(r.body) }));
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
    this.db
      .prepare(
        "INSERT INTO channels (channel_id, a, b, created_block, body) VALUES (?, ?, ?, ?, ?) " +
          "ON CONFLICT(channel_id) DO UPDATE SET " +
          "a = excluded.a, b = excluded.b, created_block = excluded.created_block, body = excluded.body",
      )
      .run(row.channelId, a.toLowerCase(), b.toLowerCase(), row.createdBlock.toString(), toWire(row));
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
