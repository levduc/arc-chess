import { request as httpRequest } from "node:http";
import { connect as netConnect, type AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { LimitExceededRpcError, type Hex } from "viem";
import { TxReceiptMissingError } from "@arena/sdk";
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

  it("H3: an action that took effect answers 200 with chainStale when only the chain read after it fails (board rate-limit fix: so does GET /status)", async () => {
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
    const call = async (base: string, tok: string, method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: { authorization: `Bearer ${tok}`, "content-type": "application/json", "x-arena-actor": "agent" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: res.status, body: await res.json() };
    };
    const offer = await call(url, token, "POST", "/offers", { deposit: "1000000", stakePerGame: "100000", challengeTimeout: "600" });
    await call(bobApi.url, bobToken, "POST", "/offers/accept", { offerId: offer.body.offerId });
    await waitFor(async () => (await call(url, token, "GET", "/status")).body.phase === "Open", 30_000, "open");
    // Arc's RPC rate-limits the chain read that follows the move (rehearsal §8.2), and only that read.
    const d = pair.alice.daemon;
    const limit = { on: false };
    const realInfo = d.hub.channelInfo.bind(d.hub);
    d.hub.channelInfo = async (id: Hex) => {
      if (limit.on) throw new LimitExceededRpcError(new Error("rate limit exceeded"));
      return realInfo(id);
    };
    const realMove = d.move.bind(d);
    d.move = async (...args: Parameters<typeof d.move>) => {
      await realMove(...args);
      limit.on = true;
    };
    const moved = await call(url, token, "POST", "/move", { move: "e4" });
    // Before H3: a 500, although the move had been signed and relayed.
    expect(moved.status).toBe(200);
    expect(moved.body.chainStale).toBe(true);
    // Fix round 1 (review M6): the RPC's own answer, not viem's first line.
    expect(moved.body.chainStaleReason).toBe('the RPC is rate-limiting (-32005 "rate limit exceeded")');
    expect(moved.body.turnNum).toBe("1");
    expect(moved.body.lastMove).toEqual({ from: "e2", to: "e4", san: "e4" });
    expect((await call(bobApi.url, bobToken, "GET", "/wait?timeout=10")).body.reason).toBe("your-turn"); // it took effect
    // Board rate-limit fix: a read-only route answers the last known view the same way -- the move is in it. Before: a
    // 503 ("the RPC is rate-limiting (…): wait a few seconds, then retry"), which left the board with nothing to show.
    // (Board fix round 1: past the read routes' 5 s cache of the watchtower's last good read, which would answer fresh.)
    for (const cid of d.channelIds()) d.handle(cid).chainReadAt = 0;
    const st = await call(url, token, "GET", "/status");
    expect(st.status).toBe(200);
    expect(st.body.chainStale).toBe(true);
    expect(st.body.chainStaleReason).toBe('the RPC is rate-limiting (-32005 "rate limit exceeded")');
    expect(st.body.turnNum).toBe("1");
    // An action that fails is still an error.
    expect((await call(url, token, "POST", "/move", { move: "d4" })).status).toBe(409);
    limit.on = false;
    // Board fix round 1: the watchtower's next good read ends the read routes' rate-limit back-off.
    const fresh = await waitFor(async () => {
      const r = await call(url, token, "GET", "/status");
      return r.body.chainStale === undefined ? r : null;
    }, 15_000, "a fresh status");
    expect(fresh.status).toBe(200);
    expect(fresh.body.chainStale).toBeUndefined();
  });

  it("H3 fix round 1 (review M4, M5): a close whose submission is rate-limited, and a mined challenge with no receipt, took effect", async () => {
    const pair = await startPair();
    const token = loadToken(pair.alice.home);
    const { server, url } = await startApi(pair.alice.daemon, { port: 0, token });
    stop = async () => {
      server.close();
      await pair.cleanup();
    };
    const call = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
      const res = await fetch(`${url}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-arena-actor": "agent" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: res.status, body: await res.json() };
    };
    const { alice, bob } = pair;
    const { offerId } = await alice.daemon.createOffer({ deposit: 1_000_000n, stakePerGame: 100_000n, challengeTimeout: 600n });
    await bob.daemon.acceptOffer(offerId);
    const id = await waitFor(() => alice.daemon.channelIds()[0], 20_000, "match");
    await waitFor(async () => (await alice.daemon.hub.channelInfo(id)).phase === "Open", 30_000, "open");

    // M4, challenge: mined, its receipt unreadable -- a 200 that says so, never a 500.
    await alice.daemon.move(id, "e4", { actor: "agent", offerDraw: true });
    const realChallenge = alice.daemon.hub.challenge.bind(alice.daemon.hub);
    alice.daemon.hub.challenge = async (...args: Parameters<typeof realChallenge>) => {
      const r = await realChallenge(...args);
      throw new TxReceiptMissingError(r.transactionHash, r.blockNumber);
    };
    const ch = await call("POST", "/challenge");
    expect(ch.status).toBe(200);
    expect(ch.body.phase).toBe("Challenged");
    expect(ch.body.chainStale).toBe(true);
    expect(ch.body.chainStaleReason).toMatch(
      /^the challenge transaction 0x[0-9a-f]{64} was mined \(block \d+\), but its receipt could not be read: whether it succeeded is not known yet; check status$/,
    );
    expect(ch.body.unconfirmed).toBe(ch.body.chainStaleReason); // final fix wave B (m-7): the CLI's note keys on it
    alice.daemon.hub.challenge = realChallenge;

    // M4, close: Bob accepts the draw (answering the challenge) and closes; Alice's close is signed and relayed, and
    // only its on-chain submission is rate-limited.
    await waitFor(() => bob.daemon.handle(id).session.isMyTurn(), 10_000, "bob's turn");
    await bob.daemon.acceptDraw(id, "agent");
    await waitFor(async () => (await alice.daemon.status(id)).attention === "game-over", 20_000, "draw seen");
    await bob.daemon.close(id, "agent");
    await waitFor(async () => (await alice.daemon.status(id)).attention === "close-requested", 10_000, "close requested");
    const limit = { on: true };
    const realInfo = alice.daemon.hub.channelInfo.bind(alice.daemon.hub);
    alice.daemon.hub.channelInfo = async (cid: Hex) => {
      if (limit.on) throw new LimitExceededRpcError(new Error("rate limit exceeded"));
      return realInfo(cid);
    };
    const closed = await call("POST", "/close");
    // Before: a 503 for a Close that had been signed and relayed.
    expect(closed.status).toBe(200);
    expect(closed.body.chainStale).toBe(true);
    expect(closed.body.lastError).toMatch(/^close: Request exceeds defined limit/);
    limit.on = false;
    await waitFor(async () => (await realInfo(id)).phase === "Finalized", 30_000, "settled by the watchtower's retry (or Bob's)");

    // M5: the host's own 429 is no RPC error: named as either.
    alice.daemon.listOffers = async () => {
      throw new Error("rate limited"); // as host.ts throws the host's 429
    };
    const offers = await call("GET", "/offers");
    expect(offers.status).toBe(503);
    expect(offers.body.error).toMatch(/^rate-limited \(RPC or host\) \(rate limited\): wait a few seconds/);
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

  it("H1: POST /offers takes ttl (seconds) for the offer's signed expiresAt; out of range or malformed is 400", async () => {
    const pair = await startPair();
    const token = loadToken(pair.alice.home);
    const { server, url } = await startApi(pair.alice.daemon, { port: 0, token });
    stop = async () => {
      server.close();
      await pair.cleanup();
    };
    const post = (body: Record<string, unknown>) =>
      fetch(`${url}/offers`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ deposit: "1000000", stakePerGame: "100000", ...body }),
      });
    const before = (await pair.alice.daemon.client.getBlock()).timestamp;
    const res = await post({ ttl: "120" });
    expect(res.status).toBe(200);
    const { offerId } = (await res.json()) as { offerId: string };
    const after = (await pair.alice.daemon.client.getBlock()).timestamp;
    const offer = (await pair.alice.daemon.listOffers()).find((o) => o.offerId === offerId)!.offer;
    expect(offer.expiresAt >= before + 120n && offer.expiresAt <= after + 120n).toBe(true);
    for (const ttl of ["59", "3601"]) {
      const bad = await post({ ttl });
      expect(bad.status).toBe(400);
      expect(((await bad.json()) as { error: string }).error).toMatch(/ttl must be between 60 and 3600 seconds/);
    }
    // Without ttl, the lifetime is the default, unchanged: an hour.
    const dflt = (await (await post({})).json()) as { offerId: string };
    const now = (await pair.alice.daemon.client.getBlock()).timestamp;
    const d = (await pair.alice.daemon.listOffers()).find((o) => o.offerId === dflt.offerId)!.offer;
    expect(d.expiresAt > now + 3500n && d.expiresAt <= now + 3600n).toBe(true);
    const malformed = await post({ ttl: 120 });
    expect(malformed.status).toBe(400);
    expect(((await malformed.json()) as { error: string }).error).toBe("ttl must be a decimal string of seconds");
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

    // Final fix wave: the board never imported chess.js, so its vendored copy is no longer served (nor read at
    // module load, where a moved file would have stopped the whole API loading).
    expect((await fetch(`${url}/board/vendor/chess.js`)).status).toBe(404);

    // No token anywhere above -- static routes carry no data. Everything else under /board, including a
    // traversal attempt (plain or percent-encoded), gets 404, not the daemon's config/token files.
    expect((await fetch(`${url}/board/nope.js`)).status).toBe(404);
    expect((await rawRequest(port, { hostHeader: `127.0.0.1:${port}`, path: "/board/../config.json" })).status).toBe(404);
    expect((await rawRequest(port, { hostHeader: `127.0.0.1:${port}`, path: "/board/..%2fconfig.json" })).status).toBe(404);
  });

  it("final fix wave M1: POST /board/code mints a single-use code that expires after 120 s; POST /board/session trades it for the token", async () => {
    const pair = await startPair();
    const token = loadToken(pair.alice.home);
    let now = 1_000_000;
    const { server, url } = await startApi(pair.alice.daemon, { port: 0, token, board: { now: () => now } });
    stop = async () => {
      server.close();
      await pair.cleanup();
    };
    const mint = () =>
      fetch(`${url}/board/code`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" } });
    const exchange = (code: unknown) =>
      fetch(`${url}/board/session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }) });

    // Minting needs the token (a data route, not a static one).
    expect((await fetch(`${url}/board/code`, { method: "POST" })).status).toBe(401);
    expect((await fetch(`${url}/board/code`, { method: "POST", headers: { authorization: "Bearer wrong" } })).status).toBe(401);
    const minted = await mint();
    expect(minted.status).toBe(200);
    const { code } = (await minted.json()) as { code: string };
    expect(code).toMatch(/^[A-Za-z0-9_-]{22}$/); // 128 bits, base64url

    // The exchange needs no bearer token: the code is the credential. The token comes back in the body only.
    const session = await exchange(code);
    expect(session.status).toBe(200);
    expect(session.headers.get("cache-control")).toBe("no-store");
    expect(await session.json()).toEqual({ token });
    expect((await exchange(code)).status).toBe(401); // single-use
    expect((await exchange("not-a-code")).status).toBe(401);
    expect((await exchange(undefined)).status).toBe(401);

    // Expiry: 120 s after it is minted.
    const { code: late } = (await (await mint()).json()) as { code: string };
    now += 120_000;
    expect((await exchange(late)).status).toBe(401);
    const { code: inTime } = (await (await mint()).json()) as { code: string };
    now += 119_000;
    expect((await exchange(inTime)).status).toBe(200);

    // Neither route answers any other method (the static board's 404).
    expect((await fetch(`${url}/board/session`)).status).toBe(404);
    expect((await fetch(`${url}/board/code`)).status).toBe(404);
  });

  it("final fix wave M1: POST /board/session is rate-limited to 10 attempts per minute", async () => {
    const pair = await startPair();
    const token = loadToken(pair.alice.home);
    let now = 5_000_000;
    const { server, url } = await startApi(pair.alice.daemon, { port: 0, token, board: { now: () => now } });
    stop = async () => {
      server.close();
      await pair.cleanup();
    };
    const mint = async () =>
      (
        (await (
          await fetch(`${url}/board/code`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" } })
        ).json()) as { code: string }
      ).code;
    const exchange = (code: unknown) =>
      fetch(`${url}/board/session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }) });
    for (let i = 0; i < 10; i++) expect((await exchange(`guess-${i}`)).status).toBe(401);
    const valid = await mint();
    // The 11th attempt inside the minute is refused before the code is even looked at -- a valid one included.
    const limited = await exchange(valid);
    expect(limited.status).toBe(429);
    expect(JSON.stringify(await limited.json())).not.toContain(token);
    now += 60_001; // the window slides
    expect((await exchange(valid)).status).toBe(200); // not consumed by the refused attempt
  });

  it("final fix wave M1 follow-up: every POST needs Content-Type: application/json (415), so a no-cors page cannot drain /board/session", async () => {
    const pair = await startPair();
    const token = loadToken(pair.alice.home);
    const { server, url } = await startApi(pair.alice.daemon, { port: 0, token });
    stop = async () => {
      server.close();
      await pair.cleanup();
    };
    const post = (path: string, headers: Record<string, string>, body?: string) => fetch(`${url}${path}`, { method: "POST", headers, body });
    // The "simple" (preflight-free) shapes a cross-origin no-cors page can send: text/plain, a form, or no body type.
    const simple: Array<Record<string, string>> = [
      { "content-type": "text/plain;charset=UTF-8" },
      { "content-type": "application/x-www-form-urlencoded" },
      { "content-type": "multipart/form-data; boundary=x" },
      {},
    ];
    for (let round = 0; round < 5; round++) {
      for (const h of simple) {
        const r = await post("/board/session", h, '{"code":"guess"}');
        expect(r.status).toBe(415);
      }
    }
    // Twenty refused simple POSTs later, the whole budget is still there: 10 JSON attempts get their 401, the 11th
    // is rate-limited.
    for (let i = 0; i < 10; i++) {
      expect((await post("/board/session", { "content-type": "application/json" }, JSON.stringify({ code: `g${i}` }))).status).toBe(401);
    }
    expect((await post("/board/session", { "content-type": "application/json" }, JSON.stringify({ code: "g" }))).status).toBe(429);

    // Every other POST too, after the token check (a request with no token still gets 401 first).
    const auth = { authorization: `Bearer ${token}` };
    expect((await post("/board/code", { ...auth, "content-type": "text/plain" })).status).toBe(415);
    expect((await post("/board/code", auth)).status).toBe(415);
    expect((await post("/handoff", { ...auth, "content-type": "text/plain" }, '{"to":"human"}')).status).toBe(415);
    expect((await post("/sweep", auth)).status).toBe(415);
    expect((await post("/handoff", { "content-type": "text/plain" }, '{"to":"human"}')).status).toBe(401);
    // JSON with a charset parameter is still JSON.
    expect((await post("/sweep", { ...auth, "content-type": "application/json; charset=utf-8" })).status).toBe(200);
    expect((await post("/board/code", { ...auth, "Content-Type": "Application/JSON" })).status).toBe(200);
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

describe("H4 fix round 2: /health names the process to this home's token", () => {
  it("with the token: {ok, pid, lock, role, degraded}; without it, or without an identity, the bare {ok}", async () => {
    const pair = await startPair();
    const token = loadToken(pair.alice.home);
    const lockNonce = "ab".repeat(16);
    const named = await startApi(pair.alice.daemon, { port: 0, token, identity: { lockNonce, role: "daemon" } });
    const bare = await startApi(pair.bob.daemon, { port: 0, token: loadToken(pair.bob.home) });
    stop = async () => {
      named.server.close();
      bare.server.close();
      await pair.cleanup();
    };
    const health = async (url: string, tok?: string) =>
      (await fetch(`${url}/health`, tok !== undefined ? { headers: { authorization: `Bearer ${tok}` } } : {})).json();
    expect(await health(named.url, token)).toEqual({ ok: true, pid: process.pid, lock: lockNonce, role: "daemon", degraded: [] });
    expect(await health(named.url)).toEqual({ ok: true });
    expect(await health(named.url, "wrong")).toEqual({ ok: true });
    expect(await health(bare.url, loadToken(pair.bob.home))).toEqual({ ok: true });
    // Final fix wave B (m-4): a channel the daemon does not watch is named, to the token only.
    const broken = `0x${"cd".repeat(32)}`;
    (pair.alice.daemon as unknown as { markDegraded(id: string, error: string): void }).markDegraded(broken, "session.json is unreadable");
    expect(((await health(named.url, token)) as { degraded: string[] }).degraded).toEqual([broken]);
    expect(await health(named.url)).toEqual({ ok: true });
  });
});
