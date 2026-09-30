import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
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
): Promise<{ status: number; body: string }> {
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
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
      },
    );
    req.on("error", reject);
    req.end();
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
    expect((await call(url, token, "POST", "/move", { move: "d4" })).status).toBe(409);

    const w = await call(bobApi.url, bobToken, "GET", "/wait?timeout=10");
    expect(w.body.reason).toBe("your-turn");

    expect((await call(url, token, "POST", "/handoff", { to: "human", note: "n" })).body.controller).toBe("human");
    expect((await call(url, token, "POST", "/handoff", { to: "robot" })).status).toBe(400);
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
