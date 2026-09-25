// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, console2} from "forge-std/Test.sol";
import {ChessBoard as B} from "../src/chess/ChessBoard.sol";
import {ChessMoves} from "../src/chess/ChessMoves.sol";
import {ChessMovesHarness} from "./helpers/ChessMovesHarness.sol";
import {ChessTestUtils} from "./helpers/ChessTestUtils.sol";

contract ChessMovesTerminalTest is Test, ChessTestUtils {
    uint8 internal constant BK = B.KING | B.BLACK;
    uint8 internal constant BB = B.BISHOP | B.BLACK;
    uint8 internal constant BN = B.KNIGHT | B.BLACK;
    uint8 internal constant BP = B.PAWN | B.BLACK;
    uint8 internal constant BQ = B.QUEEN | B.BLACK;

    ChessMovesHarness internal h;

    function setUp() public {
        h = new ChessMovesHarness();
    }

    function _play(uint256 board, uint256 meta, string memory m) internal pure returns (uint256, uint256) {
        uint32 e = uci(m);
        (bool ok, uint256 nb, uint256 nm) = ChessMoves.applyMove(board, meta, B.moveFrom(e), B.moveTo(e), B.movePromo(e));
        require(ok, string.concat("illegal: ", m));
        return (nb, nm);
    }

    function _foolsMate() internal pure returns (uint256 board, uint256 meta) {
        (board, meta) = _play(B.INITIAL_BOARD, B.INITIAL_META, "f2f3");
        (board, meta) = _play(board, meta, "e7e5");
        (board, meta) = _play(board, meta, "g2g4");
        (board, meta) = _play(board, meta, "d8h4");
    }

    function test_startPositionHasMoves() public pure {
        assertTrue(ChessMoves.hasLegalMove(B.INITIAL_BOARD, B.INITIAL_META));
    }

    function test_checkmate_noLegalMoveAndInCheck() public pure {
        (uint256 board, uint256 meta) = _foolsMate();
        assertTrue(ChessMoves.inCheck(board, meta));
        assertFalse(ChessMoves.hasLegalMove(board, meta));
    }

    function test_stalemate_noLegalMoveNotInCheck() public pure {
        // 7k/5Q2/6K1/8/8/8/8/8 b - -
        uint256 board = place(place(place(0, "h8", BK), "f7", B.QUEEN), "g6", B.KING);
        uint256 meta = metaOf(B.BLACK_SIDE, 0, B.NO_EP, 0, 0);
        assertFalse(ChessMoves.inCheck(board, meta));
        assertFalse(ChessMoves.hasLegalMove(board, meta));
    }

    function test_insufficientMaterial_matchesChessJs() public pure {
        uint256 kk = place(place(0, "a1", BK), "h1", B.KING);
        assertTrue(ChessMoves.isInsufficientMaterial(kk));
        assertTrue(ChessMoves.isInsufficientMaterial(place(kk, "b1", BN)));
        assertTrue(ChessMoves.isInsufficientMaterial(place(kk, "g1", B.BISHOP)));
        // b2 and g1 are both dark squares: same-coloured bishops are insufficient.
        assertTrue(ChessMoves.isInsufficientMaterial(place(place(kk, "b2", BB), "g1", B.BISHOP)));
        // a2 is light, g1 dark: opposite-coloured bishops can still mate.
        assertFalse(ChessMoves.isInsufficientMaterial(place(place(kk, "a2", BB), "g1", B.BISHOP)));
        assertFalse(ChessMoves.isInsufficientMaterial(place(kk, "g1", B.ROOK)));
        assertFalse(ChessMoves.isInsufficientMaterial(place(kk, "g2", B.PAWN)));
        assertFalse(ChessMoves.isInsufficientMaterial(place(place(kk, "g1", B.KNIGHT), "g2", B.KNIGHT)));
        assertFalse(ChessMoves.isInsufficientMaterial(B.INITIAL_BOARD));
    }

    function test_hasLegalMove_enPassantOnly() public pure {
        // 8/8/1b6/pP6/8/6q1/5k2/7K w - a6 0 1
        // chess.js 1.4.0: moves({verbose:true}) -> exactly 1 move, b5a6 (e.p.). inCheck: false.
        uint256 board = place(0, "h1", B.KING);
        board = place(board, "g3", BQ);
        board = place(board, "f2", BK);
        board = place(board, "b6", BB);
        board = place(board, "b5", B.PAWN);
        board = place(board, "a5", BP);
        uint256 meta = metaOf(B.WHITE_SIDE, 0, uint8(sq("a6")), 0, 0);
        assertTrue(ChessMoves.hasLegalMove(board, meta));

        // Same board, ep square cleared: chess.js reports 0 moves (isStalemate: true, inCheck: false).
        uint256 metaNoEp = metaOf(B.WHITE_SIDE, 0, B.NO_EP, 0, 0);
        assertFalse(ChessMoves.inCheck(board, metaNoEp));
        assertFalse(ChessMoves.hasLegalMove(board, metaNoEp));
    }

    function test_hasLegalMove_promotionOnly() public pure {
        // 8/1P6/8/8/8/6q1/5k2/7K w - - 0 1
        // chess.js 1.4.0: moves({verbose:true}) -> exactly 4 moves, all b7b8=Q/R/B/N. inCheck: false.
        uint256 board = place(0, "h1", B.KING);
        board = place(board, "g3", BQ);
        board = place(board, "f2", BK);
        board = place(board, "b7", B.PAWN);
        uint256 meta = metaOf(B.WHITE_SIDE, 0, B.NO_EP, 0, 0);
        assertFalse(ChessMoves.inCheck(board, meta));
        assertTrue(ChessMoves.hasLegalMove(board, meta));
    }

    function test_stalemate_whiteToMove() public pure {
        // 8/8/8/8/8/6k1/5q2/7K w - - 0 1
        // chess.js 1.4.0: isStalemate: true, isCheckmate: false, inCheck: false, 0 legal moves.
        uint256 board = place(0, "h1", B.KING);
        board = place(board, "g3", BK);
        board = place(board, "f2", BQ);
        uint256 meta = metaOf(B.WHITE_SIDE, 0, B.NO_EP, 0, 0);
        assertFalse(ChessMoves.inCheck(board, meta));
        assertFalse(ChessMoves.hasLegalMove(board, meta));
    }

    function test_gas_hasLegalMove_fullBoardCheckmate() public {
        (uint256 board, uint256 meta) = _foolsMate();
        uint256 before = gasleft();
        bool any = h.hasLegalMove(board, meta);
        uint256 used = before - gasleft();
        console2.log("hasLegalMove gas (fool's mate, full enumeration):", used);
        assertFalse(any);
        assertLt(used, 10_000_000, "stalemate/mate proof must stay well under a block");
    }
}
