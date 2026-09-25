import type { Address, Hex } from "viem";

/** 0 = participants[0] ("A"), 1 = participants[1] ("B"). */
export type PlayerIndex = 0 | 1;

/** Mirrors Solidity `Params` (contracts/src/ArenaTypes.sol). */
export type Params = {
  participants: readonly [Address, Address];
  signers: readonly [Address, Address];
  rules: Address;
  feeRecipient: Address;
  feePerPlayer: bigint;
  deposit: bigint;
  stakePerGame: bigint;
  challengeTimeout: bigint;
  fundingDeadline: bigint;
  salt: Hex;
};

/** Mirrors Solidity `State`. */
export type State = {
  channelId: Hex;
  turnNum: bigint;
  prevHash: Hex;
  balanceA: bigint;
  balanceB: bigint;
  gameIndex: number;
  move: number;
  board: bigint;
  meta: bigint;
};

/** A state with optional signatures by signers[0] (sigA) and signers[1] (sigB); "0x" = absent. */
export type SignedState = {
  state: State;
  sigA: Hex;
  sigB: Hex;
};

/** Mirrors Solidity `Proof`. */
export type Proof = {
  hasPrev: boolean;
  prev: SignedState;
  latest: SignedState;
};
