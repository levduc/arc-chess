// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Params} from "../src/ArenaTypes.sol";
import {ChannelHub} from "../src/ChannelHub.sol";
import {HubFixture} from "./helpers/HubFixture.sol";

contract ChannelHubFundingTest is HubFixture {
    function test_deposit_opensAfterBothFund() public {
        Params memory p = _params();
        bytes32 id = hub.channelId(p);

        vm.prank(alice);
        hub.deposit(abi.encode(p));
        ChannelHub.ChannelInfo memory info = hub.channelInfo(id);
        assertEq(uint8(info.phase), uint8(ChannelHub.Phase.Funding));
        assertTrue(info.funded[0]);
        assertFalse(info.funded[1]);

        vm.prank(bob);
        hub.deposit(abi.encode(p));
        info = hub.channelInfo(id);
        assertEq(uint8(info.phase), uint8(ChannelHub.Phase.Open));
        assertEq(usdc.balanceOf(address(hub)), 2 * (DEPOSIT + FEE));
        assertEq(usdc.balanceOf(alice), 100e6 - DEPOSIT - FEE);
        assertEq(hub.channelParams(id).salt, p.salt);
    }

    function test_deposit_emitsChannelCreatedWithParams() public {
        Params memory p = _params();
        vm.expectEmit(true, false, false, true, address(hub));
        emit ChannelHub.ChannelCreated(hub.channelId(p), abi.encode(p));
        vm.prank(alice);
        hub.deposit(abi.encode(p));
    }

    function test_deposit_revertsForNonParticipant() public {
        Params memory p = _params();
        address mallory = makeAddr("mallory");
        usdc.mint(mallory, 10e6);
        vm.startPrank(mallory);
        usdc.approve(address(hub), type(uint256).max);
        vm.expectRevert(ChannelHub.NotParticipant.selector);
        hub.deposit(abi.encode(p));
        vm.stopPrank();

        vm.prank(aliceSigner); // session keys cannot fund; only participant wallets
        vm.expectRevert(ChannelHub.NotParticipant.selector);
        hub.deposit(abi.encode(p));
    }

    function test_deposit_revertsWhenAlreadyFunded() public {
        Params memory p = _params();
        vm.startPrank(alice);
        hub.deposit(abi.encode(p));
        vm.expectRevert(ChannelHub.AlreadyFunded.selector);
        hub.deposit(abi.encode(p));
        vm.stopPrank();
    }

    function test_deposit_revertsWhenFeeBelowHubFeeOrRecipientDiffers() public {
        Params memory p = _params();
        p.feePerPlayer = FEE - 1;
        vm.prank(alice);
        vm.expectRevert(ChannelHub.FeeMismatch.selector);
        hub.deposit(abi.encode(p));

        p = _params();
        p.feeRecipient = makeAddr("other");
        vm.prank(alice);
        vm.expectRevert(ChannelHub.FeeMismatch.selector);
        hub.deposit(abi.encode(p));
    }

    function test_deposit_toleratesConcurrentFeeDecrease() public {
        Params memory p = _params(); // snapshot FEE
        vm.prank(owner);
        hub.setFee(FEE / 2, feeRecipient);
        _open(p);
        assertEq(usdc.balanceOf(address(hub)), 2 * (DEPOSIT + FEE));
    }

    function test_deposit_revertsAfterFundingDeadline() public {
        Params memory p = _params();
        vm.prank(alice);
        hub.deposit(abi.encode(p));
        vm.warp(p.fundingDeadline + 1);
        vm.prank(bob);
        vm.expectRevert(ChannelHub.FundingClosed.selector);
        hub.deposit(abi.encode(p));
    }

    function test_deposit_revertsForInvalidParams() public {
        Params[] memory bad = new Params[](10);
        for (uint256 i = 0; i < bad.length; i++) bad[i] = _params();
        bad[0].participants = [alice, alice];
        bad[1].signers = [aliceSigner, address(0)];
        bad[2].signers = [aliceSigner, aliceSigner];
        bad[3].stakePerGame = 0;
        bad[4].deposit = STAKE - 1;
        bad[5].challengeTimeout = 59;
        bad[6].fundingDeadline = uint64(block.timestamp);
        bad[7].rules = makeAddr("noCode");
        bad[8].signers = [aliceSigner, alice]; // a participant wallet doubling as the other side's signer
        bad[9].signers = [bob, bobSigner];
        for (uint256 i = 0; i < bad.length; i++) {
            vm.prank(alice);
            vm.expectRevert(ChannelHub.InvalidParams.selector);
            hub.deposit(abi.encode(bad[i]));
        }
    }

    function test_reclaim_refundsDepositAndFee() public {
        Params memory p = _params();
        bytes32 id = hub.channelId(p);
        vm.prank(alice);
        hub.deposit(abi.encode(p));

        vm.expectRevert(ChannelHub.TooEarly.selector);
        hub.reclaim(id);

        vm.warp(p.fundingDeadline + 1);
        hub.reclaim(id);
        assertEq(usdc.balanceOf(alice), 100e6);
        assertEq(usdc.balanceOf(address(hub)), 0);
        assertEq(uint8(hub.channelInfo(id).phase), uint8(ChannelHub.Phase.Reclaimed));

        vm.prank(bob);
        vm.expectRevert(ChannelHub.WrongPhase.selector);
        hub.deposit(abi.encode(p));
    }

    function test_reclaim_revertsOnOpenChannel() public {
        bytes32 id = _open(_params());
        vm.warp(block.timestamp + 2 hours);
        vm.expectRevert(ChannelHub.WrongPhase.selector);
        hub.reclaim(id);
    }

    function test_setFee_onlyOwnerAndBounded() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        hub.setFee(1, feeRecipient);

        vm.startPrank(owner);
        vm.expectRevert(ChannelHub.InvalidParams.selector);
        hub.setFee(MAX_FEE + 1, feeRecipient);
        vm.expectRevert(ChannelHub.InvalidParams.selector);
        hub.setFee(1, address(0));
        hub.setFee(7_000, makeAddr("newRecipient"));
        vm.stopPrank();
        assertEq(hub.feePerPlayer(), 7_000);
    }

    function test_channelId_bindsHub() public {
        ChannelHub other =
            new ChannelHub(IERC20(address(usdc)), owner, feeRecipient, FEE, MAX_FEE, MAX_DEPOSIT, MAX_COMMITTED);
        Params memory p = _params();
        assertTrue(hub.channelId(p) != other.channelId(p));
    }

    function test_hashState_matchesManualEip712() public view {
        Params memory p = _params();
        bytes32 id = hub.channelId(p);
        bytes32 structHash = keccak256(abi.encode(hub.STATE_TYPEHASH(), rules.initialState(id, p)));
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
        assertEq(hub.hashState(rules.initialState(id, p)), expected);
    }

    function test_deposit_revertsWhenFeeAboveMax() public {
        Params memory p = _params();
        p.feePerPlayer = MAX_FEE + 1;
        vm.prank(alice);
        vm.expectRevert(ChannelHub.FeeMismatch.selector);
        hub.deposit(abi.encode(p));
    }

    function test_deposit_emitsCanonicalParams_notTrailingCalldata() public {
        Params memory p = _params();
        bytes32 id = hub.channelId(p);
        bytes memory canonical = abi.encode(p);
        bytes memory withJunk = abi.encodePacked(canonical, hex"deadbeef");
        vm.expectEmit(true, false, false, true, address(hub));
        emit ChannelHub.ChannelCreated(id, canonical);
        vm.prank(alice);
        hub.deposit(withJunk);
        assertEq(uint8(hub.channelInfo(id).phase), uint8(ChannelHub.Phase.Funding));
    }
}
