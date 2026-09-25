// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ChessBoard as B} from "../src/chess/ChessBoard.sol";
import {ChessTestUtils} from "./helpers/ChessTestUtils.sol";

contract ChessBoardTest is Test, ChessTestUtils {
    function test_initialBoard_matchesPieceByPiece() public pure {
        uint8[8] memory back = [B.ROOK, B.KNIGHT, B.BISHOP, B.QUEEN, B.KING, B.BISHOP, B.KNIGHT, B.ROOK];
        uint256 board;
        for (uint256 f = 0; f < 8; f++) {
            board = B.setPiece(board, f, back[f]);
            board = B.setPiece(board, 8 + f, B.PAWN);
            board = B.setPiece(board, 48 + f, B.PAWN | B.BLACK);
            board = B.setPiece(board, 56 + f, back[f] | B.BLACK);
        }
        assertEq(board, B.INITIAL_BOARD);
        assertEq(B.pieceAt(B.INITIAL_BOARD, sq("e1")), B.KING);
        assertEq(B.pieceAt(B.INITIAL_BOARD, sq("d8")), B.QUEEN | B.BLACK);
        assertEq(B.pieceAt(B.INITIAL_BOARD, sq("e4")), B.EMPTY);
    }

    function test_initialMeta() public pure {
        assertEq(B.INITIAL_META, B.packMeta(B.WHITE_SIDE, 0x0F, B.NO_EP, 0, 0, B.STATUS_PLAYING));
        assertEq(B.INITIAL_META, 0xFF0F00);
    }

    function test_meta_roundTrip() public pure {
        uint256 m = B.packMeta(B.BLACK_SIDE, 9, 43, 77, 301, B.STATUS_DRAW_OFFERED);
        assertEq(B.side(m), B.BLACK_SIDE);
        assertEq(B.castling(m), 9);
        assertEq(B.epSquare(m), 43);
        assertEq(B.halfmove(m), 77);
        assertEq(B.ply(m), 301);
        assertEq(B.status(m), B.STATUS_DRAW_OFFERED);
        assertEq(m >> 64, 0);
    }

    function test_withStatus_onlyChangesStatus() public pure {
        uint256 m = B.packMeta(B.BLACK_SIDE, 5, 20, 3, 4, B.STATUS_PLAYING);
        uint256 w = B.withStatus(m, B.STATUS_WHITE_WON);
        assertEq(B.status(w), B.STATUS_WHITE_WON);
        assertEq(B.withStatus(w, B.STATUS_PLAYING), m);
    }

    function test_setPiece_overwritesOnlyThatSquare() public pure {
        uint256 b = B.setPiece(B.INITIAL_BOARD, sq("e2"), B.EMPTY);
        b = B.setPiece(b, sq("e4"), B.PAWN);
        assertEq(B.pieceAt(b, sq("e2")), B.EMPTY);
        assertEq(B.pieceAt(b, sq("e4")), B.PAWN);
        assertEq(B.pieceAt(b, sq("d2")), B.PAWN);
        assertEq(B.pieceAt(b, sq("f2")), B.PAWN);
    }

    function test_move_roundTrip() public pure {
        uint32 m = B.encodeMove(52, 60, B.QUEEN, B.KIND_NORMAL_OFFER_DRAW);
        assertEq(B.moveFrom(m), 52);
        assertEq(B.moveTo(m), 60);
        assertEq(B.movePromo(m), B.QUEEN);
        assertEq(B.moveKind(m), B.KIND_NORMAL_OFFER_DRAW);
        assertEq(uint256(m) >> 19, 0);
        assertEq(uci("e2e4"), B.encodeMove(12, 28, 0, B.KIND_NORMAL));
        assertEq(uci("a7a8q"), B.encodeMove(48, 56, B.QUEEN, B.KIND_NORMAL));
    }

    function test_pieceHelpers() public pure {
        assertEq(B.pieceType(B.KNIGHT | B.BLACK), B.KNIGHT);
        assertTrue(B.isBlack(B.KNIGHT | B.BLACK));
        assertFalse(B.isBlack(B.KNIGHT));
    }
}
