import {
  BaseError,
  decodeErrorResult,
  encodeFunctionData,
  erc20Abi,
  type Address,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
} from "viem";
import { channelHubAbi, mockUsdcAbi } from "./abi.js";
import { decodeSignedState, encodeParams, encodeProof, encodeSignedState } from "./abiCodec.js";
import type { TxSender } from "./tx.js";
import type { CloseTransaction, Params, Proof, SignedState, State } from "./types.js";

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

  /** Challenged/Responded events for a channel in chain order, with the signed state each one carries. */
  async disputeEvents(id: Hex, fromBlock: bigint = 0n): Promise<DisputeEvent[]> {
    // One head for both queries, so a block mined between them cannot appear in one list but not the other.
    // cacheTime 0: viem otherwise serves a cached head for up to a polling interval and would hide fresh events.
    const toBlock = await this.client.getBlockNumber({ cacheTime: 0 });
    const [challenged, responded] = await Promise.all([
      this.client.getContractEvents({ address: this.hub, abi: channelHubAbi, eventName: "Challenged", args: { channelId: id }, fromBlock, toBlock }),
      this.client.getContractEvents({ address: this.hub, abi: channelHubAbi, eventName: "Responded", args: { channelId: id }, fromBlock, toBlock }),
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

  private call(sender: TxSender, data: Hex): Promise<TransactionReceipt> {
    return this.write(sender, this.hub, data);
  }

  /** Simulates first so reverts surface as named errors, then sends and waits for success. */
  private async write(sender: TxSender, to: Address, data: Hex): Promise<TransactionReceipt> {
    try {
      await this.client.call({ account: sender.address, to, data });
    } catch (err) {
      throw new HubRevertError(decodeRevert(err), err);
    }
    const hash = await sender.send({ to, data });
    const receipt = await this.client.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new HubRevertError(undefined, new Error(`transaction ${hash} reverted`));
    return receipt;
  }
}
