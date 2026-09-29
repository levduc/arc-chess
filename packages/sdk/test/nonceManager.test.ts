/**
 * Plan 4.5 Task 10, fix round 4: the per-key nonce manager (a tracking `SerialTxSender`) and `waitOrReplace`.
 *
 * Invariants (task-10-round4-design.md):
 *   1. No pre-emption: a transaction whose wait is still active is never replaced by a different intent.
 *   2. At-most-once intent: our own resends never make one intent land twice.
 *   3. A stuck transaction is never abandoned: once its wait gives up, the next send replaces it.
 *   4. Bounded fees: no replacement exceeds the fee cap; at the cap nothing is sent.
 *   5. Every wait is bounded by its giveUpAt, its maxReplacements or its abort signal.
 *
 * Most tests run against `mempool()`: a stub node whose pool is keyed by nonce (one transaction per nonce, a
 * replacement must raise both fees by 10 %, a used nonce is refused, a send the balance cannot cover is refused),
 * so racing nonces can be expressed exactly. The rest run on the suite's Anvil with automine off.
 */
import { describe, expect, it } from "vitest";
import { TransactionNotFoundError, TransactionReceiptNotFoundError, keccak256, type Hex, type TransactionReceipt } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import * as sdk from "../src/index.js";
import {
  LocalKeyTxSender,
  SerialTxSender,
  TxDroppedError,
  TxFeeCapError,
  TxInsufficientFundsError,
  TxNonceUsedError,
  TxReceiptMissingError,
  TxStuckError,
  TxWaitAbortedError,
  waitOrReplace,
  type ReceiptClient,
  type TrackerClient,
  type TxRequest,
  type TxSender,
} from "../src/index.js";
import { CHAIN, RPC, publicClient, setEthBalance } from "./helpers/chain.js";

const ADDR = "0x00000000000000000000000000000000000000bb" as const;
const hx = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}`;
const to = (n: number): Hex => `0x${n.toString(16).padStart(40, "0")}`;
/** Lets other macrotasks (timers) run: a wait that loops on already-resolved reads must not starve the test's timers. */
const yieldTurn = () => new Promise<void>((r) => setImmediate(r));
const nap = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Resolves to `"timeout"` if `p` has not settled within `ms`. */
const within = <T>(p: Promise<T>, ms: number) =>
  Promise.race([p.then((v) => ({ v }), (e: unknown) => ({ e })), nap(ms).then(() => "timeout" as const)]);

type PoolTx = { hash: Hex; nonce: number; to: Hex; data: Hex; value: bigint; gas: bigint; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };

/** A stub node with a nonce-keyed pool. `mine()` mines every consecutive pending nonce whose fee meets `market`.
 *  `lostResponse` makes the next send be accepted by the node while its response is lost (a transport error). */
function mempool(opts: { balance?: bigint; gas?: bigint; signing?: boolean } = {}) {
  const state = { market: 0n, lostResponse: false, onEstimateGas: undefined as (() => void) | undefined };
  let latest = 0;
  let seq = 1;
  let balance = opts.balance ?? 10n ** 18n;
  const gasLimit = opts.gas ?? 21_000n;
  const pool = new Map<number, PoolTx>();
  const receipts = new Map<Hex, PoolTx>();
  const landed: PoolTx[] = [];
  /** Every transaction handed to the node, accepted or refused. */
  const attempts: PoolTx[] = [];
  const estimate = { maxFeePerGas: 1_000n, maxPriorityFeePerGas: 10n };
  const pendingCount = () => {
    let n = latest;
    while (pool.has(n)) n++;
    return n;
  };
  /** Signed-but-unsent transactions (the `signing` variant): raw -> request. */
  const signed = new Map<Hex, TxRequest>();
  const accept = (tx: TxRequest, hash: Hex) => {
      const nonce = tx.nonce ?? pendingCount();
      const t: PoolTx = {
        hash,
        nonce,
        to: tx.to,
        data: tx.data,
        value: tx.value ?? 0n,
        gas: tx.gas ?? gasLimit,
        maxFeePerGas: tx.maxFeePerGas ?? estimate.maxFeePerGas,
        maxPriorityFeePerGas: tx.maxPriorityFeePerGas ?? estimate.maxPriorityFeePerGas,
      };
      attempts.push(t);
      if (nonce < latest) throw new Error("nonce too low");
      if (t.maxFeePerGas * t.gas + t.value > balance) throw new Error("insufficient funds for gas * price + value");
      const old = pool.get(nonce);
      if (old && (t.maxFeePerGas * 10n < old.maxFeePerGas * 11n || t.maxPriorityFeePerGas * 10n < old.maxPriorityFeePerGas * 11n)) {
        throw new Error("replacement transaction underpriced");
      }
      pool.set(nonce, t);
      if (state.lostResponse) {
        state.lostResponse = false;
        throw new Error("fetch failed: socket hang up"); // the node has it; the response never arrived
      }
      return t.hash;
  };
  const inner: TxSender = {
    address: ADDR,
    async send(tx: TxRequest) {
      return accept(tx, hx(seq++));
    },
    ...(opts.signing
      ? {
          async signTransaction(tx: TxRequest) {
            const raw = hx(0xf000000 + seq++);
            signed.set(raw, tx);
            return raw;
          },
          async sendRawTransaction(raw: Hex) {
            return accept(signed.get(raw)!, keccak256(raw));
          },
        }
      : {}),
  };
  const receiptOf = (t: PoolTx) => ({ transactionHash: t.hash, status: "success", blockNumber: 1n }) as unknown as TransactionReceipt;
  const client = {
    async getTransactionReceipt({ hash }: { hash: Hex }) {
      await yieldTurn();
      const t = receipts.get(hash);
      if (!t) throw new TransactionReceiptNotFoundError({ hash });
      return receiptOf(t);
    },
    async getTransaction({ hash }: { hash: Hex }) {
      await yieldTurn();
      const t = receipts.get(hash);
      if (t) return { ...t, blockNumber: 1n };
      for (const p of pool.values()) if (p.hash === hash) return { ...p, blockNumber: null };
      throw new TransactionNotFoundError({ hash });
    },
    async getTransactionCount({ blockTag }: { blockTag?: string }) {
      return blockTag === "pending" ? pendingCount() : latest;
    },
    async estimateFeesPerGas() {
      return { ...estimate };
    },
    async estimateGas() {
      state.onEstimateGas?.();
      return gasLimit;
    },
    async getBalance() {
      return balance;
    },
  };
  const mine = () => {
    while (pool.has(latest) && pool.get(latest)!.maxFeePerGas >= state.market) {
      const t = pool.get(latest)!;
      pool.delete(latest);
      receipts.set(t.hash, t);
      landed.push(t);
      balance -= t.value;
      latest++;
    }
  };
  /** Mines a given pending transaction at its nonce, as if it had won against whatever the pool holds now. */
  const mineHash = (t: PoolTx) => {
    pool.delete(t.nonce);
    receipts.set(t.hash, t);
    landed.push(t);
    latest = t.nonce + 1;
  };
  return {
    state,
    inner,
    client: client as unknown as ReceiptClient & TrackerClient,
    rawClient: client,
    pool,
    landed,
    attempts,
    estimate,
    mine,
    mineHash,
    byHash: (h: Hex) => attempts.find((t) => t.hash === h)!,
  };
}

/** The same node, read through a lagging (load-balanced) RPC: no receipts, no transactions, a confirmed count of 0. */
function lagging(n: ReturnType<typeof mempool>): ReceiptClient & TrackerClient {
  return {
    ...n.rawClient,
    async getTransactionReceipt({ hash }: { hash: Hex }) {
      await yieldTurn();
      throw new TransactionReceiptNotFoundError({ hash });
    },
    async getTransaction({ hash }: { hash: Hex }) {
      await yieldTurn();
      throw new TransactionNotFoundError({ hash });
    },
    async getTransactionCount() {
      return 0;
    },
  } as unknown as ReceiptClient & TrackerClient;
}

describe("invariant 1: no pre-emption", () => {
  it("a send while another transaction's wait is active goes to the next nonce, and both land (demo 1)", async () => {
    const n = mempool();
    const wallet = new SerialTxSender(n.inner, n.client);
    const depositY: TxRequest = { to: to(0xd1), data: "0xdeadbeef" };
    const closeX: TxRequest = { to: to(0xc1), data: "0xc105e000" };
    const y = await wallet.send(depositY);
    const waitY = waitOrReplace(n.client, wallet, depositY, y, { timeoutMs: 300, pollMs: 20 }).then(
      (r) => r.transactionHash,
      (e: unknown) => e,
    );
    await nap(30); // Y's wait is polling; no block yet
    const x = await wallet.send(closeX);
    // Before the fix: X went out at Y's nonce 0 and knocked the healthy deposit Y out of the pool.
    expect(n.byHash(x).nonce).toBe(1);
    expect([...n.pool.keys()]).toEqual([0, 1]);
    n.mine();
    const waitX = await waitOrReplace(n.client, wallet, closeX, x, { timeoutMs: 300, pollMs: 20 });
    expect(waitX.transactionHash).toBe(x);
    expect(await waitY).toBe(y);
    expect(n.landed.map((t) => t.data)).toEqual(["0xdeadbeef", "0xc105e000"]);
  });

  it("a waiting entry is never replaced, however many sends follow it", async () => {
    const n = mempool();
    const wallet = new SerialTxSender(n.inner, n.client);
    const hashes: Hex[] = [];
    for (let i = 0; i < 4; i++) hashes.push(await wallet.send({ to: to(0x10 + i), data: "0x" }));
    expect(hashes.map((h) => n.byHash(h).nonce)).toEqual([0, 1, 2, 3]);
    expect(n.attempts).toHaveLength(4);
  });
});

describe("invariant 2: at-most-once intent", () => {
  it("demo 2: a top-up that landed but was reported dropped by a lagging node is paid once; the replacement's nonce-used error is TxNonceUsedError, with no second send", async () => {
    const n = mempool();
    const lag = lagging(n);
    const wallet = new SerialTxSender(n.inner, lag);
    const topUp: TxRequest = { to: to(0xe5), data: "0x", value: 5n };
    const a = await wallet.send(topUp);
    n.mine(); // it lands on the real chain
    const err = await waitOrReplace(lag, wallet, topUp, a, { timeoutMs: 50, pollMs: 10 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TxDroppedError);
    // The next pass re-reads the (lagging) balance: still short, so it re-sends the same top-up.
    const b = await wallet.send(topUp).catch((e: unknown) => e);
    n.mine();
    // Before the fix: the nonce-used retry went out at a fresh nonce 1, and the top-up landed twice.
    expect(n.landed.filter((t) => t.value === 5n)).toHaveLength(1);
    expect(n.attempts).toHaveLength(2); // the first send and the refused replacement at nonce 0; nothing more
    expect(n.attempts[1].nonce).toBe(0);
    expect(b).toBeInstanceOf(TxNonceUsedError);
    expect((b as TxNonceUsedError).nonce).toBe(0);
    expect(wallet.tracked()).toEqual([]); // the entry is gone: the next send starts afresh
  });

  it("a wait whose nonce was taken by an earlier intent that landed after all reports TxNonceUsedError, not that intent's receipt", async () => {
    const n = mempool();
    const wallet = new SerialTxSender(n.inner, n.client);
    const respond: TxRequest = { to: to(0xa1), data: "0xaaaa" };
    const timeout: TxRequest = { to: to(0xa2), data: "0xbbbb" };
    const r = await wallet.send(respond);
    const stuck = await waitOrReplace(n.client, wallet, respond, r, { timeoutMs: 20, pollMs: 5, maxReplacements: 0 }).catch((e: unknown) => e);
    expect(stuck).toBeInstanceOf(TxStuckError);
    const t = await wallet.send(timeout); // replaces the released respond at nonce 0
    expect(n.byHash(t).nonce).toBe(0);
    n.mineHash(n.byHash(r)); // ...but the respond wins the race after all
    const err = await waitOrReplace(n.client, wallet, timeout, t, { timeoutMs: 50, pollMs: 5 }).catch((e: unknown) => e);
    // A caller told "success" here would act on a timeout that never happened (the daemon marks the channel final).
    expect(err).toBeInstanceOf(TxNonceUsedError);
    expect((err as TxNonceUsedError).nonce).toBe(0);
    expect(wallet.tracked()).toEqual([]);
  });
});

describe("invariant 3: a stuck transaction is never abandoned", () => {
  it("after a wait gives up on a dropped transaction, the next send goes out at its nonce", async () => {
    const n = mempool();
    const lag = lagging(n); // the node the wait asks says "unknown"; the real pool still holds it
    const wallet = new SerialTxSender(n.inner, lag);
    const a = await wallet.send({ to: to(0x01), data: "0x01" });
    await waitOrReplace(lag, wallet, { to: to(0x01), data: "0x01" }, a, { timeoutMs: 20, pollMs: 5 }).catch(() => undefined);
    const b = await wallet.send({ to: to(0x02), data: "0x02" });
    expect(n.byHash(b).nonce).toBe(0);
    expect(n.byHash(b).maxFeePerGas * 1000n).toBeGreaterThanOrEqual(n.byHash(a).maxFeePerGas * 1125n);
    expect([...n.pool.keys()]).toEqual([0]);
  });

  it("the lowest released nonce is replaced first, and waiting ones above it are left alone", async () => {
    const n = mempool();
    const wallet = new SerialTxSender(n.inner, n.client);
    const a = await wallet.send({ to: to(0x01), data: "0x01" }); // nonce 0: will be given up on
    const b = await wallet.send({ to: to(0x02), data: "0x02" }); // nonce 1: its wait stays active
    const waitB = waitOrReplace(n.client, wallet, { to: to(0x02), data: "0x02" }, b, { timeoutMs: 2_000, pollMs: 5 }).catch((e: unknown) => e);
    await waitOrReplace(n.client, wallet, { to: to(0x01), data: "0x01" }, a, { timeoutMs: 20, pollMs: 5, maxReplacements: 0 }).catch(() => undefined);
    const c = await wallet.send({ to: to(0x03), data: "0x03" });
    expect(n.byHash(c).nonce).toBe(0);
    expect(n.pool.get(1)?.hash).toBe(b);
    n.mine();
    expect(await waitB).toMatchObject({ transactionHash: b });
  });

  it("a send whose fresh nonce turns out used (a pure count race) is retried once at the next nonce", async () => {
    const n = mempool();
    await n.inner.send({ to: to(0x01), data: "0x" }); // nonce 0, sent by someone else on this key
    n.mine();
    const blind = { ...n.rawClient, getTransactionCount: async () => 0 } as unknown as TrackerClient;
    const wallet = new SerialTxSender(n.inner, blind);
    const h = await wallet.send({ to: to(0x02), data: "0x" });
    expect(n.byHash(h).nonce).toBe(1);
    expect(n.attempts.map((t) => t.nonce)).toEqual([0, 0, 1]);
  });
});

describe("invariant 4: bounded fees", () => {
  it("repeated give-ups stop at the cap: TxFeeCapError, and nothing is sent", async () => {
    const n = mempool();
    // cap = max(4 x the estimate (1000), the ceiling) = 4000
    const wallet = new SerialTxSender(n.inner, n.client, { feeCeiling: 0n });
    const req: TxRequest = { to: to(0x01), data: "0x" };
    let last: unknown;
    for (let i = 0; i < 30 && !(last instanceof TxFeeCapError); i++) {
      const before = n.attempts.length;
      last = await wallet.send(req).catch((e: unknown) => e);
      if (last instanceof TxFeeCapError) {
        expect(n.attempts.length).toBe(before); // nothing sent
        break;
      }
      await waitOrReplace(n.client, wallet, req, last as Hex, { timeoutMs: 5, pollMs: 5, maxReplacements: 0 }).catch(() => undefined);
    }
    expect(n.attempts.every((t) => t.maxFeePerGas <= 4_000n && t.maxPriorityFeePerGas <= 4_000n)).toBe(true);
    expect(last).toBeInstanceOf(TxFeeCapError);
    expect(wallet.tracked()).toMatchObject([{ nonce: 0, state: "released" }]); // left as it was
  });

  it("a wait at the cap sends no replacement and ends TxStuckError after its rounds", async () => {
    const n = mempool();
    const wallet = new SerialTxSender(n.inner, n.client, { feeCeiling: 0n });
    const req: TxRequest = { to: to(0x01), data: "0x" };
    const h = await wallet.send(req);
    const err = await waitOrReplace(n.client, wallet, req, h, { timeoutMs: 5, pollMs: 5, maxReplacements: 20 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TxStuckError);
    expect(n.attempts.length).toBeLessThan(21); // stopped replacing at the cap
    expect(n.attempts.every((t) => t.maxFeePerGas <= 4_000n)).toBe(true);
  });

  it("a sender without enough balance never sends a transaction it cannot pay for", async () => {
    // Gas 21000 at 1500 wei is all it has: the balance bounds the fee under the cap (4000).
    const n = mempool({ balance: 21_000n * 1_500n });
    const session = new SerialTxSender(n.inner, n.client, { feeCeiling: 0n });
    const req: TxRequest = { to: to(0x01), data: "0x" };
    const h = await session.send(req);
    await waitOrReplace(n.client, session, req, h, { timeoutMs: 5, pollMs: 5, maxReplacements: 6 }).catch(() => undefined);
    await session.send(req).catch(() => undefined);
    expect(n.attempts.every((t) => t.maxFeePerGas * t.gas + t.value <= 21_000n * 1_500n)).toBe(true);
  });

  it("a send the node refuses for insufficient funds is TxInsufficientFundsError, and the entries are left as they were", async () => {
    const n = mempool();
    const wallet = new SerialTxSender(n.inner, n.client);
    const a = await wallet.send({ to: to(0x01), data: "0x" });
    await waitOrReplace(n.client, wallet, { to: to(0x01), data: "0x" }, a, { timeoutMs: 5, pollMs: 5, maxReplacements: 0 }).catch(() => undefined);
    const err = await wallet.send({ to: to(0x02), data: "0x", value: 10n ** 30n }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TxInsufficientFundsError);
    expect(wallet.tracked()).toMatchObject([{ nonce: 0, state: "released" }]);
  });
});

describe("invariant 5: every wait is bounded", () => {
  /** A node that shows the transaction mined (blockNumber set) but never serves its receipt. */
  function lagIndex() {
    const n = mempool();
    const client = {
      ...n.rawClient,
      async getTransaction({ hash }: { hash: Hex }) {
        await yieldTurn();
        return { hash, nonce: 0, blockNumber: 5n, maxFeePerGas: 1_000n, maxPriorityFeePerGas: 10n, gas: 21_000n };
      },
    } as unknown as ReceiptClient & TrackerClient;
    return { n, client };
  }

  it("a receipt index that lags forever ends the wait after 3 rounds: TxReceiptMissingError, entry cleared", async () => {
    const { n, client } = lagIndex();
    const wallet = new SerialTxSender(n.inner, client);
    const h = await wallet.send({ to: to(0x01), data: "0x" });
    const r = await within(waitOrReplace(client, wallet, { to: to(0x01), data: "0x" }, h, { timeoutMs: 30, pollMs: 5 }), 2_000);
    expect(r).not.toBe("timeout"); // before the fix: an endless loop
    expect((r as { e: unknown }).e).toBeInstanceOf(TxReceiptMissingError);
    expect(wallet.tracked()).toEqual([]);
  });

  it("a lagging receipt index respects giveUpAt", async () => {
    const { n, client } = lagIndex();
    const wallet = new SerialTxSender(n.inner, client);
    const h = await wallet.send({ to: to(0x01), data: "0x" });
    const t0 = Date.now();
    const r = await within(
      waitOrReplace(client, wallet, { to: to(0x01), data: "0x" }, h, { timeoutMs: 60_000, pollMs: 5, giveUpAt: t0 + 100 }),
      2_000,
    );
    expect(r).not.toBe("timeout"); // before the fix: a tight loop past giveUpAt
    expect(Date.now() - t0).toBeLessThan(1_000);
    // Round 5 (m1): the node says it was mined -- reported as such, not as stuck.
    expect((r as { e: unknown }).e).toBeInstanceOf(TxReceiptMissingError);
    expect(wallet.tracked()).toEqual([]);
  });

  it("a lagging receipt index respects the abort signal", async () => {
    const { n, client } = lagIndex();
    const wallet = new SerialTxSender(n.inner, client);
    const h = await wallet.send({ to: to(0x01), data: "0x" });
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 100);
    const r = await within(waitOrReplace(client, wallet, { to: to(0x01), data: "0x" }, h, { timeoutMs: 20, pollMs: 5, maxReplacements: 1_000, signal: ctl.signal }), 2_000);
    expect(r).not.toBe("timeout");
    expect((r as { e: unknown }).e).toBeInstanceOf(Error);
  });

  it("an aborted wait releases its entry: the next send replaces it", async () => {
    const n = mempool();
    const wallet = new SerialTxSender(n.inner, n.client);
    const a = await wallet.send({ to: to(0x01), data: "0x" });
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 30);
    const err = await waitOrReplace(n.client, wallet, { to: to(0x01), data: "0x" }, a, { timeoutMs: 5_000, pollMs: 5, signal: ctl.signal }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TxWaitAbortedError);
    const b = await wallet.send({ to: to(0x02), data: "0x" });
    expect(n.byHash(b).nonce).toBe(0);
  });
});

describe("the fees a wait observes are recorded (M3)", () => {
  it("a replacement is priced over the fees the node reports for the pending transaction", async () => {
    const n = mempool();
    const wallet = new SerialTxSender(n.inner, n.client);
    const req: TxRequest = { to: to(0x01), data: "0x" };
    const h = await wallet.send(req);
    n.pool.get(0)!.maxFeePerGas = 3_000n; // what the node reports differs from what we recorded
    n.pool.get(0)!.maxPriorityFeePerGas = 300n;
    await waitOrReplace(n.client, wallet, req, h, { timeoutMs: 5, pollMs: 5, maxReplacements: 0 }).catch(() => undefined);
    expect(wallet.tracked()[0].lastFees).toEqual({ maxFeePerGas: 3_000n, maxPriorityFeePerGas: 300n });
    const again = await wallet.send(req);
    expect(n.byHash(again).maxFeePerGas * 1000n).toBeGreaterThanOrEqual(3_000n * 1125n);
  });
});

describe("restart adoption (Anvil, automine off)", () => {
  async function anvil<T = unknown>(method: string, params: unknown[]): Promise<T> {
    const res = await fetch(RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    return ((await res.json()) as { result: T }).result;
  }
  async function pooled(address: Hex): Promise<Record<string, { hash: Hex }>> {
    const c = await anvil<{ pending: Record<string, Record<string, { hash: Hex }>> }>("txpool_content", []);
    return Object.entries(c.pending).find(([a]) => a.toLowerCase() === address.toLowerCase())?.[1] ?? {};
  }
  const recipient = () => privateKeyToAccount(generatePrivateKey()).address;

  it("a new sender for a key with a pending transaction left from before the restart replaces it at its nonce", async () => {
    const key = generatePrivateKey();
    const address = privateKeyToAccount(key).address;
    await setEthBalance(address, 10n ** 18n);
    const pub = publicClient();
    const [x, y] = [recipient(), recipient()];
    await anvil("evm_setAutomine", [false]);
    try {
      const before = new SerialTxSender(new LocalKeyTxSender(key, RPC, CHAIN));
      const h1 = await before.send({ to: x, data: "0x", value: 1n }); // stuck, then the daemon restarts
      const t1 = await pub.getTransaction({ hash: h1 });
      const after = new SerialTxSender(new LocalKeyTxSender(key, RPC, CHAIN));
      const h2 = await after.send({ to: y, data: "0x", value: 2n });
      const t2 = await pub.getTransaction({ hash: h2 });
      expect(t2.nonce).toBe(0); // before the fix: 1, queued behind the stuck nonce 0 forever
      expect(Object.keys(await pooled(address))).toEqual(["0"]);
      expect(t2.maxFeePerGas! * 1000n).toBeGreaterThanOrEqual(t1.maxFeePerGas! * 1125n);
      await anvil("evm_mine", []);
      expect(await pub.getBalance({ address: x })).toBe(0n);
      expect(await pub.getBalance({ address: y })).toBe(2n);
    } finally {
      await anvil("evm_setAutomine", [true]);
    }
  });

  it("an adopted transaction priced above the cap is not replaced: TxFeeCapError, nothing sent", async () => {
    const n = mempool();
    // Left from before the restart, at a fee far over any cap this sender will pay.
    await n.inner.send({ to: to(0x01), data: "0x", maxFeePerGas: 1_000_000n, maxPriorityFeePerGas: 1_000_000n });
    const wallet = new SerialTxSender(n.inner, n.client, { feeCeiling: 0n });
    const err = await wallet.send({ to: to(0x02), data: "0x" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TxFeeCapError);
    expect(n.attempts.slice(1).every((t) => t.maxFeePerGas <= 4_000n)).toBe(true);
    expect(n.pool.get(0)?.to).toBe(to(0x01));
  });
});

describe("round 5, C1: every untracked pending nonce is adopted, not only while nothing is tracked", () => {
  it("E1': after a restart with nonces 0 and 1 pending below a risen market, two new intents replace both; the key never stalls", async () => {
    const n = mempool();
    const old = new SerialTxSender(n.inner, n.client);
    await old.send({ to: to(1), data: "0xaa00" });
    await old.send({ to: to(1), data: "0xaa01" });
    n.state.market = 2_500n; // both are now stuck
    n.estimate.maxFeePerGas = 2_500n;
    const w = new SerialTxSender(n.inner, n.client, { feeCeiling: 0n }); // the daemon restarts
    const x = await w.send({ to: to(2), data: "0xb0" }); // adopts nonce 0
    const y = await w.send({ to: to(2), data: "0xb1" }); // x is waiting: y adopts nonce 1 (before: fresh at 2, behind it)
    expect([n.byHash(x).nonce, n.byHash(y).nonce]).toEqual([0, 1]);
    n.mine();
    expect(n.landed.map((t) => t.data)).toEqual(["0xb0", "0xb1"]);
    expect(n.pool.size).toBe(0);
    const z = await w.send({ to: to(3), data: "0xc0" }); // and the key goes on
    expect(n.byHash(z).nonce).toBe(2);
  });

  it("E2: an old top-up left pending next to a stuck nonce, then re-sent after the restart, lands once", async () => {
    const n = mempool();
    const old = new SerialTxSender(n.inner, n.client);
    await old.send({ to: to(1), data: "0xaa01" }); // nonce 0: will be stuck
    await old.send({ to: to(9), data: "0x", value: 7n }); // nonce 1: an old top-up at a fine price
    n.pool.get(0)!.maxFeePerGas = 500n;
    n.state.market = 900n; // nonce 0 cannot be mined, so neither can nonce 1
    const w = new SerialTxSender(n.inner, n.client);
    await w.send({ to: to(9), data: "0x", value: 7n }); // the re-read balance is short: the top-up again
    await w.send({ to: to(2), data: "0xcc" });
    n.mine();
    // Before: the re-sent top-up adopted nonce 0 and the next intent went fresh to 2, so both top-ups landed.
    expect(n.landed.filter((t) => t.value === 7n)).toHaveLength(1);
    expect(n.pool.size).toBe(0);
  });
});

describe("round 5, I1: a dropped transaction's old fees never block the key; session keys are capped by their balance only", () => {
  it("E3: after an outage pushed the fees to the cap and the node dropped the pool, the next send goes out and lands", async () => {
    const n = mempool();
    const w = new SerialTxSender(n.inner, n.client, { feeCeiling: 0n }); // cap = 4 x 1000
    n.state.market = 10n ** 9n; // nothing is included for a while
    let last: unknown;
    for (let i = 0; i < 20 && !(last instanceof TxFeeCapError); i++) {
      last = await w.send({ to: to(3), data: "0xdd" }).catch((e: unknown) => e);
      if (typeof last === "string") {
        await waitOrReplace(n.client, w, { to: to(3), data: "0xdd" }, last as Hex, { timeoutMs: 5, pollMs: 2, maxReplacements: 1 }).catch(() => undefined);
      }
    }
    expect(last).toBeInstanceOf(TxFeeCapError); // the outage reached the cap
    n.pool.clear(); // the node restarts with an empty pool: nothing is pending at nonce 0 any more
    n.state.market = 0n;
    const h = await w.send({ to: to(4), data: "0xee" }).catch((e: unknown) => e);
    // Before: TxFeeCapError on every send, forever -- the dropped transaction's last fees still had to be bumped.
    expect(typeof h).toBe("string");
    n.mine();
    expect(n.landed.map((t) => t.data)).toEqual(["0xee"]);
  });

  it("a session-key sender (no fee ceiling) replaces above the wallet's cap, bounded only by its balance", async () => {
    const n = mempool({ balance: 21_000n * 10_000n }); // it can pay at most 10000 per gas
    const session = new SerialTxSender(n.inner, n.client, { feeCeiling: sdk.NO_FEE_CEILING });
    const req: TxRequest = { to: to(1), data: "0x" };
    let last: unknown;
    for (let i = 0; i < 40 && !(last instanceof Error); i++) {
      last = await session.send(req).catch((e: unknown) => e);
      if (typeof last === "string") {
        await waitOrReplace(n.client, session, req, last as Hex, { timeoutMs: 2, pollMs: 2, maxReplacements: 0 }).catch(() => undefined);
      }
    }
    expect(n.attempts.some((t) => t.maxFeePerGas > 4_000n)).toBe(true); // above what a wallet (4 x estimate) may pay
    expect(n.attempts.every((t) => t.maxFeePerGas * t.gas + t.value <= 21_000n * 10_000n)).toBe(true);
    expect(last).toBeInstanceOf(TxInsufficientFundsError); // stopped by the balance, never by a fee cap
  });
});

describe("round 5, I2: a send whose response is lost is still tracked", () => {
  it("E4a: the node took it but the response was lost: the entry is recorded (released), and the resend replaces it at its nonce -- one lands", async () => {
    const n = mempool();
    const w = new SerialTxSender(n.inner, n.client);
    await w.send({ to: to(5), data: "0x01" }); // nonce 0, waiting
    n.state.lostResponse = true;
    const lost = await w.send({ to: to(5), data: "0x02" }).catch((e: unknown) => e);
    expect(lost).toBeInstanceOf(Error);
    // Before: nothing was recorded for nonce 1, although the node holds a transaction there.
    expect(w.tracked().find((t) => t.nonce === 1)).toMatchObject({ state: "released", lastFees: { maxFeePerGas: 1_000n } });
    const again = await w.send({ to: to(5), data: "0x02" }); // the caller's next pass sends it again
    expect(n.byHash(again).nonce).toBe(1);
    n.mine();
    expect(n.landed.filter((t) => t.data === "0x02")).toHaveLength(1);
  });

  it("a definitive refusal of a fresh send leaves no entry behind", async () => {
    const n = mempool();
    const w = new SerialTxSender(n.inner, n.client);
    await expect(w.send({ to: to(5), data: "0x", value: 10n ** 30n })).rejects.toBeInstanceOf(TxInsufficientFundsError);
    const realSend = n.inner.send.bind(n.inner);
    n.inner.send = async (tx) => {
      await realSend(tx).catch(() => undefined);
      throw new Error("nonce too low"); // refused (after the one count-race retry too)
    };
    await expect(w.send({ to: to(5), data: "0x" })).rejects.toThrow(/nonce too low/);
    expect(w.tracked()).toEqual([]);
  });

  it("a signing sender: a lost response is recovered by the precomputed hash; if the node cannot be asked, the entry keeps that hash", async () => {
    const n = mempool({ signing: true });
    const w = new SerialTxSender(n.inner, n.client);
    n.state.lostResponse = true;
    const h = await w.send({ to: to(5), data: "0x02" }); // the node holds it: the send succeeds after all
    expect(h).toBe(n.pool.get(0)!.hash);
    expect(w.tracked()).toMatchObject([{ nonce: 0, state: "waiting", hashes: [h] }]);
    n.mine();
    // Now the node cannot even be asked right after the lost response.
    const realGet = n.rawClient.getTransaction;
    n.rawClient.getTransaction = async () => {
      throw new Error("fetch failed");
    };
    n.state.lostResponse = true;
    await expect(w.send({ to: to(5), data: "0x03" })).rejects.toThrow(/fetch failed/);
    n.rawClient.getTransaction = realGet;
    const lostHash = n.pool.get(1)!.hash;
    expect(w.tracked().find((t) => t.nonce === 1)).toMatchObject({ state: "released", hashes: [lostHash] });
    n.mine(); // it lands
    const next = await w.send({ to: to(5), data: "0x04" }); // prune finds its receipt: fresh at nonce 2
    expect(n.byHash(next).nonce).toBe(2);
    expect(n.landed.map((t) => t.data)).toEqual(["0x02", "0x03"]);
  });

  it("a signing sender: a transport retry that reads 'nonce too low' for our own landed transaction is success, not a count race", async () => {
    const n = mempool({ signing: true });
    const w = new SerialTxSender(n.inner, n.client);
    const realRaw = n.inner.sendRawTransaction!.bind(n.inner);
    let first = true;
    n.inner.sendRawTransaction = async (raw: Hex) => {
      if (!first) return realRaw(raw);
      first = false;
      await realRaw(raw); // the first try went through and was mined...
      n.mine();
      throw new Error("nonce too low"); // ...and the transport's retry of it is refused
    };
    const h = await w.send({ to: to(5), data: "0x02", value: 3n });
    n.mine();
    // Before: the "count race" retry re-sent it at nonce 1, and it landed twice.
    expect(n.landed.filter((t) => t.value === 3n)).toHaveLength(1);
    expect(n.byHash(h).nonce).toBe(0);
  });
});

describe("final review m1: an own replacement whose send response is lost is still ours", () => {
  it("it lands: the wait returns its receipt, not TxNonceUsedError ('an earlier intent landed')", async () => {
    const n = mempool({ signing: true });
    const w = new SerialTxSender(n.inner, n.client);
    n.state.market = 10n ** 12n; // nothing is mined on its own
    const req: TxRequest = { to: to(7), data: "0x07" };
    const a = await w.send(req);
    const realRaw = n.inner.sendRawTransaction!.bind(n.inner);
    const realGet = n.rawClient.getTransaction;
    let failNextGet = false;
    n.rawClient.getTransaction = async (args: { hash: Hex }) => {
      if (failNextGet) {
        failNextGet = false;
        throw new Error("fetch failed"); // the node cannot even be asked whether it took the replacement
      }
      return realGet(args);
    };
    n.inner.sendRawTransaction = async (raw: Hex) => {
      const h = await realRaw(raw); // the node takes the wait's own replacement...
      n.inner.sendRawTransaction = realRaw;
      n.mineHash(n.byHash(h)); // ...and mines it
      failNextGet = true;
      throw new Error("fetch failed: socket hang up"); // ...but the response is lost
    };
    const r = await waitOrReplace(n.client, w, req, a, { timeoutMs: 20, pollMs: 5 });
    const replacement = n.landed[0];
    expect(replacement.hash).not.toBe(a);
    expect(replacement.data).toBe("0x07");
    expect(r.transactionHash).toBe(replacement.hash); // before: TxNonceUsedError for our own transaction
    expect(w.tracked()).toEqual([]);
  });
});

describe("round 5, minor fixes", () => {
  it("m2: an entry released while a fresh send is being prepared is replaced by that send, not queued behind", async () => {
    const n = mempool();
    const w = new SerialTxSender(n.inner, n.client);
    const a = await w.send({ to: to(1), data: "0x01" }); // nonce 0, its wait active
    n.state.onEstimateGas = () => {
      n.state.onEstimateGas = undefined;
      w.release(a); // a's wait gives up while b is being prepared (after b's released-entry check)
    };
    const b = await w.send({ to: to(2), data: "0x02" });
    expect(n.byHash(b).nonce).toBe(0); // before: 1, behind the stuck nonce 0
  });

  it("m4: a send at an explicit nonce nobody tracks is capped too", async () => {
    const n = mempool();
    const w = new SerialTxSender(n.inner, n.client, { feeCeiling: 0n }); // cap 4000
    await w.send({ to: to(1), data: "0x", nonce: 0, gas: 21_000n, maxFeePerGas: 1_000_000n, maxPriorityFeePerGas: 1_000_000n });
    expect(n.attempts[0].maxFeePerGas).toBeLessThanOrEqual(4_000n); // before: 1000000
    expect(n.attempts[0].maxPriorityFeePerGas).toBeLessThanOrEqual(4_000n);
  });

  it("m5: the wait's replacement is raised to at least bump(lastFees) before the cap, whatever fees it asked for", async () => {
    const n = mempool();
    const w = new SerialTxSender(n.inner, n.client);
    const a = await w.send({ to: to(1), data: "0x" });
    w.observed(a, { maxFeePerGas: 3_000n, maxPriorityFeePerGas: 300n }); // the node reports it higher
    n.pool.get(0)!.maxFeePerGas = 3_000n;
    n.pool.get(0)!.maxPriorityFeePerGas = 300n;
    await w.send({ to: to(1), data: "0x", nonce: 0, maxFeePerGas: 1_000n, maxPriorityFeePerGas: 10n }); // asks too little
    const t = n.attempts.at(-1)!;
    expect(t.maxFeePerGas).toBeGreaterThanOrEqual(3_375n); // before: 1000, refused as underpriced
    expect(t.maxPriorityFeePerGas).toBeGreaterThanOrEqual(338n);
    expect(n.pool.get(0)!.hash).toBe(t.hash);
  });

  it("m7: a failed fee estimate keeps the last known market for the cap instead of collapsing it to 0", async () => {
    const n = mempool();
    const w = new SerialTxSender(n.inner, n.client, { feeCeiling: 0n });
    const a = await w.send({ to: to(1), data: "0x" }); // the estimate (1000) is known from here
    await waitOrReplace(n.client, w, { to: to(1), data: "0x" }, a, { timeoutMs: 5, pollMs: 5, maxReplacements: 0 }).catch(() => undefined);
    n.rawClient.estimateFeesPerGas = async () => {
      throw new Error("fetch failed");
    };
    const b = await w.send({ to: to(2), data: "0x" }).catch((e: unknown) => e); // before: TxFeeCapError (cap 0)
    expect(typeof b).toBe("string");
    expect(n.byHash(b as Hex).maxFeePerGas).toBeGreaterThanOrEqual(1_125n);
    expect(n.byHash(b as Hex).maxFeePerGas).toBeLessThanOrEqual(4_000n);
  });
});
