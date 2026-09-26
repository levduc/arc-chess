import { existsSync, readdirSync, rmSync } from "node:fs";
import type { Hex } from "viem";
import type { Offer, Params, PlayerIndex } from "@arena/sdk";
import { arenaPaths } from "./config.js";
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

  channels(): ChannelRecord[] {
    if (!existsSync(this.paths.channels)) return [];
    return readdirSync(this.paths.channels)
      .map((id) => this.channel(id as Hex))
      .filter((r): r is ChannelRecord => r !== null);
  }

  saveOffer(r: OfferRecord): void {
    writeJsonAtomic(this.paths.offerRecord(r.offerId), r);
  }

  offer(id: Hex): OfferRecord | null {
    return readJson<OfferRecord>(this.paths.offerRecord(id));
  }

  offers(): OfferRecord[] {
    if (!existsSync(this.paths.offers)) return [];
    return readdirSync(this.paths.offers)
      .filter((f) => f.endsWith(".json"))
      .map((f) => this.offer(f.slice(0, -".json".length) as Hex))
      .filter((r): r is OfferRecord => r !== null);
  }

  removeOffer(id: Hex): void {
    rmSync(this.paths.offerRecord(id), { force: true });
  }
}
