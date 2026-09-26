import { afterEach, describe, expect, it } from "vitest";
import { loadToken, startApi } from "../src/index.js";
import { startPair, waitFor } from "./helpers/harness.js";

let stop: (() => Promise<void>) | undefined;
afterEach(async () => {
  await stop?.();
  stop = undefined;
});

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
});
