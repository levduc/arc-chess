// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ChessMoves} from "../../src/chess/ChessMoves.sol";

/// @notice External wrappers so tests can call library functions and measure gas.
contract ChessMovesHarness {
    function applyMove(uint256 board, uint256 meta, uint256 from, uint256 to, uint8 promo)
        external
        pure
        returns (bool, uint256, uint256)
    {
        return ChessMoves.applyMove(board, meta, from, to, promo);
    }

    function inCheck(uint256 board, uint256 meta) external pure returns (bool) {
        return ChessMoves.inCheck(board, meta);
    }

    function isSquareAttacked(uint256 board, uint256 sq, bool byBlack) external pure returns (bool) {
        return ChessMoves.isSquareAttacked(board, sq, byBlack);
    }
}
