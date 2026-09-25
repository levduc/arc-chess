// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ChessBoard as B} from "./ChessBoard.sol";

/// @notice Chess legality over the packed encoding in ChessBoard. Mirrors chess.js 1.4.0 semantics.
library ChessMoves {
    /// @notice True if `sq` is attacked by any piece of the given colour.
    function isSquareAttacked(uint256 board, uint256 sq, bool byBlack) internal pure returns (bool) {
        int256 f = int256(sq % 8);
        int256 r = int256(sq / 8);
        uint8 color = byBlack ? B.BLACK : 0;

        // A white pawn attacks up the board, so it sits one rank below the square it attacks.
        int256 pr = byBlack ? r + 1 : r - 1;
        if (pr >= 0 && pr < 8) {
            if (f > 0 && B.pieceAt(board, _sq(f - 1, pr)) == (B.PAWN | color)) return true;
            if (f < 7 && B.pieceAt(board, _sq(f + 1, pr)) == (B.PAWN | color)) return true;
        }

        int8[8] memory kdf = [int8(1), 2, 2, 1, -1, -2, -2, -1];
        int8[8] memory kdr = [int8(2), 1, -1, -2, -2, -1, 1, 2];
        for (uint256 i = 0; i < 8; i++) {
            int256 nf = f + kdf[i];
            int256 nr = r + kdr[i];
            if (_onBoard(nf, nr) && B.pieceAt(board, _sq(nf, nr)) == (B.KNIGHT | color)) return true;
        }

        // Directions 0-3 are orthogonal, 4-7 diagonal. The first square of each ray also detects the king.
        int8[8] memory ddf = [int8(1), -1, 0, 0, 1, 1, -1, -1];
        int8[8] memory ddr = [int8(0), 0, 1, -1, 1, -1, 1, -1];
        for (uint256 d = 0; d < 8; d++) {
            int256 nf = f + ddf[d];
            int256 nr = r + ddr[d];
            bool first = true;
            while (_onBoard(nf, nr)) {
                uint8 p = B.pieceAt(board, _sq(nf, nr));
                if (p != 0) {
                    if ((p & B.BLACK) == color) {
                        uint8 t = p & 7;
                        if (t == B.QUEEN) return true;
                        if (d < 4 ? t == B.ROOK : t == B.BISHOP) return true;
                        if (first && t == B.KING) return true;
                    }
                    break;
                }
                first = false;
                nf += ddf[d];
                nr += ddr[d];
            }
        }
        return false;
    }

    /// @notice Square of the given colour's king, or 64 if there is none.
    function kingSquare(uint256 board, bool black) internal pure returns (uint256) {
        uint8 king = B.KING | (black ? B.BLACK : 0);
        for (uint256 s = 0; s < 64; s++) {
            if (B.pieceAt(board, s) == king) return s;
        }
        return 64;
    }

    /// @notice True if the side to move is in check.
    function inCheck(uint256 board, uint256 meta) internal pure returns (bool) {
        bool black = B.side(meta) == B.BLACK_SIDE;
        uint256 k = kingSquare(board, black);
        return k < 64 && isSquareAttacked(board, k, !black);
    }

    /// @notice Validates a move by the side to move and returns the resulting board and meta (status PLAYING).
    function applyMove(uint256 board, uint256 meta, uint256 from, uint256 to, uint8 promo)
        internal
        pure
        returns (bool ok, uint256 newBoard, uint256 newMeta)
    {
        if (from >= 64 || to >= 64 || from == to) return (false, 0, 0);
        bool black = B.side(meta) == B.BLACK_SIDE;
        uint8 piece = B.pieceAt(board, from);
        uint8 ptype = B.pieceType(piece);
        if (ptype == 0 || ptype > B.KING || B.isBlack(piece) != black) return (false, 0, 0);
        uint8 target = B.pieceAt(board, to);
        if (target != 0 && (B.isBlack(target) == black || B.pieceType(target) == B.KING)) return (false, 0, 0);

        uint8 ep = B.NO_EP;
        if (ptype == B.PAWN) {
            (ok, newBoard, ep) = _pawnMove(board, B.epSquare(meta), from, to, promo, black);
        } else if (promo != 0) {
            return (false, 0, 0);
        } else if (ptype == B.KING && from / 8 == to / 8 && (to + 2 == from || from + 2 == to)) {
            (ok, newBoard) = _castle(board, B.castling(meta), from, to, black);
        } else {
            ok = _pieceCanReach(board, ptype, from, to);
            newBoard = B.setPiece(B.setPiece(board, from, B.EMPTY), to, piece);
        }
        if (!ok) return (false, 0, 0);

        uint256 k = kingSquare(newBoard, black);
        if (k == 64 || isSquareAttacked(newBoard, k, !black)) return (false, 0, 0);

        uint8 rights = B.castling(meta);
        if (ptype == B.KING) rights &= black ? ~(B.CASTLE_BK | B.CASTLE_BQ) : ~(B.CASTLE_WK | B.CASTLE_WQ);
        rights = _dropRookRights(_dropRookRights(rights, from), to);
        uint16 hm = (ptype == B.PAWN || target != 0) ? uint16(0) : B.halfmove(meta) + 1;
        newMeta = B.packMeta(black ? B.WHITE_SIDE : B.BLACK_SIDE, rights, ep, hm, B.ply(meta) + 1, B.STATUS_PLAYING);
        return (true, newBoard, newMeta);
    }

    function _pieceCanReach(uint256 board, uint8 ptype, uint256 from, uint256 to) private pure returns (bool) {
        int256 df = int256(to % 8) - int256(from % 8);
        int256 dr = int256(to / 8) - int256(from / 8);
        uint256 adf = _abs(df);
        uint256 adr = _abs(dr);
        if (ptype == B.KNIGHT) return (adf == 1 && adr == 2) || (adf == 2 && adr == 1);
        if (ptype == B.KING) return adf <= 1 && adr <= 1;
        bool straight = df == 0 || dr == 0;
        bool diagonal = adf == adr;
        if (ptype == B.ROOK && !straight) return false;
        if (ptype == B.BISHOP && !diagonal) return false;
        if (ptype == B.QUEEN && !straight && !diagonal) return false;
        return _pathClear(board, from, df, dr);
    }

    function _pawnMove(uint256 board, uint8 epSq, uint256 from, uint256 to, uint8 promo, bool black)
        private
        pure
        returns (bool, uint256, uint8)
    {
        int256 df = int256(to % 8) - int256(from % 8);
        int256 dr = int256(to / 8) - int256(from / 8);
        int256 dir = black ? int256(-1) : int256(1);
        uint8 color = black ? B.BLACK : 0;
        uint8 target = B.pieceAt(board, to);
        uint256 nb = B.setPiece(board, from, B.EMPTY);
        uint8 ep = B.NO_EP;

        if (df == 0) {
            if (target != 0) return (false, 0, 0);
            if (dr == 2 * dir) {
                if (from / 8 != (black ? 6 : 1)) return (false, 0, 0);
                uint256 mid = black ? from - 8 : from + 8;
                if (B.pieceAt(board, mid) != 0) return (false, 0, 0);
                ep = uint8(mid);
            } else if (dr != dir) {
                return (false, 0, 0);
            }
        } else if ((df == 1 || df == -1) && dr == dir) {
            if (target == 0) {
                if (to != epSq) return (false, 0, 0);
                uint256 captured = black ? to + 8 : to - 8;
                if (B.pieceAt(board, captured) != (B.PAWN | (black ? 0 : B.BLACK))) return (false, 0, 0);
                nb = B.setPiece(nb, captured, B.EMPTY);
            }
        } else {
            return (false, 0, 0);
        }

        uint8 placed = B.PAWN | color;
        if (to / 8 == (black ? 0 : 7)) {
            if (promo < B.KNIGHT || promo > B.QUEEN) return (false, 0, 0);
            placed = promo | color;
        } else if (promo != 0) {
            return (false, 0, 0);
        }
        return (true, B.setPiece(nb, to, placed), ep);
    }

    function _castle(uint256 board, uint8 rights, uint256 from, uint256 to, bool black)
        private
        pure
        returns (bool, uint256)
    {
        uint256 home = black ? 60 : 4;
        if (from != home) return (false, 0);
        bool kingSide = to == home + 2;
        uint8 right = black ? (kingSide ? B.CASTLE_BK : B.CASTLE_BQ) : (kingSide ? B.CASTLE_WK : B.CASTLE_WQ);
        if ((rights & right) == 0) return (false, 0);
        uint8 color = black ? B.BLACK : 0;
        uint256 rookFrom = kingSide ? home + 3 : home - 4;
        uint256 rookTo = kingSide ? home + 1 : home - 1;
        if (B.pieceAt(board, rookFrom) != (B.ROOK | color)) return (false, 0);
        if (B.pieceAt(board, rookTo) != 0 || B.pieceAt(board, to) != 0) return (false, 0);
        if (!kingSide && B.pieceAt(board, home - 3) != 0) return (false, 0);
        // Not out of check, not through an attacked square; the destination is checked by the caller.
        if (isSquareAttacked(board, home, !black) || isSquareAttacked(board, rookTo, !black)) return (false, 0);
        uint256 nb = B.setPiece(B.setPiece(board, home, B.EMPTY), rookFrom, B.EMPTY);
        nb = B.setPiece(B.setPiece(nb, to, B.KING | color), rookTo, B.ROOK | color);
        return (true, nb);
    }

    function _dropRookRights(uint8 rights, uint256 s) private pure returns (uint8) {
        if (s == 0) return rights & ~B.CASTLE_WQ;
        if (s == 7) return rights & ~B.CASTLE_WK;
        if (s == 56) return rights & ~B.CASTLE_BQ;
        if (s == 63) return rights & ~B.CASTLE_BK;
        return rights;
    }

    function _pathClear(uint256 board, uint256 from, int256 df, int256 dr) private pure returns (bool) {
        int256 sf = df > 0 ? int256(1) : (df < 0 ? int256(-1) : int256(0));
        int256 sr = dr > 0 ? int256(1) : (dr < 0 ? int256(-1) : int256(0));
        uint256 n = _abs(df) > _abs(dr) ? _abs(df) : _abs(dr);
        int256 f = int256(from % 8);
        int256 r = int256(from / 8);
        for (uint256 i = 1; i < n; i++) {
            f += sf;
            r += sr;
            if (B.pieceAt(board, _sq(f, r)) != 0) return false;
        }
        return true;
    }

    function _onBoard(int256 f, int256 r) private pure returns (bool) {
        return f >= 0 && f < 8 && r >= 0 && r < 8;
    }

    function _sq(int256 f, int256 r) private pure returns (uint256) {
        return uint256(r * 8 + f);
    }

    function _abs(int256 x) private pure returns (uint256) {
        return uint256(x >= 0 ? x : -x);
    }
}
