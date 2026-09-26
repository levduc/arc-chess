// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Params, State, SignedState, Proof} from "./ArenaTypes.sol";
import {IGameRules} from "./IGameRules.sol";

/// @notice Two-party state-channel adjudicator with force-move disputes (spec §4.6). Non-upgradeable.
contract ChannelHub is EIP712, Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum Phase {
        None,
        Funding,
        Open,
        Challenged,
        Finalized,
        Reclaimed
    }

    struct Channel {
        Phase phase;
        bool[2] funded;
        bool hasRegistered;
        uint8 challenger;
        uint64 deadline;
        uint64[2] cooldownUntil;
        bytes32 registeredHash;
        State registered;
        Params params;
    }

    struct ChannelInfo {
        Phase phase;
        bool[2] funded;
        bool hasRegistered;
        uint8 challenger;
        uint64 deadline;
        uint64[2] cooldownUntil;
        bytes32 registeredHash;
    }

    bytes32 public constant STATE_TYPEHASH = keccak256(
        "State(bytes32 channelId,uint64 turnNum,bytes32 prevHash,uint256 balanceA,uint256 balanceB,uint32 gameIndex,uint32 move,uint256 board,uint256 meta)"
    );
    /// @dev Cooperative-close intent. Distinct from STATE_TYPEHASH so co-signed game states never close a channel.
    bytes32 public constant CLOSE_TYPEHASH = keccak256("Close(bytes32 channelId,bytes32 stateHash)");
    uint64 public constant MIN_TIMEOUT = 60;
    uint64 public constant MAX_TIMEOUT = 7 days;

    IERC20 public immutable token;
    uint256 public immutable maxFeePerPlayer;
    uint256 public feePerPlayer;
    address public feeRecipient;
    /// @notice Spec §13 launch limits. `maxDepositPerPlayer` and `maxCommittedEscrow` are checked only when a
    /// channel is created; lowering them never affects channels already created. `paused` blocks only `deposit`.
    uint256 public maxDepositPerPlayer;
    uint256 public maxCommittedEscrow;
    uint256 public committedEscrow;
    bool public paused;
    mapping(address => uint256) public owed;
    mapping(bytes32 => Channel) internal _channels;

    event ChannelCreated(bytes32 indexed channelId, bytes params);
    event Deposited(bytes32 indexed channelId, uint8 indexed player, uint256 amount);
    event Opened(bytes32 indexed channelId);
    event Challenged(bytes32 indexed channelId, uint8 indexed challenger, uint64 turnNum, uint64 deadline, bytes signedState);
    event Responded(bytes32 indexed channelId, uint64 turnNum, bytes signedState);
    event Finalized(bytes32 indexed channelId, uint256 balanceA, uint256 balanceB, uint256 fee);
    event Reclaimed(bytes32 indexed channelId);
    event PayoutDeferred(address indexed to, uint256 amount);
    event Claimed(address indexed from, address indexed to, uint256 amount);
    // Admin-only, emitted once per setFee call; indexing feeRecipient would not help off-chain filtering
    // since it always changes together with feePerPlayer.
    // slither-disable-next-line unindexed-event-address
    event FeeUpdated(uint256 feePerPlayer, address feeRecipient);
    event LimitsUpdated(uint256 maxDepositPerPlayer, uint256 maxCommittedEscrow);
    event PausedSet(bool paused);

    error WrongPhase();
    error InvalidParams();
    error FeeMismatch();
    error FundingClosed();
    error NotParticipant();
    error AlreadyFunded();
    error TooEarly();
    error DeadlinePassed();
    error BadSignature();
    error Unsupported();
    error InvalidTransition();
    error StaleState();
    error NotClosable();
    error BalanceMismatch();
    error InCooldown();
    error NothingToClaim();
    error DepositTooLarge();
    error EscrowCapReached();
    error Paused();

    constructor(
        IERC20 token_,
        address owner_,
        address feeRecipient_,
        uint256 feePerPlayer_,
        uint256 maxFeePerPlayer_,
        uint256 maxDepositPerPlayer_,
        uint256 maxCommittedEscrow_
    ) EIP712("AgentArena", "1") Ownable(owner_) {
        if (address(token_).code.length == 0) revert InvalidParams();
        token = token_;
        maxFeePerPlayer = maxFeePerPlayer_;
        _setFee(feePerPlayer_, feeRecipient_);
        _setLimits(maxDepositPerPlayer_, maxCommittedEscrow_);
    }

    // ----------------------------------------------------------------- views

    function channelId(Params memory p) public view returns (bytes32) {
        return keccak256(abi.encode(block.chainid, address(this), p));
    }

    function hashState(State memory s) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    STATE_TYPEHASH,
                    s.channelId,
                    s.turnNum,
                    s.prevHash,
                    s.balanceA,
                    s.balanceB,
                    s.gameIndex,
                    s.move,
                    s.board,
                    s.meta
                )
            )
        );
    }

    /// @notice EIP-712 digest both signers sign to agree to settle on `s`.
    function hashClose(State memory s) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(CLOSE_TYPEHASH, s.channelId, hashState(s))));
    }

    function channelInfo(bytes32 id) external view returns (ChannelInfo memory info) {
        Channel storage c = _channels[id];
        info = ChannelInfo(
            c.phase, c.funded, c.hasRegistered, c.challenger, c.deadline, c.cooldownUntil, c.registeredHash
        );
    }

    function channelParams(bytes32 id) external view returns (Params memory) {
        return _channels[id].params;
    }

    function registeredState(bytes32 id) external view returns (State memory) {
        return _channels[id].registered;
    }

    // --------------------------------------------------------------- funding

    /// @notice Fund your side of a channel. Calling this is the participant's consent to every field of `params`.
    function deposit(bytes calldata encodedParams) external nonReentrant {
        if (paused) revert Paused();
        Params memory p = abi.decode(encodedParams, (Params));
        bytes32 id = channelId(p);
        Channel storage c = _channels[id];
        if (c.phase == Phase.None) {
            _validateNewParams(p);
            if (p.deposit > maxDepositPerPlayer) revert DepositTooLarge();
            uint256 commit = 2 * (p.deposit + p.feePerPlayer);
            if (committedEscrow + commit > maxCommittedEscrow) revert EscrowCapReached();
            committedEscrow += commit;
            c.phase = Phase.Funding;
            c.params = p;
            emit ChannelCreated(id, abi.encode(p));
        } else if (c.phase != Phase.Funding) {
            revert WrongPhase();
        }
        // Funding deadlines are minutes-to-days long; ~seconds of miner drift cannot flip this comparison.
        // slither-disable-next-line timestamp
        if (block.timestamp > p.fundingDeadline) revert FundingClosed();
        uint8 i = _participantIndex(p, msg.sender);
        if (c.funded[i]) revert AlreadyFunded();
        c.funded[i] = true;
        uint256 amount = p.deposit + p.feePerPlayer;
        emit Deposited(id, i, amount);
        if (c.funded[0] && c.funded[1]) {
            c.phase = Phase.Open;
            emit Opened(id);
        }
        token.safeTransferFrom(msg.sender, address(this), amount);
    }

    /// @notice Refund a channel that never fully funded. Anyone may call after the funding deadline.
    function reclaim(bytes32 id) external nonReentrant {
        Channel storage c = _channels[id];
        if (c.phase != Phase.Funding) revert WrongPhase();
        Params memory p = c.params;
        // Same fundingDeadline check as deposit(); miner-scale drift is immaterial against a minutes-to-days window.
        // slither-disable-next-line timestamp
        if (block.timestamp <= p.fundingDeadline) revert TooEarly();
        c.phase = Phase.Reclaimed;
        committedEscrow -= 2 * (p.deposit + p.feePerPlayer);
        emit Reclaimed(id);
        uint256 amount = p.deposit + p.feePerPlayer;
        if (c.funded[0]) _pay(p.participants[0], amount);
        if (c.funded[1]) _pay(p.participants[1], amount);
    }

    /// @notice Withdraw payouts that could not be pushed (e.g. the recipient was blocked by the token).
    function claim(address to) external nonReentrant {
        uint256 amount = owed[msg.sender];
        if (amount == 0) revert NothingToClaim();
        owed[msg.sender] = 0;
        emit Claimed(msg.sender, to, amount);
        token.safeTransfer(to, amount);
    }

    // ----------------------------------------------------------------- close

    /// @notice Settle immediately on a state both players signed a `Close` intent for (see `hashClose`): the
    /// opening state, a NEW_GAME checkpoint, or a finished game. Game results are already applied to balances in
    /// such states. Co-signed game states alone never close, so an earlier checkpoint cannot be replayed here.
    function closeCooperative(bytes calldata encodedSignedState) external nonReentrant {
        SignedState memory ss = abi.decode(encodedSignedState, (SignedState));
        State memory s = ss.state;
        bytes32 id = s.channelId;
        Channel storage c = _channels[id];
        if (c.phase != Phase.Open && c.phase != Phase.Challenged) revert WrongPhase();
        Params memory p = c.params;
        _checkBalances(p, s);
        bytes32 h = hashClose(s);
        if (!_signedBy(p.signers[0], h, ss.sigA) || !_signedBy(p.signers[1], h, ss.sigB)) revert BadSignature();
        IGameRules rules = IGameRules(p.rules);
        if (s.turnNum != 0 && !rules.isCheckpoint(s) && !rules.isGameOver(s)) revert NotClosable();
        if (c.hasRegistered && s.turnNum < c.registered.turnNum) revert StaleState();
        _finalize(id, c, p, s.balanceA, s.balanceB);
    }

    // --------------------------------------------------------------- dispute

    /// @notice Register a supported state on-chain and start the clock for the player on move.
    /// Callable by either player's wallet or session key. A state with the same turnNum as the registered
    /// one is accepted only if it is identical, which lets the waiting player challenge after a response.
    function challenge(bytes calldata encodedProof) external nonReentrant {
        Proof memory proof = abi.decode(encodedProof, (Proof));
        bytes32 id = proof.latest.state.channelId;
        Channel storage c = _channels[id];
        if (c.phase != Phase.Open) revert WrongPhase();
        Params memory p = c.params;
        uint8 who = _playerIndex(p, msg.sender);
        // Cooldown windows equal challengeTimeout (bounded by MIN_TIMEOUT/MAX_TIMEOUT), far larger than any
        // miner-controllable drift.
        // slither-disable-next-line timestamp
        if (block.timestamp < c.cooldownUntil[who]) revert InCooldown();
        (State memory s, bytes32 h) = _supported(c, p, id, proof);
        if (c.hasRegistered) {
            uint64 reg = c.registered.turnNum;
            if (s.turnNum < reg || (s.turnNum == reg && h != c.registeredHash)) revert StaleState();
        }
        _register(c, s, h);
        c.challenger = who;
        c.deadline = uint64(block.timestamp) + p.challengeTimeout;
        c.phase = Phase.Challenged;
        emit Challenged(id, who, s.turnNum, c.deadline, abi.encode(proof.latest));
    }

    /// @notice Answer a challenge with any supported newer state. Returns the channel to off-chain play and
    /// puts the challenger in cooldown for one challengeTimeout.
    function respond(bytes calldata encodedProof) external nonReentrant {
        Proof memory proof = abi.decode(encodedProof, (Proof));
        bytes32 id = proof.latest.state.channelId;
        Channel storage c = _channels[id];
        if (c.phase != Phase.Challenged) revert WrongPhase();
        // Same challengeTimeout-scale deadline as timeout() below; not sensitive to miner-scale timestamp drift.
        // slither-disable-next-line timestamp
        if (block.timestamp >= c.deadline) revert DeadlinePassed();
        Params memory p = c.params;
        (State memory s, bytes32 h) = _supported(c, p, id, proof);
        if (s.turnNum <= c.registered.turnNum) revert StaleState();
        _register(c, s, h);
        c.cooldownUntil[c.challenger] = uint64(block.timestamp) + p.challengeTimeout;
        c.phase = Phase.Open;
        emit Responded(id, s.turnNum, abi.encode(proof.latest));
    }

    /// @notice After an unanswered challenge: the player on move forfeits the current game, or a finished
    /// game settles as-is. Anyone may call.
    function timeout(bytes32 id) external nonReentrant {
        Channel storage c = _channels[id];
        if (c.phase != Phase.Challenged) revert WrongPhase();
        // challengeTimeout-scale deadline; miner-scale drift cannot meaningfully move a dispute window
        // measured in minutes or more.
        // slither-disable-next-line timestamp
        if (block.timestamp < c.deadline) revert TooEarly();
        State memory s = c.registered;
        Params memory p = c.params;
        IGameRules rules = IGameRules(p.rules);
        uint256 a = s.balanceA;
        uint256 b = s.balanceB;
        if (!rules.isGameOver(s)) (a, b) = rules.forfeitBalances(s, p);
        _finalize(id, c, p, a, b);
    }

    // ----------------------------------------------------------------- admin

    /// @notice Set the fee for channels created from now on. Existing channels keep their snapshot.
    function setFee(uint256 feePerPlayer_, address feeRecipient_) external onlyOwner {
        _setFee(feePerPlayer_, feeRecipient_);
    }

    /// @notice Set the per-channel deposit cap and the total commitment cap (spec §13). Both are checked only
    /// when a channel is created, so lowering either never affects a channel already created, and the second
    /// deposit into an existing channel is never blocked by them.
    function setLimits(uint256 maxDepositPerPlayer_, uint256 maxCommittedEscrow_) external onlyOwner {
        _setLimits(maxDepositPerPlayer_, maxCommittedEscrow_);
    }

    /// @notice Pause or unpause `deposit` (spec §13). Never blocks reclaim, closeCooperative, challenge,
    /// respond, timeout or claim: every open channel can always settle.
    function setPaused(bool paused_) external onlyOwner {
        paused = paused_;
        emit PausedSet(paused_);
    }

    // -------------------------------------------------------------- internal

    function _setFee(uint256 feePerPlayer_, address feeRecipient_) private {
        if (feePerPlayer_ > maxFeePerPlayer || feeRecipient_ == address(0)) revert InvalidParams();
        feePerPlayer = feePerPlayer_;
        feeRecipient = feeRecipient_;
        emit FeeUpdated(feePerPlayer_, feeRecipient_);
    }

    function _setLimits(uint256 maxDepositPerPlayer_, uint256 maxCommittedEscrow_) private {
        maxDepositPerPlayer = maxDepositPerPlayer_;
        maxCommittedEscrow = maxCommittedEscrow_;
        emit LimitsUpdated(maxDepositPerPlayer_, maxCommittedEscrow_);
    }

    // fundingDeadline must simply lie in the future relative to channel creation; miner-scale drift on
    // block.timestamp is immaterial to a minutes-to-days-long window.
    function _validateNewParams(Params memory p) private view {
        if (
            // slither-disable-next-line timestamp
            p.participants[0] == address(0) || p.participants[1] == address(0) || p.participants[0] == p.participants[1]
                || p.signers[0] == address(0) || p.signers[1] == address(0) || p.signers[0] == p.signers[1]
                || p.participants[0] == p.signers[1] || p.participants[1] == p.signers[0] || p.rules.code.length == 0
                || p.stakePerGame == 0 || p.deposit < p.stakePerGame || p.fundingDeadline <= block.timestamp
                || p.challengeTimeout < MIN_TIMEOUT || p.challengeTimeout > MAX_TIMEOUT
        ) {
            revert InvalidParams();
        }
        if (p.feePerPlayer < feePerPlayer || p.feePerPlayer > maxFeePerPlayer || p.feeRecipient != feeRecipient) {
            revert FeeMismatch();
        }
    }

    function _participantIndex(Params memory p, address who) private pure returns (uint8) {
        if (who == p.participants[0]) return 0;
        if (who == p.participants[1]) return 1;
        revert NotParticipant();
    }

    /// @dev Push a payout; if the token refuses (blocklist, paused), credit it to `owed` instead of reverting,
    /// so one blocked recipient can never lock the other party's funds.
    function _pay(address to, uint256 amount) private {
        if (amount == 0) return;
        // Low-level call is intentional (see doc comment above): a reverting/false-returning token must not
        // block payout. The callers reaching _pay are reclaim, closeCooperative and timeout (via _finalize).
        // Safety rests on the call target being the immutable, hook-free `token` (README trust assumptions),
        // plus `nonReentrant` on every writer of `owed` (these three and claim), so the owed[to] write that
        // follows this call cannot be exploited by reentry.
        // slither-disable-next-line reentrancy-no-eth,reentrancy-benign,low-level-calls
        (bool ok, bytes memory ret) = address(token).call(abi.encodeCall(IERC20.transfer, (to, amount)));
        if (ok && (ret.length == 0 || abi.decode(ret, (bool)))) return;
        owed[to] += amount;
        emit PayoutDeferred(to, amount);
    }

    function _finalize(bytes32 id, Channel storage c, Params memory p, uint256 a, uint256 b) private {
        if (a + b != 2 * p.deposit) revert BalanceMismatch();
        c.phase = Phase.Finalized;
        committedEscrow -= 2 * (p.deposit + p.feePerPlayer);
        uint256 fee = 2 * p.feePerPlayer;
        emit Finalized(id, a, b, fee);
        _pay(p.participants[0], a);
        _pay(p.participants[1], b);
        _pay(p.feeRecipient, fee);
    }

    function _checkBalances(Params memory p, State memory s) private pure {
        if (s.balanceA + s.balanceB != 2 * p.deposit) revert BalanceMismatch();
    }

    /// @dev ECDSA first, then ERC-1271. Unlike SignatureChecker.isValidSignatureNow, a signer that later gains
    /// code (e.g. an EIP-7702 delegation) cannot revoke its earlier ECDSA signatures (ruling R13).
    function _signedBy(address signer, bytes32 hash, bytes memory sig) private view returns (bool) {
        if (sig.length == 0) return false;
        // errArg (third return) only details a failure; any failure falls through to the ERC-1271 check.
        // slither-disable-next-line unused-return
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(hash, sig);
        if (err == ECDSA.RecoverError.NoError && recovered == signer) return true;
        return SignatureChecker.isValidERC1271SignatureNow(signer, hash, sig);
    }

    /// @dev Spec §4.3 support rule. Returns the supported latest state and its EIP-712 hash.
    function _supported(Channel storage c, Params memory p, bytes32 id, Proof memory proof)
        private
        view
        returns (State memory s, bytes32 h)
    {
        s = proof.latest.state;
        _checkBalances(p, s);
        h = hashState(s);
        IGameRules rules = IGameRules(p.rules);
        if (!proof.hasPrev) {
            if (s.turnNum == 0 && _isOpening(rules, id, p, h)) return (s, h);
            if (_signedBy(p.signers[0], h, proof.latest.sigA) && _signedBy(p.signers[1], h, proof.latest.sigB)) {
                return (s, h);
            }
            revert Unsupported();
        }

        State memory prev = proof.prev.state;
        if (prev.channelId != id || rules.isCheckpoint(s)) revert Unsupported();
        bytes32 ph = hashState(prev);
        if (s.prevHash != ph || s.turnNum != prev.turnNum + 1) revert Unsupported();
        uint8 m = rules.mover(prev, p);
        if (!_signedBy(p.signers[m], h, m == 0 ? proof.latest.sigA : proof.latest.sigB)) revert BadSignature();
        if (!rules.validTransition(prev, s, p)) revert InvalidTransition();

        bool prevEndorsed = (c.hasRegistered && ph == c.registeredHash)
            || (prev.turnNum == 0 && _isOpening(rules, id, p, ph))
            || (_signedBy(p.signers[0], ph, proof.prev.sigA) && _signedBy(p.signers[1], ph, proof.prev.sigB))
            || (!rules.isCheckpoint(prev)
                && _signedBy(p.signers[1 - m], ph, m == 0 ? proof.prev.sigB : proof.prev.sigA));
        if (!prevEndorsed) revert Unsupported();
    }

    function _isOpening(IGameRules rules, bytes32 id, Params memory p, bytes32 h) private view returns (bool) {
        return h == hashState(rules.initialState(id, p));
    }

    function _register(Channel storage c, State memory s, bytes32 h) private {
        c.registered = s;
        c.registeredHash = h;
        c.hasRegistered = true;
    }

    function _playerIndex(Params memory p, address who) private pure returns (uint8) {
        if (who == p.participants[0] || who == p.signers[0]) return 0;
        if (who == p.participants[1] || who == p.signers[1]) return 1;
        revert NotParticipant();
    }
}
