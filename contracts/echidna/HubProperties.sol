// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Params, State, SignedState, Proof} from "../src/ArenaTypes.sol";
import {ChannelHub} from "../src/ChannelHub.sol";
import {ChessRules} from "../src/chess/ChessRules.sol";
import {ChessBoard as B} from "../src/chess/ChessBoard.sol";
import {MockUSDC} from "../src/dev/MockUSDC.sol";
import {ChessTestUtils} from "../test/helpers/ChessTestUtils.sol";

/// @notice Forwards a call so `msg.sender`, as seen by the target, is this contract's own address rather
/// than HubProperties'. Stands in for two independent "wallets" (deposit/payout identities).
contract Forwarder {
    function forward(address target, bytes memory data) external returns (bool ok, bytes memory ret) {
        (ok, ret) = target.call(data);
    }
}

/// @notice The hevm cheatcodes Echidna provides, at the address forge-std's `vm` uses. The hub verifies ECDSA
/// only (final review A I-1), so the session keys here are real keys: `addr` derives their addresses and `sign`
/// produces their 65-byte, low-s signatures.
interface IHevm {
    function sign(uint256 sk, bytes32 digest) external returns (uint8 v, bytes32 r, bytes32 s);
    function addr(uint256 sk) external returns (address);
}

/// @notice Echidna harness for ChannelHub (Plan 4.5 Task 4). Restates invariants 1, 2, 4 and 7 of
/// ChannelHub.invariant.t.sol (Task 3) as `echidna_*` properties, driven by a self-contained deployment:
/// MockUSDC, ChessRules and ChannelHub are all created in this contract's constructor, so `echidna-test
/// contracts/echidna/HubProperties.sol` needs no external setup beyond compiling the repo.
///
/// This is a lighter second opinion on top of Task 3's deep Foundry invariant/fuzz suite (ChannelHub.
/// invariant.t.sol + HubHandler.sol), not a replacement for it: Echidna's own coverage-guided engine explores
/// call sequences Foundry's invariant fuzzer might weight differently. Its signatures are real (hevm `sign`); in
/// place of vm.prank it uses forwarder wallets, and in place of vm.warp, Echidna's own time delays.
contract HubProperties is ChessTestUtils {
    uint256 internal constant FEE = 5_000;
    uint256 internal constant MAX_FEE = 1_000_000;
    uint256 internal constant MAX_DEPOSIT = 10_000_000;
    uint256 internal constant MAX_COMMITTED = 1e15;
    uint256 internal constant STAKE = 100_000;
    uint64 internal constant TIMEOUT = 600;
    IHevm internal constant HEVM = IHevm(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D);
    uint256 internal constant SIGNER0_KEY = 0xA11CE;
    uint256 internal constant SIGNER1_KEY = 0xB0B;

    address internal constant FEE_RECIPIENT_A = address(0x1111);
    address internal constant FEE_RECIPIENT_B = address(0x2222);

    MockUSDC public usdc;
    ChessRules public rules;
    ChannelHub public hub;
    Forwarder public wallet0;
    Forwarder public wallet1;
    address public signer0;
    address public signer1;

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
        signer0 = HEVM.addr(SIGNER0_KEY);
        signer1 = HEVM.addr(SIGNER1_KEY);

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
        p.signers = [signer0, signer1];
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

    /// @dev Cooperative close on the opening state (turnNum 0), with both session keys' Close signatures.
    function closeOpening(uint256 idx) external {
        (bool found, Params memory p) = _pick(idx, ChannelHub.Phase.Open);
        if (!found) (found, p) = _pick(idx, ChannelHub.Phase.Challenged);
        if (!found) return;
        bytes32 id = hub.channelId(p);
        State memory s = rules.initialState(id, p);
        bytes32 h = hub.hashClose(s);
        SignedState memory ss = SignedState({state: s, sigA: _sig(SIGNER0_KEY, h), sigB: _sig(SIGNER1_KEY, h)});
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

    /// @dev Unlike challengeChannel, the line is chosen deterministically (the cheapest available line
    /// strictly past the currently-registered turnNum) rather than randomly: ChannelHub.respond's own
    /// "solo/both-signed" support path (see _proofFor) never checks that the submitted state is a legal
    /// successor of the registered one, only that its turnNum is higher and the challenge window hasn't
    /// closed -- so the only two things that can make this call fail are staleness (fixed by this) and
    /// timing (tuned via echidna.yaml's maxTimeDelay, see task-4-report.md fix round 2).
    function respondChannel(uint256 idx) external {
        (bool found, Params memory p) = _pick(idx, ChannelHub.Phase.Challenged);
        if (!found) return;
        bytes32 id = hub.channelId(p);
        (uint8 line, bool ok) = _respondLine(hub.registeredState(id).turnNum);
        if (!ok) return;
        State memory s = _lineState(id, p, line);
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

    /// @dev Fixed lines from the opening state, mirroring HubHandler.sol's `_lineState`, extended with two
    /// further plies (4, 5) so respondChannel always has a line strictly past whatever challengeChannel's
    /// random pick among 0-3 registered: opening (0, turnNum 0), one legal move (1, turnNum 1), two legal
    /// moves (2, turnNum 2), a resignation making the game terminal (3, turnNum 2), three legal moves (4,
    /// turnNum 3), four legal moves (5, turnNum 4).
    function _lineState(bytes32 id, Params memory p, uint8 line) internal view returns (State memory s) {
        s = rules.initialState(id, p);
        if (line == 0) return s;
        s = _step(s, p, uci("e2e4"));
        if (line == 1) return s;
        if (line == 3) return _step(s, p, B.encodeMove(0, 0, 0, B.KIND_RESIGN));
        s = _step(s, p, uci("e7e5"));
        if (line == 2) return s;
        s = _step(s, p, uci("g1f3"));
        if (line == 4) return s;
        s = _step(s, p, uci("b8c6"));
        return s; // line == 5
    }

    /// @dev The cheapest fixed line (see _lineState) whose turnNum is strictly greater than `registered` --
    /// respond's own support check (ChannelHub._supported's no-hasPrev, both-signed branch) never requires
    /// the submitted state to be a legal successor of the currently-registered one, only that its turnNum
    /// is higher, so picking deterministically here removes line-selection luck as a blocker and leaves
    /// timing (the challenge window) as the only remaining variable.
    function _respondLine(uint64 registered) internal pure returns (uint8 line, bool ok) {
        if (registered == 0) return (1, true);
        if (registered == 1) return (2, true);
        if (registered == 2) return (4, true);
        if (registered == 3) return (5, true);
        return (0, false);
    }

    function _step(State memory prev, Params memory p, uint32 move) internal view returns (State memory next) {
        bool ok;
        (ok, next) = rules.successor(prev, move, p);
        require(ok, "harness: illegal fixed move");
        next.prevHash = hub.hashState(prev);
    }

    /// @dev turnNum 0 (the opening) needs no signature (ChannelHub._isOpening); anything else is
    /// "solo/both-signed", with both session keys' real signatures.
    function _proofFor(State memory s) internal returns (bytes memory) {
        Proof memory pr;
        pr.latest.state = s;
        if (s.turnNum != 0) {
            bytes32 h = hub.hashState(s);
            pr.latest.sigA = _sig(SIGNER0_KEY, h);
            pr.latest.sigB = _sig(SIGNER1_KEY, h);
        }
        return abi.encode(pr);
    }

    function _sig(uint256 key, bytes32 digest) internal returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = HEVM.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }
}
