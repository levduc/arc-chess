import {
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
  createPublicClient,
  createWalletClient,
  http,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
  type WalletClient,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";

/** A transaction to send. `nonce` and the fee fields are overrides, used to replace a stuck transaction at the same
 *  nonce with higher fees (`waitOrReplace`); a sender that cannot honour them may ignore them. */
export type TxRequest = {
  to: Address;
  data: Hex;
  value?: bigint;
  nonce?: number;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
  gasPrice?: bigint;
};

/** A sent transaction and, when the sender knows it, the nonce it was sent at. */
export type SentTx = { hash: Hex; nonce?: number };

/**
 * Sends a transaction from some wallet (spec §3.1). Implementations: local key (v1), Circle CLI (Plan 6).
 *
 * Contract (Plan 4.5 Task 10 re-review I3): `send` MUST honour `TxRequest.nonce` and the fee overrides -- a stuck
 * transaction is replaced by sending again at its nonce with higher fees, and a dropped one is resent at the same
 * nonce. A sender that cannot MUST declare `supportsReplacement = false`: `waitOrReplace` then never replaces its
 * transactions, it only waits (bounded) and reports.
 */
export interface TxSender {
  readonly address: Address;
  /** False if `send` cannot honour the nonce/fee overrides (default: true). */
  readonly supportsReplacement?: boolean;
  send(tx: TxRequest): Promise<Hex>;
  /** Like `send`, but also reports the nonce used, so a dropped transaction can be resent at the same nonce. */
  sendWithNonce?(tx: TxRequest): Promise<SentTx>;
}

/**
 * Sends from a local private key. Used for participant wallets on Anvil and, with a channel's session key,
 * as the session-key sender for dispute transactions (spec §3.1 SessionKeyTxSender).
 */
export class LocalKeyTxSender implements TxSender {
  private readonly account: PrivateKeyAccount;
  private readonly wallet: WalletClient;
  private readonly reader: PublicClient;

  constructor(privateKey: Hex, rpcUrl: string, private readonly chain: Chain) {
    this.account = privateKeyToAccount(privateKey);
    this.wallet = createWalletClient({ account: this.account, chain, transport: http(rpcUrl) });
    this.reader = createPublicClient({ chain, transport: http(rpcUrl) }) as PublicClient;
  }

  /** Picks the nonce itself (the account's pending count, unless `tx.nonce` is given) and reports it. */
  async sendWithNonce(tx: TxRequest): Promise<SentTx> {
    const nonce = tx.nonce ?? (await this.reader.getTransactionCount({ address: this.account.address, blockTag: "pending" }));
    return { hash: await this.send({ ...tx, nonce }), nonce };
  }

  get address(): Address {
    return this.account.address;
  }

  send(tx: TxRequest): Promise<Hex> {
    const fees =
      tx.gasPrice !== undefined
        ? { gasPrice: tx.gasPrice }
        : tx.maxFeePerGas !== undefined
          ? { maxFeePerGas: tx.maxFeePerGas, maxPriorityFeePerGas: tx.maxPriorityFeePerGas }
          : {};
    return this.wallet.sendTransaction({
      account: this.account,
      chain: this.chain,
      to: tx.to,
      data: tx.data,
      value: tx.value,
      ...(tx.nonce !== undefined ? { nonce: tx.nonce } : {}),
      ...fees,
    } as Parameters<WalletClient["sendTransaction"]>[0]);
  }
}

/**
 * Runs one send at a time per wallet, so two concurrent callers (funding two channels, a close racing a top-up) never
 * fetch the same pending nonce. A send is finished once the node has accepted the transaction (hash returned).
 */
export class SerialTxSender implements TxSender {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private readonly inner: TxSender) {}
  get address(): Address {
    return this.inner.address;
  }
  get supportsReplacement(): boolean | undefined {
    return this.inner.supportsReplacement;
  }
  send(tx: TxRequest): Promise<Hex> {
    const run = this.tail.then(() => this.inner.send(tx));
    this.tail = run.catch(() => undefined);
    return run;
  }
  /** Serialized like `send`, so the nonce the inner sender picks is never picked twice. */
  sendWithNonce(tx: TxRequest): Promise<SentTx> {
    const inner = this.inner;
    const run = this.tail.then(() => (inner.sendWithNonce ? inner.sendWithNonce(tx) : inner.send(tx).then((hash) => ({ hash }))));
    this.tail = run.catch(() => undefined);
    return run;
  }
}

// ------------------------------------------------------------------------------------ bounded receipt waits

/** Plan 4.5 Task 10 review: the default bound on one receipt wait (viem's own default is 180 s). */
export const RECEIPT_TIMEOUT_MS = 30_000;
/** At most this many same-nonce replacements of one stuck transaction before `TxStuckError`. */
export const MAX_REPLACEMENTS = 3;
/** How often a receipt wait polls the receipts of the transactions it has sent. */
export const RECEIPT_POLL_MS = 1_000;

/** The transaction is no longer known to the node (dropped from the mempool, or reorged out and discarded) and was
 *  never mined: the caller should re-evaluate and, if still needed, send it again. */
export class TxDroppedError extends Error {
  /** `nonce`: the nonce it was sent at, when known -- resend the same logical transaction at it, so that if it was
   *  not really dropped (a lagging or load-balanced node), at most one of the two can land. */
  constructor(
    readonly hash: Hex,
    readonly nonce?: number,
  ) {
    super(`transaction ${hash} was dropped before it was mined${nonce !== undefined ? ` (nonce ${nonce})` : ""}`);
    this.name = "TxDroppedError";
  }
}

/** The transaction stayed pending through `MAX_REPLACEMENTS` fee-bumped replacements. */
export class TxStuckError extends Error {
  /** `atDeadline`: the wait stopped at its give-up time (a dispute deadline), not after its replacements. */
  constructor(
    readonly hashes: Hex[],
    readonly atDeadline = false,
  ) {
    super(
      atDeadline
        ? `transaction still pending at its give-up time (${hashes.at(-1)})`
        : `transaction still pending after ${hashes.length - 1} fee-bumped replacements (${hashes.at(-1)})`,
    );
    this.name = "TxStuckError";
  }
}

/** The subset of a viem PublicClient `waitOrReplace` uses (tests pass a stub). */
export type ReceiptClient = Pick<
  PublicClient,
  "getTransaction" | "getTransactionReceipt" | "estimateFeesPerGas"
>;

/** `x` raised by at least 12.5 % (and by at least 1 wei), rounded up. */
function bump(x: bigint): bigint {
  const raised = (x * 1125n + 999n) / 1000n;
  return raised > x ? raised : x + 1n;
}

const max = (a: bigint, b: bigint | undefined) => (b !== undefined && b > a ? b : a);

/**
 * Plan 4.5 Task 10 review: waits for `hash` (sent by `sender` as `req`) at most `timeoutMs`, instead of viem's 180 s
 * default -- a daemon's watchtower waits on these serially, so one dropped or stuck transaction must not hold it
 * past a dispute deadline. On a timeout:
 * - if any transaction sent so far (the original or a replacement) has been mined, its receipt is returned;
 * - if the node no longer knows the transaction, `TxDroppedError` (the caller re-evaluates and resends);
 * - if it is still pending, it is replaced at the same nonce with fees raised by at least 12.5 % (and at least to
 *   the node's current estimate), through the same `sender` -- up to `MAX_REPLACEMENTS` times, then `TxStuckError`.
 */
export async function waitOrReplace(
  client: ReceiptClient,
  sender: TxSender,
  req: TxRequest,
  hash: Hex,
  opts: {
    timeoutMs?: number;
    maxReplacements?: number;
    pollMs?: number;
    nonce?: number;
    /** Wall-clock ms (Plan 4.5 Task 10 re-review I2): no replacement is sent and no wait runs past it -- e.g. a
     *  respond's dispute deadline, after which the transaction can no longer help. */
    giveUpAt?: number;
  } = {},
): Promise<TransactionReceipt> {
  const timeoutMs = opts.timeoutMs ?? RECEIPT_TIMEOUT_MS;
  const pollMs = opts.pollMs ?? RECEIPT_POLL_MS;
  const maxReplacements = opts.maxReplacements ?? MAX_REPLACEMENTS;
  const hashes: Hex[] = [hash];
  let lastSendError: unknown;
  let nonce = opts.nonce;
  const canReplace = sender.supportsReplacement !== false;
  const lookup = (h: Hex) =>
    client.getTransaction({ hash: h }).catch((err: unknown) => {
      if (err instanceof TransactionNotFoundError) return null;
      throw err;
    });
  const minedOne = async (): Promise<TransactionReceipt | null> => {
    for (const h of hashes) {
      const r = await client.getTransactionReceipt({ hash: h }).catch((err: unknown) => {
        if (err instanceof TransactionReceiptNotFoundError) return null;
        throw err;
      });
      if (r) return r;
    }
    return null;
  };
  for (let round = 0; ; round++) {
    const current = hashes[hashes.length - 1];
    // Plan 4.5 Task 10 re-review (M1): one round polls the receipts of every hash sent so far -- the original can
    // still be mined while the wait is on its replacement (viem's waitForTransactionReceipt watches one hash).
    const roundEnd = Math.min(Date.now() + timeoutMs, opts.giveUpAt ?? Number.POSITIVE_INFINITY);
    for (;;) {
      const mined = await minedOne();
      if (mined) return mined;
      const left = roundEnd - Date.now();
      if (left <= 0) break;
      await new Promise((r) => setTimeout(r, Math.min(pollMs, left)));
    }
    // The newest of our transactions the node still knows (an older one may outlive a dropped replacement).
    let pending: Awaited<ReturnType<typeof lookup>> = null;
    for (const h of [...hashes].reverse()) {
      pending = await lookup(h);
      if (pending) break;
    }
    if (!pending) {
      // Plan 4.5 Task 10 re-review (I3): one more receipt check right before reporting a drop -- a transaction mined
      // between the two reads above is not dropped, and resending it would pay twice.
      const late = await minedOne();
      if (late) return late;
      throw new TxDroppedError(current, nonce);
    }
    nonce ??= pending.nonce;
    if (pending.blockNumber !== null) {
      // mined between the two reads: its receipt is there now
      const r = await minedOne();
      if (r) return r;
      continue;
    }
    if (opts.giveUpAt !== undefined && Date.now() >= opts.giveUpAt) throw new TxStuckError(hashes, true);
    if (!canReplace) {
      // A sender that cannot honour nonce/fee overrides: never replace, only wait (bounded) and report.
      if (round < maxReplacements) continue;
      throw new TxStuckError(hashes);
    }
    if (round >= maxReplacements) {
      // A replacement send that failed (e.g. it reverted in gas estimation) explains best why we are stuck; the
      // caller classifies it (HubClient.write maps an execution revert to HubRevertError, like the original send).
      if (lastSendError !== undefined) throw lastSendError;
      throw new TxStuckError(hashes);
    }
    let replacement: TxRequest;
    if (pending.maxFeePerGas !== undefined && pending.maxFeePerGas !== null) {
      const estimate = await client.estimateFeesPerGas().catch(() => undefined);
      replacement = {
        ...req,
        nonce: pending.nonce,
        maxFeePerGas: max(bump(pending.maxFeePerGas), estimate?.maxFeePerGas),
        maxPriorityFeePerGas: max(bump(pending.maxPriorityFeePerGas ?? 0n), estimate?.maxPriorityFeePerGas),
      };
    } else {
      // Plan 4.5 Task 10 re-review (M2): a legacy transaction is priced against the node's legacy estimate (an
      // EIP-1559 estimate carries no gasPrice, so the bump alone could stay under the market price).
      const legacy = { type: "legacy" } as Parameters<ReceiptClient["estimateFeesPerGas"]>[0];
      const estimate = (await client.estimateFeesPerGas(legacy).catch(() => undefined)) as { gasPrice?: bigint } | undefined;
      replacement = { ...req, nonce: pending.nonce, gasPrice: max(bump(pending.gasPrice ?? 0n), estimate?.gasPrice) };
    }
    try {
      hashes.push(await sender.send(replacement));
    } catch (err) {
      // e.g. "nonce too low": the original was mined after all
      const r = await minedOne();
      if (r) return r;
      // Plan 4.5 Task 10 re-review (I1): nothing is mined, so the original is still pending -- keep waiting on the
      // hashes already sent rather than failing a transaction that may still land.
      lastSendError = err;
    }
  }
}
