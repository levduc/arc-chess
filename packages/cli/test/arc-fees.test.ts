/**
 * Plan 6 Task 2 (spec §2.2-§2.4; audit-daemon I-1, I-6): the daemon's half of Arc's fees.
 * - The session-key top-up's gas limit is the node's estimate + 20 % + 5,000 (`topUpGasLimit`). A failed estimate
 *   sends nothing and raises `session-gas-low`.
 * - A top-up mined but reverted is not a refill: it raises `session-gas-low` and backs off (a refill), or backs
 *   funding off (`fund()`), so it is not re-sent on every pass.
 * - The chain profile's fee floor reaches the wallet sender and every session-key sender, the fee ceiling defaults to
 *   the profile's, and the sweep reserves for the floor.
 * Standard anvil throughout. arc-anvil models the floor only at some chain ids (tools/arc-foundry.md), so the floor
 * itself is asserted on the fees the senders emit (see also packages/sdk/test/feeFloor.test.ts).
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPublicClient, createTestClient, http, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { DEFAULT_FEE_CEILING_WEI, NO_FEE_CEILING, type SerialTxSender, type TxRequest } from "@arena/sdk";
import { CHAIN, RPC, setEthBalance } from "../../sdk/test/helpers/chain.js";
import {
  ArenaDaemon,
  RESPOND_GAS_BUDGET,
  SESSION_GAS_RESPONDS,
  TOP_UP_GAS_MARGIN_FIXED,
  TOP_UP_GAS_MARGIN_PERCENT,
  TopUpRevertedError,
  feeCeilingOf,
  initHome,
  profileSessionGasWei,
  topUpGasLimit,
  type ArenaConfig,
} from "../src/index.js";
import { CHAIN_PROFILES, weiToUsdc6Up } from "../src/chains.js";
import { RecordStore } from "../src/records.js";
import { startPair, waitFor } from "./helpers/harness.js";

const GWEI = 10n ** 9n;
const bigMax = (a: bigint, b: bigint) => (a > b ? a : b);
const anvil = createTestClient({ mode: "anvil", chain: CHAIN, transport: http(RPC) });
/** PUSH1 0 PUSH1 0 REVERT: any call -- a value transfer included -- reverts. */
const REVERTS = "0x60006000fd" as const;

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

type EstimateArgs = { to?: Hex | null; account?: unknown; value?: bigint };
/** Replaces the daemon's `estimateGas` for transfers to `to` only (every other estimate, e.g. a deposit's, is real).
 *  `answer` gets the real one too. */
function stubEstimate(
  d: ArenaDaemon,
  to: Hex,
  answer: (args: EstimateArgs, real: (args: EstimateArgs) => Promise<bigint>) => Promise<bigint>,
): () => void {
  const real = d.client.estimateGas.bind(d.client);
  const realOf = (args: EstimateArgs) => real(args as never);
  d.client.estimateGas = (async (args: EstimateArgs) =>
    args.to?.toLowerCase() === to.toLowerCase() ? answer(args, realOf) : realOf(args)) as typeof d.client.estimateGas;
  return () => {
    d.client.estimateGas = real;
  };
}

/** Records the hashes of the wallet's sends to `to`. */
function spySends(d: ArenaDaemon, to: Hex): Hex[] {
  const hashes: Hex[] = [];
  const real = d.wallet.send.bind(d.wallet);
  d.wallet.send = async (tx: TxRequest) => {
    const h = await real(tx);
    if (tx.to.toLowerCase() === to.toLowerCase()) hashes.push(h);
    return h;
  };
  return hashes;
}

const nonceOf = (d: ArenaDaemon, a: Hex) => d.client.getTransactionCount({ address: a, blockTag: "pending" });

describe("Plan 6 Task 2: the top-up's gas limit and the profile's session gas (units)", () => {
  it("topUpGasLimit is the estimate + 20 % (rounded up) + 5,000: 30,200 for a 21,000-gas transfer", () => {
    expect(TOP_UP_GAS_MARGIN_PERCENT).toBe(20n);
    expect(TOP_UP_GAS_MARGIN_FIXED).toBe(5_000n);
    expect(topUpGasLimit(21_000n)).toBe(30_200n);
    expect(topUpGasLimit(21_001n)).toBe(21_001n + 4_201n + 5_000n); // 4,200.2 rounds up
    expect(topUpGasLimit(40_000n)).toBe(53_000n);
  });

  it("on Arc, sessionGasWei is 4 x 2.1M gas x the profile's 40 gwei ceiling = 0.336 USDC; the ceiling defaults to the profile's", () => {
    for (const chainId of [5042, 5042002]) {
      const p = CHAIN_PROFILES[chainId];
      expect(profileSessionGasWei(p)).toBe(SESSION_GAS_RESPONDS * RESPOND_GAS_BUDGET * 40n * GWEI);
      expect(profileSessionGasWei(p)).toBe(336_000_000_000_000_000n);
      expect(weiToUsdc6Up(profileSessionGasWei(p))).toBe(336_000n); // 0.336000 USDC
      expect(feeCeilingOf({ chainId })).toBe(40n * GWEI);
      expect(feeCeilingOf({ chainId, feeCeilingWei: 60n * GWEI })).toBe(60n * GWEI); // an explicit one wins
    }
    expect(feeCeilingOf({ chainId: 31337 })).toBe(DEFAULT_FEE_CEILING_WEI); // no profile: as before (100 gwei)
    expect(feeCeilingOf({ chainId: 31337, feeCeilingWei: 7n })).toBe(7n);
  });
});

describe("Plan 6 Task 2: the profile reaches every sender the daemon builds", () => {
  const config = (chainId: number, extra: Partial<ArenaConfig> = {}): ArenaConfig => ({
    rpcUrl: RPC,
    chainId,
    hub: `0x${"11".repeat(20)}`,
    usdc: "0x3600000000000000000000000000000000000000",
    rules: `0x${"33".repeat(20)}`,
    serverUrl: "memory:",
    port: 0,
    maxFeePerPlayer: 10_000n,
    sessionGasWei: 10n ** 16n,
    pollMs: 100,
    ...extra,
  });
  /** A daemon that is never started: only its senders are looked at (or used directly). */
  const daemonOn = (cfg: ArenaConfig, walletKey: Hex = generatePrivateKey()) => {
    const home = mkdtempSync(join(tmpdir(), "arena-arcfees-"));
    initHome(home, cfg, walletKey);
    return new ArenaDaemon({ home, config: cfg, walletKey, lobby: {} as never, relay: {} as never });
  };
  const sessionSenderOf = (d: ArenaDaemon, key: Hex) =>
    (d as unknown as { sessionSenderFor(k: Hex): SerialTxSender }).sessionSenderFor(key);

  it("on Arc (5042 and 5042002): the wallet floors at 20 gwei with a 40 gwei ceiling; session keys floor at 20 gwei with no ceiling", () => {
    for (const chainId of [5042, 5042002]) {
      const d = daemonOn(config(chainId));
      expect(d.wallet.minFeePerGas).toBe(20n * GWEI);
      expect(d.wallet.feeCeiling).toBe(40n * GWEI);
      const s = sessionSenderOf(d, generatePrivateKey());
      expect(s.minFeePerGas).toBe(20n * GWEI);
      expect(s.feeCeiling).toBe(NO_FEE_CEILING);
      // An explicit ceiling in config.json still wins over the profile's.
      expect(daemonOn(config(chainId, { feeCeilingWei: 55n * GWEI })).wallet.feeCeiling).toBe(55n * GWEI);
    }
  });

  it("on a chain without a profile (anvil 31337) nothing changes: no floor, the 100 gwei default ceiling", () => {
    const d = daemonOn(config(31337));
    expect(d.wallet.minFeePerGas).toBe(0n);
    expect(d.wallet.feeCeiling).toBe(DEFAULT_FEE_CEILING_WEI);
    const s = sessionSenderOf(d, generatePrivateKey());
    expect(s.minFeePerGas).toBe(0n);
    expect(s.feeCeiling).toBe(NO_FEE_CEILING);
    expect(daemonOn(config(31337, { feeCeilingWei: 7n * GWEI })).wallet.feeCeiling).toBe(7n * GWEI);
  });

  it("on a real node: a floor above the market raises what the wallet and a session key actually send, and the sweep reserves for it", async () => {
    // A test-only profile for 31337 with native gas and a floor well above the node's own estimate (anvil's is about
    // 1-2 gwei, arc-anvil's 25): at least 10 gwei, in whole gwei, over 2 x the market.
    const pub = createPublicClient({ chain: CHAIN, transport: http(RPC) });
    const marketBefore = ((await pub.estimateFeesPerGas()) as { maxFeePerGas: bigint }).maxFeePerGas;
    const floor = bigMax(10n * GWEI, ((2n * marketBefore) / GWEI + 1n) * GWEI);
    CHAIN_PROFILES[31337] = { name: "Local floor", usdc: "0x3600000000000000000000000000000000000000", nativeIsUsdc: false, minFeePerGas: floor, feeCeilingWei: 40n * GWEI };
    try {
      const walletKey = generatePrivateKey();
      const wallet = privateKeyToAccount(walletKey).address;
      await setEthBalance(wallet, 10n ** 18n);
      const d = daemonOn(config(31337), walletKey);
      const market = ((await d.client.estimateFeesPerGas()) as { maxFeePerGas: bigint }).maxFeePerGas;
      expect(market).toBeLessThan(floor); // the floor binds here
      expect(d.wallet.minFeePerGas).toBe(floor);
      expect(d.wallet.feeCeiling).toBe(40n * GWEI);

      const h = await d.wallet.send({ to: privateKeyToAccount(generatePrivateKey()).address, data: "0x", value: 1n });
      const sent = await d.client.waitForTransactionReceipt({ hash: h }).then(() => d.client.getTransaction({ hash: h }));
      expect(sent.maxFeePerGas).toBe(floor);
      expect(sent.maxPriorityFeePerGas!).toBeLessThanOrEqual(sent.maxFeePerGas!);

      // A settled channel's session key: the sweep reserves gas x ceil(1.3 x the floor), not 1.3 x the market,
      // so its own floored send fits. Before, every attempt was refused (TxInsufficientFundsError) until abandoned.
      const sessionKey = generatePrivateKey();
      const session = sessionSenderOf(d, sessionKey);
      const start = 10n ** 16n;
      await setEthBalance(session.address, start);
      const swept = await (d as unknown as {
        performSweep(s: SerialTxSender): Promise<{ status: string; amount?: bigint; hash?: Hex }>;
      }).performSweep(session);
      expect(swept.status).toBe("swept");
      expect(swept.amount).toBe(start - 21_000n * ((floor * 13n + 9n) / 10n)); // ceil(1.3 x the floor) per gas reserved
      const tx = await d.client.getTransaction({ hash: swept.hash! });
      expect(tx.maxFeePerGas).toBe(floor);
      expect(await d.client.getBalance({ address: wallet })).toBeGreaterThan(10n ** 18n - 10n ** 15n);
    } finally {
      delete CHAIN_PROFILES[31337];
    }
  });
});

describe("Plan 6 Task 2: the session-key top-up's gas comes from the node's estimate", () => {
  it("the refill's gas limit is topUpGasLimit(the estimate): 30,200 for anvil's 21,000, and the stubbed estimate when stubbed", async () => {
    const { alice, id, config } = await matched();
    const d = alice.daemon;
    const l = d.handle(id);
    const session = l.sessionSender.address;
    const target = config.sessionGasWei;
    const sends = spySends(d, session);
    const asked: EstimateArgs[] = [];
    const answered: bigint[] = [];
    const restore = stubEstimate(d, session, async (args, real) => {
      asked.push(args);
      const gas = await real(args); // anvil's own estimate, recorded on the way (asserted below, not in here)
      answered.push(gas);
      return gas;
    });
    try {
      await d.idle();
      await setEthBalance(session, target / 10n); // drained below the floor
      await waitFor(async () => (await d.client.getBalance({ address: session })) === target, 10_000, "refill");
      await d.idle();
      expect(sends).toHaveLength(1);
      expect((await d.client.getTransaction({ hash: sends[0] })).gas).toBe(30_200n);
      // The estimate was asked for this very transfer: the wallet, the key, and the shortfall; anvil answered 21,000.
      expect(asked.at(-1)).toMatchObject({ account: alice.address, to: session, value: target - target / 10n });
      expect(answered.at(-1)).toBe(21_000n);
    } finally {
      restore();
    }
    // A node whose estimate is higher: the limit follows it.
    const restore2 = stubEstimate(d, session, async () => 40_000n);
    try {
      const refills = l.refills;
      await setEthBalance(session, target / 10n);
      await waitFor(async () => (await d.client.getBalance({ address: session })) === target, 10_000, "second refill");
      await d.idle();
      expect(sends).toHaveLength(2);
      expect((await d.client.getTransaction({ hash: sends[1] })).gas).toBe(53_000n);
      expect(l.refills).toBe(refills + 1);
    } finally {
      restore2();
    }
  });

  it("a failed estimate sends nothing -- never a guessed limit -- and raises session-gas-low", async () => {
    const { alice, id, config } = await matched();
    const d = alice.daemon;
    const l = d.handle(id);
    const session = l.sessionSender.address;
    const restore = stubEstimate(d, session, async () => {
      throw new Error("RPC unreachable");
    });
    try {
      await d.idle();
      const nonce = await nonceOf(d, alice.address);
      const refills = l.refills;
      await setEthBalance(session, config.sessionGasWei / 10n);
      const st = await waitFor(async () => {
        const s = await d.status(id);
        return s.attention === "session-gas-low" ? s : null;
      }, 10_000, "session-gas-low");
      expect(st.suggestedActions[0]).toMatch(/^fund your wallet: dispute gas for channel/);
      expect(l.sessionGasLow).toMatch(/gas estimate failed: RPC unreachable/);
      expect(l.refillBlockedUntil).toBeGreaterThan(0);
      await d.idle();
      expect(await nonceOf(d, alice.address)).toBe(nonce); // nothing was sent
      expect(l.refills).toBe(refills);
      expect(await d.client.getBalance({ address: session })).toBe(config.sessionGasWei / 10n);
    } finally {
      restore();
    }
  });
});

describe("Plan 6 Task 2 (audit-daemon I-1): a top-up that is mined but reverts is not a refill", () => {
  it("refill: not counted, raises session-gas-low, backs off -- and is sent once, not on every pass", async () => {
    const { alice, id, config } = await matched();
    const d = alice.daemon;
    const l = d.handle(id);
    const session = l.sessionSender.address;
    const target = config.sessionGasWei;
    // A node whose estimate misses the revert (the real one would fail the estimate, the path tested above), so
    // the top-up goes out, is mined, and reverts.
    const restore = stubEstimate(d, session, async () => 21_000n);
    const logs: string[] = [];
    (d as unknown as { opts: { log?: (m: string) => void } }).opts.log = (m) => logs.push(m);
    try {
      await d.idle();
      const nonce = await nonceOf(d, alice.address);
      const refills = l.refills;
      await anvil.setCode({ address: session, bytecode: REVERTS });
      await setEthBalance(session, target / 10n);
      for (let i = 0; i < 4; i++) {
        await d.idle();
        await d.mainPass();
      }
      await d.idle();
      expect(l.refills).toBe(refills); // before: 4 "refills"
      expect(await d.client.getBalance({ address: session })).toBe(target / 10n); // nothing arrived
      expect(l.sessionGasLow).toMatch(/top-up 0x[0-9a-f]{64} was mined but reverted/);
      expect(l.refillBlockedUntil).toBeGreaterThan(Date.now()); // before: 0
      expect(await nonceOf(d, alice.address)).toBe(nonce + 1); // one top-up, then the back-off held
      expect(logs.some((m) => /refilled the session key/.test(m))).toBe(false);
      expect((await d.status(id)).attention).toBe("session-gas-low");
    } finally {
      restore();
    }
  });

  it("funding: a reverted top-up backs funding off; no deposit goes in, and it is not re-sent every pass", async () => {
    const pair = await startPair();
    cleanups.push(pair.cleanup);
    const d = pair.alice.daemon;
    const { offerId } = await d.createOffer({ deposit: 1_000_000n, stakePerGame: 100_000n, challengeTimeout: 600n });
    const record = new RecordStore(pair.alice.home).offers().find((o) => o.offerId === offerId)!;
    const session = privateKeyToAccount(record.sessionKey).address;
    await anvil.setCode({ address: session, bytecode: REVERTS });
    const restore = stubEstimate(d, session, async () => 21_000n);
    const sends = spySends(d, session);
    try {
      await pair.bob.daemon.acceptOffer(offerId);
      const id = await waitFor(() => d.channelIds()[0], 20_000, "alice's channel");
      const l = d.handle(id);
      // Plan 6 Task 4: both, not the error alone. fund() sets lastError, then awaits a block read before it sets
      // fundBlockedUntil, so a poll can land between the two. arc-anvil's slower round trip exposed it (test:arc).
      await waitFor(
        () => /^funding: the session-key top-up 0x[0-9a-f]{64} was mined but reverted/.test(l.lastError ?? "") && l.fundBlockedUntil !== null,
        20_000,
        "funding backs off",
      );
      expect(l.fundBlockedUntil).not.toBeNull();
      for (let i = 0; i < 4; i++) {
        await d.idle();
        await d.mainPass();
      }
      await d.idle();
      expect(sends).toHaveLength(1); // before: one more reverted top-up on every pass
      expect((await d.hub.channelInfo(id)).funded[0]).toBe(false); // no deposit without dispute gas
      expect(await d.client.getBalance({ address: session })).toBe(0n);
    } finally {
      restore();
    }
  });

  it("TopUpRevertedError names the transaction that reverted", () => {
    const e = new TopUpRevertedError(`0x${"ab".repeat(32)}`);
    expect(e.name).toBe("TopUpRevertedError");
    expect(e.hash).toBe(`0x${"ab".repeat(32)}`);
    expect(e.message).toMatch(/was mined but reverted: nothing reached the key/);
  });
});
