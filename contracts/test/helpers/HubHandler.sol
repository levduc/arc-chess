// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Params, State, SignedState, Proof} from "../../src/ArenaTypes.sol";
import {ChannelHub} from "../../src/ChannelHub.sol";
import {ChessRules} from "../../src/chess/ChessRules.sol";
import {ChessBoard as B} from "../../src/chess/ChessBoard.sol";
import {ChessTestUtils} from "./ChessTestUtils.sol";

/// @notice A token that can blocklist a recipient, exposed by both MockUSDC and BlockingToken. Blocking a
/// participant forces ChannelHub's `_pay` fallback (owed) instead of a direct transfer.
interface IBlockableToken {
    function setBlocked(address who, bool isBlocked) external;
}

/// @notice Drives random multi-pair channel lifecycles (funding, disputes, cooperative close, timeouts,
/// admin toggles, blocklisting) against a ChannelHub and tracks, independently of the contract's own
/// bookkeeping, everything the invariants in ChannelHub.invariant.t.sol check.
contract HubHandler is Test, ChessTestUtils {
    ChannelHub internal hub;
    ChessRules internal rules;
    IERC20 internal token;
    address internal owner;
    address internal feeRecipient;

    address[] internal participants; // pairs at [2i], [2i+1]
    address[] internal signers; // pairs at [2i], [2i+1]
    mapping(address => uint256) internal keyOf; // keyed by signer address
    address[] internal knownAddrs; // participants + signers + feeRecipient, for claim/blocklist/owed scans

    Params[] internal channels;

    // ---- ghosts (see ChannelHub.invariant.t.sol for what each backs) ----
    uint256 public ghostEscrow; // token held by the hub for live (Funding/Open/Challenged) channels
    uint256 public ghostCommitted; // mirrors ChannelHub.committedEscrow
    mapping(address => uint256) public ghostOwed; // mirrors ChannelHub.owed, updated from observed deltas
    mapping(bytes32 => uint64) internal ghostLastTurnNum;
    mapping(bytes32 => uint8) public ghostFinalizedCount;
    mapping(bytes32 => uint8) public ghostReclaimedCount;

    bool public turnNumViolation;
    bool public payoutMismatch;
    bool public pausedViolation;
    uint256 public deferredPayouts; // count of individual _pay calls observed to have deferred to `owed`

    uint256 internal nonce;

    constructor(
        ChannelHub hub_,
        ChessRules rules_,
        IERC20 token_,
        address owner_,
        address feeRecipient_,
        address[] memory participants_,
        address[] memory signers_,
        uint256[] memory keys_
    ) {
        require(
            participants_.length == signers_.length && signers_.length == keys_.length
                && participants_.length % 2 == 0 && participants_.length > 0,
            "pairs must come in twos"
        );
        hub = hub_;
        rules = rules_;
        token = token_;
        owner = owner_;
        feeRecipient = feeRecipient_;
        participants = participants_;
        signers = signers_;
        for (uint256 i = 0; i < signers_.length; i++) {
            keyOf[signers_[i]] = keys_[i];
            knownAddrs.push(participants_[i]);
            knownAddrs.push(signers_[i]);
        }
        knownAddrs.push(feeRecipient_);
    }

    // ------------------------------------------------------------- views for invariants

    function channelCount() external view returns (uint256) {
        return channels.length;
    }

    function channelIdAt(uint256 i) external view returns (bytes32) {
        return hub.channelId(channels[i]);
    }

    function ghostOwedTotal() external view returns (uint256 total) {
        for (uint256 i = 0; i < knownAddrs.length; i++) {
            total += ghostOwed[knownAddrs[i]];
        }
    }

    // ------------------------------------------------------------------ funding

    function create(uint256 pairSeed, uint256 depositSeed) external {
        uint256 numPairs = participants.length / 2;
        uint256 pi = pairSeed % numPairs;
        Params memory p;
        p.participants = [participants[2 * pi], participants[2 * pi + 1]];
        p.signers = [signers[2 * pi], signers[2 * pi + 1]];
        p.rules = address(rules);
        p.feeRecipient = feeRecipient;
        p.feePerPlayer = hub.feePerPlayer();
        p.stakePerGame = 100_000;
        p.deposit = bound(depositSeed, 100_000, 5_000_000);
        p.challengeTimeout = 600;
        p.fundingDeadline = uint64(block.timestamp + 1 hours);
        p.salt = keccak256(abi.encode(nonce++));
        vm.prank(p.participants[0]);
        try hub.deposit(abi.encode(p)) {
            ghostEscrow += p.deposit + p.feePerPlayer;
            ghostCommitted += 2 * (p.deposit + p.feePerPlayer);
            channels.push(p);
        } catch {}
    }

    function fund(uint256 idx) external {
        (bool found, Params memory p) = _pick(idx, ChannelHub.Phase.Funding);
        if (!found || block.timestamp > p.fundingDeadline) return;
        vm.prank(p.participants[1]);
        try hub.deposit(abi.encode(p)) {
            ghostEscrow += p.deposit + p.feePerPlayer;
        } catch {}
    }

    function reclaim(uint256 idx) external {
        (bool found, Params memory p) = _pick(idx, ChannelHub.Phase.Funding);
        if (!found) return;
        if (block.timestamp <= p.fundingDeadline) vm.warp(p.fundingDeadline + 1);
        bytes32 id = hub.channelId(p);
        ChannelHub.ChannelInfo memory info = hub.channelInfo(id);
        address[3] memory addrs = [p.participants[0], p.participants[1], feeRecipient];
        uint256[3] memory expected = [
            info.funded[0] ? p.deposit + p.feePerPlayer : 0,
            info.funded[1] ? p.deposit + p.feePerPlayer : 0,
            0
        ];
        (uint256[3] memory balBefore, uint256[3] memory owedBefore) = _snap(addrs);
        try hub.reclaim(id) {
            _checkPayout(addrs, expected, balBefore, owedBefore);
            uint256 commit = 2 * (p.deposit + p.feePerPlayer);
            ghostCommitted -= commit;
            if (info.funded[0]) ghostEscrow -= p.deposit + p.feePerPlayer;
            if (info.funded[1]) ghostEscrow -= p.deposit + p.feePerPlayer;
            ghostReclaimedCount[id] += 1;
        } catch (bytes memory reason) {
            _checkNotPaused(reason);
        }
    }

    function claim(uint256 seed) external {
        address addr = knownAddrs[seed % knownAddrs.length];
        uint256 amount = hub.owed(addr);
        if (amount == 0) return;
        vm.prank(addr);
        try hub.claim(addr) {
            if (ghostOwed[addr] != amount) payoutMismatch = true;
            ghostOwed[addr] = 0;
        } catch (bytes memory reason) {
            _checkNotPaused(reason);
        }
    }

    // ------------------------------------------------------------------- close

    /// @dev Closes on the opening state (line 0) or a resigned-and-terminal state (line 3): both are
    /// closable per ChannelHub.closeCooperative (turnNum 0, or `rules.isGameOver`).
    function closeCooperativeAction(uint256 idx, uint256 lineSeed) external {
        (bool found, Params memory p) = _pick(idx, ChannelHub.Phase.Open);
        if (!found) (found, p) = _pick(idx, ChannelHub.Phase.Challenged);
        if (!found) return;
        bytes32 id = hub.channelId(p);
        uint8 line = (lineSeed % 2 == 0) ? 0 : 3;
        State memory s = _lineState(id, p, line);
        // No staleness pre-check here: a stale `s` must be rejected by the hub itself (StaleState, caught
        // below), so this invariant suite actually exercises that guard rather than only mirroring it.
        SignedState memory ss = SignedState({
            state: s,
            sigA: _signClose(keyOf[p.signers[0]], s),
            sigB: _signClose(keyOf[p.signers[1]], s)
        });
        address[3] memory addrs = [p.participants[0], p.participants[1], feeRecipient];
        uint256[3] memory expected = [s.balanceA, s.balanceB, 2 * p.feePerPlayer];
        (uint256[3] memory balBefore, uint256[3] memory owedBefore) = _snap(addrs);
        try hub.closeCooperative(abi.encode(ss)) {
            _checkPayout(addrs, expected, balBefore, owedBefore);
            uint256 commit = 2 * (p.deposit + p.feePerPlayer);
            ghostCommitted -= commit;
            ghostEscrow -= commit;
            ghostFinalizedCount[id] += 1;
            _syncTurnNum(id);
        } catch (bytes memory reason) {
            _checkNotPaused(reason);
        }
    }

    // ---------------------------------------------------------------- dispute

    function challenge(uint256 idx, uint256 lineSeed, uint256 whoSeed) external {
        (bool found, Params memory p) = _pick(idx, ChannelHub.Phase.Open);
        if (!found) return;
        bytes32 id = hub.channelId(p);
        ChannelHub.ChannelInfo memory info = hub.channelInfo(id);
        uint8 line = uint8(lineSeed % 4);
        State memory s = _lineState(id, p, line);
        // No staleness pre-check: a stale/equivocating `s` must be rejected by the hub's own StaleState
        // guard (caught below), so this suite actually exercises that guard instead of only mirroring it.
        uint8 who = uint8(whoSeed % 2);
        if (block.timestamp < info.cooldownUntil[who]) return;
        bytes memory proof = _proof(s, p);
        vm.prank(p.participants[who]);
        try hub.challenge(proof) {
            _syncTurnNum(id);
        } catch {}
    }

    function respond(uint256 idx, uint256 lineSeed) external {
        (bool found, Params memory p) = _pick(idx, ChannelHub.Phase.Challenged);
        if (!found) return;
        bytes32 id = hub.channelId(p);
        ChannelHub.ChannelInfo memory info = hub.channelInfo(id);
        if (block.timestamp >= info.deadline) return;
        uint8 line = uint8(lineSeed % 4);
        State memory s = _lineState(id, p, line);
        // No staleness pre-check: same rationale as above.
        bytes memory proof = _proof(s, p);
        try hub.respond(proof) {
            _syncTurnNum(id);
        } catch {}
    }

    function timeoutChannel(uint256 idx) external {
        (bool found, Params memory p) = _pick(idx, ChannelHub.Phase.Challenged);
        if (!found) return;
        bytes32 id = hub.channelId(p);
        uint64 deadline = hub.channelInfo(id).deadline;
        if (block.timestamp < deadline) vm.warp(deadline);
        State memory reg = hub.registeredState(id);
        (uint256 aExp, uint256 bExp) =
            rules.isGameOver(reg) ? (reg.balanceA, reg.balanceB) : rules.forfeitBalances(reg, p);
        address[3] memory addrs = [p.participants[0], p.participants[1], feeRecipient];
        uint256[3] memory expected = [aExp, bExp, 2 * p.feePerPlayer];
        (uint256[3] memory balBefore, uint256[3] memory owedBefore) = _snap(addrs);
        try hub.timeout(id) {
            _checkPayout(addrs, expected, balBefore, owedBefore);
            uint256 commit = 2 * (p.deposit + p.feePerPlayer);
            ghostCommitted -= commit;
            ghostEscrow -= commit;
            ghostFinalizedCount[id] += 1;
            _syncTurnNum(id);
        } catch (bytes memory reason) {
            _checkNotPaused(reason);
        }
    }

    // ------------------------------------------------------------------ admin

    function ownerSetFee(uint256 feeSeed) external {
        // Deliberately allowed to exceed maxFeePerPlayer: the hub's own InvalidParams guard must reject it
        // (caught below), so this suite exercises that cap rather than only mirroring it in invariant 7.
        uint256 fee = bound(feeSeed, 0, 2 * hub.maxFeePerPlayer());
        vm.prank(owner);
        try hub.setFee(fee, feeRecipient) {} catch {}
    }

    function ownerSetLimits(uint256 depSeed, uint256 commitSeed) external {
        uint256 dep = bound(depSeed, 100_000, 50_000_000);
        uint256 commit = bound(commitSeed, 0, 1e18);
        vm.prank(owner);
        try hub.setLimits(dep, commit) {} catch {}
    }

    function ownerSetPaused(bool paused_) external {
        vm.prank(owner);
        try hub.setPaused(paused_) {} catch {}
    }

    /// @notice Invariant 6, reinforced: while paused, probe calls that a correct hub must reject for a
    /// *non-pause* reason (NothingToClaim / WrongPhase), so any `Paused()` selector here is unambiguously a
    /// violation — without risking a real (ghost-desyncing) settlement the way an unconstrained probe would.
    function probePausedExits(uint256 seed) external {
        if (!hub.paused()) return;
        address addr = knownAddrs[seed % knownAddrs.length];
        if (hub.owed(addr) == 0) {
            vm.prank(addr);
            (bool ok, bytes memory ret) = address(hub).call(abi.encodeCall(hub.claim, (addr)));
            if (!ok) _checkNotPaused(ret);
        }
        uint256 n = channels.length;
        if (n == 0) return;
        Params memory p = channels[seed % n];
        bytes32 id = hub.channelId(p);
        ChannelHub.Phase ph = hub.channelInfo(id).phase;
        if (ph == ChannelHub.Phase.Finalized || ph == ChannelHub.Phase.Reclaimed) {
            (bool ok1, bytes memory ret1) = address(hub).call(abi.encodeCall(hub.reclaim, (id)));
            if (!ok1) _checkNotPaused(ret1);
            (bool ok2, bytes memory ret2) = address(hub).call(abi.encodeCall(hub.timeout, (id)));
            if (!ok2) _checkNotPaused(ret2);
        }
    }

    function blockParticipant(uint256 seed) external {
        address addr = knownAddrs[seed % knownAddrs.length];
        IBlockableToken(address(token)).setBlocked(addr, true);
    }

    function unblockParticipant(uint256 seed) external {
        address addr = knownAddrs[seed % knownAddrs.length];
        IBlockableToken(address(token)).setBlocked(addr, false);
    }

    // --------------------------------------------------------------- internal

    /// @dev Invariant 6: none of the exit paths (reclaim, claim, closeCooperative, timeout) may ever revert
    /// with `Paused()` — only `deposit` is allowed to. Each of those functions' catch blocks routes its
    /// revert reason here, whether or not the hub happens to be paused right now.
    function _checkNotPaused(bytes memory reason) internal {
        if (reason.length >= 4 && bytes4(reason) == ChannelHub.Paused.selector) {
            pausedViolation = true;
        }
    }

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

    function _snap(address[3] memory addrs) internal view returns (uint256[3] memory bal, uint256[3] memory owedAmt) {
        for (uint256 i = 0; i < 3; i++) {
            bal[i] = token.balanceOf(addrs[i]);
            owedAmt[i] = hub.owed(addrs[i]);
        }
    }

    /// @dev Compares actually-delivered-or-deferred amounts (independently expected, per caller) against
    /// what the hub really did, and folds observed `owed` deltas into the ghost so invariant 1 stays exact.
    function _checkPayout(
        address[3] memory addrs,
        uint256[3] memory expected,
        uint256[3] memory balBefore,
        uint256[3] memory owedBefore
    ) internal {
        for (uint256 i = 0; i < 3; i++) {
            uint256 balAfter = token.balanceOf(addrs[i]);
            uint256 owedAfter = hub.owed(addrs[i]);
            uint256 delivered = (balAfter - balBefore[i]) + (owedAfter - owedBefore[i]);
            if (delivered != expected[i]) payoutMismatch = true;
            if (owedAfter > owedBefore[i]) {
                ghostOwed[addrs[i]] += (owedAfter - owedBefore[i]);
                deferredPayouts += 1;
            }
        }
    }

    function _syncTurnNum(bytes32 id) internal {
        if (!hub.channelInfo(id).hasRegistered) return;
        uint64 cur = hub.registeredState(id).turnNum;
        if (cur < ghostLastTurnNum[id]) {
            turnNumViolation = true;
        } else {
            ghostLastTurnNum[id] = cur;
        }
    }

    /// @dev Builds one of four fixed, legal lines from the opening state (spec §4/§12): the opening itself
    /// (0), one legal move (1), two legal moves (2), or a resignation making the game terminal (3).
    function _lineState(bytes32 id, Params memory p, uint8 line) internal view returns (State memory s) {
        s = rules.initialState(id, p);
        if (line == 0) return s;
        s = _step(s, p, uci("e2e4"));
        if (line == 1) return s;
        if (line == 3) return _step(s, p, _kind(B.KIND_RESIGN));
        s = _step(s, p, uci("e7e5"));
        return s; // line == 2
    }

    function _step(State memory prev, Params memory p, uint32 move) internal view returns (State memory next) {
        bool ok;
        (ok, next) = rules.successor(prev, move, p);
        require(ok, "handler: illegal fixed move");
        next.prevHash = hub.hashState(prev);
    }

    function _kind(uint8 kind) internal pure returns (uint32) {
        return B.encodeMove(0, 0, 0, kind);
    }

    function _proof(State memory s, Params memory p) internal view returns (bytes memory) {
        Proof memory pr;
        pr.latest.state = s;
        pr.latest.sigA = _sign(keyOf[p.signers[0]], s);
        pr.latest.sigB = _sign(keyOf[p.signers[1]], s);
        return abi.encode(pr);
    }

    function _sign(uint256 key, State memory s) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 sg) = vm.sign(key, hub.hashState(s));
        return abi.encodePacked(r, sg, v);
    }

    function _signClose(uint256 key, State memory s) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 sg) = vm.sign(key, hub.hashClose(s));
        return abi.encodePacked(r, sg, v);
    }
}
