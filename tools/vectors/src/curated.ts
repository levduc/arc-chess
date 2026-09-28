// Hand-picked positions covering rules that random games rarely reach.
export const CURATED_FENS: string[] = [
  "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
  "r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1", // both castles available
  "r3k2r/8/8/8/8/8/8/R3K2R b KQkq - 0 1",
  "r3k2r/8/8/8/8/5q2/8/R3K2R w KQkq - 0 1", // queen covers f1 and d1: no castling
  "r3k2r/8/8/8/8/8/4q3/R3K2R w KQkq - 0 1", // in check: cannot castle out of check
  "rnbqkbnr/ppp1p1pp/8/3pPp2/8/8/PPPP1PPP/RNBQKBNR w KQkq f6 0 3", // en passant available
  "8/8/8/K2pP2q/8/8/8/7k w - d6 0 1", // en passant would expose the king
  "8/P7/8/8/8/8/8/k6K w - - 0 1", // promotion
  "1n5k/P7/8/8/8/8/8/K7 w - - 0 1", // promotion with capture
  "k7/8/8/8/8/8/p7/7K b - - 0 1", // black promotion
  "4k3/4r3/8/8/8/8/4B3/4K3 w - - 0 1", // pinned bishop
  "4k3/8/8/8/8/5n2/8/r3K3 w - - 0 1", // double check
  "rnbqkbnr/pppp1ppp/8/4p3/6P1/5P2/PPPPP2P/RNBQKBNR b KQkq - 0 2", // mate in one available
  "rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3", // checkmated
  "7k/5Q2/6K1/8/8/8/8/8 b - - 0 1", // stalemate
  "7k/6Q1/6K1/8/8/8/8/8 b - - 0 1", // checkmate
  "8/8/8/8/8/8/8/k6K w - - 0 1", // K v K
  "8/8/8/8/8/8/8/kn5K w - - 0 1", // K+N v K
  "8/8/8/8/8/8/1b6/k5BK w - - 0 1", // same-coloured bishops
  "8/8/8/8/8/8/b7/k5BK w - - 0 1", // opposite-coloured bishops
  "8/8/8/8/3R4/8/8/K6k w - - 99 120", // one move from the fifty-move limit
  "r3k2r/8/1N6/8/8/8/8/R3K2R w KQkq - 0 1", // Nb6xa8: castling right lost by a rook capture, not a king/rook move
  "k7/b1K5/8/8/8/8/8/R7 b - - 0 1", // Ra1 pins Ba7 on the a-file so it can't move at all: stalemate
  "k7/8/8/8/8/2N5/5N2/7K w - - 0 1", // K+N+N v K: neither side calls this insufficient material
  "7k/Q7/6K1/8/8/8/8/8 w - - 99 60", // halfmove 99->100: Qa8# still wins; every other legal move hits the cap and draws
  "1q6/8/8/8/8/6k1/8/7K b - - 0 150", // ply 299->300 (black to move): Qb1# still wins; every other legal move draws
];
