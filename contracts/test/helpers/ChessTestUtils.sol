// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ChessBoard as B} from "../../src/chess/ChessBoard.sol";

/// @notice Helpers for writing chess positions and moves in tests using algebraic squares ("e4") and UCI ("e2e4", "a7a8q").
abstract contract ChessTestUtils {
    function sq(string memory s) internal pure returns (uint256) {
        bytes memory b = bytes(s);
        require(b.length == 2, "square must be like e4");
        return _sqAt(b, 0);
    }

    function place(uint256 board, string memory s, uint8 piece) internal pure returns (uint256) {
        return B.setPiece(board, sq(s), piece);
    }

    function uci(string memory m) internal pure returns (uint32) {
        return uciKind(m, B.KIND_NORMAL);
    }

    function uciKind(string memory m, uint8 kind) internal pure returns (uint32) {
        bytes memory b = bytes(m);
        require(b.length == 4 || b.length == 5, "uci must be like e2e4 or a7a8q");
        uint8 promo = 0;
        if (b.length == 5) {
            bytes1 c = b[4];
            if (c == "n") promo = B.KNIGHT;
            else if (c == "b") promo = B.BISHOP;
            else if (c == "r") promo = B.ROOK;
            else if (c == "q") promo = B.QUEEN;
            else revert("bad promotion piece");
        }
        return B.encodeMove(uint8(_sqAt(b, 0)), uint8(_sqAt(b, 2)), promo, kind);
    }

    function metaOf(uint8 side, uint8 castling, uint8 ep, uint16 halfmove, uint16 ply) internal pure returns (uint256) {
        return B.packMeta(side, castling, ep, halfmove, ply, B.STATUS_PLAYING);
    }

    function _sqAt(bytes memory b, uint256 i) private pure returns (uint256) {
        uint256 file = uint256(uint8(b[i])) - 97; // 'a'
        uint256 rank = uint256(uint8(b[i + 1])) - 49; // '1'
        require(file < 8 && rank < 8, "square out of range");
        return rank * 8 + file;
    }
}
