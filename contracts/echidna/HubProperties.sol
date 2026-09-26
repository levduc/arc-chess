// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {Params, State, SignedState, Proof} from "../src/ArenaTypes.sol";
import {ChannelHub} from "../src/ChannelHub.sol";
import {ChessRules} from "../src/chess/ChessRules.sol";
import {ChessBoard as B} from "../src/chess/ChessBoard.sol";
import {MockUSDC} from "../src/dev/MockUSDC.sol";
import {ChessTestUtils} from "../test/helpers/ChessTestUtils.sol";

/// @notice Forwards a call so `msg.sender`, as seen by the target, is this contract's own address rather
/// than HubProperties'. Stands in for two independent "wallets" (deposit/payout identities) and two
/// independent "session key" identities, none of which can be produced by real ECDSA signing inside
/// Echidna's cheatcode-free EVM (see AlwaysValidSigner below).
contract Forwarder {
    function forward(address target, bytes memory data) external returns (bool ok, bytes memory ret) {
        (ok, ret) = target.call(data);
    }
}

/// @notice An ERC-1271 signer that accepts any non-empty signature unconditionally. Echidna cannot compute
/// real ECDSA signatures (there is no vm.sign-style cheatcode), so channel session keys here are contract
/// addresses using this fallback path of ChannelHub._signedBy instead. This only bypasses the *signature*
/// layer -- ChessRules.validTransition (the actual chess legality and the escrow/accounting bookkeeping
/// this harness restates as invariants) is exercised unmodified.
contract AlwaysValidSigner is IERC1271 {
    function isValidSignature(bytes32, bytes calldata) external pure returns (bytes4) {
        return IERC1271.isValidSignature.selector;
    }
}

/// @notice Echidna harness for ChannelHub (Plan 4.5 Task 4). Restates invariants 1, 2, 4 and 7 of
/// ChannelHub.invariant.t.sol (Task 3) as `echidna_*` properties, driven by a self-contained deployment:
/// MockUSDC, ChessRules and ChannelHub are all created in this contract's constructor, so `echidna-test
/// contracts/echidna/HubProperties.sol` needs no external setup beyond compiling the repo.
///
/// This is a lighter second opinion on top of Task 3's deep Foundry invariant/fuzz suite (ChannelHub.
/// invariant.t.sol + HubHandler.sol), not a replacement for it: Echidna's own coverage-guided engine explores
/// call sequences Foundry's invariant fuzzer might weight differently, at the cost of the strictness Foundry
/// gets from vm.sign/vm.prank/vm.warp (real signatures, real sender impersonation, real time travel), none
/// of which exist here.
contract HubProperties is ChessTestUtils {
    uint256 internal constant FEE = 5_000;
    uint256 internal constant MAX_FEE = 1_000_000;
    uint256 internal constant MAX_DEPOSIT = 10_000_000;
    uint256 internal constant MAX_COMMITTED = 1e15;
    uint256 internal constant STAKE = 100_000;
    uint64 internal constant TIMEOUT = 600;
    bytes internal constant DUMMY_SIG = hex"01"; // any non-empty bytes; AlwaysValidSigner accepts all of them.

    address internal constant FEE_RECIPIENT_A = address(0x1111);
    address internal constant FEE_RECIPIENT_B = address(0x2222);

    MockUSDC public usdc;
    ChessRules public rules;
    ChannelHub public hub;
    Forwarder public wallet0;
    Forwarder public wallet1;
    AlwaysValidSigner public signer0;
    AlwaysValidSigner public signer1;

    Params[] internal channels;
    uint256 internal nonce;

    // ---- ghosts, mirroring ChannelHub.invariant.t.sol's HubHandler ----
    uint256 public ghostEscrow; // token the hub should hold for live (Funding/Open/Challenged) channels
    uint256 public ghostCommitted; // mirrors ChannelHub.committedEscrow
    mapping(bytes32 => uint8) public settleCount; // Finalized + Reclaimed events observed, per channel

    constructor() {
        usdc = new MockUSDC();
        rules = new ChessRules();
        hub = new ChannelHub(IERC20(address(usdc)), address(this), FEE_RECIPIENT_A, FEE, MAX_FEE, MAX_DEPOSIT, MAX_COMMITTED);
        wallet0 = new Forwarder();
        wallet1 = new Forwarder();
        signer0 = new AlwaysValidSigner();
        signer1 = new AlwaysValidSigner();

        usdc.mint(address(wallet0), 1e18);
        usdc.mint(address(wallet1), 1e18);
        wallet0.forward(address(usdc), abi.encodeCall(IERC20.approve, (address(hub), type(uint256).max)));
        wallet1.forward(address(usdc), abi.encodeCall(IERC20.approve, (address(hub), type(uint256).max)));
    }

    // ------------------------------------------------------------------------------------------- actions

    /// @dev Invariant 2's target action: creates and funds side 0 of a new channel.
    function createChannel(uint256 depositSeed, uint256 windowSeed) external {
        Params memory p;
        p.participants = [address(wallet0), address(wallet1)];
        p.signers = [address(signer0), address(signer1)];
        p.rules = address(rules);
        p.feeRecipient = hub.feeRecipient(); // snapshot: ownerSetFee below can change this over the run
        p.feePerPlayer = hub.feePerPlayer();
        p.deposit = 100_000 + (depositSeed % 4_900_000); // 0.1..5 (mock) USDC
        p.stakePerGame = STAKE;
        p.challengeTimeout = TIMEOUT;
        p.fundingDeadline = uint64(block.timestamp) + 1 + uint64(windowSeed % hub.MAX_FUNDING_WINDOW());
        p.salt = keccak256(abi.encode(nonce++));

        (bool ok,) = wallet0.forward(address(hub), abi.encodeCall(hub.deposit, (abi.encode(p))));
        if (ok) {
            channels.push(p);
            ghostEscrow += p.deposit + p.feePerPlayer;
            ghostCommitted += 2 * (p.deposit + p.feePerPlayer);
        }
    }

    function fundOther(uint256 idx) external {
        (bool found, Params memory p) = _pick(idx, ChannelHub.Phase.Funding);
        if (!found) return;
        (bool ok,) = wallet1.forward(address(hub), abi.encodeCall(hub.deposit, (abi.encode(p))));
        if (ok) ghostEscrow += p.deposit + p.feePerPlayer;
    }

    function reclaimChannel(uint256 idx) external {
        (bool found, Params memory p) = _pick(idx, ChannelHub.Phase.Funding);
        if (!found) return;
        bytes32 id = hub.channelId(p);
        ChannelHub.ChannelInfo memory info = hub.channelInfo(id);
        try hub.reclaim(id) {
            uint256 refunded;
            if (info.funded[0]) refunded += p.deposit + p.feePerPlayer;
            if (info.funded[1]) refunded += p.deposit + p.feePerPlayer;
            ghostEscrow -= refunded;
            ghostCommitted -= 2 * (p.deposit + p.feePerPlayer);
            settleCount[id] += 1;
        } catch {}
    }

    /// @dev Cooperative close on the opening state (turnNum 0), signed by both mock signers.
    function closeOpening(uint256 idx) external {
        (bool found, Params memory p) = _pick(idx, ChannelHub.Phase.Open);
        if (!found) (found, p) = _pick(idx, ChannelHub.Phase.Challenged);
        if (!found) return;
        bytes32 id = hub.channelId(p);
        State memory s = rules.initialState(id, p);
        SignedState memory ss = SignedState({state: s, sigA: DUMMY_SIG, sigB: DUMMY_SIG});
        try hub.closeCooperative(abi.encode(ss)) {
            ghostEscrow -= 2 * (p.deposit + p.feePerPlayer);
            ghostCommitted -= 2 * (p.deposit + p.feePerPlayer);
            settleCount[id] += 1;
        } catch {}
    }

    function challengeChannel(uint256 idx, uint256 lineSeed) external {
        (bool found, Params memory p) = _pick(idx, ChannelHub.Phase.Open);
        if (!found) return;
        bytes32 id = hub.channelId(p);
        State memory s = _lineState(id, p, uint8(lineSeed % 4));
        bytes memory proof = _proofFor(s);
        wallet0.forward(address(hub), abi.encodeCall(hub.challenge, (proof))); // no escrow effect either way
    }

    function respondChannel(uint256 idx, uint256 lineSeed) external {
        (bool found, Params memory p) = _pick(idx, ChannelHub.Phase.Challenged);
        if (!found) return;
        bytes32 id = hub.channelId(p);
        State memory s = _lineState(id, p, uint8(lineSeed % 4));
        bytes memory proof = _proofFor(s);
        // respond has no sender restriction in ChannelHub; called directly, no escrow effect either way.
        // slither-disable-next-line unused-return
        address(hub).call(abi.encodeCall(hub.respond, (proof)));
    }

    function timeoutChannel(uint256 idx) external {
        (bool found, Params memory p) = _pick(idx, ChannelHub.Phase.Challenged);
        if (!found) return;
        bytes32 id = hub.channelId(p);
        try hub.timeout(id) {
            ghostEscrow -= 2 * (p.deposit + p.feePerPlayer);
            ghostCommitted -= 2 * (p.deposit + p.feePerPlayer);
            settleCount[id] += 1;
        } catch {}
    }

    /// @dev Exercises invariant 7's rejection path too: `feeSeed` occasionally lands above the cap.
    function ownerSetFee(uint256 feeSeed, uint256 recipientSeed) external {
        uint256 fee = feeSeed % (hub.maxFeePerPlayer() + hub.maxFeePerPlayer() / 4 + 1);
        address recipient = recipientSeed % 2 == 0 ? FEE_RECIPIENT_A : FEE_RECIPIENT_B;
        try hub.setFee(fee, recipient) {} catch {}
    }

    function ownerSetPaused(uint256 seed) external {
        try hub.setPaused(seed % 10 == 0) {} catch {}
    }

    // -------------------------------------------------------------------------------------- echidna_ props

    /// Invariant 1: hub token balance == unsettled escrow (ghost) + deferred payouts. `owed` is read live
    /// (never mirrored) -- decrementing ghostEscrow by a settlement's full amount regardless of whether
    /// `_pay` delivered it directly or deferred it to `owed` keeps this sum exact either way.
    function echidna_hubBalanceEqualsEscrowPlusOwed() public view returns (bool) {
        uint256 owedSum =
            hub.owed(address(wallet0)) + hub.owed(address(wallet1)) + hub.owed(FEE_RECIPIENT_A) + hub.owed(FEE_RECIPIENT_B);
        return usdc.balanceOf(address(hub)) == ghostEscrow + owedSum;
    }

    /// Invariant 2: committedEscrow == ghost sum of 2*(deposit+fee) over live channels.
    function echidna_committedEscrowMatchesGhost() public view returns (bool) {
        return hub.committedEscrow() == ghostCommitted;
    }

    /// Invariant 4: a channel settles (Finalized or Reclaimed) at most once.
    function echidna_finalizedOrReclaimedAtMostOnce() public view returns (bool) {
        for (uint256 i = 0; i < channels.length; i++) {
            if (settleCount[hub.channelId(channels[i])] > 1) return false;
        }
        return true;
    }

    /// Invariant 7: the fee can never exceed the immutable cap set at deployment.
    function echidna_feeNeverExceedsCap() public view returns (bool) {
        return hub.feePerPlayer() <= hub.maxFeePerPlayer();
    }

    // ------------------------------------------------------------------------------------------- internal

    function _pick(uint256 idx, ChannelHub.Phase phase) internal view returns (bool, Params memory) {
        uint256 n = channels.length;
        if (n == 0) return (false, _empty());
        for (uint256 k = 0; k < n; k++) {
            Params memory p = channels[(idx % n + k) % n];
            if (hub.channelInfo(hub.channelId(p)).phase == phase) return (true, p);
        }
        return (false, _empty());
    }

    function _empty() internal pure returns (Params memory none) {
        return none;
    }

    /// @dev Fixed lines from the opening state, mirroring HubHandler.sol's `_lineState`: opening (0), one
    /// legal move (1), two legal moves (2), or a resignation making the game terminal (3).
    function _lineState(bytes32 id, Params memory p, uint8 line) internal view returns (State memory s) {
        s = rules.initialState(id, p);
        if (line == 0) return s;
        s = _step(s, p, uci("e2e4"));
        if (line == 1) return s;
        if (line == 3) return _step(s, p, B.encodeMove(0, 0, 0, B.KIND_RESIGN));
        s = _step(s, p, uci("e7e5"));
        return s;
    }

    function _step(State memory prev, Params memory p, uint32 move) internal view returns (State memory next) {
        bool ok;
        (ok, next) = rules.successor(prev, move, p);
        require(ok, "harness: illegal fixed move");
        next.prevHash = hub.hashState(prev);
    }

    /// @dev turnNum 0 (the opening) needs no signature (ChannelHub._isOpening); anything else is
    /// "solo/both-signed" via the AlwaysValidSigner mocks, since Echidna cannot produce real ECDSA sigs.
    function _proofFor(State memory s) internal view returns (bytes memory) {
        Proof memory pr;
        pr.latest.state = s;
        if (s.turnNum != 0) {
            pr.latest.sigA = DUMMY_SIG;
            pr.latest.sigB = DUMMY_SIG;
        }
        return abi.encode(pr);
    }
}
