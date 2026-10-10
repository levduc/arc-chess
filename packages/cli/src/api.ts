import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Hex } from "viem";
import { DaemonError, type Actor, type ArenaDaemon } from "./daemon.js";
import { selfCommand } from "./version.js";

/**
 * Plan 5 Task 2 (Global Constraints): the board's own CSP, verbatim -- served on every response, JSON or static,
 * alongside the legacy sniffing/framing/referrer defenses. This API never sends any `Access-Control-*` header:
 * there is no CORS support at all, by design (a hostile origin gets no read access even with the right guesses).
 */
const CONTENT_SECURITY_POLICY =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; " +
  "frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

function securityHeaders(res: ServerResponse): void {
  res.setHeader("content-security-policy", CONTENT_SECURITY_POLICY);
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("referrer-policy", "no-referrer");
  res.setHeader("x-frame-options", "DENY");
}

/**
 * Plan 5 Task 2 (Global Constraints: DNS-rebinding defense): true only for the two exact Host values a legitimate
 * local client can send. `boundPort` is read from `server.address()` after `listen()` (not `opts.port`), so this
 * also works when the caller asked for port 0. A missing Host header, `[::1]`, or any other host/port -- fails.
 */
function hostAllowed(header: string | undefined, boundPort: number): boolean {
  return header === `127.0.0.1:${boundPort}` || header === `localhost:${boundPort}`;
}

/** Plan 5 Task 2 fix round, minor 3: true if `rawHeaders` (Node's flat, un-folded, original-casing list) names
 *  `Host` more than once. `req.headers.host` silently keeps only the first and drops the rest, so a duplicate
 *  Host header is invisible to `hostAllowed` above -- checked separately here, against the one place Node still
 *  exposes it, since which Host a request "really" means is now ambiguous rather than merely wrong. */
function hasDuplicateHostHeader(rawHeaders: readonly string[]): boolean {
  let count = 0;
  for (let i = 0; i < rawHeaders.length; i += 2) {
    if (rawHeaders[i]?.toLowerCase() === "host") count++;
  }
  return count > 1;
}

/** Plan 5 Task 2 fix round, minor 3: true only for an origin-form request-target (what every legitimate request
 *  here uses: a path starting with "/", e.g. "/channels"). False for absolute-form ("http://evil.example/x" --
 *  a well-formed URL in its own right, with its own host, that `new URL(req.url, base)` would parse without ever
 *  raising minor 2's malformed-target check) and asterisk-form ("*", normally valid only for `OPTIONS *`). Both
 *  of those forms exist for a request through a proxy, never a request straight to this origin server, and
 *  neither is bound by this server's own Host guard the way an origin-form target's path is. */
function isOriginFormTarget(rawUrl: string): boolean {
  return rawUrl.startsWith("/");
}

function send(res: ServerResponse, code: number, value: unknown): void {
  res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
}

type BoardAsset = { body: Buffer; contentType: string };

const BOARD_DIR = join(dirname(fileURLToPath(import.meta.url)), "board");

/**
 * Plan 5 Task 2: every static board file, read once here rather than per request. This map IS the allowlist --
 * `/board`, `/board/`, and the four URLs below, exactly -- so any other path under /board (a traversal attempt,
 * encoded or not, or simply an unknown file) can never resolve to a file: see the exact-match lookup below,
 * against `url.pathname`, which normalizes real `.`/`..` segments but never decodes `%2f` into a literal slash.
 */
function loadBoardAssets(): Map<string, BoardAsset> {
  const assets = new Map<string, BoardAsset>();
  const add = (urlPath: string, filePath: string, contentType: string) => {
    assets.set(urlPath, { body: readFileSync(filePath), contentType });
  };
  const indexHtml = join(BOARD_DIR, "index.html");
  add("/board", indexHtml, "text/html; charset=utf-8");
  add("/board/", indexHtml, "text/html; charset=utf-8");
  add("/board/app.js", join(BOARD_DIR, "app.js"), "text/javascript; charset=utf-8");
  add("/board/board.js", join(BOARD_DIR, "board.js"), "text/javascript; charset=utf-8");
  add("/board/api.js", join(BOARD_DIR, "api.js"), "text/javascript; charset=utf-8");
  add("/board/style.css", join(BOARD_DIR, "style.css"), "text/css; charset=utf-8");
  return assets;
}

const BOARD_ASSETS = loadBoardAssets();

/** True for `/board`, `/board/`, or anything under it, checked against the *raw* request-target (before `new
 *  URL` normalizes `.`/`..` segments away) -- so a plain traversal attempt (`/board/../config.json`, which
 *  normalizes to `/config.json`) is still recognized as a board request and 404s below, rather than falling
 *  through to the token-gated switch and answering 401 instead of the 404 a static path must always get. */
function isBoardRequest(rawUrl: string): boolean {
  const path = rawUrl.split("?")[0];
  return path === "/board" || path.startsWith("/board/");
}

/** GET on an allowlisted path serves the file; anything else under /board -- another method, an unknown file, a
 *  traversal attempt whether plain or percent-encoded -- gets a bare 404. No token is required: these routes
 *  serve no data, only the static app shell (Global Constraints, Task 2 requirement 3). */
function serveBoard(req: IncomingMessage, res: ServerResponse, pathname: string): void {
  if (req.method === "GET") {
    const asset = BOARD_ASSETS.get(pathname);
    if (asset) {
      res.writeHead(200, { "content-type": asset.contentType });
      res.end(asset.body);
      return;
    }
  }
  res.writeHead(404);
  res.end();
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 64 * 1024) throw new DaemonError(413, "request body too large");
    chunks.push(c as Buffer);
  }
  if (chunks.length === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch {
    throw new DaemonError(400, "body must be a JSON object");
  }
}

/**
 * Final fix wave (M1 follow-up): true only for `Content-Type: application/json` (a parameter such as `charset` is
 * allowed). Every POST here requires it, and answers 415 otherwise. A cross-origin page can send that type only
 * after a CORS preflight, which this API always refuses (405), so it is left with the "simple" no-cors shapes
 * (text/plain, form types, no type) -- which now reach no POST handler, and in particular cannot use up
 * `POST /board/session`'s rate-limit budget, since it is checked before the attempt is counted.
 */
function isJsonRequest(req: IncomingMessage): boolean {
  return (req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase() === "application/json";
}

const NOT_JSON = { error: "Content-Type must be application/json" };

function authorized(req: IncomingMessage, token: string): boolean {
  const header = req.headers.authorization ?? "";
  const given = Buffer.from(header.startsWith("Bearer ") ? header.slice(7) : "");
  const want = Buffer.from(token);
  return given.length === want.length && timingSafeEqual(given, want);
}

/** Final fix wave (M1): a board link's one-time code is good for this long after `POST /board/code` mints it. */
export const BOARD_CODE_TTL_MS = 120_000;
/** Final fix wave (M1): `POST /board/session` answers at most this many attempts per minute, per daemon. */
export const BOARD_SESSION_ATTEMPTS_PER_MINUTE = 10;
/** Final fix wave (M1): at most this many unused codes are kept; minting another drops the oldest. */
const MAX_BOARD_CODES = 32;

const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);
function amount(v: unknown, name: string): bigint {
  if (typeof v !== "string" || !/^[0-9]+$/.test(v)) throw new DaemonError(400, `${name} must be a decimal string of base units`);
  return BigInt(v);
}

export async function startApi(
  daemon: ArenaDaemon,
  opts: {
    port: number;
    token: string;
    host?: string;
    /** Test-only overrides for the SSE feed's own timing; production never sets either (the defaults below). */
    sse?: { pingIntervalMs?: number; changeDebounceMs?: number };
    /** Test-only: the clock the board's one-time codes and their rate limit read (default `Date.now`). */
    board?: { now?: () => number };
  },
): Promise<{ server: Server; url: string }> {
  const host = opts.host ?? "127.0.0.1";
  // Set once listen() resolves, below -- read from server.address() so a caller-requested port 0 still guards the
  // real bound port. No request can reach the handler before that assignment (nothing can connect before listen
  // returns), so the closure below always sees the real value once traffic starts flowing.
  let boundPort = opts.port;
  // Plan 5 Task 2: open GET /events streams for this one server (per-instance, not module-wide -- a test, or a
  // real host, may run several daemons' APIs at once and each has its own cap). Also drained by server.close()
  // below, so a long-lived SSE connection never keeps that call from resolving.
  const sseClients = new Set<ServerResponse>();
  const MAX_SSE_CLIENTS = 8;
  const SSE_PING_INTERVAL_MS = opts.sse?.pingIntervalMs ?? 15_000;
  // Plan 5 Task 2 fix round, minor 5: `notify()` fires on every watchtower tick (as often as `pollMs`), not only
  // on a change a human would care about -- an unthrottled feed would push far more than the board ever needs.
  const CHANGE_DEBOUNCE_MS = opts.sse?.changeDebounceMs ?? 1_000;

  /**
   * Final fix wave (M1): the board's one-time sign-in codes. `arena board` mints one with the token it reads from
   * disk (`POST /board/code`) and prints it in the link's fragment instead of the token itself; the board trades
   * it once for the token (`POST /board/session`) and keeps the token in memory only. The browser's history then
   * holds a dead code, never the token. Per API server (one per daemon), in memory: a restart voids every code.
   */
  const boardNow = opts.board?.now ?? Date.now;
  const boardCodes = new Map<string, number>(); // code -> expiry (ms)
  const sessionAttempts: number[] = []; // when each recent POST /board/session arrived (ms), oldest first

  function mintBoardCode(): string {
    const now = boardNow();
    for (const [code, expiresAt] of boardCodes) if (expiresAt <= now) boardCodes.delete(code);
    while (boardCodes.size >= MAX_BOARD_CODES) boardCodes.delete(boardCodes.keys().next().value as string);
    const code = randomBytes(16).toString("base64url"); // 128 bits
    boardCodes.set(code, now + BOARD_CODE_TTL_MS);
    return code;
  }

  /** `POST /board/session {code}`: no bearer token -- the code is the credential. Host-guarded like every route,
   *  rate-limited before the code is even read, and single-use: a used, expired or unknown code gets 401. */
  async function handleBoardSession(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!isJsonRequest(req)) return send(res, 415, NOT_JSON); // before the attempt is counted
    const now = boardNow();
    while (sessionAttempts.length > 0 && sessionAttempts[0] <= now - 60_000) sessionAttempts.shift();
    if (sessionAttempts.length >= BOARD_SESSION_ATTEMPTS_PER_MINUTE) {
      return send(res, 429, { error: `too many board sign-in attempts: wait a minute, then run \`${selfCommand()} board\` again` });
    }
    sessionAttempts.push(now);
    const b = await body(req);
    const code = typeof b.code === "string" ? b.code : "";
    const expiresAt = boardCodes.get(code);
    if (expiresAt === undefined || expiresAt <= now) {
      if (expiresAt !== undefined) boardCodes.delete(code);
      return send(res, 401, { error: `this board link has expired: run \`${selfCommand()} board\` again` });
    }
    boardCodes.delete(code);
    return send(res, 200, { token: opts.token });
  }

  /**
   * GET /events (spec: Plan 5 Task 2 requirement 4). Browsers cannot set an `Authorization` header on
   * `EventSource`, so the board's own client uses `fetch()` (with the bearer token, like every other route) and
   * reads the body through a `ReadableStream` reader instead of the `EventSource` API. Requires the token like
   * every data route; capped at `MAX_SSE_CLIENTS` concurrent streams (the caller checks that and sends 429).
   * Closes when the client disconnects, when this daemon stops (`daemon.onStop`), or when this server closes
   * (the `sseClients` sweep in the patched `close` below).
   */
  function handleSse(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
    res.write("retry: 3000\n\n");
    sseClients.add(res);
    const ping = setInterval(() => {
      try {
        res.write(": ping\n\n");
      } catch {
        // The client is already gone; req's own "close" below runs cleanup() shortly.
      }
    }, SSE_PING_INTERVAL_MS);
    const sendChange = () => {
      try {
        res.write('event: change\ndata: {"channelId":null}\n\n');
      } catch {
        // See the ping's own catch above.
      }
    };
    // Plan 5 Task 2 fix round, minor 5: rate-limited to at most one `event: change` per CHANGE_DEBOUNCE_MS, per
    // client -- trailing edge, so the first change after a quiet spell sends immediately, but a burst within the
    // window collapses to one send right away plus (if any further change arrived during the window) exactly one
    // more at the window's end. A change is never silently dropped: at most delayed to that trailing edge.
    let lastSentAt = 0;
    let trailing: NodeJS.Timeout | null = null;
    const onChange = () => {
      const elapsed = Date.now() - lastSentAt;
      if (elapsed >= CHANGE_DEBOUNCE_MS) {
        lastSentAt = Date.now();
        sendChange();
      } else if (!trailing) {
        trailing = setTimeout(() => {
          trailing = null;
          lastSentAt = Date.now();
          sendChange();
        }, CHANGE_DEBOUNCE_MS - elapsed);
      }
      // else: a trailing send is already scheduled -- it will pick up this (and any later) change.
    };
    const unsubscribeChange = daemon.onChange(onChange);
    let unsubscribeStop = (): void => undefined;
    const cleanup = () => {
      clearInterval(ping);
      if (trailing) clearTimeout(trailing);
      unsubscribeChange();
      unsubscribeStop();
      sseClients.delete(res);
    };
    unsubscribeStop = daemon.onStop(() => {
      cleanup();
      try {
        res.end();
      } catch {
        // already closed
      }
    });
    req.on("close", cleanup);
  }

  // requireHostHeader: false -- Node's own HTTP/1.1 parser otherwise answers a request with no Host header with
  // a bare 400 before this handler ever runs (RFC 7230 section 5.4), which would make the DNS-rebinding guard
  // below (hostAllowed) unreachable for exactly the "no Host header" case the ruling calls out for 421.
  const server = createServer({ requireHostHeader: false }, (req, res) => {
    void (async () => {
      securityHeaders(res);
      try {
        // Plan 5 Task 2 (Global Constraints): the Host guard applies to every route, including /health and /board,
        // before anything else -- a hostile page that got a victim's browser to hit this port by name (DNS
        // rebinding) must never reach a single byte of this API. Fix round, minor 3: a duplicate Host header is
        // folded into the same 421 -- see hasDuplicateHostHeader's docstring for why it belongs here, not with
        // minor 3's other (400) check below.
        if (!hostAllowed(req.headers.host, boundPort) || hasDuplicateHostHeader(req.rawHeaders)) {
          res.writeHead(421);
          return res.end();
        }
        // Plan 5 Task 2 fix round, minor 3: an absolute-form or asterisk-form request-target is refused outright,
        // before anything else parses it -- see isOriginFormTarget's docstring. Checked ahead of the OPTIONS
        // check too, so "OPTIONS *" lands here (400), which the ruling allows equally with 405.
        if (!isOriginFormTarget(req.url ?? "/")) {
          res.writeHead(400);
          return res.end();
        }
        // No CORS is supported: a preflight can never succeed here.
        if (req.method === "OPTIONS") {
          res.writeHead(405);
          return res.end();
        }
        // Plan 5 Task 2 fix round, minor 2: a malformed request target that still starts with "/" (so minor 3's
        // check above lets it through) can still make `new URL` throw -- e.g. "//[", a network-path reference
        // whose own host is an unterminated IPv6 literal. Caught here and turned into a 400 like any other bad
        // request, instead of falling through to the generic catch's 500. ("http://[" -- this item's original
        // motivating example -- is now caught by minor 3's check above instead, since it doesn't start with "/".)
        let url: URL;
        try {
          url = new URL(req.url ?? "/", `http://${host}:${boundPort}`);
        } catch {
          throw new DaemonError(400, "malformed request target");
        }
        // Final fix wave (M1): the board's sign-in routes, matched on the exact raw path before the static files
        // (which 404 every other method and path under /board).
        const rawPath = (req.url ?? "/").split("?")[0];
        if (req.method === "POST" && rawPath === "/board/code") {
          if (!authorized(req, opts.token)) return send(res, 401, { error: "missing or invalid token" });
          if (!isJsonRequest(req)) return send(res, 415, NOT_JSON);
          return send(res, 200, { code: mintBoardCode() });
        }
        if (req.method === "POST" && rawPath === "/board/session") return await handleBoardSession(req, res);
        // Static board files, before anything token-gated: they need no token (Task 2 requirement 3), and any
        // path under /board that isn't one of them must 404, never 401.
        if (isBoardRequest(req.url ?? "/")) return serveBoard(req, res, url.pathname);
        const route = `${req.method} ${url.pathname}`;
        if (route === "GET /health") return send(res, 200, { ok: true });
        if (route === "GET /events") {
          if (!authorized(req, opts.token)) return send(res, 401, { error: "missing or invalid token" });
          if (sseClients.size >= MAX_SSE_CLIENTS) return send(res, 429, { error: `too many /events clients (max ${MAX_SSE_CLIENTS})` });
          return handleSse(req, res);
        }
        if (!authorized(req, opts.token)) return send(res, 401, { error: "missing or invalid token" });
        if (req.method === "POST" && !isJsonRequest(req)) return send(res, 415, NOT_JSON);
        const actor: Actor = req.headers["x-arena-actor"] === "human" ? "human" : "agent";
        const q = url.searchParams;
        const b = req.method === "POST" ? await body(req) : {};
        const ch = str(b.channel) ?? str(q.get("channel") ?? undefined);
        switch (route) {
          case "GET /channels":
            return send(res, 200, await daemon.channels());
          case "GET /status":
            return send(res, 200, await daemon.status(ch));
          case "GET /wait": {
            const seconds = Math.min(600, Math.max(0, Number(q.get("timeout") ?? "60") || 0));
            return send(res, 200, await daemon.wait({ ref: ch, timeoutMs: seconds * 1000 }));
          }
          case "GET /offers":
            return send(res, 200, await daemon.listOffers());
          case "POST /offers":
            return send(
              res,
              200,
              // Plan 5 Task 1: an omitted challengeTimeout is left undefined -- createOffer defaults it to this
              // daemon's own minChallengeTimeoutOf(config), not a value fixed here.
              await daemon.createOffer({
                deposit: amount(b.deposit, "deposit"),
                stakePerGame: amount(b.stakePerGame, "stakePerGame"),
                ...(b.challengeTimeout === undefined ? {} : { challengeTimeout: amount(b.challengeTimeout, "challengeTimeout") }),
              }),
            );
          case "POST /offers/accept": {
            const id = str(b.offerId);
            if (!id) throw new DaemonError(400, "offerId is required");
            await daemon.acceptOffer(id as Hex);
            return send(res, 200, { accepted: id });
          }
          case "POST /move": {
            const m = str(b.move);
            if (!m) throw new DaemonError(400, "move is required");
            await daemon.move(ch, m, { offerDraw: b.offerDraw === true, actor });
            return send(res, 200, await daemon.status(ch));
          }
          case "POST /resign":
            await daemon.resign(ch, actor);
            return send(res, 200, await daemon.status(ch));
          case "POST /accept-draw":
            await daemon.acceptDraw(ch, actor);
            return send(res, 200, await daemon.status(ch));
          case "POST /next-game":
            await daemon.nextGame(ch, actor);
            return send(res, 200, await daemon.status(ch));
          case "POST /close":
            await daemon.close(ch, actor);
            return send(res, 200, await daemon.status(ch));
          case "POST /challenge":
            await daemon.challenge(ch, actor);
            return send(res, 200, await daemon.status(ch));
          case "POST /reclaim":
            await daemon.reclaim(ch);
            return send(res, 200, await daemon.status(ch));
          case "POST /sweep":
            // Plan 5 Task 1: a daemon-wide sweep (no `channel`) has no single channel's status to return.
            return send(res, 200, await daemon.sweep(ch));
          case "POST /handoff": {
            const to = b.to;
            if (to !== "agent" && to !== "human") throw new DaemonError(400, 'to must be "agent" or "human"');
            // Plan 5 Task 3: CRLF -> LF before the daemon's control-character check, so a pasted Windows-style line
            // break is not refused as a stray "\r"; a lone "\r" still is.
            const note = typeof b.note === "string" ? b.note.replace(/\r\n/g, "\n") : "";
            await daemon.handoff(ch, to, note);
            return send(res, 200, await daemon.status(ch));
          }
          case "POST /withdraw": {
            // Plan 5.6 Task 3 (spec §4.4): either actor may ask -- the owner lock, not the actor, is the protection.
            // The destination is never read from the request: the daemon pays the owner recorded in config.json,
            // and no route sets that. A body that tries to name one (or anything else) is refused outright, so a
            // confused caller learns that instead of assuming its `to` was honoured.
            const extra = Object.keys(b).filter((k) => k !== "amount" && k !== "all");
            if (extra.length > 0) {
              throw new DaemonError(
                400,
                `withdraw takes only {"amount": "<base units>"} or {"all": true} and always pays the recorded owner; unexpected: ${extra.join(", ").slice(0, 100)}`,
              );
            }
            if (b.all !== undefined && b.all !== true) throw new DaemonError(400, "all must be true when given");
            if ((b.all === true) === (b.amount !== undefined)) throw new DaemonError(400, "withdraw needs exactly one of amount or all");
            return send(res, 200, await daemon.withdraw(b.all === true ? { all: true } : { amount: amount(b.amount, "amount") }));
          }
          default:
            return send(res, 404, { error: `no route ${route}` });
        }
      } catch (err) {
        // A throw after headers already went out (e.g. mid-SSE) must never re-writeHead -- that throws its own
        // ERR_HTTP_HEADERS_SENT and crashes this handler instead of just ending the one response.
        if (res.headersSent) return void res.end();
        if (err instanceof DaemonError) return send(res, err.code, { error: err.message });
        return send(res, 500, { error: err instanceof Error ? err.message.split("\n")[0] : String(err) });
      }
    })();
  });
  // Plan 5.6 Task 3 fix round (I1): a listen failure (the port is taken -- by another home's daemon, or anything
  // else) must reject, not surface as an unhandled 'error' event that kills the process. `startDaemonProcess` then
  // tears down what it started and releases the home lock -- and a no-daemon `arena withdraw` fails cleanly, with
  // exit 1 and a message naming the port, instead of crashing mid-tick with the lock left behind.
  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => reject(new Error(`the daemon's local API cannot listen on ${host}:${opts.port}: ${err.message}`));
    server.once("error", onError);
    server.listen(opts.port, host, () => {
      server.off("error", onError);
      resolve();
    });
  });
  boundPort = (server.address() as AddressInfo).port;
  // Plan 5 Task 2: server.close() otherwise hangs -- an open SSE response is a keep-alive connection that never
  // ends on its own, and http.Server#close() only finishes once every connection has. Force each one closed
  // first (end() the response, then destroy() its socket so the underlying connection actually drops), then
  // defer to the real close().
  const rawClose = server.close.bind(server);
  server.close = ((callback?: (err?: Error) => void) => {
    for (const client of sseClients) {
      try {
        client.end();
      } catch {
        // already ending
      }
      try {
        client.socket?.destroy();
      } catch {
        // already gone
      }
    }
    sseClients.clear();
    return rawClose(callback);
  }) as typeof server.close;
  return { server, url: `http://${host}:${boundPort}` };
}
