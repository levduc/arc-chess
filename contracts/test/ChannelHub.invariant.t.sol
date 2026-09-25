// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {HubFixture} from "./helpers/HubFixture.sol";
import {HubHandler} from "./helpers/HubHandler.sol";

contract ChannelHubInvariantTest is HubFixture {
    HubHandler internal handler;
    uint256 internal constant MINTED = 1e15;

    function setUp() public override {
        super.setUp();
        usdc.mint(alice, MINTED);
        usdc.mint(bob, MINTED);
        handler = new HubHandler(hub, rules, [alice, bob], [aliceSigner, bobSigner], [aliceKey, bobKey], feeRecipient);
        targetContract(address(handler));
    }

    /// Hub holds exactly the escrow of live channels plus deferred payouts (none here: no blocked addresses).
    function invariant_hubBalanceEqualsEscrow() public view {
        assertEq(usdc.balanceOf(address(hub)), handler.ghostEscrow());
    }

    /// No value is created or destroyed across players, fee recipient and hub.
    function invariant_valueConserved() public view {
        uint256 total = usdc.balanceOf(alice) + usdc.balanceOf(bob) + usdc.balanceOf(feeRecipient)
            + usdc.balanceOf(address(hub));
        assertEq(total, 2 * (100e6 + MINTED));
    }
}
