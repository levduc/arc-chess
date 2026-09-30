import { request as httpRequest } from "node:http";
import { connect as netConnect, type AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { loadToken, startApi } from "../src/index.js";
import { startPair, waitFor } from "./helpers/harness.js";

let stop: (() => Promise<void>) | undefined;
afterEach(async () => {
  await stop?.();
  stop = undefined;
});

/**
 * Plan 5 Task 2: a raw request with full control over the `Host` header and no other headers -- `fetch()` treats
 * `Host` as a forbidden header and silently drops it, so the Host-guard tests below go through `node:http` instead.
 * `hostHeader: undefined` with `setHost: false` sends no Host header at all (simulating a client that omits one).
 */
function rawRequest(
  port: number,
  opts: { hostHeader?: string; method?: string; path?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: string; headers: Record<string, string | string[] | undefined> }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path: opts.path ?? "/health",
        method: opts.method ?? "GET",
        setHost: false,
        headers: { ...(opts.hostHeader !== undefined ? { host: opts.hostHeader } : {}), ...opts.headers },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8"), headers: res.headers }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/**
 * Plan 5 Task 2 fix round, minor 3: a fully raw request over a plain socket -- used only for a duplicate `Host`
 * header, which `node:http`'s own client refuses to construct (`options.headers.host` must be a single string).
 */
function rawSocketRequest(port: number, requestText: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const sock = netConnect(port, "127.0.0.1", () => sock.write(requestText));
    let buf = "";
    sock.on("data", (d: Buffer) => (buf += d.toString("utf8")));
    sock.on("end", () => {
      const [head, ...rest] = buf.split("\r\n\r\n");
      const status = Number((head ?? "").split("\r\n")[0]?.split(" ")[1] ?? "0");
      resolve({ status, body: rest.join("\r\n\r\n") });
    });
    sock.on("error", reject);
  });
}

describe("local API", () => {
  it("binds 127.0.0.1, requires the token, and drives the daemon", async () => {
    const pair = await startPair();
    const token = loadToken(pair.alice.home);
    const { server, url } = await startApi(pair.alice.daemon, { port: 0, token });
    const bobToken = loadToken(pair.bob.home);
    const bobApi = await startApi(pair.bob.daemon, { port: 0, token: bobToken });
    stop = async () => {
      server.close();
      bobApi.server.close();
      await pair.cleanup();
    };
    expect(url.startsWith("http://127.0.0.1:")).toBe(true);
    expect((server.address() as { address: string }).address).toBe("127.0.0.1");

    expect((await fetch(`${url}/health`)).status).toBe(200);
    expect((await fetch(`${url}/channels`)).status).toBe(401);
    expect((await fetch(`${url}/channels`, { headers: { authorization: "Bearer wrong" } })).status).toBe(401);

    const call = async (
      base: string,
      tok: string,
      method: string,
      path: string,
      body?: unknown,
      actor = "agent",
    ): Promise<{ status: number; body: any }> => {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: { authorization: `Bearer ${tok}`, "content-type": "application/json", "x-arena-actor": actor },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: res.status, body: await res.json() };
    };
    const offer = await call(url, token, "POST", "/offers", { deposit: "1000000", stakePerGame: "100000", challengeTimeout: "600" });
    expect(offer.status).toBe(200);
    await call(bobApi.url, bobToken, "POST", "/offers/accept", { offerId: offer.body.offerId });
    await waitFor(async () => (await call(url, token, "GET", "/status")).body.phase === "Open", 30_000, "open");

    const moved = await call(url, token, "POST", "/move", { move: "e4" });
    expect(moved.status).toBe(200);
    expect(moved.body.turnNum).toBe("1");
    // Plan 5 Task 2: the new status fields flow through the real API response too, not just buildStatus() in
    // isolation.
    expect(moved.body.lastMove).toEqual({ from: "e2", to: "e4", san: "e4" });
    expect(moved.body.orientation).toBe(moved.body.color);
    expect(moved.body.legalMovesUci).toEqual([]); // just moved: it's the opponent's turn now
    expect((await call(url, token, "POST", "/move", { move: "d4" })).status).toBe(409);

    const w = await call(bobApi.url, bobToken, "GET", "/wait?timeout=10");
    expect(w.body.reason).toBe("your-turn");

    const handoff = await call(url, token, "POST", "/handoff", { to: "human", note: "n" });
    expect(handoff.body.controller).toBe("human");
    expect(handoff.body.handoff.controller).toBe("human");
    expect(handoff.body.handoff.note).toBe("n");
    expect(typeof handoff.body.handoff.since).toBe("string");
    expect((await call(url, token, "POST", "/handoff", { to: "robot" })).status).toBe(400);
    // Plan 5 Task 2 fix round, minor 4: an over-long or control/bidi-carrying note is refused end to end too.
    expect((await call(url, token, "POST", "/handoff", { to: "agent", note: "x".repeat(1025) })).status).toBe(400);
    expect((await call(url, token, "POST", "/handoff", { to: "agent", note: "bidi‮override" })).status).toBe(400);
    // Plan 5 Task 3: a CRLF line break (a pasted note, or a client that sends one) is normalized to "\n" before the
    // control-character check; a lone "\r" is still refused.
    const crlf = await call(url, token, "POST", "/handoff", { to: "human", note: "line one\r\nline two" }, "human");
    expect(crlf.status).toBe(200);
    expect(crlf.body.handoff.note).toBe("line one\nline two");
    expect((await call(url, token, "POST", "/handoff", { to: "human", note: "lone\rcr" })).status).toBe(400);
  });

  it("Plan 5 Task 1: POST /offers without challengeTimeout defaults to minChallengeTimeoutOf(config)", async () => {
    const pair = await startPair({ aliceConfig: { minChallengeTimeout: 1800n } });
    const token = loadToken(pair.alice.home);
    const { server, url } = await startApi(pair.alice.daemon, { port: 0, token });
    stop = async () => {
      server.close();
      await pair.cleanup();
    };
    const res = await fetch(`${url}/offers`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ deposit: "1000000", stakePerGame: "100000" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { offerId: string };
    const listed = await pair.alice.daemon.listOffers();
    expect(listed.find((o) => o.offerId === body.offerId)!.offer.challengeTimeout).toBe(1800n);
  });

  it("Plan 5 Task 2 fix round, minor 2: a malformed request target is 400, not 500", async () => {
    const pair = await startPair();
    const token = loadToken(pair.alice.home);
    const { server } = await startApi(pair.alice.daemon, { port: 0, token });
    stop = async () => {
      server.close();
      await pair.cleanup();
    };
    const port = (server.address() as AddressInfo).port;
    // "//[" starts with "/" (origin-form, so minor 3's absolute-form/asterisk-form check lets it through) but is
    // still not a valid URL once parsed: WHATWG takes "//..." as network-path-reference, so this reads as an
    // unterminated IPv6 literal host -- new URL(req.url, base) throws, exercising this item's own try/catch
    // rather than minor 3's check (an earlier version of this test used "http://[", which minor 3 now rejects
    // first for an unrelated reason, before ever reaching this guard).
    const res = await rawRequest(port, { hostHeader: `127.0.0.1:${port}`, path: "//[" });
    expect(res.status).toBe(400);
  });

  it("Plan 5 Task 2 fix round, minor 3: rejects a request with more than one Host header (421)", async () => {
    const pair = await startPair();
    const token = loadToken(pair.alice.home);
    const { server } = await startApi(pair.alice.daemon, { port: 0, token });
    stop = async () => {
      server.close();
      await pair.cleanup();
    };
    const port = (server.address() as AddressInfo).port;
    const res = await rawSocketRequest(
      port,
      `GET /health HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nHost: evil.example\r\nConnection: close\r\n\r\n`,
    );
    expect(res.status).toBe(421);
  });

  it("Plan 5 Task 2 fix round, minor 3: rejects an absolute-form or asterisk-form request target (400)", async () => {
    const pair = await startPair();
    const token = loadToken(pair.alice.home);
    const { server } = await startApi(pair.alice.daemon, { port: 0, token });
    stop = async () => {
      server.close();
      await pair.cleanup();
    };
    const port = (server.address() as AddressInfo).port;
    // A well-formed *absolute* URL (unlike minor 2's "http://["), so this exercises the dedicated origin-form
    // check, not the malformed-target catch.
    const absolute = await rawRequest(port, { hostHeader: `127.0.0.1:${port}`, path: "http://evil.example/channels" });
    expect(absolute.status).toBe(400);
    const asterisk = await rawRequest(port, { hostHeader: `127.0.0.1:${port}`, path: "*", method: "OPTIONS" });
    expect([400, 405]).toContain(asterisk.status);
  });

  it("Plan 5 Task 2: rejects a Host header that is not exactly 127.0.0.1:<port> or localhost:<port> (421)", async () => {
    const pair = await startPair();
    const token = loadToken(pair.alice.home);
    const { server } = await startApi(pair.alice.daemon, { port: 0, token });
    stop = async () => {
      server.close();
      await pair.cleanup();
    };
    const port = (server.address() as AddressInfo).port;
    expect((await rawRequest(port, { hostHeader: `evil.example:${port}` })).status).toBe(421);
    expect((await rawRequest(port, { hostHeader: `127.0.0.1:${port + 1}` })).status).toBe(421); // right host, wrong port
    expect((await rawRequest(port, { hostHeader: undefined })).status).toBe(421); // no Host header at all
    expect((await rawRequest(port, { hostHeader: `[::1]:${port}` })).status).toBe(421);
    // The DNS-rebinding guard applies to every route, including /health and /board.
    expect((await rawRequest(port, { hostHeader: `evil.example:${port}`, path: "/board" })).status).toBe(421);
  });

  it("Plan 5 Task 2: accepts 127.0.0.1:<port> and localhost:<port>", async () => {
    const pair = await startPair();
    const token = loadToken(pair.alice.home);
    const { server } = await startApi(pair.alice.daemon, { port: 0, token });
    stop = async () => {
      server.close();
      await pair.cleanup();
    };
    const port = (server.address() as AddressInfo).port;
    expect((await rawRequest(port, { hostHeader: `127.0.0.1:${port}` })).status).toBe(200);
    expect((await rawRequest(port, { hostHeader: `localhost:${port}` })).status).toBe(200);
  });

  it("Plan 5 Task 2: security headers on every response, never CORS, and OPTIONS is refused", async () => {
    const pair = await startPair();
    const token = loadToken(pair.alice.home);
    const { server, url } = await startApi(pair.alice.daemon, { port: 0, token });
    stop = async () => {
      server.close();
      await pair.cleanup();
    };
    const res = await fetch(`${url}/health`);
    expect(res.headers.get("content-security-policy")).toBe(
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; " +
        "frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    );
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("cache-control")).toBe("no-store");
    for (const name of res.headers.keys()) expect(name.toLowerCase().startsWith("access-control")).toBe(false);

    const unauthed = await fetch(`${url}/channels`);
    expect(unauthed.status).toBe(401);
    for (const name of unauthed.headers.keys()) expect(name.toLowerCase().startsWith("access-control")).toBe(false);

    const opt = await fetch(`${url}/channels`, { method: "OPTIONS" });
    expect(opt.status).toBe(405);

    // The load-bearing case: a board *document* -- the one response the browser actually enforces the CSP
    // against -- carries it too, not just the JSON paths through send() above.
    const board = await fetch(`${url}/board`);
    expect(board.headers.get("content-security-policy")).toBe(
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; " +
        "frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    );
    expect(board.headers.get("x-frame-options")).toBe("DENY");

    // And on the 421 short-circuit itself (headersSent-free path, before any route dispatch).
    const port = (server.address() as AddressInfo).port;
    const rejected = await rawRequest(port, { hostHeader: `evil.example:${port}` });
    expect(rejected.status).toBe(421);
    expect(rejected.headers["content-security-policy"]).toBe(
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; " +
        "frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    );
  });

  it("Plan 5 Task 2: serves the static board with no token, and 404s anything else under /board", async () => {
    const pair = await startPair();
    const token = loadToken(pair.alice.home);
    const { server, url } = await startApi(pair.alice.daemon, { port: 0, token });
    stop = async () => {
      server.close();
      await pair.cleanup();
    };
    const port = (server.address() as AddressInfo).port;

    const index = await fetch(`${url}/board`);
    expect(index.status).toBe(200);
    expect(index.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await index.text()).toContain("<html");
    expect((await fetch(`${url}/board/`)).status).toBe(200);

    const appJs = await fetch(`${url}/board/app.js`);
    expect(appJs.status).toBe(200);
    expect(appJs.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect((await fetch(`${url}/board/board.js`)).status).toBe(200);
    expect((await fetch(`${url}/board/api.js`)).status).toBe(200);

    const css = await fetch(`${url}/board/style.css`);
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toBe("text/css; charset=utf-8");

    const vendor = await fetch(`${url}/board/vendor/chess.js`);
    expect(vendor.status).toBe(200);
    expect(vendor.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(await vendor.text()).toMatch(/class Chess/);

    // No token anywhere above -- static routes carry no data. Everything else under /board, including a
    // traversal attempt (plain or percent-encoded), gets 404, not the daemon's config/token files.
    expect((await fetch(`${url}/board/nope.js`)).status).toBe(404);
    expect((await rawRequest(port, { hostHeader: `127.0.0.1:${port}`, path: "/board/../config.json" })).status).toBe(404);
    expect((await rawRequest(port, { hostHeader: `127.0.0.1:${port}`, path: "/board/..%2fconfig.json" })).status).toBe(404);
  });

  it("Plan 5 Task 2: GET /events requires the token, streams a retry line and change events, and caps at 8 clients", async () => {
    const pair = await startPair();
    const token = loadToken(pair.alice.home);
    const { server, url } = await startApi(pair.alice.daemon, { port: 0, token });
    const controllers: AbortController[] = [];
    stop = async () => {
      for (const c of controllers) c.abort();
      server.close();
      await pair.cleanup();
    };

    expect((await fetch(`${url}/events`)).status).toBe(401);

    const open = async (): Promise<Response> => {
      const c = new AbortController();
      controllers.push(c);
      return fetch(`${url}/events`, { headers: { authorization: `Bearer ${token}` }, signal: c.signal });
    };
    const eight = await Promise.all(Array.from({ length: 8 }, () => open()));
    for (const res of eight) {
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/event-stream");
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
    expect((await open()).status).toBe(429); // the 9th client

    const reader = eight[0].body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    const until = Date.now() + 10_000;
    while (!text.includes("event: change") && Date.now() < until) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value);
    }
    expect(text).toContain("retry: 3000");
    expect(text).toContain("event: change");
    expect(text).toContain('data: {"channelId":null}');
  });

  it("Plan 5 Task 2 fix round, minor 5: /events change events are rate-limited to 1/sec per client, trailing edge", async () => {
    const pair = await startPair({ pollMs: 20 }); // fast ticks: mainPass()'s own notify() fires roughly every 20ms
    const token = loadToken(pair.alice.home);
    const { server, url } = await startApi(pair.alice.daemon, { port: 0, token, sse: { changeDebounceMs: 300 } });
    stop = async () => {
      server.close();
      await pair.cleanup();
    };
    const res = await fetch(`${url}/events`, { headers: { authorization: `Bearer ${token}` } });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    const changeAt: number[] = [];
    const deadline = Date.now() + 5_000;
    while (changeAt.length < 3 && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value);
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const evt = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        if (evt.startsWith("event: change")) changeAt.push(Date.now());
      }
    }
    // Despite notify() firing every ~20ms, at most one "event: change" arrives per ~300ms window -- and the
    // stream is never simply silent instead (a real change always lands, at worst at the trailing edge).
    expect(changeAt.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < changeAt.length; i++) {
      expect(changeAt[i] - changeAt[i - 1]).toBeGreaterThanOrEqual(250); // ~300ms window, some scheduling slack
    }
  });

  it("Plan 5 Task 2: server.close() ends open /events streams instead of hanging", async () => {
    const pair = await startPair();
    const token = loadToken(pair.alice.home);
    const { server, url } = await startApi(pair.alice.daemon, { port: 0, token });
    stop = async () => {
      await pair.cleanup(); // the server itself is closed by the test below
    };
    const res = await fetch(`${url}/events`, { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    await reader.read(); // the initial "retry: 3000" line -- confirms the stream is actually open
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("server.close() hung with an open SSE stream")), 10_000);
      server.close(() => {
        clearTimeout(timer);
        resolve();
      });
    });
    const { done } = await reader.read();
    expect(done).toBe(true);
  });

  it("Plan 5 Task 2 fix round, minor 6: daemon.stop() ends open /events streams", async () => {
    const pair = await startPair();
    const token = loadToken(pair.alice.home);
    const { server, url } = await startApi(pair.alice.daemon, { port: 0, token });
    stop = async () => {
      server.close();
      await pair.cleanup(); // idempotent: alice's daemon is already stopped by the test itself below
    };
    const res = await fetch(`${url}/events`, { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    await reader.read(); // the initial "retry: 3000" line -- confirms the stream is actually open
    await pair.alice.daemon.stop();
    const { done } = await reader.read();
    expect(done).toBe(true);
  });

  it("Plan 5 Task 2 fix round, minor 6: the /events cap slot is freed after a client disconnects", async () => {
    const pair = await startPair();
    const token = loadToken(pair.alice.home);
    const { server, url } = await startApi(pair.alice.daemon, { port: 0, token });
    const controllers: AbortController[] = [];
    stop = async () => {
      for (const c of controllers) c.abort();
      server.close();
      await pair.cleanup();
    };
    const open = async (): Promise<Response> => {
      const c = new AbortController();
      controllers.push(c);
      return fetch(`${url}/events`, { headers: { authorization: `Bearer ${token}` }, signal: c.signal });
    };
    const eight = await Promise.all(Array.from({ length: 8 }, () => open()));
    expect((await open()).status).toBe(429); // the cap is full

    // Disconnect one of the eight; cleanup() runs on the server's own "close" event for that request, which is
    // asynchronous relative to the abort() call itself -- poll for the freed slot rather than assume it's instant.
    eight[0].body?.cancel().catch(() => undefined);
    controllers[0].abort();
    await waitFor(async () => (await open()).status === 200, 5_000, "a freed /events slot");
  });

  it("Plan 5 Task 2 fix round, minor 6: /events sends a periodic ping comment", async () => {
    const pair = await startPair();
    const token = loadToken(pair.alice.home);
    const { server, url } = await startApi(pair.alice.daemon, { port: 0, token, sse: { pingIntervalMs: 50 } });
    stop = async () => {
      server.close();
      await pair.cleanup();
    };
    const res = await fetch(`${url}/events`, { headers: { authorization: `Bearer ${token}` } });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    const deadline = Date.now() + 5_000;
    while (!text.includes(": ping") && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value);
    }
    expect(text).toContain(": ping\n\n");
  });

  it("fix round I5: POST /sweep returns {results, remaining}", async () => {
    const pair = await startPair();
    const token = loadToken(pair.alice.home);
    const { server, url } = await startApi(pair.alice.daemon, { port: 0, token });
    stop = async () => {
      server.close();
      await pair.cleanup();
    };
    const res = await fetch(`${url}/sweep`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ results: [], remaining: 0 }); // no settled channels yet
  });
});
