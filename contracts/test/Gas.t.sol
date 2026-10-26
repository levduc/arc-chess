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
///
/// Fix round 2 (see task-4-report.md): the original "worst case" position here (`_denseStalemate`, still kept
/// below purely as a documented comparison point) turned out to cost only ~13% more than the minimal
/// textbook K+Q-vs-K stalemate, because ChessMoves._pieceHasMove's sliding-piece rays stop at the
/// first occupied square -- packing more pieces close together mostly adds *cheap* early-outs (a same-colour
/// blocker ends the ray immediately, before the expensive kingSquare/isSquareAttacked check), not expensive
/// ones. `_heaviestFoundStalemate` fixes that: it pins several long-range sliders with mostly-empty rays, so
/// each of their many geometrically-open candidate squares still has to run the full expensive check before
/// being rejected as unsafe.
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

    /// @dev The minimal textbook stalemate (black to move): lone king boxed by a queen and king. Baseline
    /// for the comparison in test_gas_validTransition_minimalVsDenseVsHeaviest -- same position used in
    /// ChannelHub.dispute.t.sol's test_claimStalemate_viaRespond.
    function _minimalStalemate() internal view returns (State memory st, State memory claimState) {
        uint256 board = place(place(place(0, "h8", BK), "f7", B.QUEEN), "g6", B.KING);
        st.channelId = id;
        st.turnNum = 40;
        st.balanceA = DEPOSIT;
        st.balanceB = DEPOSIT;
        st.gameIndex = 0;
        st.board = board;
        st.meta = metaOf(B.BLACK_SIDE, 0, B.NO_EP, 0, 39);
        claimState = _play(st, p, _kind(B.KIND_CLAIM_STALEMATE));
    }

    /// @dev Fix round 2: kept only as a *documented comparison point*, not as the budget's load-bearing
    /// case -- see this file's top comment. 28 of the 32 real chess piece counts on the board: white at full
    /// strength (K, Q, 2R, 2N, 2B, 8P) and black missing only its queen, one rook and one knight (K, R, 2B,
    /// 8P = 12 pieces). It is not from a real game and is not claimed to be reachable by legal play (e.g.
    /// black's two same-square-colour bishops, together with its full complement of pawns, could never arise
    /// from real promotions) -- but ChannelHub never validates material on a co-signed state (a signed `prev`
    /// is trusted at face value; see `_supported`'s both-signed branch), so any board a real deployment could
    /// ever be asked to run `validTransition` against is fair game, exactly like the other synthetic,
    /// non-reachable positions in ChessMovesTerminal.t.sol.
    function _denseStalemate() internal view returns (State memory st, State memory claimState) {
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
        st.meta = metaOf(B.BLACK_SIDE, 0, B.NO_EP, 0, 59);
        claimState = _play(st, p, _kind(B.KIND_CLAIM_STALEMATE));
    }

    /// @dev Fix round 2: the load-bearing "worst case we found" position, hand-composed from four pins and
    /// verified against chess.js 1.4.0 (not from a real game; see _denseStalemate's comment for why an
    /// unreachable board is still fair game here). Black (the mover) has a king, two rooks and two bishops:
    ///
    ///  - Both black rooks (c6, f7) are pinned *diagonally* to the black king at e8 (by the white bishops at
    ///    a4 and h5 respectively). A rook has no diagonal moves at all, so every one of its rank/file moves
    ///    goes off the pin line and exposes the king -- and with nothing else on ranks 6/7 or files c/f, each
    ///    rook still has up to 14 geometrically-open candidate squares (7 per direction) that ChessMoves must
    ///    individually run through the full expensive check (compute the resulting board, find the king, and
    ///    scan for an attacker) before rejecting as unsafe.
    ///  - Both black bishops (e5, c8) are pinned orthogonally to the same king (by the white rook at e1 down
    ///    file e, and the white rook at a8 along rank 8). A bishop has no rank/file moves, so every diagonal
    ///    move similarly exposes the king, again with long, mostly-empty diagonals (up to 13 and 7 open
    ///    squares respectively).
    ///  - The king itself is boxed in the ordinary way: its five neighbours are either occupied by black's
    ///    own rook (f7) or attacked by the white queen (d1, covering d7/d8 down file d) and the white knight
    ///    (g8, covering e7) and the white pawn (g7, covering f8).
    ///
    /// Unlike a simple adjacent pin, none of these pinned pieces can just capture their pinner to escape:
    /// they are several squares away from it, so every square *between* piece and pinner is also a legal-
    /// looking (but check-exposing) destination, which is exactly what keeps the rays long instead of short.
    /// This is the heaviest CLAIM_STALEMATE position this task found; it is not claimed to be the global
    /// maximum (that would need a search over the full pin/discovered-check space), only meaningfully
    /// heavier than the two positions above, which the comparison test below asserts as a regression guard.
    function _heaviestFoundStalemate() internal view returns (State memory st, State memory claimState) {
        uint256 board = 0;
        board = place(board, "h1", B.KING);
        board = place(board, "d1", B.QUEEN);
        board = place(board, "e1", B.ROOK);
        board = place(board, "a4", B.BISHOP);
        board = place(board, "h5", B.BISHOP);
        board = place(board, "g7", B.PAWN);
        board = place(board, "g8", B.KNIGHT);
        board = place(board, "a8", B.ROOK);
        board = place(board, "e8", BK);
        board = place(board, "c6", BR);
        board = place(board, "f7", BR);
        board = place(board, "e5", BB);
        board = place(board, "c8", BB);

        st.channelId = id;
        st.turnNum = 40;
        st.balanceA = DEPOSIT;
        st.balanceB = DEPOSIT;
        st.gameIndex = 0;
        st.board = board;
        st.meta = metaOf(B.BLACK_SIDE, 0, B.NO_EP, 0, 59);
        claimState = _play(st, p, _kind(B.KIND_CLAIM_STALEMATE));
    }

    /// @dev rules.successor's KIND_CLAIM_STALEMATE branch is exactly the check ChannelHub relies on
    /// (`!inCheck && !hasLegalMove`), so calling it via `_play` inside each `_*Stalemate` helper above (which
    /// `require`s success) is itself the legality proof for that position, not just a chess.js claim.
    function test_gas_validTransition_minimalVsDenseVsHeaviest() public view {
        (State memory st0, State memory c0) = _minimalStalemate();
        uint256 before0 = gasleft();
        bool ok0 = rules.validTransition(st0, c0, p);
        uint256 usedMinimal = before0 - gasleft();

        (State memory st1, State memory c1) = _denseStalemate();
        uint256 before1 = gasleft();
        bool ok1 = rules.validTransition(st1, c1, p);
        uint256 usedDense = before1 - gasleft();

        (State memory st2, State memory c2) = _heaviestFoundStalemate();
        uint256 before2 = gasleft();
        bool ok2 = rules.validTransition(st2, c2, p);
        uint256 usedHeaviest = before2 - gasleft();

        console2.log("validTransition(CLAIM_STALEMATE, minimal K+Q-vs-K)   gas:", usedMinimal);
        console2.log("validTransition(CLAIM_STALEMATE, dense 28-piece)     gas:", usedDense);
        console2.log("validTransition(CLAIM_STALEMATE, heaviest found)     gas:", usedHeaviest);

        assertTrue(ok0);
        assertTrue(ok1);
        assertTrue(ok2);
        // Regression guard, not just a comment: the heaviest-found position must stay far heavier than the
        // dense one, so if a future change to ChessMoves ever collapses that gap, this test should fail and
        // point back here. (The dense-vs-minimal gap documented above -- ~10%, matching the fix round 2
        // review's finding -- is not asserted: it's an observation about this specific dense position, not
        // a property the codebase needs to guarantee, and a legitimate ChessMoves optimization could
        // legitimately narrow or widen it without that being a regression.)
        assertGt(usedHeaviest, usedDense * 3, "heaviest-found should be far heavier than the dense position");
        assertLt(usedHeaviest, GAS_BUDGET, "validTransition must stay well under 30% of the block gas limit");
    }

    function test_gas_challenge_heaviestFoundClaimStalemate() public {
        (State memory st, State memory claimState) = _heaviestFoundStalemate();
        // Both co-sign `st` directly (the "solo/both-signed" endorsement path, spec §4.3) so this challenge
        // exercises the hasPrev branch -- and therefore rules.validTransition -- on the very first call.
        bytes memory proof =
            _moveProof(st, _sign(aliceKey, st), _sign(bobKey, st), claimState, "", _sign(bobKey, claimState));

        vm.prank(alice);
        uint256 before = gasleft();
        hub.challenge(proof);
        uint256 used = before - gasleft();
        console2.log("challenge(CLAIM_STALEMATE, heaviest found) gas:", used);
        assertLt(used, GAS_BUDGET, "challenge must stay well under 30% of the block gas limit");
        assertEq(uint8(hub.channelInfo(id).phase), uint8(ChannelHub.Phase.Challenged));
        assertEq(hub.registeredState(id).turnNum, claimState.turnNum);
    }

    function test_gas_respond_heaviestFoundClaimStalemate() public {
        // Reach Challenged phase cheaply first (a plain 1.e4), so `respond` below is answering a real
        // challenge rather than being the channel's first on-chain call.
        State memory s0 = rules.initialState(id, p);
        State memory s1 = _play(s0, p, uci("e2e4"));
        // Build the proof (which staticcalls hub.hashState via _sign) before arming vm.prank: that cheatcode
        // binds to the very next external call, staticcalls included (see HubHandler.sol's note).
        bytes memory openingProof = _moveProof(s0, "", "", s1, _sign(aliceKey, s1), "");
        vm.prank(alice);
        hub.challenge(openingProof);

        (State memory st, State memory claimState) = _heaviestFoundStalemate();
        bytes memory proof =
            _moveProof(st, _sign(aliceKey, st), _sign(bobKey, st), claimState, "", _sign(bobKey, claimState));

        uint256 before = gasleft();
        hub.respond(proof);
        uint256 used = before - gasleft();
        console2.log("respond(CLAIM_STALEMATE, heaviest found) gas:", used);
        assertLt(used, GAS_BUDGET, "respond must stay well under 30% of the block gas limit");
        assertEq(uint8(hub.channelInfo(id).phase), uint8(ChannelHub.Phase.Open));
        assertEq(hub.registeredState(id).turnNum, claimState.turnNum);
    }

    /// I1: the heaviest honest move proof now also carries the non-mover's co-signature in `latest`, which the
    /// hub verifies (one more signature check) because it re-emits that slot.
    function test_gas_respond_heaviestFoundClaimStalemate_coSignedLatest() public {
        State memory s0 = rules.initialState(id, p);
        State memory s1 = _play(s0, p, uci("e2e4"));
        bytes memory openingProof = _moveProof(s0, "", "", s1, _sign(aliceKey, s1), "");
        vm.prank(alice);
        hub.challenge(openingProof);

        (State memory st, State memory claimState) = _heaviestFoundStalemate();
        bytes memory coSig = _sign(aliceKey, claimState);
        bytes memory proof =
            _moveProof(st, _sign(aliceKey, st), _sign(bobKey, st), claimState, coSig, _sign(bobKey, claimState));

        uint256 before = gasleft();
        hub.respond(proof);
        uint256 used = before - gasleft();
        console2.log("respond(CLAIM_STALEMATE, heaviest found, co-signed latest) gas:", used);
        assertLt(used, GAS_BUDGET, "respond must stay well under 30% of the block gas limit");
        assertEq(hub.registeredState(id).turnNum, claimState.turnNum);
    }
}
