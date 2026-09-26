import http from "node:http";
import type { AddressInfo } from "node:net";
import type { ServerConfig } from "./config.js";
import { RpcChainReader, type ChainReader } from "./chain.js";
import { RateLimiter } from "./limits.js";
import { chessSkillMd, indexHtml, llmsTxt, skillMd } from "./docs.js";
import { SqliteRepo, type Repo } from "./repo.js";

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
  dropConnections(): void; // closes every WebSocket (tests: simulate a relay outage); Task 4 fills this in
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
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(text);
}

function decStr(n: bigint): string {
  return n.toString();
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
  // not read by this task's routes yet; Tasks 4-6 (indexer, lobby, relay) consume it from this same closure
  const chain = deps.chain ?? new RpcChainReader(cfg);
  const log = deps.log ?? ((line: string) => console.log(line));

  const metrics: Metrics = { wsConnections: 0, relayMessages: 0, indexerBlock: null, indexerLag: null };

  const postLimiter = new RateLimiter(cfg.limits.httpPostBurst, cfg.limits.httpPostPerSec);
  const getLimiter = new RateLimiter(cfg.limits.httpGetBurst, cfg.limits.httpGetPerSec);

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
      ctx.res.writeHead(200, { "content-type": "text/plain; version=0.0.4" });
      ctx.res.end(renderMetrics(metrics, 0)); // Task 4 wires the real open-offer count into this call
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
      // no WebSocket server yet; Task 4 replaces this with one that closes every live connection
    },
    async close() {
      httpServer.closeAllConnections();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      repo.close();
    },
  };
}
