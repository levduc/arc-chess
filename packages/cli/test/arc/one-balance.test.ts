/**
 * Plan 6 Task 4 (spec §2.1, §3): one balance on arc-anvil, through the Arc-like harness (`./harness.ts`): the hub's
 * token is the native-USDC proxy at 0x3600...0000 and a test-only `CHAIN_PROFILES[31337]` carries Arc's values.
 * - `wallet` prints the native balance / 10^12, rounded down, as `usdc`, and nothing else; the proxy agrees.
 * - `fund`'s USDC-only need includes the gas.
 * - `withdraw --all` keeps the reserve, `--amount` refuses to dip into it, and the withdraw's own gas comes out of
 *   that same balance (reconciled exactly from its receipt).
 * - The reserve of an open channel gates `createOffer` and `acceptOffer`, and a channel opened right at the gate leaves
 *   the other channel's refill money in the wallet.
 * Skipped on stock anvil (no native-USDC proxy there): `pnpm test:arc` runs it.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Address } from "viem";
import { RecordStore, runCli, type CliIo } from "../../src/index.js";
import { formatUsdc6 } from "../../src/funding.js";
import { CHAIN, ON_ARC_ANVIL, ARC_FLOOR_WEI, publicClient, setEthBalance } from "../../../sdk/test/helpers/chain.js";
import { waitFor } from "../helpers/harness.js";
import {
  ARC_SESSION_GAS,
  ARC_USDC,
  E12,
  FEE,
  GWEI,
  arcHome,
  deployArcHub,
  gasPaid,
  installArcLikeProfile,
  minedFrom,
  nativeOf,
  newAddress,
  startArcPair,
  startRpcRecorder,
  usdcOf,
  type ArcEnv,
} from "./harness.js";

/** 500,000 gas x the profile's 40 gwei ceiling: the wallet's own transactions, 0.02 USDC. */
const WALLET_GAS_RESERVE = 20_000n;
/** One open channel's refill money: its sessionGasWei, 0.336 USDC. */
const CHANNEL_RESERVE = ARC_SESSION_GAS / E12;

/** A home's host for the CLI commands here: a closed loopback port, as in withdraw.test.ts. `withdraw`'s in-process
 *  daemon only retries its host connection in the background, and `fund`'s `/templates` is answered by `cliIo`. */
const NOWHERE = { serverUrl: "http://127.0.0.1:9" };

/** A CliIo on the real chain; `/templates` (fund) answered with a chess template, as the host would. */
function cliIo(home: string) {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    env: { ARENA_HOME: home },
    fetch: (async (url: string, init?: RequestInit) => {
      if (url.endsWith("/templates")) {
        const limits = { maxDepositPerPlayer: "10000000", maxCommittedEscrow: "1000000000000", committedEscrow: "0", paused: false };
        return new Response(JSON.stringify([{ id: "chess", version: "1", limits }]), { status: 200 });
      }
      return fetch(url, init);
    }) as unknown as typeof fetch,
    out: (s: string) => out.push(s),
    err: (s: string) => err.push(s),
  };
  return { out, err, io, json: () => JSON.parse(out.join("\n")) as Record<string, unknown> };
}

async function setOwnerViaCli(home: string, owner: Address): Promise<void> {
  const t = cliIo(home);
  expect(await runCli(["owner", "set", owner], t.io), t.err.join("\n")).toBe(0);
}

describe.skipIf(!ON_ARC_ANVIL)("Plan 6 Task 4 (arc-anvil): one balance", () => {
  let uninstall: () => void;
  let recorder: Awaited<ReturnType<typeof startRpcRecorder>>;
  let env: ArcEnv;
  const cleanups: Array<() => Promise<void>> = [];
  beforeAll(async () => {
    uninstall = installArcLikeProfile();
    recorder = await startRpcRecorder();
    env = await deployArcHub();
  });
  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()!();
  });
  afterAll(async () => {
    uninstall?.();
    await recorder?.close();
  });

  it("the harness is Arc-like: chain 31337, the 20 gwei floor, the live USDC proxy as the hub's token, one balance", async () => {
    const pub = publicClient();
    expect(await pub.getChainId()).toBe(CHAIN.id);
    expect((await pub.getBlock()).baseFeePerGas).toBe(ARC_FLOOR_WEI);
    expect(await pub.getCode({ address: ARC_USDC })).toMatch(/^0x[0-9a-f]{100,}/);
    const token = await pub.readContract({
      address: env.hub,
      abi: [{ type: "function", name: "token", inputs: [], outputs: [{ type: "address" }], stateMutability: "view" }] as const,
      functionName: "token",
    });
    expect(token).toBe(ARC_USDC);
    const who = newAddress();
    await setEthBalance(who, 3n * 10n ** 18n + 999_999_999_999n); // 3 USDC and just under one micro-USDC
    expect(await usdcOf(who)).toBe(3_000_000n); // the proxy truncates: one balance, two views
  });

  it("wallet prints one usdc value, the native balance / 10^12 rounded down, with no native key; --wait-for-native is refused", async () => {
    const wei = 7_123456_789012345678n; // 7.123456 USDC, and 0.789012345678 of a micro-USDC more
    const { home, address } = await arcHome(env, recorder.url, wei, NOWHERE);
    const t = cliIo(home);
    expect(await runCli(["wallet"], t.io), t.err.join("\n")).toBe(0);
    expect(t.json()).toEqual({ address, chainId: CHAIN.id, usdc: "7.123456" });
    expect(await usdcOf(address)).toBe(7_123456n); // the ERC-20 view of the same balance agrees
    expect(await nativeOf(address)).toBe(wei);

    const w = cliIo(home);
    expect(await runCli(["wallet", "--wait-for-native", "1"], w.io)).toBe(1);
    expect(w.err.join("\n")).toMatch(/--wait-for-native does not apply on Arc-like .*gas is paid in USDC/);
  });

  it("fund asks for USDC only: usdc.need = deposit + fee + ceil((sessionGasWei + 500,000 x 40 gwei) / 10^12)", async () => {
    const wei = 1_500000n * E12 + 999n; // 1.5 USDC (+ dust the proxy and `fund` round away)
    const { home, address } = await arcHome(env, recorder.url, wei, NOWHERE);
    const t = cliIo(home);
    expect(await runCli(["fund", "--games", "3", "--stake", "1"], t.io), t.err.join("\n")).toBe(0);
    const printed = t.json();
    expect(printed).not.toHaveProperty("native");
    expect(printed.deposit).toBe("3.000000");
    expect(printed.feePerPlayer).toBe("0.005000"); // read from this hub on chain
    // The gas folded in: (0.336e18 + 500,000 x 40 gwei) / 10^12 = 0.356 USDC.
    const gas = (ARC_SESSION_GAS + 500_000n * 40n * GWEI + E12 - 1n) / E12;
    expect(gas).toBe(356_000n);
    const need = 3_000_000n + FEE + gas;
    expect(printed.usdc).toEqual({ have: "1.500000", need: "3.361000", shortfall: "1.861000", reserved: "0.000000" });
    expect(need - 1_500_000n).toBe(1_861_000n);
    expect(printed.message).toContain(`Please send 1.861000 USDC to ${address}`);
    expect(String(printed.message)).not.toMatch(/native/i);
  });

  it("withdraw: --amount refuses the reserve, --all keeps it, and the withdraw's own gas comes out of the same balance", async () => {
    const wei = 5n * 10n ** 18n + 123n;
    const { home, address } = await arcHome(env, recorder.url, wei, NOWHERE);
    const owner = newAddress();
    await setOwnerViaCli(home, owner);
    const before = await publicClient().getBlockNumber();

    const over = cliIo(home);
    expect(await runCli(["withdraw", "--amount", "4.980001"], over.io)).toBe(1);
    expect(over.err.join("\n")).toContain("4.980001 USDC is more than this wallet can withdraw (4.980000 USDC)");
    expect(over.err.join("\n")).toContain("0.020000 USDC of it is the gas reserve");
    expect(await nativeOf(owner)).toBe(0n);

    const all = cliIo(home);
    expect(await runCli(["withdraw", "--all"], all.io), all.err.join("\n")).toBe(0);
    expect(all.json().amount).toBe("4.980000"); // floor(5.000000000000000123) - 0.02
    expect(await usdcOf(owner)).toBe(4_980_000n);
    expect(await nativeOf(owner)).toBe(4_980_000n * E12);
    // The wallet sent exactly one transaction, the transfer; its gas was paid from the reserve itself.
    const mined = await minedFrom([address], before);
    expect(mined).toHaveLength(1);
    expect(mined[0]).toMatchObject({ to: ARC_USDC, value: 0n, status: "success" });
    const after = await nativeOf(address);
    expect(after).toBe(wei - 4_980_000n * E12 - gasPaid(mined));
    expect(all.json().usdcAfter).toBe(formatUsdc6(after / E12));
    expect(after / E12).toBeLessThan(WALLET_GAS_RESERVE); // below the reserve by exactly the withdraw's gas

    // What is left is less than the reserve: nothing to withdraw.
    const empty = cliIo(home);
    expect(await runCli(["withdraw", "--all"], empty.io)).toBe(1);
    expect(empty.err.join("\n")).toContain("nothing to withdraw");
  });

  it("an open channel's reserve gates withdraw, createOffer and acceptOffer; a channel opened at the gate leaves it in the wallet", async () => {
    const pair = await startArcPair(recorder.url, 5n * 10n ** 18n);
    cleanups.push(pair.cleanup);
    const { alice, bob } = pair;
    const { offerId } = await alice.daemon.createOffer({ deposit: 1_000_000n, stakePerGame: 100_000n, challengeTimeout: 600n });
    await bob.daemon.acceptOffer(offerId);
    const a = await waitFor(() => bob.daemon.channelIds()[0], 20_000, "channel A");
    await waitFor(async () => (await bob.daemon.hub.channelInfo(a)).phase === "Open", 30_000, "A open");
    await waitFor(() => !bob.daemon.handle(a).refilling, 5_000, "no top-up in flight");
    await setOwnerViaCli(bob.home, newAddress());

    // Bob now holds exactly 2 USDC. With A unsettled, the reserve is 0.336 + 0.02 = 0.356 USDC.
    const HOLDS = 2_000_000n;
    await setEthBalance(bob.address, HOLDS * E12);
    const reserve = CHANNEL_RESERVE + WALLET_GAS_RESERVE;
    expect(reserve).toBe(356_000n);
    const refused = bob.daemon.withdraw({ amount: HOLDS - reserve + 1n });
    await expect(refused).rejects.toMatchObject({ code: 400 });
    await expect(refused).rejects.toThrow("0.356000 USDC of it is the gas reserve");
    await expect(refused).rejects.toThrow("for the session gas of 1 unsettled channel(s)");

    // A new channel needs d + fee + ceil((0.336 own + 0.336 for A + 0.02) USDC): at 2 USDC, d is at most 1.303.
    const MAX = HOLDS - FEE - (2n * ARC_SESSION_GAS + 500_000n * 40n * GWEI) / E12;
    expect(MAX).toBe(1_303_000n);
    const offersBefore = new RecordStore(bob.home).offers().length;
    const tooBig = bob.daemon.createOffer({ deposit: MAX + 1n, stakePerGame: 100_000n, challengeTimeout: 600n });
    await expect(tooBig).rejects.toMatchObject({ code: 409 });
    await expect(tooBig).rejects.toThrow("0.000001 USDC short of the 2.000001 USDC this channel needs");
    await expect(tooBig).rejects.toThrow("the 0.356000 USDC gas reserve");
    expect(new RecordStore(bob.home).offers().length).toBe(offersBefore);

    const big = await alice.daemon.createOffer({ deposit: MAX + 1n, stakePerGame: 100_000n, challengeTimeout: 600n });
    const accept = bob.daemon.acceptOffer(big.offerId);
    await expect(accept).rejects.toMatchObject({ code: 409 });
    await expect(accept).rejects.toThrow("cannot accept this offer: this wallet holds 2.000000 USDC, 0.000001 USDC short");
    expect(new RecordStore(bob.home).offer(big.offerId)).toBeNull();

    // Exactly at the gate: B opens, and A's 0.336 USDC of refill money is still in the wallet, less only the gas of
    // B's approve, top-up and deposit (the 0.02 wallet-gas term pays for those).
    const start = await publicClient().getBlockNumber();
    const fits = await alice.daemon.createOffer({ deposit: MAX, stakePerGame: 100_000n, challengeTimeout: 600n });
    await bob.daemon.acceptOffer(fits.offerId);
    const b = await waitFor(() => bob.daemon.channelIds().find((id) => id !== a), 20_000, "channel B");
    await waitFor(async () => (await bob.daemon.hub.channelInfo(b)).phase === "Open", 30_000, "B open");
    await waitFor(() => !bob.daemon.handle(b).refilling, 5_000, "no top-up in flight");
    const bobTxs = await minedFrom([bob.address], start);
    const left = await nativeOf(bob.address);
    expect(left).toBe(HOLDS * E12 - (MAX + FEE) * E12 - ARC_SESSION_GAS - gasPaid(bobTxs));
    expect(left).toBeGreaterThanOrEqual(ARC_SESSION_GAS); // A can still be refilled in full
    expect(gasPaid(bobTxs)).toBeLessThanOrEqual(WALLET_GAS_RESERVE * E12);
  });
});
