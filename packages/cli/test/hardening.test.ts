import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hashState, signClose } from "@arena/sdk";
import { increaseTime } from "../../sdk/test/helpers/chain.js";
import { ArenaDaemon, RecordStore, loadConfig, type ChannelRecord } from "../src/index.js";
import { startPair, waitFor } from "./helpers/harness.js";

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
