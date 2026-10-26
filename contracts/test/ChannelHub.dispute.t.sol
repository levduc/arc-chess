// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {console2, Vm} from "forge-std/Test.sol";
import {Params, State, SignedState} from "../src/ArenaTypes.sol";
import {ChannelHub} from "../src/ChannelHub.sol";
import {ChessBoard as B} from "../src/chess/ChessBoard.sol";
import {HubFixture} from "./helpers/HubFixture.sol";
import {AcceptAllERC1271} from "./helpers/AcceptAllERC1271.sol";

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

    /// respond's deadline check is `>=`: it must revert DeadlinePassed both exactly at the deadline and
    /// after it, never just strictly after (mutation-review F12).
    function test_respond_revertsDeadlinePassed_atAndAfterDeadline() public {
        _challengeS1();
        uint64 deadline = hub.channelInfo(id).deadline;
        bytes memory proof = _moveProof(s1, "", "", s2, "", _sign(bobKey, s2));

        vm.warp(deadline);
        vm.expectRevert(ChannelHub.DeadlinePassed.selector);
        hub.respond(proof);

        vm.warp(deadline + 1);
        vm.expectRevert(ChannelHub.DeadlinePassed.selector);
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
        hub.closeCooperative(abi.encode(_ss(t, _signClose(aliceKey, t), _signClose(bobKey, t))));
        assertEq(uint8(hub.channelInfo(id).phase), uint8(ChannelHub.Phase.Finalized));
    }

    function test_closeCooperative_revertsWhenStaleAfterRegistered() public {
        _challengeS1(); // s1 registered, turnNum 1
        bytes memory data = abi.encode(_ss(s0, _signClose(aliceKey, s0), _signClose(bobKey, s0)));
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

    /// Game 0 ends (bob resigns after 1.e4) and both co-sign NEW_GAME; game 1 opens with bob (white) 1.e4.
    function _game1() internal view returns (State memory ng, State memory g1) {
        State memory t = _play(s1, p, _kind(B.KIND_RESIGN));
        ng = _play(t, p, _kind(B.KIND_NEW_GAME));
        g1 = _play(ng, p, uci("e2e4"));
    }

    /// T10a: a NEW_GAME prev needs both signatures (or registration); the non-mover's alone is not enough.
    function test_challenge_newGamePrevNeedsBothSignatures() public {
        (State memory ng, State memory g1) = _game1();
        bytes memory g1Sig = _sign(bobKey, g1);
        bytes memory ngSigA = _sign(aliceKey, ng);
        bytes memory ngSigB = _sign(bobKey, ng);
        bytes memory nonMoverOnly = _moveProof(ng, ngSigA, "", g1, "", g1Sig);
        bytes memory coSigned = _moveProof(ng, ngSigA, ngSigB, g1, "", g1Sig);

        vm.prank(bob);
        vm.expectRevert(ChannelHub.Unsupported.selector);
        hub.challenge(nonMoverOnly);

        vm.prank(bob);
        hub.challenge(coSigned);
        assertEq(hub.registeredState(id).turnNum, g1.turnNum);
    }

    /// M5: respond with a co-signed NEW_GAME, then after the challenger's cooldown a timeout in game 1
    /// forfeits bob, who is white (on move) in odd-indexed games.
    function test_respond_withNewGameCheckpoint_thenCooldown_thenTimeoutInGame1() public {
        (State memory ng,) = _game1();
        bytes memory ngProof = _soloProof(ng, _sign(aliceKey, ng), _sign(bobKey, ng));
        _challengeS1();
        hub.respond(ngProof);
        assertEq(hub.registeredState(id).gameIndex, 1);
        assertEq(uint8(hub.channelInfo(id).phase), uint8(ChannelHub.Phase.Open));
        uint64 cooldownEnd = hub.channelInfo(id).cooldownUntil[0];
        assertEq(cooldownEnd, block.timestamp + TIMEOUT);

        vm.prank(alice);
        vm.expectRevert(ChannelHub.InCooldown.selector);
        hub.challenge(ngProof);

        vm.warp(cooldownEnd);
        vm.prank(alice);
        hub.challenge(ngProof); // identical to the registered checkpoint
        uint64 deadline = hub.channelInfo(id).deadline;
        assertEq(deadline, cooldownEnd + TIMEOUT);
        vm.warp(deadline);
        hub.timeout(id);
        assertEq(usdc.balanceOf(alice), 100e6 - FEE + 2 * STAKE);
        assertEq(usdc.balanceOf(bob), 100e6 - FEE - 2 * STAKE);
        assertEq(usdc.balanceOf(address(hub)), 0);
    }

    // ------------------------------------------------- I1: no unchecked signature bytes are stored or emitted
    // Regression for audit finding I1 (2026-10-23 arc-launch audit, ArcFindings.t.sol PoC). `challenge` and
    // `respond` re-emit `proof.latest` verbatim, so every non-empty slot in it must be a valid signature by its
    // own signer; a slot the support rule does not need may only be empty.

    /// @dev The SignedState that the one `Challenged`/`Responded` log of the last call carried.
    function _emittedSignedState(Vm.Log[] memory logs) internal pure returns (SignedState memory) {
        assertEq(logs.length, 1);
        bytes memory enc;
        if (logs[0].topics[0] == ChannelHub.Responded.selector) {
            (, enc) = abi.decode(logs[0].data, (uint64, bytes));
        } else {
            assertEq(logs[0].topics[0], ChannelHub.Challenged.selector);
            (,, enc) = abi.decode(logs[0].data, (uint64, uint64, bytes));
        }
        return abi.decode(enc, (SignedState));
    }

    /// The PoC's scenario: Alice offers a draw and challenges; Bob answers with ACCEPT_DRAW (terminal, free for
    /// him) and puts bytes in ALICE's slot. Before the fix the hub accepted and emitted them, the shipped SDK
    /// stored them, and its `hasPrev:false` proof then reverted `Unsupported` forever. Now the junk is refused;
    /// the clean answer is accepted, its event carries only Bob's signature, and the proof the SDK builds from
    /// that event settles.
    function test_I1_respond_rejectsUncheckedBytesInNonMoverSlot() public {
        State memory d1 = _play(s0, p, uciKind("e2e4", B.KIND_NORMAL_OFFER_DRAW));
        bytes memory d1SigA = _sign(aliceKey, d1);
        bytes memory ch = _moveProof(s0, "", "", d1, d1SigA, "");
        vm.prank(alice);
        hub.challenge(ch);

        State memory d2 = _play(d1, p, _kind(B.KIND_ACCEPT_DRAW));
        bytes memory d2SigB = _sign(bobKey, d2);
        bytes memory big = new bytes(4096);
        big[0] = 0x01;
        // One byte; 4 KB; Bob's valid signature, but in Alice's slot; Alice's valid signature, but over d1.
        bytes[4] memory junk = [bytes(hex"01"), big, d2SigB, d1SigA];
        for (uint256 i; i < junk.length; ++i) {
            bytes memory bad = _moveProof(d1, d1SigA, "", d2, junk[i], d2SigB);
            vm.expectRevert(ChannelHub.BadSignature.selector);
            hub.respond(bad);
        }
        assertEq(uint8(hub.channelInfo(id).phase), uint8(ChannelHub.Phase.Challenged));

        bytes memory clean = _moveProof(d1, d1SigA, "", d2, "", d2SigB);
        vm.recordLogs();
        vm.prank(bob);
        hub.respond(clean);
        SignedState memory emitted = _emittedSignedState(vm.getRecordedLogs());
        assertEq(emitted.sigA.length, 0, "the unverified slot is emitted empty");
        assertEq(keccak256(emitted.sigB), keccak256(d2SigB));

        // Bob walks away. After her cooldown Alice proves the emitted state the way the SDK does: one slot is
        // empty, so it is `{prev: d1 (her signature), latest: emitted}`.
        vm.warp(block.timestamp + TIMEOUT);
        bytes memory sdkProof = _moveProof(d1, d1SigA, "", emitted.state, emitted.sigA, emitted.sigB);
        vm.prank(alice);
        hub.challenge(sdkProof);
        vm.warp(block.timestamp + TIMEOUT);
        hub.timeout(id);
        assertEq(usdc.balanceOf(alice), 100e6 - FEE);
        assertEq(usdc.balanceOf(bob), 100e6 - FEE);
    }

    /// Same vector through `challenge` (the audit's 200 KB gas-asymmetry case): bytes in the non-mover slot of a
    /// move proof are refused before anything is registered or emitted.
    function test_I1_challenge_rejectsUncheckedBytesInNonMoverSlot() public {
        bytes memory junk = new bytes(200_000);
        junk[0] = 0x01;
        bytes memory bad = _moveProof(s0, "", "", s1, _sign(aliceKey, s1), junk);
        vm.prank(alice);
        vm.expectRevert(ChannelHub.BadSignature.selector);
        hub.challenge(bad);
        assertEq(uint8(hub.channelInfo(id).phase), uint8(ChannelHub.Phase.Open));
        assertFalse(hub.channelInfo(id).hasRegistered);
    }

    /// The opening needs no signatures, so it is supported only with both slots empty (or, through the
    /// both-signed rule, both valid). Before the fix any bytes rode along unchecked.
    function test_I1_openingChallenge_rejectsUncheckedBytes() public {
        bytes memory junk = new bytes(1000);
        bytes memory sA = _sign(aliceKey, s0);
        bytes[4] memory bad =
            [_soloProof(s0, junk, junk), _soloProof(s0, junk, ""), _soloProof(s0, "", junk), _soloProof(s0, sA, junk)];
        for (uint256 i; i < bad.length; ++i) {
            vm.prank(bob);
            vm.expectRevert(ChannelHub.Unsupported.selector);
            hub.challenge(bad[i]);
        }
        bytes memory clean = _soloProof(s0, "", "");
        vm.recordLogs();
        vm.prank(bob);
        hub.challenge(clean);
        SignedState memory emitted = _emittedSignedState(vm.getRecordedLogs());
        assertEq(emitted.sigA.length + emitted.sigB.length, 0);
        assertEq(uint8(hub.channelInfo(id).phase), uint8(ChannelHub.Phase.Challenged));
    }

    /// A co-signed opening is still supported (spec §12 item 11), so the invariant handler's both-signed
    /// opening proof keeps working.
    function test_I1_coSignedOpening_stillSupported() public {
        bytes memory proof = _soloProof(s0, _sign(aliceKey, s0), _sign(bobKey, s0));
        vm.prank(bob);
        hub.challenge(proof);
        assertEq(uint8(hub.channelInfo(id).phase), uint8(ChannelHub.Phase.Challenged));
        assertEq(hub.channelInfo(id).registeredHash, hub.hashState(s0));
    }

    /// A move proof whose latest also carries the non-mover's VALID co-signature (spec §12 items 11 and 14) is
    /// still accepted, and the event keeps both signatures, so a client can later prove it with no `prev`.
    function test_I1_validNonMoverCoSignature_acceptedAndEmitted() public {
        _challengeS1();
        bytes memory s2SigA = _sign(aliceKey, s2);
        bytes memory s2SigB = _sign(bobKey, s2);
        bytes memory proof = _moveProof(s1, "", "", s2, s2SigA, s2SigB);
        vm.recordLogs();
        hub.respond(proof);
        SignedState memory emitted = _emittedSignedState(vm.getRecordedLogs());
        assertEq(keccak256(emitted.sigA), keccak256(s2SigA));
        assertEq(keccak256(emitted.sigB), keccak256(s2SigB));

        vm.warp(block.timestamp + TIMEOUT);
        bytes memory solo = _soloProof(emitted.state, emitted.sigA, emitted.sigB);
        vm.prank(bob);
        hub.challenge(solo);
        assertEq(hub.registeredState(id).turnNum, 2);
    }

    // Final review A I-1 (owner decision 2026-10-25): the hub verifies ECDSA only. Before, a signer whose code accepts
    // any bytes (a contract, or a session key under an EIP-7702 delegation, which Arc supports) could put junk in its
    // own slot: the hub accepted it through ERC-1271, and no client could verify it. The review's PoC used that to
    // lock a channel that only the griefer could unlock.

    /// The review's PoC (`LockPoC.t.sol`), now a regression: the griefer's signer is an accept-anything contract.
    function test_ecdsaOnly_acceptAllSigner_junkRefused() public {
        AcceptAllERC1271 griefSigner = new AcceptAllERC1271();
        Params memory g = _params();
        g.signers[1] = address(griefSigner); // bob = griefer
        bytes32 gid = _open(g);
        State memory g0 = rules.initialState(gid, g);
        State memory g1 = _play(g0, g, uci("e2e4")); // alice's move, relayed with her ECDSA signature
        bytes memory a1 = _sign(aliceKey, g1);
        State memory g2 = _play(g1, g, uci("e7e5")); // bob's move, "signed" with one byte no client can verify
        bytes memory chal = _moveProof(g1, a1, "", g2, "", hex"01");
        vm.prank(bob);
        vm.expectRevert(ChannelHub.BadSignature.selector);
        hub.challenge(chal);

        // Nor can junk ride in his slot next to Alice's real signature: as a non-mover co-signature, or on a
        // both-signed state.
        bytes memory coSigned = _moveProof(g0, "", "", g1, a1, hex"02");
        vm.prank(bob);
        vm.expectRevert(ChannelHub.BadSignature.selector);
        hub.challenge(coSigned);
        bytes memory solo = _soloProof(g1, a1, hex"02");
        vm.prank(bob);
        vm.expectRevert(ChannelHub.Unsupported.selector);
        hub.challenge(solo);
        assertFalse(hub.channelInfo(gid).hasRegistered);

        // Alice's own exit works as for any channel: her move, endorsed by the opening.
        bytes memory exit = _moveProof(g0, "", "", g1, a1, "");
        vm.prank(alice);
        hub.challenge(exit);
        vm.warp(block.timestamp + TIMEOUT);
        uint256 before = usdc.balanceOf(alice);
        hub.timeout(gid);
        assertEq(usdc.balanceOf(alice), before + DEPOSIT + STAKE); // bob, on move, forfeits
    }

    /// A session key under an EIP-7702 delegation keeps working with real ECDSA signatures (they are checked against
    /// its address), while the junk its delegate would accept is refused. Modelled by etching accept-anything code
    /// onto Bob's session key, as `ChannelHub.erc1271.t.sol` does for ruling R13.
    function test_ecdsaOnly_delegatedSessionKey_realSignaturesOnly() public {
        vm.etch(bobSigner, type(AcceptAllERC1271).runtimeCode);
        assertGt(bobSigner.code.length, 0);
        bytes memory s1SigA = _sign(aliceKey, s1);
        bytes memory junk = _moveProof(s1, s1SigA, "", s2, "", hex"01");
        vm.prank(bob);
        vm.expectRevert(ChannelHub.BadSignature.selector);
        hub.challenge(junk);
        bytes memory s2SigB = _sign(bobKey, s2);
        bytes memory real = _moveProof(s1, s1SigA, "", s2, "", s2SigB);
        vm.prank(bob);
        hub.challenge(real);
        assertEq(hub.registeredState(id).turnNum, 2);

        // The PoC's lock is gone. Alice answers with s3 and Bob goes silent: the proof her SDK builds from his
        // verified signature on s2 (the event's) is accepted, and Bob, on move, forfeits.
        bytes memory s3SigA = _sign(aliceKey, s3);
        bytes memory answer = _moveProof(s2, "", "", s3, s3SigA, "");
        vm.prank(alice);
        hub.respond(answer);
        bytes memory fromEvent = _moveProof(s2, "", s2SigB, s3, s3SigA, "");
        vm.prank(alice);
        hub.challenge(fromEvent);
        assertEq(hub.registeredState(id).turnNum, 3);
        vm.warp(block.timestamp + TIMEOUT);
        hub.timeout(id);
        assertEq(usdc.balanceOf(alice), 100e6 - FEE + STAKE);
        assertEq(usdc.balanceOf(bob), 100e6 - FEE - STAKE);
    }

    /// The same for `closeCooperative`: the delegated key's junk Close signature is refused, its real one closes.
    function test_ecdsaOnly_delegatedSessionKey_closeNeedsRealSignature() public {
        vm.etch(bobSigner, type(AcceptAllERC1271).runtimeCode);
        bytes memory junk = abi.encode(_ss(s0, _signClose(aliceKey, s0), hex"01"));
        vm.expectRevert(ChannelHub.BadSignature.selector);
        hub.closeCooperative(junk);
        bytes memory real = abi.encode(_ss(s0, _signClose(aliceKey, s0), _signClose(bobKey, s0)));
        hub.closeCooperative(real);
        assertEq(uint8(hub.channelInfo(id).phase), uint8(ChannelHub.Phase.Finalized));
    }

    /// The hub's ECDSA rule is OpenZeppelin's: a high-s twin of a valid signature, or v as 0/1, is refused, though the
    /// same key made it. The SDK refuses both too (`session.ts` `signedBy`), so it never stores one the hub refuses.
    function test_ecdsaOnly_malleableFormsRefused() public {
        _challengeS1();
        bytes32 h = hub.hashState(s2);
        (uint8 v, bytes32 r, bytes32 sg) = vm.sign(bobKey, h);
        uint256 n = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
        bytes[2] memory bad =
            [abi.encodePacked(r, bytes32(n - uint256(sg)), v == 27 ? uint8(28) : uint8(27)), abi.encodePacked(r, sg, v - 27)];
        assertEq(ecrecover(h, v == 27 ? 28 : 27, r, bytes32(n - uint256(sg))), bobSigner, "the twin is a valid ecrecover");
        for (uint256 i; i < bad.length; ++i) {
            bytes memory proof = _moveProof(s1, "", "", s2, "", bad[i]);
            vm.expectRevert(ChannelHub.BadSignature.selector);
            hub.respond(proof);
        }
        bytes memory good = _moveProof(s1, "", "", s2, "", abi.encodePacked(r, sg, v));
        hub.respond(good);
        assertEq(hub.registeredState(id).turnNum, 2);
    }
}
