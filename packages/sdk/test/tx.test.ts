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
  waitOrReplace,
  type ReceiptClient,
  type TxRequest,
  type TxSender,
} from "../src/index.js";
import { CHAIN, RPC, deployArena, publicClient, setEthBalance } from "./helpers/chain.js";

const h = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}`;
const TO = "0x00000000000000000000000000000000000000aa" as const;
const receiptOf = (hash: Hex) => ({ transactionHash: hash, status: "success" }) as unknown as TransactionReceipt;

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
