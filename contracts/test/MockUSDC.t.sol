// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {MockUSDC} from "../src/dev/MockUSDC.sol";

contract MockUSDCTest is Test {
    MockUSDC internal usdc;
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    function setUp() public {
        usdc = new MockUSDC();
    }

    function test_hasSixDecimals() public view {
        assertEq(usdc.decimals(), 6);
    }

    function test_mintAndTransfer() public {
        usdc.mint(alice, 10e6);
        vm.prank(alice);
        usdc.transfer(bob, 4e6);
        assertEq(usdc.balanceOf(alice), 6e6);
        assertEq(usdc.balanceOf(bob), 4e6);
    }

    function test_blockedAddressCannotReceiveOrSend() public {
        usdc.mint(alice, 10e6);
        usdc.setBlocked(bob, true);
        vm.prank(alice);
        vm.expectRevert(bytes("blocked"));
        usdc.transfer(bob, 1e6);

        usdc.setBlocked(bob, false);
        vm.prank(alice);
        usdc.transfer(bob, 1e6);
        usdc.setBlocked(bob, true);
        vm.prank(bob);
        vm.expectRevert(bytes("blocked"));
        usdc.transfer(alice, 1e6);
    }
}
