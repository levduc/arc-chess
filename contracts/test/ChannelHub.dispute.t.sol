// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {console2} from "forge-std/Test.sol";
import {Params, State} from "../src/ArenaTypes.sol";
import {ChannelHub} from "../src/ChannelHub.sol";
import {ChessBoard as B} from "../src/chess/ChessBoard.sol";
import {HubFixture} from "./helpers/HubFixture.sol";

contract ChannelHubDisputeTest is HubFixture {
    Params internal p;
    bytes32 internal id;
    State internal s0; // opening, alice (white) to move
    State internal s1; // 1.e4 signed by alice, bob to move
    State internal s2; // 1...e5 signed by bob, alice to move
    State internal s3; // 2.Nf3 signed by alice, bob to move

    function setUp() public override {
        super.setUp();
        p = _params();
        id = _open(p);
        s0 = rules.initialState(id, p);
        s1 = _play(s0, p, uci("e2e4"));
        s2 = _play(s1, p, uci("e7e5"));
        s3 = _play(s2, p, uci("g1f3"));
    }

    // vm.prank/vm.expectRevert/vm.expectEmit bind to the very next external call, including
    // staticcalls made while evaluating arguments (e.g. hub.hashState() inside _sign()). So proofs
    // must be built into local variables *before* arming a cheatcode, leaving the hub call as the
    // only call after it.
    function _challengeS1() internal {
        bytes memory proof = _moveProof(s0, "", "", s1, _sign(aliceKey, s1), "");
        vm.prank(alice);
        hub.challenge(proof);
    }

    function _respondS2() internal {
        hub.respond(_moveProof(s1, "", "", s2, "", _sign(bobKey, s2)));
    }

    function test_challenge_thenTimeout_forfeitsPlayerOnMove() public {
        _challengeS1();
        ChannelHub.ChannelInfo memory info = hub.channelInfo(id);
        assertEq(uint8(info.phase), uint8(ChannelHub.Phase.Challenged));
        assertEq(info.challenger, 0);
        assertEq(info.deadline, block.timestamp + TIMEOUT);

        vm.warp(info.deadline);
        hub.timeout(id);
        assertEq(usdc.balanceOf(alice), 100e6 - FEE + STAKE);
        assertEq(usdc.balanceOf(bob), 100e6 - FEE - STAKE);
        assertEq(usdc.balanceOf(feeRecipient), 2 * FEE);
    }

    function test_deadlineBoundary() public {
        _challengeS1();
        uint64 deadline = hub.channelInfo(id).deadline;
        vm.warp(deadline - 1);
        vm.expectRevert(ChannelHub.TooEarly.selector);
        hub.timeout(id);
        vm.warp(deadline);
        bytes memory proof = _moveProof(s1, "", "", s2, "", _sign(bobKey, s2));
        vm.expectRevert(ChannelHub.DeadlinePassed.selector);
        hub.respond(proof);
        hub.timeout(id);
    }

    function test_respond_returnsToOpen_andSetsChallengerCooldown() public {
        _challengeS1();
        bytes memory respondProof = _moveProof(s1, "", "", s2, "", _sign(bobKey, s2));
        bytes memory expectedEvent = abi.encode(_ss(s2, "", _sign(bobKey, s2)));
        vm.expectEmit(true, false, false, true, address(hub));
        emit ChannelHub.Responded(id, 2, expectedEvent);
        hub.respond(respondProof);

        ChannelHub.ChannelInfo memory info = hub.channelInfo(id);
        assertEq(uint8(info.phase), uint8(ChannelHub.Phase.Open));
        assertEq(info.cooldownUntil[0], block.timestamp + TIMEOUT);
        assertEq(info.cooldownUntil[1], 0);
        assertEq(hub.registeredState(id).turnNum, 2);

        // Alice plays on off-chain from the on-chain state, then tries to challenge again too soon.
        bytes memory proof = _moveProof(s2, "", "", s3, _sign(aliceKey, s3), "");
        vm.prank(alice);
        vm.expectRevert(ChannelHub.InCooldown.selector);
        hub.challenge(proof);

        vm.warp(block.timestamp + TIMEOUT);
        vm.prank(alice);
        hub.challenge(proof);
        assertEq(hub.registeredState(id).turnNum, 3);
    }

    function test_waitingPlayerCanChallengeTheRegisteredState() public {
        _challengeS1();
        _respondS2(); // registered s2: alice to move; bob is waiting and not in cooldown
        // Re-submitting the identical registered state (same turnNum, same hash) is allowed.
        bytes memory proof = _moveProof(s1, _sign(aliceKey, s1), "", s2, "", _sign(bobKey, s2));
        vm.prank(bob);
        hub.challenge(proof);
        assertEq(hub.channelInfo(id).challenger, 1);
        assertEq(uint8(hub.channelInfo(id).phase), uint8(ChannelHub.Phase.Challenged));
    }

    function test_challenge_rejectsEquivocation() public {
        _challengeS1();
        _respondS2();
        // Bob also signed a different reply at the same turn; it must not replace the registered one.
        State memory s2b = _play(s1, p, uci("c7c5"));
        bytes memory proof = _moveProof(s1, _sign(aliceKey, s1), "", s2b, "", _sign(bobKey, s2b));
        vm.prank(bob);
        vm.expectRevert(ChannelHub.StaleState.selector);
        hub.challenge(proof);
    }

    function test_challenge_bySessionKey() public {
        bytes memory proof = _moveProof(s0, "", "", s1, _sign(aliceKey, s1), "");
        vm.prank(aliceSigner);
        hub.challenge(proof);
        assertEq(hub.channelInfo(id).challenger, 0);
    }

    function test_challenge_revertsForStranger() public {
        bytes memory proof = _moveProof(s0, "", "", s1, _sign(aliceKey, s1), "");
        vm.prank(makeAddr("mallory"));
        vm.expectRevert(ChannelHub.NotParticipant.selector);
        hub.challenge(proof);
    }

    function test_challenge_revertsWrongMoverSignature() public {
        bytes memory proof = _moveProof(s0, "", "", s1, _sign(bobKey, s1), _sign(bobKey, s1));
        vm.prank(alice);
        vm.expectRevert(ChannelHub.BadSignature.selector);
        hub.challenge(proof);
    }

    function test_challenge_revertsIllegalTransition() public {
        State memory bad = s1;
        bad.board = place(bad.board, "d4", B.QUEEN);
        bytes memory proof = _moveProof(s0, "", "", bad, _sign(aliceKey, bad), "");
        vm.prank(alice);
        vm.expectRevert(ChannelHub.InvalidTransition.selector);
        hub.challenge(proof);
    }

    function test_challenge_revertsWhenPrevNotEndorsed() public {
        // s2 signed by bob with prev s1, but s1 carries no signature from alice and is not registered.
        bytes memory proof = _moveProof(s1, "", "", s2, "", _sign(bobKey, s2));
        vm.prank(bob);
        vm.expectRevert(ChannelHub.Unsupported.selector);
        hub.challenge(proof);
    }

    function test_challenge_movePairWithAliceSignedPrev() public {
        bytes memory proof = _moveProof(s1, _sign(aliceKey, s1), "", s2, "", _sign(bobKey, s2));
        vm.prank(bob);
        hub.challenge(proof);
        assertEq(hub.registeredState(id).turnNum, 2);
    }

    function test_challenge_revertsCheckpointWithSingleSignature() public {
        State memory t = _play(s1, p, _kind(B.KIND_RESIGN));
        State memory ng = _play(t, p, _kind(B.KIND_NEW_GAME));
        bytes memory soloProof = _soloProof(ng, _sign(aliceKey, ng), "");
        vm.prank(alice);
        vm.expectRevert(ChannelHub.Unsupported.selector);
        hub.challenge(soloProof);
        bytes memory moveProof = _moveProof(t, "", _sign(bobKey, t), ng, _sign(aliceKey, ng), "");
        vm.prank(alice);
        vm.expectRevert(ChannelHub.Unsupported.selector);
        hub.challenge(moveProof);
    }

    function test_respond_revertsStale() public {
        _challengeS1();
        bytes memory proof = _moveProof(s0, "", "", s1, _sign(aliceKey, s1), "");
        vm.expectRevert(ChannelHub.StaleState.selector);
        hub.respond(proof);
    }

    function test_timeout_onTerminalState_settlesAsIs() public {
        State memory t = _play(s1, p, _kind(B.KIND_RESIGN)); // bob resigned but refuses to co-sign close
        bytes memory proof = _moveProof(s1, _sign(aliceKey, s1), "", t, "", _sign(bobKey, t));
        vm.prank(alice);
        hub.challenge(proof);
        vm.warp(block.timestamp + TIMEOUT);
        hub.timeout(id);
        assertEq(usdc.balanceOf(alice), 100e6 - FEE + STAKE);
        assertEq(usdc.balanceOf(bob), 100e6 - FEE - STAKE);
    }

    function test_claimStalemate_viaRespond() public {
        uint8 bk = B.KING | B.BLACK;
        State memory st = s0;
        st.turnNum = 40;
        st.board = place(place(place(0, "h8", bk), "f7", B.QUEEN), "g6", B.KING);
        st.meta = metaOf(B.BLACK_SIDE, 0, B.NO_EP, 0, 39);
        bytes memory soloProof = _soloProof(st, _sign(aliceKey, st), _sign(bobKey, st));
        vm.prank(alice);
        hub.challenge(soloProof);

        State memory claimState = _play(st, p, _kind(B.KIND_CLAIM_STALEMATE));
        bytes memory respondProof = _moveProof(st, "", "", claimState, "", _sign(bobKey, claimState));
        uint256 before = gasleft();
        hub.respond(respondProof);
        console2.log("respond(CLAIM_STALEMATE) gas:", before - gasleft());
        assertEq(B.status(hub.registeredState(id).meta), B.STATUS_DRAW);
        assertEq(uint8(hub.channelInfo(id).phase), uint8(ChannelHub.Phase.Open));
    }

    function test_closeCooperative_allowedDuringChallenge() public {
        _challengeS1();
        State memory t = _play(s1, p, _kind(B.KIND_RESIGN));
        hub.closeCooperative(abi.encode(_ss(t, _sign(aliceKey, t), _sign(bobKey, t))));
        assertEq(uint8(hub.channelInfo(id).phase), uint8(ChannelHub.Phase.Finalized));
    }

    function test_closeCooperative_revertsWhenStaleAfterRegistered() public {
        _challengeS1(); // s1 registered, turnNum 1
        bytes memory data = abi.encode(_ss(s0, _sign(aliceKey, s0), _sign(bobKey, s0)));
        vm.expectRevert(ChannelHub.StaleState.selector);
        hub.closeCooperative(data);
    }

    function test_challenge_revertsWhenNotOpen() public {
        _challengeS1();
        bytes memory proof = _moveProof(s1, "", "", s2, "", _sign(bobKey, s2));
        vm.prank(bob);
        vm.expectRevert(ChannelHub.WrongPhase.selector);
        hub.challenge(proof);
    }
}
