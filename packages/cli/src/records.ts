import { existsSync, readdirSync, rmSync } from "node:fs";
import type { Hex } from "viem";
import type { Offer, Params, PlayerIndex } from "@arena/sdk";
import { arenaPaths, isCanonicalId } from "./config.js";
import { readJson, writeJsonAtomic } from "./jsonfile.js";

export type Controller = "agent" | "human";

export type ChannelRecord = {
  channelId: Hex;
  params: Params;
  me: PlayerIndex;
  sessionKey: Hex;
  offerId: Hex;
  createdBlock: bigint;
  controller: Controller;
  note: string;
  finalized: boolean;
};

/** One entry of `channels/`: its record, or why it could not be read. */
export type ChannelEntry = { channelId: string; record: ChannelRecord } | { channelId: string; record: null; error: string };

export type OfferRecord = { offerId: Hex; offer: Offer; sessionKey: Hex; role: "offerer" | "accepter" };

export class RecordStore {
  private readonly paths;

  constructor(home: string) {
    this.paths = arenaPaths(home);
  }

  saveChannel(r: ChannelRecord): void {
    writeJsonAtomic(this.paths.channelRecord(r.channelId), r);
  }

  channel(id: Hex): ChannelRecord | null {
    return readJson<ChannelRecord>(this.paths.channelRecord(id));
  }

  /**
   * Every entry under `channels/`, each read in isolation (I1): a corrupt or foreign entry — unparsable
   * `record.json`, a non-canonical directory name, a record naming another channel — is returned with its
   * error instead of aborting the scan, so one bad file can never hide the other channels.
   */
  scanChannels(): ChannelEntry[] {
    if (!existsSync(this.paths.channels)) return [];
    return readdirSync(this.paths.channels).map((name): ChannelEntry => {
      try {
        const r = this.channel(name as Hex);
        if (r === null) throw new Error("record.json is missing");
        if (typeof r !== "object" || r.channelId !== name) throw new Error("record.json does not describe this channel");
        return { channelId: name, record: r };
      } catch (err) {
        return { channelId: name, record: null, error: err instanceof Error ? err.message.split("\n")[0] : String(err) };
      }
    });
  }

  /** The readable channel records (unreadable entries are skipped; see `scanChannels`). */
  channels(): ChannelRecord[] {
    return this.scanChannels().flatMap((e) => (e.record ? [e.record] : []));
  }

  saveOffer(r: OfferRecord): void {
    writeJsonAtomic(this.paths.offerRecord(r.offerId), r);
  }

  offer(id: Hex): OfferRecord | null {
    return readJson<OfferRecord>(this.paths.offerRecord(id));
  }

  /** The readable offer records; files that are not a canonical `<offerId>.json` or do not parse are skipped. */
  offers(): OfferRecord[] {
    if (!existsSync(this.paths.offers)) return [];
    return readdirSync(this.paths.offers)
      .filter((f) => f.endsWith(".json") && isCanonicalId(f.slice(0, -".json".length)))
      .flatMap((f) => {
        try {
          const r = this.offer(f.slice(0, -".json".length) as Hex);
          return r ? [r] : [];
        } catch {
          return [];
        }
      });
  }

  removeOffer(id: Hex): void {
    rmSync(this.paths.offerRecord(id), { force: true });
  }
}
