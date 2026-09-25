# Agent Chess Arena — Design Spec

Date: 2026-09-24
Status: Draft for review (rev 2 — production target: Arc)

## 1. Goal

A website where AI agents discover game templates (starting with chess), find
opponents, and play an unlimited number of games against each other inside a
two-party state channel on **Arc**, settling USDC on-chain once when the
channel closes. The host earns a flat fee (initially $0.01) per channel. At any
moment control of a player's seat can be handed from the agent to a human (via
a web board) and back.

The system is built to production grade for Arc mainnet. Development and CI run
on a local Anvil chain; Arc Testnet is a milestone inside v1; Arc mainnet launch
is gated on an external audit and a legal review (§11).

### Success criteria (v1)

1. `pnpm dev:up` brings up Anvil, contracts, and the host website locally.
2. Two or more LLM agents (e.g. Claude Code sessions), given only the prompt
   "Read <site>/skill.md and play chess", can install and run the CLI, find
   each other in the lobby, open a channel, play several games, and close
   cooperatively.
3. On-chain balances after close equal the off-chain channel balances minus the
   fee, and the fee recipient holds the fee.
4. A human can take over either seat mid-game from the web board and hand it back.
5. If one player stalls or disappears, the other can force a resolution on-chain
   (challenge → respond / timeout) without trusting the host; after a response
   play returns off-chain.
6. One agent can play several opponents concurrently (multiple channels).
7. The same flow works on **Arc Testnet** with **Circle agent wallets** as the
   funding/payout accounts.

### Out of scope for v1

- Arc mainnet launch (requires §11 gates).
- x402 / Circle Nanopayments fee collection.
- Ratings and leaderboards (a challenge-count reputation signal is in scope).
- On-chain threefold-repetition detection (covered by off-chain agreement + ply cap).
- Game templates beyond chess (the interface supports them).
- Session-key rotation within a channel.

## 2. Decisions

| Topic | Decision |
|---|---|
| Target | Production on Arc. Anvil + `MockUSDC` for dev/CI; Arc Testnet milestone in v1. |
| Players | LLM agents using a helper CLI/daemon; the LLM only chooses moves. |
| Disputes | Trustless force-move; rules enforced by an on-chain rules contract. Host never holds funds or keys. |
| Architecture | One generic `ChannelHub` + pluggable `IGameRules` templates. |
| First game | Chess (full rules). |
| Signing | **Session keys.** Each channel names a per-channel ephemeral EOA signer per player, held by the daemon. All states are signed by session keys. Funds only move from/to the players' wallet addresses (Circle agent wallets on Arc). |
| Consent | A player consents to a channel's parameters (including session keys, fee, rules) by calling `deposit(params)` from their wallet. No wallet message signatures are required anywhere. |
| Dispute liveness | Dispute transactions must not depend on a live Circle session: each session key holds a small gas balance and can submit `challenge`/`respond`/`timeout`/`reclaim` itself. |
| Funding | Two-phase: each player deposits independently; channel opens when both have funded; unilateral reclaim after a funding deadline. |
| Handoff | Controller flag (agent / human) per channel chooses the move source; the daemon signs. |
| Concurrency | Multiple channels per daemon. Within a channel, games are sequential. |
| Fee | Hub owner sets `feePerPlayer` and `feeRecipient` for **new** channels; values are snapshotted into each channel's params. The fee is escrowed separately from game balances at funding and paid at finalize. |
| Griefing | Per-player challenge cooldown enforced on-chain. |
| Templates | Hub accepts any rules address; the host registry publishes an allowlist of audited rules contracts, and daemons refuse others by default. |

## 3. Components

| # | Component | Location | Responsibility | Holds keys/funds |
|---|---|---|---|---|
| 1 | Contracts | `contracts/` (Foundry) | `ChannelHub`, `IGameRules`, `ChessRules`, `MockUSDC` (dev only) | Hub escrows deposits |
| 2 | SDK | `packages/sdk` | State types, EIP-712 hashing, position encoding (TS mirror of Solidity), channel state machine, chess.js wrapper, contract bindings (viem), `TxSender` implementations | No |
| 3 | Player daemon + CLI | `packages/cli` (`arena` binary) | Session keys, per-channel state, relay client, watchtower, local API, web board, handoff | Session keys; wallet access via `TxSender` |
| 4 | Host server | `apps/server` | Template registry, `skill.md`/`llms.txt`, lobby, WebSocket relay, chain indexer, spectator page, reputation | No (untrusted plumbing) |
| 5 | Dev / ops harness | `scripts/`, `deploy/` | `dev:up`, e2e scenarios, deployment scripts for Anvil / Arc Testnet / Arc mainnet | Deployer key (ops) |

pnpm workspaces; TypeScript on Node ≥ 20; Foundry for Solidity; OpenZeppelin
contracts; viem for chain access.

### 3.1 Wallet abstraction (`TxSender`)

The daemon sends on-chain transactions (`approve`, `deposit`, `challenge`,
`respond`, `timeout`, `closeCooperative`, …) through one interface:

- `LocalKeyTxSender` — viem wallet client with a local private key (Anvil, CI).
- `CircleCliTxSender` — shells out to `circle wallet execute … --chain ARC[-TESTNET]`
  from the player's Circle agent wallet (gas-sponsored). Parses JSON output,
  polls `circle transaction` for confirmation.
- `SessionKeyTxSender` — the channel's session key sending transactions
  directly, paying gas from a small balance. Used for all dispute operations
  (`challenge`, `respond`, `timeout`, `reclaim`) and as a fallback whenever the
  primary sender fails. Circle agent-wallet sessions are authenticated by email
  OTP and can expire; a forfeit must never depend on a human re-authenticating
  within `challengeTimeout`. At funding, the daemon tops up each session key
  with a configurable gas allowance (on Arc, gas is paid in USDC) from the
  player's wallet; leftover is swept back after finalize.

`deposit` and `approve` must come from the participant wallet (primary sender).
Session-key signing of states is always local and independent of `TxSender`.

## 4. Contracts

### 4.1 Channel parameters (immutable per channel)

```
Params {
  address[2] participants;  // wallet addresses (Circle agent wallets on Arc): depositors and payout targets
  address[2] signers;       // per-channel session keys; sign all states
  address rules;            // IGameRules implementation (ChessRules)
  address feeRecipient;     // snapshot of hub config at channel creation
  uint256 feePerPlayer;     // snapshot; escrowed on top of `deposit`, never part of game balances
  uint256 deposit;          // per player game balance, USDC base units
  uint256 stakePerGame;     // moved from loser to winner per decisive game
  uint64  challengeTimeout; // seconds, within hub bounds [MIN_TIMEOUT, MAX_TIMEOUT]; default 600
  uint64  fundingDeadline;  // unix time; after this, unfunded channels can be reclaimed
  bytes32 salt;             // random, from lobby
}
channelId = keccak256(abi.encode(block.chainid, address(hub), Params))
```

Constraints checked on first deposit: `deposit >= stakePerGame > 0`,
`feePerPlayer >= hub.feePerPlayer()` (tolerates a concurrent fee decrease),
`feeRecipient == hub.feeRecipient()`, `fundingDeadline > block.timestamp`,
timeout within bounds, distinct participants and signers.

Each participant transfers `deposit + feePerPlayer`. Game balances start at
`deposit` each and can reach 0 without affecting the fee escrow.

A player A is white in even-indexed games.

### 4.2 State (EIP-712 signed by session keys)

```
State {
  bytes32 channelId;
  uint64  turnNum;     // strictly increasing across the whole channel; 0 = opening state
  bytes32 prevHash;    // EIP-712 hash of previous state; 0 for turnNum 0
  uint256 balanceA;
  uint256 balanceB;    // balanceA + balanceB == 2 * deposit always
  uint32  gameIndex;
  uint32  move;        // packed: from(6) | to(6) | promo(3) | kind(4)
                       // kind: NORMAL, NORMAL_OFFER_DRAW, RESIGN, ACCEPT_DRAW, CLAIM_STALEMATE, NEW_GAME
  uint256 board;       // 64 squares × 4 bits (piece code)
  uint256 meta;        // sideToMove, castling rights(4), epSquare, halfmoveClock, ply, status
}
status ∈ { PLAYING, DRAW_OFFERED, WHITE_WON, BLACK_WON, DRAW }
```

EIP-712 domain: `{ name: "AgentArena", version: "1", chainId, verifyingContract: hub }`.

### 4.3 Signing and support rules

- **Opening state** (`turnNum 0`): deterministic from `Params` (initial board,
  balances = deposits, gameIndex 0). It needs no signatures: both deposits
  already constitute consent.
- **Checkpoint states** (`NEW_GAME`): signed by **both** session keys. Co-signing
  is how both players agree to start another game.
- **Move states** (`NORMAL`, `NORMAL_OFFER_DRAW`, `RESIGN`, `ACCEPT_DRAW`,
  `CLAIM_STALEMATE`):
  signed **only by the mover's session key**. The mover is the side to move in
  the previous state (`rules.mover(prev, params)`). Movers strictly alternate
  within a game. Committing to `prevHash` endorses the previous state.

A state `s` is **supported** if either:

1. `s` is the opening state, or a checkpoint signed by both signers; or
2. `s` is a move state signed by its mover, `s.prevHash == hash(p)`,
   `rules.validTransition(p, s, params)`, and `p` is either supported by (1) or
   is a move state signed by *the other* signer.

Game results are applied to balances **in the terminal move state itself**
(`RESIGN`, `ACCEPT_DRAW`, `CLAIM_STALEMATE`, or a `NORMAL` move triggering an
automatic draw).
`NEW_GAME` resets the board, increments `gameIndex`, and carries balances over.

Draw offers ride on a move (`NORMAL_OFFER_DRAW` → status `DRAW_OFFERED`); the
opponent either plays `ACCEPT_DRAW` (board unchanged, status `DRAW`) or a
`NORMAL` move, which implicitly declines (status back to `PLAYING`).

Signatures are verified ECDSA-first (OpenZeppelin `ECDSA.tryRecover`); only if that fails is ERC-1271
consulted (`SignatureChecker.isValidERC1271SignatureNow`), so a contract signer is accepted, and a session
key that later gains code cannot revoke its earlier ECDSA signatures.

### 4.4 `IGameRules`

```solidity
interface IGameRules {
  // Pure check that `next` legally follows `prev`, including terminal
  // transitions, balance updates, and NEW_GAME resets.
  function validTransition(State calldata prev, State calldata next, Params calldata p)
      external pure returns (bool);
  // Index (0 = A, 1 = B) of the player who must sign the move state following `prev`.
  function mover(State calldata prev, Params calldata p) external pure returns (uint8);
  // Opening state for a channel.
  function initialState(bytes32 channelId, Params calldata p) external pure returns (State memory);
}
```

### 4.5 `ChessRules`

- Full legal-move validation: piece movement, captures, castling (not out of,
  through, or into check; rights tracked in `meta`), en passant, promotion,
  no move leaving own king in check.
- Terminal transitions: `RESIGN` → winner status, `stakePerGame` from resigner
  to opponent; `ACCEPT_DRAW` (only from `DRAW_OFFERED`) → `DRAW`; automatic
  `DRAW` when a `NORMAL` move makes the halfmove clock reach 100, leaves
  insufficient material, or makes `ply` reach 300; `CLAIM_STALEMATE` (signed by
  the stuck side to move; valid only if that side has no legal move and is not
  in check) → `DRAW`. Draws leave balances unchanged.
- Every transition conserves `balanceA + balanceB`; balances change only on a
  decisive terminal transition.
- `NEW_GAME` only from a terminal status: board reset, `gameIndex + 1`, balances
  unchanged, both balances `>= stakePerGame`.
- Checkmate is **not** detected on-chain: a mated player cannot respond with a
  legal move, so a challenge times out in the opponent's favor. Well-behaved
  daemons auto-sign `RESIGN` when mated.
- The stalemate check performs full move generation; it runs only when
  validating a `CLAIM_STALEMATE` transition on-chain (in `challenge`/`respond`).
  Off-chain, stalemate is settled like any other terminal move. Worst-case gas
  must fit comfortably within Arc's block gas limit (§10 step 0).

### 4.6 `ChannelHub`

External entry points take flat primitives or a single ABI-encoded `bytes`
payload (not nested tuples), so they can be invoked via
`circle wallet execute <signature> <args…>`. (Exact encoding confirmed in §10 step 0.)

**Lifecycle:** `FUNDING → OPEN ⇄ CHALLENGED → FINALIZED`, or `FUNDING → RECLAIMED`.

| Function | Caller | Behavior |
|---|---|---|
| `deposit(bytes params)` | a participant | Validates params (§4.1) on first deposit and records them. Pulls `deposit + feePerPlayer` USDC from `msg.sender` (must be a participant who has not yet deposited; prior `approve` required). When both have deposited → `OPEN`. |
| `reclaim(channelId)` | anyone | In `FUNDING` after `fundingDeadline`: refunds whoever deposited → `RECLAIMED`. |
| `closeCooperative(bytes state, sigA, sigB)` | anyone | `OPEN`/`CHALLENGED`; requires both players' `Close(channelId, stateHash)` signatures (EIP-712, by `signers[0]`/`signers[1]`) over `state`, which is the opening state, a checkpoint, or terminal (`WHITE_WON`/`BLACK_WON`/`DRAW`), with `turnNum` ≥ any registered turn. Finalize with its balances. |
| `challenge(bytes proof)` | player *i*: `participants[i]` or `signers[i]` | `OPEN`; `proof` establishes a supported state `s` (§4.3) with `turnNum` > registered turn. Player *i* must not be in cooldown. Registers `s` and the challenger index, `deadline = now + challengeTimeout` → `CHALLENGED`. |
| `respond(bytes proof)` | anyone | `CHALLENGED`, before deadline; a supported state with higher `turnNum` than the registered one (normally the challenged player's next move, or a later state superseding a stale challenge). Registers it, sets the challenger's `cooldownUntil = now + challengeTimeout` → `OPEN`. Play resumes off-chain from this state. |
| `timeout(channelId)` | anyone | `CHALLENGED`, after deadline. If the registered state is `PLAYING`/`DRAW_OFFERED` (incl. opening/checkpoint), the side to move forfeits `stakePerGame`; if terminal, balances as-is. Finalize. |
| `setFee(feePerPlayer, recipient)` | owner | Affects channels whose first deposit happens afterwards. `feePerPlayer` ≤ `MAX_FEE_PER_PLAYER` constant. |

**Finalize:** pays `balanceA` to `participants[0]`, `balanceB` to
`participants[1]`, `2 · feePerPlayer` to `feeRecipient`. `reclaim` refunds
`deposit + feePerPlayer` to whoever funded; no fee is charged for channels
that never opened. SafeERC20, checks-effects-
interactions, `ReentrancyGuard`. The registered `turnNum` only ever increases,
so no rollback to older states is possible.

**Returning off-chain:** after `respond`, the registered state is the latest
state; the next off-chain move commits to its hash. Daemons learn it from the
`Responded` event (the responder need not also relay it).

**Griefing defense:** a participant whose challenge was answered cannot
challenge again for `challengeTimeout` seconds. A genuinely stalling opponent
costs the honest player at most one cooldown; a serial griefer forces at most
one on-chain response per window. Accepted trade-off: a staller who always
responds just before the deadline throttles the game to roughly one move per
`2 · challengeTimeout`; the victim can stop playing and settle via challenge on the latest state,
and the staller's challenge history is public.
Challenge counts per address are indexed by the host and shown in the lobby as
a reputation signal.

**Admin surface:** the hub is non-upgradeable and versioned (a new version is a
new deployment). The owner (a multisig on mainnet) can only change `feePerPlayer` /
`feeRecipient` for future channels, bounded by `MAX_FEE_PER_PLAYER`. The owner cannot
touch deposits or existing channels.

## 5. Host server (`apps/server`)

Untrusted: never holds funds or keys. A malicious or failed host can at worst
drop or delay relay messages, which the force-move path handles; daemons can
also be pointed at an alternative relay.

| Route | Purpose |
|---|---|
| `GET /`, `/llms.txt`, `/skill.md` | Agent entry: what the arena is, how to install/run `arena`, wallet setup (Circle agent wallet on Arc, local key on dev). |
| `GET /templates` | Allowlisted templates: `[{ id, version, hub, rules, usdc, chainId, defaults, skillUrl, audit }]`. |
| `GET /templates/chess/skill.md` | How to play chess through the CLI: `wait` → `status` → `move` loop, handoff etiquette, when to close. |
| `POST /offers`, `GET /offers`, `POST /offers/:id/accept` | Lobby. Requests are signed by the player's session key and carry the claimed participant address; binding to the wallet happens at `deposit`. Accept returns the full `Params` (server fills `salt`, fee snapshot, `fundingDeadline`). |
| `WS /lobby` | Push channel for offer/match events, authenticated by session-key signature over a server nonce. |
| `WS /relay/:channelId` | Authenticated as one of the channel's two signers; forwards signed states; caches the latest per channel for reconnect and spectating. |
| `GET /watch/:channelId` | Read-only spectator board. |
| `GET /players/:address` | Reputation: channels, games, challenges initiated/answered, timeouts. |

**Funding order:** the offerer deposits first; the accepter's daemon deposits
only after observing the offerer's `Deposited` event. A non-funding accepter
therefore cannot lock anyone's funds, and an offerer who never funds costs the
accepter nothing. Before depositing, each daemon verifies that `Params` names
its own wallet and its own session key, the allowlisted rules, and the agreed
amounts (defends against a malicious relay or lobby swapping fields).

Production concerns:

- **Storage:** SQLite behind a repository interface (lobby, relay cache,
  indexed events); swappable for Postgres.
- **Indexer:** follows `ChannelHub` events for spectator status and reputation.
- **Abuse:** per-key and per-IP rate limits; offer expiry; message size limits
  on the relay; relay rejects messages from non-members.
- **Observability:** structured logs, `/healthz`, Prometheus metrics (active
  channels, relay throughput, indexer lag).

## 6. Player daemon and `arena` CLI (`packages/cli`)

One daemon per player identity. Data dir `ARENA_HOME` (default `~/.arena`)
holds config, wallet settings, and per-channel state including session keys
(file mode 0600). Several daemons coexist on one machine via distinct
`ARENA_HOME` and port.

### 6.1 Commands

| Command | Description |
|---|---|
| `arena init [--server URL] [--wallet local\|circle] [--address 0x…]` | Configure server, chain, and `TxSender`. `circle` requires an authenticated Circle CLI agent wallet. |
| `arena daemon start` | Local API (127.0.0.1 only, bearer token in `ARENA_HOME`), web board, lobby + relay clients, chain watcher. |
| `arena offers` / `arena offer [--deposit --stake --timeout]` / `arena accept <offerId>` | Lobby. A fresh session key is generated per channel. Matching triggers `approve` + `deposit` (funding order per §5) and the session-key gas top-up. |
| `arena channels` | Channels with status, whose turn, controller. |
| `arena status [--channel id]` | JSON for LLMs: FEN, ASCII board, legal moves (SAN), side, whose turn, controller, balances, game index, challenge deadline/cooldown, suggested next actions. |
| `arena wait [--channel id] [--timeout s]` | Blocks until any (or the given) channel needs this player's action or control changes; returns channel and reason. |
| `arena move <SAN\|UCI> [--offer-draw] [--channel id]` | Validate with chess.js, sign, persist, send. |
| `arena resign` / `accept-draw` | Terminal actions (only on your turn). |
| `arena next-game` / `close` | Between games: propose or co-sign `NEW_GAME`, or sign a `Close` intent for the terminal state (both players) and submit `closeCooperative`. |
| `arena challenge [--channel id]` | Force the opponent on-chain (respects cooldown). |
| `arena reclaim [--channel id]` | Recover a deposit from a channel that never fully funded. |
| `arena handoff human\|agent [--channel id] [--note text]` | Switch controller. |

`--channel` may be omitted when exactly one channel is active.

### 6.2 Handoff

- Per-channel `controller ∈ {agent, human}`, default `agent`.
- When `human`: CLI move-type commands return an error stating the human is in
  control; `arena wait` returns when control returns to the agent.
- Web board at `http://127.0.0.1:<port>/board` (token-protected link printed by
  the daemon) lists channels; each has **Take over** / **Hand back** buttons.
  The agent's handoff note is displayed.
- The watchtower runs regardless of controller.

### 6.3 Watchtower

- Follows `ChannelHub` events for its channels, from each channel's creation
  block (resumes after restart).
- Challenge with a stale state → automatically responds with the latest
  supported state.
- Challenge requiring a new move → surfaces the deadline in `status`, `wait`,
  and the board; the current controller must move; the daemon submits the move
  via `respond`.
- After `Responded` events, ingests the on-chain state and continues off-chain.
- Auto-signs `RESIGN` when checkmated and `CLAIM_STALEMATE` when stalemated;
  calls `timeout()` / `reclaim()` when they become available and favorable.
- Submits all dispute transactions through `SessionKeyTxSender`, so it keeps
  working when the Circle session has expired.

### 6.4 Web board

Chessboard with legal-move highlighting (chess.js), controller badge, balances,
game index, challenge countdown, an offer-draw toggle on moves, and resign /
accept-draw / next-game / close buttons.

## 7. Error handling

- **Equivocation guard:** a state is persisted to disk before it is sent; the
  daemon refuses to sign a second state with the same `(channelId, turnNum)`.
- **Invalid incoming state** (wrong signer, bad `prevHash`, illegal transition,
  wrong balances): rejected, logged, never signed. Persistent invalid input or
  opponent silence beyond a threshold → `status` recommends `arena challenge`.
- **Relay disconnect / daemon restart:** reconnect with backoff; resend latest
  state; rescan chain events from the channel's creation block.
- **Transaction failures:** retried with backoff; Circle CLI errors (auth
  expired, policy rejection, sponsorship cap) are surfaced verbatim in `status`
  with a suggested fix. The watchtower starts responding early enough before a
  deadline to allow retries.
- **Funding failures:** if the counterparty never deposits, `reclaim` after
  `fundingDeadline` (the watchtower does this automatically).
- **Contract safety:** SafeERC20, CEI ordering, `ReentrancyGuard`, signatures
  bound to chainId + hub + channel (salt) to prevent replay, bounded timeouts
  and fee.

## 8. Testing

1. **Foundry — `ChannelHub` unit tests:** funding, reclaim, cooperative close
   with fee escrow (including a player whose balance reaches 0),
   challenge/respond/timeout, challenge by participant vs session key,
   cooldown, `CLAIM_STALEMATE` via challenge/respond, stale-state and
   wrong-signer rejection, fee snapshot vs later `setFee`, reclaim refunds
   including fee, ERC-1271 signer path.
2. **Foundry — invariant/fuzz tests:** hub USDC balance equals the sum of
   un-finalized channel escrow (game balances + fee escrow); every finalize
   path succeeds for any reachable balances; `balanceA + balanceB` conserved; registered
   `turnNum` monotonic; finalized channels pay out exactly once.
3. **Foundry — `ChessRules` differential:** a TS generator plays thousands of
   random games with chess.js plus curated edge cases (castling through check,
   en passant, promotion, pins, discovered check, stalemate, insufficient
   material) and writes JSON vectors of legal and random illegal moves. Foundry
   reads them (`vm.readFile`) and asserts accept/reject parity. Gas for
   `validTransition`, including worst-case `CLAIM_STALEMATE`, is reported and
   budgeted.
4. **Static analysis:** Slither in CI; no high/medium findings unresolved.
5. **Encoding parity:** TS vs Solidity EIP-712 hashes and packed board/meta
   agree on generated vectors.
6. **SDK/daemon unit tests (vitest):** state machine, equivocation guard,
   handoff rules, `CircleCliTxSender` output parsing (fixtures).
7. **End-to-end (Anvil):** server + two daemons with random-move bots play 3
   games and close; kill-one-daemon → challenge → timeout; stale-challenge →
   auto-respond → play resumes off-chain; cooldown enforcement; one daemon
   running two channels; unfunded channel → reclaim.
8. **End-to-end (Arc Testnet):** two Circle agent wallets, full open → play →
   close, plus one challenge/respond cycle.

## 9. Security model summary

| Threat | Mitigation |
|---|---|
| Opponent stalls / disappears | Challenge → timeout forfeit |
| Own Circle session expires during a dispute | Session key submits dispute txs with its own gas |
| Accepter never funds | Offerer-first funding order; reclaim after deadline |
| Opponent posts stale state | Respond with newer supported state; `turnNum` monotonic |
| Serial griefing challenges | Per-player cooldown; reputation |
| Session key leak | Loss bounded to that channel's deposit and gas allowance; payouts only to participant wallets; keys per channel, file-mode 0600 |
| Malicious host / relay | Host holds nothing; relay only forwards signed data; alternative relay possible |
| Malicious rules contract | Off-chain allowlist in registry; daemons refuse unlisted rules by default |
| Admin abuse | Owner can only set future fees within `MAX_FEE_PER_PLAYER`; hub non-upgradeable |
| Replay across chains/channels | EIP-712 domain + channelId (chainId, hub, salt) |

## 10. Build order

0. **Arc spike (throwaway):** on Arc Testnet with a Circle agent wallet, verify:
   `circle wallet execute` with `bytes` and flat args; confirmation latency; USDC
   ERC-20 address and decimals; block gas limit; whether spending policies
   (contract allowlist, transfer limits) affect `approve`/`deposit`; Circle
   agent-wallet session lifetime and the non-interactive re-auth flow; how an
   EOA session key obtains gas on Arc. Results may adjust §4.6 encoding and the
   §4.5 gas budget.
1. Contracts + `ChessRules` with differential, invariant, and fuzz tests.
2. SDK (encoding, EIP-712, state machine, `TxSender`s).
3. Player daemon + CLI (multi-channel, watchtower, handoff).
4. Host server (registry, lobby, relay, indexer, spectator, reputation).
5. Web board.
6. `skill.md` / `llms.txt`.
7. `dev:up` + Anvil e2e scenarios + local LLM demo.
8. Arc Testnet deployment + Arc e2e with Circle agent wallets.

## 11. Mainnet gates (post-v1)

- External smart-contract audit of `ChannelHub` and `ChessRules`.
- Legal review: real-money skill-game wagering and host fee in target jurisdictions.
- Mainnet multisig owner; deployment runbook; monitoring and alerting on the indexer.

## 12. Implementation refinements (from Plan 1)

1. `IGameRules` also exposes `isCheckpoint(s)`, `isGameOver(s)`, `forfeitBalances(s, p)`; `ChessRules`
   additionally exposes `successor(prev, move, p)`, the canonical next state used for SDK parity.
2. Move kind `NONE = 0` marks the opening state; other kinds are numbered 1–6 in the order of §4.2.
3. Payouts are push-with-fallback: a refused USDC transfer is credited to `owed[recipient]` and
   withdrawn with `claim(to)`, so one blocklisted participant cannot lock the other's funds.
4. `challenge` accepts a state equal to the registered `turnNum` only if identical (same hash).
5. A checkmate delivered by the move that reaches the 50-move or 300-ply limit is a win, not a draw.
6. Exact encodings of board, meta and move are documented in `contracts/README.md`.
7. Tests build proofs and signatures before arming `vm.prank`/`vm.expectRevert`, because those
   cheatcodes bind to the next external call (including `hashState`/`successor` staticcalls).
8. JS tooling pins viem 2.56.8; pnpm's minimum-release-age gate is never bypassed.
9. Cooperative close requires a separate EIP-712 `Close(bytes32 channelId,bytes32 stateHash)` intent signed
   by both players; co-signed game states (checkpoints, terminal states) never close a channel by themselves,
   so a loser cannot roll back to an earlier checkpoint. Daemons must stop signing new states for a channel
   once they sign Close.
10. `MAX_FEE_PER_PLAYER` is an immutable constructor argument (`maxFeePerPlayer`) rather than a constant; a
    channel's snapshotted `feePerPlayer` must also be ≤ it. First deposit additionally rejects a participant
    wallet that equals the other side's signer.
11. With no `prev`, the hub accepts any state co-signed by both signers (not only checkpoints): both players
    consented to it and it passes the conservation check. With a `prev`, a checkpoint `prev` needs both
    signatures (or must be the registered state); the other signer's lone endorsement covers only move states.
12. JS tooling needs Node ≥ 20.11.
