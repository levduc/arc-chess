// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Params, State} from "../src/ArenaTypes.sol";
import {ChannelHub} from "../src/ChannelHub.sol";
import {ChessBoard as B} from "../src/chess/ChessBoard.sol";
import {HubFixture} from "./helpers/HubFixture.sol";

contract ChannelHubCloseTest is HubFixture {
    function _resignedGame(Params memory p, bytes32 id) internal view returns (State memory s2) {
        State memory s1 = _play(rules.initialState(id, p), p, uci("e2e4"));
        s2 = _play(s1, p, _kind(B.KIND_RESIGN)); // bob (black) resigns
    }

    function _closeData(State memory s) internal view returns (bytes memory) {
        return abi.encode(_ss(s, _signClose(aliceKey, s), _signClose(bobKey, s)));
    }

    function _close(State memory s) internal {
        hub.closeCooperative(_closeData(s));
    }

    // vm.expectRevert() latches onto the very next external call, including staticcalls made
    // while evaluating arguments (e.g. hub.hashState() inside _sign()). So the signed calldata
    // must be built *before* arming expectRevert, leaving closeCooperative as the only call after it.
    function _expectCloseRevert(State memory s, bytes4 selector) internal {
        bytes memory data = _closeData(s);
        vm.expectRevert(selector);
        hub.closeCooperative(data);
    }

    function test_closeCooperative_afterResign_paysWinnerAndFee() public {
        Params memory p = _params();
        bytes32 id = _open(p);
        _close(_resignedGame(p, id));

        assertEq(usdc.balanceOf(alice), 100e6 - DEPOSIT - FEE + DEPOSIT + STAKE);
        assertEq(usdc.balanceOf(bob), 100e6 - DEPOSIT - FEE + DEPOSIT - STAKE);
        assertEq(usdc.balanceOf(feeRecipient), 2 * FEE);
        assertEq(usdc.balanceOf(address(hub)), 0);
        assertEq(uint8(hub.channelInfo(id).phase), uint8(ChannelHub.Phase.Finalized));
    }

    function test_closeCooperative_playerAtZeroBalance() public {
        Params memory p = _params();
        p.deposit = STAKE; // bob loses everything in one game
        bytes32 id = _open(p);
        State memory s = _resignedGame(p, id);
        assertEq(s.balanceB, 0);
        _close(s);
        assertEq(usdc.balanceOf(bob), 100e6 - STAKE - FEE);
        assertEq(usdc.balanceOf(feeRecipient), 2 * FEE);
        assertEq(usdc.balanceOf(address(hub)), 0);
    }

    function test_closeCooperative_onOpeningState() public {
        Params memory p = _params();
        bytes32 id = _open(p);
        _close(rules.initialState(id, p));
        assertEq(usdc.balanceOf(alice), 100e6 - FEE);
        assertEq(usdc.balanceOf(bob), 100e6 - FEE);
    }

    function test_closeCooperative_revertsMidGame() public {
        Params memory p = _params();
        bytes32 id = _open(p);
        State memory s1 = _play(rules.initialState(id, p), p, uci("e2e4"));
        _expectCloseRevert(s1, ChannelHub.NotClosable.selector);
    }

    function test_closeCooperative_revertsWithOneSignature() public {
        Params memory p = _params();
        bytes32 id = _open(p);
        State memory s = _resignedGame(p, id);
        bytes memory d1 = abi.encode(_ss(s, _signClose(aliceKey, s), ""));
        vm.expectRevert(ChannelHub.BadSignature.selector);
        hub.closeCooperative(d1);
        bytes memory d2 = abi.encode(_ss(s, _signClose(aliceKey, s), _signClose(aliceKey, s)));
        vm.expectRevert(ChannelHub.BadSignature.selector);
        hub.closeCooperative(d2);
    }

    function test_closeCooperative_revertsWhenBalancesDontSum() public {
        Params memory p = _params();
        bytes32 id = _open(p);
        State memory s = _resignedGame(p, id);
        s.balanceA += 1; // co-signed, but would take one unit from other channels' escrow
        _expectCloseRevert(s, ChannelHub.BalanceMismatch.selector);
    }

    function test_closeCooperative_revertsTwice() public {
        Params memory p = _params();
        bytes32 id = _open(p);
        State memory s = _resignedGame(p, id);
        _close(s);
        _expectCloseRevert(s, ChannelHub.WrongPhase.selector);
    }

    function test_closeCooperative_revertsForFundingChannel() public {
        Params memory p = _params();
        bytes32 id = hub.channelId(p);
        vm.prank(alice);
        hub.deposit(abi.encode(p));
        State memory s = rules.initialState(id, p);
        _expectCloseRevert(s, ChannelHub.WrongPhase.selector);
    }

    function test_payout_deferredWhenRecipientBlocked_thenClaim() public {
        Params memory p = _params();
        bytes32 id = _open(p);
        usdc.setBlocked(bob, true);
        _close(_resignedGame(p, id));

        assertEq(usdc.balanceOf(alice), 100e6 - FEE + STAKE);
        assertEq(usdc.balanceOf(feeRecipient), 2 * FEE);
        assertEq(hub.owed(bob), DEPOSIT - STAKE);

        address bobNew = makeAddr("bobNew");
        vm.prank(bob);
        hub.claim(bobNew);
        assertEq(usdc.balanceOf(bobNew), DEPOSIT - STAKE);
        assertEq(hub.owed(bob), 0);

        vm.prank(bob);
        vm.expectRevert(ChannelHub.NothingToClaim.selector);
        hub.claim(bobNew);
    }

    // ---- ruling R12: cooperative close needs an explicit Close intent

    /// A loser cannot roll back to an earlier co-signed NEW_GAME checkpoint: its state signatures do not close.
    function test_closeCooperative_loserCannotRollBackToCheckpoint() public {
        Params memory p = _params();
        bytes32 id = _open(p);
        State memory t = _resignedGame(p, id); // game 0: alice (white) wins, bob resigned
        State memory ng = _play(t, p, _kind(B.KIND_NEW_GAME)); // co-signed to start game 1
        State memory g1 = _play(ng, p, uci("e2e4")); // game 1: bob is white
        State memory r1 = _play(g1, p, _kind(B.KIND_RESIGN)); // alice (black) resigns game 1
        assertEq(r1.balanceA, DEPOSIT);

        bytes memory rollback = abi.encode(_ss(ng, _sign(aliceKey, ng), _sign(bobKey, ng)));
        vm.prank(alice);
        vm.expectRevert(ChannelHub.BadSignature.selector);
        hub.closeCooperative(rollback);

        // Bob still settles game 1 on alice's signed RESIGN via challenge -> timeout.
        bytes memory proof = _moveProof(g1, "", _sign(bobKey, g1), r1, _sign(aliceKey, r1), "");
        vm.prank(bob);
        hub.challenge(proof);
        vm.warp(block.timestamp + TIMEOUT);
        hub.timeout(id);
        assertEq(usdc.balanceOf(alice), 100e6 - FEE);
        assertEq(usdc.balanceOf(bob), 100e6 - FEE);
        assertEq(usdc.balanceOf(address(hub)), 0);
    }

    /// A terminal state co-signed only with State signatures (not Close) cannot close; mixing one of each
    /// cannot either.
    function test_closeCooperative_revertsOnStateSignatures() public {
        Params memory p = _params();
        bytes32 id = _open(p);
        State memory s = _resignedGame(p, id);
        bytes memory both = abi.encode(_ss(s, _sign(aliceKey, s), _sign(bobKey, s)));
        bytes memory mixed = abi.encode(_ss(s, _signClose(aliceKey, s), _sign(bobKey, s)));
        vm.expectRevert(ChannelHub.BadSignature.selector);
        hub.closeCooperative(both);
        vm.expectRevert(ChannelHub.BadSignature.selector);
        hub.closeCooperative(mixed);
        assertEq(uint8(hub.channelInfo(id).phase), uint8(ChannelHub.Phase.Open));
    }

    function test_hashClose_matchesManualEip712() public view {
        Params memory p = _params();
        bytes32 id = hub.channelId(p);
        State memory s = rules.initialState(id, p);
        assertEq(hub.CLOSE_TYPEHASH(), keccak256("Close(bytes32 channelId,bytes32 stateHash)"));
        bytes32 structHash = keccak256(abi.encode(hub.CLOSE_TYPEHASH(), id, hub.hashState(s)));
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("AgentArena"),
                keccak256("1"),
                block.chainid,
                address(hub)
            )
        );
        bytes32 expected = keccak256(abi.encodePacked(hex"1901", domain, structHash));
        assertEq(hub.hashClose(s), expected);
        assertTrue(hub.hashClose(s) != hub.hashState(s));
    }
}
