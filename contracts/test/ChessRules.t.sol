// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, console2} from "forge-std/Test.sol";
import {Params, State} from "../src/ArenaTypes.sol";
import {ChessBoard as B} from "../src/chess/ChessBoard.sol";
import {ChessRules} from "../src/chess/ChessRules.sol";
import {ChessTestUtils} from "./helpers/ChessTestUtils.sol";

contract ChessRulesTest is Test, ChessTestUtils {
    uint8 internal constant BK = B.KING | B.BLACK;
    uint8 internal constant BP = B.PAWN | B.BLACK;
    uint256 internal constant DEPOSIT = 1_000_000;
    uint256 internal constant STAKE = 100_000;
    bytes32 internal constant ID = keccak256("channel");

    ChessRules internal rules;
    Params internal p;

    function setUp() public {
        rules = new ChessRules();
        p.deposit = DEPOSIT;
        p.stakePerGame = STAKE;
    }

    function _opening() internal view returns (State memory) {
        return rules.initialState(ID, p);
    }

    function _next(State memory prev, uint32 move) internal view returns (State memory n) {
        bool ok;
        (ok, n) = rules.successor(prev, move, p);
        require(ok, "successor rejected");
    }

    function _kind(uint8 kind) internal pure returns (uint32) {
        return B.encodeMove(0, 0, 0, kind);
    }

    function _position(uint256 board, uint256 meta) internal pure returns (State memory s) {
        s.channelId = ID;
        s.turnNum = 10;
        s.balanceA = DEPOSIT;
        s.balanceB = DEPOSIT;
        s.board = board;
        s.meta = meta;
    }

    function test_initialState() public view {
        State memory s = _opening();
        assertEq(s.channelId, ID);
        assertEq(s.turnNum, 0);
        assertEq(s.balanceA, DEPOSIT);
        assertEq(s.balanceB, DEPOSIT);
        assertEq(s.board, B.INITIAL_BOARD);
        assertEq(s.meta, B.INITIAL_META);
        assertEq(s.move, 0);
        assertEq(rules.mover(s, p), 0); // A is white in game 0
    }

    function test_normalMove_producesSuccessor() public view {
        State memory s0 = _opening();
        State memory s1 = _next(s0, uci("e2e4"));
        assertEq(s1.turnNum, 1);
        assertEq(B.pieceAt(s1.board, sq("e4")), B.PAWN);
        assertEq(B.side(s1.meta), B.BLACK_SIDE);
        assertEq(rules.mover(s1, p), 1);
        assertTrue(rules.validTransition(s0, s1, p));
    }

    function test_validTransition_rejectsTampering() public view {
        State memory s0 = _opening();
        State memory s1 = _next(s0, uci("e2e4"));

        State memory badBoard = _next(s0, uci("e2e4"));
        badBoard.board = place(badBoard.board, "d4", B.QUEEN);
        assertFalse(rules.validTransition(s0, badBoard, p));

        State memory badBalance = _next(s0, uci("e2e4"));
        badBalance.balanceA += 1;
        badBalance.balanceB -= 1;
        assertFalse(rules.validTransition(s0, badBalance, p));

        State memory badTurn = _next(s0, uci("e2e4"));
        badTurn.turnNum = 5;
        assertFalse(rules.validTransition(s0, badTurn, p));

        State memory nonCanonical = _next(s0, uci("e2e4"));
        nonCanonical.move = s1.move | (uint32(1) << 25);
        assertFalse(rules.validTransition(s0, nonCanonical, p));

        (bool ok,) = rules.successor(s0, uci("e2e5"), p);
        assertFalse(ok);
    }

    function test_offerDraw_thenAccept() public view {
        State memory s1 = _next(_opening(), uciKind("e2e4", B.KIND_NORMAL_OFFER_DRAW));
        assertEq(B.status(s1.meta), B.STATUS_DRAW_OFFERED);
        State memory s2 = _next(s1, _kind(B.KIND_ACCEPT_DRAW));
        assertEq(B.status(s2.meta), B.STATUS_DRAW);
        assertEq(s2.board, s1.board);
        assertEq(s2.balanceA, DEPOSIT);
        assertEq(s2.balanceB, DEPOSIT);
        assertTrue(rules.isGameOver(s2));
    }

    function test_offerDraw_declinedByNormalMove() public view {
        State memory s1 = _next(_opening(), uciKind("e2e4", B.KIND_NORMAL_OFFER_DRAW));
        State memory s2 = _next(s1, uci("e7e5"));
        assertEq(B.status(s2.meta), B.STATUS_PLAYING);
        assertFalse(rules.isGameOver(s2));
    }

    function test_acceptDraw_withoutOffer_invalid() public view {
        State memory s1 = _next(_opening(), uci("e2e4"));
        (bool ok,) = rules.successor(s1, _kind(B.KIND_ACCEPT_DRAW), p);
        assertFalse(ok);
    }

    function test_resign_shiftsStakeToOpponent() public view {
        State memory s1 = _next(_opening(), uci("e2e4"));
        State memory s2 = _next(s1, _kind(B.KIND_RESIGN)); // black (B) resigns
        assertEq(B.status(s2.meta), B.STATUS_WHITE_WON);
        assertEq(s2.balanceA, DEPOSIT + STAKE);
        assertEq(s2.balanceB, DEPOSIT - STAKE);
        assertTrue(rules.isGameOver(s2));
    }

    function test_noMovesAfterGameOver() public view {
        State memory s2 = _next(_next(_opening(), uci("e2e4")), _kind(B.KIND_RESIGN));
        (bool ok,) = rules.successor(s2, uci("e7e5"), p);
        assertFalse(ok);
        (bool again,) = rules.successor(s2, _kind(B.KIND_RESIGN), p);
        assertFalse(again);
    }

    function test_newGame_onlyAfterGameOver_andSwapsColours() public view {
        State memory s1 = _next(_opening(), uci("e2e4"));
        (bool early,) = rules.successor(s1, _kind(B.KIND_NEW_GAME), p);
        assertFalse(early);

        State memory s2 = _next(s1, _kind(B.KIND_RESIGN));
        State memory s3 = _next(s2, _kind(B.KIND_NEW_GAME));
        assertTrue(rules.isCheckpoint(s3));
        assertEq(s3.gameIndex, 1);
        assertEq(s3.board, B.INITIAL_BOARD);
        assertEq(s3.meta, B.INITIAL_META);
        assertEq(s3.balanceA, s2.balanceA);
        assertEq(rules.mover(s3, p), 1); // B is white in game 1
    }

    function test_newGame_rejectedWhenBalanceBelowStake() public {
        p.deposit = STAKE;
        State memory s2 = _next(_next(rules.initialState(ID, p), uci("e2e4")), _kind(B.KIND_RESIGN));
        assertEq(s2.balanceB, 0);
        (bool ok,) = rules.successor(s2, _kind(B.KIND_NEW_GAME), p);
        assertFalse(ok);
    }

    function test_claimStalemate() public view {
        uint256 board = place(place(place(0, "h8", BK), "f7", B.QUEEN), "g6", B.KING);
        State memory s = _position(board, metaOf(B.BLACK_SIDE, 0, B.NO_EP, 0, 40));
        State memory d = _next(s, _kind(B.KIND_CLAIM_STALEMATE));
        assertEq(B.status(d.meta), B.STATUS_DRAW);
        assertEq(d.balanceA, DEPOSIT);

        (bool notStalemate,) = rules.successor(_opening(), _kind(B.KIND_CLAIM_STALEMATE), p);
        assertFalse(notStalemate);
    }

    function test_insufficientMaterial_autoDraw() public view {
        uint256 board = place(place(place(place(0, "a1", B.KING), "f3", B.KNIGHT), "h8", BK), "e5", BP);
        State memory s = _position(board, metaOf(B.WHITE_SIDE, 0, B.NO_EP, 10, 60));
        State memory d = _next(s, uci("f3e5"));
        assertEq(B.status(d.meta), B.STATUS_DRAW);
    }

    function test_fiftyMoveRule_autoDraw() public view {
        uint256 board = place(place(place(0, "a1", B.KING), "d4", B.ROOK), "h8", BK);
        State memory s = _position(board, metaOf(B.WHITE_SIDE, 0, B.NO_EP, 99, 150));
        State memory d = _next(s, uci("d4d5"));
        assertEq(B.halfmove(d.meta), 100);
        assertEq(B.status(d.meta), B.STATUS_DRAW);
    }

    function test_fiftyMoveRule_checkmateStillWins() public view {
        uint256 board = place(place(place(0, "g6", B.KING), "a7", B.QUEEN), "h8", BK);
        State memory s = _position(board, metaOf(B.WHITE_SIDE, 0, B.NO_EP, 99, 150));
        State memory w = _next(s, uci("a7g7"));
        assertEq(B.status(w.meta), B.STATUS_WHITE_WON);
        assertEq(w.balanceA, DEPOSIT + STAKE);
        assertEq(w.balanceB, DEPOSIT - STAKE);
    }

    function test_plyCap_autoDraw() public view {
        uint256 board = place(place(place(0, "a1", B.KING), "d4", B.ROOK), "h8", BK);
        State memory s = _position(board, metaOf(B.WHITE_SIDE, 0, B.NO_EP, 0, 299));
        State memory d = _next(s, uci("d4d5"));
        assertEq(B.ply(d.meta), 300);
        assertEq(B.status(d.meta), B.STATUS_DRAW);
    }

    function test_forfeitBalances_playerOnMoveLoses() public view {
        State memory s0 = _opening();
        (uint256 a, uint256 b) = rules.forfeitBalances(s0, p);
        assertEq(a, DEPOSIT - STAKE);
        assertEq(b, DEPOSIT + STAKE);
        State memory s1 = _next(s0, uci("e2e4"));
        (a, b) = rules.forfeitBalances(s1, p);
        assertEq(a, DEPOSIT + STAKE);
        assertEq(b, DEPOSIT - STAKE);
    }

    function test_noneKindNeverValid() public view {
        (bool ok,) = rules.successor(_opening(), 0, p);
        assertFalse(ok);
    }

    function test_gas_claimStalemate() public view {
        uint256 board = place(place(place(0, "h8", BK), "f7", B.QUEEN), "g6", B.KING);
        State memory s = _position(board, metaOf(B.BLACK_SIDE, 0, B.NO_EP, 0, 40));
        State memory d = _next(s, _kind(B.KIND_CLAIM_STALEMATE));
        uint256 before = gasleft();
        bool ok = rules.validTransition(s, d, p);
        console2.log("validTransition(CLAIM_STALEMATE) gas:", before - gasleft());
        assertTrue(ok);
    }
}
