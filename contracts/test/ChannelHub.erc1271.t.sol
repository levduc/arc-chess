// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Params, State} from "../src/ArenaTypes.sol";
import {ChannelHub} from "../src/ChannelHub.sol";
import {HubFixture} from "./helpers/HubFixture.sol";
import {MockERC1271Wallet} from "./helpers/MockERC1271Wallet.sol";

contract ChannelHubErc1271Test is HubFixture {
    function test_contractSignerAccepted() public {
        MockERC1271Wallet wallet = new MockERC1271Wallet(aliceSigner);
        Params memory p = _params();
        p.signers[0] = address(wallet);
        bytes32 id = _open(p);
        State memory s0 = rules.initialState(id, p);
        State memory s1 = _play(s0, p, uci("e2e4"));

        // Build proofs (and their signatures) into locals before arming vm.prank/vm.expectRevert:
        // _moveProof -> _sign -> hub.hashState is itself an external call, which would otherwise
        // consume the prank/expectRevert meant for hub.challenge.
        bytes memory badProof = _moveProof(s0, "", "", s1, _sign(bobKey, s1), "");
        vm.prank(alice);
        vm.expectRevert(ChannelHub.BadSignature.selector);
        hub.challenge(badProof);

        bytes memory goodProof = _moveProof(s0, "", "", s1, _sign(aliceKey, s1), "");
        vm.prank(alice);
        hub.challenge(goodProof);
        assertEq(hub.registeredState(id).turnNum, 1);
    }
}
