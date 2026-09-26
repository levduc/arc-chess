import { randomBytes } from "node:crypto";
import type { Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, it } from "vitest";
import { buildParams, type MatchEvent } from "@arena/sdk";
import { increaseTime } from "../../sdk/test/helpers/chain.js";
import { ArenaDaemon, MAX_FUNDING_WINDOW, RecordStore, loadConfig } from "../src/index.js";
import { startPair, waitFor, type Player } from "./helpers/harness.js";

/** Test-only escape hatch: onMatch is private, but these tests deliver a host's (replayed) match by hand. */
const internals = (d: ArenaDaemon) => d as unknown as { onMatch(m: MatchEvent): Promise<void> };

/** A fresh daemon on `p`'s home and transport (as after a restart), optionally capturing its log. */
async function restart(p: Player, log?: (l: string) => void): Promise<ArenaDaemon> {
  const d = new ArenaDaemon({
    home: p.home,
    config: loadConfig(p.home),
    walletKey: p.walletKey,
    lobby: p.client.lobby,
    relay: p.client.relay,
    log,
  });
  cleanups.push(() => d.stop());
  await d.start();
  return d;
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function pair() {
  const p = await startPair();
  cleanups.push(p.cleanup);
  return p;
}

describe("I2: settled channels leave the relay", () => {
  it("a cooperatively closed channel is left on both sides", async () => {
    const { alice, bob } = await pair();
    const { offerId } = await alice.daemon.createOffer({ deposit: 1_000_000n, stakePerGame: 100_000n, challengeTimeout: 600n });
    await bob.daemon.acceptOffer(offerId);
    const id = await waitFor(() => alice.daemon.channelIds()[0], 20_000, "match");
    await waitFor(async () => (await alice.daemon.status(id)).phase === "Open", 30_000, "open");
    expect(alice.client.rooms()).toContain(id);
    expect(bob.client.rooms()).toContain(id);

    await alice.daemon.move(id, "e4", { actor: "agent", offerDraw: true });
    await waitFor(() => bob.daemon.handle(id).session.isMyTurn(), 5_000, "bob turn");
    await bob.daemon.acceptDraw(id, "agent");
    await waitFor(async () => (await alice.daemon.status(id)).attention === "game-over", 5_000, "draw seen");
    await alice.daemon.close(id, "agent");
    await waitFor(async () => (await bob.daemon.status(id)).attention === "close-requested", 5_000, "close requested");
    await bob.daemon.close(id, "agent");

    await waitFor(() => alice.daemon.handle(id).record.finalized && bob.daemon.handle(id).record.finalized, 20_000, "finalized");
    expect(alice.client.rooms()).not.toContain(id);
    expect(bob.client.rooms()).not.toContain(id);
  });
});

describe("I3/M12: offer records do not pile up", () => {
  it("an offer record past expiresAt + the max funding window is pruned and unwatched", async () => {
    const { alice } = await pair();
    const { offerId } = await alice.daemon.createOffer({ deposit: 1_000_000n, stakePerGame: 100_000n, challengeTimeout: 600n });
    const records = new RecordStore(alice.home);
    expect(records.offer(offerId)).not.toBe(null);
    expect(alice.client.watched()).toContain(offerId);

    // just past expiry, a match made in time could still be funded: kept
    await increaseTime(3600 + 60);
    await alice.daemon.idle();
    await alice.daemon.tick();
    expect(records.offer(offerId)).not.toBe(null);

    await increaseTime(Number(MAX_FUNDING_WINDOW));
    await alice.daemon.idle();
    await alice.daemon.tick();
    expect(records.offer(offerId)).toBe(null);
    expect(alice.client.watched()).not.toContain(offerId);
    expect(alice.client.unwatched()).toEqual([offerId]);
  });

  it("start() prunes dead offer records before its first watch, so they are never subscribed", async () => {
    const { alice } = await pair();
    const { offerId } = await alice.daemon.createOffer({ deposit: 1_000_000n, stakePerGame: 100_000n, challengeTimeout: 600n });
    await alice.daemon.stop();
    await increaseTime(3600 + Number(MAX_FUNDING_WINDOW) + 60);

    const watchCalls: string[][] = [];
    const realWatch = alice.client.lobby.watch;
    alice.client.lobby.watch = (ids) => {
      watchCalls.push([...ids]);
      realWatch(ids);
    };
    await restart(alice);
    expect(new RecordStore(alice.home).offer(offerId)).toBe(null);
    expect(watchCalls.flat()).not.toContain(offerId);
  });

  it("an offer the host refuses leaves no record behind", async () => {
    const { alice } = await pair();
    alice.client.lobby.postOffer = async () => {
      throw new Error("too many open offers from this IP");
    };
    await expect(
      alice.daemon.createOffer({ deposit: 1_000_000n, stakePerGame: 100_000n, challengeTimeout: 600n }),
    ).rejects.toThrow(/too many open offers/);
    expect(new RecordStore(alice.home).offers()).toEqual([]);
    expect(alice.client.watched()).toEqual([]);
  });
});

describe("I4: relay joins never hold up the watchtower", () => {
  it("start() returns promptly and ticks even when the relay never answers a join", async () => {
    const { alice, bob } = await pair();
    const { offerId } = await alice.daemon.createOffer({ deposit: 1_000_000n, stakePerGame: 100_000n, challengeTimeout: 600n });
    await bob.daemon.acceptOffer(offerId);
    const id = await waitFor(() => alice.daemon.channelIds()[0], 20_000, "match");
    await waitFor(async () => (await alice.daemon.status(id)).phase === "Open", 30_000, "open");
    await alice.daemon.stop();

    let joins = 0;
    const silentRelay = {
      ...alice.client.relay,
      join: () => {
        joins++;
        return new Promise<void>(() => undefined); // a host that accepts the socket but never answers
      },
    };
    const restarted = new ArenaDaemon({
      home: alice.home,
      config: loadConfig(alice.home),
      walletKey: alice.walletKey,
      lobby: alice.client.lobby,
      relay: silentRelay,
    });
    cleanups.push(() => restarted.stop());
    const started = restarted.start().then(() => "started" as const);
    const timeout = new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 5_000));
    expect(await Promise.race([started, timeout])).toBe("started");
    expect(joins).toBe(1);
    expect(restarted.handle(id).passes).toBeGreaterThan(0); // start()'s own first tick already watched it
    expect(restarted.handle(id).chain?.phase).toBe("Open");
  });
});

describe("I5: offer expiry is judged at match time", () => {
  it("an offerer who comes back after expiresAt, but before the funding deadline, still funds", async () => {
    const { alice, bob } = await pair();
    const { offerId } = await alice.daemon.createOffer({ deposit: 1_000_000n, stakePerGame: 100_000n, challengeTimeout: 600n });
    await alice.daemon.stop(); // the offerer goes offline

    await increaseTime(1800);
    const matches: MatchEvent[] = [];
    bob.client.lobby.onMatch((m) => matches.push(m));
    await bob.daemon.acceptOffer(offerId); // matched in time: fundingDeadline = match time + 3600
    await waitFor(() => matches.length === 1, 5_000, "match");

    await increaseTime(1801); // now past the offer's expiresAt (creation + 3600), well before fundingDeadline
    const back = await restart(alice);
    await internals(back).onMatch(matches[0]); // the host's replay on re-subscribe
    const id = await waitFor(() => back.channelIds()[0], 5_000, "channel opened for the replayed match");
    await waitFor(async () => (await back.status(id)).phase === "Open", 30_000, "open");
  });

  it("a match made after the offer expired is still refused", async () => {
    const { alice, bob, env } = await pair();
    const { offerId } = await alice.daemon.createOffer({ deposit: 1_000_000n, stakePerGame: 100_000n, challengeTimeout: 600n });
    const rec = new RecordStore(alice.home).offer(offerId)!;
    await alice.daemon.stop();
    await increaseTime(3700);
    // a host matching 50 s after expiry, with the widest funding window the daemon allows
    const late = buildParams(
      rec.offer,
      {
        offerId,
        player: bob.address,
        signer: privateKeyToAccount(generatePrivateKey()).address,
        nonce: `0x${randomBytes(32).toString("hex")}` as Hex,
      },
      { rules: env.rules, feeRecipient: env.host, feePerPlayer: 5_000n, fundingWindow: MAX_FUNDING_WINDOW },
      rec.offer.expiresAt + 50n,
    );
    const logs: string[] = [];
    const back = await restart(alice, (l) => logs.push(l));
    await internals(back).onMatch({ offerId, params: late });
    expect(back.channelIds()).toEqual([]);
    expect(logs.some((l) => l.includes("matched after the offer expired"))).toBe(true);
  });
});
