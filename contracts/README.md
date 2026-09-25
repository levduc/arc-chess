# Arena contracts

On-chain half of the Agent Chess Arena (spec: `docs/superpowers/specs/2026-09-24-agent-chess-arena-design.md`).

- `ChannelHub` — escrow, EIP-712 signature checks (ECDSA + ERC-1271), force-move disputes, fee payout.
- `IGameRules` — game template interface. `ChessRules` — chess template.
- `ChessBoard` / `ChessMoves` — packed encoding and legality (see the encodings below).

## Commands

    pnpm vectors                 # generate chess.js differential vectors (needed by forge test)
    pnpm test:contracts          # vectors + full forge test suite
    forge script script/Deploy.s.sol --rpc-url <rpc> --broadcast --private-key <key>

Deploy env: `ARENA_OWNER`, `ARENA_FEE_RECIPIENT`, optional `ARENA_TOKEN` (MockUSDC if unset),
`ARENA_FEE_PER_PLAYER` (default 5000 = $0.005), `ARENA_MAX_FEE_PER_PLAYER` (default 1000000).
Output: `deployments/<chainId>.json` → `{ token, chessRules, channelHub }`.

## Encodings (shared with the TypeScript SDK)

- Square: `rank * 8 + file` (a1 = 0, h8 = 63). Board: 4 bits per square at offset `sq * 4`.
  Pieces `P N B R Q K = 1..6`, black adds 8.
- Meta: side (bits 0–7), castling `K=1 Q=2 k=4 q=8` (8–15), ep square or 255 (16–23),
  halfmove (24–39), ply (40–55), status `PLAYING DRAW_OFFERED WHITE_WON BLACK_WON DRAW = 0..4` (56–63).
- Move `uint32`: from (0–5), to (6–11), promotion 0 or 2–5 (12–14), kind (15–18):
  `NONE NORMAL NORMAL_OFFER_DRAW RESIGN ACCEPT_DRAW CLAIM_STALEMATE NEW_GAME = 0..6`.
- EIP-712 domain `AgentArena` / `1`; `prevHash` is the full EIP-712 digest of the previous state.

## External entry points and Circle CLI

Every state-changing entry point takes flat arguments or a single ABI-encoded `bytes` payload
(`deposit(bytes)`, `closeCooperative(bytes)`, `challenge(bytes)`, `respond(bytes)`, `timeout(bytes32)`,
`reclaim(bytes32)`, `claim(address)`), so it can be called with `circle wallet execute`. The Arc spike
(spec §10 step 0) must confirm `circle wallet execute` accepts a `bytes` argument.
