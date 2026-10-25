// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Params, State} from "../src/ArenaTypes.sol";
import {ChannelHub} from "../src/ChannelHub.sol";
import {ChessBoard as B} from "../src/chess/ChessBoard.sol";
import {HubFixture} from "./helpers/HubFixture.sol";
import {MockERC1271Wallet} from "./helpers/MockERC1271Wallet.sol";
import {RejectAllERC1271} from "./helpers/RejectAllERC1271.sol";

contract ChannelHubErc1271Test is HubFixture {
    /// Final review A I-1 (owner decision 2026-10-25): the hub verifies ECDSA only, so a contract signer cannot sign.
    /// Not even its owner's ECDSA signature counts: it recovers to the owner's key, not to the contract.
    function test_contractSignerRefused() public {
        MockERC1271Wallet wallet = new MockERC1271Wallet(aliceSigner);
        Params memory p = _params();
        p.signers[0] = address(wallet);
        bytes32 id = _open(p);
        State memory s0 = rules.initialState(id, p);
        State memory s1 = _play(s0, p, uci("e2e4"));

        // Build proofs (and their signatures) into locals before arming vm.prank/vm.expectRevert:
        // _moveProof -> _sign -> hub.hashState is itself an external call, which would otherwise
        // consume the prank/expectRevert meant for hub.challenge.
        bytes memory ownerProof = _moveProof(s0, "", "", s1, _sign(aliceKey, s1), "");
        vm.prank(alice);
        vm.expectRevert(ChannelHub.BadSignature.selector);
        hub.challenge(ownerProof);
        assertFalse(hub.channelInfo(id).hasRegistered);

        // The deposits can still leave: the opening needs no signature.
        bytes memory opening = _soloProof(s0, "", "");
        vm.prank(bob);
        hub.challenge(opening);
        vm.warp(block.timestamp + TIMEOUT);
        hub.timeout(id);
        assertEq(uint8(hub.channelInfo(id).phase), uint8(ChannelHub.Phase.Finalized));
    }

    /// Ruling R13: a session key that gains code (e.g. EIP-7702 delegation) must not revoke its past ECDSA
    /// signatures, or a loser could erase a signed RESIGN.
    function test_ecdsaSignatureSurvivesSignerGainingCode() public {
        Params memory p = _params();
        bytes32 id = _open(p);
        State memory s0 = rules.initialState(id, p);
        State memory r = _play(s0, p, _kind(B.KIND_RESIGN)); // alice (white, on move) resigns
        bytes memory proof = _moveProof(s0, "", "", r, _sign(aliceKey, r), "");

        RejectAllERC1271 rejecter = new RejectAllERC1271();
        vm.etch(aliceSigner, address(rejecter).code);
        assertGt(aliceSigner.code.length, 0);

        vm.prank(bob);
        hub.challenge(proof);
        assertEq(hub.registeredState(id).turnNum, 1);
        vm.warp(block.timestamp + TIMEOUT);
        hub.timeout(id);
        assertEq(usdc.balanceOf(alice), 100e6 - FEE - STAKE);
        assertEq(usdc.balanceOf(bob), 100e6 - FEE + STAKE);
    }
}
