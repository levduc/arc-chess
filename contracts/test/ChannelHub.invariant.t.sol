// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ChannelHub} from "../src/ChannelHub.sol";
import {ChessRules} from "../src/chess/ChessRules.sol";
import {MockUSDC} from "../src/dev/MockUSDC.sol";
import {HubHandler} from "./helpers/HubHandler.sol";
import {BlockingToken} from "./helpers/BlockingToken.sol";

uint256 constant FEE = 5_000;
uint256 constant MAX_FEE = 1_000_000;
uint256 constant MAX_DEPOSIT = 10_000_000;
uint256 constant MAX_COMMITTED = 1e12;
uint256 constant MINTED = 1e15;

/// @notice Shared invariant assertions, applied identically to both token backends below. Ghost accounting
/// lives entirely in `HubHandler`; every check here reads that ghost state plus the hub's own on-chain views.
abstract contract ChannelHubInvariantBase is Test {
    ChannelHub internal hub;
    IERC20 internal token;
    HubHandler internal handler;
    address[] internal feeRecipients;
    address[] internal holders; // participants + feeRecipients, for the value-conservation check
    uint256 internal totalMinted;

    // Event-log-based tallies for invariant 4 (issue 8: ground truth from emitted events, not from the
    // handler's own success bookkeeping, so it can't share a blind spot with the handler).
    mapping(bytes32 => uint8) internal loggedFinalized;
    mapping(bytes32 => uint8) internal loggedReclaimed;

    /// 1. hub token balance == unsettled escrow (ghost) + deferred payouts (ghost), independently tracked
    /// from observed balance/owed deltas rather than mirrored from the hub's own state.
    function invariant_hubBalanceEqualsEscrowPlusOwed() public view {
        assertEq(token.balanceOf(address(hub)), handler.ghostEscrow() + handler.ghostOwedTotal());
    }

    /// 2. committedEscrow == ghost sum of 2*(deposit+fee) over live (Funding/Open/Challenged) channels,
    /// mirrored by the handler independently at creation/reclaim/finalize time.
    function invariant_committedEscrowMatchesGhost() public view {
        assertEq(hub.committedEscrow(), handler.ghostCommitted());
    }

    /// 3. A channel's registered turnNum never decreases. The handler flags a violation the moment an
    /// on-chain read shows a decrease from the last value it observed for that channel.
    function invariant_turnNumNeverDecreases() public view {
        assertFalse(handler.turnNumViolation());
    }

    /// 4. A Finalized/Reclaimed channel settles exactly once and never changes phase again. Counted from
    /// the hub's own emitted events (vm.recordLogs), not from the handler's success bookkeeping, so a bug
    /// reachable only through a path the handler doesn't itself track still gets caught.
    function invariant_finalizedOrReclaimedOnce() public {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter != address(hub) || logs[i].topics.length == 0) continue;
            bytes32 topic0 = logs[i].topics[0];
            if (topic0 == ChannelHub.Finalized.selector && logs[i].topics.length > 1) {
                loggedFinalized[logs[i].topics[1]] += 1;
            } else if (topic0 == ChannelHub.Reclaimed.selector && logs[i].topics.length > 1) {
                loggedReclaimed[logs[i].topics[1]] += 1;
            }
        }
        vm.recordLogs(); // drain, then re-arm for the next call

        uint256 n = handler.channelCount();
        for (uint256 i = 0; i < n; i++) {
            bytes32 id = handler.channelIdAt(i);
            uint8 fin = loggedFinalized[id];
            uint8 rec = loggedReclaimed[id];
            assertLe(uint256(fin) + uint256(rec), 1);
            if (fin == 1) assertEq(uint8(hub.channelInfo(id).phase), uint8(ChannelHub.Phase.Finalized));
            if (rec == 1) assertEq(uint8(hub.channelInfo(id).phase), uint8(ChannelHub.Phase.Reclaimed));
        }
    }

    /// 5. Every settlement (reclaim/closeCooperative/timeout) delivers exactly what the handler expected
    /// independently (the exact `s.balanceA/B` requested for `closeCooperative`, or
    /// `rules.forfeitBalances`/`isGameOver` applied to the handler's own ghost-tracked last-registered line
    /// for `timeout` — not the hub's own `registeredState`, so a registration bug can't hide from this too).
    function invariant_payoutsExactlyMatchExpected() public view {
        assertFalse(handler.payoutMismatch());
    }

    /// 6. Paused never blocks an exit. Only `deposit` may ever revert with `Paused()`.
    function invariant_pausedNeverBlocksExit() public view {
        assertFalse(handler.pausedViolation());
    }

    /// 7. The fee can never exceed the immutable cap set at deployment.
    function invariant_feeNeverExceedsCap() public view {
        assertLe(hub.feePerPlayer(), hub.maxFeePerPlayer());
    }

    /// 8 (liveness). Once the handler has set up every precondition it controls (right phase, deadline
    /// reached, nothing owed's an unblocked recipient), reclaim/timeout/claim and unblocked fund must
    /// always succeed. A revert there is a bug (e.g. a boundary off-by-one), not a legitimate rejection.
    function invariant_livenessHolds() public view {
        assertFalse(handler.livenessViolation());
    }

    /// 9 (adversarial). Nothing the hub must reject — wrong sender, wrong signature, wrong phase or
    /// timing, a repeat deposit, a non-terminal close, a claim with nothing owed — ever succeeds.
    function invariant_noAdversarialSuccess() public view {
        assertFalse(handler.adversarialViolation());
    }

    /// 10. After every successful challenge/respond, the hub's registeredState actually is what was
    /// submitted (kills a "respond doesn't register" mutant that would otherwise be invisible to timeout's
    /// own ghost-based expectation, since both would read the same stale line).
    function invariant_registrationMatchesSubmission() public view {
        assertFalse(handler.registrationViolation());
    }

    /// 11. closeCooperative never succeeds on a state staler than one already registered for that channel.
    function invariant_noStaleClose() public view {
        assertFalse(handler.staleCloseViolation());
    }

    /// Carried forward from the original single-pair suite: no value is created or destroyed by the hub.
    function invariant_valueConserved() public view {
        uint256 total = token.balanceOf(address(hub));
        for (uint256 i = 0; i < holders.length; i++) {
            total += token.balanceOf(holders[i]);
        }
        assertEq(total, totalMinted);
    }

    function _twoPairs(string memory a1, string memory b1, string memory a2, string memory b2)
        internal
        returns (address[] memory participants, address[] memory signers, uint256[] memory keys)
    {
        participants = new address[](4);
        signers = new address[](4);
        keys = new uint256[](4);
        (participants[0], participants[1], participants[2], participants[3]) =
            (makeAddr(a1), makeAddr(b1), makeAddr(a2), makeAddr(b2));
        (signers[0], keys[0]) = makeAddrAndKey(string.concat(a1, "Session"));
        (signers[1], keys[1]) = makeAddrAndKey(string.concat(b1, "Session"));
        (signers[2], keys[2]) = makeAddrAndKey(string.concat(a2, "Session"));
        (signers[3], keys[3]) = makeAddrAndKey(string.concat(b2, "Session"));
    }

    /// @notice Deterministic (not fuzz-dependent) proof that the `owed` fallback in ChannelHub._pay is
    /// actually exercised, and that `owed` accumulates rather than being overwritten (kills a
    /// `owed[to] = amount` mutant, which the fuzz-only version could miss since unblock-first `claim`
    /// narrows the window where `+=` vs `=` would ever differ): block the current fee recipient
    /// (knownAddrs[4], i.e. feeRecipients[0], since knownAddrs = participants(4) ++ feeRecipients(2)),
    /// finalize two separate channels while it stays blocked, and confirm `owed` holds the sum of both
    /// fees, not just the second.
    function test_handlerExercisesOwedFallback() public {
        handler.create(0, 0);
        handler.fund(0);
        handler.blockParticipant(4); // knownAddrs[4] == feeRecipients[0] == hub.feeRecipient() initially
        assertEq(handler.deferredPayouts(), 0);

        handler.closeCooperativeAction(0, 1); // line 3: resign -> terminal, closable
        assertEq(handler.deferredPayouts(), 1);
        uint256 owedAfterFirst = hub.owed(feeRecipients[0]);
        assertGt(owedAfterFirst, 0);
        assertEq(handler.ghostOwedTotal(), owedAfterFirst);
        assertFalse(handler.payoutMismatch());

        handler.create(1, 0);
        handler.fund(1);
        handler.closeCooperativeAction(1, 1);
        assertEq(handler.deferredPayouts(), 2);
        uint256 owedAfterSecond = hub.owed(feeRecipients[0]);
        assertEq(owedAfterSecond, 2 * owedAfterFirst); // fails under owed[to] = amount (overwrite, not +=)

        handler.unblockParticipant(4);
        handler.claim(4);
        assertEq(hub.owed(feeRecipients[0]), 0);
        assertEq(handler.ghostOwedTotal(), 0);
        assertEq(token.balanceOf(feeRecipients[0]), owedAfterSecond);
    }
}

/// @notice Backend 1: plain MockUSDC, which reverts (never returns false) on a blocked transfer.
contract ChannelHubInvariantTest is ChannelHubInvariantBase {
    MockUSDC internal usdc;

    function setUp() public {
        address owner = makeAddr("owner");
        feeRecipients = new address[](2);
        feeRecipients[0] = makeAddr("feeRecipientA");
        feeRecipients[1] = makeAddr("feeRecipientB");
        usdc = new MockUSDC();
        token = IERC20(address(usdc));
        ChessRules rules = new ChessRules();
        hub = new ChannelHub(token, owner, feeRecipients[0], FEE, MAX_FEE, MAX_DEPOSIT, MAX_COMMITTED);

        (address[] memory participants, address[] memory signers, uint256[] memory keys) =
            _twoPairs("alice", "bob", "alice2", "bob2");
        for (uint256 i = 0; i < participants.length; i++) {
            usdc.mint(participants[i], MINTED);
            vm.prank(participants[i]);
            usdc.approve(address(hub), type(uint256).max);
            holders.push(participants[i]);
        }
        holders.push(feeRecipients[0]);
        holders.push(feeRecipients[1]);
        totalMinted = 4 * MINTED;

        handler = new HubHandler(hub, rules, token, owner, participants, signers, keys, feeRecipients);
        targetContract(address(handler));
        vm.recordLogs();
    }
}

/// @notice Backend 2: BlockingToken, whose transfers return false (never revert) for a blocked
/// participant, exercising ChannelHub's `_pay` -> `owed` fallback via the false-return path specifically.
contract ChannelHubBlockingInvariantTest is ChannelHubInvariantBase {
    BlockingToken internal blockingToken;

    function setUp() public {
        address owner = makeAddr("blkOwner");
        feeRecipients = new address[](2);
        feeRecipients[0] = makeAddr("blkFeeRecipientA");
        feeRecipients[1] = makeAddr("blkFeeRecipientB");
        blockingToken = new BlockingToken();
        token = IERC20(address(blockingToken));
        ChessRules rules = new ChessRules();
        hub = new ChannelHub(token, owner, feeRecipients[0], FEE, MAX_FEE, MAX_DEPOSIT, MAX_COMMITTED);

        address[] memory participants = new address[](4);
        address[] memory signers = new address[](4);
        uint256[] memory keys = new uint256[](4);
        (participants[0], participants[1], participants[2], participants[3]) =
            (makeAddr("blkAlice"), makeAddr("blkBob"), makeAddr("blkAlice2"), makeAddr("blkBob2"));
        (signers[0], keys[0]) = makeAddrAndKey("blkAliceSession");
        (signers[1], keys[1]) = makeAddrAndKey("blkBobSession");
        (signers[2], keys[2]) = makeAddrAndKey("blkAlice2Session");
        (signers[3], keys[3]) = makeAddrAndKey("blkBob2Session");

        for (uint256 i = 0; i < participants.length; i++) {
            blockingToken.mint(participants[i], MINTED);
            vm.prank(participants[i]);
            blockingToken.approve(address(hub), type(uint256).max);
            holders.push(participants[i]);
        }
        holders.push(feeRecipients[0]);
        holders.push(feeRecipients[1]);
        totalMinted = 4 * MINTED;

        handler = new HubHandler(hub, rules, token, owner, participants, signers, keys, feeRecipients);
        targetContract(address(handler));
        vm.recordLogs();
    }
}
