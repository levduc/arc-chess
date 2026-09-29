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
    function blocked(address who) external view returns (bool);
}

/// @notice Drives random multi-pair channel lifecycles (funding, disputes, cooperative close, timeouts,
/// admin toggles, blocklisting, and deliberately adversarial attempts) against a ChannelHub and tracks,
/// independently of the contract's own bookkeeping, everything the invariants in ChannelHub.invariant.t.sol
/// check.
contract HubHandler is Test, ChessTestUtils {
    /// @dev An unrelated, always-wrong signing key: any signature produced with it must fail `_signedBy`
    /// against a real signer, used to test that the hub actually checks signatures rather than ignoring them.
    uint256 internal constant BAD_KEY = 0xB1;

    ChannelHub internal hub;
    ChessRules internal rules;
    IERC20 internal token;
    address internal owner;

    address[] internal participants; // pairs at [2i], [2i+1]
    address[] internal signers; // pairs at [2i], [2i+1]
    address[] internal feeRecipients; // >=2, so the fee recipient actually changes over the run
    mapping(address => uint256) internal keyOf; // keyed by signer address
    address[] internal knownAddrs; // participants + feeRecipients only (the only addresses that ever get paid)

    Params[] internal channels;

    // ---- ghosts (see ChannelHub.invariant.t.sol for what each backs) ----
    uint256 public ghostEscrow; // token held by the hub for live (Funding/Open/Challenged) channels
    uint256 public ghostCommitted; // mirrors ChannelHub.committedEscrow
    mapping(address => uint256) public ghostOwed; // mirrors ChannelHub.owed, updated from observed deltas
    mapping(bytes32 => uint64) internal ghostLastTurnNum;
    mapping(bytes32 => uint8) public ghostFinalizedCount;
    mapping(bytes32 => uint8) public ghostReclaimedCount;
    mapping(bytes32 => uint8) public ghostLine; // last line (0-3) successfully registered per channel

    bool public turnNumViolation;
    bool public payoutMismatch;
    bool public pausedViolation;
    bool public livenessViolation; // a call reverted despite every precondition the handler controls being met
    bool public adversarialViolation; // a call the hub must reject (bad sender/sig/phase/timing) succeeded
    bool public registrationViolation; // registeredState didn't match what a successful challenge/respond submitted
    bool public staleCloseViolation; // closeCooperative succeeded on a state staler than one already registered
    uint256 public deferredPayouts; // count of individual _pay calls observed to have deferred to `owed`

    uint256 internal nonce;

    constructor(
        ChannelHub hub_,
        ChessRules rules_,
        IERC20 token_,
        address owner_,
        address[] memory participants_,
        address[] memory signers_,
        uint256[] memory keys_,
        address[] memory feeRecipients_
    ) {
        require(
            participants_.length == signers_.length && signers_.length == keys_.length
                && participants_.length % 2 == 0 && participants_.length > 0,
            "pairs must come in twos"
        );
        require(feeRecipients_.length >= 2, "need >=2 fee recipients");
        hub = hub_;
        rules = rules_;
        token = token_;
        owner = owner_;
        participants = participants_;
        signers = signers_;
        feeRecipients = feeRecipients_;
        for (uint256 i = 0; i < signers_.length; i++) {
            keyOf[signers_[i]] = keys_[i];
        }
        for (uint256 i = 0; i < participants_.length; i++) {
            knownAddrs.push(participants_[i]);
        }
        for (uint256 i = 0; i < feeRecipients_.length; i++) {
            knownAddrs.push(feeRecipients_[i]);
        }
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
        p.feeRecipient = hub.feeRecipient(); // snapshot the CURRENT recipient (it may change over the run)
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
        bool mayLegitimatelyFail = hub.paused() || _isBlocked(p.participants[1]);
        vm.prank(p.participants[1]);
        try hub.deposit(abi.encode(p)) {
            ghostEscrow += p.deposit + p.feePerPlayer;
        } catch {
            // deposit() legitimately reverts Paused() (spec §13); that alone is never a violation here —
            // only an unexplained revert (neither paused nor a blocked sender) is (see mayLegitimatelyFail).
            if (!mayLegitimatelyFail) livenessViolation = true;
        }
    }

    function reclaim(uint256 idx) external {
        (bool found, Params memory p) = _pick(idx, ChannelHub.Phase.Funding);
        if (!found) return;
        if (block.timestamp <= p.fundingDeadline) vm.warp(p.fundingDeadline + 1);
        bytes32 id = hub.channelId(p);
        ChannelHub.ChannelInfo memory info = hub.channelInfo(id);
        address[3] memory addrs = [p.participants[0], p.participants[1], p.feeRecipient];
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
            livenessViolation = true; // phase==Funding and deadline passed: reclaim must always succeed
        }
    }

    /// @dev Unblocks the recipient first (claim always pays `to == msg.sender`), so a real claim, not just
    /// an attempt, actually goes through — the original design could populate `owed` and then never be
    /// able to drain it, undercounting how often the claim path truly executes.
    function claim(uint256 seed) external {
        address addr = knownAddrs[seed % knownAddrs.length];
        uint256 amount = hub.owed(addr);
        if (amount == 0) return;
        IBlockableToken(address(token)).setBlocked(addr, false);
        vm.prank(addr);
        try hub.claim(addr) {
            if (ghostOwed[addr] != amount) payoutMismatch = true;
            ghostOwed[addr] = 0;
        } catch (bytes memory reason) {
            _checkNotPaused(reason);
            livenessViolation = true; // owed>0 and unblocked: claim must always succeed
        }
    }

    // ------------------------------------------------------------------- close

    /// @dev Closes on the opening state (line 0) or a resigned-and-terminal state (line 3): both are
    /// closable per ChannelHub.closeCooperative (turnNum 0, or `rules.isGameOver`). No staleness
    /// pre-check: a stale `s` must be rejected by the hub itself (StaleState, caught below).
    function closeCooperativeAction(uint256 idx, uint256 lineSeed) external {
        (bool found, Params memory p) = _pick(idx, ChannelHub.Phase.Open);
        if (!found) (found, p) = _pick(idx, ChannelHub.Phase.Challenged);
        if (!found) return;
        bytes32 id = hub.channelId(p);
        uint8 line = (lineSeed % 2 == 0) ? 0 : 3;
        State memory s = _lineState(id, p, line);
        SignedState memory ss = SignedState({
            state: s,
            sigA: _signClose(keyOf[p.signers[0]], s),
            sigB: _signClose(keyOf[p.signers[1]], s)
        });
        address[3] memory addrs = [p.participants[0], p.participants[1], p.feeRecipient];
        uint256[3] memory expected = [s.balanceA, s.balanceB, 2 * p.feePerPlayer];
        (uint256[3] memory balBefore, uint256[3] memory owedBefore) = _snap(addrs);
        try hub.closeCooperative(abi.encode(ss)) {
            if (s.turnNum < ghostLastTurnNum[id]) staleCloseViolation = true;
            _checkPayout(addrs, expected, balBefore, owedBefore);
            uint256 commit = 2 * (p.deposit + p.feePerPlayer);
            ghostCommitted -= commit;
            ghostEscrow -= commit;
            ghostFinalizedCount[id] += 1;
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
        uint8 who = uint8(whoSeed % 2);
        if (block.timestamp < info.cooldownUntil[who]) return;
        bytes memory proof = _proof(s, p);
        vm.prank(p.participants[who]);
        try hub.challenge(proof) {
            _afterRegister(id, line, s);
        } catch (bytes memory reason) {
            _checkNotPaused(reason);
        }
    }

    function respond(uint256 idx, uint256 lineSeed) external {
        (bool found, Params memory p) = _pick(idx, ChannelHub.Phase.Challenged);
        if (!found) return;
        bytes32 id = hub.channelId(p);
        if (block.timestamp >= hub.channelInfo(id).deadline) return;
        uint8 line = uint8(lineSeed % 4);
        State memory s = _lineState(id, p, line);
        bytes memory proof = _proof(s, p);
        try hub.respond(proof) {
            _afterRegister(id, line, s);
        } catch (bytes memory reason) {
            _checkNotPaused(reason);
        }
    }

    function timeoutChannel(uint256 idx) external {
        (bool found, Params memory p) = _pick(idx, ChannelHub.Phase.Challenged);
        if (!found) return;
        bytes32 id = hub.channelId(p);
        uint64 deadline = hub.channelInfo(id).deadline;
        if (block.timestamp < deadline) vm.warp(deadline);
        // Expected payout is derived from the ghost of the last *successfully submitted* line, not from
        // re-reading the hub's own `registeredState` — otherwise a bug in challenge/respond that fails to
        // register (e.g. F17) would be invisible here, because both sides would read the same stale state.
        State memory reg = _lineState(id, p, ghostLine[id]);
        (uint256 aExp, uint256 bExp) =
            rules.isGameOver(reg) ? (reg.balanceA, reg.balanceB) : rules.forfeitBalances(reg, p);
        address[3] memory addrs = [p.participants[0], p.participants[1], p.feeRecipient];
        uint256[3] memory expected = [aExp, bExp, 2 * p.feePerPlayer];
        (uint256[3] memory balBefore, uint256[3] memory owedBefore) = _snap(addrs);
        try hub.timeout(id) {
            _checkPayout(addrs, expected, balBefore, owedBefore);
            uint256 commit = 2 * (p.deposit + p.feePerPlayer);
            ghostCommitted -= commit;
            ghostEscrow -= commit;
            ghostFinalizedCount[id] += 1;
        } catch (bytes memory reason) {
            _checkNotPaused(reason);
            livenessViolation = true; // phase==Challenged and deadline reached: timeout must always succeed
        }
    }

    // ------------------------------------------------------------------ admin

    function ownerSetFee(uint256 feeSeed, uint256 recipientSeed) external {
        // Mostly in-cap (so setFee actually succeeds and the recipient genuinely switches between channel
        // creation and settlement — needed to exercise a fee-paid-to-the-wrong-recipient bug), occasionally
        // above cap so invariant 7's own rejection path stays exercised too.
        uint256 fee = bound(feeSeed, 0, hub.maxFeePerPlayer() + hub.maxFeePerPlayer() / 4);
        address recipient = feeRecipients[recipientSeed % feeRecipients.length];
        vm.prank(owner);
        try hub.setFee(fee, recipient) {} catch {}
    }

    function ownerSetLimits(uint256 depSeed, uint256 commitSeed) external {
        uint256 dep = bound(depSeed, 100_000, 50_000_000);
        uint256 commit = bound(commitSeed, 0, 1e18);
        vm.prank(owner);
        try hub.setLimits(dep, commit) {} catch {}
    }

    /// @dev Biased toward unpaused (~10% true), so exit actions (reclaim/close/timeout/claim/challenge/
    /// respond) run under both pause states across a run instead of coin-flipping into gridlock.
    function ownerSetPaused(uint256 seed) external {
        bool wantPaused = (seed % 10 == 0);
        vm.prank(owner);
        try hub.setPaused(wantPaused) {} catch {}
    }

    /// @notice Invariant 6, reinforced. Two safe probes while paused:
    /// (a) `claim` on an address with nothing owed -> a correct hub rejects with `NothingToClaim`.
    /// (b) reclaim/timeout/challenge/respond/closeCooperative on an already-Finalized/Reclaimed channel,
    ///     using minimal (possibly garbage) payloads -> every one of those five must reject with
    ///     `WrongPhase` *before* touching anything else, so this is safe regardless of payload contents
    ///     and can never accidentally trigger a real settlement.
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
        if (ph != ChannelHub.Phase.Finalized && ph != ChannelHub.Phase.Reclaimed) return;
        _probeMustReject(abi.encodeCall(hub.reclaim, (id)));
        _probeMustReject(abi.encodeCall(hub.timeout, (id)));
        Proof memory pr;
        pr.latest.state.channelId = id;
        _probeMustReject(abi.encodeCall(hub.challenge, (abi.encode(pr))));
        _probeMustReject(abi.encodeCall(hub.respond, (abi.encode(pr))));
        SignedState memory ss;
        ss.state.channelId = id;
        _probeMustReject(abi.encodeCall(hub.closeCooperative, (abi.encode(ss))));
    }

    function _probeMustReject(bytes memory data) internal {
        (bool ok, bytes memory ret) = address(hub).call(data);
        if (!ok) {
            _checkNotPaused(ret);
        } else {
            adversarialViolation = true; // a terminal channel accepted a state-mutating call
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

    // ------------------------------------------------------------- adversarial
    // Each of these attempts something a correct hub must reject (wrong sender, wrong signature, wrong
    // phase/timing, or a repeat), catches the (expected) revert, and only ever updates ghosts from the
    // actually-observed effect if the call unexpectedly succeeds — in which case it also flags a violation.

    function adversarialChallenge(uint256 idx, uint256 lineSeed, uint256 senderSeed) external {
        (bool found, Params memory p) = _pick(idx, ChannelHub.Phase.Open);
        if (!found) return;
        bytes32 id = hub.channelId(p);
        uint8 line = uint8(lineSeed % 4);
        State memory s = _lineState(id, p, line);
        bytes memory proof = _proof(s, p);
        address sender = _adversarialSender(senderSeed, p);
        bool authorized = sender == p.participants[0] || sender == p.participants[1] || sender == p.signers[0]
            || sender == p.signers[1];
        vm.prank(sender);
        try hub.challenge(proof) {
            if (!authorized) adversarialViolation = true;
            _afterRegister(id, line, s);
        } catch (bytes memory reason) {
            _checkNotPaused(reason);
        }
    }

    /// @notice A hasPrev proof built from two consecutive, correctly-signed lines (opening -> one move),
    /// exercising the `_supported` hasPrev branch that the solo-proof-only normal actions never reach.
    function adversarialHasPrevChallenge(uint256 idx) external {
        (bool found, Params memory p) = _pick(idx, ChannelHub.Phase.Open);
        if (!found) return;
        bytes32 id = hub.channelId(p);
        State memory prevState = _lineState(id, p, 0); // opening: needs no signature to be endorsed
        State memory latestState = _lineState(id, p, 1); // one legal move, white (signers[0]) to have moved
        Proof memory pr;
        pr.hasPrev = true;
        pr.prev.state = prevState;
        pr.latest.state = latestState;
        pr.latest.sigA = _sign(keyOf[p.signers[0]], latestState);
        vm.prank(p.participants[0]);
        try hub.challenge(abi.encode(pr)) {
            _afterRegister(id, 1, latestState);
        } catch (bytes memory reason) {
            _checkNotPaused(reason);
        }
    }

    /// @notice Challenge or respond with one signature corrupted (turnNum > 0, so a signature is actually
    /// required) — a correct hub must reject with BadSignature (kills a signature-check-removed mutant).
    function adversarialBadSig(uint256 idx, uint256 lineSeed, uint256 targetSeed) external {
        uint8 line = uint8(1 + (lineSeed % 3)); // never 0: the opening needs no signature at all
        bool useRespond = (targetSeed % 2 == 1);
        (bool found, Params memory p) = _pick(idx, useRespond ? ChannelHub.Phase.Challenged : ChannelHub.Phase.Open);
        if (!found) return;
        bytes32 id = hub.channelId(p);
        if (useRespond && block.timestamp >= hub.channelInfo(id).deadline) return;
        State memory s = _lineState(id, p, line);
        Proof memory pr;
        pr.latest.state = s;
        pr.latest.sigA = _sign(keyOf[p.signers[0]], s);
        pr.latest.sigB = _badSig(hub.hashState(s));
        bytes memory proof = abi.encode(pr);
        if (useRespond) {
            try hub.respond(proof) {
                adversarialViolation = true;
                _afterRegister(id, line, s);
            } catch (bytes memory reason) {
                _checkNotPaused(reason);
            }
        } else {
            try hub.challenge(proof) {
                adversarialViolation = true;
                _afterRegister(id, line, s);
            } catch (bytes memory reason) {
                _checkNotPaused(reason);
            }
        }
    }

    /// @notice Cooperative close on a non-terminal line (F4: NotClosable removed) or with a corrupted
    /// close signature (F13: signature check removed) — a correct hub must reject both.
    function adversarialClose(uint256 idx, uint256 lineSeed, uint256 corruptSeed) external {
        (bool found, Params memory p) = _pick(idx, ChannelHub.Phase.Open);
        if (!found) (found, p) = _pick(idx, ChannelHub.Phase.Challenged);
        if (!found) return;
        bytes32 id = hub.channelId(p);
        uint8 line = uint8(lineSeed % 4);
        State memory s = _lineState(id, p, line);
        uint8 corrupt = uint8(corruptSeed % 3); // 0 = none, 1 = corrupt sigA, 2 = corrupt sigB
        bytes memory sigA = corrupt == 1 ? _badSig(hub.hashClose(s)) : _signClose(keyOf[p.signers[0]], s);
        bytes memory sigB = corrupt == 2 ? _badSig(hub.hashClose(s)) : _signClose(keyOf[p.signers[1]], s);
        SignedState memory ss = SignedState({state: s, sigA: sigA, sigB: sigB});
        address[3] memory addrs = [p.participants[0], p.participants[1], p.feeRecipient];
        uint256[3] memory expected = [s.balanceA, s.balanceB, 2 * p.feePerPlayer];
        (uint256[3] memory balBefore, uint256[3] memory owedBefore) = _snap(addrs);
        try hub.closeCooperative(abi.encode(ss)) {
            bool nonTerminal = (line == 1 || line == 2);
            if (nonTerminal || corrupt != 0) adversarialViolation = true;
            if (s.turnNum < ghostLastTurnNum[id]) staleCloseViolation = true;
            _checkPayout(addrs, expected, balBefore, owedBefore);
            uint256 commit = 2 * (p.deposit + p.feePerPlayer);
            ghostCommitted -= commit;
            ghostEscrow -= commit;
            ghostFinalizedCount[id] += 1;
        } catch (bytes memory reason) {
            _checkNotPaused(reason);
        }
    }

    /// @notice A second deposit from the participant that already funded (F5: AlreadyFunded removed).
    function adversarialDeposit(uint256 idx) external {
        (bool found, Params memory p) = _pick(idx, ChannelHub.Phase.Funding);
        if (!found) (found, p) = _pick(idx, ChannelHub.Phase.Open);
        if (!found) return;
        vm.prank(p.participants[0]); // always the participant `create()` funded first
        try hub.deposit(abi.encode(p)) {
            adversarialViolation = true;
            ghostEscrow += p.deposit + p.feePerPlayer; // deposit() always moves exactly this much in
        } catch {
            // deposit() is the one function that legitimately reverts Paused() (spec §13) — unlike every
            // other action here, that is not itself a violation, so we don't route it to _checkNotPaused.
        }
    }

    /// @notice timeout strictly before the deadline (F11: TooEarly removed/weakened).
    function adversarialTimeout(uint256 idx) external {
        (bool found, Params memory p) = _pick(idx, ChannelHub.Phase.Challenged);
        if (!found) return;
        bytes32 id = hub.channelId(p);
        if (block.timestamp >= hub.channelInfo(id).deadline) return;
        try hub.timeout(id) {
            adversarialViolation = true;
            State memory reg = _lineState(id, p, ghostLine[id]);
            uint256 commit = 2 * (p.deposit + p.feePerPlayer);
            ghostCommitted -= commit;
            ghostEscrow -= commit;
            ghostFinalizedCount[id] += 1;
        } catch (bytes memory reason) {
            _checkNotPaused(reason);
        }
    }

    /// @notice respond at or after the deadline (F12: DeadlinePassed removed/weakened).
    function adversarialRespondLate(uint256 idx, uint256 lineSeed) external {
        (bool found, Params memory p) = _pick(idx, ChannelHub.Phase.Challenged);
        if (!found) return;
        bytes32 id = hub.channelId(p);
        ChannelHub.ChannelInfo memory info = hub.channelInfo(id);
        if (block.timestamp < info.deadline) return;
        uint8 line = uint8(lineSeed % 4);
        State memory s = _lineState(id, p, line);
        if (s.turnNum <= hub.registeredState(id).turnNum) return;
        bytes memory proof = _proof(s, p);
        try hub.respond(proof) {
            adversarialViolation = true;
            _afterRegister(id, line, s);
        } catch (bytes memory reason) {
            _checkNotPaused(reason);
        }
    }

    /// @notice claim with nothing owed (NothingToClaim removed).
    function adversarialClaimNothing(uint256 seed) external {
        address addr = knownAddrs[seed % knownAddrs.length];
        if (hub.owed(addr) != 0) return;
        vm.prank(addr);
        try hub.claim(addr) {
            adversarialViolation = true;
        } catch (bytes memory reason) {
            _checkNotPaused(reason);
        }
    }

    // --------------------------------------------------------------- internal

    /// @dev Invariant 6: none of the exit paths (reclaim, claim, closeCooperative, timeout, challenge,
    /// respond) may ever revert with `Paused()` — only `deposit` is allowed to. Every catch block routes
    /// its revert reason here, whether or not the hub happens to be paused right now.
    function _checkNotPaused(bytes memory reason) internal {
        if (reason.length >= 4 && bytes4(reason) == ChannelHub.Paused.selector) {
            pausedViolation = true;
        }
    }

    function _isBlocked(address who) internal view returns (bool) {
        return IBlockableToken(address(token)).blocked(who);
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
            if (balAfter < balBefore[i] || owedAfter < owedBefore[i]) {
                // Should never happen (nothing here ever decreases); guard rather than let an unchecked
                // subtraction revert the handler call (which would be misclassified under fail_on_revert).
                payoutMismatch = true;
                continue;
            }
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

    /// @dev Called after every successful challenge/respond (normal or adversarial) that submitted a
    /// `_lineState`-built state. Records which line is now registered (so `timeoutChannel` can compute its
    /// expected payout independently of the hub's own `registeredState`) and checks that the hub's
    /// registered state actually is what was just submitted (kills a "respond doesn't register" mutant).
    function _afterRegister(bytes32 id, uint8 line, State memory s) internal {
        ghostLine[id] = line;
        State memory reg = hub.registeredState(id);
        if (reg.turnNum != s.turnNum || hub.hashState(reg) != hub.hashState(s)) {
            registrationViolation = true;
        }
        _syncTurnNum(id);
    }

    function _adversarialSender(uint256 seed, Params memory p) internal pure returns (address) {
        uint256 k = seed % 5;
        if (k == 0) return address(uint160(uint256(keccak256(abi.encode("adversarial-stranger", seed)))));
        if (k == 1) return p.participants[0];
        if (k == 2) return p.participants[1];
        if (k == 3) return p.signers[0];
        return p.signers[1];
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

    function _badSig(bytes32 hash) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 sg) = vm.sign(BAD_KEY, hash);
        return abi.encodePacked(r, sg, v);
    }
}
