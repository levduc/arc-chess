// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ChessDifferentialBase} from "./helpers/ChessDifferentialBase.sol";

/// @notice Asserts ChessMoves/ChessRules agree with chess.js on every generated position. Generate with
/// `pnpm vectors`. See ChessDifferentialDeep.t.sol for the 20,000-game deep set.
contract ChessDifferentialTest is ChessDifferentialBase {
    function test_chunk0() public { _run(0); }
    function test_chunk1() public { _run(1); }
    function test_chunk2() public { _run(2); }
    function test_chunk3() public { _run(3); }
    function test_chunk4() public { _run(4); }
    function test_chunk5() public { _run(5); }
    function test_chunk6() public { _run(6); }
    function test_chunk7() public { _run(7); }
    function test_chunk8() public { _run(8); }
    function test_chunk9() public { _run(9); }

    function _run(uint256 chunk) internal {
        _runPath(string.concat(vm.projectRoot(), "/test/vectors/chunk-", vm.toString(chunk), ".hex"));
    }
}
