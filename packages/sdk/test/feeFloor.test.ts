/**
 * Plan 6 Task 2 (spec §2.3, audit-daemon I-6): `SerialTxSender`'s `minFeePerGas`, the chain's fee floor. Arc's
 * mempool silently drops a transaction whose `maxFeePerGas` is under 20 gwei, and arc-anvil does not model that at
 * every chain id (tools/arc-foundry.md), so the floor is asserted here, on the fees the sender emits.
 *
 * Every fresh send and every same-nonce replacement must satisfy:
 *   - `maxFeePerGas >= minFeePerGas` (or a legacy `gasPrice >= minFeePerGas`);
 *   - `maxPriorityFeePerGas <= maxFeePerGas`;
 *   - the floor is the LAST step, after the cap and the balance clamp: clamped up, or refused with
 *     `TxInsufficientFundsError` when the balance cannot pay it -- never clamped down under it.
 * With no `minFeePerGas`, every emitted fee is exactly as before.
 *
 * The stub node is keyed by nonce (one transaction per nonce; a replacement must raise both fees by 10 %; a used
 * nonce and a send the balance cannot cover are refused). `chainFloor` makes it behave like Arc: a transaction under
 * it is accepted and then silently forgotten.
 */
import { describe, expect, it } from "vitest";
import {
  Eip1559FeesNotSupportedError,
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
  type Hex,
  type TransactionReceipt,
} from "viem";
import {
  SerialTxSender,
  TxDroppedError,
  TxFeeCapError,
  TxInsufficientFundsError,
  TxStuckError,
  NO_FEE_CEILING,
  waitOrReplace,
  type ReceiptClient,
  type TrackerClient,
  type TxRequest,
  type TxSender,
} from "../src/index.js";

const GWEI = 10n ** 9n;
const FLOOR = 20n * GWEI; // Arc's
const GAS = 21_000n;
const ADDR = "0x00000000000000000000000000000000000000bb" as const;
const hx = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}`;
const to = (n: number): Hex => `0x${n.toString(16).padStart(40, "0")}`;
const yieldTurn = () => new Promise<void>((r) => setImmediate(r));

type Sent = { hash: Hex; nonce: number; value: bigint; gas: bigint; maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint; gasPrice?: bigint };
const feeOf = (t: { maxFeePerGas?: bigint; gasPrice?: bigint }) => t.maxFeePerGas ?? t.gasPrice ?? 0n;

function node(
  o: { balance?: bigint; estimate?: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }; legacyEstimate?: bigint; legacyOnly?: boolean; chainFloor?: bigint } = {},
) {
  const estimate = { ...(o.estimate ?? { maxFeePerGas: 1n * GWEI, maxPriorityFeePerGas: 1n * GWEI }) };
  const state = { balance: o.balance ?? 10n ** 18n, latest: 0 };
  let seq = 1;
  const pool = new Map<number, Sent>();
  const receipts = new Map<Hex, Sent>();
  /** Every transaction handed to the node, accepted or refused, with its fee fields exactly as sent. */
  const attempts: Sent[] = [];
  const pendingCount = () => {
    let n = state.latest;
    while (pool.has(n)) n++;
    return n;
  };
  const inner: TxSender = {
    address: ADDR,
    async send(tx: TxRequest) {
      const t: Sent = {
        hash: hx(seq++),
        nonce: tx.nonce ?? pendingCount(),
        value: tx.value ?? 0n,
        gas: tx.gas ?? GAS,
        ...(tx.maxFeePerGas !== undefined ? { maxFeePerGas: tx.maxFeePerGas, maxPriorityFeePerGas: tx.maxPriorityFeePerGas } : {}),
        ...(tx.gasPrice !== undefined ? { gasPrice: tx.gasPrice } : {}),
      };
      attempts.push(t);
      if (t.nonce < state.latest) throw new Error("nonce too low");
      if (feeOf(t) * t.gas + t.value > state.balance) throw new Error("insufficient funds for gas * price + value");
      const old = pool.get(t.nonce);
      if (old && (feeOf(t) * 10n < feeOf(old) * 11n || (t.maxPriorityFeePerGas ?? 0n) * 10n < (old.maxPriorityFeePerGas ?? 0n) * 11n)) {
        throw new Error("replacement transaction underpriced");
      }
      // Arc: under the floor, the node takes it and then forgets it -- no error, it never lands.
      if (o.chainFloor !== undefined && feeOf(t) < o.chainFloor) return t.hash;
      pool.set(t.nonce, t);
      return t.hash;
    },
  };
  const raw = {
    async getTransactionReceipt({ hash }: { hash: Hex }) {
      await yieldTurn();
      const t = receipts.get(hash);
      if (!t) throw new TransactionReceiptNotFoundError({ hash });
      return { transactionHash: t.hash, status: "success", blockNumber: 1n } as unknown as TransactionReceipt;
    },
    async getTransaction({ hash }: { hash: Hex }) {
      await yieldTurn();
      const t = receipts.get(hash);
      if (t) return { ...t, blockNumber: 1n };
      for (const p of pool.values()) if (p.hash === hash) return { ...p, blockNumber: null };
      throw new TransactionNotFoundError({ hash });
    },
    async getTransactionCount({ blockTag }: { blockTag?: string }) {
      return blockTag === "pending" ? pendingCount() : state.latest;
    },
    async estimateFeesPerGas(args?: { type?: string }) {
      if (args?.type === "legacy") return { gasPrice: o.legacyEstimate ?? estimate.maxFeePerGas };
      if (o.legacyOnly) throw new Eip1559FeesNotSupportedError();
      return { ...estimate };
    },
    async estimateGas() {
      return GAS;
    },
    async getBalance() {
      return state.balance;
    },
  };
  /** Mines every consecutive pending nonce. */
  const mine = () => {
    while (pool.has(state.latest)) {
      const t = pool.get(state.latest)!;
      pool.delete(state.latest);
      receipts.set(t.hash, t);
      state.balance -= t.value;
      state.latest++;
    }
  };
  return { inner, client: raw as unknown as ReceiptClient & TrackerClient, pool, attempts, estimate, state, mine };
}

/** Every attempt meets the floor, and no priority fee is above its max fee. */
function expectFloored(attempts: Sent[], floor = FLOOR) {
  expect(attempts.length).toBeGreaterThan(0);
  for (const t of attempts) {
    expect(feeOf(t)).toBeGreaterThanOrEqual(floor);
    if (t.maxFeePerGas !== undefined) expect(t.maxPriorityFeePerGas ?? 0n).toBeLessThanOrEqual(t.maxFeePerGas);
  }
}

describe("Plan 6: SerialTxSender's fee floor (minFeePerGas) on fresh sends", () => {
  it("an estimate under the floor is raised to it; the priority fee stays at or under the max fee", async () => {
    const n = node({ estimate: { maxFeePerGas: 1n * GWEI, maxPriorityFeePerGas: 1n * GWEI } });
    const s = new SerialTxSender(n.inner, n.client, { minFeePerGas: FLOOR });
    expect(s.minFeePerGas).toBe(FLOOR);
    await s.send({ to: to(1), data: "0x" });
    expect(n.attempts).toHaveLength(1);
    expect(n.attempts[0]).toMatchObject({ maxFeePerGas: FLOOR, maxPriorityFeePerGas: 1n * GWEI });
    expect(s.tracked()[0].lastFees).toEqual({ maxFeePerGas: FLOOR, maxPriorityFeePerGas: 1n * GWEI }); // later bumps start here
  });

  it("an estimate above the floor is sent unchanged (Arc's own 29 / 5 gwei)", async () => {
    const n = node({ estimate: { maxFeePerGas: 29n * GWEI, maxPriorityFeePerGas: 5n * GWEI } });
    await new SerialTxSender(n.inner, n.client, { minFeePerGas: FLOOR }).send({ to: to(1), data: "0x" });
    expect(n.attempts[0]).toMatchObject({ maxFeePerGas: 29n * GWEI, maxPriorityFeePerGas: 5n * GWEI });
  });

  it("the floor beats the fee cap: with the cap under the floor, the send still goes out at the floor", async () => {
    const n = node(); // estimate 1 gwei: the cap is max(4 x 1 gwei, 0) = 4 gwei
    await new SerialTxSender(n.inner, n.client, { feeCeiling: 0n, minFeePerGas: FLOOR }).send({ to: to(1), data: "0x" });
    expect(n.attempts[0].maxFeePerGas).toBe(FLOOR);
  });

  it("a balance that pays the estimate but not the floor is refused: TxInsufficientFundsError, nothing sent, nothing tracked", async () => {
    const value = 7n * 10n ** 15n;
    const n = node({ balance: value + GAS * FLOOR - 1n }); // 1 wei short of the floor, after the value
    const s = new SerialTxSender(n.inner, n.client, { minFeePerGas: FLOOR });
    const err = await s.send({ to: to(1), data: "0x", value }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TxInsufficientFundsError);
    expect(String((err as Error).cause)).toMatch(/fee floor of 20000000000/);
    expect(n.attempts).toHaveLength(0);
    expect(s.tracked()).toEqual([]);
    // Exactly enough: sent, at the floor.
    n.state.balance += 1n;
    await s.send({ to: to(1), data: "0x", value });
    expect(n.attempts).toHaveLength(1);
    expect(n.attempts[0].maxFeePerGas).toBe(FLOOR);
  });

  it("a legacy-only chain: the gas price is floored too", async () => {
    const n = node({ legacyOnly: true, legacyEstimate: 2n * GWEI });
    await new SerialTxSender(n.inner, n.client, { minFeePerGas: FLOOR }).send({ to: to(1), data: "0x" });
    expect(n.attempts[0]).toMatchObject({ gasPrice: FLOOR });
    expect(n.attempts[0].maxFeePerGas).toBeUndefined();
  });

  it("why: on a chain that drops under-floor transactions, a sender without the floor loses its send; one with it lands", async () => {
    const without = node({ chainFloor: FLOOR });
    const plain = new SerialTxSender(without.inner, without.client);
    const req: TxRequest = { to: to(1), data: "0x" };
    const a = await plain.send(req);
    const lost = await waitOrReplace(without.client, plain, req, a, { timeoutMs: 10, pollMs: 2 }).catch((e: unknown) => e);
    expect(lost).toBeInstanceOf(TxDroppedError);

    const withFloor = node({ chainFloor: FLOOR });
    const s = new SerialTxSender(withFloor.inner, withFloor.client, { minFeePerGas: FLOOR });
    const b = await s.send(req);
    withFloor.mine();
    const r = await waitOrReplace(withFloor.client, s, req, b, { timeoutMs: 50, pollMs: 2 });
    expect(r.transactionHash).toBe(b);
  });
});

describe("Plan 6: the fee floor on same-nonce replacements", () => {
  it("replaceReleased, known fees: a new intent replacing a given-up transaction is over the floor", async () => {
    const n = node();
    const s = new SerialTxSender(n.inner, n.client, { minFeePerGas: FLOOR });
    const req: TxRequest = { to: to(1), data: "0x01" };
    const a = await s.send(req);
    await waitOrReplace(n.client, s, req, a, { timeoutMs: 5, pollMs: 2, maxReplacements: 0 }).catch(() => undefined);
    expect(s.tracked()).toMatchObject([{ nonce: 0, state: "released" }]);
    const b = await s.send({ to: to(2), data: "0x02" });
    expect(n.attempts.find((t) => t.hash === b)!.nonce).toBe(0);
    expectFloored(n.attempts);
    expect(n.attempts[1].maxFeePerGas! * 1000n).toBeGreaterThanOrEqual(FLOOR * 1125n); // bumped over the floored original
  });

  it("replaceReleased, unknown fees (a nonce adopted after a restart): 2 x an under-floor estimate is raised to the floor", async () => {
    const n = node();
    // Left pending by an earlier run (no floor), at the 1 gwei estimate.
    await new SerialTxSender(n.inner, n.client).send({ to: to(1), data: "0xaa" });
    expect(n.attempts[0].maxFeePerGas).toBe(1n * GWEI);
    const s = new SerialTxSender(n.inner, n.client, { minFeePerGas: FLOOR }); // the daemon restarts
    const h = await s.send({ to: to(2), data: "0xbb" });
    const t = n.attempts.find((x) => x.hash === h)!;
    expect(t.nonce).toBe(0); // adopted and replaced
    expect(t).toMatchObject({ maxFeePerGas: FLOOR, maxPriorityFeePerGas: 2n * GWEI });
    expect(n.pool.get(0)!.hash).toBe(h);
  });

  it("replaceReleased, unknown fees: a balance that pays 2 x the estimate but not the floor is refused, and the entry is left released", async () => {
    const n = node();
    await new SerialTxSender(n.inner, n.client).send({ to: to(1), data: "0xaa" });
    n.state.balance = GAS * 15n * GWEI;
    const s = new SerialTxSender(n.inner, n.client, { minFeePerGas: FLOOR });
    const err = await s.send({ to: to(2), data: "0xbb" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TxInsufficientFundsError);
    expect(n.attempts).toHaveLength(1); // only the earlier run's
    expect(s.tracked()).toMatchObject([{ nonce: 0, state: "released" }]);
  });

  it("replaceReleased's 'underpriced' raise loop stays over the floor", async () => {
    const n = node();
    // A pending transaction priced above anything we know (sent by an earlier run, at 30 gwei).
    await new SerialTxSender(n.inner, n.client).send({ to: to(1), data: "0xaa", nonce: 0, gas: GAS, maxFeePerGas: 30n * GWEI, maxPriorityFeePerGas: 3n * GWEI });
    const s = new SerialTxSender(n.inner, n.client, { minFeePerGas: FLOOR });
    const h = await s.send({ to: to(2), data: "0xbb" });
    const mine = n.attempts.slice(1);
    expect(mine.length).toBeGreaterThan(1); // floored to 20 gwei, refused as underpriced, then raised
    expectFloored(mine);
    expect(n.pool.get(0)!.hash).toBe(h);
  });

  it("the floor beats the cap, but a raise above the cap is still refused: TxFeeCapError, never a send under the floor", async () => {
    const n = node();
    await new SerialTxSender(n.inner, n.client).send({ to: to(1), data: "0xaa", nonce: 0, gas: GAS, maxFeePerGas: 30n * GWEI, maxPriorityFeePerGas: 3n * GWEI });
    const s = new SerialTxSender(n.inner, n.client, { feeCeiling: 0n, minFeePerGas: FLOOR }); // cap 4 gwei < floor
    const err = await s.send({ to: to(2), data: "0xbb" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TxFeeCapError);
    expectFloored(n.attempts.slice(1));
    expect(n.pool.get(0)!.hash).toBe(n.attempts[0].hash); // the old one still stands
  });

  it("replaceOwn (tracked), through waitOrReplace's own replacements: every one is over the floor, each raised", async () => {
    const n = node({ estimate: { maxFeePerGas: 1_000n, maxPriorityFeePerGas: 1n } }); // arc-anvil's collapsed estimate
    const s = new SerialTxSender(n.inner, n.client, { feeCeiling: NO_FEE_CEILING, minFeePerGas: FLOOR });
    const req: TxRequest = { to: to(1), data: "0x" };
    const a = await s.send(req);
    const err = await waitOrReplace(n.client, s, req, a, { timeoutMs: 5, pollMs: 2, maxReplacements: 3 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TxStuckError); // nothing is mined in this test
    expect(n.attempts).toHaveLength(4);
    expectFloored(n.attempts);
    for (let i = 1; i < n.attempts.length; i++) expect(n.attempts[i].maxFeePerGas!).toBeGreaterThan(n.attempts[i - 1].maxFeePerGas!);
  });

  it("replaceOwn (tracked): a key drained below what a replacement needs sends nothing (no under-floor fee), and the wait ends at its bound", async () => {
    const n = node();
    const s = new SerialTxSender(n.inner, n.client, { minFeePerGas: FLOOR });
    const req: TxRequest = { to: to(1), data: "0x" };
    const a = await s.send(req);
    n.state.balance = GAS * 15n * GWEI; // drained after the send
    const err = await waitOrReplace(n.client, s, req, a, { timeoutMs: 5, pollMs: 2, maxReplacements: 2 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TxStuckError);
    expect(n.attempts).toHaveLength(1);
  });

  it("audit I-6: replaceOwn on a nonce nobody tracks no longer clamps under the floor -- it is refused, nothing sent", async () => {
    // floor-paths.mts: a key that can pay 15 gwei per gas, asked to replace nonce 7 at 32 / 6 gwei.
    const ask: TxRequest = { to: to(1), data: "0x", nonce: 7, gas: GAS, maxFeePerGas: 32n * GWEI, maxPriorityFeePerGas: 6n * GWEI };
    const before = node({ balance: GAS * 15n * GWEI, estimate: { maxFeePerGas: 29n * GWEI, maxPriorityFeePerGas: 5n * GWEI } });
    await new SerialTxSender(before.inner, before.client, { feeCeiling: NO_FEE_CEILING }).send(ask);
    expect(before.attempts[0].maxFeePerGas).toBe(15n * GWEI); // no floor: clamped to the balance, as before (Arc drops it)

    const n = node({ balance: GAS * 15n * GWEI, estimate: { maxFeePerGas: 29n * GWEI, maxPriorityFeePerGas: 5n * GWEI } });
    const s = new SerialTxSender(n.inner, n.client, { feeCeiling: NO_FEE_CEILING, minFeePerGas: FLOOR });
    await expect(s.send(ask)).rejects.toBeInstanceOf(TxInsufficientFundsError);
    expect(n.attempts).toHaveLength(0);
  });

  it("replaceOwn on a nonce nobody tracks: an under-floor ask is raised to the floor (EIP-1559 and legacy)", async () => {
    const n = node();
    const s = new SerialTxSender(n.inner, n.client, { minFeePerGas: FLOOR });
    await s.send({ to: to(1), data: "0x", nonce: 3, gas: GAS, maxFeePerGas: 10n * GWEI, maxPriorityFeePerGas: 10n * GWEI });
    expect(n.attempts[0]).toMatchObject({ nonce: 3, maxFeePerGas: FLOOR, maxPriorityFeePerGas: 10n * GWEI });
    await s.send({ to: to(1), data: "0x", nonce: 4, gas: GAS, gasPrice: 1n * GWEI });
    expect(n.attempts[1]).toMatchObject({ nonce: 4, gasPrice: FLOOR });
    expectFloored(n.attempts);
  });
});

describe("Plan 6: no minFeePerGas, no change", () => {
  /** The same script on a fresh node: fresh sends, a give-up and its replacement, a wait's own replacements, an
   *  adopted nonce, and the untracked replaceOwn clamp. Returns every attempt's nonce and fee fields. */
  async function script(opts: { minFeePerGas?: bigint } | undefined) {
    const n = node({ estimate: { maxFeePerGas: 1n * GWEI, maxPriorityFeePerGas: 1n * GWEI } });
    await new SerialTxSender(n.inner, n.client).send({ to: to(9), data: "0x99" }); // nonce 0, left by an earlier run
    const s = opts === undefined ? new SerialTxSender(n.inner, n.client) : new SerialTxSender(n.inner, n.client, opts);
    const req: TxRequest = { to: to(1), data: "0x01" };
    const a = await s.send(req); // adopts nonce 0
    await waitOrReplace(n.client, s, req, a, { timeoutMs: 5, pollMs: 2, maxReplacements: 2 }).catch(() => undefined);
    await s.send({ to: to(2), data: "0x02" }); // replaces the released nonce 0
    await s.send({ to: to(3), data: "0x03" }); // fresh at nonce 1
    n.state.balance = GAS * 15n * GWEI + 5n;
    await s.send({ to: to(4), data: "0x", nonce: 9, gas: GAS, maxFeePerGas: 32n * GWEI, maxPriorityFeePerGas: 6n * GWEI }).catch(() => undefined);
    return n.attempts.map(({ nonce, maxFeePerGas, maxPriorityFeePerGas, gasPrice, value, gas }) => ({ nonce, maxFeePerGas, maxPriorityFeePerGas, gasPrice, value, gas }));
  }

  it("a sender without the option, with minFeePerGas 0, and with a floor under every fee all emit exactly the same fees", async () => {
    const base = await script(undefined);
    expect(base.length).toBeGreaterThanOrEqual(6);
    expect(new SerialTxSender(node().inner, node().client).minFeePerGas).toBe(0n);
    expect(await script({ minFeePerGas: 0n })).toEqual(base);
    expect(await script({ minFeePerGas: 1n })).toEqual(base); // every fee is already over 1 wei
    expect(base[1]).toMatchObject({ nonce: 0, maxFeePerGas: 2n * GWEI }); // the adoption, priced 2 x the estimate as before
    expect(base.at(-1)).toMatchObject({ nonce: 9, maxFeePerGas: 15n * GWEI }); // the untracked clamp, as before
  });

  it("with the floor, the same script emits only floored fees (the cases above, together)", async () => {
    const floored = await script({ minFeePerGas: FLOOR });
    expectFloored(floored.slice(1) as Sent[]); // all but the earlier run's own send
  });
});

/**
 * Plan 6 hardening H1 (Task 2 review Minor-1): two floor call sites are defensively redundant today, so no
 * black-box test can tell them from a send without the floor -- an entry's `lastFees` is always floored already,
 * and the underpriced loop's input was floored one line up. These white-box tests pin them anyway, by raising the
 * sender's floor after a transaction was priced under it (as for an entry whose `lastFees` came from a pre-floor
 * send): with the `floored` call removed from either site, the emitted fee is under the new floor and the test fails.
 */
describe("H1: the two defensive floor sites are pinned (Task 2 review Minor-1)", () => {
  const raiseFloor = (s: SerialTxSender, floor: bigint) => {
    (s as unknown as { minFeePerGas: bigint }).minFeePerGas = floor;
  };

  it("replaceOwn (tracked): a replacement of an entry priced under the floor is floored (tx.ts replaceOwn, tracked branch)", async () => {
    const n = node({ estimate: { maxFeePerGas: 1n * GWEI, maxPriorityFeePerGas: 1n * GWEI } });
    const s = new SerialTxSender(n.inner, n.client); // no floor yet: the entry's lastFees is 1 gwei
    const req: TxRequest = { to: to(1), data: "0x" };
    const a = await s.send(req);
    expect(s.tracked()).toMatchObject([{ nonce: 0, state: "waiting", lastFees: { maxFeePerGas: 1n * GWEI } }]);
    raiseFloor(s, FLOOR);
    // waitOrReplace's own replacement goes through replaceOwn's tracked branch: bump(1 gwei) would be 1.125 gwei.
    await waitOrReplace(n.client, s, req, a, { timeoutMs: 5, pollMs: 2, maxReplacements: 1 }).catch(() => undefined);
    expect(n.attempts).toHaveLength(2);
    expect(n.attempts[1].nonce).toBe(0);
    expect(n.attempts[1].maxFeePerGas).toBe(FLOOR);
    expect(n.attempts[1].maxPriorityFeePerGas!).toBeLessThanOrEqual(FLOOR);
  });

  it("replaceReleased's underpriced raise loop floors each raise (tx.ts replaceReleased, raise loop)", async () => {
    const n = node();
    // A pending transaction at nonce 0, from an earlier run, priced above anything this sender knows.
    await new SerialTxSender(n.inner, n.client).send({ to: to(1), data: "0xaa", nonce: 0, gas: GAS, maxFeePerGas: 30n * GWEI, maxPriorityFeePerGas: 1n * GWEI });
    const s = new SerialTxSender(n.inner, n.client, { minFeePerGas: FLOOR });
    // The node refuses the first replacement as underpriced; meanwhile the floor rises to 100 gwei. The loop's
    // raise of the 20 gwei attempt is 1.5 x 20 = 30 gwei, under the new floor unless that site floors it.
    const HIGH = 100n * GWEI;
    const send = n.inner.send.bind(n.inner);
    let first = true;
    n.inner.send = async (tx) => {
      if (first && tx.nonce === 0) {
        first = false;
        raiseFloor(s, HIGH);
      }
      return send(tx);
    };
    const h = await s.send({ to: to(2), data: "0xbb" });
    const mine = n.attempts.slice(1);
    expect(mine.length).toBe(2); // 20 gwei refused as underpriced, then raised
    expect(mine[0].maxFeePerGas).toBe(FLOOR);
    expect(mine[1].maxFeePerGas).toBe(HIGH);
    expect(n.pool.get(0)!.hash).toBe(h);
  });
});
