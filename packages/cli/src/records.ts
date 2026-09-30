import { existsSync, readdirSync, rmSync } from "node:fs";
import type { Hex } from "viem";
import type { Offer, Params, PlayerIndex, SignedAcceptance } from "@arena/sdk";
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
  /** I3: last block whose dispute events have all been ingested; absent = none scanned yet. */
  scannedBlock?: bigint;
  /** Final review I3: the on-chain phase the channel was retired in (Finalized, Reclaimed, or None/Funding for a
   *  channel that never opened), recorded with `finalized`, so its status can still be served from disk once the
   *  daemon has let go of it. Absent in records written before it existed. */
  finalPhase?: string;
  /** Plan 5 Task 1 (mainnet gates: session-gas sweep): `true` once the session key's balance has been swept back
   *  to the wallet, `"dust"` if it was declined as too small to be worth the send cost, or `"abandoned"` (fix
   *  round I8) after `SWEEP_ABANDON_ATTEMPTS` failed attempts -- the session gas is written off rather than
   *  retried forever. Absent (unset) for a channel not finalized yet, or finalized but not yet swept (including
   *  every record written before this feature existed -- `arena sweep`/`POST /sweep` picks those up too). */
  swept?: true | "dust" | "abandoned";
  /** Plan 5 fix round (rule 4): the amount swept (base units of native gas), set alongside `swept: true`. Fix
   *  round 3, M-4: the latest entry of `sweeps`, kept for compatibility. */
  sweptAmount?: bigint;
  /** Plan 5 fix round (rule 4): the sweep transaction's hash, set alongside `swept: true`. Fix round 3, M-4: the
   *  latest entry of `sweeps`, kept for compatibility. */
  sweptTx?: Hex;
  /** Fix round 3, M-4: every real sweep this channel's session key has had, oldest first, appended to (never
   *  overwritten) each time `swept: true` is set. A late top-up re-checked and swept again (minor 4), or an
   *  "abandoned" channel `arena sweep` retries successfully (important 1), means more than one over a channel's
   *  lifetime -- `sweptAmount`/`sweptTx` alone, overwritten each time, only ever showed the latest. Absent for a
   *  record written before this field existed, or one never (yet) swept for real. */
  sweeps?: Array<{ amount: bigint; tx: Hex; at: number }>;
  /** Plan 5 Task 1 (mainnet gates: settled index): wall-clock ms at which this channel was first seen finalized,
   *  set alongside `finalized`. Used to sort the settled index loaded at `start()` by settle time, newest first.
   *  Absent in records written before this field existed (sorts as the oldest). */
  settledAt?: number;
};

/** One entry of `channels/`: its record, or why it could not be read. */
export type ChannelEntry = { channelId: string; record: ChannelRecord } | { channelId: string; record: null; error: string };

export type OfferRecord = {
  offerId: Hex;
  offer: Offer;
  sessionKey: Hex;
  role: "offerer" | "accepter";
  /** M-d: the accepter's signed acceptance, stored before it is sent, so a retry re-sends it instead of re-keying. */
  acceptance?: SignedAcceptance;
};

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
