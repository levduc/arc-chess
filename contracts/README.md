# Arena contracts

On-chain half of the Agent Chess Arena (spec: `docs/superpowers/specs/2026-09-24-agent-chess-arena-design.md`).

- `ChannelHub` — escrow, EIP-712 signature checks (ECDSA + ERC-1271), force-move disputes, fee payout.
- `IGameRules` — game template interface. `ChessRules` — chess template.
- `ChessBoard` / `ChessMoves` — packed encoding and legality (see the encodings below).

## Commands

    pnpm vectors                 # generate chess.js differential vectors (needed by forge test)
    pnpm test:contracts          # vectors + full forge test suite
    pnpm analyze:slither         # Slither static analysis on src/ (scripts/tools/slither.sh)
    pnpm fuzz:echidna            # Echidna property fuzzing on ChannelHub (scripts/tools/echidna.sh)
    forge script script/Deploy.s.sol --rpc-url <rpc> --broadcast --private-key <key>

`pnpm analyze:slither` runs Slither (via `uvx`, pinned in the script) against `contracts/src/`, excluding
`lib/`, `test/`, `script/` and `echidna/`. Pass bar: zero High or Medium findings on `src/` (excluding
`src/dev/`, which is dev-only and never deployed); Low/Informational findings on new code are fixed or
annotated with `slither-disable-next-line <detector>` and a justification, matching the existing style in
ChannelHub.sol. It requires `forge` on PATH (crytic-compile's Foundry integration shells out to it).

`pnpm fuzz:echidna` runs Echidna (downloaded and sha256-verified into the gitignored `tools/bin/` on first
use) against `contracts/echidna/HubProperties.sol`, a self-contained harness (it deploys its own MockUSDC,
ChessRules and ChannelHub) that restates invariants 1, 2, 4 and 7 of `ChannelHub.invariant.t.sol` as
`echidna_*` properties over `deposit`/`fund`/`reclaim`/close-on-opening/`challenge`/`respond`/`timeout`
actions. It is a second, coverage-guided opinion alongside Task 3's deep Foundry invariant/fuzz suite, not a
replacement for it — Echidna has no `vm.sign`/`vm.prank`/`vm.warp` equivalent, so the harness stands in with
mock ERC-1271 "always valid" signers and forwarder "wallet" contracts instead of real signatures and sender
impersonation. It requires `forge` on PATH; the script itself writes a repo-local, pinned `crytic-compile`
wrapper into the gitignored `tools/bin/` (which runs it via `uvx` on demand) rather than installing anything
globally.

Deploy env: `ARENA_OWNER`, `ARENA_FEE_RECIPIENT`, `ARENA_TOKEN` (required on every chain except the local
chain 31337, where MockUSDC is deployed if it is unset; elsewhere the script reverts without it),
`ARENA_FEE_PER_PLAYER` (default 5000 = $0.005), `ARENA_MAX_FEE_PER_PLAYER` (default 1000000),
`ARENA_MAX_DEPOSIT_PER_PLAYER` (default 10000000 = 10 USDC), `ARENA_MAX_COMMITTED_ESCROW` (default
1000000000 = 1,000 USDC). The last two are the spec §13 launch limits (see "Admin surface" below); they are
deployment parameters, not constants, and the owner is expected to raise them as operating history
accumulates.
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
- The hub is to launch directly on Arc mainnet, with no prior testnet phase and no external audit first
  (spec §13, decided 2026-09-26), an accepted risk. To bound a contract defect's damage, the owner-set launch limits
  (`maxDepositPerPlayer`, `maxCommittedEscrow`, `paused`) cap exposure while operating history accumulates;
  see "Admin surface" below for what they do and do not let the owner do.

## Admin surface (spec §13)

The owner (a multisig on mainnet) can change only fees, the two caps and the pause flag. None of these touch
deposits or existing channels, and the hub stays non-upgradeable:

- `setFee(feePerPlayer, feeRecipient)` — the fee snapshotted into channels created from now on.
- `setLimits(maxDepositPerPlayer, maxCommittedEscrow)` — the per-channel deposit cap and the hub-wide
  commitment cap, both checked only at channel creation. Lowering either affects only channels created
  afterwards; the second deposit into an already-created channel is never blocked by them, and `setLimits`
  accepts any values, including a cap below the current `committedEscrow`.
  - `maxDepositPerPlayer`: a first `deposit` whose `params.deposit` exceeds it reverts `DepositTooLarge`.
  - `maxCommittedEscrow`: `committedEscrow` tracks `2 * (deposit + feePerPlayer)` per unsettled channel
    (reserving both sides at once, so the second deposit is never blocked by the cap), added at creation and
    subtracted at `_finalize`/`reclaim`. Creation that would push it over the cap reverts `EscrowCapReached`.
- `setPaused(bool)` — blocks every `deposit` (new channels and second-side funding alike) while set. It never
  blocks `reclaim`, `closeCooperative`, `challenge`, `respond`, `timeout` or `claim`: every open channel can
  always settle, and a half-funded channel is still refunded by `reclaim` after its funding deadline.

The worst an owner (or a compromised owner key) can do is refuse new business; it can never move escrowed
funds, alter an existing channel's terms, or block an exit. One side effect of the pause: it blocks the second
deposit too, so a player who has already funded a new channel stays locked until that channel's `fundingDeadline`
(at most `MAX_FUNDING_WINDOW`, 1 day, on-chain; at most 2 hours through an honest host) and then reclaims.

**Ownership cannot be renounced** (audit M2): `renounceOwnership` is overridden to always revert with
`RenounceDisabled`, for every caller. Renouncing while paused would freeze new business forever: funds would be
unaffected, but the hub could never be unpaused or have its caps raised again. Ownership moves only through
Ownable2Step's `transferOwnership` and the new owner's `acceptOwnership`.

**Residual risk: first-come squatting of `maxCommittedEscrow`.** `params.fundingDeadline` is bounded to at
most `block.timestamp + MAX_FUNDING_WINDOW` (a constant, 1 day) by `_validateNewParams` — without this, a
self-dealing attacker could set an unbounded deadline, fund only their own side, and hold that reservation
against the cap forever, since `reclaim` only becomes callable after the deadline passes. With the bound, any such
half-funded reservation is reclaimable (by anyone) within one day. It is not free: the squatter locks its own side
(`deposit + feePerPlayer`) for that window. The worse case is not bounded by the window: a self-dealing channel
funded on **both** sides and left Open holds its reservation indefinitely, at a cost of the reservation's capital
(locked) plus `2 * feePerPlayer` per channel. The owner's response to this, as to any other capacity pressure, is to
raise `maxCommittedEscrow`; monitor `committedEscrow` against real game activity.

## External entry points and Circle CLI

Every state-changing entry point takes flat arguments or a single ABI-encoded `bytes` payload
(`deposit(bytes)`, `closeCooperative(bytes)`, `challenge(bytes)`, `respond(bytes)`, `timeout(bytes32)`,
`reclaim(bytes32)`, `claim(address)`), so it can be called with `circle wallet execute`. The Arc spike
(spec §10 step 0) must confirm `circle wallet execute` accepts a `bytes` argument.
