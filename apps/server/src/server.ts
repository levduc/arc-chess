import http from "node:http";
import type { AddressInfo } from "node:net";
import { decodeWire, toWire, WireFormatError } from "@arena/sdk";
import type { ServerConfig } from "./config.js";
import { RpcChainReader, type ChainReader } from "./chain.js";
import { RateLimiter } from "./limits.js";
import { chessSkillMd, indexHtml, llmsTxt, skillMd } from "./docs.js";
import { Lobby, LobbyError } from "./lobby.js";
import { Relay } from "./relay.js";
import { SqliteRepo, type Repo } from "./repo.js";
import { attachWs } from "./ws.js";

export type Metrics = {
  wsConnections: number;
  relayMessages: number;
  indexerBlock: bigint | null;
  indexerLag: bigint | null;
};

export type ServerDeps = { chain?: ChainReader; log?: (line: string) => void };

export type ArenaServer = {
  url: string;
  port: number;
  config: ServerConfig;
  repo: Repo;
  dropConnections(): void; // closes every WebSocket (tests: simulate a relay outage)
  close(): Promise<void>;
};

/** Everything a route handler needs. A handler returns true once it has written a response, ending the chain. */
type Ctx = {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  url: URL;
  method: string;
  ip: string;
};

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = toWire(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(text);
}

function decStr(n: bigint): string {
  return n.toString();
}

/** Thrown by `readBody` once the request exceeds the cap; the route handler turns it into a 413. */
class BodyTooLargeError extends Error {}

const MAX_BODY_BYTES = 64 * 1024;
// once a body is rejected as too large, we still drain it (so the connection can flush the 413 and close cleanly
// instead of the client seeing a raw reset) -- but only up to this much more. A client that keeps streaming past
// this hard backstop gets its socket destroyed outright; draining is a courtesy, not an obligation.
const MAX_DRAIN_BYTES = 1024 * 1024;

/** Reads the whole request body as text, refusing (413) anything over `maxBytes` -- by content-length up front,
 *  and by actual bytes received in case content-length is missing or lied about. Either way, once rejected, the
 *  amount of additional data this will tolerate reading is capped at `MAX_DRAIN_BYTES`. */
function readBody(req: http.IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let rejected = false;
    let drained = 0;

    function rejectOversized(): void {
      if (rejected) return;
      rejected = true;
      reject(new BodyTooLargeError());
      req.removeAllListeners("data");
      req.on("data", (chunk: Buffer) => {
        drained += chunk.length;
        if (drained > MAX_DRAIN_BYTES) req.destroy();
      });
      req.resume();
    }

    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > maxBytes) {
      rejectOversized();
      return;
    }

    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        rejectOversized();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** Runs a lobby route body, mapping its failure modes to the ruled-on HTTP status. Anything else propagates to
 *  `handle`'s catch-all (500). */
async function withLobbyErrors(res: http.ServerResponse, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      // don't offer keep-alive on a connection that just tried to push an oversized body through it
      res.setHeader("connection", "close");
      sendJson(res, 413, { error: "body too large" });
    } else if (err instanceof WireFormatError) {
      sendJson(res, 400, { error: err.message });
    } else if (err instanceof LobbyError) {
      sendJson(res, err.status, { error: err.message });
    } else {
      throw err;
    }
  }
}

function templateEntry(cfg: ServerConfig, url: string) {
  return {
    id: "chess",
    version: "1",
    chainId: cfg.chainId,
    rpcUrl: cfg.publicRpcUrl || cfg.rpcUrl,
    hub: cfg.hub,
    rules: cfg.rules,
    usdc: cfg.usdc,
    defaults: {
      deposit: decStr(cfg.defaults.deposit),
      stakePerGame: decStr(cfg.defaults.stakePerGame),
      challengeTimeout: decStr(cfg.defaults.challengeTimeout),
    },
    fundingWindow: decStr(cfg.fundingWindow),
    skillUrl: `${url}/templates/chess/skill.md`,
    audit: cfg.audit,
  };
}

/** Prometheus text exposition format (version=0.0.4). Gauges that have no value yet render NaN, a valid float. */
function renderMetrics(m: Metrics, offersOpen: number): string {
  const line = (name: string, help: string, type: "gauge" | "counter", value: string | number) =>
    `# HELP ${name} ${help}\n# TYPE ${name} ${type}\n${name} ${value}\n`;
  return (
    line("arena_ws_connections", "Open WebSocket connections.", "gauge", m.wsConnections) +
    line("arena_relay_messages_total", "Relay messages forwarded.", "counter", m.relayMessages) +
    line("arena_offers_open", "Open (unmatched, unexpired) lobby offers.", "gauge", offersOpen) +
    line(
      "arena_indexer_block",
      "Last block the indexer has processed.",
      "gauge",
      m.indexerBlock === null ? "NaN" : m.indexerBlock.toString(),
    ) +
    line(
      "arena_indexer_lag_blocks",
      "Chain head minus the indexer's processed block.",
      "gauge",
      m.indexerLag === null ? "NaN" : m.indexerLag.toString(),
    )
  );
}

const MARKDOWN_ROUTES = ["/skill.md", "/llms.txt", "/templates/chess/skill.md"] as const;

export async function startServer(cfg: ServerConfig, deps: ServerDeps = {}): Promise<ArenaServer> {
  const repo = new SqliteRepo(cfg.dbPath);
  // shared by the lobby (Task 4) and, in later tasks, the indexer and relay
  const chain = deps.chain ?? new RpcChainReader(cfg);
  const log = deps.log ?? ((line: string) => console.log(line));

  const metrics: Metrics = { wsConnections: 0, relayMessages: 0, indexerBlock: null, indexerLag: null };

  const postLimiter = new RateLimiter(cfg.limits.httpPostBurst, cfg.limits.httpPostPerSec);
  const getLimiter = new RateLimiter(cfg.limits.httpGetBurst, cfg.limits.httpGetPerSec);

  const lobby = new Lobby(repo, chain, cfg);
  const relay = new Relay(repo, cfg, metrics, log);

  // filled once listen() resolves; route handlers close over this box rather than a value, so they always see it
  const self: { url: string } = { url: "" };

  const handlers: Array<(ctx: Ctx) => Promise<boolean>> = [
    async (ctx) => {
      if (ctx.method !== "GET" || ctx.url.pathname !== "/healthz") return false;
      sendJson(ctx.res, 200, { ok: true });
      return true;
    },
    async (ctx) => {
      if (ctx.method !== "GET" || ctx.url.pathname !== "/metrics") return false;
      const offersOpen = repo.openOfferTotal(await chain.now());
      ctx.res.writeHead(200, { "content-type": "text/plain; version=0.0.4" });
      ctx.res.end(renderMetrics(metrics, offersOpen));
      return true;
    },
    async (ctx) => {
      if (ctx.method !== "POST" || ctx.url.pathname !== "/offers") return false;
      await withLobbyErrors(ctx.res, async () => {
        const body = decodeWire(await readBody(ctx.req, MAX_BODY_BYTES));
        const result = await lobby.post(body, ctx.ip);
        sendJson(ctx.res, 201, result);
      });
      return true;
    },
    async (ctx) => {
      if (ctx.method !== "GET" || ctx.url.pathname !== "/offers") return false;
      sendJson(ctx.res, 200, await lobby.list());
      return true;
    },
    async (ctx) => {
      const match = /^\/offers\/([^/]+)\/accept$/.exec(ctx.url.pathname);
      if (ctx.method !== "POST" || !match) return false;
      await withLobbyErrors(ctx.res, async () => {
        const body = decodeWire(await readBody(ctx.req, MAX_BODY_BYTES));
        const event = await lobby.accept(match[1], body);
        sendJson(ctx.res, 200, event);
      });
      return true;
    },
    async (ctx) => {
      if (ctx.method !== "GET" || ctx.url.pathname !== "/templates") return false;
      sendJson(ctx.res, 200, [templateEntry(cfg, self.url)]);
      return true;
    },
    async (ctx) => {
      if (ctx.method !== "GET" || !(MARKDOWN_ROUTES as readonly string[]).includes(ctx.url.pathname)) return false;
      const body =
        ctx.url.pathname === "/skill.md"
          ? skillMd(cfg, self.url)
          : ctx.url.pathname === "/llms.txt"
            ? llmsTxt(cfg, self.url)
            : chessSkillMd(cfg, self.url);
      ctx.res.writeHead(200, { "content-type": "text/markdown; charset=utf-8" });
      ctx.res.end(body);
      return true;
    },
    async (ctx) => {
      if (ctx.method !== "GET" || ctx.url.pathname !== "/") return false;
      ctx.res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      ctx.res.end(indexHtml(repo.recentChannels(50)));
      return true;
    },
  ];

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const method = req.method ?? "GET";
      const ip = req.socket.remoteAddress ?? "?";
      const limiter = method === "POST" ? postLimiter : getLimiter;
      if (!limiter.take(ip)) {
        sendJson(res, 429, { error: "rate limited" });
        return;
      }
      const url = new URL(req.url ?? "/", "http://internal");
      const ctx: Ctx = { req, res, url, method, ip };
      for (const handler of handlers) {
        if (await handler(ctx)) return;
      }
      sendJson(res, 404, { error: "not found" });
    } catch (err) {
      log(JSON.stringify({ ts: new Date().toISOString(), level: "error", msg: "request failed", error: String(err) }));
      if (!res.headersSent) sendJson(res, 500, { error: "internal" });
    }
  }

  const httpServer = http.createServer((req, res) => void handle(req, res));
  // backstops against a slow/stalled client holding a connection open indefinitely (headers, then the whole request)
  httpServer.requestTimeout = 15_000;
  httpServer.headersTimeout = 10_000;
  const wsHandle = attachWs(httpServer, { lobby, relay, cfg, metrics, log });

  const pruneInterval = setInterval(() => {
    chain
      .now()
      .then((now) => repo.pruneOffers(now))
      .catch((err: unknown) => {
        log(JSON.stringify({ ts: new Date().toISOString(), level: "error", msg: "prune failed", error: String(err) }));
      });
  }, 10 * 60 * 1000);
  pruneInterval.unref();

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(cfg.port, cfg.host, () => resolve());
  });
  const port = (httpServer.address() as AddressInfo).port;
  self.url = cfg.publicUrl || `http://${cfg.host}:${port}`;

  return {
    url: self.url,
    port,
    config: cfg,
    repo,
    dropConnections() {
      wsHandle.dropAll();
    },
    async close() {
      clearInterval(pruneInterval);
      await wsHandle.close();
      httpServer.closeAllConnections();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      repo.close();
    },
  };
}
