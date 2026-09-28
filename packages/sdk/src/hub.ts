import {
  BaseError,
  ExecutionRevertedError,
  decodeErrorResult,
  encodeFunctionData,
  erc20Abi,
  type Address,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
} from "viem";
import { channelHubAbi, mockUsdcAbi } from "./abi.js";
import { decodeParams, decodeSignedState, encodeParams, encodeProof, encodeSignedState } from "./abiCodec.js";
import type { TxSender } from "./tx.js";
import type { CloseTransaction, Params, PlayerIndex, Proof, SignedState, State } from "./types.js";

export const PHASE = ["None", "Funding", "Open", "Challenged", "Finalized", "Reclaimed"] as const;
export type Phase = (typeof PHASE)[number];

export type ChannelInfo = {
  phase: Phase;
  funded: readonly [boolean, boolean];
  hasRegistered: boolean;
  challenger: number;
  deadline: bigint;
  cooldownUntil: readonly [bigint, bigint];
  registeredHash: Hex;
};

export type DisputeEvent = {
  kind: "Challenged" | "Responded";
  blockNumber: bigint;
  logIndex: number;
  transactionHash: Hex;
  turnNum: bigint;
  signed: SignedState;
  challenger?: number;
  deadline?: bigint;
};

/** One hub event, for any channel, decoded from `getContractEvents` with `eventName` omitted (hubEvents). */
export type HubEvent = { blockNumber: bigint; logIndex: number; channelId: Hex } & (
  | { kind: "ChannelCreated"; params: Params }
  | { kind: "Deposited"; player: PlayerIndex; amount: bigint }
  | { kind: "Opened" }
  | { kind: "Challenged"; challenger: PlayerIndex; turnNum: bigint; deadline: bigint; signed: SignedState }
  | { kind: "Responded"; turnNum: bigint; signed: SignedState }
  | { kind: "Finalized"; balanceA: bigint; balanceB: bigint; fee: bigint }
  | { kind: "Reclaimed" }
);

/** Splits [fromBlock, toBlock] (inclusive) into consecutive chunks of at most `size` blocks each. */
export function chunkRanges(
  fromBlock: bigint,
  toBlock: bigint,
  size: bigint,
): Array<{ fromBlock: bigint; toBlock: bigint }> {
  if (size <= 0n) throw new RangeError("chunkRanges: size must be positive");
  const chunks: Array<{ fromBlock: bigint; toBlock: bigint }> = [];
  for (let from = fromBlock; from <= toBlock; from += size) {
    const to = from + size - 1n;
    chunks.push({ fromBlock: from, toBlock: to < toBlock ? to : toBlock });
  }
  return chunks;
}

/** A hub call that would revert; `errorName` is the decoded custom error (e.g. "BadSignature") when known. */
export class HubRevertError extends Error {
  constructor(
    readonly errorName: string | undefined,
    underlying: unknown,
  ) {
    super(
      errorName
        ? `hub reverted: ${errorName}`
        : `hub call failed: ${underlying instanceof Error ? underlying.message : String(underlying)}`,
      { cause: underlying },
    );
    this.name = "HubRevertError";
  }
}

const REVERT_ABI = [...channelHubAbi, ...mockUsdcAbi];

/** Extracts the custom-error name from a viem call/transaction error, if the revert data is decodable. */
export function decodeRevert(err: unknown): string | undefined {
  if (!(err instanceof BaseError)) return undefined;
  const withData = err.walk((e) => typeof (e as { data?: unknown }).data === "string") as { data?: Hex } | null;
  const data = withData?.data;
  if (!data || data === "0x") return undefined;
  try {
    // decodeErrorResult also matches the built-in Error(string)/Panic(uint256) selectors at runtime
    // (it appends them to the ABI internally), but its return type is narrowed to REVERT_ABI's own
    // error names, so we widen here rather than change the (correct) runtime behaviour.
    const decoded = decodeErrorResult({ abi: REVERT_ABI, data }) as { errorName: string; args?: readonly unknown[] };
    return decoded.errorName === "Error" ? String(decoded.args?.[0]) : decoded.errorName;
  } catch {
    return undefined;
  }
}

/**
 * True if an error thrown by `TxSender.send` is an execution revert, as opposed to a failure of the send itself.
 * Decodable revert data settles it. Without data, only the node's own message counts, and only if it says
 * "execution reverted": viem also classifies "gas required exceeds allowance" (the sender cannot pay for gas, not
 * a hub revert) as an ExecutionRevertedError, and its top-level message reads "Execution reverted with reason:
 * ..." either way -- so the raw node message (`details`, propagated up the cause chain) is what is tested.
 */
function isSendRevert(err: unknown): boolean {
  if (!(err instanceof BaseError)) return false;
  if (decodeRevert(err) !== undefined) return true;
  const reverted = err.walk((e) => e instanceof ExecutionRevertedError) as BaseError | null;
  return reverted !== null && /execution reverted/i.test(reverted.details ?? "");
}

export class HubClient {
  constructor(
    readonly hub: Address,
    readonly client: PublicClient,
  ) {}

  approve(sender: TxSender, token: Address, amount: bigint): Promise<TransactionReceipt> {
    return this.write(sender, token, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [this.hub, amount] }));
  }

  deposit(sender: TxSender, p: Params): Promise<TransactionReceipt> {
    return this.call(sender, encodeFunctionData({ abi: channelHubAbi, functionName: "deposit", args: [encodeParams(p)] }));
  }

  /** Submits a cooperative close. Takes only a `CloseTransaction` (see `ChannelSession.closeTransaction()`). */
  closeCooperative(sender: TxSender, tx: CloseTransaction): Promise<TransactionReceipt> {
    if (tx.kind !== "close") throw new TypeError('closeCooperative needs a CloseTransaction (kind: "close")');
    const ss = { state: tx.state, sigA: tx.sigA, sigB: tx.sigB }; // strip `kind` before ABI encoding
    return this.call(
      sender,
      encodeFunctionData({ abi: channelHubAbi, functionName: "closeCooperative", args: [encodeSignedState(ss)] }),
    );
  }

  challenge(sender: TxSender, proof: Proof): Promise<TransactionReceipt> {
    return this.call(sender, encodeFunctionData({ abi: channelHubAbi, functionName: "challenge", args: [encodeProof(proof)] }));
  }

  respond(sender: TxSender, proof: Proof): Promise<TransactionReceipt> {
    return this.call(sender, encodeFunctionData({ abi: channelHubAbi, functionName: "respond", args: [encodeProof(proof)] }));
  }

  timeout(sender: TxSender, id: Hex): Promise<TransactionReceipt> {
    return this.call(sender, encodeFunctionData({ abi: channelHubAbi, functionName: "timeout", args: [id] }));
  }

  reclaim(sender: TxSender, id: Hex): Promise<TransactionReceipt> {
    return this.call(sender, encodeFunctionData({ abi: channelHubAbi, functionName: "reclaim", args: [id] }));
  }

  claim(sender: TxSender, to: Address): Promise<TransactionReceipt> {
    return this.call(sender, encodeFunctionData({ abi: channelHubAbi, functionName: "claim", args: [to] }));
  }

  async channelInfo(id: Hex): Promise<ChannelInfo> {
    const r = await this.client.readContract({ address: this.hub, abi: channelHubAbi, functionName: "channelInfo", args: [id] });
    return { ...r, phase: PHASE[r.phase] };
  }

  async registeredState(id: Hex): Promise<State> {
    const s = await this.client.readContract({ address: this.hub, abi: channelHubAbi, functionName: "registeredState", args: [id] });
    return { ...s };
  }

  async channelParams(id: Hex): Promise<Params> {
    const p = await this.client.readContract({ address: this.hub, abi: channelHubAbi, functionName: "channelParams", args: [id] });
    return { ...p };
  }

  owed(addr: Address): Promise<bigint> {
    return this.client.readContract({ address: this.hub, abi: channelHubAbi, functionName: "owed", args: [addr] });
  }

  /** The hub's current fee config for new channels (spec §4.6). */
  async feeConfig(): Promise<{ feePerPlayer: bigint; feeRecipient: Address }> {
    const [feePerPlayer, feeRecipient] = await Promise.all([
      this.client.readContract({ address: this.hub, abi: channelHubAbi, functionName: "feePerPlayer" }),
      this.client.readContract({ address: this.hub, abi: channelHubAbi, functionName: "feeRecipient" }),
    ]);
    return { feePerPlayer, feeRecipient };
  }

  /**
   * The hub's current launch limits (spec §13): the two owner-set caps, the live commitment, and the pause
   * flag. All four are read at one block number (cacheTime 0, as in `disputeEvents`/`hubEvents`) so a block
   * mined between reads cannot produce an inconsistent snapshot (e.g. a cap and a commitment from different
   * blocks).
   */
  async limits(): Promise<{
    maxDepositPerPlayer: bigint;
    maxCommittedEscrow: bigint;
    committedEscrow: bigint;
    paused: boolean;
  }> {
    const blockNumber = await this.client.getBlockNumber({ cacheTime: 0 });
    const [maxDepositPerPlayer, maxCommittedEscrow, committedEscrow, paused] = await Promise.all([
      this.client.readContract({ address: this.hub, abi: channelHubAbi, functionName: "maxDepositPerPlayer", blockNumber }),
      this.client.readContract({ address: this.hub, abi: channelHubAbi, functionName: "maxCommittedEscrow", blockNumber }),
      this.client.readContract({ address: this.hub, abi: channelHubAbi, functionName: "committedEscrow", blockNumber }),
      this.client.readContract({ address: this.hub, abi: channelHubAbi, functionName: "paused", blockNumber }),
    ]);
    return { maxDepositPerPlayer, maxCommittedEscrow, committedEscrow, paused };
  }

  /** The hub's accepted `challengeTimeout` range in seconds (`MIN_TIMEOUT`..`MAX_TIMEOUT`, inclusive). */
  async timeoutBounds(): Promise<{ min: bigint; max: bigint }> {
    const [min, max] = await Promise.all([
      this.client.readContract({ address: this.hub, abi: channelHubAbi, functionName: "MIN_TIMEOUT" }),
      this.client.readContract({ address: this.hub, abi: channelHubAbi, functionName: "MAX_TIMEOUT" }),
    ]);
    return { min: BigInt(min), max: BigInt(max) };
  }

  /**
   * Challenged/Responded events for a channel in chain order, with the signed state each one carries. `toBlock`
   * omitted means the current head (cacheTime 0: viem otherwise serves a cached head for up to a polling interval
   * and would hide fresh events) -- one head for both queries, so a block mined between them cannot appear in one
   * list but not the other.
   */
  async disputeEvents(id: Hex, fromBlock: bigint = 0n, toBlock?: bigint): Promise<DisputeEvent[]> {
    const to = toBlock ?? (await this.client.getBlockNumber({ cacheTime: 0 }));
    const [challenged, responded] = await Promise.all([
      this.client.getContractEvents({
        address: this.hub,
        abi: channelHubAbi,
        eventName: "Challenged",
        args: { channelId: id },
        fromBlock,
        toBlock: to,
      }),
      this.client.getContractEvents({
        address: this.hub,
        abi: channelHubAbi,
        eventName: "Responded",
        args: { channelId: id },
        fromBlock,
        toBlock: to,
      }),
    ]);
    const events: DisputeEvent[] = [
      ...challenged.map((l) => ({
        kind: "Challenged" as const,
        blockNumber: l.blockNumber,
        logIndex: l.logIndex,
        transactionHash: l.transactionHash,
        turnNum: l.args.turnNum as bigint,
        signed: decodeSignedState(l.args.signedState as Hex),
        challenger: Number(l.args.challenger),
        deadline: l.args.deadline as bigint,
      })),
      ...responded.map((l) => ({
        kind: "Responded" as const,
        blockNumber: l.blockNumber,
        logIndex: l.logIndex,
        transactionHash: l.transactionHash,
        turnNum: l.args.turnNum as bigint,
        signed: decodeSignedState(l.args.signedState as Hex),
      })),
    ];
    return events.sort((x, y) =>
      x.blockNumber === y.blockNumber ? x.logIndex - y.logIndex : x.blockNumber < y.blockNumber ? -1 : 1,
    );
  }

  /** The current head; cacheTime 0 so a caller polling for new events never sees a stale cached block. */
  blockNumber(): Promise<bigint> {
    return this.client.getBlockNumber({ cacheTime: 0 });
  }

  /**
   * Every hub event for every channel in `[fromBlock, toBlock]`, chain order -- for a watchtower scanning the
   * whole hub rather than one channel at a time, since it may not know every channel to poll for ahead of time.
   * Events with no `channelId` arg (PayoutDeferred, Claimed, FeeUpdated, LimitsUpdated, PausedSet,
   * EIP712DomainChanged, OZ Ownership*) are skipped.
   */
  async hubEvents(fromBlock: bigint, toBlock: bigint): Promise<HubEvent[]> {
    const logs = await this.client.getContractEvents({ address: this.hub, abi: channelHubAbi, fromBlock, toBlock });
    const events: HubEvent[] = [];
    for (const log of logs) {
      const args = log.args as Record<string, unknown>;
      if (typeof args.channelId !== "string") continue;
      const channelId = args.channelId as Hex;
      const base = { blockNumber: log.blockNumber, logIndex: log.logIndex, channelId };
      switch (log.eventName) {
        case "ChannelCreated":
          events.push({ ...base, kind: "ChannelCreated", params: decodeParams(args.params as Hex) });
          break;
        case "Deposited":
          events.push({
            ...base,
            kind: "Deposited",
            player: Number(args.player) as PlayerIndex,
            amount: args.amount as bigint,
          });
          break;
        case "Opened":
          events.push({ ...base, kind: "Opened" });
          break;
        case "Challenged":
          events.push({
            ...base,
            kind: "Challenged",
            challenger: Number(args.challenger) as PlayerIndex,
            turnNum: args.turnNum as bigint,
            deadline: args.deadline as bigint,
            signed: decodeSignedState(args.signedState as Hex),
          });
          break;
        case "Responded":
          events.push({
            ...base,
            kind: "Responded",
            turnNum: args.turnNum as bigint,
            signed: decodeSignedState(args.signedState as Hex),
          });
          break;
        case "Finalized":
          events.push({
            ...base,
            kind: "Finalized",
            balanceA: args.balanceA as bigint,
            balanceB: args.balanceB as bigint,
            fee: args.fee as bigint,
          });
          break;
        case "Reclaimed":
          events.push({ ...base, kind: "Reclaimed" });
          break;
        default:
          // Unknown event carrying a channelId-named arg; ignore defensively rather than guess its shape.
          break;
      }
    }
    return events.sort((x, y) =>
      x.blockNumber === y.blockNumber ? x.logIndex - y.logIndex : x.blockNumber < y.blockNumber ? -1 : 1,
    );
  }

  private call(sender: TxSender, data: Hex): Promise<TransactionReceipt> {
    return this.write(sender, this.hub, data);
  }

  /**
   * Simulates first so reverts surface as named errors, then sends and waits for success. The chain can change
   * between the simulate and the send (e.g. two players racing the same cooperative close): a revert the sender's
   * own gas estimate hits is reported as a HubRevertError too, named when decodable, never as a raw viem error.
   */
  private async write(sender: TxSender, to: Address, data: Hex): Promise<TransactionReceipt> {
    try {
      await this.client.call({ account: sender.address, to, data });
    } catch (err) {
      throw new HubRevertError(decodeRevert(err), err);
    }
    let hash: Hex;
    try {
      hash = await sender.send({ to, data });
    } catch (err) {
      if (isSendRevert(err)) throw new HubRevertError(decodeRevert(err), err);
      // not a revert (RPC down, nonce, gas allowance, a non-viem sender's own failure): the caller sees it unchanged
      throw err;
    }
    const receipt = await this.client.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new HubRevertError(undefined, new Error(`transaction ${hash} reverted`));
    return receipt;
  }
}
