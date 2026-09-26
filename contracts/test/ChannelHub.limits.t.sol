// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Params, State} from "../src/ArenaTypes.sol";
import {ChannelHub} from "../src/ChannelHub.sol";
import {ChessBoard as B} from "../src/chess/ChessBoard.sol";
import {HubFixture} from "./helpers/HubFixture.sol";

/// @notice Spec §13 launch limits: per-channel deposit cap, total commitment cap, deposit-only pause.
contract ChannelHubLimitsTest is HubFixture {
    function _resignedGame(Params memory p, bytes32 id) internal view returns (State memory s2) {
        State memory s1 = _play(rules.initialState(id, p), p, uci("e2e4"));
        s2 = _play(s1, p, _kind(B.KIND_RESIGN));
    }

    function _close(State memory s) internal {
        hub.closeCooperative(abi.encode(_ss(s, _signClose(aliceKey, s), _signClose(bobKey, s))));
    }

    function _pause() internal {
        vm.prank(owner);
        hub.setPaused(true);
    }

    // ------------------------------------------------------------- deposit cap

    function test_deposit_atCapSucceeds_capPlusOneReverts() public {
        vm.prank(owner);
        hub.setLimits(DEPOSIT, MAX_COMMITTED);

        Params memory p = _params(); // deposit == DEPOSIT == cap
        vm.prank(alice);
        hub.deposit(abi.encode(p));
        assertEq(uint8(hub.channelInfo(hub.channelId(p)).phase), uint8(ChannelHub.Phase.Funding));

        Params memory p2 = _params();
        p2.deposit = DEPOSIT + 1;
        p2.salt = keccak256("other");
        vm.prank(alice);
        vm.expectRevert(ChannelHub.DepositTooLarge.selector);
        hub.deposit(abi.encode(p2));
    }

    // ------------------------------------------------------------- funding window bound (reservation bound)

    function test_fundingDeadline_atMaxWindowSucceeds_maxWindowPlusOneReverts() public {
        Params memory p = _params();
        p.fundingDeadline = uint64(block.timestamp) + hub.MAX_FUNDING_WINDOW();
        vm.prank(alice);
        hub.deposit(abi.encode(p)); // exactly at the bound: succeeds
        assertEq(uint8(hub.channelInfo(hub.channelId(p)).phase), uint8(ChannelHub.Phase.Funding));

        Params memory p2 = _params();
        p2.salt = keccak256("other");
        p2.fundingDeadline = uint64(block.timestamp) + hub.MAX_FUNDING_WINDOW() + 1;
        vm.prank(alice);
        vm.expectRevert(ChannelHub.InvalidParams.selector);
        hub.deposit(abi.encode(p2));
    }

    // ------------------------------------------------------------- committed escrow accounting

    function test_committedEscrow_createFundClose_returnsToZero() public {
        Params memory p = _params();
        uint256 commit = 2 * (p.deposit + p.feePerPlayer);
        bytes32 id = hub.channelId(p);

        vm.prank(alice);
        hub.deposit(abi.encode(p));
        assertEq(hub.committedEscrow(), commit);

        vm.prank(bob);
        hub.deposit(abi.encode(p));
        assertEq(hub.committedEscrow(), commit); // second deposit never changes it

        _close(_resignedGame(p, id));
        assertEq(hub.committedEscrow(), 0);
    }

    function test_committedEscrow_createReclaim_returnsToZero() public {
        Params memory p = _params();
        uint256 commit = 2 * (p.deposit + p.feePerPlayer);
        bytes32 id = hub.channelId(p);

        vm.prank(alice);
        hub.deposit(abi.encode(p));
        assertEq(hub.committedEscrow(), commit);

        vm.warp(p.fundingDeadline + 1);
        hub.reclaim(id);
        assertEq(hub.committedEscrow(), 0);
    }

    function test_committedEscrow_createFundChallengeTimeout_returnsToZero() public {
        Params memory p = _params();
        uint256 commit = 2 * (p.deposit + p.feePerPlayer);
        bytes32 id = _open(p);
        assertEq(hub.committedEscrow(), commit);

        State memory s0 = rules.initialState(id, p);
        State memory s1 = _play(s0, p, uci("e2e4"));
        bytes memory proof = _moveProof(s0, "", "", s1, _sign(aliceKey, s1), "");
        vm.prank(alice);
        hub.challenge(proof);
        assertEq(hub.committedEscrow(), commit); // dispute never touches escrow accounting

        vm.warp(hub.channelInfo(id).deadline);
        hub.timeout(id);
        assertEq(hub.committedEscrow(), 0);
    }

    function test_committedEscrow_capCheckedAtCreationOnly() public {
        Params memory p = _params();
        uint256 commit = 2 * (p.deposit + p.feePerPlayer);
        vm.prank(alice);
        hub.deposit(abi.encode(p));
        assertEq(hub.committedEscrow(), commit);

        vm.prank(owner);
        hub.setLimits(0, commit - 1); // lower both caps below the current commitment

        vm.prank(bob);
        hub.deposit(abi.encode(p)); // second deposit is unaffected by the lowered caps
        assertEq(hub.committedEscrow(), commit);
        assertEq(uint8(hub.channelInfo(hub.channelId(p)).phase), uint8(ChannelHub.Phase.Open));
    }

    function test_escrowCapReached_exactBoundary() public {
        Params memory p = _params();
        uint256 commit = 2 * (p.deposit + p.feePerPlayer);
        vm.prank(owner);
        hub.setLimits(MAX_DEPOSIT, commit);
        vm.prank(alice);
        hub.deposit(abi.encode(p)); // exactly at the cap: succeeds

        Params memory p2 = _params();
        p2.salt = keccak256("other");
        vm.prank(owner);
        hub.setLimits(MAX_DEPOSIT, commit + 2 * (p2.deposit + p2.feePerPlayer) - 1);
        vm.prank(alice);
        vm.expectRevert(ChannelHub.EscrowCapReached.selector);
        hub.deposit(abi.encode(p2));
    }

    /// A channel's commit is the fee snapshotted into its params at creation, not the hub's current fee: a
    /// setFee between creation and settlement must not desync committedEscrow.
    function test_committedEscrow_honoursFeeSnapshot_acrossClose() public {
        Params memory p = _params(); // snapshots FEE
        bytes32 id = _open(p);
        vm.prank(owner);
        hub.setFee(FEE * 3, feeRecipient);
        _close(_resignedGame(p, id));
        assertEq(hub.committedEscrow(), 0);
    }

    function test_committedEscrow_honoursFeeSnapshot_acrossReclaim() public {
        Params memory p = _params(); // snapshots FEE
        vm.prank(alice);
        hub.deposit(abi.encode(p));
        vm.prank(owner);
        hub.setFee(FEE * 3, feeRecipient);
        vm.warp(p.fundingDeadline + 1);
        hub.reclaim(hub.channelId(p));
        assertEq(hub.committedEscrow(), 0);
    }

    // ------------------------------------------------------------- pause: deposit only

    function test_pause_blocksCreation() public {
        _pause();
        Params memory p = _params();
        vm.prank(alice);
        vm.expectRevert(ChannelHub.Paused.selector);
        hub.deposit(abi.encode(p));
    }

    /// Paused() is checked before any other validation, so it wins even against invalid params.
    function test_pause_checkedBeforeParamValidation() public {
        _pause();
        Params memory p = _params();
        p.participants = [alice, alice]; // would otherwise revert InvalidParams
        vm.prank(alice);
        vm.expectRevert(ChannelHub.Paused.selector);
        hub.deposit(abi.encode(p));
    }

    function test_pause_blocksSecondSideFunding() public {
        Params memory p = _params();
        vm.prank(alice);
        hub.deposit(abi.encode(p));
        _pause();
        vm.prank(bob);
        vm.expectRevert(ChannelHub.Paused.selector);
        hub.deposit(abi.encode(p));
    }

    function test_pause_reclaimStillWorks() public {
        Params memory p = _params();
        bytes32 id = hub.channelId(p);
        vm.prank(alice);
        hub.deposit(abi.encode(p));
        vm.warp(p.fundingDeadline + 1);
        _pause();
        hub.reclaim(id);
        assertEq(uint8(hub.channelInfo(id).phase), uint8(ChannelHub.Phase.Reclaimed));
    }

    function test_pause_closeCooperativeStillWorks() public {
        Params memory p = _params();
        bytes32 id = _open(p);
        State memory s = _resignedGame(p, id);
        _pause();
        _close(s);
        assertEq(uint8(hub.channelInfo(id).phase), uint8(ChannelHub.Phase.Finalized));
    }

    function test_pause_challengeStillWorks() public {
        Params memory p = _params();
        bytes32 id = _open(p);
        State memory s0 = rules.initialState(id, p);
        State memory s1 = _play(s0, p, uci("e2e4"));
        bytes memory proof = _moveProof(s0, "", "", s1, _sign(aliceKey, s1), "");
        _pause();
        vm.prank(alice);
        hub.challenge(proof);
        assertEq(uint8(hub.channelInfo(id).phase), uint8(ChannelHub.Phase.Challenged));
    }

    function test_pause_respondStillWorks() public {
        Params memory p = _params();
        bytes32 id = _open(p);
        State memory s0 = rules.initialState(id, p);
        State memory s1 = _play(s0, p, uci("e2e4"));
        State memory s2 = _play(s1, p, uci("e7e5"));
        bytes memory challengeProof = _moveProof(s0, "", "", s1, _sign(aliceKey, s1), "");
        vm.prank(alice);
        hub.challenge(challengeProof);
        bytes memory respondProof = _moveProof(s1, "", "", s2, "", _sign(bobKey, s2));
        _pause();
        hub.respond(respondProof);
        assertEq(uint8(hub.channelInfo(id).phase), uint8(ChannelHub.Phase.Open));
    }

    function test_pause_timeoutStillWorks() public {
        Params memory p = _params();
        bytes32 id = _open(p);
        State memory s0 = rules.initialState(id, p);
        State memory s1 = _play(s0, p, uci("e2e4"));
        bytes memory challengeProof = _moveProof(s0, "", "", s1, _sign(aliceKey, s1), "");
        vm.prank(alice);
        hub.challenge(challengeProof);
        vm.warp(hub.channelInfo(id).deadline);
        _pause();
        hub.timeout(id);
        assertEq(uint8(hub.channelInfo(id).phase), uint8(ChannelHub.Phase.Finalized));
    }

    function test_pause_claimStillWorks() public {
        Params memory p = _params();
        bytes32 id = _open(p);
        usdc.setBlocked(bob, true);
        _close(_resignedGame(p, id));
        assertGt(hub.owed(bob), 0);

        _pause();
        address bobNew = makeAddr("bobNew");
        vm.prank(bob);
        hub.claim(bobNew);
        assertEq(hub.owed(bob), 0);
    }

    // ------------------------------------------------------------- admin surface

    function test_setLimits_onlyOwnerAndEmits() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        hub.setLimits(1, 2);

        vm.expectEmit(true, false, false, true, address(hub));
        emit ChannelHub.LimitsUpdated(123, 456);
        vm.prank(owner);
        hub.setLimits(123, 456);
        assertEq(hub.maxDepositPerPlayer(), 123);
        assertEq(hub.maxCommittedEscrow(), 456);
    }

    function test_setPaused_onlyOwnerAndEmits() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        hub.setPaused(true);

        vm.expectEmit(true, false, false, true, address(hub));
        emit ChannelHub.PausedSet(true);
        vm.prank(owner);
        hub.setPaused(true);
        assertTrue(hub.paused());
    }

    // ------------------------------------------------------------- fuzz

    /// committedEscrow always equals the sum of 2*(deposit+fee) over channels that have not yet settled,
    /// across random deposit, fee and cap values.
    function testFuzz_committedEscrow_equalsSumOverUnsettled(
        uint256 depositSeed1,
        uint256 depositSeed2,
        uint256 feeSeed,
        uint256 capSeed
    ) public {
        uint256 fee = bound(feeSeed, 0, MAX_FEE);
        vm.prank(owner);
        hub.setFee(fee, feeRecipient);

        uint256 d1 = bound(depositSeed1, STAKE, 2_000_000);
        uint256 d2 = bound(depositSeed2, STAKE, 2_000_000);
        uint256 commit1 = 2 * (d1 + fee);
        uint256 commit2 = 2 * (d2 + fee);
        uint256 cap = bound(capSeed, commit1 + commit2, MAX_COMMITTED);
        vm.prank(owner);
        hub.setLimits(MAX_DEPOSIT, cap);

        Params memory p1 = _params();
        p1.feePerPlayer = fee;
        p1.deposit = d1;
        p1.salt = keccak256("fuzz1");
        Params memory p2 = _params();
        p2.feePerPlayer = fee;
        p2.deposit = d2;
        p2.salt = keccak256("fuzz2");

        bytes32 id1 = _open(p1); // funded both sides: unsettled but Open
        vm.prank(alice);
        hub.deposit(abi.encode(p2)); // only alice funded: unsettled, still Funding
        assertEq(hub.committedEscrow(), commit1 + commit2);

        _close(_resignedGame(p1, id1));
        assertEq(hub.committedEscrow(), commit2);

        vm.warp(p2.fundingDeadline + 1);
        hub.reclaim(hub.channelId(p2));
        assertEq(hub.committedEscrow(), 0);
    }
}
