import { randomBytes } from "node:crypto";
import type http from "node:http";
import type { Address, Hex } from "viem";
import { WebSocket as WsWebSocket, WebSocketServer } from "ws";
import { decodeWire, toWire, type MatchEvent, type Params, type RelayMessage } from "@arena/sdk";
import type { ServerConfig } from "./config.js";
import type { Lobby } from "./lobby.js";
import { clientKey, RateLimiter } from "./limits.js";
import type { Relay, RelayPeer } from "./relay.js";
import type { Metrics } from "./server.js";

// server -> client
export type ServerFrame =
  | { type: "hello"; nonce: Hex }
  | { type: "match"; event: MatchEvent }
  | { type: "joined"; channelId: Hex }
  | { type: "relay"; message: RelayMessage }
  | { type: "error"; error: string; channelId?: Hex };

// client -> server
export type ClientFrame =
  | { type: "subscribe"; offerIds: Hex[] }
  | { type: "unsubscribe"; offerIds: Hex[] }
  | { type: "join"; channelId: Hex; params: Params; signer: Address; sig: Hex }
  | { type: "leave"; channelId: Hex }
  | { type: "relay"; message: RelayMessage };

const OFFER_ID_RE = /^0x[0-9a-f]{64}$/i;
const HEARTBEAT_MS = 30_000;
const RATE_LIMIT_KEY = "f";

type ConnState = {
  nonce: Hex;
  watched: Set<Hex>;
  peer: RelayPeer;
  limiter: RateLimiter;
  alive: boolean;
  /** Serializes this connection's frame handling. `ws` can emit several "message" events synchronously from one
   *  underlying read, and `relay.join`/`relay.forward` await async signature recovery -- without this, a later
   *  frame's (synchronous) handling can finish before an earlier one's (async) handling does, reordering what the
   *  other side sees. Every frame is chained onto this so they resolve in the order they arrived. */
  chain: Promise<void>;
};

export function attachWs(
  httpServer: http.Server,
  deps: { lobby: Lobby; relay: Relay | null; cfg: ServerConfig; metrics: Metrics; log: (l: string) => void },
): { close(): Promise<void>; dropAll(): void; count(): number } {
  const { lobby, relay, cfg, metrics, log } = deps;
  const wss = new WebSocketServer({ noServer: true, maxPayload: cfg.limits.maxFrameBytes });
  const states = new Map<WsWebSocket, ConnState>();
  const perIp = new Map<string, number>();

  function ipCount(ip: string): number {
    return perIp.get(ip) ?? 0;
  }
  function incIp(ip: string): void {
    perIp.set(ip, ipCount(ip) + 1);
  }
  function decIp(ip: string): void {
    const n = ipCount(ip) - 1;
    if (n <= 0) perIp.delete(ip);
    else perIp.set(ip, n);
  }

  function send(ws: WsWebSocket, frame: ServerFrame): void {
    if (ws.readyState === WsWebSocket.OPEN) ws.send(toWire(frame));
  }

  /** Logs an unexpected exception/rejection from a frame's handling (`relay.join`/`relay.forward` normally
   *  resolve on their own, sending their own `error` frame on refusal, so this is a genuine bug or I/O failure)
   *  and tells the client something went wrong. */
  function onFrameFailure(ws: WsWebSocket, err: unknown): void {
    log(JSON.stringify({ ts: new Date().toISOString(), level: "error", msg: "ws frame failed", error: String(err) }));
    send(ws, { type: "error", error: "internal" });
  }

  /** The frame's offer ids, lower-cased, or `null` (after sending an `error`) if any of them is malformed. */
  function offerIdsOf(ws: WsWebSocket, offerIds: unknown): Hex[] | null {
    if (!Array.isArray(offerIds) || !offerIds.every((x) => typeof x === "string")) {
      send(ws, { type: "error", error: "malformed frame: offerIds must be a list of strings" });
      return null;
    }
    for (const raw of offerIds) {
      if (!OFFER_ID_RE.test(raw)) {
        send(ws, { type: "error", error: "malformed frame: bad offer id" });
        return null; // none of this frame's ids are taken
      }
    }
    return (offerIds as string[]).map((raw) => raw.toLowerCase() as Hex);
  }

  function handleSubscribe(ws: WsWebSocket, state: ConnState, offerIds: unknown): void {
    const ids = offerIdsOf(ws, offerIds);
    if (!ids) return;
    // ids are accepted case-insensitively and normalized to canonical lower-case (offerIdsOf)
    for (const id of ids) {
      if (state.watched.has(id)) continue;
      if (state.watched.size >= cfg.limits.maxWatchedOffers) {
        send(ws, { type: "error", error: "too many watched offers" });
        break;
      }
      state.watched.add(id);
      const m = lobby.matchFor(id);
      if (m) send(ws, { type: "match", event: m }); // replay: this connection missed the push
    }
  }

  function handleUnsubscribe(ws: WsWebSocket, state: ConnState, offerIds: unknown): void {
    const ids = offerIdsOf(ws, offerIds);
    if (!ids) return;
    for (const id of ids) state.watched.delete(id);
  }

  async function handleFrame(ws: WsWebSocket, state: ConnState, raw: unknown): Promise<void> {
    if (typeof raw !== "object" || raw === null || typeof (raw as { type?: unknown }).type !== "string") {
      send(ws, { type: "error", error: "malformed frame" });
      return;
    }
    const frame = raw as { type: string; [k: string]: unknown };
    if (frame.type === "subscribe") {
      handleSubscribe(ws, state, frame.offerIds);
      return;
    }
    if (frame.type === "unsubscribe") {
      handleUnsubscribe(ws, state, frame.offerIds);
      return;
    }
    if (frame.type === "join") {
      if (relay === null) {
        send(ws, { type: "error", error: "relay unavailable" });
        return;
      }
      type JoinFrame = { channelId: unknown; params: unknown; signer: unknown; sig: unknown };
      await relay.join(state.peer, frame as unknown as JoinFrame);
      return;
    }
    if (frame.type === "leave") {
      if (relay === null) {
        send(ws, { type: "error", error: "relay unavailable" });
        return;
      }
      relay.leaveChannel(state.peer, frame.channelId);
      return;
    }
    if (frame.type === "relay") {
      if (relay === null) {
        send(ws, { type: "error", error: "relay unavailable" });
        return;
      }
      await relay.forward(state.peer, frame.message);
      return;
    }
    send(ws, { type: "error", error: "malformed frame" });
  }

  httpServer.on("upgrade", (req, rawSocket, head) => {
    const socket = rawSocket as import("node:net").Socket;
    const url = new URL(req.url ?? "/", "http://internal");
    if (url.pathname !== "/ws") {
      socket.destroy();
      return;
    }
    const ip = clientKey(req, cfg.trustProxy);
    if (ipCount(ip) >= cfg.limits.wsPerIp) {
      socket.end("HTTP/1.1 429 Too Many Requests\r\n\r\n");
      return;
    }
    incIp(ip);
    let decremented = false;
    socket.once("close", () => {
      if (!decremented) {
        decremented = true;
        decIp(ip);
      }
    });
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", (ws: WsWebSocket) => {
    const nonce = `0x${randomBytes(32).toString("hex")}` as Hex;
    const peer: RelayPeer = { send: (frame) => send(ws, frame), joined: new Map(), nonce, closed: false };
    const state: ConnState = {
      nonce,
      watched: new Set(),
      peer,
      limiter: new RateLimiter(cfg.limits.wsFrameBurst, cfg.limits.wsFramePerSec),
      alive: true,
      chain: Promise.resolve(),
    };
    states.set(ws, state);
    metrics.wsConnections = states.size;
    send(ws, { type: "hello", nonce });

    ws.on("pong", () => {
      state.alive = true;
    });

    ws.on("message", (data) => {
      if (ws.readyState !== WsWebSocket.OPEN) return;
      if (!state.limiter.take(RATE_LIMIT_KEY)) {
        ws.close(1008, "rate limited");
        return;
      }
      let frame: unknown;
      try {
        frame = decodeWire(String(data));
      } catch {
        send(ws, { type: "error", error: "malformed frame" });
        return;
      }
      // chained onto the connection's existing queue, not run immediately: see `ConnState.chain`.
      state.chain = state.chain.then(() => handleFrame(ws, state, frame)).catch((err: unknown) => {
        onFrameFailure(ws, err);
      });
    });

    ws.on("close", () => {
      relay?.leave(state.peer);
      states.delete(ws);
      metrics.wsConnections = states.size;
    });

    ws.on("error", () => {
      // 'close' still follows; state cleanup happens there.
    });
  });

  const unsubscribe = lobby.onMatch((event) => {
    for (const [ws, state] of states) {
      if (state.watched.has(event.offerId)) send(ws, { type: "match", event });
    }
  });

  const heartbeat = setInterval(() => {
    for (const [ws, state] of states) {
      if (!state.alive) {
        ws.terminate();
        continue;
      }
      state.alive = false;
      ws.ping();
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();

  return {
    async close(): Promise<void> {
      clearInterval(heartbeat);
      unsubscribe();
      for (const ws of states.keys()) ws.terminate();
      states.clear();
      metrics.wsConnections = 0;
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
    dropAll(): void {
      for (const ws of states.keys()) ws.terminate();
    },
    count(): number {
      return states.size;
    },
  };
}
