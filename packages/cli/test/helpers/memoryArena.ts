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

type Member = {
  rooms: Set<Hex>;
  watched: Set<Hex>;
  unwatched: Hex[];
  handlers: Set<(m: RelayMessage) => void>;
  joinedHandlers: Set<(id: Hex) => void>;
  watchRefusedHandlers: Set<(message: string) => void>;
  connected: boolean;
};

/** In-process stand-in for the host (Plan 4) using the same SDK matching rules. */
export class MemoryArena {
  private readonly offers = new Map<Hex, SignedOffer>();
  private readonly matchHandlers = new Set<(m: MatchEvent) => void>();
  private readonly members = new Set<Member>();

  constructor(private readonly terms: () => Promise<MatchTerms & { now: bigint }>) {}

  client(): {
    lobby: LobbyClient;
    relay: RelayClient;
    disconnect(): void;
    reconnect(): void;
    /** Channels this client is currently joined to (left channels are gone). */
    rooms(): Hex[];
    /** Offer ids this client currently watches, and every id it has unwatched, in order. */
    watched(): Hex[];
    unwatched(): Hex[];
    /** Test-only: simulates the host refusing a subscribe (e.g. "too many watched offers"), firing every handler
     *  registered via `lobby.onWatchRefused`. Plan 4.5 Task 11 fix round -- this in-memory stand-in has no real
     *  per-connection watch cap to trip on its own. */
    refuseWatch(message: string): void;
  } {
    const member: Member = {
      rooms: new Set(),
      watched: new Set(),
      unwatched: [],
      handlers: new Set(),
      joinedHandlers: new Set(),
      watchRefusedHandlers: new Set(),
      connected: true,
    };
    this.members.add(member);
    const lobby: LobbyClient = {
      postOffer: async (so) => {
        if (!(await verifyOffer(so))) throw new Error("bad offer signature");
        const id = offerId(so.offer);
        this.offers.set(id, structuredClone(so));
        // Mirrors host.ts's real postOffer, which watches its own new offer on success (Plan 4.5 Task 11 fix
        // round: daemon.ts no longer does this redundantly itself -- see M5 -- so the fake must do it here for
        // its `watched()`/`unwatched()` bookkeeping to mean anything).
        lobby.watch([id]);
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
        // Mirrors host.ts's real accept(), which watches the just-matched offer on success -- see postOffer above.
        lobby.watch([event.offerId]);
        setTimeout(() => {
          for (const h of this.matchHandlers) h(structuredClone(event));
        }, 0);
      },
      onMatch: (h) => {
        this.matchHandlers.add(h);
        return () => this.matchHandlers.delete(h);
      },
      watch: (ids) => {
        for (const id of ids) member.watched.add(id);
      },
      unwatch: (ids) => {
        for (const id of ids) {
          member.watched.delete(id);
          member.unwatched.push(id);
        }
      },
      onWatchRefused: (h) => {
        member.watchRefusedHandlers.add(h);
        return () => member.watchRefusedHandlers.delete(h);
      },
    };
    const relay: RelayClient = {
      join: async (channelId) => {
        member.rooms.add(channelId);
        setTimeout(() => {
          for (const h of member.joinedHandlers) h(channelId);
        }, 0);
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
      onJoined: (h) => {
        member.joinedHandlers.add(h);
        return () => member.joinedHandlers.delete(h);
      },
      leave: (channelId) => {
        member.rooms.delete(channelId);
      },
    };
    return {
      lobby,
      relay,
      disconnect: () => {
        member.connected = false;
      },
      // Simulates the real transport's re-join: fires every joined handler for every room already joined.
      reconnect: () => {
        member.connected = true;
        for (const channelId of member.rooms) {
          setTimeout(() => {
            for (const h of member.joinedHandlers) h(channelId);
          }, 0);
        }
      },
      rooms: () => [...member.rooms],
      watched: () => [...member.watched],
      unwatched: () => [...member.unwatched],
      refuseWatch: (message: string) => {
        for (const h of member.watchRefusedHandlers) h(message);
      },
    };
  }
}
