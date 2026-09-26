// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ChannelHub} from "../src/ChannelHub.sol";
import {ChessRules} from "../src/chess/ChessRules.sol";
import {MockUSDC} from "../src/dev/MockUSDC.sol";

contract Deploy is Script {
    function run() external returns (ChannelHub hub, ChessRules rules, address token) {
        address owner = vm.envAddress("ARENA_OWNER");
        address feeRecipient = vm.envAddress("ARENA_FEE_RECIPIENT");
        uint256 feePerPlayer = vm.envOr("ARENA_FEE_PER_PLAYER", uint256(5_000));
        uint256 maxFeePerPlayer = vm.envOr("ARENA_MAX_FEE_PER_PLAYER", uint256(1_000_000));
        // Spec §13 launch limits: 10 USDC per player, 1,000 USDC committed hub-wide.
        uint256 maxDepositPerPlayer = vm.envOr("ARENA_MAX_DEPOSIT_PER_PLAYER", uint256(10_000_000));
        uint256 maxCommittedEscrow = vm.envOr("ARENA_MAX_COMMITTED_ESCROW", uint256(1_000_000_000));
        token = vm.envOr("ARENA_TOKEN", address(0));
        // MockUSDC is a local-dev convenience only; on any real chain the escrow token must be explicit.
        bool deployMock = token == address(0);
        if (deployMock && block.chainid != 31337) {
            revert("Deploy: ARENA_TOKEN must be set on non-local chains (MockUSDC is deployed only on chain 31337)");
        }

        vm.startBroadcast();
        if (deployMock) token = address(new MockUSDC());
        rules = new ChessRules();
        hub = new ChannelHub(
            IERC20(token), owner, feeRecipient, feePerPlayer, maxFeePerPlayer, maxDepositPerPlayer, maxCommittedEscrow
        );
        vm.stopBroadcast();

        string memory obj = "deployment";
        vm.serializeAddress(obj, "token", token);
        vm.serializeAddress(obj, "chessRules", address(rules));
        string memory json = vm.serializeAddress(obj, "channelHub", address(hub));
        vm.writeJson(json, string.concat(vm.projectRoot(), "/deployments/", vm.toString(block.chainid), ".json"));
    }
}
