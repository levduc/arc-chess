import http from "node:http";
import type { AddressInfo } from "node:net";
import { getAddress, type Address, type Hex } from "viem";
import { channelId, decodeWire, fenOf, statusOf, toWire, WireFormatError } from "@arena/sdk";
import type { ServerConfig } from "./config.js";
import { fundFromFaucet, RpcChainReader, type ChainReader } from "./chain.js";
import { chessSkillMd, indexHtml, llmsTxt, skillMd, watchHtml } from "./docs.js";
import { Indexer, playerStats } from "./indexer.js";
import { clientKey, RateLimiter } from "./limits.js";
import { Lobby, LobbyError } from "./lobby.js";
import { Relay } from "./relay.js";
import { SqliteRepo, type Repo } from "./repo.js";
import { attachWs } from "./ws.js";

export type Metrics = {
  wsConnections: number;
  relayMessages: number;
  indexerBlock: bigint | null;
  indexerLag: bigint | null;
  /** H1 fix round 1: blocks whose dispute events the RPC refused to serve, even alone (`Indexer.skippedBlocks()`). */
  indexerSkippedBlocks?: number;
};

/** `wsPingMs` overrides the app-level `/ws` ping interval (25 s), for tests. */
export type ServerDeps = { chain?: ChainReader; log?: (line: string) => void; wsPingMs?: number };

export type ArenaServer = {
  url: string;
  port: number;
  config: ServerConfig;
  repo: Repo;
  indexer: Indexer;
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

/** Task 2 (spec §13): the current launch limits for /templates, as decimal strings and a boolean, or `null` if
 *  the chain read fails -- a host outage must not take down the whole route (the rest of the entry is still
 *  useful, and is otherwise all static config). */
async function templateLimits(chain: ChainReader): Promise<{
  maxDepositPerPlayer: string;
  maxCommittedEscrow: string;
  committedEscrow: string;
  paused: boolean;
} | null> {
  try {
    const l = await chain.limits();
    return {
      maxDepositPerPlayer: decStr(l.maxDepositPerPlayer),
      maxCommittedEscrow: decStr(l.maxCommittedEscrow),
      committedEscrow: decStr(l.committedEscrow),
      paused: l.paused,
    };
  } catch {
    return null;
  }
}

async function templateEntry(cfg: ServerConfig, url: string, chain: ChainReader, faucetEnabled: boolean) {
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
    limits: await templateLimits(chain),
    // Plan 5.5 Task 1 (Global Constraints): advertised only once the three-way guard has confirmed the faucet is
    // actually enabled -- `undefined` here is dropped by `toWire`'s JSON.stringify, so a disabled faucet leaves
    // no `faucet` key at all, not a null or false one a careless client might still act on.
    ...(faucetEnabled ? { faucet: `${url}/faucet` } : {}),
    // Plan 5.6 Task 4 (spec §3): the pinned CLI version, when this host configures one -- same undefined-key
    // omission as `faucet` above when it does not.
    ...(cfg.cli !== undefined ? { cli: cfg.cli } : {}),
    // Plan 5.7 Task 2 (spec §5): the XMTP fallback config, when this host publishes one -- same undefined-key
    // omission as `cli`/`faucet` above when it does not. `init` copies this into the daemon's `config.json`.
    ...(cfg.xmtp !== undefined ? { xmtp: cfg.xmtp } : {}),
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
      m.indexerBlock === null ? "0" : m.indexerBlock.toString(),
    ) +
    line(
      "arena_indexer_lag_blocks",
      "Chain head minus the indexer's processed block.",
      "gauge",
      m.indexerLag === null ? "NaN" : m.indexerLag.toString(),
    ) +
    line(
      "arena_indexer_skipped_blocks",
      "Blocks whose dispute events the RPC refused to serve, even alone (monitor: should stay 0).",
      "gauge",
      m.indexerSkippedBlocks ?? 0,
    )
  );
}

const MARKDOWN_ROUTES = ["/skill.md", "/llms.txt", "/templates/chess/skill.md"] as const;

const ADDR_ROUTE_RE = /^0x[0-9a-fA-F]{40}$/;
const HEX32_ROUTE_RE = /^0x[0-9a-f]{64}$/i;

/** Canonicalizes a channel id path segment: lower-cases it and rejects anything that isn't 0x + 64 hex chars. */
function canonicalChannelId(raw: string): Hex | null {
  return HEX32_ROUTE_RE.test(raw) ? (raw.toLowerCase() as Hex) : null;
}

export async function startServer(cfg: ServerConfig, deps: ServerDeps = {}): Promise<ArenaServer> {
  const repo = new SqliteRepo(cfg.dbPath, (p) => channelId(cfg.chainId, cfg.hub, p));
  // shared by the lobby (Task 4) and, in later tasks, the indexer and relay
  const chain = deps.chain ?? new RpcChainReader(cfg);
  const log = deps.log ?? ((line: string) => console.log(line));

  // Product hardening: a database recorded against one chain/deployment (chain id, hub address, and the chain's
  // own genesis hash -- chain id alone cannot tell a redeployed local chain apart from the one the database was
  // last opened against) must never be silently reused against another. Without this, e.g. re-running a local
  // dev stack against a fresh Anvil instance left the indexer's persisted cursor pointing past the new chain's
  // head, and it would silently index nothing from then on (see indexer.ts's cursor-ahead-of-head warning).
  let genesisHash: Hex;
  try {
    genesisHash = await chain.genesisHash();
  } catch (err) {
    repo.close();
    throw new Error(`could not read the chain's genesis block to verify database identity: ${err instanceof Error ? err.message : String(err)}`);
  }
  const recorded = repo.identity();
  if (recorded === null) {
    repo.setIdentity({ chainId: cfg.chainId, hub: cfg.hub, genesisHash });
  } else {
    const mismatch =
      recorded.chainId !== cfg.chainId ||
      recorded.hub.toLowerCase() !== cfg.hub.toLowerCase() ||
      recorded.genesisHash.toLowerCase() !== genesisHash.toLowerCase();
    if (mismatch) {
      repo.close();
      throw new Error(
        `database ${cfg.dbPath} belongs to another chain/deployment: it was opened against ` +
          `chainId=${recorded.chainId} hub=${recorded.hub} genesisHash=${recorded.genesisHash}, but this config is ` +
          `chainId=${cfg.chainId} hub=${cfg.hub} genesisHash=${genesisHash}. Use a fresh --db, or point this config ` +
          `back at the original chain/deployment.`,
      );
    }
  }

  if (cfg.dbPath === ":memory:") {
    log(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: "warn",
        msg: "dbPath is :memory: -- matches, the relay cache and indexed channels are lost on restart",
      }),
    );
  }

  // Plan 5.5 Task 1 (Global Constraints): the dev faucet needs all three at once -- config opt-in, chain id
  // 31337, and the RPC itself answering as Anvil. Checked once, here, and cached for the server's lifetime: every
  // `/faucet` request and every `/templates` response just reads this boolean, never re-derives it. The chain-id
  // and config checks are synchronous and come first, so a real deployment (devFaucet never set, or chainId never
  // 31337) never even makes the `clientVersion()` RPC call.
  let faucetEnabled = false;
  if (cfg.devFaucet === true && cfg.chainId === 31337) {
    try {
      const version = await chain.clientVersion();
      faucetEnabled = /^anvil\//i.test(version);
      if (!faucetEnabled) {
        log(
          JSON.stringify({
            ts: new Date().toISOString(),
            level: "warn",
            msg: "devFaucet is set and chainId is 31337, but the RPC's web3_clientVersion is not Anvil's -- /faucet stays disabled",
            clientVersion: version,
          }),
        );
      }
    } catch (err) {
      log(
        JSON.stringify({
          ts: new Date().toISOString(),
          level: "warn",
          msg: "devFaucet is set, but web3_clientVersion could not be read -- /faucet stays disabled",
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }
  if (faucetEnabled) {
    log(JSON.stringify({ ts: new Date().toISOString(), level: "info", msg: "dev faucet enabled (chainId 31337, Anvil)" }));
  }
  // Plan 5.5 Task 1: one request per address per 10 minutes, in memory only -- the faucet is dev-only and this
  // process's lifetime is the whole relevant window. Keyed by the lower-cased address so case never splits a key.
  const FAUCET_COOLDOWN_MS = 10 * 60 * 1000;
  const faucetLastRequest = new Map<string, number>();

  const metrics: Metrics = { wsConnections: 0, relayMessages: 0, indexerBlock: null, indexerLag: null, indexerSkippedBlocks: 0 };

  const postLimiter = new RateLimiter(cfg.limits.httpPostBurst, cfg.limits.httpPostPerSec);
  const getLimiter = new RateLimiter(cfg.limits.httpGetBurst, cfg.limits.httpGetPerSec);

  const lobby = new Lobby(repo, chain, cfg);
  const relay = new Relay(repo, cfg, metrics, log);
  const indexer = new Indexer(repo, chain, cfg, log, relay);
  indexer.start();

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
      metrics.indexerBlock = repo.cursor() ?? 0n;
      metrics.indexerLag = await indexer.lag();
      metrics.indexerSkippedBlocks = indexer.skippedBlocks().length;
      ctx.res.writeHead(200, { "content-type": "text/plain; version=0.0.4" });
      ctx.res.end(renderMetrics(metrics, offersOpen));
      return true;
    },
    async (ctx) => {
      const match = /^\/players\/([^/]+)$/.exec(ctx.url.pathname);
      if (ctx.method !== "GET" || !match) return false;
      const addr = match[1];
      if (!ADDR_ROUTE_RE.test(addr)) {
        sendJson(ctx.res, 400, { error: "bad address" });
        return true;
      }
      sendJson(ctx.res, 200, playerStats(repo, relay, addr.toLowerCase() as Address));
      return true;
    },
    async (ctx) => {
      const match = /^\/api\/channels\/([^/]+)$/.exec(ctx.url.pathname);
      if (ctx.method !== "GET" || !match) return false;
      const id = canonicalChannelId(match[1]);
      if (!id) {
        sendJson(ctx.res, 400, { error: "bad channel id" });
        return true;
      }
      const row = repo.channelRow(id);
      // once a settled channel's relay cache is pruned, the state the indexer recorded at settlement stands in
      const latestSigned = relay.latestState(id) ?? row?.finalState ?? null;
      if (!row && !latestSigned) {
        sendJson(ctx.res, 404, { error: "not found" });
        return true;
      }
      const latest = latestSigned
        ? {
            turnNum: decStr(latestSigned.state.turnNum),
            gameIndex: latestSigned.state.gameIndex,
            fen: fenOf(latestSigned.state),
            balanceA: decStr(latestSigned.state.balanceA),
            balanceB: decStr(latestSigned.state.balanceB),
            status: statusOf(latestSigned.state),
          }
        : null;
      sendJson(ctx.res, 200, {
        channelId: id,
        // No indexer row means this channel is known only through the relay's live/cached state (e.g. it hasn't
        // been seen on-chain yet by this process): phase, participants and the on-chain params below are then
        // unknown and reported as null, rather than guessed from `latest`.
        phase: row ? row.phase : null,
        participants: row ? row.params.participants : null,
        stakePerGame: row ? decStr(row.params.stakePerGame) : null,
        deposit: row ? decStr(row.params.deposit) : null,
        createdBlock: row ? decStr(row.createdBlock) : null,
        latest,
      });
      return true;
    },
    async (ctx) => {
      const match = /^\/watch\/([^/]+)$/.exec(ctx.url.pathname);
      if (ctx.method !== "GET" || !match) return false;
      ctx.res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      ctx.res.end(watchHtml(match[1] as Hex));
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
      sendJson(ctx.res, 200, [await templateEntry(cfg, self.url, chain, faucetEnabled)]);
      return true;
    },
    async (ctx) => {
      if (ctx.method !== "POST" || ctx.url.pathname !== "/faucet") return false;
      // Global Constraints: disabled is indistinguishable from "route doesn't exist" -- falling through to the
      // 404 catch-all at the bottom of `handle`, exactly like any other unknown path.
      if (!faucetEnabled) return false;
      const contentType = ctx.req.headers["content-type"] ?? "";
      if (!/^application\/json\b/i.test(contentType)) {
        sendJson(ctx.res, 415, { error: "content-type must be application/json" });
        return true;
      }
      await withLobbyErrors(ctx.res, async () => {
        const raw = decodeWire(await readBody(ctx.req, MAX_BODY_BYTES));
        const body = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
        const addrRaw = typeof body.address === "string" ? body.address : "";
        if (!ADDR_ROUTE_RE.test(addrRaw)) {
          sendJson(ctx.res, 400, { error: "address must be a 0x-prefixed 40-hex-character address" });
          return;
        }
        const address = getAddress(addrRaw);
        const key = address.toLowerCase();
        const now = Date.now();
        const last = faucetLastRequest.get(key);
        if (last !== undefined && now - last < FAUCET_COOLDOWN_MS) {
          const retryAfterSeconds = Math.ceil((last + FAUCET_COOLDOWN_MS - now) / 1000);
          sendJson(ctx.res, 429, { error: "this address was funded recently; try again later", retryAfterSeconds });
          return;
        }
        // Reserve the slot before minting: two concurrent requests for the same address must not both mint, and
        // a failed mint below must not lock the address out for a full cooldown it never actually received.
        faucetLastRequest.set(key, now);
        try {
          const funded = await fundFromFaucet(cfg.rpcUrl, cfg.usdc, address);
          sendJson(ctx.res, 200, { address, usdc: decStr(funded.usdc), native: decStr(funded.native) });
        } catch (err) {
          faucetLastRequest.delete(key);
          throw err;
        }
      });
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
      ctx.res.end(indexHtml(repo.recentChannels(20)));
      return true;
    },
  ];

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const method = req.method ?? "GET";
      const ip = clientKey(req, cfg.trustProxy);
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
  const wsHandle = attachWs(httpServer, { lobby, relay, cfg, metrics, log, pingMs: deps.wsPingMs });

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
    indexer,
    dropConnections() {
      wsHandle.dropAll();
    },
    async close() {
      indexer.stop();
      clearInterval(pruneInterval);
      await wsHandle.close();
      httpServer.closeAllConnections();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      repo.close();
    },
  };
}
