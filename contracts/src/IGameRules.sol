// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Params, State} from "./ArenaTypes.sol";

/// @notice A game template plugged into ChannelHub. Implementations must be deterministic and side-effect free.
interface IGameRules {
    /// @notice Opening state (turnNum 0) of a channel. It needs no signatures.
    function initialState(bytes32 channelId, Params calldata p) external view returns (State memory);

    /// @notice True if `s` is a checkpoint that must be signed by both players.
    function isCheckpoint(State calldata s) external view returns (bool);

    /// @notice Index (0 or 1) of the player whose session key signs the move state following `prev`.
    function mover(State calldata prev, Params calldata p) external view returns (uint8);

    /// @notice True if `next` legally follows `prev`. Ignores `prevHash`, which the hub checks.
    function validTransition(State calldata prev, State calldata next, Params calldata p)
        external
        view
        returns (bool);

    /// @notice True if no game is in progress in `s`; such a state settles with its balances as-is.
    function isGameOver(State calldata s) external view returns (bool);

    /// @notice Balances after the player on move in `s` forfeits the current game.
    function forfeitBalances(State calldata s, Params calldata p)
        external
        view
        returns (uint256 balanceA, uint256 balanceB);
}
