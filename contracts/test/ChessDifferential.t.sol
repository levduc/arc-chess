// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ChessBoard as B} from "../src/chess/ChessBoard.sol";
import {ChessMovesHarness} from "./helpers/ChessMovesHarness.sol";

struct LegalMove {
    uint8 from;
    uint8 to;
    uint8 promo;
    uint256 board;
    uint8 side;
    uint8 castling;
    uint16 halfmove;
    uint16 ply;
}

struct IllegalMove {
    uint8 from;
    uint8 to;
    uint8 promo;
}

struct PositionCase {
    string fen;
    uint256 board;
    uint256 meta;
    bool inCheck;
    bool hasLegalMove;
    bool insufficient;
    LegalMove[] legal;
    IllegalMove[] illegal;
}

/// @notice Asserts ChessMoves agrees with chess.js on every generated position. Generate with `pnpm vectors`.
contract ChessDifferentialTest is Test {
    ChessMovesHarness internal h;

    function setUp() public {
        h = new ChessMovesHarness();
    }

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
        string memory path = string.concat(vm.projectRoot(), "/test/vectors/chunk-", vm.toString(chunk), ".hex");
        require(vm.exists(path), "vectors missing: run `pnpm vectors` from the repo root");
        PositionCase[] memory cases = abi.decode(vm.parseBytes(vm.readFile(path)), (PositionCase[]));
        require(cases.length > 0, "empty vector chunk");
        for (uint256 i = 0; i < cases.length; i++) {
            _checkPosition(cases[i]);
        }
    }

    function _checkPosition(PositionCase memory c) internal view {
        assertEq(h.inCheck(c.board, c.meta), c.inCheck, string.concat("inCheck: ", c.fen));
        assertEq(h.hasLegalMove(c.board, c.meta), c.hasLegalMove, string.concat("hasLegalMove: ", c.fen));
        assertEq(h.isInsufficientMaterial(c.board), c.insufficient, string.concat("insufficient: ", c.fen));

        for (uint256 j = 0; j < c.legal.length; j++) {
            LegalMove memory m = c.legal[j];
            string memory label = string.concat(c.fen, " | ", vm.toString(m.from), "->", vm.toString(m.to), " promo ", vm.toString(m.promo));
            (bool ok, uint256 nb, uint256 nm) = h.applyMove(c.board, c.meta, m.from, m.to, m.promo);
            assertTrue(ok, string.concat("legal move rejected: ", label));
            assertEq(nb, m.board, string.concat("board mismatch: ", label));
            assertEq(uint256(B.side(nm)), uint256(m.side), string.concat("side mismatch: ", label));
            assertEq(uint256(B.castling(nm)), uint256(m.castling), string.concat("castling mismatch: ", label));
            assertEq(uint256(B.halfmove(nm)), uint256(m.halfmove), string.concat("halfmove mismatch: ", label));
            assertEq(uint256(B.ply(nm)), uint256(m.ply), string.concat("ply mismatch: ", label));
        }
        for (uint256 j = 0; j < c.illegal.length; j++) {
            IllegalMove memory m = c.illegal[j];
            (bool ok,,) = h.applyMove(c.board, c.meta, m.from, m.to, m.promo);
            assertFalse(
                ok,
                string.concat("illegal move accepted: ", c.fen, " | ", vm.toString(m.from), "->", vm.toString(m.to), " promo ", vm.toString(m.promo))
            );
        }
    }
}
