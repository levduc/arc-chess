// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ChessBoard as B} from "../src/chess/ChessBoard.sol";
import {ChessMoves} from "../src/chess/ChessMoves.sol";
import {ChessTestUtils} from "./helpers/ChessTestUtils.sol";

contract ChessMovesTest is Test, ChessTestUtils {
    uint8 internal constant BP = B.PAWN | B.BLACK;
    uint8 internal constant BR = B.ROOK | B.BLACK;
    uint8 internal constant BQ = B.QUEEN | B.BLACK;
    uint8 internal constant BK = B.KING | B.BLACK;

    function _move(uint256 board, uint256 meta, string memory m) internal pure returns (bool, uint256, uint256) {
        uint32 e = uci(m);
        return ChessMoves.applyMove(board, meta, B.moveFrom(e), B.moveTo(e), B.movePromo(e));
    }

    function test_pawnDoublePush_setsEpAndFlipsSide() public pure {
        (bool ok, uint256 nb, uint256 nm) = _move(B.INITIAL_BOARD, B.INITIAL_META, "e2e4");
        assertTrue(ok);
        assertEq(B.pieceAt(nb, sq("e4")), B.PAWN);
        assertEq(B.pieceAt(nb, sq("e2")), B.EMPTY);
        assertEq(B.side(nm), B.BLACK_SIDE);
        assertEq(B.epSquare(nm), sq("e3"));
        assertEq(B.halfmove(nm), 0);
        assertEq(B.ply(nm), 1);
        assertEq(B.castling(nm), 0x0F);
        assertEq(B.status(nm), B.STATUS_PLAYING);
    }

    function test_pawnDoublePush_blocked() public pure {
        uint256 board = place(B.INITIAL_BOARD, "e3", B.KNIGHT | B.BLACK);
        (bool ok,,) = _move(board, B.INITIAL_META, "e2e4");
        assertFalse(ok);
    }

    function test_knightMoveIncrementsHalfmove() public pure {
        (bool ok,, uint256 nm) = _move(B.INITIAL_BOARD, B.INITIAL_META, "g1f3");
        assertTrue(ok);
        assertEq(B.halfmove(nm), 1);
        assertEq(B.epSquare(nm), B.NO_EP);
        (bool bad,,) = _move(B.INITIAL_BOARD, B.INITIAL_META, "g1g3");
        assertFalse(bad);
    }

    function test_sliderBlockedByOwnPawn() public pure {
        (bool ok,,) = _move(B.INITIAL_BOARD, B.INITIAL_META, "a1a3");
        assertFalse(ok);
    }

    function test_cannotCaptureOwnPiece() public pure {
        (bool ok,,) = _move(B.INITIAL_BOARD, B.INITIAL_META, "d1d2");
        assertFalse(ok);
    }

    function test_cannotMoveOpponentPiece() public pure {
        (bool ok,,) = _move(B.INITIAL_BOARD, B.INITIAL_META, "e7e5");
        assertFalse(ok);
    }

    function test_rejectsOutOfRangeAndNullMoves() public pure {
        (bool a,,) = ChessMoves.applyMove(B.INITIAL_BOARD, B.INITIAL_META, 64, 0, 0);
        (bool b,,) = ChessMoves.applyMove(B.INITIAL_BOARD, B.INITIAL_META, 12, 12, 0);
        assertFalse(a);
        assertFalse(b);
    }

    function test_pinnedPieceCannotMove() public pure {
        uint256 board = place(place(place(place(0, "e1", B.KING), "e2", B.BISHOP), "e7", BR), "a8", BK);
        uint256 meta = metaOf(B.WHITE_SIDE, 0, B.NO_EP, 0, 0);
        (bool ok,,) = _move(board, meta, "e2d3");
        assertFalse(ok);
    }

    function test_kingCannotMoveIntoCheck() public pure {
        uint256 board = place(place(place(0, "e1", B.KING), "d8", BR), "a8", BK);
        uint256 meta = metaOf(B.WHITE_SIDE, 0, B.NO_EP, 0, 0);
        (bool into,,) = _move(board, meta, "e1d1");
        (bool away,,) = _move(board, meta, "e1f1");
        assertFalse(into);
        assertTrue(away);
    }

    function test_castleKingSide_movesRookAndClearsRights() public pure {
        uint256 board = place(place(place(0, "e1", B.KING), "h1", B.ROOK), "e8", BK);
        uint256 meta = metaOf(B.WHITE_SIDE, B.CASTLE_WK, B.NO_EP, 0, 0);
        (bool ok, uint256 nb, uint256 nm) = _move(board, meta, "e1g1");
        assertTrue(ok);
        assertEq(B.pieceAt(nb, sq("g1")), B.KING);
        assertEq(B.pieceAt(nb, sq("f1")), B.ROOK);
        assertEq(B.pieceAt(nb, sq("h1")), B.EMPTY);
        assertEq(B.pieceAt(nb, sq("e1")), B.EMPTY);
        assertEq(B.castling(nm), 0);
    }

    function test_castleThroughCheck_illegal() public pure {
        uint256 board = place(place(place(place(0, "e1", B.KING), "h1", B.ROOK), "e8", BK), "f8", BR);
        uint256 meta = metaOf(B.WHITE_SIDE, B.CASTLE_WK, B.NO_EP, 0, 0);
        (bool ok,,) = _move(board, meta, "e1g1");
        assertFalse(ok);
    }

    function test_castleWithoutRight_illegal() public pure {
        uint256 board = place(place(place(0, "e1", B.KING), "h1", B.ROOK), "e8", BK);
        uint256 meta = metaOf(B.WHITE_SIDE, B.CASTLE_WQ, B.NO_EP, 0, 0);
        (bool ok,,) = _move(board, meta, "e1g1");
        assertFalse(ok);
    }

    function test_castleQueenSide_bFileOccupied_illegal() public pure {
        uint256 board = place(place(place(place(0, "e1", B.KING), "a1", B.ROOK), "b1", B.KNIGHT), "e8", BK);
        uint256 meta = metaOf(B.WHITE_SIDE, B.CASTLE_WQ, B.NO_EP, 0, 0);
        (bool ok,,) = _move(board, meta, "e1c1");
        assertFalse(ok);
    }

    function test_rookCaptureDropsBothRookRights() public pure {
        uint256 board = place(place(place(place(0, "e1", B.KING), "a1", B.ROOK), "e8", BK), "a8", BR);
        uint256 meta = metaOf(B.WHITE_SIDE, 0x0F, B.NO_EP, 7, 10);
        (bool ok,, uint256 nm) = _move(board, meta, "a1a8");
        assertTrue(ok);
        assertEq(B.castling(nm), B.CASTLE_WK | B.CASTLE_BK);
        assertEq(B.halfmove(nm), 0); // capture resets the clock
    }

    function test_enPassant_removesCapturedPawn() public pure {
        uint256 board = place(place(place(place(0, "e1", B.KING), "e8", BK), "e5", B.PAWN), "d5", BP);
        uint256 meta = metaOf(B.WHITE_SIDE, 0, uint8(sq("d6")), 0, 20);
        (bool ok, uint256 nb,) = _move(board, meta, "e5d6");
        assertTrue(ok);
        assertEq(B.pieceAt(nb, sq("d6")), B.PAWN);
        assertEq(B.pieceAt(nb, sq("d5")), B.EMPTY);
    }

    function test_enPassant_withoutEpSquare_illegal() public pure {
        uint256 board = place(place(place(place(0, "e1", B.KING), "e8", BK), "e5", B.PAWN), "d5", BP);
        uint256 meta = metaOf(B.WHITE_SIDE, 0, B.NO_EP, 0, 20);
        (bool ok,,) = _move(board, meta, "e5d6");
        assertFalse(ok);
    }

    function test_enPassant_exposingKing_illegal() public pure {
        // 8/8/8/K2pP2q/8/8/8/7k w - d6
        uint256 board = place(place(place(place(place(0, "a5", B.KING), "d5", BP), "e5", B.PAWN), "h5", BQ), "h1", BK);
        uint256 meta = metaOf(B.WHITE_SIDE, 0, uint8(sq("d6")), 0, 0);
        (bool ok,,) = _move(board, meta, "e5d6");
        assertFalse(ok);
    }

    function test_promotion_requiresPieceOnLastRankOnly() public pure {
        uint256 board = place(place(place(0, "a7", B.PAWN), "h1", B.KING), "a1", BK);
        uint256 meta = metaOf(B.WHITE_SIDE, 0, B.NO_EP, 0, 0);
        (bool none,,) = _move(board, meta, "a7a8");
        (bool queen, uint256 nb,) = _move(board, meta, "a7a8q");
        assertFalse(none);
        assertTrue(queen);
        assertEq(B.pieceAt(nb, sq("a8")), B.QUEEN);
        (bool early,,) = _move(B.INITIAL_BOARD, B.INITIAL_META, "e2e4q");
        assertFalse(early);
    }

    function test_isSquareAttacked_basics() public pure {
        assertTrue(ChessMoves.isSquareAttacked(B.INITIAL_BOARD, sq("f3"), false)); // g1 knight, e2/g2 pawns
        assertFalse(ChessMoves.isSquareAttacked(B.INITIAL_BOARD, sq("e4"), false));
        assertTrue(ChessMoves.isSquareAttacked(B.INITIAL_BOARD, sq("f6"), true));
        assertFalse(ChessMoves.inCheck(B.INITIAL_BOARD, B.INITIAL_META));
        assertEq(ChessMoves.kingSquare(B.INITIAL_BOARD, true), sq("e8"));
        assertEq(ChessMoves.kingSquare(0, false), 64);
    }
}
