// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Deploy} from "../script/Deploy.s.sol";
import {ChannelHub} from "../src/ChannelHub.sol";

/// Deploy.s.sol pins Arc's USDC on Arc mainnet and testnet (final review A m-1, proposal M3).
contract DeployScriptTest is Test {
    address internal constant ARC_USDC = 0x3600000000000000000000000000000000000000;
    address internal constant ETHEREUM_USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;

    /// One test, not several: `vm.setEnv` sets the variables for the whole forge process, and forge runs tests in
    /// parallel. No case reaches the script's `vm.writeJson`, so no `deployments/<chainId>.json` is ever written: a
    /// pinned token with no code there stops at the hub's constructor.
    function test_arcChainsRequireArcUsdc() public {
        Deploy script = new Deploy();
        vm.setEnv("ARENA_OWNER", vm.toString(makeAddr("owner")));
        vm.setEnv("ARENA_FEE_RECIPIENT", vm.toString(makeAddr("feeRecipient")));
        uint256[2] memory arc = [uint256(5042), 5042002];
        address[2] memory wrong = [ETHEREUM_USDC, address(0x3600000000000000000000000000000000000001)];
        for (uint256 i; i < arc.length; ++i) {
            vm.chainId(arc[i]);
            for (uint256 j; j < wrong.length; ++j) {
                vm.setEnv("ARENA_TOKEN", vm.toString(wrong[j]));
                vm.expectRevert(
                    bytes("Deploy: on Arc (5042, 5042002) ARENA_TOKEN must be USDC 0x3600000000000000000000000000000000000000")
                );
                script.run();
            }
            // Arc's USDC passes the pin; it has no code in this test EVM, so the hub's constructor refuses it.
            vm.setEnv("ARENA_TOKEN", vm.toString(ARC_USDC));
            vm.expectRevert(ChannelHub.InvalidParams.selector);
            script.run();
            vm.stopBroadcast(); // a revert inside the script's broadcast leaves it open
        }
        // Off Arc the pin does not apply: the same wrong token gets as far as the constructor.
        vm.chainId(1);
        vm.setEnv("ARENA_TOKEN", vm.toString(ETHEREUM_USDC));
        vm.expectRevert(ChannelHub.InvalidParams.selector);
        script.run();
        vm.stopBroadcast();
    }
}
