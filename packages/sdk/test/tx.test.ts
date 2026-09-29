/**
 * Plan 4.5 Task 10 review: bounded receipt waits (`waitOrReplace`) -- a timeout, a dropped transaction, and a stuck
 * one replaced at the same nonce with higher fees. Stubbed client/sender tests pin the decision logic; two tests
 * against the suite's Anvil (automine switched off for their duration) pin what a real node and viem do with the
 * nonce/fee overrides and with `anvil_dropTransaction`.
 */
import { describe, expect, it } from "vitest";
import {
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
  WaitForTransactionReceiptTimeoutError,
  type Hex,
  type TransactionReceipt,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
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
import { CHAIN, RPC, publicClient, setEthBalance } from "./helpers/chain.js";

const h = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}`;
const TO = "0x00000000000000000000000000000000000000aa" as const;
const receiptOf = (hash: Hex) => ({ transactionHash: hash, status: "success" }) as unknown as TransactionReceipt;

/** A stub node: `mined` holds the hashes that have a receipt, `pool` the pending ones (hash -> nonce/fees). */
function stubNode() {
  const mined = new Set<Hex>();
  const pool = new Map<Hex, { nonce: number; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }>();
  const sent: TxRequest[] = [];
  let next = 100;
  const client: ReceiptClient = {
    waitForTransactionReceipt: (async ({ hash }: { hash: Hex }) => {
      if (mined.has(hash)) return receiptOf(hash);
      throw new WaitForTransactionReceiptTimeoutError({ hash });
    }) as ReceiptClient["waitForTransactionReceipt"],
    getTransactionReceipt: (async ({ hash }: { hash: Hex }) => {
      if (mined.has(hash)) return receiptOf(hash);
      throw new TransactionReceiptNotFoundError({ hash });
    }) as ReceiptClient["getTransactionReceipt"],
    getTransaction: (async ({ hash }: { hash: Hex }) => {
      const p = pool.get(hash);
      if (!p) throw new TransactionNotFoundError({ hash });
      return { hash, blockNumber: null, ...p };
    }) as unknown as ReceiptClient["getTransaction"],
    estimateFeesPerGas: (async () => ({ maxFeePerGas: 1_000n, maxPriorityFeePerGas: 10n })) as ReceiptClient["estimateFeesPerGas"],
  };
  const sender: TxSender = {
    address: "0x00000000000000000000000000000000000000bb",
    async send(tx: TxRequest) {
      sent.push(tx);
      const hash = h(next++);
      pool.set(hash, { nonce: tx.nonce ?? 7, maxFeePerGas: tx.maxFeePerGas ?? 2_000n, maxPriorityFeePerGas: tx.maxPriorityFeePerGas ?? 100n });
      return hash;
    },
  };
  return { client, sender, mined, pool, sent };
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
