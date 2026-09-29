/**
 * Plan 4.5 Task 9: a malicious relay/host, as a man-in-the-middle proxy between `arena daemon` processes and the real
 * host server. A daemon whose `serverUrl` points here gets every HTTP route (`/templates`, `/offers`, `/offers/:id/
 * accept`, ...) and its one `/ws` connection forwarded to the real server -- through tamper hooks that see every parsed
 * frame and every HTTP response and may pass, modify, drop, duplicate, delay or inject.
 *
 * Only what a real network attacker (or a malicious host operator) controls is tampered: the bytes between the
 * daemon and the server. The daemon's RPC is never proxied -- the chain is the ground truth every test asserts on.
 */
import http from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { decodeWire, toWire } from "@arena/sdk";

/** `down`: server -> daemon. `up`: daemon -> server. */
export type Dir = "down" | "up";

/** One proxied `/ws` connection (one daemon connection, and its own upstream connection to the server). */
export type WsConn = {
  readonly id: number;
  /** Every frame seen on this connection before any hook ran, per direction, in arrival order (for replays). */
  readonly seen: Record<Dir, unknown[]>;
  /** Sends `frame` (toWire-encoded) straight to the daemon (`down`) or the server (`up`), bypassing the hooks. */
  inject(frame: unknown, dir?: Dir): void;
  /** Drops both sides of this connection at once: the daemon sees a closed socket and reconnects through the proxy. */
  kill(): void;
  readonly closed: boolean;
};

/**
 * What a WS hook returns for one frame:
 * - `undefined`: pass it through unchanged;
 * - `{ send: [] }`: drop it;
 * - `{ send: [f] }`: forward `f` instead (modify);
 * - `{ send: [f, f] }`: duplicate; `{ send: [f, extra, ...] }`: forward `f` and inject `extra`s after it;
 * - `delayMs`: forward whatever `send` holds (or the original frame) that much later, without holding up the frames
 *   behind it -- so a delay reorders.
 */
export type WsVerdict = { send?: unknown[]; delayMs?: number } | undefined | void;

/** What an HTTP hook sees: the forwarded request and the real server's response, body decoded (toWire JSON) when it
 *  decodes. Returning a value replaces the response body with it (re-encoded with toWire); `undefined` passes. */
export type HttpCtx = { method: string; path: string; status: number; body: unknown };

export type MitmHooks = {
  ws?: (frame: any, ctx: { dir: Dir; conn: WsConn }) => WsVerdict | Promise<WsVerdict>;
  http?: (ctx: HttpCtx) => unknown | Promise<unknown>;
};

export type MitmStats = {
  wsConnections: number;
  frames: Record<Dir, number>;
  modified: number;
  dropped: number;
  duplicated: number;
  injected: number;
  delayed: number;
  /** Frames delivered after a frame that arrived later on the same connection and direction (i.e. overtaken). */
  reordered: number;
  killed: number;
  httpRequests: number;
  httpRewritten: number;
};

export type Mitm = {
  /** The proxy's base URL: pass it as a daemon's `--server`. */
  url: string;
  setHooks(h: MitmHooks): void;
  stats: MitmStats;
  /** Every proxied WS connection so far, oldest first (killed ones included; check `closed`). */
  connections: WsConn[];
  stop(): Promise<void>;
};

function decode(raw: string): { frame: unknown; ok: boolean } {
  try {
    return { frame: decodeWire(raw), ok: true };
  } catch {
    return { frame: raw, ok: false };
  }
}

const encode = (frame: unknown, ok = true): string => (ok ? toWire(frame) : String(frame));

// Hop-by-hop headers (RFC 9110 §7.6.1) plus the ones fetch recomputes itself; never copied across the proxy.
const HOP_HEADERS = new Set(["connection", "keep-alive", "transfer-encoding", "upgrade", "host", "content-length", "content-encoding"]);

export async function startMitm(targetUrl: string, hooks: MitmHooks = {}): Promise<Mitm> {
  const target = targetUrl.replace(/\/$/, "");
  const targetWs = target.replace(/^http/, "ws");
  let current: MitmHooks = hooks;
  const stats: MitmStats = {
    wsConnections: 0,
    frames: { down: 0, up: 0 },
    modified: 0,
    dropped: 0,
    duplicated: 0,
    injected: 0,
    delayed: 0,
    reordered: 0,
    killed: 0,
    httpRequests: 0,
    httpRewritten: 0,
  };
  const connections: WsConn[] = [];
  const sockets = new Set<Socket>();
  const timers = new Set<NodeJS.Timeout>();
  let nextId = 1;

  // ------------------------------------------------------------------------------------------------------- HTTP

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      void (async () => {
        stats.httpRequests++;
        const method = req.method ?? "GET";
        const path = req.url ?? "/";
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(req.headers)) {
          if (!HOP_HEADERS.has(k) && typeof v === "string") headers[k] = v;
        }
        try {
          const upstream = await fetch(`${target}${path}`, {
            method,
            headers,
            body: method === "GET" || method === "HEAD" ? undefined : Buffer.concat(chunks),
          });
          let text = await upstream.text();
          const hook = current.http;
          if (hook) {
            const { frame: body, ok } = decode(text);
            const replaced = await hook({ method, path: path.split("?")[0], status: upstream.status, body: ok ? body : text });
            if (replaced !== undefined) {
              text = typeof replaced === "string" ? replaced : toWire(replaced);
              stats.httpRewritten++;
            }
          }
          const out: Record<string, string> = {};
          upstream.headers.forEach((v, k) => {
            if (!HOP_HEADERS.has(k)) out[k] = v;
          });
          out["content-length"] = String(Buffer.byteLength(text));
          res.writeHead(upstream.status, out);
          res.end(text);
        } catch (err) {
          res.writeHead(502, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: `mitm: upstream failed: ${String(err)}` }));
        }
      })();
    });
  });
  server.on("connection", (s: Socket) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });

  // --------------------------------------------------------------------------------------------------------- WS

  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    if (new URL(req.url ?? "/", "http://mitm").pathname !== "/ws") {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket as Socket, head, (down) => onConnection(down));
  });

  function onConnection(down: WebSocket): void {
    stats.wsConnections++;
    const up = new WebSocket(`${targetWs}/ws`);
    const pendingUp: string[] = []; // daemon frames that arrived before the upstream socket opened
    const chains: Record<Dir, Promise<void>> = { down: Promise.resolve(), up: Promise.resolve() };
    const arrived: Record<Dir, number> = { down: 0, up: 0 };
    const lastDelivered: Record<Dir, number> = { down: 0, up: 0 };
    let closed = false;

    const rawSend = (dir: Dir, data: string) => {
      if (closed) return;
      if (dir === "down") {
        if (down.readyState === WebSocket.OPEN) down.send(data);
      } else if (up.readyState === WebSocket.OPEN) {
        up.send(data);
      } else if (up.readyState === WebSocket.CONNECTING) {
        pendingUp.push(data);
      }
    };

    const conn: WsConn = {
      id: nextId++,
      seen: { down: [], up: [] },
      inject(frame: unknown, dir: Dir = "down") {
        stats.injected++;
        rawSend(dir, toWire(frame));
      },
      kill() {
        if (closed) return;
        stats.killed++;
        shutdown();
      },
      get closed() {
        return closed;
      },
    };
    connections.push(conn);

    function shutdown(): void {
      if (closed) return;
      closed = true;
      down.terminate();
      up.terminate();
    }

    async function handle(dir: Dir, data: RawData): Promise<void> {
      stats.frames[dir]++;
      const seq = ++arrived[dir];
      const raw = data.toString();
      const { frame, ok } = decode(raw);
      conn.seen[dir].push(frame);
      const hook = current.ws;
      const verdict = hook && ok ? await hook(frame, { dir, conn }) : undefined;
      if (!verdict) {
        lastDelivered[dir] = seq;
        rawSend(dir, raw);
        return;
      }
      const out = verdict.send ?? [frame];
      const original = encode(frame, ok);
      if (out.length === 0) stats.dropped++;
      out.forEach((f, i) => {
        const text = encode(f);
        if (i === 0 && text !== original) stats.modified++;
        if (i > 0) {
          if (text === original) stats.duplicated++;
          else stats.injected++;
        }
      });
      const deliver = () => {
        if (seq < lastDelivered[dir]) stats.reordered++;
        else lastDelivered[dir] = seq;
        for (const f of out) rawSend(dir, encode(f));
      };
      if (verdict.delayMs && verdict.delayMs > 0 && out.length > 0) {
        stats.delayed++;
        const t = setTimeout(() => {
          timers.delete(t);
          deliver();
        }, verdict.delayMs);
        timers.add(t);
      } else {
        deliver();
      }
    }

    // Frames in one direction go through the hooks strictly in arrival order (as the real server serializes them);
    // only an explicit `delayMs` lets a frame fall behind the ones after it.
    const enqueue = (dir: Dir, data: RawData) => {
      chains[dir] = chains[dir].then(() => handle(dir, data)).catch(() => undefined);
    };

    up.on("open", () => {
      for (const d of pendingUp.splice(0)) up.send(d);
    });
    up.on("message", (data) => enqueue("down", data));
    down.on("message", (data) => enqueue("up", data));
    up.on("close", shutdown);
    down.on("close", shutdown);
    up.on("error", shutdown);
    down.on("error", shutdown);
  }

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    setHooks(h: MitmHooks) {
      current = h;
    },
    stats,
    connections,
    async stop() {
      for (const t of timers) clearTimeout(t);
      for (const c of connections) c.kill();
      wss.close();
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
