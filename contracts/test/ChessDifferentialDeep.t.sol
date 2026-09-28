// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ChessDifferentialBase} from "./helpers/ChessDifferentialBase.sol";

/// @notice Runs the same checks as ChessDifferentialTest against the 20,000-game deep vector set. Generate
/// with `pnpm vectors:deep`. Only runs when ARENA_DEEP_VECTORS=1 (set by `pnpm test:contracts:deep`); skips
/// cleanly otherwise so the default `forge test` loop never depends on the (large, gitignored) deep vectors.
contract ChessDifferentialDeepTest is ChessDifferentialBase {
    function test_deepVectors() public {
        if (vm.envOr("ARENA_DEEP_VECTORS", uint256(0)) != 1) {
            vm.skip(true);
            return;
        }
        string memory dir = string.concat(vm.projectRoot(), "/test/vectors-deep/chunk-");
        uint256 chunk = 0;
        while (true) {
            string memory path = string.concat(dir, vm.toString(chunk), ".hex");
            if (!vm.exists(path)) break;
            _runPath(path);
            chunk++;
        }
        require(chunk > 0, "no deep vectors found: run `pnpm vectors:deep`");
    }
}
