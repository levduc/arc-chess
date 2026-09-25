// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Immutable per-channel parameters. A participant consents to them by calling ChannelHub.deposit.
struct Params {
    address[2] participants; // wallets: depositors and payout targets
    address[2] signers; // per-channel session keys that sign all states
    address rules; // IGameRules implementation
    address feeRecipient; // snapshot of hub config at channel creation
    uint256 feePerPlayer; // escrowed on top of `deposit`, never part of game balances
    uint256 deposit; // per-player game balance
    uint256 stakePerGame; // moved from loser to winner per decisive game
    uint64 challengeTimeout; // seconds
    uint64 fundingDeadline; // unix time
    bytes32 salt;
}

/// @notice A channel state. Signed with EIP-712 by session keys.
struct State {
    bytes32 channelId;
    uint64 turnNum;
    bytes32 prevHash;
    uint256 balanceA;
    uint256 balanceB;
    uint32 gameIndex;
    uint32 move;
    uint256 board;
    uint256 meta;
}

/// @notice A state with optional signatures by signers[0] (sigA) and signers[1] (sigB). Empty bytes = absent.
struct SignedState {
    State state;
    bytes sigA;
    bytes sigB;
}

/// @notice Evidence that `latest` is supported (spec §4.3). If `hasPrev` is false, `latest` must be the
/// opening state or signed by both signers. Otherwise `latest` is a move state following `prev`.
struct Proof {
    bool hasPrev;
    SignedState prev;
    SignedState latest;
}
