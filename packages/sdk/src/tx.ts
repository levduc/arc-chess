import {
  BaseError,
  ExecutionRevertedError,
  InsufficientFundsError,
  NonceTooLowError,
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
  type WalletClient,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";

/** A transaction to send. `nonce`, the fee fields and `gas` are overrides. A `TxSender` MUST honour them; one that
 *  cannot MUST declare `supportsReplacement = false` (see `TxSender`), and is then never asked to replace anything.
 *
 *  Plan 4.5 Task 10 round 4: callers send new intents **without** a nonce -- a tracking `SerialTxSender` picks it.
 *  An explicit `nonce` is how `waitOrReplace` replaces its own pending transaction (the same intent, at the same
 *  nonce, with higher fees). */
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

/**
 * Sends a transaction from some wallet (spec §3.1). Implementations: local key (v1), Circle CLI (Plan 6).
 *
 * Contract (Plan 4.5 Task 10 re-review I3): `send` MUST honour `TxRequest.nonce` and the fee overrides -- a stuck
 * transaction is replaced by sending again at its nonce with higher fees. A sender that cannot MUST declare
 * `supportsReplacement = false`: `waitOrReplace` then never replaces its transactions, it only waits (bounded) and
 * reports.
 */
export interface TxSender {
  readonly address: Address;
  /** False if `send` cannot honour the nonce/fee overrides (default: true). */
  readonly supportsReplacement?: boolean;
  send(tx: TxRequest): Promise<Hex>;
  /** Optional (round 5, I2): signs `tx` (nonce, gas and fees set) without sending it, so a tracking sender knows the
   *  hash before the send -- a transaction whose send response is lost is still tracked by its hash. Both this and
   *  `sendRawTransaction`, or neither. */
  signTransaction?(tx: TxRequest): Promise<Hex>;
  /** Sends a transaction signed by `signTransaction`; resolves with its hash. */
  sendRawTransaction?(raw: Hex): Promise<Hex>;
  /** A tracking sender's per-nonce bookkeeping, driven by `waitOrReplace` (see SerialTxSender). */
  readonly tracker?: TxTracker;
}

/** A transaction's fee fields (EIP-1559 or legacy). */
export type Fees = { maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint; gasPrice?: bigint };

/**
 * One nonce a tracking sender has used and not yet seen mined. `hashes` holds every transaction sent at it -- the
 * intent now waiting and, after a replacement of a released entry, the earlier intent it replaced. `waiting`: a
 * receipt wait owns it (no other intent may touch it). `released`: its wait ended without success (stuck, dropped,
 * aborted, gave up), so the next send from this key replaces it.
 */
export type TrackedTx = { nonce: number; lastFees: Fees; hashes: Hex[]; state: "waiting" | "released"; gas?: bigint };

/** What `waitOrReplace` tells a tracking sender about the entry holding the hash it waits on. */
export interface TxTracker {
  entryOf(hash: Hex): TrackedTx | undefined;
  /** Fees the node reports for one of the entry's transactions (so its `lastFees` is never unknown). */
  observed(hash: Hex, fees: Fees): void;
  /** Its nonce is used (a receipt was found, ours or an earlier intent's): the entry is removed. */
  settle(hash: Hex): void;
  /** Its wait ended without success: the next send replaces it. */
  release(hash: Hex): void;
}

/**
 * Sends from a local private key. Used for participant wallets on Anvil and, with a channel's session key,
 * as the session-key sender for dispute transactions (spec §3.1 SessionKeyTxSender).
 */
export class LocalKeyTxSender implements TxSender {
  private readonly account: PrivateKeyAccount;
  private readonly wallet: WalletClient;
  /** A read client on the same RPC (a SerialTxSender around this one uses it to track its transactions). */
  readonly reader: PublicClient;

  constructor(privateKey: Hex, rpcUrl: string, private readonly chain: Chain) {
    this.account = privateKeyToAccount(privateKey);
    this.wallet = createWalletClient({ account: this.account, chain, transport: http(rpcUrl) });
    this.reader = createPublicClient({ chain, transport: http(rpcUrl) }) as PublicClient;
  }

  get address(): Address {
    return this.account.address;
  }

  /** Signs locally (round 5, I2). Needs `nonce` and `gas`; fees default to the node's estimate. */
  async signTransaction(tx: TxRequest): Promise<Hex> {
    if (tx.nonce === undefined || tx.gas === undefined) throw new Error("signTransaction needs a nonce and a gas limit");
    const base = { chainId: this.chain.id, to: tx.to, data: tx.data, value: tx.value, gas: tx.gas, nonce: tx.nonce };
    if (tx.gasPrice !== undefined) return this.account.signTransaction({ ...base, type: "legacy", gasPrice: tx.gasPrice });
    const fees =
      tx.maxFeePerGas !== undefined
        ? { maxFeePerGas: tx.maxFeePerGas, maxPriorityFeePerGas: tx.maxPriorityFeePerGas ?? 0n }
        : ((await this.reader.estimateFeesPerGas()) as { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint });
    return this.account.signTransaction({ ...base, type: "eip1559", ...fees });
  }

  sendRawTransaction(raw: Hex): Promise<Hex> {
    return this.wallet.sendRawTransaction({ serializedTransaction: raw });
  }

  async send(tx: TxRequest): Promise<Hex> {
    // Gas is estimated here, against the latest block, unless given (a SerialTxSender always gives it): some nodes
    // (Anvil) estimate against the pending block by default, which may hold a transaction this one replaces.
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

/** The reads a tracking `SerialTxSender` needs. */
export type TrackerClient = Pick<
  PublicClient,
  "getTransactionReceipt" | "getTransaction" | "getTransactionCount" | "estimateFeesPerGas" | "estimateGas" | "getBalance"
>;

// ------------------------------------------------------------------------------------ errors

/** A replacement of a released transaction found its nonce already used: it (or an earlier intent sent at it) has
 *  landed. Nothing was re-sent at a fresh nonce -- the caller re-reads the chain on its next pass. Also thrown by a
 *  wait whose nonce was taken by an earlier intent that landed instead of the one it waits for. */
export class TxNonceUsedError extends Error {
  constructor(
    readonly nonce: number,
    cause?: unknown,
  ) {
    super(`nonce ${nonce} is already used: an earlier transaction at it has landed`, { cause });
    this.name = "TxNonceUsedError";
  }
}

/** The fee needed to replace a transaction is over the sender's fee cap: nothing was sent. */
export class TxFeeCapError extends Error {
  constructor(
    readonly nonce: number,
    readonly cap: bigint,
    readonly needed?: bigint,
    cause?: unknown,
  ) {
    super(
      `replacing the transaction at nonce ${nonce} needs a fee over the cap of ${cap} wei per gas${needed !== undefined ? ` (needs ${needed})` : ""}: not sent`,
      { cause },
    );
    this.name = "TxFeeCapError";
  }
}

/** The sender's balance cannot pay for the transaction (value plus gas at the fee it needs): nothing was sent. */
export class TxInsufficientFundsError extends Error {
  constructor(
    readonly address: Address,
    cause?: unknown,
  ) {
    super(`${address} cannot pay for the transaction (value plus gas at the fee it needs): not sent`, { cause });
    this.name = "TxInsufficientFundsError";
  }
}

// ------------------------------------------------------------------------------------ fee cap

/** A replacement's fee is capped at this multiple of the node's current estimate (or the ceiling, if higher). */
export const FEE_CAP_MULTIPLIER = 4n;
/** Default `feeCeiling` (per gas): the cap is never below it, so a quiet chain still leaves room to bump. */
export const DEFAULT_FEE_CEILING_WEI = 100n * 10n ** 9n;
/** A `feeCeiling` that never binds: only the balance bound caps the fee. For session keys, whose dispute
 *  transactions (respond, timeout) must never be refused by a fee cap below what the key can pay (round 5). */
export const NO_FEE_CEILING = 2n ** 128n;

export type SerialTxSenderOptions = {
  /** The cap is max(FEE_CAP_MULTIPLIER x the current estimate, feeCeiling) per gas, on both fee fields. */
  feeCeiling?: bigint;
};

type Entry = { nonce: number; lastFees: Fees; hashes: Set<Hex>; state: "waiting" | "released"; gas?: bigint };

/**
 * The per-key nonce and transaction manager (Plan 4.5 Task 10 round 4). Sends run one at a time, and each nonce
 * this key uses and has not yet seen mined is tracked (`TrackedTx`) until its wait ends:
 *
 * - **No pre-emption.** A new intent never touches a nonce whose wait is still active; it takes the next nonce.
 * - **No abandonment.** Once a wait gives up (stuck, dropped, aborted, deadline), its entry is `released` and the
 *   next send from this key replaces it at its nonce, fees raised -- a timeout replaces a stuck respond instead of
 *   queueing behind it, and a re-sent top-up replaces its own stuck copy.
 * - **At most once.** A replacement that finds its nonce used throws `TxNonceUsedError` and is never re-sent at a
 *   fresh nonce: whatever was at that nonce landed, and the caller re-reads the chain first.
 * - **Bounded fees.** No transaction goes over max(4 x the current estimate, `feeCeiling`) per gas, nor over what
 *   the balance can pay (`(balance - value) / gas`). A replacement that would need more is not sent.
 * - **Restart.** A fresh sender that finds a pending transaction on its key (none tracked, pending count above the
 *   confirmed one) adopts the lowest such nonce as released and replaces it.
 *
 * Tracking needs a read client: `reader`, or the inner sender's own (`LocalKeyTxSender.reader`). Without one, or
 * for an inner sender that declares `supportsReplacement = false`, sends are only serialized.
 */
export class SerialTxSender implements TxSender, TxTracker {
  private tail: Promise<unknown> = Promise.resolve();
  private readonly entries = new Map<number, Entry>();
  private readonly reader: TrackerClient | undefined;
  /** max(4 x the estimate, this) caps every fee this sender pays (see SerialTxSenderOptions). */
  readonly feeCeiling: bigint;

  constructor(
    private readonly inner: TxSender,
    reader?: TrackerClient,
    opts: SerialTxSenderOptions = {},
  ) {
    this.reader = reader ?? (inner as { reader?: TrackerClient }).reader;
    this.feeCeiling = opts.feeCeiling ?? DEFAULT_FEE_CEILING_WEI;
  }

  get address(): Address {
    return this.inner.address;
  }
  get supportsReplacement(): boolean | undefined {
    return this.inner.supportsReplacement;
  }
  get tracker(): TxTracker | undefined {
    return this.tracking ? this : undefined;
  }
  private get tracking(): boolean {
    return this.reader !== undefined && this.inner.supportsReplacement !== false;
  }

  /** Every tracked nonce, lowest first (for tests and tooling). */
  tracked(): TrackedTx[] {
    return [...this.entries.values()].sort((a, b) => a.nonce - b.nonce).map(snapshot);
  }

  /** Serialized: a nonce is never picked twice. */
  send(tx: TxRequest): Promise<Hex> {
    const run = this.tail.then(() => this.sendNow(tx));
    this.tail = run.catch(() => undefined);
    return run;
  }

  // --- TxTracker (driven by waitOrReplace)

  entryOf(hash: Hex): TrackedTx | undefined {
    const e = this.find(hash);
    return e ? snapshot(e) : undefined;
  }
  observed(hash: Hex, fees: Fees): void {
    const e = this.find(hash);
    if (e && hasFees(fees)) e.lastFees = maxFees(e.lastFees, fees);
  }
  settle(hash: Hex): void {
    const e = this.find(hash);
    if (!e) return;
    this.entries.delete(e.nonce);
    this.markMined(e.nonce);
  }
  release(hash: Hex): void {
    const e = this.find(hash);
    if (e) e.state = "released";
  }
  private find(hash: Hex): Entry | undefined {
    for (const e of this.entries.values()) if (e.hashes.has(hash)) return e;
    return undefined;
  }

  // --- sending

  private async sendNow(tx: TxRequest): Promise<Hex> {
    const reader = this.reader;
    if (!reader || !this.tracking) return this.inner.send(tx);
    if (tx.nonce !== undefined) return this.replaceOwn(reader, tx, tx.nonce);
    const { confirmed, pending } = await this.prune(reader);
    // Adoption (round 5, C1): a pending nonce no entry tracks holds a transaction no wait of ours owns -- left by an
    // earlier run of this key's sender (a restart). The lowest such nonce is adopted as released, whatever else is
    // tracked, so a stuck one is replaced instead of blocking every nonce above it.
    for (let n = confirmed; n < pending; n++) {
      if (this.entries.has(n)) continue;
      this.entries.set(n, { nonce: n, lastFees: {}, hashes: new Set(), state: "released" });
      break;
    }
    const released = this.lowestReleased();
    if (released) return this.replaceReleased(reader, tx, released);
    return this.sendFresh(reader, tx);
  }

  private lowestReleased(except?: Entry): Entry | undefined {
    return [...this.entries.values()].filter((e) => e.state === "released" && e !== except).sort((a, b) => a.nonce - b.nonce)[0];
  }

  /** Nonces below this are known used (a receipt was seen for a transaction at them). */
  private minedBelow = 0;
  private markMined(nonce: number): void {
    if (nonce + 1 > this.minedBelow) this.minedBelow = nonce + 1;
  }

  /**
   * Drops every entry that is mined (its nonce is below the confirmed count, or one of its hashes has a receipt), and
   * returns the counts. The confirmed count is read after the pending one, and never below a nonce this sender has
   * seen mined, so a transaction of ours mined meanwhile (or behind a lagging count) is never taken for one left
   * pending.
   */
  private async prune(reader: TrackerClient): Promise<{ confirmed: number; pending: number }> {
    const pending = await reader.getTransactionCount({ address: this.address, blockTag: "pending" });
    const latest = await reader.getTransactionCount({ address: this.address, blockTag: "latest" });
    for (const e of [...this.entries.values()]) {
      if (e.nonce < Math.max(latest, this.minedBelow)) {
        this.entries.delete(e.nonce);
        continue;
      }
      for (const h of e.hashes) {
        const r = await reader.getTransactionReceipt({ hash: h }).catch(() => null);
        if (r) {
          this.entries.delete(e.nonce);
          this.markMined(e.nonce);
          break;
        }
      }
      // Round 5 (I1): a released transaction the node no longer holds (dropped, or the pool was flushed) has no
      // price to outbid. Its last fees are forgotten, so the next send at its nonce is priced from the market --
      // not bumped over fees that may already sit at the cap.
      if (this.entries.get(e.nonce) === e && e.state === "released" && hasFees(e.lastFees)) {
        if (pending <= e.nonce || !(await this.knowsAny(reader, e))) e.lastFees = {};
      }
    }
    return { confirmed: Math.max(latest, this.minedBelow), pending };
  }

  private async knowsAny(reader: TrackerClient, e: Entry): Promise<boolean> {
    for (const h of e.hashes) {
      const t = await reader.getTransaction({ hash: h }).catch(() => null);
      if (t) return true;
    }
    return false;
  }

  /** A new intent at a nonce nobody tracks: max(the pending count, the highest tracked nonce + 1). */
  private async sendFresh(reader: TrackerClient, tx: TxRequest): Promise<Hex> {
    const next = () => {
      const top = Math.max(-1, ...this.entries.keys());
      return reader.getTransactionCount({ address: this.address, blockTag: "pending" }).then((p) => Math.max(p, top + 1));
    };
    let nonce = await next();
    // Against pending: a new intent may depend on one of ours still pending (a deposit on its approve).
    const gas = tx.gas ?? (await this.estimateGas(reader, tx, "pending"));
    const estimate = this.noted(await estimateFees(reader));
    const room = await this.room(reader, estimate, gas, tx.value ?? 0n);
    if (feeOf(estimate) > room.balance) throw new TxInsufficientFundsError(this.address);
    const fees = clampFees(estimate, room.cap);
    for (let attempt = 0; ; attempt++) {
      // Round 5 (m2): a wait may have released an entry while this send was being prepared (its release runs outside
      // this mutex): replace that one instead of going fresh behind it.
      const released = this.lowestReleased();
      if (released) return this.replaceReleased(reader, tx, released);
      // Round 5 (I2): recorded before the send, so a transaction the node took although its response was lost is
      // still tracked (released, at its nonce, with its fees and -- when signed locally -- its hash).
      const e: Entry = { nonce, lastFees: fees, hashes: new Set(), state: "waiting", gas };
      this.entries.set(nonce, e);
      const r = await this.transmit(reader, { ...tx, nonce, gas, ...fees });
      if (r.hash) e.hashes.add(r.hash);
      if (r.err === undefined) return r.hash!;
      const err = r.err;
      // A pure count race (another sender on this key, a lagging count): retried once, at the next nonce.
      if (attempt === 0 && isNonceUsedError(err)) {
        this.entries.delete(nonce);
        this.markMined(nonce);
        nonce = Math.max(await next(), nonce + 1);
        continue;
      }
      if (isDefinitive(err)) this.entries.delete(nonce); // refused: nothing is pending at that nonce
      else e.state = "released"; // it may be pending: the next send replaces it
      throw this.classify(err);
    }
  }

  /**
   * Sends `req` (nonce, gas and fees set). When the inner sender can sign locally, the hash is known before the send
   * (round 5, I2). A failed send whose transaction the node nevertheless holds (a lost response, or a transport
   * retry of a send that went through, refused as "nonce too low" / "already known") is a success.
   */
  private async transmit(reader: TrackerClient, req: TxRequest): Promise<{ hash?: Hex; err?: unknown }> {
    const inner = this.inner;
    let raw: Hex | undefined;
    let hash: Hex | undefined;
    if (inner.signTransaction && inner.sendRawTransaction) {
      raw = await inner.signTransaction(req);
      hash = keccak256(raw);
    }
    try {
      return { hash: raw ? await inner.sendRawTransaction!(raw) : await inner.send(req) };
    } catch (err) {
      if (hash && (await reader.getTransaction({ hash }).then(() => true, () => false))) return { hash };
      return { hash, err };
    }
  }

  /**
   * A new intent replacing a released entry at its nonce. Priced over its last fees (bump) and at least the node's
   * estimate -- or, for an adopted entry whose fees are unknown, at 2x the estimate, raised 50 % on each
   * "underpriced" -- never over the cap. A nonce-used error deletes the entry: `TxNonceUsedError`, nothing more is
   * sent.
   */
  private async replaceReleased(reader: TrackerClient, tx: TxRequest, e: Entry): Promise<Hex> {
    const known = hasFees(e.lastFees);
    const estimate = this.noted(known ? await estimateLike(reader, e.lastFees) : await estimateFees(reader));
    // New calldata: estimated against latest (the pending state holds the transaction being replaced).
    const gas = tx.gas ?? (await this.estimateGas(reader, tx, "latest"));
    const room = await this.room(reader, estimate, gas, tx.value ?? 0n);
    let fees = known ? replacementFees(e.lastFees, estimate) : doubled(estimate!);
    if (known) this.affordable(e.nonce, bumpFees(e.lastFees), room);
    else this.affordable(e.nonce, estimate!, room);
    fees = clampFees(fees, bigMin(room.cap, room.balance));
    for (;;) {
      const r = await this.transmit(reader, { ...tx, nonce: e.nonce, gas, ...fees });
      if (r.err === undefined) {
        e.hashes.add(r.hash!);
        e.lastFees = fees;
        e.state = "waiting";
        e.gas = gas;
        return r.hash!;
      }
      const err = r.err;
      if (isNonceUsedError(err)) {
        this.entries.delete(e.nonce);
        this.markMined(e.nonce);
        throw new TxNonceUsedError(e.nonce, err);
      }
      if (!isDefinitive(err)) {
        // Round 5 (I2): it may be pending -- still released, now with this attempt's hash and fees.
        if (r.hash) e.hashes.add(r.hash);
        e.lastFees = maxFees(e.lastFees, fees);
        e.gas = gas;
        throw err;
      }
      if (!isUnderpriced(err)) throw this.classify(err);
      // The pool holds a transaction priced above what we know: +50 %, up to the cap.
      const limit = bigMin(room.cap, room.balance);
      const raised = clampFees(raise(fees, 3n, 2n), limit);
      if (feeOf(raised) <= feeOf(fees)) {
        throw limit < room.cap ? new TxInsufficientFundsError(this.address, err) : new TxFeeCapError(e.nonce, room.cap, undefined, err);
      }
      fees = raised;
    }
  }

  /** `waitOrReplace` replacing its own transaction (the same intent, at the same nonce), capped. */
  private async replaceOwn(reader: TrackerClient, tx: TxRequest, nonce: number): Promise<Hex> {
    const e = this.entries.get(nonce);
    if (!e) {
      // A nonce nobody tracks: sent as asked, but capped too (round 5, m4).
      const est = this.noted(await estimateLike(reader, feesOf(tx)));
      const g = tx.gas ?? (await this.estimateGas(reader, tx, "latest"));
      const r = await this.room(reader, est, g, tx.value ?? 0n);
      const asked = hasFees(feesOf(tx)) ? feesOf(tx) : (est ?? {});
      return this.inner.send({ ...tx, gas: g, ...clampFees(asked, bigMin(r.cap, r.balance)) });
    }
    const estimate = this.noted(await estimateLike(reader, e.lastFees));
    const gas = tx.gas ?? e.gas ?? (await this.estimateGas(reader, tx, "latest"));
    const room = await this.room(reader, estimate, gas, tx.value ?? 0n);
    const asked = hasFees(feesOf(tx)) ? feesOf(tx) : replacementFees(e.lastFees, estimate);
    // Round 5 (m5): never below bump(lastFees), whatever the wait asked for -- the pool would refuse it.
    const wanted = hasFees(e.lastFees) ? maxFees(asked, bumpFees(e.lastFees)) : asked;
    if (hasFees(e.lastFees)) this.affordable(nonce, bumpFees(e.lastFees), room);
    const fees = clampFees(wanted, bigMin(room.cap, room.balance));
    const r = await this.transmit(reader, { ...tx, gas, ...fees });
    if (r.err === undefined || !isDefinitive(r.err)) {
      // Sent -- or maybe sent (round 5, I2): either way the wait polls it from now on.
      if (r.hash) e.hashes.add(r.hash);
      e.lastFees = maxFees(e.lastFees, fees);
      e.gas = gas;
    }
    if (r.err === undefined) return r.hash!;
    // A used nonce is left to the wait: its receipt re-check tells its own transaction from an earlier intent's.
    throw this.classify(r.err);
  }

  /** The last fee estimate the node gave this sender (round 5, m7). */
  private lastEstimate: Fees | undefined;
  private noted<T extends Fees | undefined>(estimate: T): T {
    if (estimate && hasFees(estimate)) this.lastEstimate = estimate;
    return estimate;
  }

  /** The fee cap, and the most per gas the balance can pay for this transaction. */
  private async room(reader: TrackerClient, estimate: Fees | undefined, gas: bigint, value: bigint): Promise<{ cap: bigint; balance: bigint }> {
    // Round 5 (m7): a failed estimate falls back to the last one this sender saw; with none at all, no market cap
    // applies to this attempt (the balance bound still does).
    const known = estimate ?? this.lastEstimate;
    const cap = known ? bigMax(feeOf(known) * FEE_CAP_MULTIPLIER, this.feeCeiling) : NO_FEE_CEILING;
    const funds = await reader.getBalance({ address: this.address });
    const balance = funds > value && gas > 0n ? (funds - value) / gas : 0n;
    return { cap, balance };
  }

  /** Throws unless `needed` fits under the cap (TxFeeCapError) and the balance (TxInsufficientFundsError). */
  private affordable(nonce: number, needed: Fees, room: { cap: bigint; balance: bigint }): void {
    const fee = feeOf(needed);
    if (fee > room.cap) throw new TxFeeCapError(nonce, room.cap, fee);
    if (fee > room.balance) throw new TxInsufficientFundsError(this.address);
  }

  private estimateGas(reader: TrackerClient, tx: TxRequest, blockTag: "latest" | "pending"): Promise<bigint> {
    return reader.estimateGas({ account: this.address, to: tx.to, data: tx.data, value: tx.value, blockTag });
  }

  private classify(err: unknown): unknown {
    return isInsufficientFundsError(err) ? new TxInsufficientFundsError(this.address, err) : err;
  }
}

// ------------------------------------------------------------------------------------ fee helpers

/** True for a send refused because its nonce is already used: viem's NonceTooLowError, or the node's own words
 *  (Anvil: "nonce too low"; geth: "nonce too low" / "already known" differs -- only the used-nonce forms count). */
export function isNonceUsedError(err: unknown): boolean {
  if (err instanceof BaseError && err.walk((e) => e instanceof NonceTooLowError)) return true;
  return /nonce too low|nonce (has )?already (been )?used|lower than the current nonce/i.test(errorText(err));
}

/** True for a send refused because the account cannot pay for it. */
export function isInsufficientFundsError(err: unknown): boolean {
  if (err instanceof BaseError && err.walk((e) => e instanceof InsufficientFundsError)) return true;
  return /insufficient funds/i.test(errorText(err));
}

/** True for a send the node definitely refused (nothing of it can be pending): a used nonce, underpriced, not
 *  affordable, or reverted. Anything else (a transport failure, a timeout, an unknown error) may have reached the
 *  node, so the transaction is treated as possibly pending (round 5, I2). */
function isDefinitive(err: unknown): boolean {
  return (
    isNonceUsedError(err) ||
    isUnderpriced(err) ||
    isInsufficientFundsError(err) ||
    (err instanceof BaseError && err.walk((e) => e instanceof ExecutionRevertedError) !== null) ||
    /execution reverted/i.test(errorText(err))
  );
}

/** True for a replacement refused because it does not outbid the transaction the pool holds at its nonce. */
function isUnderpriced(err: unknown): boolean {
  return /underpriced|fee too low|replacement transaction/i.test(errorText(err));
}

function errorText(err: unknown): string {
  return err instanceof BaseError ? `${err.message} ${err.details}` : err instanceof Error ? err.message : String(err);
}

function feesOf(x: Fees): Fees {
  if (x.maxFeePerGas !== undefined && x.maxFeePerGas !== null) {
    return { maxFeePerGas: x.maxFeePerGas, maxPriorityFeePerGas: x.maxPriorityFeePerGas ?? 0n };
  }
  if (x.gasPrice !== undefined && x.gasPrice !== null) return { gasPrice: x.gasPrice };
  return {};
}

const hasFees = (f: Fees) => f.maxFeePerGas !== undefined || f.gasPrice !== undefined;
/** The fee per gas a transaction may pay at most (maxFeePerGas, or a legacy gasPrice). */
const feeOf = (f: Fees) => f.maxFeePerGas ?? f.gasPrice ?? 0n;
const bigMax = (a: bigint, b: bigint) => (a > b ? a : b);
const bigMin = (a: bigint, b: bigint) => (a < b ? a : b);

/** The node's current fee estimate in the same style (EIP-1559 or legacy) as `like`; undefined if it fails. */
async function estimateLike(client: Pick<PublicClient, "estimateFeesPerGas">, like: Fees): Promise<Fees | undefined> {
  const legacy = like.gasPrice !== undefined && like.maxFeePerGas === undefined;
  const args = (legacy ? { type: "legacy" } : undefined) as Parameters<PublicClient["estimateFeesPerGas"]>[0];
  return (await client.estimateFeesPerGas(args).catch(() => undefined)) as Fees | undefined;
}

/** The node's current estimate for a new transaction: EIP-1559, or legacy on a chain without it. */
async function estimateFees(client: Pick<PublicClient, "estimateFeesPerGas">): Promise<Fees> {
  try {
    return feesOf((await client.estimateFeesPerGas()) as Fees);
  } catch (err) {
    if (!(err instanceof BaseError && err.name === "Eip1559FeesNotSupportedError")) throw err;
    return feesOf((await client.estimateFeesPerGas({ type: "legacy" } as Parameters<PublicClient["estimateFeesPerGas"]>[0])) as Fees);
  }
}

/** `x` raised by at least 12.5 % (and by at least 1 wei), rounded up. */
function bump(x: bigint): bigint {
  const raised = (x * 1125n + 999n) / 1000n;
  return raised > x ? raised : x + 1n;
}

const max = (a: bigint, b: bigint | undefined) => (b !== undefined && b > a ? b : a);

/** The least a same-nonce replacement must pay over `last`. */
function bumpFees(last: Fees): Fees {
  if (last.maxFeePerGas !== undefined) return { maxFeePerGas: bump(last.maxFeePerGas), maxPriorityFeePerGas: bump(last.maxPriorityFeePerGas ?? 0n) };
  return last.gasPrice !== undefined ? { gasPrice: bump(last.gasPrice) } : {};
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

/** `f` scaled by num/den (rounded up), both fields. */
function raise(f: Fees, num: bigint, den: bigint): Fees {
  const up = (x: bigint) => (x * num + den - 1n) / den;
  if (f.maxFeePerGas !== undefined) return { maxFeePerGas: up(f.maxFeePerGas), maxPriorityFeePerGas: up(f.maxPriorityFeePerGas ?? 0n) };
  return f.gasPrice !== undefined ? { gasPrice: up(f.gasPrice) } : {};
}

const doubled = (f: Fees) => raise(f, 2n, 1n);

/** `f` with every field at most `cap` (and the priority fee at most the max fee). */
function clampFees(f: Fees, cap: bigint): Fees {
  if (f.maxFeePerGas !== undefined) {
    const m = bigMin(f.maxFeePerGas, cap);
    return { maxFeePerGas: m, maxPriorityFeePerGas: bigMin(bigMin(f.maxPriorityFeePerGas ?? 0n, cap), m) };
  }
  return f.gasPrice !== undefined ? { gasPrice: bigMin(f.gasPrice, cap) } : {};
}

/** The higher of two fee sets, field by field (in `a`'s style when both are known). */
function maxFees(a: Fees, b: Fees): Fees {
  if (!hasFees(a)) return feesOf(b);
  if (a.maxFeePerGas !== undefined && b.maxFeePerGas !== undefined) {
    return { maxFeePerGas: bigMax(a.maxFeePerGas, b.maxFeePerGas), maxPriorityFeePerGas: bigMax(a.maxPriorityFeePerGas ?? 0n, b.maxPriorityFeePerGas ?? 0n) };
  }
  if (a.gasPrice !== undefined && b.gasPrice !== undefined) return { gasPrice: bigMax(a.gasPrice, b.gasPrice) };
  return a;
}

function snapshot(e: Entry): TrackedTx {
  return { nonce: e.nonce, lastFees: { ...e.lastFees }, hashes: [...e.hashes], state: e.state, ...(e.gas !== undefined ? { gas: e.gas } : {}) };
}

// ------------------------------------------------------------------------------------ bounded receipt waits

/** Plan 4.5 Task 10 review: the default bound on one receipt wait (viem's own default is 180 s). */
export const RECEIPT_TIMEOUT_MS = 30_000;
/** At most this many same-nonce replacements of one stuck transaction before `TxStuckError`. */
export const MAX_REPLACEMENTS = 3;
/** How often a receipt wait polls the receipts of the transactions it has sent. */
export const RECEIPT_POLL_MS = 1_000;
/** A transaction the node reports mined whose receipt stays unreadable this many rounds is treated as mined. */
export const LAGGING_RECEIPT_ROUNDS = 3;

/** The transaction is no longer known to the node (dropped from the mempool, or reorged out and discarded) and was
 *  never mined: the caller should re-evaluate and, if still needed, send it again. */
export class TxDroppedError extends Error {
  /** `nonce` / `lastFees`: what it was last sent at, when known. A tracking SerialTxSender releases it, so the next
   *  send from that key goes out at that nonce with higher fees -- if it was not really dropped (a lagging or
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

/** The wait was aborted (its `signal`, e.g. a daemon stopping): nothing more is sent or awaited. A tracking
 *  SerialTxSender releases the transaction, so the next send from that key replaces it. */
export class TxWaitAbortedError extends Error {
  constructor(
    readonly hashes: Hex[],
    readonly nonce?: number,
    readonly lastFees?: Fees,
  ) {
    super(`stopped waiting for transaction ${hashes.at(-1)}`);
    this.name = "TxWaitAbortedError";
  }
}

/** The node says the transaction was mined (block `blockNumber`) but has not served its receipt for
 *  `LAGGING_RECEIPT_ROUNDS` rounds: it is treated as mined, and the caller re-reads the chain on its next pass. */
export class TxReceiptMissingError extends Error {
  constructor(
    readonly hash: Hex,
    readonly blockNumber: bigint,
    readonly nonce?: number,
  ) {
    super(`transaction ${hash} was mined in block ${blockNumber} but its receipt could not be read`);
    this.name = "TxReceiptMissingError";
  }
}

/** The subset of a viem PublicClient `waitOrReplace` uses (tests pass a stub). */
export type ReceiptClient = Pick<
  PublicClient,
  "getTransaction" | "getTransactionReceipt" | "estimateFeesPerGas"
>;

/**
 * Plan 4.5 Task 10 review: waits for `hash` (sent by `sender` as `req`) at most `timeoutMs` per round, instead of
 * viem's 180 s default. After each round:
 * - if any transaction sent at its nonce has been mined, its receipt is returned -- unless it is an earlier intent's
 *   (the one a tracking sender replaced with this one), which is `TxNonceUsedError`: this intent did not land;
 * - if the node no longer knows the transaction, `TxDroppedError` (the caller re-evaluates and resends);
 * - if it is still pending, it is replaced at the same nonce with fees raised by at least 12.5 % (and at least to
 *   the node's current estimate), through the same `sender` -- up to `maxReplacements` times, then `TxStuckError`.
 *   A tracking sender caps the fee: a replacement it cannot afford is not sent, and the wait goes on.
 *
 * Round 4: with a tracking sender, the wait owns its entry for its whole duration. It deletes it on success and
 * releases it on every other exit, so the next send from that key replaces it (never queues behind it). Every exit
 * is bounded by `giveUpAt`, `maxReplacements` or `signal`.
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
    /** The nonce `hash` was sent at, when the caller knows it (a tracking sender knows it itself). */
    nonce?: number;
    /** Wall-clock ms (Plan 4.5 Task 10 re-review I2): no replacement is sent and no wait runs past it -- e.g. a
     *  respond's dispute deadline, after which the transaction can no longer help. */
    giveUpAt?: number;
    /** Aborts the wait (Plan 4.5 Task 10 re-review 2): e.g. a daemon's stop() must not wait out a 30 s round. */
    signal?: AbortSignal;
  } = {},
): Promise<TransactionReceipt> {
  const timeoutMs = opts.timeoutMs ?? RECEIPT_TIMEOUT_MS;
  const pollMs = opts.pollMs ?? RECEIPT_POLL_MS;
  const maxReplacements = opts.maxReplacements ?? MAX_REPLACEMENTS;
  const tracker = sender.tracker;
  /** This intent's transactions: the original and our replacements of it. */
  const hashes: Hex[] = [hash];
  /** Every transaction at this nonce: ours, and the earlier intent's a tracking sender replaced with this one. */
  const known = new Set<Hex>([hash]);
  const sync = () => {
    const e = tracker?.entryOf(hash);
    if (e) for (const h of e.hashes) known.add(h);
    return e;
  };
  const tracked = sync();
  let nonce = opts.nonce ?? tracked?.nonce;
  let lastFees: Fees | undefined = tracked && hasFees(tracked.lastFees) ? tracked.lastFees : undefined;
  let lastSendError: unknown;
  let lagging = 0;
  let succeeded = false;
  const canReplace = sender.supportsReplacement !== false;
  const lookup = (h: Hex) =>
    client.getTransaction({ hash: h }).catch((err: unknown) => {
      if (err instanceof TransactionNotFoundError) return null;
      throw err;
    });
  const minedOne = async (): Promise<TransactionReceipt | null> => {
    sync();
    for (const h of known) {
      const r = await client.getTransactionReceipt({ hash: h }).catch((err: unknown) => {
        if (err instanceof TransactionReceiptNotFoundError) return null;
        throw err;
      });
      if (!r) continue;
      tracker?.settle(hash); // the nonce is used either way
      if (hashes.includes(h)) {
        succeeded = true;
        return r;
      }
      // An earlier intent at this nonce landed instead: this one never will. Its receipt is not ours to report.
      throw new TxNonceUsedError(nonce ?? tracked?.nonce ?? -1);
    }
    return null;
  };
  const aborted = () => opts.signal?.aborted === true;
  const pastGiveUp = () => opts.giveUpAt !== undefined && Date.now() >= opts.giveUpAt;
  /** Sleeps `ms`, or less if the signal aborts meanwhile. */
  const nap = (ms: number) =>
    new Promise<void>((resolve) => {
      if (aborted()) return resolve();
      const done = () => {
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      opts.signal?.addEventListener("abort", done, { once: true });
    });
  try {
    for (let round = 0; ; round++) {
      const current = hashes[hashes.length - 1];
      // Plan 4.5 Task 10 re-review (M1): one round polls the receipts of every hash at this nonce -- the original
      // can still be mined while the wait is on its replacement (viem's waitForTransactionReceipt watches one hash).
      const roundEnd = Math.min(Date.now() + timeoutMs, opts.giveUpAt ?? Number.POSITIVE_INFINITY);
      for (let poll = 0; ; poll++) {
        const mined = await minedOne();
        if (mined) return mined;
        if (aborted()) throw new TxWaitAbortedError(hashes, nonce, lastFees);
        const left = roundEnd - Date.now();
        if (left <= 0) break;
        // Quick first polls (a transaction is usually mined within a block or two), then every `pollMs`.
        await nap(Math.min(pollMs, 50 * 2 ** poll, left));
      }
      // The newest of our transactions the node still knows (an older one may outlive a dropped replacement).
      let pending: Awaited<ReturnType<typeof lookup>> = null;
      for (const h of [...hashes].reverse()) {
        pending = await lookup(h);
        if (pending) break;
      }
      if (!pending) {
        // Plan 4.5 Task 10 re-review (I3): one more receipt check right before reporting a drop -- a transaction
        // mined between the two reads above is not dropped, and resending it would pay twice.
        const late = await minedOne();
        if (late) return late;
        throw new TxDroppedError(current, nonce, lastFees);
      }
      nonce ??= pending.nonce;
      const seen = feesOf(pending as unknown as Fees);
      if (hasFees(seen)) {
        // Round 4 (M3): the tracking sender learns every fee the node reports, so its lastFees is never unknown.
        tracker?.observed(pending.hash, seen);
        lastFees = sync()?.lastFees ?? seen;
      }
      if (pending.blockNumber !== null) {
        // Mined, but no receipt yet (a lagging receipt index). It counts as a round, and the wait's bounds apply.
        lagging++;
        const r = await minedOne();
        if (r) return r;
        if (aborted()) throw new TxWaitAbortedError(hashes, nonce, lastFees);
        // Round 5 (m1): at its give-up time too, a transaction the node reports mined is treated as mined.
        if (lagging >= LAGGING_RECEIPT_ROUNDS || pastGiveUp()) {
          tracker?.settle(hash); // treated as mined: the caller re-reads the chain on its next pass
          throw new TxReceiptMissingError(pending.hash, pending.blockNumber, nonce);
        }
        continue;
      }
      if (pastGiveUp()) throw new TxStuckError(hashes, true, nonce, lastFees);
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
      const base = lastFees ?? {};
      const replacement: TxRequest = {
        ...req,
        nonce: pending.nonce,
        gas: (pending as { gas?: bigint }).gas,
        ...replacementFees(base, await estimateLike(client, base)),
      };
      // Final review m1: the entry's hashes before this send. A send that fails ambiguously (a lost response) may
      // still have added its transaction to the entry; that one is ours too (see the catch below).
      const before = new Set(tracker?.entryOf(hash)?.hashes ?? []);
      try {
        const sent = await sender.send(replacement);
        hashes.push(sent);
        known.add(sent);
        lastSendError = undefined; // a later replacement went out: an earlier one's failure no longer explains anything
      } catch (err) {
        // Final review m1: a replacement the node may hold although its response was lost is recorded in the entry
        // (round 5, I2). It is this intent's own transaction, not an earlier intent's: if it lands, the wait returns
        // its receipt instead of reporting TxNonceUsedError for it.
        for (const h of tracker?.entryOf(hash)?.hashes ?? []) {
          if (!before.has(h) && !hashes.includes(h)) {
            hashes.push(h);
            known.add(h);
          }
        }
        // Round 4: the replacement would go over the fee cap or the balance: nothing was sent; keep waiting.
        if (err instanceof TxFeeCapError || err instanceof TxInsufficientFundsError) continue;
        // e.g. "nonce too low": the original (or an earlier intent at this nonce) was mined after all
        const r = await minedOne();
        if (r) return r;
        // Plan 4.5 Task 10 re-review (I1): nothing is mined, so the original is still pending -- keep waiting on the
        // hashes already sent rather than failing a transaction that may still land.
        lastSendError = err;
      }
    }
  } finally {
    // Every exit but success releases the entry (a no-op once it is settled): the next send replaces it.
    if (!succeeded) tracker?.release(hash);
  }
}
