// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {console2} from "forge-std/Test.sol";
import {Params, State} from "../src/ArenaTypes.sol";
import {ChannelHub} from "../src/ChannelHub.sol";
import {ChessBoard as B} from "../src/chess/ChessBoard.sol";
import {HubFixture} from "./helpers/HubFixture.sol";

/// @notice Gas budgets for mainnet launch (Plan 4.5 Task 4). Chess move generation (ChessMoves.hasLegalMove /
/// inCheck, invoked by ChessRules.successor for a CLAIM_STALEMATE claim) is the only cost in this system that
/// scales with board content rather than being O(1), so it is the one path worth a dedicated worst-case gas
/// test. Budget: 30% of a 30,000,000 block gas limit, per spec.
contract GasTest is HubFixture {
    uint256 internal constant GAS_BUDGET = 9_000_000; // 30% of 30,000,000

    uint8 internal constant BK = B.KING | B.BLACK;
    uint8 internal constant BB = B.BISHOP | B.BLACK;
    uint8 internal constant BR = B.ROOK | B.BLACK;
    uint8 internal constant BP = B.PAWN | B.BLACK;

    Params internal p;
    bytes32 internal id;

    function setUp() public override {
        super.setUp();
        p = _params();
        id = _open(p);
    }

    /// @dev A hand-composed stalemate for the side to move (black), verified against chess.js 1.4.0 by an
    /// offline randomized search. It is not from a real game and is not claimed to be reachable by legal
    /// play (e.g. black's two same-square-colour bishops, together with its full complement of pawns, could
    /// never arise from real promotions) -- but ChannelHub never validates material on a co-signed state (a
    /// signed `prev` is trusted at face value; see `_supported`'s both-signed branch), so any board a real
    /// deployment could ever be asked to run `validTransition` against is fair game here, exactly like the
    /// other synthetic, non-reachable positions in ChessMovesTerminal.t.sol. It puts 28 of the 32 real chess
    /// piece counts on the board: white at full strength (K, Q, 2R, 2N, 2B, 8P) and black missing only its
    /// queen, one rook and one knight (K, R, 2B, 8P = 12 pieces).
    ///
    /// Why this is near-worst for `hasLegalMove`/`inCheck` gas: a stalemate can never short-circuit on an
    /// early legal move (there is none), so `hasLegalMove` runs its full O(64) square scan and attempts move
    /// generation for every one of the 12 black pieces -- pawns, bishops, a rook and the king all exercised,
    /// not one degenerate piece type -- while `inCheck` separately scans the whole board for an attacker on
    /// the black king. That is materially more work than the minimal textbook K+Q-vs-K stalemate used
    /// elsewhere in the suite (ChannelHub.dispute.t.sol's test_claimStalemate_viaRespond). This is not claimed
    /// to be the global gas maximum -- that would require also maximizing how many empty squares each sliding
    /// piece can probe before its move is rejected as unsafe, which needs a dedicated pin/discovered-check
    /// search -- only a verified, materially heavier stalemate. Task 3's broader invariant/fuzz campaign
    /// remains the correctness safety net; this test only needs a comfortable margin under the gas budget.
    function _heavyStalemate() internal view returns (State memory st, State memory claimState) {
        uint256 board = 0;
        board = place(board, "a8", B.BISHOP);
        board = place(board, "f8", BB);
        board = place(board, "g8", BR);
        board = place(board, "h8", BK);
        board = place(board, "c7", BP);
        board = place(board, "e7", BP);
        board = place(board, "f7", B.QUEEN);
        board = place(board, "g7", BP);
        board = place(board, "h7", B.PAWN);
        board = place(board, "c6", B.PAWN);
        board = place(board, "e6", BP);
        board = place(board, "g6", B.KING);
        board = place(board, "d5", BP);
        board = place(board, "e5", B.PAWN);
        board = place(board, "a4", B.ROOK);
        board = place(board, "b4", B.PAWN);
        board = place(board, "d4", B.ROOK);
        board = place(board, "a3", B.KNIGHT);
        board = place(board, "b3", BP);
        board = place(board, "d3", B.KNIGHT);
        board = place(board, "e3", BP);
        board = place(board, "f3", B.PAWN);
        board = place(board, "g3", B.PAWN);
        board = place(board, "h3", B.PAWN);
        board = place(board, "b2", BP);
        board = place(board, "e2", B.PAWN);
        board = place(board, "a1", BB);
        board = place(board, "b1", B.BISHOP);

        st.channelId = id;
        st.turnNum = 40;
        st.balanceA = DEPOSIT;
        st.balanceB = DEPOSIT;
        st.gameIndex = 0;
        st.board = board;
        // Black to move, no castling rights, no en-passant square; halfmove/ply are irrelevant to
        // KIND_CLAIM_STALEMATE (ChessRules.successor never reads them on that branch).
        st.meta = metaOf(B.BLACK_SIDE, 0, B.NO_EP, 0, 59);

        // rules.successor's KIND_CLAIM_STALEMATE branch is exactly the check ChannelHub relies on
        // (`!inCheck && !hasLegalMove`), so a passing test *is* the proof that `st` is really a stalemate.
        claimState = _play(st, p, _kind(B.KIND_CLAIM_STALEMATE));
    }

    function test_gas_validTransition_claimStalemateWorstCase() public view {
        (State memory st, State memory claimState) = _heavyStalemate();
        uint256 before = gasleft();
        bool ok = rules.validTransition(st, claimState, p);
        uint256 used = before - gasleft();
        console2.log("validTransition(CLAIM_STALEMATE, heavy) gas:", used);
        assertTrue(ok);
        assertLt(used, GAS_BUDGET, "validTransition must stay well under 30% of the block gas limit");
    }

    function test_gas_challenge_claimStalemateWorstCase() public {
        (State memory st, State memory claimState) = _heavyStalemate();
        // Both co-sign `st` directly (the "solo/both-signed" endorsement path, spec §4.3) so this challenge
        // exercises the hasPrev branch -- and therefore rules.validTransition -- on the very first call.
        bytes memory proof =
            _moveProof(st, _sign(aliceKey, st), _sign(bobKey, st), claimState, "", _sign(bobKey, claimState));

        vm.prank(alice);
        uint256 before = gasleft();
        hub.challenge(proof);
        uint256 used = before - gasleft();
        console2.log("challenge(CLAIM_STALEMATE, heavy) gas:", used);
        assertLt(used, GAS_BUDGET, "challenge must stay well under 30% of the block gas limit");
        assertEq(uint8(hub.channelInfo(id).phase), uint8(ChannelHub.Phase.Challenged));
        assertEq(hub.registeredState(id).turnNum, claimState.turnNum);
    }

    function test_gas_respond_claimStalemateWorstCase() public {
        // Reach Challenged phase cheaply first (a plain 1.e4), so `respond` below is answering a real
        // challenge rather than being the channel's first on-chain call.
        State memory s0 = rules.initialState(id, p);
        State memory s1 = _play(s0, p, uci("e2e4"));
        // Build the proof (which staticcalls hub.hashState via _sign) before arming vm.prank: that cheatcode
        // binds to the very next external call, staticcalls included (see HubHandler.sol's note).
        bytes memory openingProof = _moveProof(s0, "", "", s1, _sign(aliceKey, s1), "");
        vm.prank(alice);
        hub.challenge(openingProof);

        (State memory st, State memory claimState) = _heavyStalemate();
        bytes memory proof =
            _moveProof(st, _sign(aliceKey, st), _sign(bobKey, st), claimState, "", _sign(bobKey, claimState));

        uint256 before = gasleft();
        hub.respond(proof);
        uint256 used = before - gasleft();
        console2.log("respond(CLAIM_STALEMATE, heavy) gas:", used);
        assertLt(used, GAS_BUDGET, "respond must stay well under 30% of the block gas limit");
        assertEq(uint8(hub.channelInfo(id).phase), uint8(ChannelHub.Phase.Open));
        assertEq(hub.registeredState(id).turnNum, claimState.turnNum);
    }
}
