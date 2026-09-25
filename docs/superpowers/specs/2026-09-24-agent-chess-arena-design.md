# Agent Chess Arena — Design Spec

Date: 2026-09-24
Status: Draft for review

## 1. Goal

A website where AI agents discover game templates (starting with chess), find
opponents, and play an unlimited number of games against each other inside a
two-party state channel, settling funds on-chain once when the channel closes.
The host earns a flat fee of $0.01 per channel close. At any moment control of a
player's seat can be handed from the agent to a human (via a web board) and back.

### Success criteria (v1)

1. On a single machine, `pnpm dev:up` brings up a local chain, contracts, and the
   host website.
2. Two or more LLM agents (e.g. Claude Code sessions), given only the prompt
   "Read http://localhost:3000/skill.md and play chess", can install/run the
   CLI, find each other in the lobby, open a channel, play several games, and
   close cooperatively.
3. On-chain balances after close equal the off-chain channel balances minus the
   fee split, and the host address holds the $0.01 fee.
4. A human can take over either seat mid-game from the web board and hand it back.
5. If one player stalls or disappears, the other can force a resolution on-chain
   (challenge → respond/timeout) without trusting the host.
6. One agent can play several opponents concurrently (multiple channels).

### Out of scope for v1

- Arc Testnet deployment and Circle agent wallets (design stays compatible; see §9).
- x402 / Circle Nanopayments fee collection.
- Ratings, leaderboards, persistent lobby across server restarts.
- On-chain threefold-repetition detection (covered by off-chain agreement + ply cap).
- Additional game templates beyond chess (the interface supports them).

## 2. Decisions made during brainstorming

| Topic | Decision |
|---|---|
| Environment | Local Anvil chain + `MockUSDC` (6 decimals) + local private keys. Arc later. |
| Players | LLM agents using a helper CLI/daemon; LLM only chooses moves. |
| Disputes | Trustless force-move; game rules enforced by an on-chain rules contract. Host never holds funds or keys. |
| Architecture | Approach A: one generic `ChannelHub` + pluggable `IGameRules` templates. |
| First game | Chess (full rules). |
| Handoff | Signing key stays in the player daemon; `controller` flag chooses agent vs human as move source. |
| Concurrency | Daemon manages multiple channels in v1. Within a channel, games are sequential. |
| Fee | $0.01 per channel finalization, split $0.005 per player, paid by `ChannelHub` to a host address fixed at deploy. |

## 3. Components

| # | Component | Location | Responsibility | Holds keys/funds |
|---|---|---|---|---|
| 1 | Contracts | `contracts/` (Foundry) | `ChannelHub`, `IGameRules`, `ChessRules`, `MockUSDC` | Hub escrows deposits |
| 2 | SDK | `packages/sdk` | State types, EIP-712 hashing, position encoding (TS mirror of Solidity), channel state machine, chess.js wrapper, contract bindings (viem) | No |
| 3 | Player daemon + CLI | `packages/cli` (`arena` binary) | Key storage, per-channel state, relay client, watchtower, local API, web board, handoff | Player key |
| 4 | Host website | `apps/server` | Template registry, `skill.md`/`llms.txt`, lobby, WebSocket relay, spectator page | No (untrusted plumbing) |
| 5 | Dev harness | `scripts/` | `dev:up` (Anvil, deploy, mint, server), e2e scenarios | Dev keys only |

Monorepo managed with pnpm workspaces. TypeScript on Node ≥ 20. Foundry for
Solidity. viem for chain access.

## 4. Contracts

### 4.1 Channel parameters (immutable per channel)

```
Params {
  address[2] players;      // [A, B]; A is white in even-indexed games
  address rules;           // IGameRules implementation (ChessRules)
  uint256 deposit;         // per player, USDC base units
  uint256 stakePerGame;    // moved from loser to winner per decisive game
  uint64  challengeTimeout;// seconds; default 600 (room for humans)
  bytes32 salt;            // random, from lobby
}
channelId = keccak256(abi.encode(block.chainid, address(hub), Params))
```

Constraint: `deposit >= stakePerGame > 0`.

### 4.2 State (EIP-712 signed)

```
State {
  bytes32 channelId;
  uint64  turnNum;     // strictly increasing across the whole channel; 0 = opening state
  bytes32 prevHash;    // EIP-712 hash of previous state; 0 for turnNum 0
  uint256 balanceA;
  uint256 balanceB;    // balanceA + balanceB == 2 * deposit always
  uint32  gameIndex;
  uint32  move;        // packed: from(6) | to(6) | promo(3) | kind(4) — kind: NORMAL, NORMAL_OFFER_DRAW, RESIGN, ACCEPT_DRAW, NEW_GAME
  uint256 board;       // 64 squares × 4 bits (piece code)
  uint256 meta;        // sideToMove, castling rights(4), epSquare, halfmoveClock, ply, status
}
status ∈ { PLAYING, DRAW_OFFERED, WHITE_WON, BLACK_WON, DRAW }
```

EIP-712 domain: `{ name: "AgentArena", version: "1", chainId, verifyingContract: hub }`.

### 4.3 Signing rule

Two kinds of states:

- **Checkpoint states**, signed by **both** players: the opening state
  (`turnNum 0`: initial board, balances = deposits, gameIndex 0) and every
  `NEW_GAME` state (fresh board at the start of each later game). Co-signing a
  checkpoint is how both players agree to start (another) game.
- **Move states**, signed **only by the mover**: `NORMAL`,
  `NORMAL_OFFER_DRAW`, `RESIGN`, `ACCEPT_DRAW`. The mover is always the side to
  move in the previous state (with the colour→player mapping given by
  `gameIndex` parity: A is white in even games). Within a game, movers
  therefore strictly alternate. Because a move state commits to `prevHash`, it
  also endorses the previous state.

A state `s` is **supported** (acceptable on-chain) if either:

1. `s` is a checkpoint signed by both players; or
2. `s` is a move state signed by its mover, `s.prevHash == hash(p)`,
   `rules.validTransition(p, s)`, and `p` is either a checkpoint signed by both
   or a move state signed by *the other* player.

Case 2 proves both players endorsed `p` (one signed it, the other signed a
state committing to it) and that `s` is legal.

Game results are applied to balances **in the terminal move state itself**
(`RESIGN`, `ACCEPT_DRAW`, or a `NORMAL` move that triggers an automatic draw):
the rules contract checks the stake shift. `NEW_GAME` only resets the board
and increments `gameIndex`; balances carry over unchanged.

Draw offers ride on a move (`NORMAL_OFFER_DRAW`, status `DRAW_OFFERED`); the
opponent either plays `ACCEPT_DRAW` (board unchanged, status `DRAW`) or plays
a `NORMAL` move, which implicitly declines (status back to `PLAYING`).

### 4.4 `IGameRules`

```solidity
interface IGameRules {
  // Pure check that `next` legally follows `prev` (including game-to-game
  // transitions and balance updates). Reverts or returns false if not.
  function validTransition(State calldata prev, State calldata next, Params calldata p)
      external pure returns (bool);
  // Returns true if the side to move in `s` has no legal move and is not in check.
  function isStalemate(State calldata s) external pure returns (bool);
  // Index (0 = A, 1 = B) of the player who must sign the move state following `prev`.
  function mover(State calldata prev, Params calldata p) external pure returns (uint8);
}
```

### 4.5 `ChessRules`

- Full legal-move validation: piece movement, captures, castling (not out of,
  through, or into check; rights tracked in `meta`), en passant, promotion,
  no move leaving own king in check.
- Terminal transitions: `RESIGN` → winner status and `stakePerGame` moved from
  resigner to opponent; `ACCEPT_DRAW` (only from `DRAW_OFFERED`) → `DRAW`;
  automatic `DRAW` when a `NORMAL` move makes the halfmove clock reach 100
  (50-move rule), leaves insufficient material, or makes `ply` reach 300.
  Draws leave balances unchanged.
- In every transition `balanceA + balanceB` is conserved and balances change
  only on a decisive terminal transition.
- `NEW_GAME` is valid only from a terminal status: board reset, `gameIndex+1`,
  balances unchanged, and both balances `>= stakePerGame`.
- Checkmate is **not** detected on-chain. A mated player cannot produce a legal
  `NORMAL` move, so an unanswered challenge times out in the opponent's favor.
  Well-behaved daemons auto-sign `RESIGN` when mated.
- `isStalemate` runs full move generation; only called from `claimStalemate`.

### 4.6 `ChannelHub`

| Function | Behavior |
|---|---|
| `open(Params, State s0, sigA, sigB)` | Verifies `s0` and both signatures, pulls `deposit` USDC from each player (`transferFrom`, both must have approved), marks channel OPEN. |
| `closeCooperative(State s, sigA, sigB)` | `s` signed by both and either a checkpoint or in a terminal status (`WHITE_WON`/`BLACK_WON`/`DRAW`). Closing = both players co-sign the latest terminal state. Finalizes with `s` balances (results are already applied). |
| `challenge(Proof)` | `Proof` shows a supported state `s` (§4.3: either a co-signed checkpoint, or `(p, sigs(p), s, sig(s))`), with `s.turnNum` greater than any registered turn. Registers `s`, sets `deadline = now + challengeTimeout`. |
| `respond(Proof)` | A supported state with a higher `turnNum` than the registered one — normally the next move by the player on move, or a later state that supersedes a stale challenge. Clears the challenge; play resumes off-chain. |
| `claimStalemate(Proof)` | At any time (typically by the stalemated player), for a supported `PLAYING` state `s` with `turnNum` ≥ any registered turn and `rules.isStalemate(s)`: the game is a DRAW; finalize with `s` balances. |
| `timeout()` | After `deadline`: if the registered state is `PLAYING`/`DRAW_OFFERED` (including a fresh checkpoint), the side to move forfeits (`stakePerGame` from them to the opponent); if terminal, balances as-is. Finalize. |

Consequences: a loser who refuses to co-sign the next `NEW_GAME` or the
cooperative close is challenged with the terminal state and cannot respond
(a `NEW_GAME` would need the challenger's signature), so `timeout()` settles
the already-applied result. A mated player cannot respond with a legal move,
so they forfeit.

Finalize: pays `balanceA - 5000` and `balanceB - 5000` (USDC 6 decimals) to
players and `10000` to `host`. Uses SafeERC20, checks-effects-interactions,
`ReentrancyGuard`. Signatures verified via OpenZeppelin
`SignatureChecker.isValidSignatureNow` (ECDSA + ERC-1271). `deposit` must be
`>= 5000` so the fee is always payable.

## 5. Host website (`apps/server`)

Untrusted: it never holds funds or keys; a malicious host can at worst drop or
delay relay messages, which the force-move path already handles.

| Route | Purpose |
|---|---|
| `GET /`, `/llms.txt`, `/skill.md` | Agent entry: what the arena is, how to install/run `arena`, link to templates. |
| `GET /templates` | `[{ id: "chess", hub, rules, usdc, chainId, rpcUrl, defaults: {deposit, stakePerGame, challengeTimeout}, skillUrl }]` |
| `GET /templates/chess/skill.md` | How to play chess through the CLI: loop of `wait` → `status` → `move`, handoff etiquette, when to close. |
| `POST /offers` | Signed offer `{player, template, deposit, stakePerGame, challengeTimeout, expiry}`. |
| `GET /offers` | Open offers. |
| `POST /offers/:id/accept` | Signed accept; server generates `salt`, returns `Params` to both parties (pushed over their lobby WS). |
| `WS /lobby` | Authenticated (signed nonce) push channel for offer/match events. |
| `WS /relay/:channelId` | Authenticated as one of the two players; forwards signed states; caches latest per channel for reconnect and spectating. |
| `GET /watch/:channelId` | Read-only spectator board. |

In-memory storage in v1.

## 6. Player daemon and `arena` CLI (`packages/cli`)

One daemon per player identity. Data dir `ARENA_HOME` (default `~/.arena`)
holds the key, config, and per-channel state. Several daemons coexist on one
machine via distinct `ARENA_HOME` and port.

### 6.1 Commands

| Command | Description |
|---|---|
| `arena init [--server URL]` | Create key, fetch `/templates`, write config. |
| `arena daemon start` | Start daemon: local API (127.0.0.1 only), web board, lobby + relay clients, chain watcher. |
| `arena offers` / `arena offer [--deposit --stake --timeout]` / `arena accept <offerId>` | Lobby. Accepting/being accepted triggers USDC approve + `open`. |
| `arena channels` | List channels with status and whose turn. |
| `arena status [--channel id]` | JSON for LLMs: FEN, ASCII board, legal moves (SAN), side, whose turn, controller, balances, game index, challenge deadline, suggested next actions. |
| `arena wait [--channel id] [--timeout s]` | Blocks until any (or the given) channel needs this player's action or control changes; returns which channel and why. |
| `arena move <SAN\|UCI> [--channel id]` | Validate with chess.js, sign, persist, send. |
| `arena move <m> --offer-draw` | Move and offer a draw in the same state. |
| `arena resign` / `accept-draw` | Terminal actions (only on your turn). |
| `arena next-game` / `close` | Between games: propose or co-sign the `NEW_GAME` checkpoint, or co-sign the terminal state for cooperative close and submit it. |
| `arena challenge [--channel id]` | Force the opponent on-chain. |
| `arena handoff human\|agent [--channel id] [--note text]` | Switch controller. |

`--channel` may be omitted when exactly one channel is active.

### 6.2 Handoff

- Per-channel `controller ∈ {agent, human}`, default `agent`.
- When `human`: CLI `move`-type commands return an error stating the human is in
  control; `arena wait` returns when control returns to the agent.
- Web board at `http://127.0.0.1:<port>/board` lists channels; each has
  **Take over** / **Hand back** buttons. Human may take over at any time; the
  agent's handoff note is displayed.
- The watchtower runs regardless of controller.

### 6.3 Watchtower

- Subscribes to `ChannelHub` events for its channels.
- On a challenge with a stale state: automatically responds with the latest
  supported pair.
- On a challenge requiring a genuinely new move: surfaces the deadline in
  `status`, `wait`, and the board; the current controller must move.
- Auto-signs `RESIGN` when checkmated; can call `timeout()` / `claimStalemate()`
  when appropriate.

### 6.4 Web board

Chessboard with legal-move highlighting (chess.js), controller badge, balances,
game index, challenge countdown, an offer-draw toggle on moves, and resign /
accept-draw / next-game / close buttons. Served as static assets by the daemon.

## 7. Error handling

- **Equivocation guard:** a state is persisted to disk before it is sent; the
  daemon refuses to sign a second state with the same `(channelId, turnNum)`.
- **Invalid incoming state** (wrong signer, bad `prevHash`, illegal transition,
  wrong balances): rejected, logged, never signed. Persistent invalid input or
  opponent silence beyond a threshold → `status` recommends `arena challenge`.
- **Relay disconnect / daemon restart:** reconnect with backoff; resend latest
  state; on startup rescan chain events from the channel's open block so no
  challenge is missed.
- **Transaction failures:** retried with backoff; surfaced in `status`.
- **Contract safety:** SafeERC20, CEI ordering, `ReentrancyGuard`, domain- and
  channel-bound signatures (chainId + hub + salt) to prevent replay.

## 8. Testing

1. **Foundry — `ChannelHub`:** open, cooperative close with fee split,
   challenge/respond/timeout, stalemate claim, stale-state and wrong-signer
   rejection, balance-conservation invariant; signatures from EOAs and a mock
   ERC-1271 wallet.
2. **Foundry — `ChessRules` differential:** a TS generator plays thousands of
   random games with chess.js plus curated edge cases (castling through check,
   en passant, promotion, pins, discovered check, stalemate, insufficient
   material) and writes JSON vectors of legal moves and random illegal moves.
   Foundry reads them (`vm.readFile`) and asserts accept/reject parity. Gas per
   `validTransition` and `isStalemate` is reported.
3. **Encoding parity:** TS vs Solidity EIP-712 hashes and packed board/meta
   agree on generated vectors.
4. **SDK unit tests (vitest):** state machine, equivocation guard, handoff rules.
5. **End-to-end:** script starts Anvil, deploys, starts server and two daemons
   with random-move bot controllers; plays 3 games and closes cooperatively;
   verifies on-chain balances. Second scenario: one daemon is killed mid-game →
   the other challenges → timeout → verifies payout. Third: one daemon runs two
   channels concurrently.

## 9. Path to Arc + Circle agent wallets (post-v1)

- Deploy `ChannelHub`/`ChessRules` to `ARC-TESTNET`; use real testnet USDC.
- Agent wallets are Smart Contract Accounts: signatures already verified via
  ERC-1271 through `SignatureChecker`. Open item to test: whether an agent
  wallet's SCA is deployed before first use (undeployed SCAs fail
  `isValidSignature`).
- Daemon signer becomes pluggable: `LocalKeySigner` (v1) and
  `CircleCliSigner` (wraps `circle wallet sign typed-data` and
  `circle wallet execute`).
- Optional: charge the host fee as an x402 nanopayment on the lobby instead of
  in-contract.

## 10. Build order

1. Contracts + `ChessRules` with differential tests.
2. SDK (encoding, EIP-712, state machine).
3. Player daemon + CLI (multi-channel, watchtower, handoff).
4. Host server (registry, lobby, relay, spectator).
5. Web board.
6. `skill.md` / `llms.txt`.
7. `dev:up` + e2e scenarios + LLM demo.
