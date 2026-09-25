// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
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
    uint64 public constant MIN_TIMEOUT = 60;
    uint64 public constant MAX_TIMEOUT = 7 days;

    IERC20 public immutable token;
    uint256 public immutable maxFeePerPlayer;
    uint256 public feePerPlayer;
    address public feeRecipient;
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
    event FeeUpdated(uint256 feePerPlayer, address feeRecipient);

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

    constructor(IERC20 token_, address owner_, address feeRecipient_, uint256 feePerPlayer_, uint256 maxFeePerPlayer_)
        EIP712("AgentArena", "1")
        Ownable(owner_)
    {
        if (address(token_).code.length == 0) revert InvalidParams();
        token = token_;
        maxFeePerPlayer = maxFeePerPlayer_;
        _setFee(feePerPlayer_, feeRecipient_);
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
        Params memory p = abi.decode(encodedParams, (Params));
        bytes32 id = channelId(p);
        Channel storage c = _channels[id];
        if (c.phase == Phase.None) {
            _validateNewParams(p);
            c.phase = Phase.Funding;
            c.params = p;
            emit ChannelCreated(id, encodedParams);
        } else if (c.phase != Phase.Funding) {
            revert WrongPhase();
        }
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
        if (block.timestamp <= p.fundingDeadline) revert TooEarly();
        c.phase = Phase.Reclaimed;
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

    /// @notice Settle immediately on a state signed by both players: the opening state, a NEW_GAME checkpoint,
    /// or a finished game. Game results are already applied to balances in such states.
    function closeCooperative(bytes calldata encodedSignedState) external nonReentrant {
        SignedState memory ss = abi.decode(encodedSignedState, (SignedState));
        State memory s = ss.state;
        bytes32 id = s.channelId;
        Channel storage c = _channels[id];
        if (c.phase != Phase.Open && c.phase != Phase.Challenged) revert WrongPhase();
        Params memory p = c.params;
        _checkBalances(p, s);
        bytes32 h = hashState(s);
        if (!_signedBy(p.signers[0], h, ss.sigA) || !_signedBy(p.signers[1], h, ss.sigB)) revert BadSignature();
        IGameRules rules = IGameRules(p.rules);
        if (s.turnNum != 0 && !rules.isCheckpoint(s) && !rules.isGameOver(s)) revert NotClosable();
        if (c.hasRegistered && s.turnNum < c.registered.turnNum) revert StaleState();
        _finalize(id, c, p, s.balanceA, s.balanceB);
    }

    // ----------------------------------------------------------------- admin

    /// @notice Set the fee for channels created from now on. Existing channels keep their snapshot.
    function setFee(uint256 feePerPlayer_, address feeRecipient_) external onlyOwner {
        _setFee(feePerPlayer_, feeRecipient_);
    }

    // -------------------------------------------------------------- internal

    function _setFee(uint256 feePerPlayer_, address feeRecipient_) private {
        if (feePerPlayer_ > maxFeePerPlayer || feeRecipient_ == address(0)) revert InvalidParams();
        feePerPlayer = feePerPlayer_;
        feeRecipient = feeRecipient_;
        emit FeeUpdated(feePerPlayer_, feeRecipient_);
    }

    function _validateNewParams(Params memory p) private view {
        if (
            p.participants[0] == address(0) || p.participants[1] == address(0)
                || p.participants[0] == p.participants[1] || p.signers[0] == address(0) || p.signers[1] == address(0)
                || p.signers[0] == p.signers[1] || p.rules.code.length == 0 || p.stakePerGame == 0
                || p.deposit < p.stakePerGame || p.fundingDeadline <= block.timestamp
                || p.challengeTimeout < MIN_TIMEOUT || p.challengeTimeout > MAX_TIMEOUT
        ) revert InvalidParams();
        if (p.feePerPlayer < feePerPlayer || p.feeRecipient != feeRecipient) revert FeeMismatch();
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
        (bool ok, bytes memory ret) = address(token).call(abi.encodeCall(IERC20.transfer, (to, amount)));
        if (ok && (ret.length == 0 || abi.decode(ret, (bool)))) return;
        owed[to] += amount;
        emit PayoutDeferred(to, amount);
    }

    function _finalize(bytes32 id, Channel storage c, Params memory p, uint256 a, uint256 b) private {
        if (a + b != 2 * p.deposit) revert BalanceMismatch();
        c.phase = Phase.Finalized;
        uint256 fee = 2 * p.feePerPlayer;
        emit Finalized(id, a, b, fee);
        _pay(p.participants[0], a);
        _pay(p.participants[1], b);
        _pay(p.feeRecipient, fee);
    }

    function _checkBalances(Params memory p, State memory s) private pure {
        if (s.balanceA + s.balanceB != 2 * p.deposit) revert BalanceMismatch();
    }

    function _signedBy(address signer, bytes32 hash, bytes memory sig) private view returns (bool) {
        return sig.length != 0 && SignatureChecker.isValidSignatureNow(signer, hash, sig);
    }
}
