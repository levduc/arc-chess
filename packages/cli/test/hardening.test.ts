import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import type { Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  ChannelSession,
  LocalKeyTxSender,
  buildParams,
  hashState,
  offerId as computeOfferId,
  signClose,
  type MatchEvent,
  type SignedAcceptance,
} from "@arena/sdk";
import { SCHOLARS_MATE } from "../../sdk/test/helpers/fixtures.js";
import { CHAIN, RPC, increaseTime, now, setLimits, setPaused } from "../../sdk/test/helpers/chain.js";
import { ArenaDaemon, DaemonError, FileSessionStore, RecordStore, arenaPaths, loadConfig, type ChannelRecord } from "../src/index.js";
import { startPair, waitFor } from "./helpers/harness.js";

/** Test-only escape hatch: onMatch/records are private/protected, but these tests craft host events. */
type Internals = { onMatch(m: MatchEvent): Promise<void>; records: { saveOffer(r: unknown): void } };
const internals = (d: ArenaDaemon): Internals => d as unknown as Internals;
const randomNonce = (): Hex => `0x${randomBytes(32).toString("hex")}`;

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function matched() {
  const pair = await startPair();
  cleanups.push(pair.cleanup);
  const { offerId } = await pair.alice.daemon.createOffer({ deposit: 1_000_000n, stakePerGame: 100_000n, challengeTimeout: 600n });
  await pair.bob.daemon.acceptOffer(offerId);
  const id = await waitFor(async () => {
    const [a, b] = [pair.alice.daemon.channelIds(), pair.bob.daemon.channelIds()];
    return a.length === 1 && b.length === 1 && a[0] === b[0] ? a[0] : null;
  }, 20_000, "match");
  await waitFor(async () => (await pair.alice.daemon.hub.channelInfo(id)).phase === "Open", 20_000, "funding");
  return { ...pair, id };
}

describe("I1: one bad channel entry never disables the watchtower", () => {
  it("P2 regression: start() survives corrupt entries, watches the valid channel and reports the rest as degraded", async () => {
    const { alice, id } = await matched();
    await alice.daemon.stop();
    const channels = join(alice.home, "channels");
    // (1) a truncated record.json
    const garbage = `0x${"ab".repeat(32)}`;
    mkdirSync(join(channels, garbage), { recursive: true });
    writeFileSync(join(channels, garbage, "record.json"), "{ truncated");
    // (2) a directory that is not a channel id at all
    mkdirSync(join(channels, "not-a-channel"), { recursive: true });
    // (3) a well-formed record whose params do not hash to its channelId (e.g. another hub/chain)
    const foreign = `0x${"cd".repeat(32)}` as const;
    const real = new RecordStore(alice.home).channel(id) as ChannelRecord;
    new RecordStore(alice.home).saveChannel({ ...real, channelId: foreign });

    const restarted = new ArenaDaemon({
      home: alice.home,
      config: loadConfig(alice.home),
      walletKey: alice.walletKey,
      lobby: alice.client.lobby,
      relay: alice.client.relay,
    });
    cleanups.push(() => restarted.stop());
    await expect(restarted.start()).resolves.toBeUndefined();

    // The valid channel is live, picked by default, and watched.
    expect(restarted.channelIds()).toEqual([id]);
    expect((await restarted.status()).phase).toBe("Open");
    await restarted.idle();
    const before = restarted.handle(id).passes;
    await restarted.tick();
    expect(restarted.handle(id).passes).toBeGreaterThan(before);

    // The bad entries are reported, not watched, and never picked.
    const listed = await restarted.channels();
    expect(listed).toHaveLength(4);
    const degraded = listed.filter((c) => "degraded" in c && c.degraded) as Array<{ channelId: string; error: string }>;
    expect(degraded.map((d) => d.channelId).sort()).toEqual([garbage, foreign, "not-a-channel"].sort());
    expect(degraded.find((d) => d.channelId === foreign)!.error).toMatch(/does not match this hub and chain/);
    expect(degraded.find((d) => d.channelId === "not-a-channel")!.error).toMatch(/canonical/);
    await expect(restarted.status(garbage)).rejects.toThrow(/could not be loaded/);
  });
});

describe("I1: a corrupt session file", () => {
  it("degrades only that channel: start() resolves and reports it", async () => {
    const { alice, id } = await matched();
    await alice.daemon.stop();
    writeFileSync(arenaPaths(alice.home).channelSession(id), "{ not json");
    const restarted = new ArenaDaemon({ home: alice.home, config: loadConfig(alice.home), walletKey: alice.walletKey, lobby: alice.client.lobby, relay: alice.client.relay });
    cleanups.push(() => restarted.stop());
    await expect(restarted.start()).resolves.toBeUndefined();
    expect(restarted.channelIds()).toEqual([]);
    expect(await restarted.channels()).toEqual([{ channelId: id, degraded: true, error: expect.any(String) }]);
  });
});

describe("I2: stalled and withheld states escalate instead of looping", () => {
  it("P1 regression: an opponent Close signature on a non-terminal state is refused and wait() does not hot-loop", async () => {
    const { alice, bob, id, env } = await matched();
    await alice.daemon.move(id, "e4", { actor: "agent" }); // now Bob's turn; Bob stalls
    await waitFor(() => bob.daemon.handle(id).session.isMyTurn(), 5_000, "bob turn");
    const s = bob.daemon.handle(id).session.latest.state;
    const sig = await signClose(bob.daemon.handle(id).record.sessionKey, s, env.domain);
    await bob.client.relay.send({ type: "close", channelId: id, close: { stateHash: hashState(s, env.domain), by: 1, sig } });
    await waitFor(() => /not a finished game/.test(alice.daemon.handle(id).lastError ?? ""), 5_000, "close refused");
    const st = await alice.daemon.status(id);
    expect(st.opponentWantsToClose).toBe(false);
    expect(st.attention).toBeNull();
    for (let i = 0; i < 2; i++) {
      const t0 = Date.now();
      await expect(alice.daemon.wait({ timeoutMs: 300 })).resolves.toEqual({ channelId: null, reason: "timeout" });
      expect(Date.now() - t0).toBeGreaterThanOrEqual(250);
    }
  });

  it("wait() returns opponent-silent once the opponent is silent on their move for more than challengeTimeout", async () => {
    const { alice, bob, id } = await matched();
    await alice.daemon.move(id, "e4", { actor: "agent" });
    await waitFor(() => bob.daemon.handle(id).session.isMyTurn(), 5_000, "bob turn");
    await bob.daemon.stop();
    bob.client.disconnect();
    await alice.daemon.status(id); // the move is observed as progress, on chain time
    expect(alice.daemon.handle(id).lastProgressAt).not.toBeNull();
    await expect(alice.daemon.wait({ timeoutMs: 300 })).resolves.toEqual({ channelId: null, reason: "timeout" });
    await increaseTime(601); // challengeTimeout is 600 s
    await expect(alice.daemon.wait({ timeoutMs: 10_000 })).resolves.toEqual({ channelId: id, reason: "opponent-silent" });
    const st = await alice.daemon.status(id);
    expect(st.attention).toBe("opponent-silent");
    expect(st.suggestedActions[0]).toMatch(/^arena challenge/);
    // Following the suggestion ends the silence alarm: the channel is now Challenged and Bob must answer on-chain.
    await alice.daemon.challenge(id, "agent");
    const after = await alice.daemon.status(id);
    expect(after.phase).toBe("Challenged");
    expect(after.attention).toBeNull();
  });
});

describe("I4: never-fundable offers and never-funded channels", () => {
  it("createOffer rejects offers the hub could never fund with 400", async () => {
    const pair = await startPair();
    cleanups.push(pair.cleanup);
    const d = pair.alice.daemon;
    const bad = [
      { deposit: 1_000_000n, stakePerGame: 0n, challengeTimeout: 600n, why: /stakePerGame must be greater than 0/ },
      { deposit: 99_999n, stakePerGame: 100_000n, challengeTimeout: 600n, why: /deposit must be at least stakePerGame/ },
      { deposit: 1_000_000n, stakePerGame: 100_000n, challengeTimeout: 59n, why: /challengeTimeout must be between 60 and 604800/ },
      { deposit: 1_000_000n, stakePerGame: 100_000n, challengeTimeout: 604_801n, why: /challengeTimeout must be between 60 and 604800/ },
    ];
    for (const { why, ...o } of bad) {
      const err = await d.createOffer(o).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(DaemonError);
      expect((err as DaemonError).code).toBe(400);
      expect((err as DaemonError).message).toMatch(why);
    }
    expect(await pair.alice.client.lobby.listOffers()).toEqual([]); // nothing was posted
    // The bounds themselves are fine, and so is deposit == stake.
    await expect(d.createOffer({ deposit: 100_000n, stakePerGame: 100_000n, challengeTimeout: 60n })).resolves.toHaveProperty("offerId");
    await expect(d.createOffer({ deposit: 100_000n, stakePerGame: 100_000n, challengeTimeout: 604_800n })).resolves.toHaveProperty("offerId");
  });

  it("retires a matched channel whose funding window passes with nobody funded (phase None)", async () => {
    const pair = await startPair();
    cleanups.push(pair.cleanup);
    const { alice, bob } = pair;
    const { offerId } = await alice.daemon.createOffer({ deposit: 1_000_000n, stakePerGame: 100_000n, challengeTimeout: 600n });
    const so = (await alice.client.lobby.listOffers()).find((o) => computeOfferId(o.offer) === offerId)!;
    // Bob holds an acceptance and receives a match that Alice never hears about, so the offerer never funds.
    const sessionKey = generatePrivateKey();
    internals(bob.daemon).records.saveOffer({ offerId, offer: so.offer, sessionKey, role: "accepter" });
    const terms = { rules: pair.env.rules, feeRecipient: pair.env.host, feePerPlayer: 5_000n, fundingWindow: 3600n };
    const acceptance = { offerId, player: bob.address, signer: privateKeyToAccount(sessionKey).address, nonce: randomNonce() };
    await internals(bob.daemon).onMatch({ offerId, params: buildParams(so.offer, acceptance, terms, await now()) });
    const [id] = bob.daemon.channelIds();
    expect(id).toBeDefined();
    expect((await bob.daemon.hub.channelInfo(id)).phase).toBe("None");
    expect(bob.daemon.handle(id).record.finalized).toBe(false);
    expect((await bob.daemon.status()).channelId).toBe(id); // still the one active channel

    await increaseTime(3601);
    await waitFor(() => bob.daemon.handle(id).record.finalized, 10_000, "retired");
    expect((await bob.daemon.hub.channelInfo(id)).phase).toBe("None");
    expect(new RecordStore(bob.home).channel(id)!.finalized).toBe(true); // persisted
    // It has left the active set, and is no longer polled.
    await expect(bob.daemon.status()).rejects.toThrow(/no active channel/);
    const st = await bob.daemon.status(id);
    expect(st.suggestedActions[0]).toMatch(/^done: the funding window closed/);
    await bob.daemon.idle();
    const passes = bob.daemon.handle(id).passes;
    await bob.daemon.tick();
    expect(bob.daemon.handle(id).passes).toBe(passes);
  });
});

describe("Task 2: off-chain mirrors of the hub's launch limits (spec §13)", () => {
  it("createOffer rejects a deposit over the hub's per-player cap before posting anything", async () => {
    const pair = await startPair();
    cleanups.push(pair.cleanup);
    await setLimits(pair.env.hub, 500_000n, 10n ** 12n);
    const err = await pair.alice.daemon
      .createOffer({ deposit: 1_000_000n, stakePerGame: 100_000n, challengeTimeout: 600n })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DaemonError);
    expect((err as DaemonError).code).toBe(400);
    expect((err as DaemonError).message).toBe("deposit exceeds the hub's per-player cap of 500000 base units");
    expect(await pair.alice.client.lobby.listOffers()).toEqual([]); // nothing was posted
  });

  it("acceptOffer rejects an over-cap offer without creating a record or signing anything", async () => {
    const pair = await startPair();
    cleanups.push(pair.cleanup);
    const { alice, bob } = pair;
    const { offerId } = await alice.daemon.createOffer({ deposit: 1_000_000n, stakePerGame: 100_000n, challengeTimeout: 600n });
    await setLimits(pair.env.hub, 500_000n, 10n ** 12n);
    const err = await bob.daemon.acceptOffer(offerId).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DaemonError);
    expect((err as DaemonError).code).toBe(400);
    expect((err as DaemonError).message).toBe("deposit exceeds the hub's per-player cap of 500000 base units");
    expect(new RecordStore(bob.home).offer(offerId)).toBeNull();
    expect(bob.daemon.channelIds()).toEqual([]);
  });

  it("createOffer rejects while the hub is paused, with a clear cause", async () => {
    const pair = await startPair();
    cleanups.push(pair.cleanup);
    await setPaused(pair.env.hub, true);
    const err = await pair.alice.daemon
      .createOffer({ deposit: 1_000_000n, stakePerGame: 100_000n, challengeTimeout: 600n })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DaemonError);
    expect((err as DaemonError).code).toBe(409);
    expect((err as DaemonError).message).toBe("the hub is paused: no new channels");
  });

  it("acceptOffer rejects while the hub is paused", async () => {
    const pair = await startPair();
    cleanups.push(pair.cleanup);
    const { alice, bob } = pair;
    const { offerId } = await alice.daemon.createOffer({ deposit: 1_000_000n, stakePerGame: 100_000n, challengeTimeout: 600n });
    await setPaused(pair.env.hub, true);
    const err = await bob.daemon.acceptOffer(offerId).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DaemonError);
    expect((err as DaemonError).code).toBe(409);
    expect((err as DaemonError).message).toBe("the hub is paused: no new channels");
  });

  it("onMatch ignores a match the hub would now reject (paused after the match was posted) and logs it", async () => {
    const pair = await startPair();
    cleanups.push(pair.cleanup);
    const { alice, bob } = pair;
    const { offerId } = await alice.daemon.createOffer({ deposit: 1_000_000n, stakePerGame: 100_000n, challengeTimeout: 600n });
    const so = (await alice.client.lobby.listOffers()).find((o) => computeOfferId(o.offer) === offerId)!;
    const sessionKey = generatePrivateKey();
    internals(bob.daemon).records.saveOffer({ offerId, offer: so.offer, sessionKey, role: "accepter" });
    const terms = { rules: pair.env.rules, feeRecipient: pair.env.host, feePerPlayer: 5_000n, fundingWindow: 3600n };
    const acceptance = { offerId, player: bob.address, signer: privateKeyToAccount(sessionKey).address, nonce: randomNonce() };
    await setPaused(pair.env.hub, true);
    await internals(bob.daemon).onMatch({ offerId, params: buildParams(so.offer, acceptance, terms, await now()) });
    expect(bob.daemon.channelIds()).toEqual([]);
  });

  it(
    "a funding revert while paused sets a clear lastError and backs off for 30s; funding completes once unpaused",
    async () => {
      const pair = await startPair();
      cleanups.push(pair.cleanup);
      const { alice, bob } = pair;
      const { offerId } = await alice.daemon.createOffer({ deposit: 1_000_000n, stakePerGame: 100_000n, challengeTimeout: 600n });
      await bob.daemon.acceptOffer(offerId);
      const id = await waitFor(async () => {
        const [a, b] = [alice.daemon.channelIds(), bob.daemon.channelIds()];
        return a.length === 1 && b.length === 1 && a[0] === b[0] ? a[0] : null;
      }, 20_000, "match");

      await setPaused(pair.env.hub, true);
      await waitFor(async () => {
        await alice.daemon.idle();
        await alice.daemon.tick();
        return /^funding: Paused$/.test(alice.daemon.handle(id).lastError ?? "");
      }, 5_000, "paused funding error");
      expect(alice.daemon.handle(id).fundBlockedUntil).not.toBeNull();
      expect((await alice.daemon.hub.channelInfo(id)).funded[0]).toBe(false);

      // Unpausing alone must not trigger an immediate retry: the back-off (>= 30s of chain time) still applies,
      // so the watchtower does not hot-loop a revert it already saw.
      await setPaused(pair.env.hub, false);
      await alice.daemon.idle();
      await alice.daemon.tick();
      expect((await alice.daemon.hub.channelInfo(id)).funded[0]).toBe(false);

      await increaseTime(31);
      await waitFor(async () => (await alice.daemon.hub.channelInfo(id)).funded[0], 20_000, "alice funded once the back-off expires");
      await bob.daemon.idle();
      await bob.daemon.tick();
      await waitFor(async () => (await alice.daemon.hub.channelInfo(id)).phase === "Open", 20_000, "open");
      expect(alice.daemon.handle(id).lastError).toBeNull();
      expect(alice.daemon.handle(id).fundBlockedUntil).toBeNull();
    },
  );

  it("status suggests waiting for the hub's pause when a channel is funding-blocked by it", async () => {
    const pair = await startPair();
    cleanups.push(pair.cleanup);
    const { alice, bob } = pair;
    const { offerId } = await alice.daemon.createOffer({ deposit: 1_000_000n, stakePerGame: 100_000n, challengeTimeout: 600n });
    await bob.daemon.acceptOffer(offerId);
    const id = await waitFor(async () => {
      const [a, b] = [alice.daemon.channelIds(), bob.daemon.channelIds()];
      return a.length === 1 && b.length === 1 && a[0] === b[0] ? a[0] : null;
    }, 20_000, "match");
    await setPaused(pair.env.hub, true);
    await waitFor(async () => {
      await alice.daemon.idle();
      await alice.daemon.tick();
      return /^funding: Paused$/.test(alice.daemon.handle(id).lastError ?? "");
    }, 5_000, "paused funding error");
    const st = await alice.daemon.status(id);
    expect(st.suggestedActions).toContainEqual(
      "wait: the hub is paused; funding resumes automatically when it is unpaused (or reclaim after the funding deadline)",
    );
  });
});

describe("minor fixes", () => {
  it("M-c: a restart after receiving a mating move, but before auto-resigning, resigns from the Open-phase tick", async () => {
    const { alice, bob, id, env } = await matched();
    for (const m of SCHOLARS_MATE.slice(0, -1)) {
      const [mover, other] = alice.daemon.handle(id).session.isMyTurn() ? [alice, bob] : [bob, alice];
      await mover.daemon.move(id, m, { actor: "agent" });
      const turn = mover.daemon.handle(id).session.latest.state.turnNum;
      await waitFor(() => other.daemon.handle(id).session.latest.state.turnNum === turn, 5_000, `relay ${m}`);
    }
    // Bob "crashes": his daemon stops, then the mating move reaches (and is persisted by) his session alone.
    await bob.daemon.stop();
    await alice.daemon.move(id, SCHOLARS_MATE.at(-1)!, { actor: "agent" });
    const record = new RecordStore(bob.home).channel(id)!;
    const session = await ChannelSession.open({
      params: record.params,
      me: record.me,
      sessionKey: record.sessionKey,
      domain: env.domain,
      store: new FileSessionStore(arenaPaths(bob.home).channelSession(id)),
    });
    expect(await session.receive(alice.daemon.handle(id).session.latest)).toBe("move");
    expect(session.isMyTurn()).toBe(true); // mated, and not yet resigned

    const restarted = new ArenaDaemon({ home: bob.home, config: loadConfig(bob.home), walletKey: bob.walletKey, lobby: bob.client.lobby, relay: bob.client.relay });
    cleanups.push(() => restarted.stop());
    await restarted.start();
    await waitFor(async () => (await alice.daemon.status(id)).gameStatus === "white_won", 10_000, "auto-resign reaches alice");
    expect(restarted.handle(id).session.isMyTurn()).toBe(false);
    expect((await restarted.status(id)).gameStatus).toBe("white_won");
  });

  it("M-d: acceptOffer is idempotent — a retry re-sends the same signed acceptance and never generates a new key", async () => {
    const pair = await startPair();
    cleanups.push(pair.cleanup);
    const { alice, bob } = pair;
    const { offerId } = await alice.daemon.createOffer({ deposit: 1_000_000n, stakePerGame: 100_000n, challengeTimeout: 600n });
    // Bob's first attempt is lost in transit (the host never sees it); later attempts go through.
    const lobby = bob.client.lobby;
    const original = lobby.accept.bind(lobby);
    const sent: SignedAcceptance[] = [];
    let attempts = 0;
    lobby.accept = async (sa) => {
      attempts++;
      sent.push(structuredClone(sa));
      if (attempts === 1) throw new Error("network down");
      return original(sa);
    };
    await expect(bob.daemon.acceptOffer(offerId)).rejects.toThrow(/network down/);
    const keyAfterFirst = new RecordStore(bob.home).offer(offerId)!.sessionKey;
    await bob.daemon.acceptOffer(offerId.toUpperCase().replace("0X", "0x") as Hex); // any hex case is the same offer
    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual(sent[0]); // same acceptance, same signature
    const id = await waitFor(async () => {
      const [a, b] = [alice.daemon.channelIds(), bob.daemon.channelIds()];
      return a.length === 1 && b.length === 1 && a[0] === b[0] ? a[0] : null;
    }, 20_000, "match");
    expect(bob.daemon.handle(id).record.sessionKey).toBe(keyAfterFirst);
    await waitFor(async () => (await alice.daemon.hub.channelInfo(id)).phase === "Open", 20_000, "funding");
    // Once matched, accepting again is refused outright.
    const again = await bob.daemon.acceptOffer(offerId).catch((e: unknown) => e);
    expect(again).toBeInstanceOf(DaemonError);
    expect((again as DaemonError).code).toBe(409);
    expect((again as DaemonError).message).toMatch(/already accepted/);
    expect(sent).toHaveLength(2);
    await expect(bob.daemon.acceptOffer("./0x1234" as Hex)).rejects.toThrow(/offerId must be/);
  });

  it("concurrent acceptOffer calls for one offer create exactly one acceptance (M-carry)", async () => {
    const pair = await startPair();
    cleanups.push(pair.cleanup);
    const { offerId } = await pair.alice.daemon.createOffer({ deposit: 1_000_000n, stakePerGame: 100_000n, challengeTimeout: 600n });
    const results = await Promise.allSettled([pair.bob.daemon.acceptOffer(offerId), pair.bob.daemon.acceptOffer(offerId)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(String(rejected.reason)).toMatch(/already being accepted|already accepted/);
  });

  it("scans dispute events in chunks from a persisted cursor and survives a getLogs failure (I3)", async () => {
    // Both periodic timers are parked (see the "calls timeout" test above for the same reasoning): the stub
    // below fails hub.disputeEvents exactly once, for whichever caller happens to invoke it first. With a live
    // periodic tick still running, that could be a background pass rather than the explicit one this test
    // drives, and the assertion right after it would then flake against a scan that already recovered.
    const pair = await startPair({ pollMs: 3_600_000, bobConfig: { logChunkBlocks: 2 } });
    cleanups.push(pair.cleanup);
    const { alice, bob } = pair;
    const { offerId } = await alice.daemon.createOffer({ deposit: 1_000_000n, stakePerGame: 100_000n, challengeTimeout: 600n });
    await bob.daemon.acceptOffer(offerId);
    const id = await waitFor(() => alice.daemon.channelIds()[0], 20_000, "match");
    await alice.daemon.idle();
    await alice.daemon.tick(); // alice (offerer) deposits
    await waitFor(async () => (await alice.daemon.hub.channelInfo(id)).funded[0], 20_000, "alice funded");
    await bob.daemon.idle();
    await bob.daemon.tick(); // bob (accepter) deposits now that funded[0] is true
    await waitFor(async () => (await alice.daemon.status(id)).phase === "Open", 30_000, "open");
    bob.client.disconnect(); // Bob never sees e4 over the relay; only through the Challenged event
    await alice.daemon.move(id, "e4", { actor: "agent" });
    await alice.daemon.challenge(id, "agent");
    // A getLogs failure must not stop the rest of the watchtower pass.
    const hub = bob.daemon.hub;
    const real = hub.disputeEvents.bind(hub);
    let failures = 1;
    hub.disputeEvents = (...a: Parameters<typeof real>) => (failures-- > 0 ? Promise.reject(new Error("range too large")) : real(...a));
    await bob.daemon.idle();
    await bob.daemon.tick();
    expect(bob.daemon.handle(id).lastError).toMatch(/^events:/);
    await waitFor(async () => { await bob.daemon.idle(); await bob.daemon.tick(); return bob.daemon.handle(id).session.isMyTurn(); }, 20_000, "ingested e4 from chain");
    const rec = bob.daemon.handle(id).record;
    expect(rec.scannedBlock).toBeDefined();
    expect(rec.scannedBlock! >= rec.createdBlock).toBe(true);
  });

  it("re-reads the trailing rescan window: an event a laggy getLogs hid on one scan is still ingested later", async () => {
    // Both periodic timers are parked, for the same reason as the getLogs-failure test above: the stub below
    // must be consumed by the explicit tick this test drives, not by a background pass racing ahead of it.
    const pair = await startPair({ pollMs: 3_600_000 });
    cleanups.push(pair.cleanup);
    const { alice, bob } = pair;
    const { offerId } = await alice.daemon.createOffer({ deposit: 1_000_000n, stakePerGame: 100_000n, challengeTimeout: 600n });
    await bob.daemon.acceptOffer(offerId);
    const id = await waitFor(() => alice.daemon.channelIds()[0], 20_000, "match");
    await alice.daemon.idle();
    await alice.daemon.tick(); // alice (offerer) deposits
    await waitFor(async () => (await alice.daemon.hub.channelInfo(id)).funded[0], 20_000, "alice funded");
    await bob.daemon.idle();
    await bob.daemon.tick(); // bob (accepter) deposits now that funded[0] is true
    await waitFor(async () => (await alice.daemon.status(id)).phase === "Open", 30_000, "open");
    bob.client.disconnect(); // Bob never sees e4 over the relay; only through the Challenged event
    await alice.daemon.move(id, "e4", { actor: "agent" });
    await alice.daemon.challenge(id, "agent");
    // Simulates a load-balanced RPC whose blockNumber() outran its own getLogs index: the very first call to
    // disputeEvents (whatever range it's asked for) comes back empty, hiding the Challenged event entirely --
    // yet the scan still reports a fully-scanned head, since it saw no failure.
    const hub = bob.daemon.hub;
    const real = hub.disputeEvents.bind(hub);
    let hideOnce = true;
    hub.disputeEvents = (...a: Parameters<typeof real>) => {
      if (hideOnce) {
        hideOnce = false;
        return Promise.resolve([]);
      }
      return real(...a);
    };
    await bob.daemon.idle();
    await bob.daemon.tick(); // the event is hidden; no failure is recorded, and the scan "completes" past it
    expect(bob.daemon.handle(id).lastError).toBeNull();
    expect(bob.daemon.handle(id).session.isMyTurn()).toBe(false); // still unaware of e4
    // Without the rescan window, the next scan would start strictly after the (falsely) fully-scanned head and
    // would never see that block's event again. With it, the trailing DISPUTE_RESCAN_BLOCKS are re-read on the
    // very next tick, and the real disputeEvents (hideOnce is now false) returns the event this time.
    await waitFor(async () => { await bob.daemon.idle(); await bob.daemon.tick(); return bob.daemon.handle(id).session.isMyTurn(); }, 20_000, "ingested e4 on rescan");
  });
});

describe("Plan 4.5 Task 10: reorg resilience", () => {
  it("re-approves USDC when the allowance is gone (an approve dropped by a reorg, or revoked) instead of remembering it", async () => {
    const { alice, bob, env } = await matched(); // alice's daemon approved the hub while funding channel 1
    // The approve is gone, as after a reorg deeper than the deposit (the system chaos test drops it with anvil_reorg).
    const aliceWallet = new LocalKeyTxSender(alice.walletKey, RPC, CHAIN);
    await alice.daemon.hub.approve(aliceWallet, env.usdc, 0n);
    const { offerId } = await alice.daemon.createOffer({ deposit: 1_000_000n, stakePerGame: 100_000n, challengeTimeout: 600n });
    await bob.daemon.acceptOffer(offerId);
    const second = await waitFor(
      () => alice.daemon.channelIds().find((c) => alice.daemon.handle(c).record.offerId === offerId) ?? null,
      20_000,
      "second match",
    );
    // Before the fix, alice's in-memory "approved" flag skipped the approve and her deposit reverted on every tick.
    await waitFor(async () => (await alice.daemon.hub.channelInfo(second)).phase === "Open", 20_000, "second channel funded");
    expect(alice.daemon.handle(second).lastError).toBeNull();
  });
});

describe("Plan 4.5 Task 10: transient RPC failures", () => {
  it("a watchtower pass that fails on an RPC error sets a watch: lastError, and the next good pass clears it", async () => {
    const { alice, id } = await matched();
    const hub = alice.daemon.hub;
    const real = hub.channelInfo.bind(hub);
    let fail = true;
    hub.channelInfo = async (c) => {
      if (fail) {
        fail = false;
        throw new Error("HTTP request failed.");
      }
      return real(c);
    };
    // Whichever periodic pass hits the failure records it ("watch: …" after the fix)...
    await waitFor(() => /HTTP request failed/.test(alice.daemon.handle(id).lastError ?? ""), 5_000, "the failed pass");
    expect(fail).toBe(false);
    // ...and the next good pass clears it. Before the fix it stayed until a relay message happened to arrive.
    await waitFor(() => alice.daemon.handle(id).lastError === null, 5_000, "a good pass to clear it");
    expect(alice.daemon.handle(id).passes).toBeGreaterThan(1);
  });
});

describe("Plan 4.5 Task 10: a move is not failed by an RPC error after it was sent", () => {
  it("move() resolves when the follow-up challenge check cannot reach the chain; the peer still gets the move", async () => {
    const { alice, bob, id } = await matched();
    const hub = alice.daemon.hub;
    const real = hub.channelInfo.bind(hub);
    let fail = false;
    hub.channelInfo = async (c) => {
      if (fail) throw new Error("HTTP request failed.");
      return real(c);
    };
    fail = true; // every chain read of alice's daemon fails for the length of the move call
    try {
      // Before the fix this rejected, although the move had been signed, persisted and relayed.
      await alice.daemon.move(id, "e4", { actor: "agent" });
    } finally {
      fail = false;
    }
    expect(alice.daemon.handle(id).session.latest.state.turnNum).toBe(1n);
    await waitFor(() => bob.daemon.handle(id).session.latest.state.turnNum === 1n, 5_000, "bob holds turn 1");
  });
});
