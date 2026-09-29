/**
 * Plan 4.5 Task 10 review: bounded receipt waits (`waitOrReplace`) -- a timeout, a dropped transaction, and a stuck
 * one replaced at the same nonce with higher fees. Stubbed client/sender tests pin the decision logic; two tests
 * against the suite's Anvil (automine switched off for their duration) pin what a real node and viem do with the
 * nonce/fee overrides and with `anvil_dropTransaction`.
 */
import { describe, expect, it } from "vitest";
import {
  BaseError,
  ExecutionRevertedError,
  HttpRequestError,
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
  WaitForTransactionReceiptTimeoutError,
  encodeFunctionData,
  erc20Abi,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  HubClient,
  HubRevertError,
  LocalKeyTxSender,
  MAX_REPLACEMENTS,
  SerialTxSender,
  TxDroppedError,
  TxStuckError,
  TxWaitAbortedError,
  isNonceUsedError,
  waitOrReplace,
  type ReceiptClient,
  type TrackerClient,
  type TxRequest,
  type TxSender,
} from "../src/index.js";
import { CHAIN, RPC, deployArena, mintUsdc, publicClient, setEthBalance } from "./helpers/chain.js";

const h = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}`;
const TO = "0x00000000000000000000000000000000000000aa" as const;
/** Hashes whose (stub) receipt says the transaction reverted. */
const revertedHashes = new Set<Hex>();
const receiptOf = (hash: Hex) =>
  ({ transactionHash: hash, status: revertedHashes.has(hash) ? "reverted" : "success" }) as unknown as TransactionReceipt;

const nap = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A stub node. `mined` holds the hashes that have a receipt, `pool` the pending ones (hash -> nonce/fees); a hash in
 * neither is unknown (dropped). `waitForTransactionReceipt` behaves like viem's: it watches one hash until its
 * timeout. `legacy` makes the sender's transactions pre-EIP-1559 (gasPrice only).
 */
function stubNode(opts: { legacy?: boolean; supportsReplacement?: boolean } = {}) {
  const mined = new Set<Hex>();
  type PoolTx = { nonce: number; maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint; gasPrice?: bigint };
  const pool = new Map<Hex, PoolTx>();
  const sent: TxRequest[] = [];
  const estimates: string[] = [];
  let next = 100;
  // `waitForTransactionReceipt` is kept (viem-like) so a regression can be run against the previous implementation.
  const client = {
    waitForTransactionReceipt: (async ({ hash, timeout }: { hash: Hex; timeout?: number }) => {
      const end = Date.now() + (timeout ?? 180_000);
      for (;;) {
        if (mined.has(hash)) return receiptOf(hash);
        if (Date.now() >= end) throw new WaitForTransactionReceiptTimeoutError({ hash });
        await nap(2);
      }
    }),
    getTransactionReceipt: (async ({ hash }: { hash: Hex }) => {
      if (mined.has(hash)) return receiptOf(hash);
      throw new TransactionReceiptNotFoundError({ hash });
    }) as ReceiptClient["getTransactionReceipt"],
    getTransaction: (async ({ hash }: { hash: Hex }) => {
      if (mined.has(hash)) return { hash, blockNumber: 1n, nonce: 7 };
      const p = pool.get(hash);
      if (!p) throw new TransactionNotFoundError({ hash });
      return { hash, blockNumber: null, ...p };
    }) as unknown as ReceiptClient["getTransaction"],
    estimateFeesPerGas: (async (args?: { type?: string }) => {
      estimates.push(args?.type ?? "eip1559");
      return args?.type === "legacy" ? { gasPrice: 3_000n } : { maxFeePerGas: 1_000n, maxPriorityFeePerGas: 10n };
    }) as unknown as ReceiptClient["estimateFeesPerGas"],
  } as unknown as ReceiptClient;
  const sender: TxSender = {
    address: "0x00000000000000000000000000000000000000bb",
    ...(opts.supportsReplacement === false ? { supportsReplacement: false } : {}),
    async send(tx: TxRequest) {
      sent.push(tx);
      const hash = h(next++);
      pool.set(
        hash,
        opts.legacy
          ? { nonce: tx.nonce ?? 7, gasPrice: tx.gasPrice ?? 2_000n }
          : { nonce: tx.nonce ?? 7, maxFeePerGas: tx.maxFeePerGas ?? 2_000n, maxPriorityFeePerGas: tx.maxPriorityFeePerGas ?? 100n },
      );
      return hash;
    },
  };
  return { client, sender, mined, pool, sent, estimates };
}

describe("waitOrReplace (stubbed node)", () => {
  it("returns the receipt when the transaction is mined within the timeout, without replacing it", async () => {
    const n = stubNode();
    const hash = await n.sender.send({ to: TO, data: "0x" });
    n.mined.add(hash);
    expect((await waitOrReplace(n.client, n.sender, { to: TO, data: "0x" }, hash, { timeoutMs: 10 })).transactionHash).toBe(hash);
    expect(n.sent).toHaveLength(1);
  });

  it("throws TxDroppedError when the node no longer knows a transaction that was never mined", async () => {
    const n = stubNode();
    const hash = await n.sender.send({ to: TO, data: "0x" });
    n.pool.delete(hash); // dropped from the mempool (or reorged out and discarded)
    const err = await waitOrReplace(n.client, n.sender, { to: TO, data: "0x" }, hash, { timeoutMs: 10 }).catch((e) => e);
    expect(err).toBeInstanceOf(TxDroppedError);
    expect((err as TxDroppedError).hash).toBe(hash);
    expect(n.sent).toHaveLength(1); // never resent blindly: the caller re-evaluates first
  });

  it("replaces a still-pending transaction at the same nonce with fees raised by at least 12.5 %, and returns its receipt", async () => {
    const n = stubNode();
    const req = { to: TO, data: "0x1234" as Hex, value: 5n };
    const hash = await n.sender.send(req);
    const realSend = n.sender.send.bind(n.sender);
    n.sender.send = async (tx) => {
      const r = await realSend(tx);
      n.mined.add(r); // the replacement gets mined
      return r;
    };
    const receipt = await waitOrReplace(n.client, n.sender, req, hash, { timeoutMs: 10 });
    expect(n.sent).toHaveLength(2);
    const replacement = n.sent[1];
    expect(receipt.transactionHash).not.toBe(hash);
    expect(replacement).toMatchObject({ to: TO, data: "0x1234", value: 5n, nonce: 7 });
    expect(replacement.maxFeePerGas! * 1000n).toBeGreaterThanOrEqual(2_000n * 1125n);
    expect(replacement.maxPriorityFeePerGas! * 1000n).toBeGreaterThanOrEqual(100n * 1125n);
  });

  it(`gives up with TxStuckError after ${MAX_REPLACEMENTS} replacements, each raising the fees again`, async () => {
    const n = stubNode();
    const hash = await n.sender.send({ to: TO, data: "0x" });
    const err = await waitOrReplace(n.client, n.sender, { to: TO, data: "0x" }, hash, { timeoutMs: 10 }).catch((e) => e);
    expect(err).toBeInstanceOf(TxStuckError);
    expect((err as TxStuckError).hashes).toHaveLength(1 + MAX_REPLACEMENTS);
    const fees = n.sent.slice(1).map((t) => t.maxFeePerGas!);
    for (let i = 1; i < fees.length; i++) expect(fees[i] * 1000n).toBeGreaterThanOrEqual(fees[i - 1] * 1125n);
    expect(n.sent.every((t, i) => i === 0 || t.nonce === 7)).toBe(true);
  });

  it("returns the original's receipt if it was mined after all (e.g. while the replacement was being sent)", async () => {
    const n = stubNode();
    const hash = await n.sender.send({ to: TO, data: "0x" });
    n.sender.send = async () => {
      n.mined.add(hash); // the original lands; the replacement is refused
      throw new Error("nonce too low");
    };
    expect((await waitOrReplace(n.client, n.sender, { to: TO, data: "0x" }, hash, { timeoutMs: 10 })).transactionHash).toBe(hash);
  });
});

describe("waitOrReplace against Anvil (automine off for the test)", () => {
  async function anvil<T = unknown>(method: string, params: unknown[]): Promise<T> {
    const res = await fetch(RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    return ((await res.json()) as { result: T }).result;
  }
  async function fundedSender(): Promise<{ sender: SerialTxSender; address: Hex }> {
    const key = generatePrivateKey();
    const address = privateKeyToAccount(key).address;
    await setEthBalance(address, 10n ** 18n);
    return { sender: new SerialTxSender(new LocalKeyTxSender(key, RPC, CHAIN)), address };
  }

  it("a stuck transaction is replaced at the same nonce through the same sender, and the replacement is mined", async () => {
    const { sender, address } = await fundedSender();
    const pub = publicClient();
    await anvil("evm_setAutomine", [false]);
    let mining = true;
    try {
      const req: TxRequest = { to: TO, data: "0x", value: 1n };
      const hash = await sender.send(req);
      const original = await pub.getTransaction({ hash });
      // Mine only once the pool holds a transaction from this sender other than the original: the replacement.
      const miner = (async () => {
        while (mining) {
          const content = await anvil<{ pending: Record<string, Record<string, { hash: Hex }>> }>("txpool_content", []);
          const mine = Object.entries(content.pending).find(([a]) => a.toLowerCase() === address.toLowerCase())?.[1] ?? {};
          if (Object.values(mine).some((t) => t.hash !== hash)) {
            await anvil("evm_mine", []);
            return;
          }
          await new Promise((r) => setTimeout(r, 100));
        }
      })();
      const receipt = await waitOrReplace(pub, sender, req, hash, { timeoutMs: 1_500 });
      mining = false;
      await miner;
      expect(receipt.status).toBe("success");
      expect(receipt.transactionHash).not.toBe(hash);
      const replacement = await pub.getTransaction({ hash: receipt.transactionHash });
      expect(replacement.nonce).toBe(original.nonce);
      expect(replacement.maxFeePerGas! * 1000n).toBeGreaterThanOrEqual(original.maxFeePerGas! * 1125n);
      await expect(pub.getTransactionReceipt({ hash })).rejects.toThrow(); // the original never landed
    } finally {
      mining = false;
      await anvil("evm_setAutomine", [true]);
    }
  });

  it("a dropped transaction surfaces as TxDroppedError within the timeout", async () => {
    const { sender } = await fundedSender();
    const pub = publicClient();
    await anvil("evm_setAutomine", [false]);
    try {
      const req: TxRequest = { to: TO, data: "0x", value: 1n };
      const hash = await sender.send(req);
      await anvil("anvil_dropTransaction", [hash]);
      const t0 = Date.now();
      await expect(waitOrReplace(pub, sender, req, hash, { timeoutMs: 1_500 })).rejects.toBeInstanceOf(TxDroppedError);
      expect(Date.now() - t0).toBeLessThan(10_000);
    } finally {
      await anvil("evm_setAutomine", [true]);
    }
  });
});

describe("HubClient.write: simulate failures (Plan 4.5 Task 10 review)", () => {
  it("rethrows a transport failure of the simulating eth_call unchanged, not as a HubRevertError", async () => {
    const real = publicClient();
    const failure = new HttpRequestError({ url: RPC, status: 500, details: "Internal Server Error" });
    const stub = { ...real, call: async () => { throw failure; } } as unknown as PublicClient;
    const hub = new HubClient(TO, stub);
    const err = await hub.timeout(new LocalKeyTxSender(generatePrivateKey(), RPC, CHAIN), h(1)).catch((e) => e);
    expect(err).toBe(failure); // before the fix: HubRevertError("hub call failed: HTTP request failed ...")
    expect(err).not.toBeInstanceOf(HubRevertError);
  });

  it("still reports a revert without data (no decodable reason) as a HubRevertError", async () => {
    const real = publicClient();
    // Any call is turned into garbage calldata to a contract with no fallback: an execution revert with empty data.
    const env = await deployArena();
    const stub = {
      ...real,
      call: (args: Parameters<PublicClient["call"]>[0]) => real.call({ ...args, data: "0xdeadbeef" }),
    } as unknown as PublicClient;
    const hub = new HubClient(env.hub, stub);
    const err = await hub.timeout(new LocalKeyTxSender(generatePrivateKey(), RPC, CHAIN), h(1)).catch((e) => e);
    expect(err).toBeInstanceOf(HubRevertError);
    expect((err as HubRevertError).errorName).toBeUndefined();
  });
});

describe("waitOrReplace: Task 10 re-review", () => {
  it("M1: an original mined while the wait is on its replacement is returned within that round", async () => {
    const n = stubNode();
    const hash = await n.sender.send({ to: TO, data: "0x" });
    const t0 = Date.now();
    // Round 1 (400 ms) ends with a replacement; the original lands 150 ms into round 2.
    setTimeout(() => n.mined.add(hash), 550);
    const r = await waitOrReplace(n.client, n.sender, { to: TO, data: "0x" }, hash, { timeoutMs: 400, pollMs: 20 });
    expect(r.transactionHash).toBe(hash);
    expect(n.sent).toHaveLength(2); // the replacement was sent...
    // ...but the wait noticed the original at once, not only when round 2 ran out (before: ~800 ms).
    expect(Date.now() - t0).toBeLessThan(750);
  });
});

describe("waitOrReplace: a failing replacement send (Task 10 re-review I1)", () => {
  const revert = () =>
    new ExecutionRevertedError({ cause: new BaseError("execution reverted", { details: "execution reverted: WrongPhase()" }) });

  it("keeps waiting on the original when its replacement's send reverts, and returns the original once mined", async () => {
    const n = stubNode();
    const hash = await n.sender.send({ to: TO, data: "0x" });
    const realSend = n.sender.send.bind(n.sender);
    let refused = 0;
    n.sender.send = async (tx) => {
      if (tx.nonce !== undefined) {
        refused++;
        setTimeout(() => n.mined.add(hash), 30); // the original lands shortly after
        throw revert();
      }
      return realSend(tx);
    };
    // Before the fix the replacement's revert was thrown at once, for a transaction that was still pending.
    const r = await waitOrReplace(n.client, n.sender, { to: TO, data: "0x" }, hash, { timeoutMs: 100, pollMs: 5 });
    expect(r.transactionHash).toBe(hash);
    expect(refused).toBe(1);
  });

  it("if it gives up in the end, HubClient.write reports that revert as a HubRevertError, like the original send's", async () => {
    const n = stubNode();
    const client = { ...n.client, call: async () => ({ data: undefined }) } as unknown as PublicClient;
    const realSend = n.sender.send.bind(n.sender);
    n.sender.send = async (tx) => {
      if (tx.nonce !== undefined) throw revert(); // every replacement reverts; the original never lands
      return realSend(tx);
    };
    const hub = new HubClient(TO, client);
    const err = await hub.timeout(n.sender, h(1), { receiptTimeoutMs: 20 }).catch((e) => e);
    expect(err).toBeInstanceOf(HubRevertError); // before: the raw ExecutionRevertedError
  });
});

describe("waitOrReplace: drops, nonces and the replacement contract (Task 10 re-review I3)", () => {
  it("re-checks the receipts right before reporting a drop: a transaction mined meanwhile is returned, not 'dropped'", async () => {
    const n = stubNode();
    const hash = await n.sender.send({ to: TO, data: "0x" });
    n.pool.delete(hash); // the node's pool no longer lists it...
    const realLookup = n.client.getTransaction;
    n.client.getTransaction = (async (args: { hash: Hex }) => {
      try {
        return await realLookup(args);
      } finally {
        n.mined.add(hash); // ...because it was just mined (seen by the next receipt read)
      }
    }) as typeof realLookup;
    // Before the fix: TxDroppedError, and the caller would pay a second time.
    const r = await waitOrReplace(n.client, n.sender, { to: TO, data: "0x" }, hash, { timeoutMs: 10, pollMs: 5 });
    expect(r.transactionHash).toBe(hash);
  });

  it("TxDroppedError carries the nonce the transaction was sent at", async () => {
    const n = stubNode();
    const hash = await n.sender.send({ to: TO, data: "0x", nonce: 9 });
    n.pool.delete(hash);
    const err = await waitOrReplace(n.client, n.sender, { to: TO, data: "0x" }, hash, { timeoutMs: 10, pollMs: 5, nonce: 9 }).catch((e) => e);
    expect(err).toBeInstanceOf(TxDroppedError);
    expect((err as TxDroppedError).nonce).toBe(9);
  });

  it("HubClient.write sends without a nonce (round 4: the sender picks it) and reports a dropped write", async () => {
    const n = stubNode();
    const sender: TxSender = {
      address: n.sender.address,
      async send(tx) {
        expect(tx.nonce).toBeUndefined();
        const hash = await n.sender.send({ ...tx, nonce: 11 });
        n.pool.delete(hash); // dropped at once
        return hash;
      },
    };
    const client = { ...n.client, call: async () => ({ data: undefined }) } as unknown as PublicClient;
    const hub = new HubClient(TO, client);
    const err = await hub.timeout(sender, h(1), { receiptTimeoutMs: 10 }).catch((e) => e);
    expect(err).toBeInstanceOf(TxDroppedError);
    expect((err as TxDroppedError).nonce).toBeUndefined(); // an untracked sender: the node no longer knows it
  });

  it("a sender that declares supportsReplacement = false is never replaced: it only waits, bounded, then reports", async () => {
    const n = stubNode({ supportsReplacement: false });
    const hash = await n.sender.send({ to: TO, data: "0x" });
    const err = await waitOrReplace(n.client, n.sender, { to: TO, data: "0x" }, hash, { timeoutMs: 10, pollMs: 5 }).catch((e) => e);
    expect(err).toBeInstanceOf(TxStuckError);
    expect(n.sent).toHaveLength(1); // before the fix: 3 replacements it could not honour
  });

  it("SerialTxSender(LocalKeyTxSender) picks the pending nonce itself; a replacement at a used nonce is refused (Anvil)", async () => {
    const key = generatePrivateKey();
    const address = privateKeyToAccount(key).address;
    await setEthBalance(address, 10n ** 18n);
    const sender = new SerialTxSender(new LocalKeyTxSender(key, RPC, CHAIN));
    const pub = publicClient();
    const a = await sender.send({ to: TO, data: "0x", value: 1n });
    expect((await pub.getTransaction({ hash: a })).nonce).toBe(0);
    const b = await sender.send({ to: TO, data: "0x", value: 1n });
    expect((await pub.getTransaction({ hash: b })).nonce).toBe(1);
    await expect(sender.send({ to: TO, data: "0x", value: 1n, nonce: 1 })).rejects.toThrow(/nonce/i); // used
  });
});

describe("waitOrReplace: a give-up time (Task 10 re-review I2)", () => {
  it("neither replaces nor waits past giveUpAt: a stuck transaction is reported at that time", async () => {
    const n = stubNode();
    const hash = await n.sender.send({ to: TO, data: "0x" });
    const t0 = Date.now();
    const err = await waitOrReplace(n.client, n.sender, { to: TO, data: "0x" }, hash, {
      timeoutMs: 1_000,
      pollMs: 10,
      giveUpAt: t0 + 150,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(TxStuckError);
    expect((err as TxStuckError).atDeadline).toBe(true);
    expect(Date.now() - t0).toBeLessThan(600); // before: a full 1 s round, then a replacement and more rounds
    expect(n.sent).toHaveLength(1);
  });

  it("HubClient.write passes giveUpAt through", async () => {
    const n = stubNode();
    const client = { ...n.client, call: async () => ({ data: undefined }) } as unknown as PublicClient;
    const t0 = Date.now();
    const err = await new HubClient(TO, client)
      .timeout(n.sender, h(1), { receiptTimeoutMs: 1_000, giveUpAt: t0 + 150 })
      .catch((e) => e);
    expect(err).toBeInstanceOf(TxStuckError);
    expect(Date.now() - t0).toBeLessThan(1_200);
  });
});

describe("waitOrReplace: legacy transactions (Task 10 re-review M2)", () => {
  it("prices a legacy replacement against the node's legacy fee estimate", async () => {
    const n = stubNode({ legacy: true });
    const hash = await n.sender.send({ to: TO, data: "0x" }); // gasPrice 2000; the node's legacy estimate is 3000
    const realSend = n.sender.send.bind(n.sender);
    n.sender.send = async (tx) => {
      const r = await realSend(tx);
      if (tx.nonce !== undefined) n.mined.add(r);
      return r;
    };
    await waitOrReplace(n.client, n.sender, { to: TO, data: "0x" }, hash, { timeoutMs: 10, pollMs: 5 });
    expect(n.estimates).toEqual(["legacy"]); // before: an EIP-1559 estimate, which has no gasPrice
    expect(n.sent[1].gasPrice).toBe(3_000n); // before: 2250 (the bump alone), under the market price
    expect(n.sent[1].maxFeePerGas).toBeUndefined();
  });
});

describe("SerialTxSender tracks its outstanding transaction (Task 10 re-review 2)", () => {
  async function anvil<T = unknown>(method: string, params: unknown[]): Promise<T> {
    const res = await fetch(RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    return ((await res.json()) as { result: T }).result;
  }
  async function fresh() {
    const key = generatePrivateKey();
    const address = privateKeyToAccount(key).address;
    await setEthBalance(address, 10n ** 18n);
    return { key, address, sender: new SerialTxSender(new LocalKeyTxSender(key, RPC, CHAIN)) };
  }
  const recipient = () => privateKeyToAccount(generatePrivateKey()).address;
  /** Every pending transaction of `address` in the pool, by nonce. */
  async function pooled(address: Hex): Promise<Record<string, { hash: Hex }>> {
    const c = await anvil<{ pending: Record<string, Record<string, { hash: Hex }>> }>("txpool_content", []);
    return Object.entries(c.pending).find(([a]) => a.toLowerCase() === address.toLowerCase())?.[1] ?? {};
  }
  async function manual<T>(fn: () => Promise<T>): Promise<T> {
    await anvil("evm_setAutomine", [false]);
    try {
      return await fn();
    } finally {
      await anvil("evm_setIntervalMining", [0]);
      await anvil("evm_setAutomine", [true]);
    }
  }

  it("a stuck transaction given up on is replaced by the next send, at its nonce with higher fees", () =>
    manual(async () => {
      const { address, sender } = await fresh();
      const pub = publicClient();
      const [respondTo, timeoutTo] = [recipient(), recipient()];
      const first: TxRequest = { to: respondTo, data: "0x", value: 1n }; // a respond, say
      const h1 = await sender.send(first);
      const stuck = await waitOrReplace(pub, sender, first, h1, { timeoutMs: 200, pollMs: 50, maxReplacements: 0 }).catch((e) => e);
      expect(stuck).toBeInstanceOf(TxStuckError);
      expect((stuck as TxStuckError).nonce).toBe(0);
      const lastFees = (stuck as TxStuckError).lastFees!;
      expect(lastFees.maxFeePerGas).toBeDefined();
      // The next dispute send (a timeout, say) goes out at the stuck nonce, fees raised -- not queued behind it.
      const h2 = await sender.send({ to: timeoutTo, data: "0x", value: 2n });
      const t2 = await pub.getTransaction({ hash: h2 });
      expect(t2.nonce).toBe(0); // before the fix: 1, queued behind the frozen nonce 0 forever
      expect(t2.maxFeePerGas! * 1000n).toBeGreaterThanOrEqual(lastFees.maxFeePerGas! * 1125n);
      expect(Object.keys(await pooled(address))).toEqual(["0"]);
      await anvil("evm_mine", []);
      expect((await pub.getTransactionReceipt({ hash: h2 })).status).toBe("success");
      expect(await pub.getBalance({ address: respondTo })).toBe(0n);
      expect(await pub.getBalance({ address: timeoutTo })).toBe(2n);
    }));

  it("a stuck top-up re-sent replaces its own copy: it is paid once, not twice", () =>
    manual(async () => {
      const { sender } = await fresh();
      const pub = publicClient();
      const session = recipient();
      const topUp: TxRequest = { to: session, data: "0x", value: 5n };
      const h1 = await sender.send(topUp);
      await waitOrReplace(pub, sender, topUp, h1, { timeoutMs: 200, pollMs: 50, maxReplacements: 0 }).catch(() => undefined);
      const h2 = await sender.send(topUp); // the next pass: balance still short, so the top-up is sent again
      await anvil("evm_mine", []);
      await anvil("evm_mine", []);
      expect(await pub.getBalance({ address: session })).toBe(5n); // before the fix: 10n
      expect((await pub.getTransactionReceipt({ hash: h2 })).status).toBe("success");
    }));

  it("a transaction reported dropped by a lagging node is re-sent at its nonce: at most one of the two lands", () =>
    manual(async () => {
      const { address, sender } = await fresh();
      const pub = publicClient();
      const to = recipient();
      const deposit: TxRequest = { to, data: "0x", value: 3n };
      const h1 = await sender.send(deposit);
      // The node this wait asks lags: it does not know h1 -- although the real pool still holds it.
      const lagging = {
        ...pub,
        getTransaction: async ({ hash }: { hash: Hex }) => {
          throw new TransactionNotFoundError({ hash });
        },
      } as unknown as ReceiptClient;
      const dropped = await waitOrReplace(lagging, sender, deposit, h1, { timeoutMs: 100, pollMs: 50 }).catch((e) => e);
      expect(dropped).toBeInstanceOf(TxDroppedError);
      expect((dropped as TxDroppedError).nonce).toBe(0);
      const h2 = await sender.send(deposit); // the resend
      expect((await pub.getTransaction({ hash: h2 })).nonce).toBe(0); // before the fix: 1 -- both would land
      expect(Object.keys(await pooled(address))).toEqual(["0"]);
      await anvil("evm_mine", []);
      await anvil("evm_mine", []);
      expect(await pub.getBalance({ address: to })).toBe(3n);
    }));

  it("round 4, invariant 1: a send while another transaction's wait is active never pre-empts it; both land", () =>
    manual(async () => {
      const { sender } = await fresh();
      const pub = publicClient();
      const [x, y] = [recipient(), recipient()];
      const forA: TxRequest = { to: x, data: "0x", value: 1n }; // channel A's transaction
      const forB: TxRequest = { to: y, data: "0x", value: 1n }; // channel B's, sent while A's wait is active
      const a = await sender.send(forA);
      const waitA = waitOrReplace(pub, sender, forA, a, { timeoutMs: 5_000, pollMs: 100 }).catch((e) => e);
      await nap(150); // A's wait is polling
      const b = await sender.send(forB);
      // Round 3 sent B at A's nonce 0 and knocked A's healthy transaction out of the pool.
      expect((await pub.getTransaction({ hash: b })).nonce).toBe(1);
      await anvil("evm_setIntervalMining", [1]); // the chain goes on
      await waitOrReplace(pub, sender, forB, b, { timeoutMs: 5_000, pollMs: 100 });
      expect(((await waitA) as TransactionReceipt).transactionHash).toBe(a);
      expect(await pub.getBalance({ address: x })).toBe(1n); // each landed exactly once
      expect(await pub.getBalance({ address: y })).toBe(1n);
      expect(sender.tracked()).toEqual([]);
    }));

  it("round 4: a fresh send whose nonce turns out used (a pure count race) is retried once at the next nonce", async () => {
    const { key, address } = await fresh();
    const pub = publicClient();
    const inner = new LocalKeyTxSender(key, RPC, CHAIN);
    // Nonce 0 is used by a send this tracker never saw, and its reader's counts lag behind it.
    const h0 = await inner.send({ to: recipient(), data: "0x", value: 1n });
    await pub.waitForTransactionReceipt({ hash: h0 });
    const blind = {
      getTransactionReceipt: pub.getTransactionReceipt.bind(pub),
      getTransactionCount: async () => 0,
      getTransaction: pub.getTransaction.bind(pub),
      estimateFeesPerGas: pub.estimateFeesPerGas.bind(pub),
      estimateGas: pub.estimateGas.bind(pub),
      getBalance: pub.getBalance.bind(pub),
    } as unknown as TrackerClient;
    const sender = new SerialTxSender(inner, blind);
    const h1 = await sender.send({ to: recipient(), data: "0x", value: 1n }); // 0 is refused, then nonce 1
    await pub.waitForTransactionReceipt({ hash: h1 });
    expect((await pub.getTransaction({ hash: h1 })).nonce).toBe(1);
    expect(sender.tracked().map((t) => t.nonce)).toEqual([1]);
    expect(await pub.getTransactionCount({ address })).toBe(2);
  });

  it("isNonceUsedError recognises Anvil's real used-nonce error, and nothing else", async () => {
    const { key } = await fresh();
    const pub = publicClient();
    const inner = new LocalKeyTxSender(key, RPC, CHAIN);
    const h = await inner.send({ to: recipient(), data: "0x", value: 1n });
    await pub.waitForTransactionReceipt({ hash: h });
    const used = await inner.send({ to: recipient(), data: "0x", value: 1n, nonce: 0 }).catch((e) => e);
    expect(isNonceUsedError(used)).toBe(true);
    const poor = new LocalKeyTxSender(generatePrivateKey(), RPC, CHAIN); // no ETH at all
    const broke = await poor.send({ to: recipient(), data: "0x", value: 1n }).catch((e) => e);
    expect(broke).toBeInstanceOf(Error);
    expect(isNonceUsedError(broke)).toBe(false);
  });
});

describe("a replacement that would revert against the pending state (Task 10 re-review 2)", () => {
  async function anvil<T = unknown>(method: string, params: unknown[]): Promise<T> {
    const res = await fetch(RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    return ((await res.json()) as { result: T }).result;
  }

  it("is still sent: it carries its original's gas limit, and a new intent is estimated against the latest block", async () => {
    const env = await deployArena();
    const key = generatePrivateKey();
    const address = privateKeyToAccount(key).address;
    await setEthBalance(address, 10n ** 18n);
    await mintUsdc(env.usdc, address, 1_000n);
    const pub = publicClient();
    const sender = new SerialTxSender(new LocalKeyTxSender(key, RPC, CHAIN));
    // Moving the whole balance succeeds once: against a pending state that already holds it, it would revert.
    const all: TxRequest = {
      to: env.usdc,
      data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [TO, 1_000n] }),
    };
    await anvil("evm_setAutomine", [false]);
    try {
      const h1 = await sender.send(all);
      const stuck = await waitOrReplace(pub, sender, all, h1, { timeoutMs: 200, pollMs: 50, maxReplacements: 1 }).catch((e) => e);
      // Before: the replacement's gas estimate reverted (pending state), so the wait ended in that revert.
      expect(stuck).toBeInstanceOf(TxStuckError);
      expect((stuck as TxStuckError).hashes).toHaveLength(2);
      const again = await sender.send(all); // the next send of the same intent, at the stuck nonce
      expect((await pub.getTransaction({ hash: again })).nonce).toBe(0);
      await anvil("evm_mine", []);
      expect((await pub.getTransactionReceipt({ hash: again })).status).toBe("success");
    } finally {
      await anvil("evm_setAutomine", [true]);
    }
  });
});

describe("waitOrReplace: an earlier replacement's failure is forgotten once a later one goes out (re-review 2, minor 1)", () => {
  it("replacement 1 reverts, 2 and 3 are sent: the result is TxStuckError, not that revert", async () => {
    const n = stubNode();
    const hash = await n.sender.send({ to: TO, data: "0x" });
    const realSend = n.sender.send.bind(n.sender);
    let replacements = 0;
    n.sender.send = async (tx) => {
      if (tx.nonce !== undefined && ++replacements === 1) {
        throw new ExecutionRevertedError({ cause: new BaseError("execution reverted", { details: "execution reverted" }) });
      }
      return realSend(tx);
    };
    const err = await waitOrReplace(n.client, n.sender, { to: TO, data: "0x" }, hash, { timeoutMs: 10, pollMs: 5 }).catch((e) => e);
    expect(replacements).toBe(3);
    expect(err).toBeInstanceOf(TxStuckError); // before: the stale revert of replacement 1
  });
});

describe("HubClient.write reports the transaction that actually reverted (re-review 2, minor 6)", () => {
  it("a mined replacement that reverted is named by its own hash, not the original's", async () => {
    const n = stubNode();
    const client = { ...n.client, call: async () => ({ data: undefined }) } as unknown as PublicClient;
    const realSend = n.sender.send.bind(n.sender);
    let replacement: Hex | undefined;
    n.sender.send = async (tx) => {
      const r = await realSend(tx);
      if (tx.nonce !== undefined) {
        replacement = r;
        revertedHashes.add(r);
        n.mined.add(r); // the replacement is mined -- and reverted
      }
      return r;
    };
    const err = await new HubClient(TO, client).timeout(n.sender, h(1), { receiptTimeoutMs: 10 }).catch((e) => e);
    expect(err).toBeInstanceOf(HubRevertError);
    expect(String((err as Error).message)).toContain(replacement!); // before: the original's hash
  });
});

describe("waitOrReplace can be aborted (re-review 2, minor 5)", () => {
  it("an aborted signal ends the wait at once, with no replacement", async () => {
    const n = stubNode();
    const hash = await n.sender.send({ to: TO, data: "0x" });
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 50);
    const t0 = Date.now();
    const err = await waitOrReplace(n.client, n.sender, { to: TO, data: "0x" }, hash, { timeoutMs: 5_000, signal: ctl.signal }).catch((e) => e);
    expect(err).toBeInstanceOf(TxWaitAbortedError);
    expect(Date.now() - t0).toBeLessThan(1_000); // before: the full 5 s round, then replacements
    expect(n.sent).toHaveLength(1);
  });
});
