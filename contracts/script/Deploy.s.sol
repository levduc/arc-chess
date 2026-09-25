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
        token = vm.envOr("ARENA_TOKEN", address(0));

        vm.startBroadcast();
        if (token == address(0)) token = address(new MockUSDC());
        rules = new ChessRules();
        hub = new ChannelHub(IERC20(token), owner, feeRecipient, feePerPlayer, maxFeePerPlayer);
        vm.stopBroadcast();

        string memory obj = "deployment";
        vm.serializeAddress(obj, "token", token);
        vm.serializeAddress(obj, "chessRules", address(rules));
        string memory json = vm.serializeAddress(obj, "channelHub", address(hub));
        vm.writeJson(json, string.concat(vm.projectRoot(), "/deployments/", vm.toString(block.chainid), ".json"));
    }
}
