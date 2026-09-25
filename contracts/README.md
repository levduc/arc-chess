# Arena contracts

On-chain half of the Agent Chess Arena (spec: `docs/superpowers/specs/2026-09-24-agent-chess-arena-design.md`).

- `ChannelHub` — escrow, EIP-712 signature checks (ECDSA + ERC-1271), force-move disputes, fee payout.
- `IGameRules` — game template interface. `ChessRules` — chess template.
- `ChessBoard` / `ChessMoves` — packed encoding and legality (see the encodings below).

## Commands

    pnpm vectors                 # generate chess.js differential vectors (needed by forge test)
    pnpm test:contracts          # vectors + full forge test suite
    forge script script/Deploy.s.sol --rpc-url <rpc> --broadcast --private-key <key>

Deploy env: `ARENA_OWNER`, `ARENA_FEE_RECIPIENT`, `ARENA_TOKEN` (required on every chain except the local
chain 31337, where MockUSDC is deployed if it is unset; elsewhere the script reverts without it),
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
- Cooperative-close intent: `Close(bytes32 channelId,bytes32 stateHash)` where `stateHash = hashState(s)`
  (the full EIP-712 digest of the state); digest from `hub.hashClose(s)`. `closeCooperative` requires both
  signers' signatures over this digest; signatures over the state itself (`hashState`) never close a channel,
  so an earlier co-signed checkpoint or terminal state cannot be replayed to roll back later games. Once a
  daemon signs `Close` for a channel it must stop signing new states for that channel.

## Signatures

`ChannelHub` verifies signatures ECDSA-first: `ECDSA.tryRecover` against the signer, and only if that fails
an ERC-1271 `isValidSignature` call on the signer. A session key that later gains code (e.g. an EIP-7702
delegation) therefore cannot revoke ECDSA signatures it already produced, while contract signers still work.

## Trust assumptions

- `ARENA_TOKEN` (the hub's immutable `token`) must be a plain ERC-20: no transfer hooks or callbacks (not
  ERC-777 style), not fee-on-transfer, not rebasing, and `transfer`/`transferFrom` must return a bool or
  nothing. Escrow accounting assumes the hub receives and sends exactly the amounts requested, and payout
  safety assumes the token cannot call back into the hub. A token that refuses some recipients (blocklist,
  pause) is tolerated: refused payouts are deferred to `owed` and withdrawn with `claim`.
- `Params.rules` is chosen by the players, not vetted on-chain. It must come from the host's allowlist of
  audited game templates (daemons refuse unlisted rules by default). A reverting or malicious rules contract
  blocks every exit that consults it (challenge, respond, timeout, and cooperative close on any later state):
  the only remaining exit is `closeCooperative` on the opening state (`turnNum` 0), which never calls `rules`.

## External entry points and Circle CLI

Every state-changing entry point takes flat arguments or a single ABI-encoded `bytes` payload
(`deposit(bytes)`, `closeCooperative(bytes)`, `challenge(bytes)`, `respond(bytes)`, `timeout(bytes32)`,
`reclaim(bytes32)`, `claim(address)`), so it can be called with `circle wallet execute`. The Arc spike
(spec §10 step 0) must confirm `circle wallet execute` accepts a `bytes` argument.
