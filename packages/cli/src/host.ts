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
  /** How long a connection must stay up past `hello` before the reconnect backoff resets (default 30 s). */
  stableAfterMs?: number;
  /** With no frame at all from the server for this long (it pings every 25 s), the connection is treated as dead
   *  and replaced (default 70 s). */
  idleTimeoutMs?: number;
};

/**
 * Plan 5.7 (spec §2): the host relay plus its up-signal, which `FallbackRelay` (xmtp/fallback.ts) reads to decide
 * where a message goes. `isJoined(id)` is true exactly while `send` for that channel would go out: the socket is
 * open and the server has confirmed the channel's join on it. `onLinkChange` fires after every change to that
 * condition (a `joined` frame, a new `hello`, the socket closing or being abandoned, a `leave`).
 */
export type HostRelay = RelayClient & { isJoined(channelId: Hex): boolean; onLinkChange(handler: () => void): () => void };

export type HostConnection = {
  lobby: LobbyClient;
  relay: HostRelay;
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
  | { type: "error"; error: string; channelId?: Hex }
  | { type: "ping" };

type ClientFrame =
  | { type: "subscribe"; offerIds: Hex[] }
  | { type: "unsubscribe"; offerIds: Hex[] }
  | { type: "join"; channelId: Hex; params: Params; signer: Address; sig: Hex }
  | { type: "leave"; channelId: Hex }
  | { type: "relay"; message: RelayMessage };

const SUBSCRIBE_CHUNK = 64;
const JOIN_TIMEOUT_MS = 10_000;
const DEFAULT_MIN_BACKOFF_MS = 250;
const DEFAULT_MAX_BACKOFF_MS = 10_000;
const DEFAULT_STABLE_AFTER_MS = 30_000;
const DEFAULT_IDLE_TIMEOUT_MS = 70_000;
// Re-joins after a reconnect go out at most 10 per second: half the server's default sustained frame rate (20/s),
// since each confirmed join makes the daemon re-send its own state, proposal and Close on the same connection.
const REJOIN_INTERVAL_MS = 100;
const CAPACITY_REFUSAL_PREFIX = "too many channels on this connection";

/**
 * Error-frame message prefixes (relay.ts's `join`) that mean a join is refused for good: the same channelId,
 * params and signer would be refused again by any server holding this same on-chain state, so it must not stay
 * registered for retry. Every other join refusal -- a per-connection capacity limit ("too many channels on this
 * connection"), a server-side hiccup ("internal", "relay unavailable"), a client-side timeout with no error
 * frame at all, "unknown channel" (the host may learn of the channel later, e.g. once its indexer sees it
 * created on-chain), or any other message this ruling did not name (e.g. "malformed join frame") -- leaves the
 * channel registered and it is retried on the next `hello` instead.
 */
export const PERMANENT_JOIN_REFUSAL_PREFIXES = [
  "params do not match",
  "not a member of this channel",
  "bad join signature",
] as const;

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

/** Turns a non-OK HTTP response body into an error message: the server's `{error}` field when the body decodes
 *  that way, otherwise the status plus a bounded snippet of the raw body, so a non-JSON error page or a proxy's
 *  own error text is still visible instead of being swallowed. */
function errorFromBody(text: string, status: number): string {
  try {
    const decoded = decodeWire(text) as { error?: unknown } | null;
    if (decoded && typeof decoded === "object" && typeof decoded.error === "string") return decoded.error;
  } catch {
    // not decodable as wire JSON -- fall through to a status-plus-snippet message
  }
  const snippet = text.length > 200 ? `${text.slice(0, 200)}…` : text;
  return snippet ? `request failed with status ${status}: ${snippet}` : `request failed with status ${status}`;
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
  const stableAfterMs = opts.stableAfterMs ?? DEFAULT_STABLE_AFTER_MS;
  const idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const httpBase = serverUrl.replace(/\/$/, "");
  const wsUrl = serverUrl.replace(/^http/, "ws").replace(/\/$/, "") + "/ws";

  let ws: WebSocket | null = null;
  let nonce: Hex | null = null;
  let closed = false;
  let attempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let stableTimer: ReturnType<typeof setTimeout> | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  /** The socket whose re-join loop must stop: the server refused a join there for lack of channel slots, so the
   *  rest would be refused too. They stay registered and go out on the next `hello`. */
  let rejoinFullOn: WebSocket | null = null;

  const watched = new Set<Hex>();
  const joins = new Map<Hex, JoinEntry>();
  const joinedOnSocket = new Set<Hex>();
  const matchHandlers = new Set<(m: MatchEvent) => void>();
  const relayHandlers = new Set<(m: RelayMessage) => void>();
  const joinedHandlers = new Set<(id: Hex) => void>();
  const watchRefusedHandlers = new Set<(message: string) => void>();
  const linkHandlers = new Set<() => void>();
  const joinWaiters = new Map<Hex, JoinWaiter[]>();

  function safeCall<A extends unknown[]>(fn: (...args: A) => void, args: A, what: string): void {
    try {
      fn(...args);
    } catch (err) {
      log(`host: ${what} handler threw: ${errorText(err)}`);
    }
  }

  /** Plan 5.7: tells `onLinkChange` subscribers that some channel's `isJoined` may have changed. */
  function linkChanged(): void {
    for (const h of linkHandlers) safeCall(h, [], "onLinkChange");
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

  /** Signs and sends a join frame -- but only if the connection is still the one we started signing on: signing
   *  is async (it calls out to the signer), and the socket can close/reconnect (a new socket, a new nonce) while
   *  it's in flight. Sending a join signed over a stale nonce, on a socket that's no longer current, would be
   *  silently refused or misattributed by the server -- so on any change, this is a no-op and the join is left
   *  registered in `joins` to be (re-)sent on the next `hello` instead. */
  async function sendJoin(channelId: Hex, entry: JoinEntry): Promise<void> {
    const socketAtStart = ws;
    const nonceAtStart = nonce;
    if (!nonceAtStart || !socketAtStart) return;
    const sig = await signRelayJoin(entry.signer, channelId, nonceAtStart);
    if (ws !== socketAtStart || nonce !== nonceAtStart) return; // the connection moved on while we were signing
    sendFrame({ type: "join", channelId, params: entry.params, signer: entry.signer.address, sig });
  }

  /** Re-sends every registered join on the connection that just said `hello`, paced (`REJOIN_INTERVAL_MS`) so a
   *  daemon with many channels never bursts past the server's frame limit. Stops as soon as that connection is
   *  gone, or has refused a join for lack of channel slots; the next `hello` starts over. */
  async function rejoinAll(socket: WebSocket, n: Hex): Promise<void> {
    for (const [channelId, entry] of [...joins]) {
      if (closed || ws !== socket || nonce !== n || rejoinFullOn === socket) return;
      if (joins.get(channelId) !== entry) continue; // left (or re-registered) while this loop was running
      try {
        await sendJoin(channelId, entry);
      } catch (err) {
        log(`host: resend of join ${channelId} failed: ${errorText(err)}`);
      }
      await new Promise((r) => setTimeout(r, REJOIN_INTERVAL_MS));
    }
  }

  function onHello(n: Hex): void {
    nonce = n;
    joinedOnSocket.clear();
    linkChanged();
    // Only a connection that stays up resets the backoff: a server that accepts and then drops us right away
    // (rate limit, overload) must keep seeing a growing delay, not a reconnect at minimum backoff forever.
    clearTimeout(stableTimer);
    stableTimer = setTimeout(() => {
      attempt = 0;
    }, stableAfterMs);
    for (const ids of chunk([...watched], SUBSCRIBE_CHUNK)) sendFrame({ type: "subscribe", offerIds: ids });
    if (ws) void rejoinAll(ws, n);
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
        linkChanged();
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
      case "ping":
        return; // only there to reset the idle watchdog, which every frame does
      case "error": {
        const msg = typeof frame.error === "string" ? frame.error : "unknown error";
        const channelId = typeof frame.channelId === "string" ? (frame.channelId as Hex) : undefined;
        // Not yet confirmed joined on this socket, but registered for (re-)join: this error is almost certainly
        // the server refusing that join, not a later forward failure on an already-joined channel. A channel
        // that *is* joined always keeps its entry: an unrelated forward error (bad signature, wrong sender, ...)
        // must not deregister a good join. Among join refusals, only a *permanent* one (PERMANENT_JOIN_REFUSAL_
        // PREFIXES) drops the channel from the re-join set; every other refusal stays registered and is retried
        // on the next `hello`.
        if (channelId && joins.has(channelId) && !joinedOnSocket.has(channelId)) {
          if (PERMANENT_JOIN_REFUSAL_PREFIXES.some((prefix) => msg.startsWith(prefix))) {
            joins.delete(channelId);
            log(`host: join to ${channelId} refused permanently, not retrying: ${msg}`);
          } else {
            if (msg.startsWith(CAPACITY_REFUSAL_PREFIX)) rejoinFullOn = ws;
            log(`host: join to ${channelId} refused, will retry on the next hello: ${msg}`);
          }
        } else {
          log(`host: server error: ${msg}`);
          // A subscribe-level refusal (no channelId): the offer id(s) in that frame are not being watched, so
          // any match on them will be missed until this is resolved (Plan 4.5 Task 11 fix round -- see
          // onWatchRefused's docstring). Watched by message rather than by frame type, since the server's error
          // frame carries no other structure to key on.
          if (msg.includes("too many watched offers")) {
            for (const h of watchRefusedHandlers) safeCall(h, [msg], "onWatchRefused");
          }
        }
        if (channelId) settleJoinWaiters(channelId, new Error(msg));
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
    log(`host: reconnecting in ${Math.round(delay)} ms`);
    reconnectTimer = setTimeout(() => connect(), delay);
  }

  /** Forgets `socket` and reconnects at once: the close handshake on a half-open connection may never finish, so
   *  its eventual `close` event is ignored rather than waited for. */
  function abandon(socket: WebSocket): void {
    if (ws !== socket) return;
    log(`host: no frame from the server for ${idleTimeoutMs} ms, reconnecting`);
    ws = null;
    clearTimeout(stableTimer);
    nonce = null;
    joinedOnSocket.clear();
    linkChanged();
    try {
      socket.close();
    } catch {
      // already closing
    }
    scheduleReconnect();
  }

  function armWatchdog(socket: WebSocket): void {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => abandon(socket), idleTimeoutMs);
  }

  function connect(): void {
    if (closed) return;
    const socket = new WebSocket(wsUrl);
    ws = socket;
    armWatchdog(socket);
    socket.addEventListener("message", (e: MessageEvent) => {
      if (ws !== socket) return; // abandoned
      armWatchdog(socket);
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
      if (ws !== socket) return; // abandoned: already replaced
      clearTimeout(idleTimer);
      clearTimeout(stableTimer);
      nonce = null;
      joinedOnSocket.clear();
      linkChanged();
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
      const text = await res.text();
      if (!res.ok) throw new Error(errorFromBody(text, res.status));
      const body = decodeWire(text) as { offerId?: Hex };
      const id = body.offerId as Hex;
      lobby.watch([id]);
      return id;
    },
    async listOffers(): Promise<SignedOffer[]> {
      const res = await fetchFn(`${httpBase}/offers`);
      const text = await res.text();
      if (!res.ok) throw new Error(errorFromBody(text, res.status));
      const decoded = decodeWire(text);
      if (!Array.isArray(decoded)) throw new Error("listOffers: server response was not an array");
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
      const text = await res.text();
      if (!res.ok) throw new Error(errorFromBody(text, res.status));
      const event = parseMatchEvent(decodeWire(text));
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
    unwatch(offerIds: Hex[]): void {
      const dropped = offerIds.filter((id) => watched.delete(id));
      if (nonce && dropped.length > 0) {
        for (const ids of chunk(dropped, SUBSCRIBE_CHUNK)) sendFrame({ type: "unsubscribe", offerIds: ids });
      }
    },
    onWatchRefused(handler: (message: string) => void): () => void {
      watchRefusedHandlers.add(handler);
      return () => watchRefusedHandlers.delete(handler);
    },
  };

  const relay: HostRelay = {
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
    leave(channelId: Hex): void {
      const registered = joins.delete(channelId);
      const wasJoined = joinedOnSocket.delete(channelId);
      settleJoinWaiters(channelId, new Error(`left ${channelId}`));
      if (registered && nonce) sendFrame({ type: "leave", channelId });
      if (wasJoined) linkChanged();
    },
    isJoined(channelId: Hex): boolean {
      // Exactly the negation of `send`'s "relay not connected" condition.
      return ws !== null && ws.readyState === WebSocket.OPEN && joinedOnSocket.has(channelId);
    },
    onLinkChange(handler: () => void): () => void {
      linkHandlers.add(handler);
      return () => linkHandlers.delete(handler);
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
      clearTimeout(stableTimer);
      clearTimeout(idleTimer);
      // Reject any join() calls still waiting on a `joined`/`error` frame that will now never arrive; each
      // waiter's own reject closure clears its timeout, so no timer is left running past close().
      for (const channelId of [...joinWaiters.keys()]) settleJoinWaiters(channelId, new Error("host closed"));
      ws?.close();
    },
  };
}
