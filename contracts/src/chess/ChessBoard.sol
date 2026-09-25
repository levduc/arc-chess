// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Packed chess encoding shared by ChessMoves and ChessRules. See the plan's Global Constraints for layouts.
library ChessBoard {
    uint8 internal constant EMPTY = 0;
    uint8 internal constant PAWN = 1;
    uint8 internal constant KNIGHT = 2;
    uint8 internal constant BISHOP = 3;
    uint8 internal constant ROOK = 4;
    uint8 internal constant QUEEN = 5;
    uint8 internal constant KING = 6;
    uint8 internal constant BLACK = 8; // colour bit of a piece code

    uint8 internal constant WHITE_SIDE = 0;
    uint8 internal constant BLACK_SIDE = 1;

    uint8 internal constant CASTLE_WK = 1;
    uint8 internal constant CASTLE_WQ = 2;
    uint8 internal constant CASTLE_BK = 4;
    uint8 internal constant CASTLE_BQ = 8;

    uint8 internal constant NO_EP = 255;

    uint8 internal constant STATUS_PLAYING = 0;
    uint8 internal constant STATUS_DRAW_OFFERED = 1;
    uint8 internal constant STATUS_WHITE_WON = 2;
    uint8 internal constant STATUS_BLACK_WON = 3;
    uint8 internal constant STATUS_DRAW = 4;

    uint8 internal constant KIND_NONE = 0;
    uint8 internal constant KIND_NORMAL = 1;
    uint8 internal constant KIND_NORMAL_OFFER_DRAW = 2;
    uint8 internal constant KIND_RESIGN = 3;
    uint8 internal constant KIND_ACCEPT_DRAW = 4;
    uint8 internal constant KIND_CLAIM_STALEMATE = 5;
    uint8 internal constant KIND_NEW_GAME = 6;

    uint256 internal constant INITIAL_BOARD =
        0xcabedbac99999999000000000000000000000000000000001111111142365324;
    uint256 internal constant INITIAL_META = 0xFF0F00;

    function pieceAt(uint256 board, uint256 sq) internal pure returns (uint8) {
        return uint8((board >> (sq * 4)) & 0xF);
    }

    function setPiece(uint256 board, uint256 sq, uint8 piece) internal pure returns (uint256) {
        uint256 shift = sq * 4;
        return (board & ~(uint256(0xF) << shift)) | (uint256(piece) << shift);
    }

    function pieceType(uint8 piece) internal pure returns (uint8) {
        return piece & 7;
    }

    function isBlack(uint8 piece) internal pure returns (bool) {
        return piece & BLACK != 0;
    }

    function side(uint256 meta) internal pure returns (uint8) {
        return uint8(meta & 0xFF);
    }

    function castling(uint256 meta) internal pure returns (uint8) {
        return uint8((meta >> 8) & 0xFF);
    }

    function epSquare(uint256 meta) internal pure returns (uint8) {
        return uint8((meta >> 16) & 0xFF);
    }

    function halfmove(uint256 meta) internal pure returns (uint16) {
        return uint16((meta >> 24) & 0xFFFF);
    }

    function ply(uint256 meta) internal pure returns (uint16) {
        return uint16((meta >> 40) & 0xFFFF);
    }

    function status(uint256 meta) internal pure returns (uint8) {
        return uint8((meta >> 56) & 0xFF);
    }

    function packMeta(uint8 side_, uint8 castling_, uint8 ep_, uint16 halfmove_, uint16 ply_, uint8 status_)
        internal
        pure
        returns (uint256)
    {
        return uint256(side_) | (uint256(castling_) << 8) | (uint256(ep_) << 16) | (uint256(halfmove_) << 24)
            | (uint256(ply_) << 40) | (uint256(status_) << 56);
    }

    function withStatus(uint256 meta, uint8 status_) internal pure returns (uint256) {
        return (meta & ~(uint256(0xFF) << 56)) | (uint256(status_) << 56);
    }

    function encodeMove(uint8 from, uint8 to, uint8 promo, uint8 kind) internal pure returns (uint32) {
        return uint32(from) | (uint32(to) << 6) | (uint32(promo) << 12) | (uint32(kind) << 15);
    }

    function moveFrom(uint32 m) internal pure returns (uint8) {
        return uint8(m & 63);
    }

    function moveTo(uint32 m) internal pure returns (uint8) {
        return uint8((m >> 6) & 63);
    }

    function movePromo(uint32 m) internal pure returns (uint8) {
        return uint8((m >> 12) & 7);
    }

    function moveKind(uint32 m) internal pure returns (uint8) {
        return uint8((m >> 15) & 15);
    }
}
