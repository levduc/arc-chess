import type { Hex } from "viem";
import {
  buildParams,
  offerId,
  verifyAcceptance,
  verifyOffer,
  type LobbyClient,
  type MatchEvent,
  type MatchTerms,
  type RelayClient,
  type RelayMessage,
  type SignedAcceptance,
  type SignedOffer,
} from "@arena/sdk";

type Member = { rooms: Set<Hex>; handlers: Set<(m: RelayMessage) => void>; connected: boolean };

/** In-process stand-in for the host (Plan 4) using the same SDK matching rules. */
export class MemoryArena {
  private readonly offers = new Map<Hex, SignedOffer>();
  private readonly matchHandlers = new Set<(m: MatchEvent) => void>();
  private readonly members = new Set<Member>();

  constructor(private readonly terms: () => Promise<MatchTerms & { now: bigint }>) {}

  client(): { lobby: LobbyClient; relay: RelayClient; disconnect(): void; reconnect(): void } {
    const member: Member = { rooms: new Set(), handlers: new Set(), connected: true };
    this.members.add(member);
    const lobby: LobbyClient = {
      postOffer: async (so) => {
        if (!(await verifyOffer(so))) throw new Error("bad offer signature");
        const id = offerId(so.offer);
        this.offers.set(id, structuredClone(so));
        return id;
      },
      listOffers: async () => [...this.offers.values()].map((o) => structuredClone(o)),
      accept: async (sa: SignedAcceptance) => {
        const so = this.offers.get(sa.acceptance.offerId);
        if (!so) throw new Error("unknown offer");
        if (!(await verifyAcceptance(sa))) throw new Error("bad acceptance signature");
        const t = await this.terms();
        const params = buildParams(so.offer, sa.acceptance, t, t.now);
        this.offers.delete(sa.acceptance.offerId);
        const event: MatchEvent = { offerId: sa.acceptance.offerId, params };
        setTimeout(() => {
          for (const h of this.matchHandlers) h(structuredClone(event));
        }, 0);
      },
      onMatch: (h) => {
        this.matchHandlers.add(h);
        return () => this.matchHandlers.delete(h);
      },
    };
    const relay: RelayClient = {
      join: async (channelId) => {
        member.rooms.add(channelId);
      },
      send: async (msg) => {
        if (!member.connected) throw new Error("disconnected");
        for (const other of this.members) {
          if (other === member || !other.connected || !other.rooms.has(msg.channelId)) continue;
          const copy = structuredClone(msg);
          setTimeout(() => {
            for (const h of other.handlers) h(copy);
          }, 0);
        }
      },
      onMessage: (h) => {
        member.handlers.add(h);
        return () => member.handlers.delete(h);
      },
    };
    return {
      lobby,
      relay,
      disconnect: () => {
        member.connected = false;
      },
      reconnect: () => {
        member.connected = true;
      },
    };
  }
}
