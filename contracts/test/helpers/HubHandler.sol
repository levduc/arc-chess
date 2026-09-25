// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Params, State, SignedState, Proof} from "../../src/ArenaTypes.sol";
import {ChannelHub} from "../../src/ChannelHub.sol";
import {ChessRules} from "../../src/chess/ChessRules.sol";

/// @notice Drives random channel lifecycles and tracks how much USDC the hub should hold.
contract HubHandler is Test {
    ChannelHub internal hub;
    ChessRules internal rules;
    address internal alice;
    address internal bob;
    address internal aliceSigner;
    address internal bobSigner;
    uint256 internal aliceKey;
    uint256 internal bobKey;
    address internal feeRecipient;

    Params[] internal channels;
    uint256 public ghostEscrow;
    uint256 internal nonce;

    constructor(
        ChannelHub hub_,
        ChessRules rules_,
        address[2] memory players,
        address[2] memory signers,
        uint256[2] memory keys,
        address feeRecipient_
    ) {
        hub = hub_;
        rules = rules_;
        (alice, bob) = (players[0], players[1]);
        (aliceSigner, bobSigner) = (signers[0], signers[1]);
        (aliceKey, bobKey) = (keys[0], keys[1]);
        feeRecipient = feeRecipient_;
    }

    function create(uint256 depositSeed) external {
        Params memory p;
        p.participants = [alice, bob];
        p.signers = [aliceSigner, bobSigner];
        p.rules = address(rules);
        p.feeRecipient = feeRecipient;
        p.feePerPlayer = hub.feePerPlayer();
        p.stakePerGame = 100_000;
        p.deposit = bound(depositSeed, 100_000, 5_000_000);
        p.challengeTimeout = 600;
        p.fundingDeadline = uint64(block.timestamp + 1 hours);
        p.salt = keccak256(abi.encode(nonce++));
        vm.prank(alice);
        hub.deposit(abi.encode(p));
        ghostEscrow += p.deposit + p.feePerPlayer;
        channels.push(p);
    }

    function fund(uint256 idx) external {
        (bool found, Params memory p) = _pick(idx, ChannelHub.Phase.Funding);
        if (!found || block.timestamp > p.fundingDeadline) return;
        vm.prank(bob);
        hub.deposit(abi.encode(p));
        ghostEscrow += p.deposit + p.feePerPlayer;
    }

    function reclaim(uint256 idx) external {
        (bool found, Params memory p) = _pick(idx, ChannelHub.Phase.Funding);
        if (!found) return;
        if (block.timestamp <= p.fundingDeadline) vm.warp(p.fundingDeadline + 1);
        hub.reclaim(hub.channelId(p));
        ghostEscrow -= p.deposit + p.feePerPlayer; // only alice funded while in Funding
    }

    function closeOpening(uint256 idx) external {
        (bool found, Params memory p) = _pick(idx, ChannelHub.Phase.Open);
        if (!found) return;
        State memory s = rules.initialState(hub.channelId(p), p);
        SignedState memory ss;
        ss.state = s;
        ss.sigA = _signClose(aliceKey, s);
        ss.sigB = _signClose(bobKey, s);
        hub.closeCooperative(abi.encode(ss));
        ghostEscrow -= 2 * (p.deposit + p.feePerPlayer);
    }

    function challengeAndTimeout(uint256 idx) external {
        (bool found, Params memory p) = _pick(idx, ChannelHub.Phase.Open);
        if (!found) return;
        bytes32 id = hub.channelId(p);
        if (block.timestamp < hub.channelInfo(id).cooldownUntil[1]) return;
        Proof memory pr;
        pr.latest.state = rules.initialState(id, p);
        vm.prank(bob);
        hub.challenge(abi.encode(pr));
        vm.warp(block.timestamp + p.challengeTimeout);
        hub.timeout(id);
        ghostEscrow -= 2 * (p.deposit + p.feePerPlayer);
    }

    function _pick(uint256 idx, ChannelHub.Phase phase) internal view returns (bool, Params memory) {
        uint256 n = channels.length;
        for (uint256 k = 0; k < n; k++) {
            Params memory p = channels[(idx % n + k) % n];
            if (hub.channelInfo(hub.channelId(p)).phase == phase) return (true, p);
        }
        Params memory none;
        return (false, none);
    }

    function _signClose(uint256 key, State memory s) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 sg) = vm.sign(key, hub.hashClose(s));
        return abi.encodePacked(r, sg, v);
    }
}
