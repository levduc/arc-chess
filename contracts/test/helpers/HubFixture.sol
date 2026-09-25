// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Params, State, SignedState, Proof} from "../../src/ArenaTypes.sol";
import {ChannelHub} from "../../src/ChannelHub.sol";
import {ChessRules} from "../../src/chess/ChessRules.sol";
import {ChessBoard as B} from "../../src/chess/ChessBoard.sol";
import {MockUSDC} from "../../src/dev/MockUSDC.sol";
import {ChessTestUtils} from "./ChessTestUtils.sol";

abstract contract HubFixture is Test, ChessTestUtils {
    MockUSDC internal usdc;
    ChessRules internal rules;
    ChannelHub internal hub;

    address internal owner = makeAddr("owner");
    address internal feeRecipient = makeAddr("feeRecipient");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal aliceSigner;
    uint256 internal aliceKey;
    address internal bobSigner;
    uint256 internal bobKey;

    uint256 internal constant FEE = 5_000;
    uint256 internal constant MAX_FEE = 1_000_000;
    uint256 internal constant DEPOSIT = 1_000_000;
    uint256 internal constant STAKE = 100_000;
    uint64 internal constant TIMEOUT = 600;

    function setUp() public virtual {
        (aliceSigner, aliceKey) = makeAddrAndKey("aliceSession");
        (bobSigner, bobKey) = makeAddrAndKey("bobSession");
        usdc = new MockUSDC();
        rules = new ChessRules();
        hub = new ChannelHub(IERC20(address(usdc)), owner, feeRecipient, FEE, MAX_FEE);
        usdc.mint(alice, 100e6);
        usdc.mint(bob, 100e6);
        vm.prank(alice);
        usdc.approve(address(hub), type(uint256).max);
        vm.prank(bob);
        usdc.approve(address(hub), type(uint256).max);
    }

    function _params() internal view returns (Params memory p) {
        p.participants = [alice, bob];
        p.signers = [aliceSigner, bobSigner];
        p.rules = address(rules);
        p.feeRecipient = feeRecipient;
        p.feePerPlayer = FEE;
        p.deposit = DEPOSIT;
        p.stakePerGame = STAKE;
        p.challengeTimeout = TIMEOUT;
        p.fundingDeadline = uint64(block.timestamp + 1 hours);
        p.salt = keccak256("salt");
    }

    function _open(Params memory p) internal returns (bytes32 id) {
        vm.prank(p.participants[0]);
        hub.deposit(abi.encode(p));
        vm.prank(p.participants[1]);
        hub.deposit(abi.encode(p));
        return hub.channelId(p);
    }

    function _sign(uint256 key, State memory s) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 sg) = vm.sign(key, hub.hashState(s));
        return abi.encodePacked(r, sg, v);
    }

    function _signClose(uint256 key, State memory s) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 sg) = vm.sign(key, hub.hashClose(s));
        return abi.encodePacked(r, sg, v);
    }

    function _play(State memory prev, Params memory p, uint32 move) internal view returns (State memory next) {
        bool ok;
        (ok, next) = rules.successor(prev, move, p);
        require(ok, "illegal move in test");
        next.prevHash = hub.hashState(prev);
    }

    function _kind(uint8 kind) internal pure returns (uint32) {
        return B.encodeMove(0, 0, 0, kind);
    }

    function _ss(State memory s, bytes memory sigA, bytes memory sigB) internal pure returns (SignedState memory ss) {
        ss.state = s;
        ss.sigA = sigA;
        ss.sigB = sigB;
    }

    function _moveProof(
        State memory prev,
        bytes memory prevSigA,
        bytes memory prevSigB,
        State memory latest,
        bytes memory sigA,
        bytes memory sigB
    ) internal pure returns (bytes memory) {
        Proof memory pr;
        pr.hasPrev = true;
        pr.prev = _ss(prev, prevSigA, prevSigB);
        pr.latest = _ss(latest, sigA, sigB);
        return abi.encode(pr);
    }

    function _soloProof(State memory s, bytes memory sigA, bytes memory sigB) internal pure returns (bytes memory) {
        Proof memory pr;
        pr.latest = _ss(s, sigA, sigB);
        return abi.encode(pr);
    }
}
