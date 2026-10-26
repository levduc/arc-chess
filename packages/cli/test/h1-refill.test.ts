/**
 * Plan 6 hardening H1: what a failed session-key refill raises, what it tells the agent to do, and what ends its
 * back-off.
 * - Task 2 review Minor-2: a reverted top-up is not fixed by funding the wallet, so its action says so (and, on Arc,
 *   asks for no USDC), and a rise in the wallet's balance does not end its back-off.
 * - audit-daemon M-8: on Arc every inflow raises the wallet's balance; only a rise that covers the refill ends a
 *   back-off the wallet's own shortfall started.
 * - audit-daemon M-5: refills that keep failing in transit (no receipt, dropped) raise `session-gas-low` after
 *   `REFILL_TRANSIENT_FAILURES_ALERT` in a row instead of never telling the agent.
 */
import type { Hex } from "viem";
import { afterEach, describe, expect, it } from "vitest";
import { TxDroppedError, TxFeeCapError, TxInsufficientFundsError, TxReceiptMissingError } from "@arena/sdk";
import {
  REFILL_TRANSIENT_FAILURES_ALERT,
  SessionGasEstimateError,
  TopUpRevertedError,
  refillFailureCause,
  sessionGasLowAction,
  type ArenaDaemon,
} from "../src/index.js";
import { setEthBalance } from "../../sdk/test/helpers/chain.js";
import { startPair, waitFor } from "./helpers/harness.js";

const ANVIL_DEFAULT_BALANCE = 10n ** 22n;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

/** An Open channel whose periodic timer is parked once it is open: every pass below is one this test drives. */
async function openChannel() {
  const pair = await startPair();
  cleanups.push(pair.cleanup);
  const { offerId } = await pair.alice.daemon.createOffer({ deposit: 1_000_000n, stakePerGame: 100_000n, challengeTimeout: 600n });
  await pair.bob.daemon.acceptOffer(offerId);
  const id = await waitFor(() => pair.alice.daemon.channelIds()[0], 20_000, "match");
  await waitFor(async () => (await pair.alice.daemon.hub.channelInfo(id)).phase === "Open", 20_000, "funding");
  const d = pair.alice.daemon;
  clearInterval((d as unknown as { timer?: NodeJS.Timeout }).timer);
  await d.idle();
  return { ...pair, d, id };
}

/** Replaces the refill's top-up with `fail` (counting calls) and drops the key below its floor. */
async function failingRefills(d: ArenaDaemon, id: Hex, target: bigint, fail: () => unknown) {
  const internals = d as unknown as { topUpSession(l: unknown): Promise<boolean> };
  const calls = { n: 0 };
  internals.topUpSession = () => {
    calls.n++;
    return Promise.reject(fail());
  };
  await setEthBalance(d.handle(id).sessionSender.address, target / 10n);
  return calls;
}

const pass = async (d: ArenaDaemon) => {
  await d.idle();
  await d.tick();
};

describe("H1: refill failure causes", () => {
  it("refillFailureCause: funds, fee cap, estimate and revert raise at once; anything else is transient", () => {
    const hash = `0x${"ab".repeat(32)}` as Hex;
    expect(refillFailureCause(new TxInsufficientFundsError("0x00000000000000000000000000000000000000a1"))).toEqual({ kind: "funds" });
    expect(refillFailureCause(new TxFeeCapError(1, 40n))).toEqual({ kind: "fee-cap" });
    expect(refillFailureCause(new SessionGasEstimateError(new Error("x"), "gas"))).toEqual({ kind: "estimate" });
    expect(refillFailureCause(new TopUpRevertedError(hash))).toEqual({ kind: "reverted", txHash: hash });
    expect(refillFailureCause(new TxDroppedError(hash))).toBeNull();
    expect(refillFailureCause(new TxReceiptMissingError(hash, 1n))).toBeNull();
  });

  it("a reverted top-up: its own remedy, no 'fund your wallet', and a wallet balance rise does not end its back-off", async () => {
    const { d, id, alice, config } = await openChannel();
    const hash = `0x${"cd".repeat(32)}` as Hex;
    try {
      const calls = await failingRefills(d, id, config.sessionGasWei, () => new TopUpRevertedError(hash));
      await pass(d);
      expect(calls.n).toBe(1);
      const st = await d.status(id);
      expect(st.attention).toBe("session-gas-low");
      expect(d.handle(id).sessionGasLowCause).toEqual({ kind: "reverted", txHash: hash });
      expect(st.suggestedActions[0]).toMatch(new RegExp(`^check the refill: a top-up of channel ${id}'s session key reverted on-chain \\(tx ${hash}\\)`));
      expect(st.suggestedActions[0]).toContain("funding the wallet will not fix it");
      expect(st.suggestedActions.join("\n")).not.toMatch(/fund your wallet/);
      // Before H1, funding the wallet ended the back-off and bought one more reverted send.
      await pass(d); // the gate's first look
      await setEthBalance(alice.address, ANVIL_DEFAULT_BALANCE * 2n);
      for (let i = 0; i < 5; i++) await pass(d);
      expect(calls.n).toBe(1);
      expect(d.handle(id).refillBlockedUntil).toBeGreaterThan(Date.now());
    } finally {
      await setEthBalance(alice.address, ANVIL_DEFAULT_BALANCE);
    }
  });

  it("audit-daemon M-8: a wallet shortfall's back-off ends only on a rise that covers the refill", async () => {
    const { d, id, alice, config } = await openChannel();
    try {
      await setEthBalance(alice.address, 1_000n); // the wallet genuinely cannot pay
      const calls = await failingRefills(d, id, config.sessionGasWei, () => new TxInsufficientFundsError(alice.address));
      await pass(d);
      expect(calls.n).toBe(1);
      expect(d.handle(id).sessionGasLowCause).toEqual({ kind: "funds" });
      expect((await d.status(id)).suggestedActions[0]).toMatch(/^fund your wallet: /); // the one cause funding fixes
      await pass(d); // the gate's first look at the wallet
      // An unrelated inflow (on Arc: a payout, a sweep of another channel) that does not cover the refill.
      await setEthBalance(alice.address, 2_000n);
      for (let i = 0; i < 3; i++) await pass(d);
      expect(calls.n).toBe(1);
      // One that covers it ends the back-off at once: the refill is retried on the next pass.
      await setEthBalance(alice.address, ANVIL_DEFAULT_BALANCE);
      await pass(d);
      expect(calls.n).toBe(2);
    } finally {
      await setEthBalance(alice.address, ANVIL_DEFAULT_BALANCE);
    }
  });

  it("audit-daemon M-5: refills failing in transit raise session-gas-low after REFILL_TRANSIENT_FAILURES_ALERT in a row", async () => {
    const { d, id, config } = await openChannel();
    const hash = `0x${"ef".repeat(32)}` as Hex;
    const calls = await failingRefills(d, id, config.sessionGasWei, () => new TxReceiptMissingError(hash, 5n));
    const l = d.handle(id);
    for (let i = 1; i < REFILL_TRANSIENT_FAILURES_ALERT; i++) {
      l.refillBlockedUntil = 0; // past the back-off: this test is about the count, not the timing
      await pass(d);
      expect(calls.n).toBe(i);
      expect(l.sessionGasLow).toBeNull(); // still transient
    }
    l.refillBlockedUntil = 0;
    await pass(d);
    expect(calls.n).toBe(REFILL_TRANSIENT_FAILURES_ALERT);
    expect(l.sessionGasLowCause).toEqual({ kind: "failing", failures: REFILL_TRANSIENT_FAILURES_ALERT });
    expect(l.sessionGasLow).toMatch(new RegExp(`the last ${REFILL_TRANSIENT_FAILURES_ALERT} refills failed in transit`));
    const st = await d.status(id);
    expect(st.attention).toBe("session-gas-low");
    expect(st.suggestedActions[0]).toMatch(/^check the RPC: /);
    expect(st.suggestedActions[0]).toContain("funding the wallet will not fix it");
    // A refill that goes through clears it all.
    const internals = d as unknown as { topUpSession(l: unknown): Promise<boolean> };
    internals.topUpSession = async () => {
      await setEthBalance(l.sessionSender.address, config.sessionGasWei);
      return true;
    };
    l.refillBlockedUntil = 0;
    await pass(d);
    expect(l.sessionGasLow).toBeNull();
    expect(l.sessionGasLowCause).toBeNull();
    expect(l.refillTransientFailures).toBe(0);
  });
});

describe("H1: sessionGasLowAction by cause (Task 2 review Minor-2; H2's concern: no USDC ask unless funding fixes it)", () => {
  const id = `0x${"12".repeat(32)}` as Hex;
  const reason = "the session key holds 1000 wei, below the floor of 168000000000000000, and the wallet could not refill it: x";
  const ARC = { chainId: 5042, sessionGasWei: 336_000_000_000_000_000n, feeCeilingWei: 40_000_000_000n };

  it("on Arc, only funds (or no cause) asks the human for USDC; every other cause names its own remedy and asks for none", () => {
    for (const cause of [undefined, null, { kind: "funds" } as const]) {
      expect(sessionGasLowAction(id, reason, ARC, cause)).toMatch(/^fund your wallet: .*ask your human to send at least 0\.356000 USDC/);
    }
    const others = [
      [{ kind: "fee-cap" } as const, /^wait: /],
      [{ kind: "estimate" } as const, /^check the RPC: /],
      [{ kind: "reverted", txHash: `0x${"ab".repeat(32)}` } as const, /^check the refill: .*reverted on-chain \(tx 0xab/],
      [{ kind: "failing", failures: 3 } as const, /^check the RPC: .*the last 3 refills failed/],
    ] as const;
    for (const [cause, start] of others) {
      for (const gasFunding of [ARC, undefined]) {
        const text = sessionGasLowAction(id, reason, gasFunding, cause);
        expect(text).toMatch(start);
        expect(text).toContain("funding the wallet will not fix it");
        expect(text).not.toMatch(/fund your wallet|ask your human to send/);
      }
      // The reason is still shown in USDC on Arc.
      expect(sessionGasLowAction(id, reason, ARC, cause)).toContain("0.000000000000001 USDC");
    }
  });
});
