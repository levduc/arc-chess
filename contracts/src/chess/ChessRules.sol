// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IGameRules} from "../IGameRules.sol";
import {Params, State} from "../ArenaTypes.sol";
import {ChessBoard as B} from "./ChessBoard.sol";
import {ChessMoves} from "./ChessMoves.sol";

/// @notice Chess template for ChannelHub. Checkmate is not detected on-chain: a mated player cannot respond
/// to a challenge with a legal move and forfeits on timeout (spec §4.5).
contract ChessRules is IGameRules {
    uint16 public constant MAX_PLY = 300;
    uint16 public constant FIFTY_MOVE_HALFMOVES = 100;

    function initialState(bytes32 channelId, Params calldata p) external pure returns (State memory s) {
        s.channelId = channelId;
        s.balanceA = p.deposit;
        s.balanceB = p.deposit;
        s.board = B.INITIAL_BOARD;
        s.meta = B.INITIAL_META;
    }

    function isCheckpoint(State calldata s) external pure returns (bool) {
        return B.moveKind(s.move) == B.KIND_NEW_GAME;
    }

    function isGameOver(State calldata s) external pure returns (bool) {
        uint8 st = B.status(s.meta);
        return st == B.STATUS_WHITE_WON || st == B.STATUS_BLACK_WON || st == B.STATUS_DRAW;
    }

    function mover(State calldata prev, Params calldata) external pure returns (uint8) {
        return _playerOnMove(prev.gameIndex, prev.meta);
    }

    function forfeitBalances(State calldata s, Params calldata p) external pure returns (uint256, uint256) {
        return _shiftStake(s.balanceA, s.balanceB, _playerOnMove(s.gameIndex, s.meta), p.stakePerGame);
    }

    function validTransition(State calldata prev, State calldata next, Params calldata p)
        external
        pure
        returns (bool)
    {
        (bool ok, State memory e) = successor(prev, next.move, p);
        return ok && e.channelId == next.channelId && e.turnNum == next.turnNum && e.balanceA == next.balanceA
            && e.balanceB == next.balanceB && e.gameIndex == next.gameIndex && e.board == next.board
            && e.meta == next.meta;
    }

    /// @notice The canonical state after applying `move` to `prev`. `prevHash` is left zero (the hub owns it).
    function successor(State calldata prev, uint32 move, Params calldata p)
        public
        pure
        returns (bool ok, State memory next)
    {
        next = prev;
        next.turnNum = prev.turnNum + 1;
        next.prevHash = bytes32(0);
        next.move = move;
        uint8 kind = B.moveKind(move);
        uint8 st = B.status(prev.meta);
        bool inProgress = st == B.STATUS_PLAYING || st == B.STATUS_DRAW_OFFERED;

        if (kind == B.KIND_NEW_GAME) {
            if (inProgress || move != B.encodeMove(0, 0, 0, B.KIND_NEW_GAME)) return (false, next);
            if (prev.balanceA < p.stakePerGame || prev.balanceB < p.stakePerGame) return (false, next);
            next.gameIndex = prev.gameIndex + 1;
            next.board = B.INITIAL_BOARD;
            next.meta = B.INITIAL_META;
            return (true, next);
        }
        if (!inProgress) return (false, next);

        if (kind == B.KIND_NORMAL || kind == B.KIND_NORMAL_OFFER_DRAW) {
            return _normalMove(prev, move, kind, p, next);
        }
        if (move != B.encodeMove(0, 0, 0, kind)) return (false, next);
        if (kind == B.KIND_RESIGN) {
            bool whiteResigns = B.side(prev.meta) == B.WHITE_SIDE;
            next.meta = B.withStatus(prev.meta, whiteResigns ? B.STATUS_BLACK_WON : B.STATUS_WHITE_WON);
            (next.balanceA, next.balanceB) = _shiftStake(
                prev.balanceA, prev.balanceB, _playerOnMove(prev.gameIndex, prev.meta), p.stakePerGame
            );
            return (true, next);
        }
        if (kind == B.KIND_ACCEPT_DRAW) {
            if (st != B.STATUS_DRAW_OFFERED) return (false, next);
            next.meta = B.withStatus(prev.meta, B.STATUS_DRAW);
            return (true, next);
        }
        if (kind == B.KIND_CLAIM_STALEMATE) {
            if (ChessMoves.inCheck(prev.board, prev.meta) || ChessMoves.hasLegalMove(prev.board, prev.meta)) {
                return (false, next);
            }
            next.meta = B.withStatus(prev.meta, B.STATUS_DRAW);
            return (true, next);
        }
        return (false, next);
    }

    function _normalMove(State calldata prev, uint32 move, uint8 kind, Params calldata p, State memory next)
        private
        pure
        returns (bool, State memory)
    {
        uint8 from = B.moveFrom(move);
        uint8 to = B.moveTo(move);
        uint8 promo = B.movePromo(move);
        if (move != B.encodeMove(from, to, promo, kind)) return (false, next);
        (bool legal, uint256 board, uint256 meta) = ChessMoves.applyMove(prev.board, prev.meta, from, to, promo);
        if (!legal) return (false, next);

        uint8 status = kind == B.KIND_NORMAL_OFFER_DRAW ? B.STATUS_DRAW_OFFERED : B.STATUS_PLAYING;
        if (ChessMoves.isInsufficientMaterial(board)) {
            status = B.STATUS_DRAW;
        } else if (B.halfmove(meta) >= FIFTY_MOVE_HALFMOVES || B.ply(meta) >= MAX_PLY) {
            // A checkmate delivered by the limiting move still wins; otherwise the game is drawn.
            if (ChessMoves.inCheck(board, meta) && !ChessMoves.hasLegalMove(board, meta)) {
                status = B.side(prev.meta) == B.WHITE_SIDE ? B.STATUS_WHITE_WON : B.STATUS_BLACK_WON;
                (next.balanceA, next.balanceB) = _shiftStake(
                    prev.balanceA, prev.balanceB, _playerOnMove(prev.gameIndex, meta), p.stakePerGame
                );
            } else {
                status = B.STATUS_DRAW;
            }
        }
        next.board = board;
        next.meta = B.withStatus(meta, status);
        return (true, next);
    }

    function _playerOnMove(uint32 gameIndex, uint256 meta) private pure returns (uint8) {
        uint8 whitePlayer = uint8(gameIndex % 2);
        return B.side(meta) == B.WHITE_SIDE ? whitePlayer : 1 - whitePlayer;
    }

    function _shiftStake(uint256 a, uint256 b, uint8 loser, uint256 stake) private pure returns (uint256, uint256) {
        if (loser == 0) {
            uint256 x = stake < a ? stake : a;
            return (a - x, b + x);
        }
        uint256 y = stake < b ? stake : b;
        return (a + y, b - y);
    }
}
