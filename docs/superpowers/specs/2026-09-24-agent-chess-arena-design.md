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
   (Plan 5.5: skill.md's first section is now a numbered install-fund-find-an-opponent-play-settle recipe for
   exactly this prompt, and a dev server's house bots (`arena bot`, §12 item 48) plus its dev faucet mean one
   agent alone can satisfy this criterion against an always-available opponent -- no second human-operated agent
   needed. `tests/system/agent-recipe.test.ts` exercises the whole recipe end to end with a scripted, non-LLM
   agent standing in for one.)
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

pnpm workspaces; TypeScript on Node ≥ 20 (Node ≥ 24, see §12 item 15); Foundry for Solidity; OpenZeppelin
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
  to `sessionGasWei` (on Arc, gas is paid in USDC) from the player's wallet.
  While the channel is Open or Challenged, the daemon refills the key from the
  wallet back to `sessionGasWei` whenever it drops below `sessionGasFloor`
  (§12 item 29), backed off per channel on repeated failure (§12 item 36).
  Once a channel reaches Finalized or Reclaimed, the main pass sweeps the
  session key's balance back to the wallet, reserving headroom for a same-nonce
  fee bump and declining as dust when nothing worth sending is left (§12 item
  35, Plan 5). `arena sweep` / `POST /sweep` additionally sweep settled
  channels found still unswept at start -- legacy records, or ones a restart
  interrupted mid-sweep. A record that cannot be swept after
  `SWEEP_ABANDON_ATTEMPTS` (12) retries is recorded `swept: "abandoned"` so
  eviction proceeds anyway; its balance is stranded, not lost, and a later
  `arena sweep --channel <id>` retries it. `owed` payouts are still not
  claimed by the daemon.

`deposit` and `approve` must come from the participant wallet (primary sender).
Session-key signing of states is always local and independent of `TxSender`.

**The `TxSender` contract** (Plan 4.5; `packages/sdk/src/tx.ts`):

- `send(tx)` MUST honour `tx.nonce` and the fee overrides (`maxFeePerGas`,
  `maxPriorityFeePerGas`, `gasPrice`) and the gas limit. A stuck transaction
  is replaced by sending again at its nonce with higher fees.
- A sender that cannot honour them MUST declare `supportsReplacement = false`.
  Its transactions are then never replaced: the receipt wait only waits
  (bounded) and reports. Such a sender is also untracked by the nonce manager
  and its fees are not capped, so it gives up invariants 3 and 4 of §12
  item 22.
- Optionally, `signTransaction(tx)` and `sendRawTransaction(raw)`, both or
  neither: signing before sending lets the nonce manager know a transaction's
  hash even when the send's response is lost.
- The wallet key behind the daemon's wallet sender is used **only by that
  daemon**. The nonce manager adopts and replaces any pending transaction it
  finds on the key, so a transfer sent from the same key elsewhere can be
  replaced and never land.

Plan 6's `CircleCliTxSender` is written against this contract.

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
  signed **only by the mover's session key**. (See §12 items 11 and 14: a move
  state may also carry the non-mover's co-signature — e.g. R4's adopted move on
  a pending checkpoint — and is then supported with no predecessor.) The mover
  is the side to move in the previous state (`rules.mover(prev, params)`).
  Movers strictly alternate within a game. Committing to `prevHash` endorses
  the previous state.

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

Signatures are verified with ECDSA only (OpenZeppelin `ECDSA.tryRecover`: 65 bytes, v 27 or 28, low s), with no
ERC-1271 fallback (owner decision 2026-10-25, final review A I-1). A signer whose code accepts any bytes, such as a
contract or an EIP-7702-delegated session key, could otherwise put unverifiable signatures in a proof. A delegated
key's own ECDSA signatures still verify against its address, and gaining code cannot revoke them. The SDK's
`recoverStateSigner`/`recoverCloseSigner` accept only the same form, because viem alone also recovers a high-s twin
and v 0/1, so a session never stores a signature the hub refuses (§12 item 70).

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
| `arena daemon start` | Local API (127.0.0.1 only, bearer token in `ARENA_HOME`), web board, lobby + relay clients, chain watcher. Its startup line prints the board's URL with no token (`board`) plus a `boardHint`; the token never reaches a log file. |
| `arena board` | Asks the running daemon for a one-time sign-in code and prints the board's link with it in the fragment (`http://127.0.0.1:<port>/board#code=…`, single-use, valid 120 s). The token itself is never printed (§12 item 42). Open the link in a browser on the machine the daemon runs on. |
| `arena offers` / `arena offer [--deposit --stake --timeout]` / `arena accept <offerId>` | Lobby. A fresh session key is generated per channel. Matching triggers `approve` + `deposit` (funding order per §5) and the session-key gas top-up. `--timeout` defaults to this daemon's `minChallengeTimeout` (§12 item 38) if omitted. |
| `arena channels` | Channels with status, whose turn, controller. |
| `arena status [--channel id]` | JSON for LLMs: FEN, ASCII board, legal moves (SAN), side, whose turn, controller, balances, game index, challenge deadline/cooldown, suggested next actions. |
| `arena wait [--channel id] [--timeout s]` | Blocks until any (or the given) channel needs this player's action or control changes, or a human holding a seat must answer a challenge (`human-must-move`); returns channel and reason. |
| `arena move <SAN\|UCI> [--offer-draw] [--channel id]` | Validate with chess.js, sign, persist, send. |
| `arena resign` / `accept-draw` | Terminal actions (only on your turn). |
| `arena next-game` / `close` | Between games: propose or co-sign `NEW_GAME`, or sign a `Close` intent for the terminal state (both players) and submit `closeCooperative`. |
| `arena challenge [--channel id]` | Force the opponent on-chain (respects cooldown). |
| `arena reclaim [--channel id]` | Recover a deposit from a channel that never fully funded. |
| `arena sweep [--channel id]` | Sweeps settled channels' session-key gas back to the wallet; backed by `POST /sweep` (single-flight, 60 s budget, reports `remaining`). |
| `arena handoff human\|agent [--channel id] [--note text]` | Switch controller. |

`--channel` may be omitted when exactly one channel is active.

### 6.2 Handoff

- Per-channel `controller ∈ {agent, human}`, default `agent`. `POST /handoff
  {to, note}` switches it. `note` is capped at 1024 characters and rejects
  control and bidi-override/isolate characters, with a `\r\n` normalised to
  `\n` before that check (§12 item 43); `status.handoff` reports
  `{controller, note, since}` for whoever holds the seat.
- Every move-type command (`move`, `resign`, `accept-draw`, `next-game`,
  `close`, `challenge`) is refused with 409 unless its `x-arena-actor` header
  matches the channel's current `controller` -- symmetric, so an agent request
  gets 409 while `human` holds the seat, and a `human`-actor request (the
  board's own header) gets 409 while `agent` holds it. The daemon never
  signs on the refused side. This is a coordination guard between two
  parties sharing the bearer token, not access control: any token holder
  can send either actor header or hand the seat over. The watchtower keeps
  running regardless of controller (stale-challenge responses, auto-resign
  on mate, timeouts and reclaims are unaffected).
- A challenge that needs a move on a human-held seat (§6.3): the agent's
  `wait` returns `human-must-move` (once per challenge, whoever holds the
  seat), so the agent can tell the human; and once at most
  `max(60 s, challengeTimeout / 3)` of chain time is left before the
  deadline, the daemon hands the seat back to the agent with the note
  `auto-returned: challenge deadline approaching` (`autoReturnOnChallenge`,
  default on). A forfeit never depends on a human who closed the board
  (§3.1; §12 item 45).
- `arena wait` wakes with `reason: "control-changed"` on a controller change
  it observes while it is in flight. A change that happened before the call
  started is not itself a wake reason: `wait` instead returns the channel's
  ordinary `attention` (e.g. `your-turn`), so callers must read
  `status.controller` after every `wait`, not infer control from the reason
  string alone (§12 item 44).
- The human opens the board by running `arena board` on the machine the
  daemon runs on and opening the link it prints within 120 s. The link
  carries a single-use code, never the bearer token (§6.4, §12 item 42).
  Until it is used it must never be pasted or shared, and never opened from
  another machine: signing in with it is holding every channel's controls.

### 6.3 Watchtower

- Follows `ChannelHub` events for its channels, from each channel's creation
  block (resumes after restart).
- Challenge with a stale state → automatically responds with the latest
  supported state.
- Challenge requiring a new move → surfaces the deadline in `status`
  (`challenge.deadline`, `secondsLeft`, `mustMove`) and the board (a red
  banner and a countdown); the current controller must move; the daemon
  submits the move via `respond`. With the agent in control, `wait` returns
  `your-turn`. With a human in control, `wait` returns `human-must-move` to
  the agent once per challenge, the board warns "Move before <time> or the
  seat returns to your agent", and once at most `max(60 s, challengeTimeout /
  3)` is left the dispute pass hands the seat back to the agent
  (`status.challenge.autoReturnAt` is that moment in chain time), whose
  `wait` then returns `control-changed` or `your-turn` (§12 item 45).
- After `Responded` events, ingests the on-chain state and continues off-chain.
- Auto-signs `RESIGN` when checkmated and `CLAIM_STALEMATE` when stalemated;
  calls `timeout()` / `reclaim()` when they become available and favorable.
- Submits all dispute transactions through `SessionKeyTxSender`, so it keeps
  working when the Circle session has expired.
- Keeps each open channel's session key able to pay for those transactions:
  it refills a key below `sessionGasFloor` from the wallet, and raises
  `session-gas-low` if the wallet cannot (§12 item 29).

### 6.4 Web board

Served by the daemon's own local API at `/board`: static files with no build
step (vanilla ES modules and CSS; the board does not use chess.js, it gets
legal moves from `status.legalMovesUci`), each read from disk once and
matched against an exact-path allowlist, so any other path under `/board` --
a traversal attempt, encoded or not, or simply an unknown file -- 404s rather
than falling through to anything token-gated. The static shell needs no
token; every data route still requires the bearer token. The browser reads a
one-time code from `location.hash` on load (`#code=…`, from `arena board`),
clears the fragment with `history.replaceState`, and trades the code for the
token with `POST /board/session`; it keeps the token only in memory, sending
it as `Authorization: Bearer <token>` on every call. `EventSource` cannot set
headers, so live updates use `fetch()` with a `ReadableStream` reader instead
(§12 items 41, 42).

Layout: a channel list with a status chip per channel (your turn, waiting,
challenged, settled) and the `session-gas-low` / `lobbyError` /
`opponent-silent` attention banners; a center 8x8 CSS-grid board (orientation
from `orientation`, last move highlighted, click a piece for its
`legalMovesUci` targets, a small promotion picker for q/r/b/n, keyboard
navigable); a right panel (controller badge, Take over / Hand back with a
note field, the current handoff note, balances, game index, status, an
offer-draw toggle, resign / accept-draw / next-game / close, and a challenge
countdown with a red "you must move" banner, plus, while a human holds the
seat, a warning of when it returns to the agent); and a lobby panel (open offers
with Accept, a small create-offer form). Everything untrusted -- notes,
errors, opponent-influenced strings -- is rendered as text, never `innerHTML`.

**Security model** (§12 item 41):
- Host guard: any request whose `Host` header is not exactly
  `127.0.0.1:<port>` or `localhost:<port>` gets 421, on every route including
  `/health` and `/board` -- the DNS-rebinding defense. A duplicate `Host`
  header also gets 421; a non-origin-form request-target (an absolute-form or
  asterisk-form URL, a shape a same-origin browser never sends) gets 400.
- No CORS: no `Access-Control-*` header is ever sent, and a preflight
  `OPTIONS` gets 405. Every POST also requires `Content-Type:
  application/json` (else 415; after the token check, and on `POST
  /board/session` before its rate-limit attempt is counted), so a
  cross-origin page -- which could send JSON only after that refused
  preflight -- is left with no-cors "simple" POSTs that reach no handler.
- Every response carries the board's CSP (`default-src 'self'; script-src
  'self'; style-src 'self'; img-src 'self' data:; connect-src 'self';
  frame-ancestors 'none'; base-uri 'none'; form-action 'none'`),
  `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, and
  `X-Frame-Options: DENY`; JSON responses add `Cache-Control: no-store`.
- The token lives only in the daemon's `token.json`, the board's memory and
  the `Authorization` header -- never in a URL (fragment included), a query
  string, or a log line. Links carry a single-use, 120 s code instead;
  `POST /board/code` (token-gated) mints one, and `POST /board/session`
  (Host-guarded, no token, 10 attempts per minute per daemon) trades it for
  the token once (§12 item 42).

**Live updates.** `GET /events` is a token-gated SSE feed. It sends
`event: change` with `data: {"channelId":null}` -- the event carries no
payload; the board reacts by re-fetching `/channels` and the selected
`/status` -- whenever the daemon's state changes, debounced per client to at
most one send per second (trailing-edge: a burst collapses to one send right
away, plus one more at the window's end if anything changed during it), plus
a `: ping` comment every 15 s. At most 8 concurrent clients; a 9th gets 429.
The stream closes on client disconnect, daemon stop, or server close.

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
   including fee, a contract signer refused and an ECDSA signature that survives its signer gaining code
   (ECDSA only: §4.3).
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
| Forced responds drain the session key, then a stale challenge goes unanswered | Refill below `sessionGasFloor` while Open/Challenged; `session-gas-low` when the wallet cannot (§12 item 29) |
| Short `challengeTimeout` makes a missed deadline likely | Daemons refuse offers and matches under `minChallengeTimeout`, default 900 s (§12 item 30) |
| Session key leak | Loss bounded to that channel's deposit and gas allowance; payouts only to participant wallets; keys per channel, file-mode 0600 |
| Malicious host / relay | Host holds nothing; relay only forwards signed data; alternative relay possible |
| Malicious rules contract | Off-chain allowlist in registry; daemons refuse unlisted rules by default |
| Admin abuse | Owner can only set future fees within `MAX_FEE_PER_PLAYER`, the launch caps, and a deposit-only pause (§13); hub non-upgradeable; exits never pausable |
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

## 12. Implementation refinements (from Plans 1, 2 and 4.5)

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
   by both players; co-signed game states never close a channel by themselves, so a loser cannot roll back to
   an earlier checkpoint. The hub accepts a Close on the opening, a checkpoint or a terminal state, but daemons
   sign Close only on terminal states (item 13). Daemons must stop signing new states for a channel once they
   sign Close.
10. `MAX_FEE_PER_PLAYER` is an immutable constructor argument (`maxFeePerPlayer`) rather than a constant; a
    channel's snapshotted `feePerPlayer` must also be ≤ it. First deposit additionally rejects a participant
    wallet that equals the other side's signer.
11. With no `prev`, the hub accepts any state co-signed by both signers (not only checkpoints): both players
    consented to it and it passes the conservation check. With a `prev`, a checkpoint `prev` needs both
    signatures (or must be the registered state); the other signer's lone endorsement covers only move states.
12. JS tooling needs Node ≥ 20.11.
13. **R8 (Plan 2) — Close only on terminal states** (replaces R7, which let the player on move close at the
    opening or on a both-signed checkpoint). A player signs Close only when the latest state is terminal
    (`WHITE_WON`/`BLACK_WON`/`DRAW`), with no new-game proposal pending and nothing later signed. Why: signing
    Close freezes the signer, but the opponent may keep that signature and instead challenge the same state.
    The opening needs no signatures and a both-signed checkpoint is already supported, so the hub registers
    it; the frozen closer cannot respond, and `timeout` makes them forfeit `stakePerGame` (reproduced on
    Anvil). On a terminal state `timeout` settles balances as-is, so a withheld counter-signature costs the
    closer nothing. Exit paths: between games, close on the finished game instead of proposing the next one;
    before game 0, the player to move plays a move with a draw offer, the opponent accepts, and both close on
    the `DRAW` state (balances unchanged).
14. **R9 (Plan 2) — a move on a pending checkpoint is accepted.** A player who proposed a `NEW_GAME` checkpoint
    `C` and has not yet received the countersignature accepts the opponent's move `C+1` — off-chain or from a
    `Challenged`/`Responded` event — if it is the canonical successor of `C`, commits to `hash(C)`, is not a
    checkpoint, and is signed by `C`'s mover (the opponent). Why: by §4.3 rule 2 the opponent's signature on a
    move that commits to `C` endorses `C`, so the missing countersignature adds nothing. Without this rule, an
    opponent who countersigns but withholds it (or a dropped relay message) leaves the proposer unable to accept
    `C+1`; after a challenge with `{prev: C both-signed, latest: C+1}` the proposer cannot respond and forfeits.
    After acceptance the proposer's next move `C+2` is proven as `{prev: C+1 (opponent-signed), latest: C+2}`,
    which the hub accepts. R4 (Plan 3 fix round 1): on acceptance the proposer also signs `C+1` itself, through
    the normal equivocation-guarded signing path, whether adopted off-chain (`receive`) or from an on-chain event
    (`ingestOnChain`). `C+1` is then stored fully signed and is provable on its own (`{hasPrev: false, latest:
    C+1}`), with no need for `C+2` or for `C`'s countersignature at all. Why: the opponent's signature on `C+1`
    already endorses `C` (as above), so nothing is lost by the proposer also signing `C+1`; doing so closes a
    liveness gap the naive version of this rule left open (N1, Plan 2 review; I1, Plan 3 review): if `C+1` is a
    finished game (a resignation on move 1), the *unsigned* adopted state would leave `prev` a checkpoint only
    the proposer had signed — a proof the hub rejects, with no further move able to repair it, and no way to
    unlock funds without the opponent's cooperation, on- or off-chain. A `C` countersignature that later arrives
    anyway is still accepted and repairs the stored predecessor, but this is now cosmetic, since `C+1`'s
    provability never depended on it.
15. **Node floor.** The host server uses `node:sqlite`, so the workspace requires Node ≥ 24; this supersedes §3's
    "Node ≥ 20".
16. **One WebSocket endpoint.** `GET /ws` multiplexes lobby match events and relay traffic, and replaces §5's
    `WS /lobby` and `WS /relay/:channelId`.
    - Each connection receives a random nonce in its `hello` frame.
    - A relay `join` carries the channel's `Params` (self-certifying: the server recomputes `channelId`) and a
      session-key EIP-191 (`personal_sign`) signature over `keccak256(abi.encode("arena-relay-join", channelId,
      nonce))`.
    - The server accepts a join only for a channel it knows that is not settled: one its lobby matched (the
      match records the `channelId`), or one its indexer has seen on-chain. A channel whose indexer row is
      `Finalized` or `Reclaimed` counts as unknown, so its pruned cache cannot be refilled; daemons leave a
      channel when they mark it settled and never need the relay after that. Any other join is refused with
      `unknown channel`. Why: otherwise anyone could mint throwaway channels and fill the host's disk through the
      relay cache. The CLI
      treats this refusal as transient and retries the join on the next `hello`, because the host can learn of
      the channel later, for example once its indexer sees `ChannelCreated`. A retry costs one frame per
      reconnect.
    - A `leave` frame removes the connection from one channel and frees its slot under the per-connection join
      limit. The daemon sends it as soon as it marks a channel settled or retired.
    - Lobby `subscribe` frames name offer ids and are unauthenticated: a match event only reveals params that
      become public on-chain at deposit. An `unsubscribe` frame frees the slots again. The daemon unwatches, and
      deletes, an offer record once `expiresAt + maxFundingWindow` (7200 s) has passed.
    - The server persists matches and replays them on subscribe, so an offerer who was offline at match time
      still funds. The daemon judges an offer's expiry at match time, not when it processes the match: it refuses
      a match only when `fundingDeadline > expiresAt + maxFundingWindow`, which shows the match was made after
      expiry. It still requires `fundingDeadline > now`. An offerer who comes back after `expiresAt` to a match
      made in time therefore still funds.
    - The server sends an application-level `ping` frame every 25 s. A client that receives no frame for 70 s
      treats the connection as dead (for example half-open after a sleep) and reconnects.
17. **Relay cache.** The relay caches, per channel and sender, the 4 highest-turn `state` messages and the latest
    `close`. A state with the same `turnNum` as a held one replaces it. A state lower than all 4 held ones is
    dropped, so a lower turn never evicts a higher one. The relay caches a state only if it carries a valid
    signature of its sender. It replays the peer's cached states to a (re)joining member in ascending `turnNum`
    order, then the peer's close. Why 4 and not 1: a player who resigns at turn *n* and at once proposes the next
    game at *n*+1 sends two states in a row, and a peer who missed both needs *n* before it can accept *n*+1.
    The extra slots also absorb re-sends.
    - Daemons re-send their latest own-signed state, a pending own new-game proposal, and their Close signature
      every time a join is confirmed.
    - `ChannelSession.receive` answers re-sent messages with `duplicate`/`stale` instead of an error. A different
      state at the latest turn remains an error.
    - When the indexer applies `Finalized` or `Reclaimed`, it stores the relay's latest verified state and the
      games count derived from it on the channel row. It deletes the channel's relay cache a day later. After
      that, reputation and `/api/channels` read the stored values.
    - The server deletes a matched offer a day past its funding deadline if its channel never reached the chain
      or is settled. For a channel that never reached the chain, it also deletes the relay cache in the same
      transaction, because no indexer row will ever schedule that cache for pruning.
18. **Dispute scan cursor.** Daemons scan `Challenged`/`Responded` events forward from a persisted per-channel
    cursor, in chunks of `logChunkBlocks` (default 1000). They never advance past an event that failed to
    ingest, and a `getLogs` failure does not stop the rest of the watchtower pass. Every scan also re-reads the
    trailing 32 blocks behind the cursor. Why: a load-balanced RPC's `blockNumber` can run ahead of its own
    `getLogs` index, and a shallow reorg can drop an event, so a single pass can miss an event for good.
    `ingestOnChain` ignores states it already holds, so the overlap is harmless. The server indexer uses the same
    pattern over all hub events: chunked cursor plus a trailing 32-block rescan, with `apply` idempotent through
    each row's `lastEvent`. A rescanned chunk never moves the indexer's cursor back.
    *Plan 6 hardening H1:* when the RPC refuses a chunk, the scan splits it (only a refusal of the query itself, never
    a rate limit or a transient failure: item 67). A single block it refuses even on its own, while the RPC is
    otherwise up, is skipped, so later events stay readable. The skip is recorded per channel
    (`skippedEventBlocks`), shown in `status`, and the skipped blocks are retried in turn every few minutes; a block
    that reads again resets its count. The dispute pass reads the phase and the registered state from the hub's
    storage, not from events, so a skip cannot hide a challenge.
    - If the unreadable event is a `Challenged` that registered a move this daemon never received, the daemon adopts
      the registered move from storage when the hub's endorsement makes that safe, and answers it. The worst case is
      a lock: a later challenge needs the opponent's signature, which a later readable event repairs. It is not a
      forfeit.
    - When adoption is impossible, the daemon raises the attention `challenge-unseen`. It names the turn and the
      deadline. The fix is the human's: switch `rpcUrl` and restart the daemon.
    - The server indexer applies the same split-and-skip, skipping only a refused block's `Challenged`/`Responded`
      events. It reports the count as `arena_indexer_skipped_blocks` on `/metrics`: the blocks skipped since that
      process started. A skip is permanent in practice. The count starts at 0 on a restart, and a later read of the
      block can drop it from the count without applying its dispute events (`apply` ignores an event older than a
      row's `lastEvent`), so the affected rows may stay stale (final review C m-1).
    - The hardened hub (audit I1; `proposal/hub-hardening`, merged in `750e280` and deployed on Arc testnet) verifies
      every signature slot it re-emits, and since `aa5ddfc` with ECDSA only (item 70). So an oversized event cannot
      arise from a daemon-signed state; it needs an RPC that refuses, or lies about, an ordinary one.
19. **Host connection lifecycle (CLI).**
    - `start()` and match handling never wait on a relay join. A slow or silent host cannot delay the watchtower
      or the local API. A failed join is recorded as the channel's `lastError`.
    - After a reconnect, re-joins go out at 10 per second or fewer, and only for channels that are not settled,
      because every confirmed join makes the daemon re-send frames of its own. The server's default sustained
      frame rate is 400 per second per connection (item 34). The loop stops at the first "too many channels on this
      connection" refusal, and the remaining joins wait for the next `hello`.
    - The reconnect backoff resets only after a connection has stayed up for 30 s past `hello`. A server that
      accepts the connection and drops it at once therefore sees a growing delay.
20. **Per-IP limits.** The server keys every per-IP limit (the HTTP token buckets, `wsPerIp` and
    `maxOpenOffersPerIp`) as follows:
    - an IPv4 address counts as itself, and an IPv4-mapped IPv6 address counts as its IPv4 address;
    - an IPv6 address counts by its /64 prefix;
    - with `trustProxy` set, the key is the right-most `X-Forwarded-For` entry. The default is off: the key is the
      socket peer. Behind a reverse proxy, `trustProxy` must be on, or every client shares the proxy's buckets.
21. **`arena init --server` trust.** `/templates` also publishes an `rpcUrl`. The addresses and the RPC it
    publishes decide where deposits go and what the watchtower sees, so the host is trusted for them.
    - When `init` adopts any of these values, it checks over that RPC that `eth_chainId` matches and that the hub
      and rules addresses hold code. It fails otherwise.
    - It prints every chain value with a `trust` line, and warns on stderr about a non-loopback `http://` server.
    - With `--rpc/--chain-id/--hub/--usdc/--rules` all given, it fetches nothing from the server and does not
      verify the addresses. It still asks the RPC for `eth_gasPrice` to derive the default `sessionGasWei` (item 29),
      unless `--session-gas-wei` is given too; then it makes no network call.
    - This refines §9's "host holds nothing". The host still holds no funds or keys, but agents must verify the
      published addresses, or pass them explicitly, and should preferably use their own RPC.

### Plan 4.5 refinements (hardening, 2026-09-29)

22. **Per-key nonce manager.** Every key the daemon sends from (the wallet and each session key) has a tracking
    `SerialTxSender`. Sends are serialized per key, and each nonce the key has used and not yet seen mined is
    tracked with its hashes and last fees, in state `waiting` (a receipt wait owns it) or `released` (its wait
    ended without success). It holds five invariants:
    1. **No pre-emption.** A new intent never replaces a transaction whose wait is still active; it takes the next
       nonce.
    2. **At-most-once intent.** Our own resends never make one intent land twice. A replacement that finds its
       nonce used throws `TxNonceUsedError` and is never re-sent at a fresh nonce: the caller re-reads the chain.
       The one accepted residual: a top-up whose send response was lost, mined before the resend and read against
       a stale balance, can be paid once more (at most one extra `sessionGasWei`).
    3. **Stuck transactions are never abandoned.** Once a wait gives up on nonce N, the next send from that key
       replaces N with raised fees instead of queueing behind it. A fresh sender that finds pending nonces it does
       not track (a restart, or a lost response) adopts the lowest one as released and replaces it.
    4. **Bounded fees.** The wallet never pays more per gas than max(4 × the node's estimate, `feeCeilingWei`,
       default 100 gwei; 40 gwei on Arc, item 60), nor more than its balance can cover. Session keys have no fee
       ceiling (a dispute must never be refused by one); only their balance bounds them, which is why item 29
       exists. *Plan 6 (item 62):* on a chain with a fee floor (Arc, 20 gwei), the floor is applied last, after the
       balance clamp. It can beat the ceiling, but never the balance: a send the balance cannot pay at the floor is
       refused (`TxInsufficientFundsError`), never sent under it.
    5. **Every wait is bounded** by its give-up time, its replacement count or the daemon's stop signal.

    It assumes instant finality (Arc): after a reorg that un-mines one of our transactions, that nonce is not
    adopted again.
23. **`TxSender` contract.** See §3.1: honour the nonce and fee overrides or declare `supportsReplacement =
    false`; the optional sign-then-send pair; the wallet key is used only by this daemon.
24. **Two-pass watchtower.** Every `pollMs` the daemon starts two independent passes. The dispute pass handles only
    Challenged channels (adopt on-chain states, respond, auto-resign or claim, time out a silent opponent), each
    channel concurrently with its own session key. The main pass does everything else: offer pruning, funding,
    reclaim, dispute scans and self-heal for channels that are not Challenged, the cooperative-close retry, match
    retries and settled-channel eviction. A stalled funding or close transaction therefore never delays a respond,
    and one channel's stuck respond never delays another's. Per-channel flags keep a respond (the dispute pass or
    the move path) and a reclaim (the main pass or the reclaim API) from running twice at once.
25. **Bounded receipt waits.** Every write waits at most `RECEIPT_TIMEOUT_MS` (30 s) per round; a dispute
    transaction waits min(30 s, a third of the time left to its deadline), never under 10 s. After each round a
    dropped transaction is reported (the caller re-evaluates), and a pending one is replaced at its nonce with fees
    raised by at least 12.5 %, up to 3 times. A respond gives up at its dispute deadline. A transaction the node
    reports mined whose receipt stays unreadable for 3 rounds is treated as mined.
26. **Chain and deployment identity.** The server records `(chainId, hub, genesis hash)` in its database the first
    time it opens it and refuses to start against a different chain or deployment. The indexer unwinds rows whose
    events a reorg removed, within a 32-block window. A daemon refuses to load a channel record whose params do not
    hash to its id under the configured hub and chain (it is reported as degraded).
27. **Lobby watch slots.** An offer matches at most once, so the daemon unwatches it on any match event for it,
    before anything else; the server also frees a watch slot as soon as it pushes that offer's match. A subscribe
    the host refuses sets a daemon-wide `lobbyError`, shown in every channel's status, and new offers and accepts
    answer 503 until the daemon restarts. The daemon leaves a settled channel's relay room, freeing its join slot.
28. **Accepter binding.** The accepter re-verifies the offer's signature before recording or signing anything, and
    `checkMatchParams` binds the offerer's seat (wallet and session key) to the offer it accepted, so a host cannot
    seat someone else opposite it.
29. **Session-key dispute gas (final review C1).** Responding is a safety property: an unanswered challenge on any
    supported earlier state lets the challenger time out on it, erasing every game since and taking a forfeit. So:
    - While a channel is Open or Challenged, a session key below `sessionGasFloor` (default half of
      `sessionGasWei`) is refilled from the wallet (its nonce-managed sender) up to `sessionGasWei`. The balance is
      read again right before the send. The main pass refills Challenged channels first; the dispute pass also
      refills, after its own respond. One refill per channel at a time.
    - If the wallet cannot refill, the channel raises the `session-gas-low` attention (first, whoever controls the
      channel) with the suggested action "fund your wallet: dispute gas for channel X is low". `wait` wakes for it
      once per episode.
    - `arena init` derives the default `sessionGasWei` from the chain:
      $$\text{sessionGasWei} = k \cdot G_{\text{respond}} \cdot F_{\text{cap}}$$
      with $k = 4$, $G_{\text{respond}} = 2{,}100{,}000$ (the heaviest measured respond, about 1.86M, plus a
      margin) and $F_{\text{cap}} = \max(\text{fee ceiling}, 4 \times \text{the RPC's gas price})$.
      `--session-gas-wei` overrides it. *Plan 6 (item 61):* on a chain with a built-in profile,
      $F_{\text{cap}}$ is the profile's own fee ceiling, with no gas-price read and whatever `--fee-ceiling-wei`
      says: $4 \times 2{,}100{,}000 \times 40\,\text{gwei} = 0.336$ USDC per channel on Arc. On Arc,
      $4 \times$ `eth_gasPrice` is at least 80 gwei (20 gwei floor), so the old term would always lock at least
      0.672 USDC (0.84 at a 25 gwei gas price); refills cover a fee spike instead.
30. **Minimum challenge timeout (final review I4).** Daemons refuse a `challengeTimeout` under `minChallengeTimeout`
    (default 900 s): `createOffer` and `acceptOffer` answer 400, and a match under it is ignored. The offer defaults
    (`arena offer`, the API, the server's `defaults.challengeTimeout`) are 900 s. The hub's own minimum stays 60 s.
31. **Bounded approval (final review I2).** The daemon approves exactly `deposit + feePerPlayer` before a deposit,
    and only when the current allowance is short; never an unlimited allowance. `arena init` warns loudly when the
    hub, rules or USDC address differs from the canonical deployment for a known chain id (`KNOWN_DEPLOYMENTS`).
    *Plan 6 (item 64):* on a chain with a built-in profile it refuses instead; Arc's entries are added after each
    deploy.
32. **Flat daemon memory (final review I3).** A settled channel (Finalized, Reclaimed, or retired without our
    deposit) is dropped from the daemon's live set 10 minutes of chain time after the main pass first sees it
    settled. `status` still serves it from its cached final status (the latest 1,000) or from disk, and `channels`
    lists the cached ones. A daemon needs a supervisor that restarts it (see the CLI README).
33. **Settlement wake.** A channel that reaches Finalized or Reclaimed while the daemon watches it raises a one-shot
    `settled` attention, consumed by the first `wait` that returns it.
34. **Server WS frame limits.** The per-connection defaults are 4000 frames burst and 400 per second, twice what
    the soak needed: one daemon sends every channel's relay traffic over one connection, and a trip closes it
    (1008). The per-IP caps are unchanged. Outside a local Anvil chain the server refuses to start without an
    explicit, non-development `audit` string, since `/templates` publishes it.

### Plan 5 refinements (web board and handoff, 2026-09-29)

35. **Session-gas sweep.** See §3.1: once a channel reaches Finalized or Reclaimed, the main pass sweeps the
    session key's balance back to the wallet, reserving `gas * ceil(feePerGas * 1.3)` headroom for a same-nonce fee
    bump and declining as dust when nothing worth sending is left. `arena sweep` / `POST /sweep` additionally sweep
    settled channels found still unswept at start (legacy records, or ones a restart interrupted mid-sweep). A
    record that cannot be swept after `SWEEP_ABANDON_ATTEMPTS` (12) retries is recorded `swept: "abandoned"` so
    eviction proceeds anyway; a later `arena sweep --channel <id>` retries it. `POST /sweep` with no `--channel` is
    single-flight (a concurrent call gets 409) and spends at most `SWEEP_TIME_BUDGET_MS` (60 s) attempting records,
    reporting `remaining` rather than hanging the caller.
36. **Refill back-off.** A channel whose dispute-gas refill keeps failing gets a per-channel
    `refillBlockedUntil`: 30 s after the first failure, doubling on each further one up to 5 min, reset by a
    successful refill, a balance already at the floor, or the wallet's own balance rising since it was last
    observed (it may have just been funded). One log line opens the episode and one closes it.
37. **`session-gas-low` precision.** Raised only when the wallet itself cannot pay for a refill --
    `TxInsufficientFundsError`, `TxFeeCapError`, or a failed fee/gas estimate for it -- never for a transient refill
    error (a nonce race, a dropped/stuck send, a missing receipt), which is logged and re-evaluated on the next
    pass without alarming the agent. *Plan 6 (item 63):* a top-up that was mined and reverted raises it too, and
    is never counted as a refill. *Plan 6 hardening H1 (commit 50f71c9):* the action is cause-specific. Only a
    wallet shortfall says "fund your wallet", and only it names an amount (0.356 USDC on Arc). A reverted top-up
    ("check the refill:"), a fee over the ceiling ("wait:"), a failed estimate, or 3 refills in a row lost in
    transit (cause "failing"; "check the RPC:") each say that funding will not fix it. Transient failures now raise
    the attention after 3 in a row. A revert's back-off is not ended by a rise in the wallet's balance.
38. **Offer default timeout** (supersedes item 30 for the daemon's own defaults). When `POST /offers` omits
    `challengeTimeout`, the daemon now defaults it to its own `minChallengeTimeoutOf(config)` rather than a fixed
    900 s; `arena offer` omits the field unless `--timeout` is given. The server's `/templates`
    `defaults.challengeTimeout` (item 30) is a separate value and is unaffected.
39. **`wait --channel` on an evicted settled channel** returns `{channelId, reason: "settled"}` at once instead of
    surfacing `pick()`'s 409, re-checked on every iteration of the poll loop too (a channel can be evicted mid-wait).
40. **`dev-up --dir` guard.** `--dir` is refused when the directory already exists, is non-empty, and carries no
    `.arena-dev-marker` file; the marker is written on first successful use, so later runs against the same
    directory are unaffected.
41. **Board security model.** See §6.4: the Host guard (421, including a duplicate `Host` header; 400 for a
    non-origin-form request-target), the CSP and other security headers, the static board's exact-match allowlist
    (no directory listing, no traversal), and the `GET /events` SSE cap (8 clients, 429 past it) with its
    per-client debounce (at most one `change` per second, trailing-edge) are all load-bearing against a hostile web
    page sharing the browser: DNS rebinding, a same-machine port guess, or injected markup.
42. **Token discipline** (corrected by the final fix wave, M1). The bearer token never appears in a URL or a log
    line. A URL fragment is not private: `history.replaceState` clears the address bar, but the browser's history
    database (and its omnibox suggestions, and any history sync) keeps the URL it opened, fragment and all. So
    `arena board` asks the running daemon (`POST /board/code`, with the token read from disk) for a one-time code and
    prints `http://127.0.0.1:<port>/board#code=<code>`: 128 random bits, base64url, single-use, expiring 120 s after
    it is minted, at most 32 outstanding. The board clears the fragment and trades the code for the token (`POST
    /board/session {code}`: no bearer token, Host-guarded, rate-limited to 10 attempts per minute per daemon before
    the code is read; a used, expired or unknown code gets 401), then keeps the token in memory only. History holds
    only a dead code. `#token=` links are no longer accepted (the board shows "This link has expired — run `arena
    board` again"). The `arena daemon` start line prints the board's URL with no code or token (`board`) plus a
    `boardHint`, so nothing that gets redirected to a log file (`nohup … > daemon.log`, a systemd unit's stdout)
    ever carries a credential.
43. **Handoff note.** `POST /handoff`'s `note` is capped at `MAX_HANDOFF_NOTE_LENGTH` (1024) characters and rejects
    C0/C1 control characters and bidi-override/isolate formatting characters; a `\r\n` is normalised to `\n` before
    that check, so a pasted Windows-style line break is not itself rejected. The board renders it as text, never
    `innerHTML` -- this cap is about denial-of-service and layout, not XSS, since text rendering already defeats
    markup.
44. **`wait()`'s controller baseline.** Each call records, per channel, the controller it first observes; a change
    after that baseline returns `{reason: "control-changed"}`, but a change that happened before the call started
    is visible only through the channel's ordinary `attention` (e.g. `your-turn`), not through the reason string.
    Callers must read `status.controller` after every `wait` rather than infer control from the reason alone (see
    `docs/superpowers/mainnet-gates.md` for a note on giving `wait` a `since` cursor instead).

### Plan 5 final fix wave (2026-09-29)

45. **A challenge on a human-held seat** (I1). The attention `human-must-move` is raised when a human holds the seat,
    the channel is Challenged and `challenge.mustMove` holds. It appears in `status.attention` for the agent (after
    `session-gas-low`), and `wait` returns it whoever holds the seat, once per challenge (keyed by the challenge's
    deadline; a human taking the seat again re-arms it). The dispute pass, on move in the registered state and
    after auto-resign/claim, hands the seat back to the agent once `secondsLeft <= max(60, challengeTimeout / 3)`
    (chain time), with the note `auto-returned: challenge deadline approaching` and a change notification; inside
    that window a human who takes the seat again is handed straight back. `status.challenge.autoReturnAt` is that
    moment in chain time (null unless a human holds a seat that must move and auto-return is on), and the board
    warns "Move before <time> or the seat returns to your agent". Config `autoReturnOnChallenge` (default true;
    `arena init --auto-return-on-challenge false`) turns the return off, not the attention.
46. **Bounded automatic sweep** (I2, M3, M4, M5). The main pass's own sweeps (live channels and the sweep queue)
    pass `giveUpAt = now + SWEEP_PER_RECORD_TIMEOUT_MS` (20 s) to their receipt wait, like `arena sweep`, and the
    queue is attempted at most `SWEEP_QUEUE_PER_PASS` (3) records per pass, round-robin. A sweep transaction the
    daemon gave up on (`pendingTx`) is probed at once, then, while the node still holds it unmined, only after the
    sweep back-off; after `SWEEP_PENDING_PROBES` (3) such probes the next attempt goes ahead and replaces it at the
    same nonce with raised fees (the old hashes stay remembered; a read failure, or a mined transaction whose
    receipt is unreadable, is retried without counting). A failed pre-send chain read (`SweepReadError`: the
    settled check, the key's nonce, balance and fees, the wallet's code) backs off but never counts toward
    `SWEEP_ABANDON_ATTEMPTS`; the send, the receipt and a contract wallet's gas estimate still do. The pending
    hashes are persisted as `record.sweepPending` (written before `stop()`'s early return), so a restart resumes
    checking them and records a late landing as the sweep rather than "dust".
47. **`settled` for every seat** (M2). The one-shot `settled` attention no longer requires the agent to hold the
    seat, and `wait --channel <id>` on a settled channel still in `live` returns `settled` at once (consuming any
    pending wake), as it does once evicted (item 39). An all-channels `wait` keeps the one-shot rule.
48. **Dev faucet and house bots are dev tooling** (Plan 5.5). `POST /faucet` is gated by a three-way guard,
    checked once at startup and cached for the process's lifetime: config `devFaucet` must be `true`, `chainId`
    must be `31337`, and the RPC's `web3_clientVersion` must match `/^anvil\//i`. Any one false and the route
    behaves exactly like an unknown path (404) -- a real deployment never even makes the `web3_clientVersion`
    call. When enabled it mints exactly 100 USDC and raises native ETH to at least 10 ETH (never lowering it;
    raised from 1 ETH in a fix round, since the CLI's own default `sessionGasWei` is ~0.84 ETH, leaving no real
    headroom for skill.md's own "open a second channel" step), rate-limited to once per address per 10 minutes,
    and `/templates`' chess entry gains a `faucet` URL (absent
    entirely when disabled). `arena init` calls it automatically below a 20 USDC balance (`--no-faucet` turns
    this off). `arena bot` (a long-lived standing-offer player with a simple chess strategy, `packages/cli/src/
    bot.ts`) refuses any chain but 31337 unless `--allow-real-chain` is passed. `pnpm dev:up --house-bots N`
    (default 2) starts, funds and tears down N of them, so a single fresh agent always has an opponent (§1
    success criterion 2). Both are dev-only (§13's mainnet gates): faucet must be disabled; house bots not run
    on mainnet.

### Plan 5.6 refinements (CLI distribution and agent funding, 2026-10-09)

See `docs/superpowers/specs/2026-10-09-cli-distribution-and-funding-design.md` for the full design; this is a
summary of what was actually built.

49. **Bundle and manifest.** `scripts/build-cli.ts [--out DIR] [--release]` bundles `packages/cli/src/bin-entry.ts`
    (and everything it imports — the SDK, viem, chess.js) with esbuild into one zero-runtime-dependency ESM file,
    `DIR/arena.mjs` (not minified, executable bit set, a `#!/usr/bin/env node` banner that gives bundled CJS
    dependencies a `require` via `createRequire`), copies the five board assets to `DIR/board/`, and writes a
    generated `DIR/package.json` (`name` from `ARENA_CLI_PACKAGE`, default `@arena/cli`; `version` from
    `packages/cli/package.json`; `bin`, `type: "module"`, `engines: {"node": ">=24"}`, `files`; no `dependencies`;
    `license`/`repository` from `ARENA_CLI_LICENSE`/`ARENA_CLI_REPOSITORY`, required by `--release`). `cliVersion()`
    and `selfCommand()` (`packages/cli/src/version.ts`) read `__ARENA_CLI_VERSION__`/`__ARENA_CLI_PACKAGE__`,
    substituted by esbuild's `define` in the bundle and undefined under `tsx`; `selfCommand()` is the exact
    `npx -y <package>@<version>` form the bundle uses to refer to itself (in `USAGE`, `owner set`'s printed
    command, and daemon-unreachable hints) — never the install hint for a *different*, host-required version.
    `arena --version` / `arena version` print the bare version and exit 0. `api.ts`'s `BOARD_DIR` (resolved from
    `import.meta.url`) is unchanged and correctly resolves `dist/board/` inside the bundle, and again through
    npm's `.bin/arena` symlink into `node_modules/@arena/cli/` after a real install (Review Focus 5; proven by the
    clean-room system test below).
50. **The host's `cli` pin and the `init` version gate.** An optional server config `cli: {package, version,
    minVersion?}` (validated: npm package-name syntax, plain `x.y.z` semver, `minVersion <= version`) is published
    on every `/templates` entry when configured, and — only when the raw config has no explicit `cliCommand` key —
    derives `cliCommand` as `npx -y <package>@<version>`. A host with `cli` configured serves a `/skill.md` whose
    recipe gains step 0, "Install" (`node --version` 24+, then the pinned `npx` command, with the sentence "use
    this exact pinned command for every step below; never @latest"); without `cli` the page, and `cliCommand`'s
    default of `arena`, are unchanged. `arena init` runs its version gate (`hostCliVerdict`) only after every
    other refusal -- the chain/hub/usdc/rules repoint check, the RPC pin, the code checks and the owner rules --
    and before anything is written (final fix wave, C1). Everything in `cli` comes from the host, so the gate first
    validates it locally: `package` against the server's own npm-name syntax (at most 214 characters), `version` and
    `minVersion` as strict `x.y.z` (and `minVersion <= version`); anything else is refused (exit 1) with a short
    description that never echoes the raw value. In the published bundle (`__ARENA_CLI_PACKAGE__` defined), a host
    whose `cli.package` differs from the build's own package is refused, naming only the validated name and no
    install command: a host may pin a version, never a different package. Then it compares its own `cliVersion()`
    with `compareSemver`: below `minVersion` (defaulting to `version` when unset) it refuses (exit 1), naming the
    required version and the exact install command for the (validated) package at the host's `version` (never this
    build's own, too-old, `selfCommand()`); below only `version` it still succeeds, with a `cliUpgrade` note in the
    summary; equal versions, or no `cli` at all, leave no `cliUpgrade` key. `skill.md`'s troubleshooting line says
    the only install command an agent may run is the one in step 0, and never one copied from an error that names
    a different package.
51. **`arena fund --games N --stake X [--deposit D]`, or `arena fund --offer <offerId> [--games N]`.** Reads
    `/templates`' chess entry (deposit cap, optional dev faucet) and the hub's live `feePerPlayer()`, and this
    wallet's USDC/native balances — no daemon needed. `deposit = D` when given (must satisfy `stake <= D <= cap`,
    else exit 1 with every amount, the cap included, in whole USDC), else `min(games × stake, cap)`. `--offer`
    (final fix wave, K1) takes `D` and `stake` from that open offer in the server's public `GET /offers` (decoded
    from its `$bigint` wire format); it excludes `--deposit`/`--stake`, adds `{offerId, stakePerGame}` to the
    output, and exits 1 with "offer <id> is not open any more; run offers again" when the offer is gone.
    `--games 0` and a zero `--stake` are usage errors (exit 2). `usdc.need = deposit + feePerPlayer`; `native.need = sessionGasWei + 500_000n ×
    feeCeilingWei` (`FUND_TX_GAS_UNITS`, one channel's dispute-gas reserve plus approve/deposit/close gas).
    `shortfall = max(0, need − have)` per asset. If anything is short and a faucet is advertised, it is called
    once (same origin pin, timeout and redirect refusal as `init`'s own auto-fund) and the balances re-read before
    printing. Output: `{address, chainId, deposit, feePerPlayer, usdc: {have, need, shortfall}, native: {have,
    need, shortfall}, owner, faucet?, message}` — `message` names the token, the exact USDC amount (6 decimals),
    the native amount rounded up to 4 places (`formatNativeCeil4`, never down), the address and the chain, plus a
    reminder to supply the owner address when none is recorded. Exit 0 whenever the arithmetic succeeds: a
    shortfall is data, not an error; exit 1 only if the server or the hub cannot be read at all (including a hub
    address with no contract code — never silently read as a zero fee).
52. **`arena wallet --wait-for-usdc A [--wait-for-native B] [--timeout S]`.** Polls both balances every 5 s
    (overridable for tests via the hidden `ARENA_WAIT_POLL_MS`, never below 200 ms) until every given threshold holds or `--timeout`
    (default 1800 s, max 3600 s) elapses, then prints `wallet`'s usual JSON plus `{reached, waitedSeconds}`. Exit
    0 once reached, 2 on an actual elapsed timeout, 1 on a read error — a bad value (a malformed amount, or a
    timeout outside `[1, 3600]`) is deliberately a plain error (exit 1), not the CLI's usual usage error (exit 2),
    so an agent that sees exit 2 here reads it only as "timed out," never as "malfunctioned" (Review Focus 2).
    Only a flag given with no value at all is a usage error (exit 2), per the Task 2 ruling. Plain `arena wallet` (no wait
    flag) is unchanged.
53. **The owner lock, amended after the Task 3 security review.** `owner` lives in `config.json`; `arena owner`
    reads `{owner}` (`null` if unset). The **first** set (`arena owner set <addr>` or `arena init --owner <addr>`)
    is free. A **change** needs the *current* owner's EIP-191 signature over a message binding the wallet, the
    chain, both owners and an `ownerNonce` (an integer, default 0, incremented on every change, so A→B→A can never
    replay an old signature) — the first design gated a change on an interactive terminal, dropped because
    `script`/`unbuffer`/`expect` can fake one in a single shell line, which did not meet "changing owner needs
    you." Without `--signature`, `owner set` prints `{messageToSign, signer, command}` and exits 1. The signature
    is verified **locally** by ECDSA recovery (`verifyOwnerSignature`), never through the RPC — a lying RPC's
    ERC-6492 check could otherwise forge any change, and a re-`init` may repoint `rpcUrl`; the cost is that a
    smart-contract owner can never be changed through the CLI, only by hand-editing `config.json` (the honesty
    note, below). The owner can never be the zero address, this wallet, the hub, the USDC token, the rules
    contract, or any session key this home holds (`forbiddenOwners`). **Re-running `init` keeps the owner and its
    nonce** (Review Focus 3): without `--owner` both are carried over verbatim; `--owner <other>` against a
    different recorded owner is refused (pointing at `owner set --signature`), while `--owner <same>` is a no-op,
    exit 0. Separately, **a re-`init` never repoints the money**: it refuses to change `chainId`, `hub`, `usdc` or
    `rules` on an existing home at all (withdraw to the owner and use a fresh `ARENA_HOME` instead), and changes
    `rpcUrl` only once every channel record is finalized (an unreadable record counts as open) — an RPC that hides
    a challenge can cost an open channel its funds, so the RPC is pinned while one is open; if the RPC itself dies
    with a channel open, the human's only recovery is hand-editing `rpcUrl` in `config.json` and restarting the
    daemon. `init` holds the home lock for its whole run (so a daemon can't open a channel between its checks and
    its write) and always checks that the hub, USDC and rules addresses hold code, even when every chain flag is
    explicit. **Honesty note:** this lock stops a confused or prompt-injected agent from redirecting funds through
    the CLI or the daemon API; it is not a defence against code that can read `wallet.json` or hand-edit
    `config.json` — which is also the human's only recovery when the owner can't sign (a smart-contract owner, or
    the dead-RPC case above). The agent must never hand-edit either file itself.
54. **`arena withdraw (--amount A | --all)`.** Requires a recorded owner (exit 1 otherwise, naming `owner set`);
    moves USDC only, never native, and takes **no destination** (`--to`, a bare address, or any other flag is a
    usage error). Always goes through the daemon's `SerialTxSender` — started in-process and stopped again if
    none is already running, under the home lock, exactly as `arena bot` does — because the daemon owns this
    wallet's one transaction-nonce sequence; a running daemon re-reads `owner` from `config.json` on every
    request, so a signed owner change needs no restart. **Review Focus 4:** refused with `409`, naming the
    channel, while any channel still awaits this wallet's own *deposit* (including one being matched, or a
    retried match), so a withdraw can never starve a deposit the daemon is about to make — retry once that
    channel is funded or its funding window has closed. `--all` sends `usdc − withdrawReserve()`, a named seam
    returning `0n` on every chain this daemon runs on today (gas here is native); **Plan 6 defines Arc's
    USDC-as-gas reserve** for both this and `fund`'s native line. Success means the transfer's receipt carries the
    USDC `Transfer(wallet → owner, amount)` log — never a balance delta, which a same-block inflow (or, on Arc,
    USDC gas) can skew either way; a token whose `transfer` returns `false` without reverting (a blocklisted
    recipient) is reported as a failure naming the tx hash. `usdcAfter` may be `null`, with a note, if the balance
    can't be re-read right after a confirmed send — the transfer itself is still a success. Output: `{to, amount,
    txHash, usdcAfter}`. Funds escrowed in open channels are not in the wallet; the over-balance error says to
    close them first. `HubClient.transfer` reuses `approve`'s own write path (`erc20Abi`'s `transfer`).
    `tests/system/cli-clean-room.test.ts` is the success-criterion-1 system test (spec §1): it builds, packs
    (`npm pack`) and installs (`npm install --offline`) the CLI tarball outside the repo, then runs this whole
    flow — `fund` → the human sends exactly what was asked → `wallet --wait-for-*` → `owner set` (and a refused
    change) → the installed daemon's `/board` (Review Focus 5) → a house bot's offer → games → close → `withdraw
    --all` — entirely through the installed binary for the agent and the house bot, with exact balances asserted
    on both sides.

### Plan 5.7 refinements (XMTP fallback transport, 2026-10-13)

See `docs/superpowers/specs/2026-10-13-xmtp-fallback-design.md` for the full design and
`docs/superpowers/plans/2026-10-13-xmtp-fallback.md` for the task breakdown. Items 55–59 were brought in line
with the code in Plan 5.7's final fix wave (2026-10-14), after the whole-branch review.

55. **`FallbackRelay` composes the host relay with XMTP; the chain stays the last resort.** A new `FallbackRelay`
    (`packages/cli/src/xmtp/fallback.ts`) implements the existing `RelayClient` (`join`/`send`/`onMessage`/
    `onJoined`/`leave`) by composing the host relay (`connectHost(...).relay`, which gains `isJoined(channelId)`
    and `onLinkChange(handler)`) with an `XmtpRelay` built on an `XmtpTransport` interface
    (`packages/cli/src/xmtp/transport.ts`). Daemon game logic is unchanged: messages from both transports are
    always accepted and fed to the same handlers, and duplicates are harmless (an exact duplicate of `latest` is
    already a no-op; the close-signature path is already idempotent). `send` goes via the host relay while it is
    up for that channel (socket open and channel joined); once the channel has not been up for
    `HOST_DOWN_GRACE_MS = 3000`, sends go via XMTP instead, holding briefly and retrying on `onLinkChange` or a
    timer otherwise; a send never throws to the daemon for a transport reason. A channel's XMTP side exists only
    once the daemon has seen it Open on chain (both deposits in) and armed it (`FallbackRelay.arm`, from the
    chain refresh) -- never at match time, since an accept costs nothing -- and at most `XMTP_MAX_CLIENTS = 64`
    channels per daemon are armed at once; until armed (or past the cap) a channel is the host relay's alone.
    `ChannelStatus` gains `transport: "relay" | "xmtp" | "none"` and `xmtpDropped`; the daemon start line gains
    `fallback: "xmtp" | "off"`, and its API `GET /fallback` (`{fallback, reason?}`). With
    `config.xmtp` absent, or the XMTP SDK failing to load, `run.ts` uses the host relay directly and behaviour is
    byte-for-byte identical to pre-Plan-5.7 (Global Constraint: every existing test passes unmodified).
56. **XMTP identity is the channel's own session key; acceptance drops known strangers and verifies everything
    else by signature, never by a lookup that can fail.** Each channel's session key (`params.signers[me]`) is
    its XMTP identity, and the opponent's session key (`params.signers[other]`) is who it expects to hear from —
    no discovery, and the raw session key never reaches XMTP code (I5): the client signs through the same
    `RelaySigner` the relay join already uses, and the per-channel XMTP database key is
    `keccak256(await signer.signMessage({ message: { raw: toHex("arena-xmtp-db/v1:" + channelId) } }))`, 32
    bytes, RFC-6979-deterministic so there is no new secret to store. The wire format is one XMTP text message
    per `RelayMessage`: `{"arena": 1, "msg": <RelayMessage wire JSON>}`, at most `XMTP_MAX_PAYLOAD_BYTES` (16
    KiB). Acceptance (amended 2026-10-14, commit `61d0246`, after three review rounds found liveness bugs in
    identity lookups that can fail): `open()` remembers the known opponent DM's conversation id(s) as a **fast
    path**, needing no lookup. Otherwise the sender is looked up. A **known stranger** (lookup succeeded, and
    the address or DM is definitely not the opponent's) is dropped and counted (`dropped(channelId)`) before it
    consumes any rate-limit budget. The opponent is identified only by verified member addresses, never by the
    recovery identifier (C-N1, fix round 5): a sender's inbox state is matched by its member identifiers alone
    (each added with its own signature), never by its recovery identifier, which any inbox can point at any
    address unsigned; the opponent's inbox id is set only by answers keyed by the opponent's own address (its
    DM found by address, and the network's inbox lookup), each replacing the stored one; and the DM found by
    the opponent's address, or any conversation whose peer is the opponent's inbox, is never denied. An **undetermined** sender (the lookup itself failed or timed out) is *not*
    held back — it is delivered to the session in arrival order, which verifies every state and close signature
    (`session.receive`/`session.receiveClose`) exactly as it already does for host-relay traffic, so a flaky
    lookup can never cost liveness. Every message, on every path, still passes the 16 KiB cap, `arena === 1`,
    the existing wire validators, XMTP-message-id dedupe, and the same per-channel inbound rate limit the host
    relay already enforces; a message that limit turns away is re-delivered by a catch-up of the opponent DM once
    the bucket refills, never by a stream restart. A session rejection of an undetermined-sender message is also counted in
    `dropped(channelId)`, but never sets `lastError` and is never logged per message, so a stranger flood during
    a lookup outage can't spam `status` (success criterion 3: a message from a sender **known** not to be the
    opponent is dropped before it reaches the session; a message whose sender **can't be determined** reaches
    the session, where nothing changes without the channel's own session-key signatures).
57. **Packaging keeps the SDK out of the published bundle.** The published CLI bundle stays zero-runtime-
    dependency; `@xmtp/node-sdk@6.1.0` (about 480 MB installed) is never bundled, only installed at runtime into
    `<home>/xmtp/sdk/node_modules/@xmtp/node-sdk` by `arena xmtp enable`
    (`npm install --prefix <home>/xmtp/sdk --no-audit --no-fund --save-exact @xmtp/node-sdk@6.1.0`), and loaded
    with a dynamic `import()` only when the directory is present and `config.xmtp` is set, once, at daemon start.
    6.1.0 (not 6.0.0) because its `Client.close()` releases a client: each is closed when its channel is finalized
    (its DB files then deleted) or the daemon stops. A missing, broken, or wrong-version SDK, or an invalid `xmtp`
    in `config.json`, is not a crash: the daemon logs once and runs with `fallback: "off"`, and
    `arena xmtp status` (which also reports what the running daemon loaded) and `arena bot` report and work around
    it respectively. This
    plan adds no new workspace dependency — the SDK lives only in a runtime home directory or a test fixture,
    never in the pnpm workspace (Global Constraints).
58. **Configuration flows from the server to `config.json`, never fetched at fallback time.** The server config
    gains optional `xmtp: {env: "local"|"dev"|"production", apiUrl?, gatewayHost?}` (the same shape as the CLI's
    `XmtpConfig`), published in `/templates` only when configured; `gatewayHost` is accepted with `env: "dev"` or
    `env: "production"`, refused with `env: "local"`. `init` copies it into `config.json` as `xmtp`, re-init updates it, and a server without
    `xmtp` removes it — because the site may be down exactly when the daemon needs this config, the daemon reads
    it from its own `config.json`, never from a live fetch. `dev:up --xmtp-local` publishes `xmtp: {env:"local",
    apiUrl}` backed by the pinned local-node fixture below.
59. **The host-paid gateway runs on separate infrastructure and is never exercised by tests.** The XMTP Gateway
    Service (`github.com/xmtp/xmtpd/pkg/gateway`, image pinned in `deploy/xmtp-gateway/docker-compose.yml`) holds
    a hot payer key, funded with USDC on Base through XMTP's Funding Portal, and pays XMTP's per-message fee on
    every agent's behalf so no agent needs its own funded wallet just to send messages. It must run on
    infrastructure separate from the website (an outage of `apps/server` must never also take down the
    fallback it's paying for). `deploy/xmtp-gateway/README.md` documents every `XMTPD_*` variable, the funding
    steps, the `WithAuthorizers` IP rate-limit hook (the prebuilt image ships with none), a ~$20 payer cap
    (≈400,000 messages at XMTP's published ~$5/100k-messages, 1 KB/90-day assumption), monitoring the payer
    balance, and the upgrade path to XMTP's (not-yet-shipped) client auth tokens. No test or CI job ever runs the
    gateway — it needs a real Base RPC and real funds — and the arena never runs it in tests. System tests
    instead run against `tests/system/xmtp-local/docker-compose.yml`, a copy of `xmtp/xmtp-local-node`'s compose
    file with every image pinned by `@sha256:` digest and host ports parameterized
    (`${XMTP_GRPC_PORT:-5555}`/`${XMTP_API_PORT:-5556}`/`${XMTP_HISTORY_PORT:-5558}`), brought up under a unique
    compose project name per run and always torn down with `down -v`, even on failure.

### Plan 6 refinements (Arc launch, 2026-10-24)

See `docs/superpowers/specs/2026-10-23-arc-launch-design.md` for the design and `docs/superpowers/arc-facts.md` for
the chain facts. Items 60–66 describe the code on `feat/arc-launch` after Tasks 1–3 and hardening wave H2; item 67,
hardening wave H3; item 68, hardening wave H4; item 69, the final fix wave's CLI part (B); item 70, the ECDSA-only
hub.

60. **Chain profiles.** `CHAIN_PROFILES` (`packages/cli/src/chains.ts`) is built into the CLI and keyed by chain id;
    nothing in it is ever taken from the host. Arc (5042) and Arc Testnet (5042002) each have `usdc`
    `0x3600…0000`, `nativeIsUsdc: true`, `minFeePerGas` 20 gwei and `feeCeilingWei` 40 gwei. The profile's ceiling
    is the wallet's default fee ceiling there (`feeCeilingOf`). A chain without a profile (anvil, 31337) behaves
    exactly as before.
61. **One balance and reserve gating.** On a `nativeIsUsdc` chain, USDC and gas are one balance:
    - `wallet` prints one `usdc`, the native balance (18 decimals) shown with 6, rounded down, and no `native`;
      `--wait-for-native` exits 1.
    - `fund` folds the gas into `usdc.need`, rounded up, and prints no `native` object. `usdc.need` also keeps one
      `sessionGasWei` for each of the home's channels that is not finalized, shown as `usdc.reserved`; `usdc.have`
      stays the whole balance.
    - `withdrawReserve()` = unsettled channels × `sessionGasWei` + 500,000 × the fee ceiling, rounded up.
      `withdraw --all` keeps it, so `usdcAfter` is not 0, and `withdraw --amount` never dips into it.
    - The other unsettled channels' reserve also gates every opening path (`createOffer`, `acceptOffer`, `fund()`'s
      top-up and deposit; `oneBalanceOpenNeed`), so a new channel never spends a live channel's refill money.
    - The default `sessionGasWei` is $4 \times 2{,}100{,}000 \times$ the profile's ceiling = 0.336 USDC (item 29).
62. **Fee floor.** `SerialTxSender` takes `minFeePerGas` from the profile, for the wallet and every session key.
    Every send and replacement has `maxFeePerGas` ≥ the floor and `maxPriorityFeePerGas` ≤ `maxFeePerGas`. The
    floor is applied after the balance clamp: a fee is raised to it, or the send is refused when the balance cannot
    pay it, never sent below it (Arc's mempool drops such a transaction silently). `init` refuses a
    `--fee-ceiling-wei` below the floor (item 22.4).
63. **Top-up gas and receipts.** A session-key top-up's gas limit is its `estimateGas` plus 20 % and 5,000 (a
    plain transfer costs 21,000 on Arc). A failed estimate sends nothing and raises `session-gas-low`. Every
    top-up checks its receipt: a reverted one never counts as a refill, raises `session-gas-low`, and backs off
    (item 37). Arc may give no receipt for a gas-consuming blocklist revert, so every receipt wait stays bounded
    (item 25), and a wait that times out must never be reported as success on the deposit, close, dispute, sweep
    or withdraw path (to be confirmed path by path: Arc launch spec §2.6).
64. **Pinned deployments.** On a chain with a profile, `init` always refuses a USDC other than the profile's and,
    once `KNOWN_DEPLOYMENTS` pins that chain, any other hub or rules, whether from `/templates` or from flags. The
    daemon re-checks the pin when it starts. Other chains keep item 31's warning. The entries for 5042 and 5042002
    are added after each deploy.
65. **Arc test subset.** `pnpm test:arc` (`scripts/test-arc.sh`) runs the contract suite, the SDK and CLI
    money-moving tests (deposit, close, dispute, sweep, top-up, withdraw) and the system dispute e2e against
    Arc Foundry's `arc-anvil --network arc`, pinned at `v0.8.0-2` with verified checksums (`tools/arc-foundry.md`).
    Each step uses its own port, but the subset must run alone: its SDK, CLI and system steps build into the same
    `contracts/out` as the standard suites (which stay on standard anvil), and two builds at once can fail (the race
    was reproduced in the Task 4 review; the ledger's ruling is to serialize it).
    `arc-anvil` answers a below-floor send with an error (`-32003`, at chain ids 31337 and 5042) instead of
    dropping it silently, so the silent drop itself is asserted at sender level.
66. **The agent journey on Arc (hardening wave H2, audit-journey).**
    - `fund`'s message on a profile chain names the network and its chain id, says the USDC must be sent on that
      network only, warns that USDC sent on Ethereum, Base or any other network will not arrive, and says how to
      get USDC there: Circle's CCTP bridge from another chain, or an exchange or wallet that supports Arc; Circle's
      faucet on Arc Testnet.
    - The owner must be an address the human controls on Arc: not an exchange deposit address unless that
      exchange supports USDC deposits on Arc, and not a smart wallet deployed only on another chain. `fund`'s
      owner question, `owner set`'s stderr note and `/skill.md` all say so.
    - `/skill.md` on 5042 and 5042002 uses only `usdc.*` and `--wait-for-usdc`; reads the profit and loss only
      once `status.swept` is set, or after a bounded wait and `arena sweep`, and counts the USDC spent on gas;
      confirms the amount, owner and network before `withdraw --all`; after about 30 minutes unmatched, tells its
      human but keeps waiting, and plays any late match, until the offer's `expiresAt` (30 minutes: the recipe
      posts `--ttl 1800`; there is no cancel) has passed; offers back, with `withdraw --all`, whatever arrived when a funding wait times out; and leaves
      funding to the human, on Arc only.
    - `buildStatus` takes optional `gasFunding` `{chainId, sessionGasWei, feeCeilingWei}`, which the daemon's
      `statusOf` passes (`cb142ea`). With it, on Arc,
      `session-gas-low`'s reason is shown in USDC and gwei, and its action asks for one channel's gas budget in
      USDC ($\text{sessionGasWei} + 500{,}000 \times \text{ceiling}$, 0.356 USDC by default).
    - `arena xmtp enable` removes the `.sdk-tmp-*` directory a killed earlier run left behind. `/skill.md` tells
      the agent to run it in the background and poll `arena xmtp status`.
67. **Rate-limit resilience (hardening wave H3, and its fix round 1).** Arc's public RPC answers a modest mix of
    reads with `-32005` "rate limit exceeded" (viem's `LimitExceededRpcError`, "Request exceeds defined limit.") or an
    HTTP 429. It refuses a query it will never serve with `-32012` "requested range too large" (Arc testnet rehearsal
    §8.1, §8.2).
    - **Error classes** (`packages/sdk/src/rpc.ts`). `isRateLimited` is checked first, so its words always win: the
      words "rate limit", "too many requests", "request limit", "max requests", "requests per", "per second", "rps",
      "throttl…", "quota", "compute units" or "capacity" anywhere in the cause chain; an HTTP 429; a JSON-RPC code
      429 or `-32007`; or `-32005`, unless its words are a refusal. `isRangeRefusal` is never true while
      `isRateLimited` is. Otherwise it is `-32012`, viem's `ResponseBodyTooLargeError`, or the RPC's words for a
      block range, result count or response size over its limit (a bare "exceeds max" is not one: "exceeds max
      requests per second" is a rate limit). Only a refusal splits a range or counts toward a skip, in the indexer
      and in the daemon's dispute scan (item 18). Any other failure ends that poll or pass, uncounted and unprobed,
      and the next one reads the same range. Why: under load the RPC refuses at random, and a skip on that would hide
      a dispute event. H1's probes stay the second gate: a probe that is refused too stops the poll or pass, uncounted.
    - **Transport.** Every RPC client (`LocalKeyTxSender`, the daemon's, the server's `RpcChainReader`) uses
      `rpcTransport`: viem's `http` retry classes, retried after 0.5, 1, 2, 4 and 8 s, with a `Retry-After` honoured
      up to 4 s per retry. Under a rate limit (fast answers) a read waits at most 15.5 s in all, 20 s with
      `Retry-After`. On an RPC that does not answer, the timeout is retried too:
      - The daemon's client caps each request's **total** time at 20 s (`DAEMON_RPC_TOTAL_TIMEOUT_MS`, the transport's
        `totalTimeoutMs`), attempts at 5 s (`DAEMON_RPC_TIMEOUT_MS`). An attempt in flight at the deadline is
        abandoned, no retry starts whose wait would end past it, and the last error is thrown, so a rate limit stays a
        rate limit. A respond makes 11 requests one after another before its send (counted on the real path by
        `h3-ratelimit.test.ts`), and the send is one attempt of at most 10 s: 11 × 20 s + 10 s = 230 s, inside
        `autoReturnSecondsOf` (300 s at the 900 s default window). The session key's tracker adds reads to that count:
        up to two per hash it still tracks (each replacement adds a hash), a receipt read and, for a released entry
        with fees, a transaction read (`prune`, `knowsAny`). Arc's tracker is normally empty at a respond.
      - The server's and `LocalKeyTxSender`'s own clients keep viem's retries and its 10 s: about 75 s per read.
      A send is never retried: viem issues `eth_sendRawTransaction` with `retryCount: 0`, and the capped transport
      excludes the send methods by name. A `SerialTxSender` send answered "nonce too low" whose own hash cannot be read
      (a rate-limited check) is kept at its nonce with that hash, released, on every path (a fresh send, a replacement
      of a released entry, the wait's own replacement), and never re-sent at the next nonce. Every path checks a
      request's `notAfter` right before it transmits: `waitOrReplace` sets it to its `giveUpAt` on a replacement, and a
      respond sets it to its give-up time plus 15 s (`RESPOND_SEND_MARGIN_MS`; 3 s before final fix wave B, m-6), so a
      respond whose reads end well past its deadline is not broadcast (it could only revert). The give-up time is never
      earlier than the last moment a block could still take the respond (it is computed from the latest block's
      timestamp, which is not ahead of the chain's clock). The margin is wide because the costs are lopsided: a respond
      held back that would have landed forfeits the game, one sent too late costs about 0.008 USDC of gas. It covers
      Arc's 1 s timestamps, a proposer clock running ahead, and this machine's wall clock stepping forward by up to
      15 s between the read and the send (both times are `Date.now()`).
    - **CLI one-shot calls** (`rpcCall`: `init`, `wallet`, `fund`). An HTTP 429 or 5xx, or a JSON-RPC rate limit, is
      retried after 1, 2, 4 and 8 s. One that persists fails with "the RPC is rate-limiting: … wait a minute, then
      retry the command".
    - **Action routes** (`/move`, `/resign`, `/accept-draw`, `/next-game`, `/close`, `/challenge`, `/reclaim`,
      `/handoff`). An action that took effect answers 200 even when the chain read for the status it returns fails:
      the last known status, with `chainStale: true` and `chainStaleReason` (e.g. "the RPC is rate-limiting (HTTP
      429)"). The CLI prints a note. Took effect includes a Close that is signed and relayed whose on-chain submission
      failed on anything but the hub's refusal (the watchtower retries it), and a challenge or reclaim mined with no
      readable receipt (`chainStaleReason` says so, and that whether it succeeded is not known yet). A failed action
      still errors. A rate limit that outlasts the retries is a 503: "the RPC is rate-limiting (<the RPC's answer>):
      wait a few seconds, then retry", or "rate-limited (RPC or host) (…)" when no RPC error is in the chain (the
      host's own 429).
    - **Sweep attribution.** A sweep whose receipt wait fails other than with a typed `Tx*Error` (a rate-limited
      receipt read), or whose send fails ambiguously (a lost response), throws `SweepWaitError` with the sweep's own
      hashes. They are kept in `pendingTx` and `sweepPending`, and the attempt is not charged. The next attempt
      records the landed sweep (`swept: true` and a `sweeps` entry), never `"dust"`.
    - **Session-gas check.** After a failed read of a session key's balance, the check waits 5 s, doubling to 60 s,
      before it reads again. A read that succeeds ends the back-off. A refill is at most 60 s late because of it.
    - Tips are unchanged: a key tips `eth_maxPriorityFeePerGas` (5 gwei on Arc Testnet in the rehearsal), within the
      profile's floor and ceiling.
68. **The agent journey after the first live run (hardening wave H4).** Three unprimed Claude agents onboarded from
    `/skill.md` on Arc testnet, had their human pay them, played 11 games and cashed out
    (`.superpowers/sdd/2026-10-23-arc-launch/live-run-report.md`). Five frictions are fixed:
    - **`fund` leads with what to tell the human.** No agent put the ask in its own reply: each ran `fund`, then went
      straight to `wallet --wait-for-usdc`, and a human sees only the agent's replies. `fund`'s JSON now starts with
      `tellYourHuman`: "Tell your human now, in your own reply, word for word, before you run wallet
      --wait-for-usdc (they cannot see this command's output): " (the wait clause only when something is short),
      then `disclosure`, then `message`. `disclosure` comes second. Every earlier field is unchanged, and `message`
      is still the sentence the live-run human watcher parses.
    - **The human hears what they fund before paying.** `disclosure` is a few sentences: the network (on Arc, whether
      it is mainnet or a test network), the hub address, the host's `/templates` `audit` text (quoted as the host's
      words, folded onto one line, Unicode format characters such as bidi overrides removed (fix round 1, M6), at
      most 300 characters, or "Its host publishes no audit statement."), the per-player deposit cap as the host's
      own figure ("The host says each player may deposit at most …", M6), the hub's fee per player per channel, and
      that withdrawals go only to the owner
      (named once recorded). `/skill.md` step 4 tells the agent to write `tellYourHuman` into its reply before any
      wait, and to remind the human of the missing amount after each wait that returns `reached: false`. The
      report after about 30 minutes, and the offer of `withdraw --all` for what did arrive, are unchanged.
    - **`arena daemon --detach`.** The daemon died with the agent's tool session, once mid-game with a channel open.
      `--detach` refuses, spawning nothing, when the home has no `config.json`. It re-runs the same CLI directly
      (`<node> <node flags> <entry script> daemon`, never a wrapper or `npx`) as a detached child in its own session
      and process group, stdin closed, stdout and stderr appended to `ARENA_HOME/daemon.log`. It waits up to
      `--timeout` (default 60 s, 1–600) for the child's own start line, its pid in `daemon.lock` and its `/health`,
      then prints `{detached: true, healthy: true, pid, api, log}` (exit 0). Fix round 1:
      - **A lock-holding child is never stopped (I1).** `ArenaDaemon.start()` arms its dispute timer before the chain
        reads that make a start slow, so at the deadline a child that holds the lock is reported `{detached: true,
        healthy: false, …, hint}` (exit 0) and left running. Only a child that exits (an error with the log's last
        lines) or never takes the lock (stopped by its own pid: SIGTERM, SIGKILL after 10 s) fails.
      - **A live lock holder is named, never looped on (I2, M1; fix round 2, N3).** Before spawning, and when the
        child loses the lock to another daemon (two `--detach` at once), the holder is asked who it is through its own
        API, until the deadline (see the next bullet). This home's `arena daemon` prints `{alreadyRunning: true,
        healthy: true, pid, api, log}` (exit 0). A lock pid that never answers -- starting, stuck, or a reused pid --
        exits 1 "not answering" (check `channels` in a minute, then tell the human, with the pid and the log); a bot,
        a withdraw, or an answer that is not the lock's writer exit 1 with what to do. No lock is called stale while
        its pid lives.
      - **Its limit (M8).** A new session and process group survive a process-group kill and a terminal hangup, not
        the teardown of a systemd scope (logind `KillUserProcesses=yes`), a per-command PID namespace or cgroup, or a
        container stop. The next live run checks survival under its own sandbox.
      `/skill.md` step 2 starts the daemon this way, says not to use the tool's background-task feature or
      `nohup … &`, and says what to do on each outcome. Setup keeps the restart loop for a human. Every "cannot reach
      the daemon" hint says `start it with "<cli> daemon --detach"` and, if it keeps stopping, to read the end of
      `daemon.log` (M2). `init` on a home a daemon holds says to skip init if the home is set up, and names
      `daemon stop` for a re-init (I3, M4).
    - **Lock identity, with no clock (fix round 2, N1, N3).** `acquireHomeLock` writes `{pid, nonce}` with a fresh
      random nonce per acquisition. Asked `GET /health` with the home's bearer token, the daemon's API answers
      `{ok, pid, lock: <nonce>, role: daemon|bot|withdraw}`; without the token, `{ok}` as before. A holder is "this
      home's daemon" only when that pid and nonce are the lock's (never for an older CLI's nonce-less lock: item 69).
      This replaces fix round 1's start-time-versus-lock-mtime check, which broke on the `ps` path (a start time
      derived from `Date.now()` compared for equality, so `stop` never worked off Linux) and under wall-clock steps
      (a live daemon called a reused pid). `/proc` or `ps` now only shows a stopped process go. A home with port 0
      (tests only) cannot be asked.
    - **`arena daemon stop [--timeout S] [--yes-i-understand]`.** `stop` SIGTERMs the pid that `daemon.lock` names
      only after the daemon's API confirmed it is that pid with that nonce and role `daemon`, in the same call, and
      again right before the signal. A lock pid that does not answer is never signalled: wait, retry, then tell the
      human (pid, log). `stop` refuses while any channel record is not `finalized`, whatever its phase (N2): `None`
      may have our deposit in flight, `Funding` opens by itself on the opponent's deposit, and a deposit past its
      funding deadline needs this daemon to reclaim it; a retired record is finalized, so it never blocks. The
      refusal does not print the override (m2). `--yes-i-understand`, documented in the README for a human only,
      overrides that check alone. `stop` waits up to 60 s by default for the process to exit, then prints
      `{stopped: true, pid}`. `/skill.md`: a restart is `daemon stop`, then
      `daemon --detach`; if `stop` refuses, keep the running daemon and tell the human (m3). Step 8 ends the recipe
      with `daemon stop` once every channel is settled -- `Finalized`, `Reclaimed`, or a suggested action starting
      with `done:`, which includes a retired channel (m4; "a", not "the first": a host refusal can be listed before
      it, final review C m-15) -- and swept, any offer the agent posted has expired (M5), and
      the withdraw is done, and says overriding a refusal is the human's decision. skill.md never names the flag.
    - **Offers are picked at random among equals.** Two concurrent agents took the same first-listed offer; the
      loser got `offer … not found` after its money arrived. `/skill.md` step 3 says to pick at random among the
      offers that fit equally well. Step 5 and Troubleshooting say a lost race needs no new money: re-list, pick
      another, and ask for more only if that `fund --offer` shows a shortfall. The CLI has no auto-pick path.
    - **The took-effect note.** `/skill.md` Troubleshooting quotes H3's CLI note (`note: <action> took effect, but
      the chain could not be read afterwards`) and says the action did take effect and is never sent again. H3's
      code is unchanged.
69. **Final fix wave, the CLI (B; `.superpowers/sdd/2026-10-23-arc-launch/final-review-b.md`).**
    - **An unconfirmed withdraw is never answered "retry" (I-1).** `withdraw()` diffs the wallet sender's tracked
      hashes around `hub.transfer`, as the sweep does. A failure after the send that is none of the four typed wait
      errors (a rate-limited or timed-out receipt read, a 5xx) is a 502 naming what was sent, never H3's 503 "wait a
      few seconds, then retry". Every 502 or 503 of an unconfirmed withdraw carries its hashes, as the API body's
      `hashes` and in the message ("check the owner's balance, an explorer or `<cli> wallet` before retrying: a retry
      can pay the owner twice"). It is recorded in `<home>/withdraw-pending.json`, and the next withdraw, through the
      same daemon or a fresh in-process one, resolves it from the chain before it reads the balance:
      - one of its transactions mined with the `Transfer` to the owner: it landed. That withdraw is refused (409,
        "the owner has been paid, so nothing was sent now"), the record cleared, and the next one goes ahead;
      - each mined without that `Transfer`, or never mined while another transaction took its nonce: none can pay.
        Cleared, and the withdraw goes ahead. "Another took its nonce" is concluded only after the receipt is read once
        more, after the nonce count: it may be this very transfer, mined during the reads (re-review n-1);
      - mined with its receipt unreadable: refused (409) whatever its age (re-review n-2), since its nonce is used and a
        send would be a second transfer. The message has the agent tell its human, who checks it on an explorer and,
        if it did not pay, removes the record;
      - otherwise (pending, or unknown with its nonce free): refused (409) until `WITHDRAW_UNCONFIRMED_HOLD_MS`
        (10 minutes) after it was sent, then cleared and sent. The send replaces a transfer still pending at its
        nonce wherever the RPC's pending count shows it; on one that does not, a fresh in-process daemon past the
        hold sends at the next nonce (the residual).
      A check whose read fails is a 503: nothing is sent.
    - **No message tells the agent to edit `config.json` (I-2).** `start()`'s refusal of a config naming contracts this
      CLI does not pin is addressed to the human: "Tell your human: this daemon's config names contracts the CLI does
      not pin for chain N … they decide what happens next". It says the agent never edits `config.json` and starts no
      new home while a channel is unsettled, and that the release that set the home up can still settle and withdraw;
      restoring the pinned addresses would read the channels on the wrong hub and retire them. `init`'s and `owner`'s
      "fix or remove it first" on an unreadable `config.json`, and `owner set`'s hand-edit lines, are the human's step.
    - **`init` refuses an Arc chain no release pins yet (m-10).** With `requirePin` (`init` only, never `start()`, so
      no home is stranded), `pinnedDeploymentRefusals` refuses a `nativeIsUsdc` profile chain with no
      `KNOWN_DEPLOYMENTS` entry: a CLI published before Task 6 never takes the mainnet hub a hostile `/templates`
      names. The test-only override is `UNPINNED_INIT_ALLOWED_FOR_TESTS`, a module-level set that no flag, environment
      variable or file writes.
    - **The respond margin is 15 s (m-6):** item 67.
    - **Lock identity (m-1, m-2).** A lock with no nonce is never confirmed (any listener can echo a pid), and a
      confirmed answer must name a role. An answer that waiting does not change -- a 200 without identity, a
      nonce-less lock -- is a `definite` silence: `--detach` and `stop` exit 1 at once, telling the agent to tell its
      human, where `--detach` used to wait out its timeout. The README says how a human stops such a daemon by hand.
    - **`stop` and the channels no daemon watches (m-4, m-11).** A record that cannot be read counts as live for
      `stop`, as for `init`'s RPC check. The authenticated `/health` lists the channels the daemon does not watch
      (`degraded`), and `stop`'s refusal names degraded and unreadable records apart: not watched by any daemon,
      `close` cannot settle them, tell your human. Three counts of "not settled" remain, each erring safe: `fund`
      counts degraded records (it asks for more), the daemon's reserve does not, and `stop` counts degraded and
      unreadable ones (it refuses more often).
    - **Status and notes (m-3, m-5, m-7).** The lobby refusal's "restart this daemon" is not shown for a finalized
      record, so a retired channel's first action stays `done:`. It, the 503 on offer and accept, and the withdraw 409
      restart the daemon only once no channel is live, and otherwise say to tell the human (`stop` refuses while one
      is). A challenge or reclaim mined with its receipt unreadable carries `unconfirmed` in its status; the CLI then
      prints `note: <cmd> was mined, but whether it succeeded is not known yet (…): run "<cli> status" to check`, not
      the took-effect note.
    - **Smaller (m-8, m-9, m-12).** A close the wallet cannot pay for, or whose fee is over its ceiling, says so in
      `lastError` (`close()` still answers 200). `handleUnseenRegistered` re-reads the session's latest turn after its
      awaits, so a turn a relay delivered meanwhile is not raised as `challenge-unseen`. The daemon's 20 s request cap
      leaves a `Retry-After` 5 attempts and 16 s of waiting. A respond still pending at its give-up time
      (`TxStuckError`), which a send inside the 15 s margin can be on Arc before the next block, gets the same phase
      re-check as a revert or a drop, so one that landed is not reported "stuck".
    - **Live run #2's frictions (its (f)1-3).**
      - A funding pass resumed after its approve and session-key top-up (a rate limit stopped the deposit) needs only
        what is still to be spent. `fund()` records the gas those two paid, from their receipts
        (`ChannelRecord.fundingGasPaid`, on disk), and `oneBalanceOpenNeed` credits it, rounded up and capped at the
        wallet-gas term it came out of. So `fund`'s ask always covers a resumed pass, and the human is never asked
        again for gas already spent (0.002189 USDC in the run). An approve or top-up whose receipt could not be read,
        or that reverted, is not credited.
      - `fund` keeps its ask (`<home>/fund-ask.json`) when something is short. A `wallet --wait-for-usdc` for exactly
        that `usdc.need` says first, on stderr and while nothing has arrived, "Your human must see this -- if you
        have not written it in your reply, stop and do that now, word for word (they cannot see this command's
        output): <disclosure> <message>". A timed-out result leads with it as `tellYourHuman`. It is never repeated
        once the wait is met, nor for another amount.
      - `offers` prints the open offers in a fresh `node:crypto` random order on every call, and says so on stderr:
        "take the first one that fits". The daemon's `GET /offers` is unchanged.
70. **ECDSA-only signatures (final review A I-1, owner decision 2026-10-25; `aa5ddfc`, `aeed9dc`).** Signatures are
    verified with ECDSA only (OpenZeppelin `ECDSA.tryRecover`: 65 bytes, v 27 or 28, low s), with no ERC-1271
    fallback. A signer whose code accepts any bytes, such as a contract or an EIP-7702-delegated session key, could
    otherwise put unverifiable signatures in a proof. A delegated key's own ECDSA signatures still verify against its
    address, and gaining code cannot revoke them. The SDK's `recoverStateSigner`/`recoverCloseSigner` accept only the
    same form, because viem alone also recovers a high-s twin and v 0/1, so a session never stores a signature the
    hub refuses. §4.3 says the same. Arc testnet runs this hub since redeploy #2 (`ed5862a`: ChannelHub
    `0x3D8434455E4258a877a327De3B1201f94A558d38`, ChessRules `0xD3C7eA363A4d734d85abcB243B8D3135746C14Ba`, pinned in
    `KNOWN_DEPLOYMENTS[5042002]`); `init` refuses the superseded hub with the ERC-1271 fallback (`0x9b8B…bA41`), as it
    refuses the pre-hardening one.
71. **Reads under a rate-limited RPC, and the board (owner report 2026-10-29: "in the take over … rpc limit … run arena
    board again and again to move").** `GET /status` and `GET /channels` refreshed the chain first and failed with
    item 67's 503 when that read failed, so a rate-limited RPC left the board unable to show the human's own move, the
    opponent's reply, or the game at all, although these are the daemon's own session state. A reload to recover lost
    the in-memory token (final fix wave M1), hence a new `arena board` link each time.
    - **Reads answer the last known view.** A chain refresh that fails with anything but a `DaemonError` (as
      `statusAfterAction` already treated it) answers `{ ...status, chainStale: true, chainStaleReason }`: the position,
      turn, legal moves, balances and signatures are current; `phase`, `challenge`, `cooldown` and the attention and
      actions they drive are from the last read. `channels()` does this per channel, so one failure no longer fails the
      list. Once a read is rate-limited, or its one block read fails, the channels not yet refreshed are served stale for
      that reason without further reads. `statusAfterAction` is now `status` plus `unconfirmed`. A failed refresh writes
      no `lastError` and logs nothing; `l.chain` keeps its last view.
    - **Nothing that acts trusts it.** The watchtower's passes, `respondIfChallenged`, `settleCheck` and `wait()` read the
      chain or `statusOf` themselves and never call `status()`/`channels()`. The bot does not challenge on a
      `chainStale` status; it still moves and co-signs. skill.md says the same to agents: play on, never `challenge` or
      `reclaim` on a stale status. The CLI prints a read's note for `status` and `channels`.
    - **The board.** A `chainStale` answer, or a background read answered with the rate-limit 503, raises one calm
      banner ("The chain RPC is busy …", `role="status"`) instead of a "Could not refresh" toast per poll. Each route's
      own fresh answer clears its part. Moves stay enabled. While a session is live, `beforeunload` asks before a reload
      or a closed tab, but not for the reload a newly pasted link triggers. The token stays in memory only.
    - **Fix round 1 (`board-review.md`).**
      - **A stale view suggests no dispute step (I1).** `buildStatus` with `stale` drops every `arena challenge` and
        `arena reclaim` suggestion, ends with `arena status   (the chain view is stale: re-check before any challenge)`,
        and sets `humanAttention` to null. The board's Challenge button and its hint follow from the suggestions.
        `attention` stays, and `wait()` never builds from a stale view. Its countdowns (`challenge.secondsLeft`,
        `cooldown`) run on by the view's age; silence never does (m1). `chainReadAt` says when the view was read.
      - **Read-route cache and back-off (I2).** The board polled `GET /status` about once a second, and each poll
        re-read the view the watchtower had read one pass earlier: +44% on one daemon's RPC rate, measured.
        - `status()` and `channels()` serve a view under `CHAIN_VIEW_MAX_AGE_MS` (5 s) old without a read.
          `ChannelHandle.chainReadAt` is stamped by every full `refreshChain`, whoever calls it.
        - After a read-route read is rate-limited, they answer stale with no read for `READ_BACKOFF_MS` (10 s).
          The back-off is daemon-wide, and any successful `refreshChain` ends it.
        - `statusAfterAction` always skips the cache. It honours the back-off except after `/challenge`,
          `/reclaim` and `/close` (`chainWrite`).
        - In `channels()`, each channel is checked against the cache, then the back-off, then read. The shared block
          read is made only when a channel needs one. Any read failure stops the reads for the rest of the list (m2).
        - A transaction this daemon sends for a channel drops its cached view (`chainWritten`). That covers
          `challenge()`, `reclaim()`, a respond and the close submission. Otherwise a bot that just challenged would be
          told "Open, silent" for up to 5 s.
        - A view is not fresh once the session has progressed since it was read (`progressKeyOf` ≠ `progressKey`).
          Progress is observed only at a read (`lastProgressAt`), and silence is judged on it.
        - The watchtower's passes, `respondIfChallenged`, `settleCheck`, auto-return, withdraw and `wait()` never
          read the cache nor honour the back-off.
      - **A non-RPC refresh failure is logged once (m3).** It is still answered stale.

## 13. Guarded mainnet launch (decided 2026-09-26)

The owner chose to launch directly on Arc mainnet, with no Arc Testnet phase and no external audit first. The §11 audit
and legal gates are accepted risks. They are not preconditions. To keep a contract defect's damage bounded, the hub gets
on-chain launch limits, and the §8 test campaign is extended (Plan 4.5) before the web board (Plan 5).

1. **Per-channel deposit cap.**
   - `maxDepositPerPlayer` is set by the owner and checked when a channel is created. A first `deposit` whose
     `params.deposit` exceeds it reverts with `DepositTooLarge`.
   - The cap can be raised or lowered at any time. A change affects only channels created afterwards.
2. **Total commitment cap.**
   - The hub tracks `committedEscrow`. When a channel is created it adds `2 · (deposit + feePerPlayer)`, reserving
     both sides at once, so the second deposit is never blocked by the cap.
   - It subtracts the same amount when the channel finalizes or is reclaimed.
   - Creating a channel that would push `committedEscrow` above the owner-set `maxCommittedEscrow` reverts with
     `EscrowCapReached`.
   - Lowering the cap below the current commitment only stops new channels.
   - An unfunded channel's reservation cannot outlive `MAX_FUNDING_WINDOW` (a constant, 1 day): `_validateNewParams`
     reverts `InvalidParams` if `params.fundingDeadline > block.timestamp + MAX_FUNDING_WINDOW`. Without this
     bound, a self-dealing attacker could set `fundingDeadline` far in the future, fund only their own side,
     and hold that reservation against `maxCommittedEscrow` indefinitely, since `reclaim` is only callable
     after the deadline passes. With the bound, a half-funded channel's reservation is always reclaimable
     within one day. Squatting is not free: the squatter locks its own side (`deposit + feePerPlayer`) for the
     window.
   - The worse case is not bounded by the window: a self-dealing channel funded on **both** sides and left Open
     holds its reservation indefinitely. It costs the squatter the reservation's capital, locked, plus
     2 · `feePerPlayer` per channel. The owner's response is the same as for any other capacity pressure: raise
     `maxCommittedEscrow`. Monitor `committedEscrow` against real game activity.
3. **Pause.**
   - `setPaused(bool)` (owner) blocks every `deposit`: new channels and second-side funding alike.
   - It never blocks `reclaim`, `closeCooperative`, `challenge`, `respond`, `timeout` or `claim`. Every open channel
     can always settle, and a half-funded channel is refunded by `reclaim` after its funding deadline.
4. **Admin surface.** The owner (a multisig on mainnet) can change only fees, the two caps and the pause flag. None of
   these touch deposits or existing channels, and the hub stays non-upgradeable. §9 "Admin abuse" is extended
   accordingly. The worst an owner can do is refuse new business, with one side effect: a pause blocks the second
   deposit too, so a player who funded first stays locked until the channel's `fundingDeadline` (at most 1 day
   on-chain, at most 2 hours through an honest host) and then reclaims. The owner must never renounce ownership:
   renouncing while paused freezes new business forever (funds are unaffected).
5. **Off-chain mirrors.**
   - `HubClient` reads the limits.
   - Daemons mirror all three limits in `createOffer` and `acceptOffer`, before anything is posted or signed: the
     pause (409), `maxDepositPerPlayer` (400), and the escrow cap, `committedEscrow + 2 · (deposit + feePerPlayer) ≤
     maxCommittedEscrow` with the hub's current fee (409). At match time they re-check the pause and the per-player
     cap and ignore a match that fails; the commitment is left to the hub, and a deposit it refuses backs off for
     30 s of chain time.
   - The host lobby refuses such offers.
   - `/templates` publishes the current limits and the pause flag.
6. **Launch values.** The launch values are deployment parameters, not constants. Suggested starting points:
   `maxDepositPerPlayer` = 10 USDC and `maxCommittedEscrow` = 1,000 USDC, raised as operating history accumulates.
