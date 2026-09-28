// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Params, State} from "../../src/ArenaTypes.sol";
import {ChessBoard as B} from "../../src/chess/ChessBoard.sol";
import {ChessRules} from "../../src/chess/ChessRules.sol";
import {ChessMovesHarness} from "./ChessMovesHarness.sol";

struct LegalMove {
    uint8 from;
    uint8 to;
    uint8 promo;
    uint256 board;
    uint8 side;
    uint8 castling;
    uint16 halfmove;
    uint16 ply;
    // Status ChessRules.successor records after this move is played as KIND_NORMAL, per chess.js.
    uint8 status;
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

/// @notice Shared position-level checks for the default and deep ChessRules/ChessMoves differential suites.
/// Kept out of both concrete test contracts so `forge test` never runs the same position set twice.
abstract contract ChessDifferentialBase is Test {
    ChessMovesHarness internal h;
    ChessRules internal rules;
    Params internal p;

    function setUp() public virtual {
        h = new ChessMovesHarness();
        rules = new ChessRules();
        p.stakePerGame = 1;
        p.deposit = type(uint128).max;
    }

    function _runPath(string memory path) internal {
        require(vm.exists(path), "vectors missing: run `pnpm vectors` (or `pnpm vectors:deep`) from the repo root");
        PositionCase[] memory cases = abi.decode(vm.parseBytes(vm.readFile(path)), (PositionCase[]));
        require(cases.length > 0, "empty vector chunk");
        for (uint256 i = 0; i < cases.length; i++) {
            // Routed through an external self-call so each position's staticcall return data (applyMove,
            // successor, ...) lands in a fresh EVM memory space instead of accumulating across every position
            // in the chunk. EVM memory cost is quadratic in total memory used within one call frame; checking
            // a large deep-mode chunk (100+ positions, each with dozens of legal/illegal moves) directly in
            // this loop measurably ran out of gas partway through a chunk even after chunking itself was
            // fixed to reset memory only between chunks (see ChessDifferentialDeep.t.sol). `this.` is a real
            // CALL, not a jump, so memory resets per position while assertion/failure state — which forge-std
            // signals through the `vm.assertTrue`/`vm.assertEq`-style cheatcode, not call-local memory —
            // still accumulates correctly.
            this.checkPositionExternal(cases[i]);
        }
    }

    function checkPositionExternal(PositionCase calldata c) external view {
        _checkPosition(c);
    }

    function _checkPosition(PositionCase memory c) internal view {
        assertEq(h.inCheck(c.board, c.meta), c.inCheck, string.concat("inCheck: ", c.fen));
        assertEq(h.hasLegalMove(c.board, c.meta), c.hasLegalMove, string.concat("hasLegalMove: ", c.fen));
        assertEq(h.isInsufficientMaterial(c.board), c.insufficient, string.concat("insufficient: ", c.fen));

        State memory prev;
        prev.board = c.board;
        prev.meta = c.meta;

        // A legal stalemate claim always draws; anything else (in check, or a legal move exists) is rejected.
        (bool claimOk, State memory claimed) = rules.successor(prev, B.encodeMove(0, 0, 0, B.KIND_CLAIM_STALEMATE), p);
        assertEq(claimOk, !c.inCheck && !c.hasLegalMove, string.concat("CLAIM_STALEMATE legality: ", c.fen));
        if (claimOk) assertEq(uint256(B.status(claimed.meta)), uint256(B.STATUS_DRAW), string.concat("CLAIM_STALEMATE status: ", c.fen));

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

            (bool sOk, State memory next) = rules.successor(prev, B.encodeMove(m.from, m.to, m.promo, B.KIND_NORMAL), p);
            assertTrue(sOk, string.concat("successor rejected a legal move: ", label));
            assertEq(uint256(B.status(next.meta)), uint256(m.status), string.concat("status mismatch: ", label));
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
