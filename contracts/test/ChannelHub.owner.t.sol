// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Params} from "../src/ArenaTypes.sol";
import {ChannelHub} from "../src/ChannelHub.sol";
import {HubFixture} from "./helpers/HubFixture.sol";

/// Audit M2: `renounceOwnership` always reverts, and the Ownable2Step hand-over still works.
contract ChannelHubOwnerTest is HubFixture {
    address internal newOwner = makeAddr("newOwner");

    function _renounceReverts(address caller) internal {
        vm.prank(caller);
        vm.expectRevert(ChannelHub.RenounceDisabled.selector);
        hub.renounceOwnership();
    }

    function test_M2_renounce_revertsForOwner_ownerKept() public {
        _renounceReverts(owner);
        assertEq(hub.owner(), owner);
        assertEq(hub.pendingOwner(), address(0));
        // The owner can still administer the hub.
        vm.prank(owner);
        hub.setPaused(true);
        assertTrue(hub.paused());
    }

    /// Not `OwnableUnauthorizedAccount`: the override has no `onlyOwner`, so every caller gets the same error.
    function test_M2_renounce_revertsForAnyCaller() public {
        _renounceReverts(alice);
        _renounceReverts(address(this));
        assertEq(hub.owner(), owner);
    }

    /// The scenario of the audit: a mistaken renounce while paused would have frozen new business forever.
    function test_M2_renounceWhilePaused_hubCanStillBeUnpaused() public {
        vm.prank(owner);
        hub.setPaused(true);
        _renounceReverts(owner);
        vm.prank(owner);
        hub.setPaused(false);
        assertFalse(hub.paused());
        Params memory p = _params();
        _open(p);
    }

    /// A pending hand-over is not cleared by the reverted renounce.
    function test_M2_renounce_keepsPendingTransfer() public {
        vm.prank(owner);
        hub.transferOwnership(newOwner);
        _renounceReverts(owner);
        assertEq(hub.owner(), owner);
        assertEq(hub.pendingOwner(), newOwner);
        vm.prank(newOwner);
        hub.acceptOwnership();
        assertEq(hub.owner(), newOwner);
    }

    function test_M2_twoStepTransfer_stillWorks() public {
        // Only the owner may start a transfer.
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        hub.transferOwnership(alice);

        vm.expectEmit(true, true, false, false, address(hub));
        emit Ownable2Step.OwnershipTransferStarted(owner, newOwner);
        vm.prank(owner);
        hub.transferOwnership(newOwner);
        assertEq(hub.owner(), owner, "owner unchanged until accepted");
        assertEq(hub.pendingOwner(), newOwner);

        // Until accepted, the old owner keeps every right and the new one has none.
        vm.prank(newOwner);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, newOwner));
        hub.setPaused(true);

        // Only the pending owner may accept.
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        hub.acceptOwnership();
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, owner));
        hub.acceptOwnership();

        vm.expectEmit(true, true, false, false, address(hub));
        emit Ownable.OwnershipTransferred(owner, newOwner);
        vm.prank(newOwner);
        hub.acceptOwnership();
        assertEq(hub.owner(), newOwner);
        assertEq(hub.pendingOwner(), address(0));

        // The new owner administers; the old one cannot.
        vm.prank(newOwner);
        hub.setLimits(123, 456);
        assertEq(hub.maxDepositPerPlayer(), 123);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, owner));
        hub.setPaused(true);

        // And the new owner cannot renounce either.
        _renounceReverts(newOwner);
        assertEq(hub.owner(), newOwner);
    }

    /// A pending transfer can be redirected, or cancelled with address(0); a cancelled one cannot be accepted.
    function test_M2_twoStepTransfer_redirectAndCancel() public {
        vm.prank(owner);
        hub.transferOwnership(alice);
        vm.prank(owner);
        hub.transferOwnership(newOwner);
        assertEq(hub.pendingOwner(), newOwner);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        hub.acceptOwnership();

        vm.prank(owner);
        hub.transferOwnership(address(0));
        assertEq(hub.pendingOwner(), address(0));
        vm.prank(newOwner);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, newOwner));
        hub.acceptOwnership();
        assertEq(hub.owner(), owner);
    }
}
