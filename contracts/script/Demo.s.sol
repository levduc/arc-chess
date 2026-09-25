// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Params, State, SignedState} from "../src/ArenaTypes.sol";
import {ChannelHub} from "../src/ChannelHub.sol";
import {ChessRules} from "../src/chess/ChessRules.sol";
import {ChessBoard as B} from "../src/chess/ChessBoard.sol";
import {ChessMoves} from "../src/chess/ChessMoves.sol";
import {MockUSDC} from "../src/dev/MockUSDC.sol";
import {ChessTestUtils} from "../test/helpers/ChessTestUtils.sol";

/// @notice Local demo: two scripted players open a channel, play three games off-chain, and settle once on-chain.
/// Run against Anvil: forge script script/Demo.s.sol --rpc-url http://127.0.0.1:8545 --broadcast
contract Demo is Script, ChessTestUtils {
    // Anvil default accounts 0-2; account 3 is the host that collects the fee.
    uint256 internal constant DEPLOYER = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;
    uint256 internal constant ALICE = 0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d;
    uint256 internal constant BOB = 0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a;
    address internal constant HOST = 0x90F79bf6EB2c4f870365E785982E1f101E93b906;
    string internal constant SCHOLARS_MATE = "e2e4 e7e5 d1h5 b8c6 f1c4 g8f6 h5f7";

    MockUSDC internal usdc;
    ChessRules internal rules;
    ChannelHub internal hub;
    Params internal p;
    uint256 internal aliceSession = uint256(keccak256("alice-session"));
    uint256 internal bobSession = uint256(keccak256("bob-session"));
    uint256 internal offchainStates;

    function run() external {
        address alice = vm.addr(ALICE);
        address bob = vm.addr(BOB);

        console2.log("=== 1. Deploy + fund (on-chain) ===");
        vm.startBroadcast(DEPLOYER);
        usdc = new MockUSDC();
        rules = new ChessRules();
        hub = new ChannelHub(IERC20(address(usdc)), vm.addr(DEPLOYER), HOST, 5_000, 1_000_000);
        usdc.mint(alice, 10e6);
        usdc.mint(bob, 10e6);
        vm.stopBroadcast();
        console2.log("ChannelHub:", address(hub));

        p.participants = [alice, bob];
        p.signers = [vm.addr(aliceSession), vm.addr(bobSession)];
        p.rules = address(rules);
        p.feeRecipient = HOST;
        p.feePerPlayer = 5_000;
        p.deposit = 1e6; // 1.00 USDC each
        p.stakePerGame = 100_000; // 0.10 USDC per game
        p.challengeTimeout = 600;
        p.fundingDeadline = uint64(block.timestamp + 1 hours);
        p.salt = keccak256("demo");

        vm.startBroadcast(ALICE);
        usdc.approve(address(hub), type(uint256).max);
        hub.deposit(abi.encode(p));
        vm.stopBroadcast();
        vm.startBroadcast(BOB);
        usdc.approve(address(hub), type(uint256).max);
        hub.deposit(abi.encode(p));
        vm.stopBroadcast();
        bytes32 id = hub.channelId(p);
        console2.log("Channel opened. Each deposited 1.005 USDC (1.00 stake + 0.005 fee)");

        State memory s = rules.initialState(id, p);
        console2.log("");
        console2.log("=== 2. Off-chain play (signed messages only, no transactions) ===");
        s = _game(s, "Game 0: Alice white");
        s = _newGame(s);
        s = _game(s, "Game 1: Bob white");
        s = _newGame(s);
        s = _game(s, "Game 2: Alice white");

        console2.log("");
        console2.log("=== 3. Settle once (on-chain) ===");
        bytes32 closeDigest = hub.hashClose(s);
        SignedState memory ss;
        ss.state = s;
        ss.sigA = _sig(aliceSession, closeDigest);
        ss.sigB = _sig(bobSession, closeDigest);
        vm.startBroadcast(ALICE);
        hub.closeCooperative(abi.encode(ss));
        vm.stopBroadcast();

        console2.log("Off-chain signed states:", offchainStates);
        console2.log("Alice USDC (started 10.000000):", _usd(usdc.balanceOf(alice)));
        console2.log("Bob   USDC (started 10.000000):", _usd(usdc.balanceOf(bob)));
        console2.log("Host fee collected:", _usd(usdc.balanceOf(HOST)));
    }

    /// Plays Scholar's Mate for whoever is white; the mated player's daemon then signs RESIGN.
    function _game(State memory s, string memory title) internal returns (State memory) {
        console2.log("");
        console2.log(title);
        bytes memory moves = bytes(SCHOLARS_MATE);
        uint256 start;
        for (uint256 i = 0; i <= moves.length; i++) {
            if (i == moves.length || moves[i] == " ") {
                bytes memory m = new bytes(i - start);
                for (uint256 j = 0; j < m.length; j++) m[j] = moves[start + j];
                s = _step(s, uci(string(m)), string(m));
                start = i + 1;
            }
        }
        if (ChessMoves.inCheck(s.board, s.meta) && !ChessMoves.hasLegalMove(s.board, s.meta)) {
            console2.log("  checkmate -> loser's daemon signs RESIGN");
        }
        s = _step(s, B.encodeMove(0, 0, 0, B.KIND_RESIGN), "RESIGN");
        _printBoard(s.board);
        console2.log("  balances  A:", _usd(s.balanceA), " B:", _usd(s.balanceB));
        return s;
    }

    /// One move state: computed by the rules contract, signed only by the mover's session key.
    function _step(State memory prev, uint32 move, string memory label) internal returns (State memory next) {
        bool ok;
        (ok, next) = rules.successor(prev, move, p);
        require(ok, string.concat("illegal: ", label));
        next.prevHash = hub.hashState(prev);
        uint8 m = rules.mover(prev, p);
        bytes memory sig = _sig(m == 0 ? aliceSession : bobSession, hub.hashState(next));
        require(sig.length == 65 && rules.validTransition(prev, next, p), "transition check failed");
        offchainStates++;
        console2.log(string.concat("  ", m == 0 ? "Alice" : "Bob  ", " signs #", vm.toString(next.turnNum), " ", label));
    }

    /// NEW_GAME checkpoint: both players co-sign; colours swap.
    function _newGame(State memory prev) internal returns (State memory next) {
        bool ok;
        (ok, next) = rules.successor(prev, B.encodeMove(0, 0, 0, B.KIND_NEW_GAME), p);
        require(ok, "new game rejected");
        next.prevHash = hub.hashState(prev);
        _sig(aliceSession, hub.hashState(next));
        _sig(bobSession, hub.hashState(next));
        offchainStates++;
        console2.log("");
        console2.log(string.concat("  both sign #", vm.toString(next.turnNum), " NEW_GAME (checkpoint)"));
    }

    function _sig(uint256 key, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    function _printBoard(uint256 board) internal pure {
        bytes memory glyphs = ".PNBRQK??pnbrqk?";
        for (uint256 r = 8; r > 0; r--) {
            bytes memory row = new bytes(8);
            for (uint256 f = 0; f < 8; f++) row[f] = glyphs[B.pieceAt(board, (r - 1) * 8 + f)];
            console2.log(string.concat("    ", string(row)));
        }
    }

    function _usd(uint256 amount) internal pure returns (string memory) {
        string memory frac = vm.toString(amount % 1e6);
        while (bytes(frac).length < 6) frac = string.concat("0", frac);
        return string.concat(vm.toString(amount / 1e6), ".", frac);
    }
}
