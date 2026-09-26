import type { Address, Hex } from "viem";
import {
  decodeWire,
  parseMatchEvent,
  parseRelayMessage,
  parseSignedOffer,
  signRelayJoin,
  toWire,
  WireFormatError,
  type LobbyClient,
  type MatchEvent,
  type Params,
  type RelayClient,
  type RelayMessage,
  type RelaySigner,
  type SignedAcceptance,
  type SignedOffer,
} from "@arena/sdk";

export type HostOptions = {
  fetch?: typeof fetch;
  log?: (line: string) => void;
  minBackoffMs?: number;
  maxBackoffMs?: number;
};

export type HostConnection = {
  lobby: LobbyClient;
  relay: RelayClient;
  connected(): boolean;
  close(): void;
};

// Re-declared here rather than imported from the server (Tasks 4-5's ws.ts): the CLI must not depend on
// @arena/server. These must stay in sync with apps/server/src/ws.ts's ServerFrame/ClientFrame.
type ServerFrame =
  | { type: "hello"; nonce: Hex }
  | { type: "match"; event: unknown }
  | { type: "joined"; channelId: Hex }
  | { type: "relay"; message: unknown }
  | { type: "error"; error: string; channelId?: Hex };

type ClientFrame =
  | { type: "subscribe"; offerIds: Hex[] }
  | { type: "join"; channelId: Hex; params: Params; signer: Address; sig: Hex }
  | { type: "relay"; message: RelayMessage };

const SUBSCRIBE_CHUNK = 64;
const JOIN_TIMEOUT_MS = 10_000;
const DEFAULT_MIN_BACKOFF_MS = 250;
const DEFAULT_MAX_BACKOFF_MS = 10_000;

type JoinEntry = { params: Params; signer: RelaySigner };
type JoinWaiter = { resolve(): void; reject(err: Error): void };

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The CLI's two host transports (Plan 4 §7): an HTTP lobby client and a reconnecting WebSocket relay client, both
 * built over one persistent connection to `serverUrl`. Never sees a private key -- only a `RelaySigner` (I5).
 */
export function connectHost(serverUrl: string, opts: HostOptions = {}): HostConnection {
  const fetchFn = opts.fetch ?? fetch;
  const log = opts.log ?? (() => undefined);
  const minBackoffMs = opts.minBackoffMs ?? DEFAULT_MIN_BACKOFF_MS;
  const maxBackoffMs = opts.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
  const httpBase = serverUrl.replace(/\/$/, "");
  const wsUrl = serverUrl.replace(/^http/, "ws").replace(/\/$/, "") + "/ws";

  let ws: WebSocket | null = null;
  let nonce: Hex | null = null;
  let closed = false;
  let attempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

  const watched = new Set<Hex>();
  const joins = new Map<Hex, JoinEntry>();
  const joinedOnSocket = new Set<Hex>();
  const matchHandlers = new Set<(m: MatchEvent) => void>();
  const relayHandlers = new Set<(m: RelayMessage) => void>();
  const joinedHandlers = new Set<(id: Hex) => void>();
  const joinWaiters = new Map<Hex, JoinWaiter[]>();

  function safeCall<A extends unknown[]>(fn: (...args: A) => void, args: A, what: string): void {
    try {
      fn(...args);
    } catch (err) {
      log(`host: ${what} handler threw: ${errorText(err)}`);
    }
  }

  function sendFrame(frame: ClientFrame): void {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(toWire(frame));
  }

  function settleJoinWaiters(channelId: Hex, err?: Error): void {
    const waiters = joinWaiters.get(channelId);
    if (!waiters) return;
    joinWaiters.delete(channelId);
    for (const w of waiters) (err ? w.reject(err) : w.resolve());
  }

  async function sendJoin(channelId: Hex, entry: JoinEntry): Promise<void> {
    if (!nonce) return;
    const sig = await signRelayJoin(entry.signer, channelId, nonce);
    sendFrame({ type: "join", channelId, params: entry.params, signer: entry.signer.address, sig });
  }

  function onHello(n: Hex): void {
    nonce = n;
    attempt = 0;
    joinedOnSocket.clear();
    for (const ids of chunk([...watched], SUBSCRIBE_CHUNK)) sendFrame({ type: "subscribe", offerIds: ids });
    for (const [channelId, entry] of joins) {
      sendJoin(channelId, entry).catch((err: unknown) => {
        log(`host: resend of join ${channelId} failed: ${errorText(err)}`);
      });
    }
  }

  function onFrame(raw: unknown): void {
    if (typeof raw !== "object" || raw === null || typeof (raw as { type?: unknown }).type !== "string") {
      log("host: malformed frame dropped: not a frame object");
      return;
    }
    const frame = raw as ServerFrame & { [k: string]: unknown };
    switch (frame.type) {
      case "hello": {
        if (typeof frame.nonce !== "string") {
          log("host: malformed frame dropped: hello.nonce must be a string");
          return;
        }
        onHello(frame.nonce as Hex);
        return;
      }
      case "match": {
        try {
          const event = parseMatchEvent(frame.event);
          for (const h of matchHandlers) safeCall(h, [event], "onMatch");
        } catch (err) {
          log(`host: malformed frame dropped: ${errorText(err)}`);
        }
        return;
      }
      case "joined": {
        if (typeof frame.channelId !== "string") {
          log("host: malformed frame dropped: joined.channelId must be a string");
          return;
        }
        const id = frame.channelId as Hex;
        joinedOnSocket.add(id);
        settleJoinWaiters(id);
        for (const h of joinedHandlers) safeCall(h, [id], "onJoined");
        return;
      }
      case "relay": {
        try {
          const message = parseRelayMessage(frame.message);
          for (const h of relayHandlers) safeCall(h, [message], "onMessage");
        } catch (err) {
          log(`host: malformed frame dropped: ${errorText(err)}`);
        }
        return;
      }
      case "error": {
        const msg = typeof frame.error === "string" ? frame.error : "unknown error";
        log(`host: server error: ${msg}`);
        if (typeof frame.channelId === "string") settleJoinWaiters(frame.channelId as Hex, new Error(msg));
        return;
      }
      default:
        log(`host: malformed frame dropped: unknown frame type ${String((frame as { type?: unknown }).type)}`);
    }
  }

  function scheduleReconnect(): void {
    if (closed) return;
    const delay = Math.min(maxBackoffMs, minBackoffMs * 2 ** attempt) + Math.random() * minBackoffMs;
    attempt++;
    reconnectTimer = setTimeout(() => connect(), delay);
  }

  function connect(): void {
    if (closed) return;
    const socket = new WebSocket(wsUrl);
    ws = socket;
    socket.addEventListener("message", (e: MessageEvent) => {
      let parsed: unknown;
      try {
        parsed = decodeWire(String(e.data));
      } catch (err) {
        log(`host: malformed frame dropped: ${err instanceof WireFormatError ? err.message : errorText(err)}`);
        return;
      }
      onFrame(parsed);
    });
    socket.addEventListener("close", () => {
      nonce = null;
      joinedOnSocket.clear();
      scheduleReconnect();
    });
    socket.addEventListener("error", () => {
      // 'close' always follows; cleanup happens there.
    });
  }

  connect();

  const lobby: LobbyClient = {
    async postOffer(so: SignedOffer): Promise<Hex> {
      const res = await fetchFn(`${httpBase}/offers`, { method: "POST", body: toWire(so) });
      const body = decodeWire(await res.text()) as { offerId?: Hex; error?: string };
      if (res.status !== 201) throw new Error(body.error ?? `postOffer failed with status ${res.status}`);
      const id = body.offerId as Hex;
      lobby.watch([id]);
      return id;
    },
    async listOffers(): Promise<SignedOffer[]> {
      const res = await fetchFn(`${httpBase}/offers`);
      const decoded = decodeWire(await res.text());
      if (!Array.isArray(decoded)) return [];
      const out: SignedOffer[] = [];
      for (const entry of decoded) {
        try {
          out.push(parseSignedOffer(entry));
        } catch {
          // dropped: not a well-formed signed offer
        }
      }
      return out;
    },
    async accept(sa: SignedAcceptance): Promise<void> {
      const res = await fetchFn(`${httpBase}/offers/${sa.acceptance.offerId}/accept`, {
        method: "POST",
        body: toWire(sa),
      });
      const decoded = decodeWire(await res.text());
      if (res.status !== 200) {
        throw new Error((decoded as { error?: string }).error ?? `accept failed with status ${res.status}`);
      }
      const event = parseMatchEvent(decoded);
      setTimeout(() => {
        for (const h of matchHandlers) safeCall(h, [event], "onMatch");
      }, 0);
      lobby.watch([event.offerId]);
    },
    onMatch(handler: (m: MatchEvent) => void): () => void {
      matchHandlers.add(handler);
      return () => matchHandlers.delete(handler);
    },
    watch(offerIds: Hex[]): void {
      for (const id of offerIds) watched.add(id);
      if (nonce) for (const ids of chunk(offerIds, SUBSCRIBE_CHUNK)) sendFrame({ type: "subscribe", offerIds: ids });
    },
  };

  const relay: RelayClient = {
    async join(channelId: Hex, params: Params, signer: RelaySigner): Promise<void> {
      joins.set(channelId, { params, signer });
      if (!nonce || !ws || ws.readyState !== WebSocket.OPEN) return; // sent on the next hello
      await sendJoin(channelId, { params, signer });
      await new Promise<void>((resolve, reject) => {
        const list = joinWaiters.get(channelId) ?? [];
        const entry: JoinWaiter = {
          resolve: () => {
            clearTimeout(timer);
            resolve();
          },
          reject: (err) => {
            clearTimeout(timer);
            reject(err);
          },
        };
        const timer = setTimeout(() => {
          const still = joinWaiters.get(channelId);
          if (still) {
            const idx = still.indexOf(entry);
            if (idx >= 0) still.splice(idx, 1);
            if (still.length === 0) joinWaiters.delete(channelId);
          }
          reject(new Error(`timed out waiting to join ${channelId}`));
        }, JOIN_TIMEOUT_MS);
        list.push(entry);
        joinWaiters.set(channelId, list);
      });
    },
    async send(msg: RelayMessage): Promise<void> {
      if (!ws || ws.readyState !== WebSocket.OPEN || !joinedOnSocket.has(msg.channelId)) {
        throw new Error("relay not connected");
      }
      sendFrame({ type: "relay", message: msg });
    },
    onMessage(handler: (msg: RelayMessage) => void): () => void {
      relayHandlers.add(handler);
      return () => relayHandlers.delete(handler);
    },
    onJoined(handler: (channelId: Hex) => void): () => void {
      joinedHandlers.add(handler);
      return () => joinedHandlers.delete(handler);
    },
  };

  return {
    lobby,
    relay,
    connected(): boolean {
      return ws !== null && ws.readyState === WebSocket.OPEN && nonce !== null;
    },
    close(): void {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      ws?.close();
    },
  };
}
