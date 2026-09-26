import { randomBytes } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import { WebSocketServer } from "ws";
import { connectHost } from "@arena/cli";
import {
  offerId as computeOfferId,
  signAcceptance,
  signOffer,
  toWire,
  type Acceptance,
  type MatchEvent,
  type Offer,
  type RelayMessage,
  type SignedAcceptance,
  type SignedOffer,
} from "@arena/sdk";
import { DEFAULT_LIMITS } from "../src/config.js";
import { startServer, type ArenaServer } from "../src/server.js";
import { FakeChain, testConfig } from "./helpers/fakeChain.js";
import { makeChannelFixture, rawStateAt, signStateAs } from "./helpers/channel.js";
import { wsConnect } from "./helpers/wsClient.js";

let server: ArenaServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

/** Polls `fn` until it returns truthy, or throws after `ms`. */
async function waitFor(fn: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  for (;;) {
    if (fn()) return;
    if (Date.now() > end) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 20));
  }
}

function randomNonce(): Hex {
  return `0x${randomBytes(32).toString("hex")}` as Hex;
}

async function makeOffer(over: Partial<Offer> = {}): Promise<{ offer: Offer; so: SignedOffer; signerKey: Hex }> {
  const signerKey = generatePrivateKey();
  const offer: Offer = {
    template: "chess",
    player: privateKeyToAccount(generatePrivateKey()).address,
    signer: privateKeyToAccount(signerKey).address,
    deposit: 1_000_000n,
    stakePerGame: 100_000n,
    challengeTimeout: 600n,
    expiresAt: 1_003_600n, // FakeChain starts at time = 1_000_000n; well within offerMaxLifetime (86_400n)
    nonce: randomNonce(),
    ...over,
  };
  const so: SignedOffer = { offer, sig: await signOffer(signerKey, offer) };
  return { offer, so, signerKey };
}

async function makeAcceptance(offerId: Hex): Promise<SignedAcceptance> {
  const signerKey = generatePrivateKey();
  const acceptance: Acceptance = {
    offerId,
    player: privateKeyToAccount(generatePrivateKey()).address,
    signer: privateKeyToAccount(signerKey).address,
    nonce: randomNonce(),
  };
  return { acceptance, sig: await signAcceptance(signerKey, acceptance) };
}

describe("host transports (connectHost) against a real server", () => {
  it("postOffer/listOffers/accept round-trip; accept emits the match locally and to the watching offerer", async () => {
    server = await startServer(testConfig(), { chain: new FakeChain() });
    const hostA = connectHost(server.url); // the offerer, watching its own offer
    const hostB = connectHost(server.url); // the accepter
    try {
      await waitFor(() => hostA.connected() && hostB.connected());
      const { offer, so } = await makeOffer();
      const id = await hostA.lobby.postOffer(so); // postOffer also calls watch([id])
      expect(id).toBe(computeOfferId(offer));

      const listed = await hostB.lobby.listOffers();
      expect(listed).toContainEqual(so);

      const remoteMatches: MatchEvent[] = [];
      hostA.lobby.onMatch((m) => remoteMatches.push(m));
      const localMatches: MatchEvent[] = [];
      hostB.lobby.onMatch((m) => localMatches.push(m));

      const sa = await makeAcceptance(id);
      await hostB.lobby.accept(sa);

      // The accepter's own onMatch fires locally (setTimeout 0) *and*, since accept() also calls watch([id]),
      // is very likely replayed a second time once that subscribe reaches the server -- both are specified
      // behavior, so this only asserts that the local emission happened, not an exact count.
      await waitFor(() => localMatches.length >= 1); // emitted locally, without waiting on a server round trip
      expect(localMatches[0].offerId).toBe(id);
      await waitFor(() => remoteMatches.length === 1); // pushed over /ws to the watching offerer, exactly once
      expect(remoteMatches[0].offerId).toBe(id);
    } finally {
      hostA.close();
      hostB.close();
    }
  });

  it("watch() replays a match made while the offerer was not connected", async () => {
    server = await startServer(testConfig(), { chain: new FakeChain() });
    const hostA = connectHost(server.url);
    await waitFor(() => hostA.connected());
    const { so } = await makeOffer();
    const id = await hostA.lobby.postOffer(so);
    hostA.close(); // the offerer goes offline

    const hostB = connectHost(server.url);
    await waitFor(() => hostB.connected());
    await hostB.lobby.accept(await makeAcceptance(id));
    hostB.close();

    const hostA2 = connectHost(server.url); // the offerer reconnects, fresh
    try {
      await waitFor(() => hostA2.connected());
      const matches: MatchEvent[] = [];
      hostA2.lobby.onMatch((m) => matches.push(m));
      hostA2.lobby.watch([id]);
      await waitFor(() => matches.length === 1);
      expect(matches[0].offerId).toBe(id);
    } finally {
      hostA2.close();
    }
  });

  it("relay: join with a signer (never a key), send, receive; onJoined fires on join", async () => {
    const cfg = testConfig();
    server = await startServer(cfg, { chain: new FakeChain() });
    const fx = makeChannelFixture(cfg, server.repo);
    const hostA = connectHost(server.url);
    const hostB = connectHost(server.url);
    try {
      await waitFor(() => hostA.connected() && hostB.connected());
      const joinedA: Hex[] = [];
      hostA.relay.onJoined((id) => joinedA.push(id));
      const joinedB: Hex[] = [];
      hostB.relay.onJoined((id) => joinedB.push(id));

      // `privateKeyToAccount` returns a RelaySigner ({address, signMessage}); the raw key never crosses into
      // host.ts, which only ever calls signer.signMessage(...) (I5).
      await hostA.relay.join(fx.id, fx.params, privateKeyToAccount(fx.kA));
      await hostB.relay.join(fx.id, fx.params, privateKeyToAccount(fx.kB));
      await waitFor(() => joinedA.includes(fx.id) && joinedB.includes(fx.id));

      const received: RelayMessage[] = [];
      hostB.relay.onMessage((m) => received.push(m));
      const s1 = await signStateAs(fx, rawStateAt(fx, 1n), 0);
      await hostA.relay.send({ type: "state", channelId: fx.id, signed: s1 });
      await waitFor(() => received.length === 1);
      expect(received[0]).toEqual({ type: "state", channelId: fx.id, signed: s1 });
    } finally {
      hostA.close();
      hostB.close();
    }
  });

  it("reconnects after the server drops connections and re-joins + re-subscribes; onJoined fires again", async () => {
    const cfg = testConfig();
    server = await startServer(cfg, { chain: new FakeChain() });
    const fx = makeChannelFixture(cfg, server.repo);
    const hostA = connectHost(server.url, { minBackoffMs: 20, maxBackoffMs: 100 });
    const hostB = connectHost(server.url, { minBackoffMs: 20, maxBackoffMs: 100 });
    try {
      await waitFor(() => hostA.connected() && hostB.connected());
      let joinedACount = 0;
      hostA.relay.onJoined(() => joinedACount++);
      let joinedBCount = 0;
      hostB.relay.onJoined(() => joinedBCount++);

      await hostA.relay.join(fx.id, fx.params, privateKeyToAccount(fx.kA));
      await hostB.relay.join(fx.id, fx.params, privateKeyToAccount(fx.kB));
      await waitFor(() => joinedACount === 1 && joinedBCount === 1);

      const received: RelayMessage[] = [];
      hostB.relay.onMessage((m) => received.push(m));

      // hostA also watches an offer before the drop. The match for it is made over HTTP (unaffected by the ws
      // drop) *while hostA is disconnected*, so the only way hostA can learn of it is the re-subscribe its
      // reconnect sends on the next `hello` -- this is what proves re-subscribe coverage, not just re-join.
      const { so } = await makeOffer();
      const offerId = await hostA.lobby.postOffer(so);
      const matches: MatchEvent[] = [];
      hostA.lobby.onMatch((m) => matches.push(m));

      server.dropConnections();
      await hostB.lobby.accept(await makeAcceptance(offerId));

      await waitFor(() => joinedACount === 2 && joinedBCount === 2, 10_000);
      await waitFor(() => hostA.connected() && hostB.connected(), 10_000);
      await waitFor(() => matches.length >= 1, 10_000); // replayed via the re-subscribe on reconnect
      expect(matches[0].offerId).toBe(offerId);

      const s1 = await signStateAs(fx, rawStateAt(fx, 1n), 0);
      await hostA.relay.send({ type: "state", channelId: fx.id, signed: s1 });
      await waitFor(() => received.length === 1, 10_000);
      expect(received[0]).toEqual({ type: "state", channelId: fx.id, signed: s1 });
    } finally {
      hostA.close();
      hostB.close();
    }
  });

  it("send() rejects once the socket has actually disconnected", async () => {
    const cfg = testConfig();
    server = await startServer(cfg, { chain: new FakeChain() });
    const fx = makeChannelFixture(cfg, server.repo);
    const hostA = connectHost(server.url);
    try {
      await waitFor(() => hostA.connected());
      await hostA.relay.join(fx.id, fx.params, privateKeyToAccount(fx.kA));

      server.dropConnections();
      await waitFor(() => !hostA.connected());

      const s1 = await signStateAs(fx, rawStateAt(fx, 1n), 0);
      await expect(hostA.relay.send({ type: "state", channelId: fx.id, signed: s1 })).rejects.toThrow(
        /relay not connected/,
      );
    } finally {
      hostA.close();
    }
  });

  it("a join refused by the server is not retried on every future hello", async () => {
    const cfg = testConfig();
    server = await startServer(cfg, { chain: new FakeChain() });
    const fx = makeChannelFixture(cfg, server.repo);
    const outsider = generatePrivateKey(); // not one of fx.params.signers
    const logs: string[] = [];
    const hostA = connectHost(server.url, { minBackoffMs: 20, maxBackoffMs: 100, log: (l) => logs.push(l) });
    try {
      await waitFor(() => hostA.connected());
      await expect(hostA.relay.join(fx.id, fx.params, privateKeyToAccount(outsider))).rejects.toThrow(
        /not a member/,
      );
      await waitFor(() => logs.some((l) => l.includes("refused")));

      server.dropConnections();
      // wait for the client to see the drop first: otherwise `connected()` can still be true of the old socket and
      // the assertion below would pass without any reconnect having happened
      await waitFor(() => !hostA.connected());
      await waitFor(() => hostA.connected());
      expect(logs.some((l) => l.includes("reconnecting in"))).toBe(true);
      await new Promise((r) => setTimeout(r, 200)); // a resend-on-hello, if it happened, would show up by now
      expect(logs.filter((l) => l.includes("not a member")).length).toBe(1); // not repeated on the reconnect
    } finally {
      hostA.close();
    }
  });

  it("an unknown-channel refusal is permanent: the channel is not re-joined on the next hello", async () => {
    const cfg = testConfig();
    server = await startServer(cfg, { chain: new FakeChain() });
    const fx = makeChannelFixture(cfg); // self-minted: never matched or indexed by this host
    const logs: string[] = [];
    const hostA = connectHost(server.url, { minBackoffMs: 20, maxBackoffMs: 100, log: (l) => logs.push(l) });
    try {
      await waitFor(() => hostA.connected());
      await expect(hostA.relay.join(fx.id, fx.params, privateKeyToAccount(fx.kA))).rejects.toThrow(/unknown channel/);
      await waitFor(() => logs.some((l) => l.includes("refused permanently")));

      server.dropConnections();
      await waitFor(() => !hostA.connected());
      await waitFor(() => hostA.connected());
      await new Promise((r) => setTimeout(r, 200)); // a resend-on-hello, if it happened, would show up by now
      expect(logs.filter((l) => l.includes("unknown channel")).length).toBe(1);
    } finally {
      hostA.close();
    }
  });

  it("a transient join refusal (too many channels on this connection) is retried after a reconnect", async () => {
    // A per-connection capacity error names no permanent property of the join itself (a fresh connection with
    // fewer other channels already joined could accept the very same join) -- unlike "not a member of this
    // channel" above, it must stay registered and be retried on the next `hello`, not dropped.
    const cfg = testConfig({ limits: { ...DEFAULT_LIMITS, maxJoinsPerConnection: 1 } });
    server = await startServer(cfg, { chain: new FakeChain() });
    const fx1 = makeChannelFixture(cfg, server.repo);
    const fx2 = makeChannelFixture(cfg, server.repo);
    const logs: string[] = [];
    const hostA = connectHost(server.url, { minBackoffMs: 20, maxBackoffMs: 100, log: (l) => logs.push(l) });
    try {
      await waitFor(() => hostA.connected());
      await hostA.relay.join(fx1.id, fx1.params, privateKeyToAccount(fx1.kA)); // takes the connection's one slot
      await expect(hostA.relay.join(fx2.id, fx2.params, privateKeyToAccount(fx2.kA))).rejects.toThrow(
        /too many channels/,
      );
      await waitFor(() => logs.some((l) => l.includes("will retry")));

      server.dropConnections();
      await waitFor(() => !hostA.connected());
      await waitFor(() => hostA.connected());
      // The fresh connection re-attempts fx1 and fx2 (in that registration order) on its next `hello`; fx1 still
      // wins the connection's one slot first, so fx2 is refused again -- proving fx2's join was resent, not
      // silently dropped after the first refusal.
      await waitFor(() => logs.filter((l) => l.includes("too many channels")).length >= 2, 10_000);
    } finally {
      hostA.close();
    }
  });

  it("leave() frees the channel's slot: a second channel joins over the one-channel limit", async () => {
    const cfg = testConfig({ limits: { ...DEFAULT_LIMITS, maxJoinsPerConnection: 1 } });
    server = await startServer(cfg, { chain: new FakeChain() });
    const fx1 = makeChannelFixture(cfg, server.repo);
    const fx2 = makeChannelFixture(cfg, server.repo);
    const hostA = connectHost(server.url, { minBackoffMs: 20, maxBackoffMs: 100 });
    try {
      await waitFor(() => hostA.connected());
      await hostA.relay.join(fx1.id, fx1.params, privateKeyToAccount(fx1.kA));
      hostA.relay.leave(fx1.id);
      await hostA.relay.join(fx2.id, fx2.params, privateKeyToAccount(fx2.kA)); // resolves only on `joined`

      // after a reconnect only fx2 is re-joined: fx1 was left for good
      const rejoined: Hex[] = [];
      hostA.relay.onJoined((id) => rejoined.push(id));
      server.dropConnections();
      await waitFor(() => !hostA.connected());
      await waitFor(() => rejoined.includes(fx2.id), 5_000);
      await new Promise((r) => setTimeout(r, 200));
      expect(rejoined).toEqual([fx2.id]);
    } finally {
      hostA.close();
    }
  });

  it("re-joins after a reconnect are paced under the server's frame rate limit", async () => {
    // a burst budget far below the channel count: an unpaced burst of re-joins would be closed with 1008
    const limits = { ...DEFAULT_LIMITS, wsFrameBurst: 10, wsFramePerSec: 60 };
    const cfg = testConfig({ limits });
    server = await startServer(cfg, { chain: new FakeChain() });
    const fxs = Array.from({ length: 30 }, () => makeChannelFixture(cfg, server!.repo));
    const hostA = connectHost(server.url, { minBackoffMs: 20, maxBackoffMs: 100 });
    try {
      await waitFor(() => hostA.connected());
      for (const fx of fxs) {
        await hostA.relay.join(fx.id, fx.params, privateKeyToAccount(fx.kA));
        await new Promise((r) => setTimeout(r, 25)); // the test's own joins stay under the limit too
      }
      const rejoined = new Set<Hex>();
      hostA.relay.onJoined((id) => rejoined.add(id));
      let drops = 0;
      server.dropConnections();
      await waitFor(() => !hostA.connected());
      const watch = setInterval(() => {
        if (!hostA.connected()) drops++;
      }, 5);
      try {
        await waitFor(() => hostA.connected());
        drops = 0; // only disconnects after the reconnect count
        await waitFor(() => rejoined.size === fxs.length, 10_000);
      } finally {
        clearInterval(watch);
      }
      expect(drops).toBe(0);
      expect(hostA.connected()).toBe(true);
    } finally {
      hostA.close();
    }
  });

  it("an immediate close after hello does not reset the reconnect backoff (M8)", async () => {
    const httpServer = http.createServer();
    const wss = new WebSocketServer({ server: httpServer });
    wss.on("connection", (ws) => {
      ws.send(toWire({ type: "hello", nonce: `0x${"00".repeat(32)}` }));
      ws.close(1008, "rate limited"); // accepted, greeted, then dropped at once
    });
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const port = (httpServer.address() as AddressInfo).port;
    const delays: number[] = [];
    const min = 20;
    const host = connectHost(`http://127.0.0.1:${port}`, {
      minBackoffMs: min,
      maxBackoffMs: 10_000,
      log: (l) => {
        const m = /reconnecting in (\d+) ms/.exec(l);
        if (m) delays.push(Number(m[1]));
      },
    });
    try {
      await waitFor(() => delays.length >= 3, 5_000);
      // attempt k waits min * 2^k plus up to `min` of jitter, so each band is disjoint from the one before
      expect(delays[1]).toBeGreaterThan(delays[0]);
      expect(delays[1]).toBeGreaterThanOrEqual(2 * min);
      expect(delays[2]).toBeGreaterThanOrEqual(4 * min);
    } finally {
      host.close();
      wss.close();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
  });

  it("close() rejects a pending join() wait instead of leaving it hanging for the full timeout", async () => {
    // A tiny stand-in server that sends `hello` and then never answers a `join` -- so the only thing that can
    // ever settle the pending join() promise is close() itself, not a (would-be 10s) timeout.
    const httpServer = http.createServer();
    const wss = new WebSocketServer({ server: httpServer });
    wss.on("connection", (ws) => {
      ws.send(toWire({ type: "hello", nonce: `0x${"00".repeat(32)}` }));
    });
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const port = (httpServer.address() as AddressInfo).port;
    const fx = makeChannelFixture(testConfig());
    const host = connectHost(`http://127.0.0.1:${port}`);
    try {
      await waitFor(() => host.connected());
      const joinPromise = host.relay.join(fx.id, fx.params, privateKeyToAccount(fx.kA));
      await new Promise((r) => setTimeout(r, 50)); // let the join frame go out and the wait start
      host.close();
      await expect(joinPromise).rejects.toThrow(/host closed/);
    } finally {
      wss.close();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
  });

  it("the server sends an app-level ping frame on its interval (M7)", async () => {
    server = await startServer(testConfig(), { chain: new FakeChain(), wsPingMs: 50 });
    const c = await wsConnect(server.url);
    try {
      expect(await c.next((f) => f.type === "ping", 2_000)).toEqual({ type: "ping" });
    } finally {
      c.ws.close();
    }
  });

  it("a silent connection is dropped and replaced after idleTimeoutMs; pings keep a live one (M7)", async () => {
    let connections = 0;
    let pinging = false;
    const httpServer = http.createServer();
    const wss = new WebSocketServer({ server: httpServer });
    wss.on("connection", (ws) => {
      connections++;
      ws.send(toWire({ type: "hello", nonce: `0x${"00".repeat(32)}` }));
      if (!pinging) return; // half-open from the client's point of view: nothing ever arrives again
      const t = setInterval(() => ws.send(toWire({ type: "ping" })), 50);
      ws.on("close", () => clearInterval(t));
    });
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
    const logs: string[] = [];
    const opts = { minBackoffMs: 20, maxBackoffMs: 50, idleTimeoutMs: 200, log: (l: string) => logs.push(l) };
    const silent = connectHost(url, opts);
    try {
      await waitFor(() => connections >= 2, 3_000); // the watchdog gave up on the first and reconnected
      expect(logs.some((l) => l.includes("no frame from the server"))).toBe(true);
    } finally {
      silent.close();
    }

    pinging = true;
    connections = 0;
    logs.length = 0;
    const live = connectHost(url, opts);
    try {
      await waitFor(() => live.connected());
      await new Promise((r) => setTimeout(r, 700)); // several idle timeouts' worth of pings
      expect(connections).toBe(1);
      expect(live.connected()).toBe(true);
      expect(logs).toEqual([]); // pings are neither "malformed" nor an "unknown frame type"
    } finally {
      live.close();
      wss.close();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
  });

  it("the lobby surfaces the server's error message on a rejected request", async () => {
    server = await startServer(testConfig(), { chain: new FakeChain() });
    const hostA = connectHost(server.url);
    try {
      await waitFor(() => hostA.connected());
      const { so } = await makeOffer({ stakePerGame: 0n }); // rejected by the lobby (400)
      await expect(hostA.lobby.postOffer(so)).rejects.toThrow(/stakePerGame must be greater than 0/);
    } finally {
      hostA.close();
    }
  });

  it("drops malformed server frames without crashing (log called)", async () => {
    // A tiny stand-in server (not `startServer`) that sends a well-formed `hello` and then a frame that fails to
    // parse as a RelayMessage -- exercising the CLI transport's own frame validation, not the real server's.
    const httpServer = http.createServer();
    const wss = new WebSocketServer({ server: httpServer });
    wss.on("connection", (ws) => {
      ws.send(toWire({ type: "hello", nonce: `0x${"00".repeat(32)}` }));
      ws.send(toWire({ type: "relay", message: { type: "state" } })); // missing channelId/signed
    });
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const port = (httpServer.address() as AddressInfo).port;

    const logs: string[] = [];
    const host = connectHost(`http://127.0.0.1:${port}`, { log: (l) => logs.push(l) });
    try {
      await waitFor(() => logs.some((l) => l.includes("malformed")));
    } finally {
      host.close();
      wss.close();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
  });

  it("close() stops reconnecting", async () => {
    server = await startServer(testConfig(), { chain: new FakeChain() });
    const host = connectHost(server.url, { minBackoffMs: 20, maxBackoffMs: 50 });
    await waitFor(() => host.connected());
    host.close();
    await new Promise((r) => setTimeout(r, 300)); // several backoff intervals: long enough to see a reconnect
    expect(host.connected()).toBe(false);
  });
});
