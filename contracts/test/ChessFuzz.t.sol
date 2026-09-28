// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Params, State} from "../src/ArenaTypes.sol";
import {ChessBoard as B} from "../src/chess/ChessBoard.sol";
import {ChessRules} from "../src/chess/ChessRules.sol";

/// @notice Robustness fuzz for ChessRules: validTransition (and successor) must never panic (an arithmetic or
/// array out-of-bounds error, selector 0x4e487b71), for any `prev` a signer could construct and any `move`.
/// It may legitimately reject a transition by returning false; it must never revert with a panic.
///
/// Unbounded turnNum/gameIndex/halfmove/ply/balance fields DO panic (checked-arithmetic overflow adding 1, or
/// adding a stake to a near-max balance) — see task-5-report.md for the repro. This test bounds those fields
/// instead of fixing ChessRules, per the controller's ruling (task-5-report.md, Finding 1): every `prev` the
/// hub ever validates is itself a transition from a state one signer or both co-signed, so turnNum/gameIndex
/// only ever increase by 1, halfmove resets to 0 or ends the game at 100, ply is capped at 300, and balances
/// are bounded by the deposit caps — the unbounded values below are not constructible through the protocol.
/// A panic would also only revert the transaction, exactly like any other rejected transition, so even if it
/// were reachable it would not be a safety issue on its own.
contract ChessFuzzTest is Test {
    bytes4 internal constant PANIC_SELECTOR = 0x4e487b71;

    ChessRules internal rules;
    Params internal p;

    function setUp() public {
        rules = new ChessRules();
        p.stakePerGame = 1;
        p.deposit = type(uint128).max;
    }

    function testFuzz_validTransition_neverPanics(
        uint256 board,
        uint8 side,
        uint8 castling,
        uint8 ep,
        uint16 halfmove,
        uint16 ply,
        uint8 status,
        uint64 turnNum,
        uint32 gameIndex,
        uint256 balanceA,
        uint256 balanceB,
        uint32 move,
        uint256 nextBoard,
        uint256 nextMeta
    ) public view {
        // Bound to the domain the hub can ever actually construct (see the finding in the contract comment
        // above and in task-5-report.md). This is a test-input choice, not a change to ChessRules.
        turnNum = uint64(bound(turnNum, 0, 1_000_000));
        gameIndex = uint32(bound(gameIndex, 0, 1_000_000));
        halfmove = uint16(bound(halfmove, 0, 60_000));
        ply = uint16(bound(ply, 0, 60_000));
        balanceA = bound(balanceA, 0, type(uint128).max);
        balanceB = bound(balanceB, 0, type(uint128).max);

        State memory prev;
        prev.board = board;
        prev.meta = B.packMeta(side, castling, ep, halfmove, ply, status);
        prev.turnNum = turnNum;
        prev.gameIndex = gameIndex;
        prev.balanceA = balanceA;
        prev.balanceB = balanceB;

        State memory next = prev;
        next.move = move;
        next.turnNum = prev.turnNum + 1;
        next.board = nextBoard;
        next.meta = nextMeta;

        _assertNoPanic(prev, next);
    }

    /// @notice Same as above but drives `successor` (validTransition's core), whose only output is a bool +
    /// State rather than a bool, per the brief's "if the interface returns a value rather than reverting,
    /// assert that it never panics".
    function testFuzz_successor_neverPanics(
        uint256 board,
        uint8 side,
        uint8 castling,
        uint8 ep,
        uint16 halfmove,
        uint16 ply,
        uint8 status,
        uint64 turnNum,
        uint32 gameIndex,
        uint256 balanceA,
        uint256 balanceB,
        uint32 move
    ) public view {
        turnNum = uint64(bound(turnNum, 0, 1_000_000));
        gameIndex = uint32(bound(gameIndex, 0, 1_000_000));
        halfmove = uint16(bound(halfmove, 0, 60_000));
        ply = uint16(bound(ply, 0, 60_000));
        balanceA = bound(balanceA, 0, type(uint128).max);
        balanceB = bound(balanceB, 0, type(uint128).max);

        State memory prev;
        prev.board = board;
        prev.meta = B.packMeta(side, castling, ep, halfmove, ply, status);
        prev.turnNum = turnNum;
        prev.gameIndex = gameIndex;
        prev.balanceA = balanceA;
        prev.balanceB = balanceB;

        try rules.successor(prev, move, p) returns (bool, State memory) {
            // No result-shape assertion here: this test only cares that it never panics.
        } catch (bytes memory reason) {
            assertFalse(_isPanic(reason), "successor panicked");
        }
    }

    function _assertNoPanic(State memory prev, State memory next) internal view {
        try rules.validTransition(prev, next, p) returns (bool) {
            // A plain true/false result is fine either way; the fuzz only cares about panics.
        } catch (bytes memory reason) {
            assertFalse(_isPanic(reason), "validTransition panicked");
        }
    }

    function _isPanic(bytes memory reason) internal pure returns (bool) {
        if (reason.length < 4) return false;
        bytes4 selector;
        assembly {
            selector := mload(add(reason, 32))
        }
        return selector == PANIC_SELECTOR;
    }
}
