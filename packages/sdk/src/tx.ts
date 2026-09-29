import {
  BaseError,
  NonceTooLowError,
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
  /** Gas limit. A same-nonce replacement carries its original's (Plan 4.5 Task 10 re-review 2): estimating it
   *  again would run against a pending state that already includes the original, where it can revert. */
  gas?: bigint;
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
  /** Told by `waitOrReplace` when a receipt for `hash` has been found (a tracking sender settles it). */
  mined?(hash: Hex): void;
  /** A tracking sender's unconfirmed transaction (see SerialTxSender). */
  readonly outstanding?: Outstanding | null;
}

/**
 * Sends from a local private key. Used for participant wallets on Anvil and, with a channel's session key,
 * as the session-key sender for dispute transactions (spec §3.1 SessionKeyTxSender).
 */
export class LocalKeyTxSender implements TxSender {
  private readonly account: PrivateKeyAccount;
  private readonly wallet: WalletClient;
  /** A read client on the same RPC (a SerialTxSender around this one uses it to track its outstanding tx). */
  readonly reader: PublicClient;

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

  async send(tx: TxRequest): Promise<Hex> {
    // Gas is estimated here, against the latest block, unless given: some nodes (Anvil) estimate against the pending
    // block by default, which already holds this account's stuck transaction -- a new intent replacing it at its
    // nonce (see SerialTxSender) could then revert in estimation although it is valid.
    const gas =
      tx.gas ??
      (await this.reader.estimateGas({ account: this.account.address, to: tx.to, data: tx.data, value: tx.value, blockTag: "latest" }));
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
      gas,
      ...(tx.nonce !== undefined ? { nonce: tx.nonce } : {}),
      ...fees,
    } as Parameters<WalletClient["sendTransaction"]>[0]);
  }
}

/** A transaction's fee fields (EIP-1559 or legacy). */
export type Fees = { maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint; gasPrice?: bigint };

/** The transaction a tracking sender has sent and not yet seen confirmed: its nonce, the fees it last went out
 *  with, and every hash sent at that nonce. */
export type Outstanding = { nonce: number; lastFees: Fees; hashes: Hex[] };

/** The reads a tracking `SerialTxSender` needs. */
export type TrackerClient = Pick<
  PublicClient,
  "getTransactionReceipt" | "getTransaction" | "getTransactionCount" | "estimateFeesPerGas"
>;

/**
 * Runs one send at a time per wallet, so two concurrent callers (funding two channels, a close racing a top-up) never
 * fetch the same pending nonce. A send is finished once the node has accepted the transaction (hash returned).
 *
 * Plan 4.5 Task 10 re-review 2: it also tracks its **outstanding** transaction -- the one it last sent and has not
 * seen confirmed (still in flight, stuck, dropped, or given up on by `waitOrReplace`). The next send without an
 * explicit nonce first checks it: if it was mined (a receipt for any of its hashes, or the account's confirmed nonce
 * count is past it) it is cleared and the send takes a fresh nonce; otherwise the send goes out **at its nonce** with
 * fees raised by at least 12.5 % over its last fees, replacing it with the new intent -- only one of the two can
 * land. That is what makes a timeout replace a stuck respond instead of queueing behind it forever, and a re-sent
 * top-up replace its own stuck copy instead of paying twice. A nonce-used error clears it and the send is retried
 * once at a fresh nonce.
 *
 * On a wallet shared by several channels, such a replacement can pre-empt another channel's pending transaction:
 * that channel's wait then sees its transaction gone (TxDroppedError) and its next pass sends it again, which
 * self-heals with no double effect (tx.test.ts).
 *
 * Tracking needs a read client: `reader`, or the inner sender's own (`LocalKeyTxSender.reader`). Without one, or for
 * an inner sender that declares `supportsReplacement = false`, sends are only serialized.
 */
export class SerialTxSender implements TxSender {
  private tail: Promise<unknown> = Promise.resolve();
  private current: Outstanding | null = null;
  private readonly reader: TrackerClient | undefined;

  constructor(
    private readonly inner: TxSender,
    reader?: TrackerClient,
  ) {
    this.reader = reader ?? (inner as { reader?: TrackerClient }).reader;
  }

  get address(): Address {
    return this.inner.address;
  }
  get supportsReplacement(): boolean | undefined {
    return this.inner.supportsReplacement;
  }
  /** The outstanding transaction, if any (for tests and tooling). */
  get outstanding(): Outstanding | null {
    return this.current;
  }

  send(tx: TxRequest): Promise<Hex> {
    return this.sendWithNonce(tx).then((s) => s.hash);
  }

  /** Serialized, so the nonce is never picked twice; reports the nonce used. */
  sendWithNonce(tx: TxRequest): Promise<SentTx> {
    const run = this.tail.then(() => this.sendNow(tx));
    this.tail = run.catch(() => undefined);
    return run;
  }

  mined(hash: Hex): void {
    if (this.current?.hashes.includes(hash)) this.current = null;
  }

  private raw(tx: TxRequest): Promise<SentTx> {
    const inner = this.inner;
    return inner.sendWithNonce ? inner.sendWithNonce(tx) : inner.send(tx).then((hash) => ({ hash, nonce: tx.nonce }));
  }

  private async sendNow(tx: TxRequest): Promise<SentTx> {
    const reader = this.reader;
    if (!reader || this.inner.supportsReplacement === false) return this.raw(tx);
    let req = tx;
    const o = this.current;
    if (tx.nonce === undefined && o) {
      if (await this.settled(reader, o)) {
        this.current = null;
      } else {
        const estimate = await estimateLike(reader, o.lastFees);
        req = { ...tx, nonce: o.nonce, ...replacementFees(o.lastFees, estimate) };
      }
    }
    try {
      const sent = await this.raw(req);
      await this.record(reader, sent, req);
      return sent;
    } catch (err) {
      if (!isNonceUsedError(err)) throw err;
      // Whatever held that nonce is settled now.
      if (this.current && req.nonce === this.current.nonce) this.current = null;
      // A caller-chosen nonce (a waitOrReplace replacement) is never moved: a used nonce means its original landed.
      if (tx.nonce !== undefined) throw err;
      const sent = await this.raw(tx); // once, at a fresh nonce
      await this.record(reader, sent, tx);
      return sent;
    }
  }

  /** Mined: a receipt for one of its hashes, or the account's confirmed nonce count is already past it. */
  private async settled(reader: TrackerClient, o: Outstanding): Promise<boolean> {
    for (const h of o.hashes) {
      const r = await reader.getTransactionReceipt({ hash: h }).catch(() => null);
      if (r) return true;
    }
    const confirmed = await reader.getTransactionCount({ address: this.inner.address, blockTag: "latest" });
    return confirmed > o.nonce;
  }

  private async record(reader: TrackerClient, sent: SentTx, req: TxRequest): Promise<void> {
    let nonce = sent.nonce ?? req.nonce;
    let fees = feesOf(req);
    if (nonce === undefined || !hasFees(fees)) {
      const t = await reader.getTransaction({ hash: sent.hash }).catch(() => null);
      nonce ??= t?.nonce;
      if (!hasFees(fees) && t) fees = feesOf(t as unknown as Fees);
    }
    if (nonce === undefined) return;
    if (this.current && this.current.nonce === nonce) {
      this.current = { nonce, lastFees: hasFees(fees) ? fees : this.current.lastFees, hashes: [...this.current.hashes, sent.hash] };
    } else {
      this.current = { nonce, lastFees: fees, hashes: [sent.hash] };
    }
  }
}

/** True for a send refused because its nonce is already used: viem's NonceTooLowError, or the node's own words
 *  (Anvil: "nonce too low"; geth: "nonce too low" / "already known" differs -- only the used-nonce forms count). */
export function isNonceUsedError(err: unknown): boolean {
  if (err instanceof BaseError && err.walk((e) => e instanceof NonceTooLowError)) return true;
  const text = err instanceof BaseError ? `${err.message} ${err.details}` : err instanceof Error ? err.message : String(err);
  return /nonce too low|nonce (has )?already (been )?used|lower than the current nonce/i.test(text);
}

function feesOf(x: Fees): Fees {
  if (x.maxFeePerGas !== undefined && x.maxFeePerGas !== null) {
    return { maxFeePerGas: x.maxFeePerGas, maxPriorityFeePerGas: x.maxPriorityFeePerGas ?? 0n };
  }
  if (x.gasPrice !== undefined && x.gasPrice !== null) return { gasPrice: x.gasPrice };
  return {};
}

const hasFees = (f: Fees) => f.maxFeePerGas !== undefined || f.gasPrice !== undefined;

/** The node's current fee estimate in the same style (EIP-1559 or legacy) as `like`. */
async function estimateLike(client: Pick<PublicClient, "estimateFeesPerGas">, like: Fees): Promise<Fees | undefined> {
  const legacy = like.gasPrice !== undefined && like.maxFeePerGas === undefined;
  const args = (legacy ? { type: "legacy" } : undefined) as Parameters<PublicClient["estimateFeesPerGas"]>[0];
  return (await client.estimateFeesPerGas(args).catch(() => undefined)) as Fees | undefined;
}

/** Fees for a same-nonce replacement: each raised by at least 12.5 % over `last`, and at least to `estimate`. */
function replacementFees(last: Fees, estimate: Fees | undefined): Fees {
  if (last.maxFeePerGas !== undefined) {
    return {
      maxFeePerGas: max(bump(last.maxFeePerGas), estimate?.maxFeePerGas),
      maxPriorityFeePerGas: max(bump(last.maxPriorityFeePerGas ?? 0n), estimate?.maxPriorityFeePerGas),
    };
  }
  if (last.gasPrice !== undefined) return { gasPrice: max(bump(last.gasPrice), estimate?.gasPrice) };
  // Unknown last fees: a bumped current estimate is the best available guess.
  if (estimate?.maxFeePerGas !== undefined) {
    return { maxFeePerGas: bump(estimate.maxFeePerGas), maxPriorityFeePerGas: bump(estimate.maxPriorityFeePerGas ?? 0n) };
  }
  return estimate?.gasPrice !== undefined ? { gasPrice: bump(estimate.gasPrice) } : {};
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
  /** `nonce` / `lastFees`: what it was last sent at, when known. A tracking SerialTxSender keeps it outstanding, so
   *  the next send goes out at that nonce with higher fees -- if it was not really dropped (a lagging or
   *  load-balanced node), at most one of the two can land. */
  constructor(
    readonly hash: Hex,
    readonly nonce?: number,
    readonly lastFees?: Fees,
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
    readonly nonce?: number,
    readonly lastFees?: Fees,
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
  // What the sender recorded at send time, when it tracks (the node may never answer for a dropped transaction).
  const tracked = sender.outstanding?.hashes.includes(hash) ? sender.outstanding : null;
  nonce ??= tracked?.nonce;
  let lastFees: Fees | undefined = tracked?.lastFees;
  const minedOne = async (): Promise<TransactionReceipt | null> => {
    for (const h of hashes) {
      const r = await client.getTransactionReceipt({ hash: h }).catch((err: unknown) => {
        if (err instanceof TransactionReceiptNotFoundError) return null;
        throw err;
      });
      if (r) {
        sender.mined?.(r.transactionHash); // a tracking sender settles its outstanding transaction
        return r;
      }
    }
    return null;
  };
  for (let round = 0; ; round++) {
    const current = hashes[hashes.length - 1];
    // Plan 4.5 Task 10 re-review (M1): one round polls the receipts of every hash sent so far -- the original can
    // still be mined while the wait is on its replacement (viem's waitForTransactionReceipt watches one hash).
    const roundEnd = Math.min(Date.now() + timeoutMs, opts.giveUpAt ?? Number.POSITIVE_INFINITY);
    for (let poll = 0; ; poll++) {
      const mined = await minedOne();
      if (mined) return mined;
      const left = roundEnd - Date.now();
      if (left <= 0) break;
      // Quick first polls (a transaction is usually mined within a block or two), then every `pollMs`.
      await new Promise((r) => setTimeout(r, Math.min(pollMs, 50 * 2 ** poll, left)));
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
      throw new TxDroppedError(current, nonce, lastFees);
    }
    nonce ??= pending.nonce;
    lastFees = feesOf(pending as unknown as Fees);
    if (pending.blockNumber !== null) {
      // mined between the two reads: its receipt is there now
      const r = await minedOne();
      if (r) return r;
      continue;
    }
    if (opts.giveUpAt !== undefined && Date.now() >= opts.giveUpAt) throw new TxStuckError(hashes, true, nonce, lastFees);
    if (!canReplace) {
      // A sender that cannot honour nonce/fee overrides: never replace, only wait (bounded) and report.
      if (round < maxReplacements) continue;
      throw new TxStuckError(hashes, false, nonce, lastFees);
    }
    if (round >= maxReplacements) {
      // A replacement send that failed (e.g. it reverted in gas estimation) explains best why we are stuck; the
      // caller classifies it (HubClient.write maps an execution revert to HubRevertError, like the original send).
      if (lastSendError !== undefined) throw lastSendError;
      throw new TxStuckError(hashes, false, nonce, lastFees);
    }
    // Plan 4.5 Task 10 re-review (M2): priced against the node's estimate in the same style (legacy or EIP-1559).
    const replacement: TxRequest = {
      ...req,
      nonce: pending.nonce,
      gas: (pending as { gas?: bigint }).gas,
      ...replacementFees(lastFees, await estimateLike(client, lastFees)),
    };
    try {
      hashes.push(await sender.send(replacement));
      lastSendError = undefined; // a later replacement went out: an earlier one's failure no longer explains anything
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
