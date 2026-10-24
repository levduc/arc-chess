// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Params, State} from "../src/ArenaTypes.sol";
import {ChannelHub} from "../src/ChannelHub.sol";
import {ChessBoard as B} from "../src/chess/ChessBoard.sol";
import {BlockingToken} from "./helpers/BlockingToken.sol";
import {HubFixture} from "./helpers/HubFixture.sol";

/// Audit M1: `claim()` pays `msg.sender` only. A blocklisted party's `owed` stays frozen in the hub until the token
/// unblocks it, so the hub is no way around the blocklist, and a normal claim still pays the caller in full.
/// Run against both blocklist styles: a token that reverts (MockUSDC, like Arc's USDC, which reverts with
/// "Blocked address") and one that returns false (BlockingToken).
abstract contract ChannelHubClaimBase is HubFixture {
    address internal fresh = makeAddr("fresh");

    function _token() internal view virtual returns (IERC20);
    function _setBlocked(address who, bool isBlocked) internal virtual;
    function _expectBlockedRevert() internal virtual;

    /// Bob (black) resigns, so Alice wins one stake; the payouts listed in `blocked` are deferred to `owed`.
    function _settleResigned(address blocked) internal {
        Params memory p = _params();
        bytes32 id = _open(p);
        _setBlocked(blocked, true);
        State memory s1 = _play(rules.initialState(id, p), p, uci("e2e4"));
        State memory s2 = _play(s1, p, _kind(B.KIND_RESIGN));
        hub.closeCooperative(abi.encode(_ss(s2, _signClose(aliceKey, s2), _signClose(bobKey, s2))));
    }

    function test_M1_blockedClaimant_cannotRedirect() public {
        _settleResigned(bob);
        uint256 owedBob = hub.owed(bob);
        assertEq(owedBob, DEPOSIT - STAKE);
        IERC20 t = _token();
        uint256 hubBefore = t.balanceOf(address(hub));

        // claim() can only pay bob, and the token refuses bob: the claim reverts and nothing moves.
        _expectBlockedRevert();
        vm.prank(bob);
        hub.claim();

        // The redirect is gone: there is no claim(address), and the hub has no fallback.
        vm.prank(bob);
        (bool ok,) = address(hub).call(abi.encodeWithSignature("claim(address)", fresh));
        assertFalse(ok, "claim(address) must not exist");

        // Nobody else can pull bob's owed: another caller's claim covers only its own, here nothing.
        vm.prank(fresh);
        vm.expectRevert(ChannelHub.NothingToClaim.selector);
        hub.claim();

        assertEq(hub.owed(bob), owedBob, "owed stays frozen in the hub");
        assertEq(t.balanceOf(address(hub)), hubBefore, "the hub's balance is unchanged");
        assertEq(t.balanceOf(fresh), 0);
    }

    function test_M1_claim_paysCaller() public {
        _settleResigned(bob);
        uint256 owedBob = hub.owed(bob);
        IERC20 t = _token();
        _setBlocked(bob, false);
        uint256 bobBefore = t.balanceOf(bob);
        uint256 hubBefore = t.balanceOf(address(hub));

        vm.expectEmit(true, true, false, true, address(hub));
        emit ChannelHub.Claimed(bob, bob, owedBob);
        vm.prank(bob);
        hub.claim();

        assertEq(t.balanceOf(bob), bobBefore + owedBob, "the caller is paid in full");
        assertEq(t.balanceOf(address(hub)), hubBefore - owedBob);
        assertEq(hub.owed(bob), 0);
        vm.prank(bob);
        vm.expectRevert(ChannelHub.NothingToClaim.selector);
        hub.claim();
    }

    /// The token blocks the hub itself: every payout defers, and every claim reverts until the hub is unblocked.
    /// Nothing is lost, and each party is then paid to its own address.
    function test_M1_hubBlocked_claimsWait_thenPayEachCaller() public {
        _settleResigned(address(hub));
        IERC20 t = _token();
        assertEq(hub.owed(alice), DEPOSIT + STAKE);
        assertEq(hub.owed(bob), DEPOSIT - STAKE);
        assertEq(hub.owed(feeRecipient), 2 * FEE);

        _expectBlockedRevert();
        vm.prank(alice);
        hub.claim();
        assertEq(hub.owed(alice), DEPOSIT + STAKE);

        _setBlocked(address(hub), false);
        address[3] memory who = [alice, bob, feeRecipient];
        for (uint256 i; i < 3; ++i) {
            uint256 amount = hub.owed(who[i]);
            uint256 before = t.balanceOf(who[i]);
            vm.prank(who[i]);
            hub.claim();
            assertEq(t.balanceOf(who[i]), before + amount);
            assertEq(hub.owed(who[i]), 0);
        }
        assertEq(t.balanceOf(address(hub)), 0, "the hub holds nothing it does not owe");
    }
}

/// MockUSDC: a transfer touching a blocked address reverts with "blocked".
contract ChannelHubClaimRevertingTokenTest is ChannelHubClaimBase {
    function _token() internal view override returns (IERC20) {
        return IERC20(address(usdc));
    }

    function _setBlocked(address who, bool isBlocked) internal override {
        usdc.setBlocked(who, isBlocked);
    }

    function _expectBlockedRevert() internal override {
        vm.expectRevert("blocked");
    }
}

/// BlockingToken: a transfer touching a blocked address returns false, which SafeERC20 turns into a revert.
contract ChannelHubClaimFalseReturningTokenTest is ChannelHubClaimBase {
    BlockingToken internal btoken;

    function setUp() public override {
        super.setUp();
        btoken = new BlockingToken();
        hub = new ChannelHub(IERC20(address(btoken)), owner, feeRecipient, FEE, MAX_FEE, MAX_DEPOSIT, MAX_COMMITTED);
        btoken.mint(alice, 100e6);
        btoken.mint(bob, 100e6);
        vm.prank(alice);
        btoken.approve(address(hub), type(uint256).max);
        vm.prank(bob);
        btoken.approve(address(hub), type(uint256).max);
    }

    function _token() internal view override returns (IERC20) {
        return IERC20(address(btoken));
    }

    function _setBlocked(address who, bool isBlocked) internal override {
        btoken.setBlocked(who, isBlocked);
    }

    function _expectBlockedRevert() internal override {
        vm.expectRevert(abi.encodeWithSelector(SafeERC20.SafeERC20FailedOperation.selector, address(btoken)));
    }
}
