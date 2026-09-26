// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
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
    address internal feeRecipientAddr;

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

    /// 4. A Finalized/Reclaimed channel settles exactly once and never changes phase again.
    function invariant_finalizedOrReclaimedOnce() public view {
        uint256 n = handler.channelCount();
        for (uint256 i = 0; i < n; i++) {
            bytes32 id = handler.channelIdAt(i);
            uint8 fin = handler.ghostFinalizedCount(id);
            uint8 rec = handler.ghostReclaimedCount(id);
            assertLe(uint256(fin) + uint256(rec), 1);
            if (fin == 1) assertEq(uint8(hub.channelInfo(id).phase), uint8(ChannelHub.Phase.Finalized));
            if (rec == 1) assertEq(uint8(hub.channelInfo(id).phase), uint8(ChannelHub.Phase.Reclaimed));
        }
    }

    /// 5. Every settlement (reclaim/closeCooperative/timeout) delivers exactly what the handler expected
    /// independently (built from the fixed move lines / ChessRules.forfeitBalances, not from trusting the
    /// hub's own registered state), whether paid directly or deferred to `owed`.
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

    /// @notice Deterministic (not fuzz-dependent) proof that the `owed` fallback in ChannelHub._pay is
    /// actually exercised through the handler: block the fee recipient (known index 8 for this 2-pair
    /// layout: 4 participants + 4 signers + feeRecipient), finalize a channel, and confirm the fee is
    /// deferred rather than delivered, then confirm `claim` retrieves it once unblocked.
    function test_handlerExercisesOwedFallback() public {
        handler.create(0, 0);
        handler.fund(0);
        handler.blockParticipant(8); // knownAddrs[8] == feeRecipientAddr
        assertEq(handler.deferredPayouts(), 0);

        handler.closeCooperativeAction(0, 1); // line 3: resign -> terminal, closable
        assertEq(handler.deferredPayouts(), 1);
        uint256 owedFee = hub.owed(feeRecipientAddr);
        assertGt(owedFee, 0);
        assertEq(handler.ghostOwedTotal(), owedFee);
        assertFalse(handler.payoutMismatch());

        handler.unblockParticipant(8);
        handler.claim(8);
        assertEq(hub.owed(feeRecipientAddr), 0);
        assertEq(handler.ghostOwedTotal(), 0);
        assertEq(token.balanceOf(feeRecipientAddr), owedFee);
    }
}

/// @notice Backend 1: plain MockUSDC, whose blocklist is also exercised here so both invariant suites
/// drive the `owed` fallback (spec: BlockingToken ruling applies to a MockUSDC-*like* token too).
contract ChannelHubInvariantTest is ChannelHubInvariantBase {
    MockUSDC internal usdc;
    address[] internal holders; // participants + feeRecipient, for the value-conservation check

    function setUp() public {
        address owner = makeAddr("owner");
        address feeRecipient = makeAddr("feeRecipient");
        feeRecipientAddr = feeRecipient;
        usdc = new MockUSDC();
        token = IERC20(address(usdc));
        ChessRules rules = new ChessRules();
        hub = new ChannelHub(token, owner, feeRecipient, FEE, MAX_FEE, MAX_DEPOSIT, MAX_COMMITTED);

        (address[] memory participants, address[] memory signers, uint256[] memory keys) =
            _twoPairs("alice", "bob", "alice2", "bob2");
        for (uint256 i = 0; i < participants.length; i++) {
            usdc.mint(participants[i], MINTED);
            vm.prank(participants[i]);
            usdc.approve(address(hub), type(uint256).max);
            holders.push(participants[i]);
        }
        holders.push(feeRecipient);

        handler = new HubHandler(hub, rules, token, owner, feeRecipient, participants, signers, keys);
        targetContract(address(handler));
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

    /// Carried forward from the original single-pair suite: no value is created or destroyed by the hub.
    function invariant_valueConserved() public view {
        uint256 total = token.balanceOf(address(hub));
        for (uint256 i = 0; i < holders.length; i++) {
            total += token.balanceOf(holders[i]);
        }
        assertEq(total, 4 * MINTED);
    }
}

/// @notice Backend 2: BlockingToken, whose transfers revert (rather than return false) for a blocked
/// participant, exercising ChannelHub's `_pay` -> `owed` fallback via the revert path specifically.
contract ChannelHubBlockingInvariantTest is ChannelHubInvariantBase {
    BlockingToken internal blockingToken;

    function setUp() public {
        address owner = makeAddr("blkOwner");
        address feeRecipient = makeAddr("blkFeeRecipient");
        feeRecipientAddr = feeRecipient;
        blockingToken = new BlockingToken();
        token = IERC20(address(blockingToken));
        ChessRules rules = new ChessRules();
        hub = new ChannelHub(token, owner, feeRecipient, FEE, MAX_FEE, MAX_DEPOSIT, MAX_COMMITTED);

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
        }

        handler = new HubHandler(hub, rules, token, owner, feeRecipient, participants, signers, keys);
        targetContract(address(handler));
    }
}
