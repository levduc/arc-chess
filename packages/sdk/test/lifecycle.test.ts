import { describe, expect, it } from "vitest";
import { generatePrivateKey } from "viem/accounts";
import {
  ChannelSession,
  HubClient,
  HubRevertError,
  LocalKeyTxSender,
  MemoryStore,
  signState,
  type SessionConfig,
} from "../src/index.js";
import { ANVIL_KEYS, CHAIN, RPC, deployArena, increaseTime, mintUsdc, now, setEthBalance, usdcBalance } from "./helpers/chain.js";
import { SCHOLARS_MATE, makeParams } from "./helpers/fixtures.js";

const START = 10_000_000n;
const MAX = 2n ** 255n;

async function arena(salt: string) {
  const env = await deployArena();
  const alice = new LocalKeyTxSender(ANVIL_KEYS[1], RPC, CHAIN);
  const bob = new LocalKeyTxSender(ANVIL_KEYS[2], RPC, CHAIN);
  const sessionKeys = [generatePrivateKey(), generatePrivateKey()] as const;
  const params = makeParams({
    participants: [alice.address, bob.address],
    sessionKeys,
    rules: env.rules,
    feeRecipient: env.host,
    fundingDeadline: (await now()) + 3600n,
    salt,
  });
  const hub = new HubClient(env.hub, env.pub);
  for (const who of [alice, bob]) {
    await mintUsdc(env.usdc, who.address, START);
    await hub.approve(who, env.usdc, MAX);
  }
  const cfg = (me: 0 | 1): SessionConfig => ({ params, me, sessionKey: sessionKeys[me], domain: env.domain, store: new MemoryStore() });
  return { env, hub, alice, bob, params, sessionKeys, cfg };
}

async function open(x: Awaited<ReturnType<typeof arena>>) {
  await x.hub.deposit(x.alice, x.params);
  await x.hub.deposit(x.bob, x.params);
  const a = await ChannelSession.create(x.cfg(0));
  const b = await ChannelSession.create(x.cfg(1));
  expect((await x.hub.channelInfo(a.id)).phase).toBe("Open");
  return { a, b };
}

async function play(a: ChannelSession, b: ChannelSession, moves: string[]) {
  for (const m of moves) {
    const [mover, other] = a.isMyTurn() ? [a, b] : [b, a];
    await other.receive(await mover.move(m));
  }
}

describe("channel lifecycle on Anvil", () => {
  it("plays two games off-chain and closes cooperatively with Close signatures", async () => {
    const x = await arena("coop");
    const { a, b } = await open(x);

    await play(a, b, SCHOLARS_MATE); // game 0: A white mates
    await a.receive(await b.resign());
    const proposal = await a.proposeNewGame();
    await b.receive(proposal);
    await a.receive(await b.countersignNewGame());
    await play(a, b, SCHOLARS_MATE); // game 1: B white mates
    await b.receive(await a.resign());

    await b.receiveClose(await a.signClose());
    await a.receiveClose(await b.signClose());
    const tx = a.closeTransaction();
    expect(tx).not.toBeNull();
    await x.hub.closeCooperative(x.alice, tx!);

    expect((await x.hub.channelInfo(a.id)).phase).toBe("Finalized");
    expect(await usdcBalance(x.env.usdc, x.alice.address)).toBe(START - x.params.feePerPlayer);
    expect(await usdcBalance(x.env.usdc, x.bob.address)).toBe(START - x.params.feePerPlayer);
    expect(await usdcBalance(x.env.usdc, x.env.host)).toBe(2n * x.params.feePerPlayer);
  });

  it("challenges via a session key, answers on-chain, resumes, and forfeits a staller on timeout", async () => {
    const x = await arena("dispute");
    const { a, b } = await open(x);
    const aliceSessionSender = new LocalKeyTxSender(x.sessionKeys[0], RPC, CHAIN);
    await setEthBalance(aliceSessionSender.address, 10n ** 18n);

    const e4 = await a.move("e2e4");
    await b.receive(e4); // Bob goes quiet instead of answering
    await x.hub.challenge(aliceSessionSender, a.challengeProof());
    expect((await x.hub.channelInfo(a.id)).phase).toBe("Challenged");

    // Bob's watchtower sees the challenge, answers on-chain; Alice adopts the answer from the event.
    const events = await x.hub.disputeEvents(b.id);
    expect(events.map((e) => e.kind)).toEqual(["Challenged"]);
    expect(await b.ingestOnChain(events[0].signed)).toBe(false); // Bob already had it
    await b.move("e7e5");
    await x.hub.respond(x.bob, b.challengeProof());
    const responded = (await x.hub.disputeEvents(a.id)).at(-1)!;
    expect(responded.kind).toBe("Responded");
    expect(await a.ingestOnChain(responded.signed)).toBe(true);
    expect(a.isMyTurn()).toBe(true);
    expect((await x.hub.channelInfo(a.id)).phase).toBe("Open");

    // Now Alice stalls; Bob challenges the registered state and wins the stake on timeout.
    await x.hub.challenge(x.bob, b.challengeProof());
    await expect(x.hub.timeout(x.alice, a.id)).rejects.toThrow(/TooEarly/);
    await increaseTime(Number(x.params.challengeTimeout));
    await x.hub.timeout(x.alice, a.id);
    const d = x.params.deposit;
    const f = x.params.feePerPlayer;
    const s = x.params.stakePerGame;
    expect(await usdcBalance(x.env.usdc, x.alice.address)).toBe(START - d - f + (d - s));
    expect(await usdcBalance(x.env.usdc, x.bob.address)).toBe(START - d - f + (d + s));
  });

  it("reclaims an unfunded channel after the deadline", async () => {
    const x = await arena("reclaim");
    await x.hub.deposit(x.alice, x.params);
    const a = await ChannelSession.create(x.cfg(0));
    await expect(x.hub.reclaim(x.alice, a.id)).rejects.toThrow(/TooEarly/);
    await increaseTime(3601);
    await x.hub.reclaim(x.alice, a.id);
    expect(await usdcBalance(x.env.usdc, x.alice.address)).toBe(START);
    expect((await x.hub.channelInfo(a.id)).phase).toBe("Reclaimed");
  });

  it("surfaces hub custom errors by name", async () => {
    const x = await arena("errors");
    const { a, b } = await open(x);
    await b.receive(await a.move("e2e4"));
    await a.receive(await b.resign());
    // State co-signatures are not a close intent: the hub rejects them.
    const s = a.latest.state;
    const cosigned = {
      state: s,
      sigA: await signState(x.sessionKeys[0], s, x.env.domain),
      sigB: await signState(x.sessionKeys[1], s, x.env.domain),
    };
    const err = await x.hub.closeCooperative(x.alice, cosigned).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HubRevertError);
    expect((err as HubRevertError).errorName).toBe("BadSignature");
    await expect(x.hub.deposit(x.alice, x.params)).rejects.toThrow(/WrongPhase/);
  });
});
