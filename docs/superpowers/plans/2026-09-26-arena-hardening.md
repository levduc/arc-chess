# Arena Hardening & Test Campaign Implementation Plan (Plan 4.5)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prepare the arena for a guarded direct-to-mainnet launch. There are two parts:
- the on-chain launch limits from spec §13, mirrored off-chain;
- a test campaign covering contract security, every dispute path end-to-end, adversarial and chaos conditions, load and soak, and live LLM-agent games.

**Architecture:**
- Contracts: ChannelHub gains launch limits (a deposit cap, a commitment cap and a deposit-only pause). Foundry test depth grows with a deep profile, Slither and a second fuzzer (Echidna).
- System tests: a reusable process harness starts Anvil, deploys, then starts the real server and real `arena daemon` child processes. The dispute, adversarial, chaos, load and LLM suites all run on top of it.
- Plan 5's `pnpm dev:up` moves into this plan, since the harness needs it.

**Tech Stack:** Foundry (Solidity 0.8.28, via_ir); Slither (uvx), Echidna (pinned release binary); TypeScript (Node ≥ 24, tsx, vitest 5.0.1); fast-check 4.10.0; viem 2.56.8; the Claude Code CLI (`claude -p`) for the LLM games.

**Spec:** `docs/superpowers/specs/2026-09-24-agent-chess-arena-design.md`. This plan covers:
- the new §13 (guarded mainnet launch);
- the §8 testing items 1–4 and 7, deepened;
- the §1 success criteria 2 (LLM agents play from `skill.md`), 5 (force-move without trusting the host) and 6 (multiple channels).

It also carries these parked items: M6 (relay spoofing is documented as display-only), M11 (lock pid reuse), M15 (dispute-scan RPC load) and the I5 residual (a minimum funding window).

## Global Constraints

- Exact pins:
  - viem 2.56.8 (never 2.56.9); ws 8.21.3; tsx 4.23.15; typescript 6.0.3; vitest 5.0.1; @types/node 25.9.8.
  - fast-check 4.10.0: released 2026-09-11. Do not take 4.10.1 or 4.10.2 unless pnpm's release-age gate accepts them.
- **Never bypass pnpm's minimumReleaseAge gate.** If a pin is refused, stop and report.
- Python tools run through `uvx` with a pinned version (`uvx --from slither-analyzer==<ver> slither`). No global pip installs.
- Echidna comes as a pinned GitHub release binary, downloaded into `tools/bin/` (gitignored) by a script. It is never added to the system PATH.
- Contract rules:
  - the contracts stay non-upgradeable;
  - the owner can never move deposits or change existing channels;
  - exits (reclaim, closeCooperative, challenge, respond, timeout, claim) can never be paused.
- The protocol rules in spec §12 stay intact: the equivocation guard, Close only on terminal states, no signing after Close, NEW_GAME needs both signatures, and the daemon re-validates everything.
- Tests never weaken existing assertions. A failing new test means the product is wrong until proven otherwise. Every product fix gets a regression test.
- Ports:
  - Anvil 8546 belongs to the test suites.
  - A user demo stack is running: Anvil on :8545, server on :8080, daemons on :7071/:7072. Never touch it.
  - System-test harnesses use ephemeral ports and their own Anvil ports (8600–8699 range, picked per run).
- Long-running suites (deep fuzz, soak, LLM games) sit behind explicit scripts and never run inside `pnpm test:*`. A short CI version of each is in the default suites wherever the task says so.
- Commit trailer: `Co-Authored-By: <model> <noreply@anthropic.com>`.
- Style: 2 spaces, double quotes, 120 columns, comments only for non-obvious whys. Solidity follows the existing contracts' style.

## Review Focus

1. **The owner lowers caps or pauses while channels are mid-game.** Expected:
   - every open channel still closes, disputes and times out;
   - a half-funded channel is refunded by reclaim;
   - `committedEscrow` returns to zero after everything settles.
2. **A daemon or agent tries an offer above the cap.** Expected: a clear refusal before any funds move, never a funded-then-stuck channel.
3. **The opponent disappears mid-game over the real server.** Expected: the honest daemon challenges and wins by timeout with no human step, and the balances are exact.
4. **A malicious relay tampers with or replays messages.** Expected: no daemon signs or funds anything unsafe, and funds settle correctly on-chain.
5. **A daemon is killed with -9 at any point, or the RPC flaps.** Expected: after restart it resumes and settles, with no equivocation and no lost funds.

---

## File Structure

- `contracts/src/ChannelHub.sol` (modify): launch limits.
- `contracts/script/Deploy.s.sol` (modify): new constructor args (env).
- `contracts/test/ChannelHub.limits.t.sol` (new).
- `contracts/test/helpers/HubHandler.sol` and `contracts/test/ChannelHub.invariant.t.sol` (modify): broader actions and invariants.
- `contracts/foundry.toml` (modify): a `[profile.deep]` profile.
- `contracts/echidna/` (new): the Echidna property harness and config.
- `scripts/tools/echidna.sh` (new): pinned download plus run.
- `packages/sdk/src/hub.ts` (modify): `limits()`; `abi.ts` regenerated.
- `packages/sdk/test/helpers/chain.ts` (modify): `deployArena` passes limits.
- `packages/sdk/test/model.test.ts` (new): fast-check model-based session tests.
- `packages/cli/src/daemon.ts` (modify): limit checks.
- `apps/server/src/lobby.ts`, `apps/server/src/server.ts`, `apps/server/src/chain.ts`, `apps/server/src/docs.ts` (modify): limit checks, `/templates` fields.
- `scripts/dev-up.ts` (new): `pnpm dev:up`.
- `tests/system/` (new package `@arena/system-tests`), holding:
  - `harness.ts`: Anvil, deploy, server and daemon processes;
  - `bot.ts`: random-move and scripted players;
  - `mitm.ts`: the malicious relay proxy;
  - `faultyRpc.ts`;
  - `dispute.test.ts`, `adversarial.test.ts`, `chaos.test.ts`, `load.test.ts`;
  - `soak.ts`, `llm-games.ts`.

---

### Task 1: ChannelHub launch limits (spec §13)

**Files:**
- Modify: `contracts/src/ChannelHub.sol`, `contracts/script/Deploy.s.sol`, `contracts/README.md`, `packages/sdk/src/abi.ts` (regenerated with `pnpm --filter @arena/sdk abi`), `packages/sdk/src/hub.ts`, `packages/sdk/test/helpers/chain.ts`.
- Test: `contracts/test/ChannelHub.limits.t.sol`, `packages/sdk/test/lifecycle.test.ts`.

**Interfaces:**
- Produces (Solidity):
  - `uint256 public maxDepositPerPlayer;`
  - `uint256 public maxCommittedEscrow;`
  - `uint256 public committedEscrow;`
  - `bool public paused;`
  - `function setLimits(uint256 maxDepositPerPlayer_, uint256 maxCommittedEscrow_) external onlyOwner;`
  - `function setPaused(bool paused_) external onlyOwner;`
  - errors `DepositTooLarge()`, `EscrowCapReached()`, `Paused()`;
  - events `LimitsUpdated(uint256 maxDepositPerPlayer, uint256 maxCommittedEscrow)` and `PausedSet(bool paused)`.
  - The constructor gains `maxDepositPerPlayer_` and `maxCommittedEscrow_` after the existing args.
- Produces (SDK): `HubClient.limits(): Promise<{ maxDepositPerPlayer: bigint; maxCommittedEscrow: bigint; committedEscrow: bigint; paused: boolean }>`.
- `deployArena()` in the SDK test helpers passes `maxDepositPerPlayer = 10_000_000` and `maxCommittedEscrow = 10**12`. These are generous, so existing tests are unaffected.

Behavior (exact):
- `deposit`:
  - If `paused`, revert `Paused()` first, for creation and second-side funding alike.
  - On creation, after `_validateNewParams`:
    - revert `DepositTooLarge()` if `p.deposit > maxDepositPerPlayer`;
    - compute `commit = 2 * (p.deposit + p.feePerPlayer)`;
    - revert `EscrowCapReached()` if `committedEscrow + commit > maxCommittedEscrow`;
    - otherwise add `commit` to `committedEscrow`.
- `_finalize` and `reclaim`: subtract `2 * (p.deposit + p.feePerPlayer)` from `committedEscrow`.
- Setters emit their events. `setLimits` accepts any values, including values below the current commitment.

- [ ] **Step 1: Write failing Foundry tests** in `ChannelHub.limits.t.sol`. Use `HubFixture` and extend it for the new constructor args. Cover:
  - deposit == cap succeeds and deposit == cap+1 reverts `DepositTooLarge`;
  - commitment accounting across create → fund → close, create → reclaim, and create → fund → challenge → timeout, returning to 0 each time;
  - the cap is checked at creation only (the second deposit succeeds even after `setLimits` lowered the cap below the current commitment);
  - `EscrowCapReached` at the exact boundary;
  - pause blocks creation and second-side funding;
  - under pause, reclaim, closeCooperative, challenge, respond, timeout and claim all still work (one test each);
  - only the owner can call `setLimits`/`setPaused`, and events are emitted;
  - a fuzz test: for random deposit/fee/cap values, `committedEscrow` equals the sum over unsettled channels.
- [ ] **Step 2: Run to verify they fail.** `cd contracts && forge test --match-path test/ChannelHub.limits.t.sol` → compile errors or failures.
- [ ] **Step 3: Implement** in `ChannelHub.sol`. Keep CEI and the existing slither annotations.
  - Update `Deploy.s.sol` to read `ARENA_MAX_DEPOSIT_PER_PLAYER` (default 10_000_000 = 10 USDC) and `ARENA_MAX_COMMITTED_ESCROW` (default 1_000_000_000 = 1,000 USDC).
  - Update every existing test fixture that constructs the hub.
- [ ] **Step 4: Run all contract tests.** `pnpm test:contracts` → all pass. The count is 115 plus the new tests.
- [ ] **Step 5: SDK.**
  - Regenerate `abi.ts`.
  - Add `HubClient.limits()`.
  - Update `deployArena` for the new constructor args.
  - Add a lifecycle test that reads the limits and checks that `committedEscrow` rises on deposit.
  - Run `pnpm test:sdk` and the typecheck.
- [ ] **Step 6: Run the CLI and server suites.** They must be unaffected, because `deployArena` uses generous limits.
- [ ] **Step 7: Commit.**

### Task 2: Off-chain mirrors of the limits (daemon, server, CLI)

**Files:**
- Modify: `packages/cli/src/daemon.ts`, `apps/server/src/chain.ts`, `apps/server/src/lobby.ts`, `apps/server/src/server.ts`, `apps/server/src/docs.ts`, `apps/server/README.md`.
- Tests: `packages/cli/test/hardening.test.ts`, `apps/server/test/lobby.test.ts`, `apps/server/test/foundation.test.ts`.

**Interfaces:**
- Consumes: `HubClient.limits()`.
- Produces: `ChainReader.limits()` (cached for ≤ 5 s). `/templates` entries gain `limits: { maxDepositPerPlayer, maxCommittedEscrow, committedEscrow, paused }` as decimal strings and a boolean.

Behavior:
- Daemon:
  - `createOffer` rejects with `DaemonError(400, "deposit exceeds the hub's per-player cap of <n>")` when over the cap, and with `DaemonError(409, "the hub is paused: no new channels")` when paused.
  - `acceptOffer` applies the same checks against the offer's deposit, before signing anything.
  - `onMatch` re-checks and ignores a match the hub would reject, and logs it.
  - A funding revert with `Paused`/`DepositTooLarge`/`EscrowCapReached` becomes a clear `lastError`, and the watchtower does not retry funding in a hot loop: a back-off of at least 30 s per channel.
- Server lobby:
  - `post` rejects with 400 when over the cap, and with 409 when paused;
  - `accept` rejects with 409 when paused;
  - `accept` rejects with 409 when accepting would exceed the commitment cap. Include the reserved amount of matches that are not yet funded; a best-effort check against `committedEscrow` is acceptable.
- `skill.md` explains the limits in one short paragraph, and `status` of an affected channel names the cause.

- [ ] **Step 1: Write the failing tests.**
  - Daemon (Anvil):
    - `setLimits` to a small cap, then `createOffer` above it rejects;
    - `acceptOffer` of an over-cap offer rejects without creating a record;
    - pause, then `createOffer` rejects;
    - pause after match and before funding: `lastError` names Paused, and after unpause funding completes.
  - Server (FakeChain with limits): post/accept rejections, and the `/templates` limits fields.
- [ ] **Step 2: Run to verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the CLI and server suites and both typechecks.**
- [ ] **Step 5: Commit.**

### Task 3: Deeper contract invariants and fuzzing

**Files:**
- Modify: `contracts/test/helpers/HubHandler.sol`, `contracts/test/ChannelHub.invariant.t.sol`, `contracts/foundry.toml`, root `package.json` (script `test:contracts:deep`).
- Create: `contracts/test/helpers/BlockingToken.sol`, a MockUSDC variant that can blocklist a recipient.

Requirements:
- The handler gains these actions:
  - challenge with a random supported state (opening, a checkpoint, or a mid-game move built with `ChessTestUtils`/the rules);
  - respond;
  - timeout after `vm.warp`;
  - closeCooperative on terminal states;
  - claim;
  - owner `setFee`, `setLimits` and `setPaused` toggles;
  - blocklisting and unblocklisting a participant on the BlockingToken, so `owed` paths run;
  - multiple player pairs, so channels interleave.
- Invariants, each its own `invariant_` function:
  1. The hub's token balance equals the ghost sum of unsettled escrow plus the ghost sum of `owed`.
  2. `committedEscrow` equals the ghost sum of `2·(deposit+fee)` over channels in Funding, Open or Challenged.
  3. The registered `turnNum` never decreases per channel. Track it in a ghost mapping, updated on every action.
  4. A Finalized or Reclaimed channel never changes phase again, and its payout happens exactly once: ghost counters of Finalized/Reclaimed events per id are ≤ 1.
  5. For every finalized channel, participant payouts plus owed equal `2·deposit`, and the fee recipient's receipts equal `2·fee`.
  6. Paused never blocks an exit. The handler attempts exits while paused and asserts that they do not revert with `Paused`.
  7. `feePerPlayer ≤ maxFeePerPlayer` always.
- Add `[profile.deep]` with invariant runs 1000, depth 200, fuzz runs 20000. Add the script `"test:contracts:deep": "pnpm vectors && FOUNDRY_PROFILE=deep forge test --root contracts"`.
- The default profile keeps runs low enough that `pnpm test:contracts` finishes in under 2 minutes.

- [ ] Steps:
  1. Write the handler actions and the invariants.
  2. Run the default profile.
  3. Run the deep profile once and record the time and result in the report.
  4. Fix any product bug found, with a regression unit test.
  5. Commit.

### Task 4: Static analysis, a second fuzzer, gas budgets

**Files:**
- Create: `contracts/echidna/HubProperties.sol`, `contracts/echidna/echidna.yaml`, `scripts/tools/echidna.sh`, `scripts/tools/slither.sh`, `contracts/test/Gas.t.sol`.
- Modify: `.gitignore` (`tools/bin/`), `contracts/README.md`, root `package.json` (scripts `analyze:slither`, `fuzz:echidna`).

Requirements:
- Slither:
  - `scripts/tools/slither.sh` runs `uvx --from slither-analyzer==<pinned latest stable> slither contracts --filter-paths "lib/|test/|script/|echidna/"`.
  - The result must have zero High or Medium findings. Each Low or Informational finding on the new code is fixed, or annotated with a justification in the existing style.
  - Paste the final summary into the report.
- Echidna:
  - `scripts/tools/echidna.sh` downloads a pinned echidna release for linux x86_64 into `tools/bin/`, verifies its sha256 (record the checksum in the script) and runs it.
  - `HubProperties.sol` restates invariants 1, 2, 4 and 7 from Task 3 as `echidna_*` properties over a self-contained harness: deploys MockUSDC and the hub, and drives deposit, fund, reclaim, close-opening, challenge and timeout actions.
  - Run 50k calls and record the result.
  - If the pinned binary cannot run on this machine (glibc and so on), try the next newer release once. If that also fails, record it in the report and continue, since Task 3's deep Foundry fuzzing is the fallback.
- Gas budgets:
  - `Gas.t.sol` measures `validTransition` for a worst-case `CLAIM_STALEMATE` position and the full `challenge`/`respond` paths.
  - It asserts each stays under 30% of a 30M block gas limit.
  - It reports actual numbers with `console.log`.

- [ ] Steps:
  1. Scripts.
  2. Run Slither and fix or annotate.
  3. Echidna harness and run.
  4. Gas test.
  5. `pnpm test:contracts`.
  6. Commit.

### Task 5: ChessRules extended differential and robustness fuzzing

**Files:**
- Modify: the vectors generator in `tools/vectors` (find it through the root `vectors` script) and `contracts/test/ChessDifferential.t.sol`.
- Create: `contracts/test/ChessFuzz.t.sol`.

Requirements:
- The generator gains a `--deep` mode: 20,000 random games plus curated edge cases. The edge cases cover:
  - underpromotion to each piece, with and without capture;
  - castling rights lost by a rook capture;
  - en passant that exposes a check along the rank;
  - double check;
  - stalemate with pinned pieces;
  - insufficient material;
  - the 50-move boundary at halfmove 99 and 100;
  - MAX_PLY 299 and 300, including mate on the limit.
- The default (CI) vector set is unchanged in size.
- `pnpm vectors:deep` writes to a separate directory, which `test:contracts:deep` consumes.
- `ChessFuzz.t.sol`: for random `(board, meta, move)` from fuzz inputs, `validTransition` either returns a result or reverts only with the documented errors. It never panics (no arithmetic or array panics). Use `vm.expectRevert`-free try/catch and assert the revert selector set.
- Mismatches found: fix the Solidity or TS rules side, add a curated regression vector, and report it.

- [ ] Steps:
  1. Generator deep mode and curated cases.
  2. Differential run.
  3. Robustness fuzz.
  4. Fix any bugs with regressions.
  5. Commit.

### Task 6: SDK model-based property tests (fast-check)

**Files:**
- Modify: `packages/sdk/package.json` (devDependency `fast-check` 4.10.0).
- Create: `packages/sdk/test/model.test.ts`.

Requirements:
- A fast-check model runs two `ChannelSession`s (MemoryStore) exchanging messages over a simulated network that can drop, duplicate, reorder and delay messages.
- Each session is driven by a random honest policy that picks from these actions:
  - a legal move, possibly with offerDraw;
  - resign;
  - acceptDraw when offered;
  - proposeNewGame and countersign;
  - signClose on terminal states;
  - crash and restore from the stored snapshot (`ChannelSession.restore`/`open`);
  - re-send the latest state (as a reconnect would).
- Safety properties, checked after every step:
  - a session never signs two different states for the same `(channelId, turnNum)`: keep a global log of every signature produced, keyed by the signer;
  - `balanceA + balanceB == 2·deposit` for every signed state;
  - a Close signature exists only for terminal states, and no state signature is produced after that session signed Close;
  - `latest.turnNum` never decreases in a session;
  - `challengeProof()` always yields a proof the on-chain rules would accept. Check the proof structure with the SDK's own `successor`/hash checks (no chain);
  - once both close signatures exist, `closeTransaction()` is non-null, and it is identical on both sides.
- Liveness property: with a network that eventually delivers (no drops after step k), both sessions converge to the same `latest` hash, or to a state where the pending actions are clear (one side's turn).
- `numRuns`: 200 in CI (under 60 s) and 5000 under `MODEL_RUNS=5000`.
- Any counterexample is shrunk and turned into a named deterministic regression test in `session.test.ts`, and the session bug is fixed.

- [ ] Steps:
  1. Install the pin.
  2. Model and properties.
  3. Run.
  4. Fix and add regressions.
  5. `pnpm test:sdk` and the typecheck.
  6. Commit.

### Task 7: `pnpm dev:up` and the system-test process harness

**Files:**
- Create:
  - `scripts/dev-up.ts`;
  - `tests/system/package.json` (`@arena/system-tests`, private; deps: workspace sdk, cli, server, and viem, tsx, vitest pins);
  - `tests/system/tsconfig.json`, `tests/system/vitest.config.ts`;
  - `tests/system/harness.ts`, `tests/system/bot.ts`, `tests/system/harness.test.ts`.
- Modify: `pnpm-workspace.yaml` (add `tests/*`), root `package.json` (`dev:up`, `test:system`), and the root README, or `apps/server/README.md` if there is no root README.

Requirements:
- **`pnpm dev:up [--port 8080] [--anvil-port 8545] [--players 2]`:**
  - starts Anvil on the given port;
  - deploys with `Deploy.s.sol` through `forge script`;
  - writes the server config to `.arena-dev/server.json` (gitignored) and starts the server;
  - for each player, creates an ARENA_HOME under `.arena-dev/players/<name>` with an Anvil key, mints 100 USDC, runs `arena init --server`, and prints the exact commands to start their daemons.
  - It keeps running and tears everything down on Ctrl-C.
  - If a requested port is in use, it refuses with a clear message and never kills other processes.
- **`harness.ts`:**

  ```ts
  export type Stack = {
    rpcUrl: string; chainId: number; hub: Address; usdc: Address; rules: Address; host: Address;
    serverUrl: string; server: ChildProcess; anvil: ChildProcess;
    player(name: string, key?: Hex): Promise<Player>;   // init home + mint + start `arena daemon` child process
    restartServer(): Promise<void>;                      // same db file
    setLimits(maxDeposit: bigint, maxCommitted: bigint): Promise<void>;
    setPaused(p: boolean): Promise<void>;
    increaseTime(seconds: number): Promise<void>;
    stop(): Promise<void>;
  };
  export type Player = {
    name: string; home: string; address: Address; apiUrl: string; token: string;
    api(method: "GET" | "POST", path: string, body?: object): Promise<any>; // talks to the daemon's local API
    kill(signal?: NodeJS.Signals): Promise<void>; start(): Promise<void>; // process control (SIGKILL supported)
    logs(): string;
  };
  export async function startStack(opts?: { anvilPort?: number; serverOverrides?: object; blockTime?: number }): Promise<Stack>;
  ```

  - Anvil ports are picked from 8600–8699 with a bind check.
  - Every child process is killed in `stop()`, including after a test failure (use `afterEach`).
- **`bot.ts`:** `playRandomGame(white: Player, black: Player, opts)`, `playLine(...)`, and `waitStatus(player, predicate, ms)`. Everything goes through the daemon HTTP API, the same surface an agent uses.
- **`harness.test.ts`** is a smoke test: start the stack, open a channel between two process daemons, play one scholar's mate, close, and assert balances.
- `test:system` runs `tests/system` with `fileParallelism: false`.

- [ ] Steps:
  1. The harness and smoke test first (TDD on the smoke test).
  2. `dev:up`, checked by running it with `--port 0`-style ephemeral ports for about 10 s in a test or by hand, then Ctrl-C.
  3. Docs.
  4. Commit.

### Task 8: Dispute paths end-to-end over the real server (spec §8.7)

**Files:** Create: `tests/system/dispute.test.ts`.

Scenarios. Each is its own test on a fresh stack. Use `challengeTimeout` = 60 (the hub minimum) and `increaseTime` to keep them fast.
1. **Opponent disappears → timeout forfeit.**
   - Mid-game, SIGKILL Bob while it is his move.
   - Alice's agent runs `challenge`, time passes the deadline, and Alice's watchtower calls `timeout`.
   - Assert: Alice's on-chain balance gains the stake, the phase is Finalized, and there was no human step beyond the one `challenge` call.
2. **Stale challenge → auto-respond → play resumes off-chain.** Bob challenges with an older state. The harness can provide it: stop Bob's daemon, use the SDK directly with Bob's session key from his home, and submit a proof of an earlier state. Assert:
   - Alice's watchtower responds automatically;
   - the phase returns to Open;
   - both continue playing off-chain, and the game completes and closes.
3. **Challenge that needs a real move.** Alice challenges while it is Bob's turn. Bob's agent sees `challenge.mustMove`, moves, and the daemon submits it through `respond`. Play resumes.
4. **Cooldown.** After (3), Alice challenges again inside the cooldown. The daemon API returns an error mentioning cooldown, and there is no on-chain transaction.
5. **Unfunded channel → reclaim.** Alice offers and Bob accepts, then Bob is killed before funding. Past `fundingDeadline`, Alice's watchtower reclaims automatically, and her balance is restored, including the fee.
6. **One daemon, two channels at once.** Alice plays Bob and Carol concurrently with random bots, and both channels close with exact balances.
7. **Restart in the middle of a dispute.** Alice challenges, then Alice's daemon is SIGKILLed and restarted before the deadline. Bob answers, and Alice's restarted watchtower adopts the `Responded` state. Play resumes.
8. **Challenge on a new-game checkpoint.** After game 0, Alice proposes the next game and Bob goes silent. Alice challenges on the checkpoint, and the timeout forfeits Bob's stake for game 1 as spec §4.6 says.
9. **Pause and caps during play.** With a channel mid-game:
   - the owner pauses and lowers the caps;
   - the game continues, closes and settles;
   - a new offer is refused with the paused message;
   - `committedEscrow` returns to 0.

- [ ] Steps:
  1. Write each scenario.
  2. Run them. A failure is a product bug until proven otherwise: fix it in the right component, with a unit regression.
  3. Commit (one commit per product fix plus the test file).

### Task 9: Adversarial suites (malicious relay, malicious peer)

**Files:** Create: `tests/system/mitm.ts`, `tests/system/peer.ts`, `tests/system/adversarial.test.ts`.

Requirements:
- **`mitm.ts`** is an HTTP and WebSocket proxy between the daemons and the real server. The daemons' `serverUrl` points at the proxy. It has pluggable tamper hooks per frame and request:
  - modify a field of a match event (deposit, signer, participant, feeRecipient, fundingDeadline, salt);
  - swap participant order;
  - drop, duplicate, reorder or delay frames;
  - replay old relay states;
  - inject a forged state or close message with a random signature;
  - inject a close for a non-terminal state;
  - rewrite `/templates` (the hub address) for init.
- **Adversarial relay tests.** Each asserts that no unsafe funding or signing happened. Check the on-chain Deposited events, the daemon's session snapshot signatures, and final balances:
  1. For each tampered match field: no deposit happens, and the daemon logs the reason.
  2. Drop, duplicate and reorder over a whole game: the game still completes and closes, possibly after reconnects.
  3. Replayed old states: no `lastError` storm, and they are treated as stale.
  4. A forged state or close: rejected, with no signature produced in response.
  5. A tampered `/templates` at init: `init` fails its RPC code/chainId verification, or shows the tampered value in its trust output (assert which one).
- **`peer.ts`** is a malicious opponent built directly on the SDK with its own session key. It joins the real relay (it is a real channel member after a real match) and can:
  - send an equivocating second state for the same turn;
  - send an illegal move signed correctly;
  - withhold its countersignature on NEW_GAME;
  - send close signatures for the wrong state;
  - spam valid-but-stale states;
  - challenge repeatedly (griefing).
- **Malicious peer tests.** The honest daemon:
  - never signs a conflicting state;
  - surfaces `opponent-silent` or a challenge suggestion;
  - wins by challenge and timeout where the peer stalls;
  - holds its balance exactly per the protocol.
  - Griefing challenges are throttled by the on-chain cooldown.

- [ ] Steps:
  1. Proxy and peer.
  2. Tests.
  3. Fix product bugs with regressions.
  4. Commit.

### Task 10: Chaos (crash at any point, RPC faults, reorgs, server restarts)

**Files:** Create: `tests/system/faultyRpc.ts`, `tests/system/chaos.test.ts`.

Requirements:
- **`faultyRpc.ts`** is a JSON-RPC proxy in front of Anvil with a configurable probability of each of:
  - connection errors;
  - HTTP 500;
  - timeouts (delay beyond the client timeout);
  - `getLogs` range errors ("query exceeds max block range" when the range is > N);
  - lagging heads (it reports a block number whose logs are not yet served).
- The daemons use the proxy's URL. The server uses it too, in one test.
- **Crash-at-any-point.** A seeded test loop over K = 12 kill points spread across one game plus close:
  - after offer, after match, mid-funding, after each of several moves, after proposing a new game, after signing Close, while challenged;
  - at each point, SIGKILL one daemon at random and restart it;
  - assert the channel finishes and settles with exact balances;
  - assert no equivocation: the peer never saw two signed states for the same turn from the restarted daemon (use the server relay cache and the peer's session log).
  - The seed is logged, and a failing seed reproduces.
- **RPC fault test.** A full game plus a dispute (challenge → respond) runs at a 20% fault rate and a 2000-block `getLogs` cap. It completes. The watchtower keeps handling the dispute despite errors.
- **Reorg test.** Use `anvil_reorg` (supported by the pinned anvil) on the stack's own Anvil only:
  - after a `Challenged` event, reorg it out and re-include it;
  - after a deposit, reorg depth 2.
  - Assert that daemons and the indexer converge, which exercises the 32-block rescan windows.
- **Server restart.** Restart the server (same DB file) mid-game and at the moment of a match. Games resume, and the match is replayed.

- [ ] Steps:
  1. Proxy.
  2. Chaos tests.
  3. Fix product bugs with regressions.
  4. Commit.

### Task 11: Load and soak

**Files:** Create: `tests/system/load.test.ts`, `tests/system/soak.ts`. Modify: root `package.json` (`soak`).

Requirements:
- `load.test.ts` (CI, under 3 min): 6 daemons, 9 channels at once (each daemon in 3), random-move bots with a ply cap, then close. Assert:
  - all channels settle with conserving balances: the sum of changes equals −fees;
  - server metrics show every connection closed at the end;
  - no relay message is lost, meaning no channel needed a challenge.
- `soak.ts` (manual, `pnpm soak --minutes 30 --daemons 10 --channels 30`):
  - loops create → play random games → next-game → close continuously;
  - every 30 s it samples daemon and server RSS and open file descriptors (`/proc/<pid>/status` and `fd`), plus `/metrics`;
  - it writes `soak-report.json` and fails if RSS grows by more than 50% after warm-up, or if any channel stalls longer than 2 minutes.
- Run the soak once for 15 minutes and put the summary in the report.

- [ ] Steps:
  1. Load test.
  2. Soak script.
  3. The 15-minute run.
  4. Fix leaks found, with regression tests where feasible.
  5. Commit.

### Task 12: Live LLM-agent games from `skill.md` alone (success criterion 2)

**Files:** Create: `tests/system/llm-games.ts`, `tests/system/LLM-GAMES.md` (the report template). Modify: root `package.json` (`llm-games`).

Requirements:
- `pnpm llm-games --agents 2 --games 2 [--model <id>]` does the following:
  - starts a stack (Task 7);
  - funds two fresh wallets;
  - launches two headless Claude Code sessions with `claude -p` through `child_process`. Each session:
    - has its own `ARENA_HOME` and working directory;
    - has `--permission-mode` or allowed tools restricted to Bash for the arena CLI plus WebFetch/curl to the local server;
    - gets only the prompt: "Read <serverUrl>/skill.md and play chess against another agent. Play <games> games, then close the channel. Your wallet key is in ARENA_HOME already." Pre-init the homes so the agents only need `arena daemon`.
  - streams each session's output to `.arena-dev/llm/<name>.log`;
  - has a hard wall-clock limit (default 30 min) and kills everything on timeout.
- **Pass criteria:**
  - a channel opened between the two agents' wallets;
  - at least 1 game completed;
  - the channel reached Finalized with conserving balances.
- Afterwards, record in `LLM-GAMES.md`:
  - the result (pass or fail) and the durations;
  - games played;
  - notable agent confusions, quoted from the logs;
  - `skill.md` wording fixes made.
- Apply any `skill.md` improvements the run shows are needed (it is a product surface), then run again once.
- This task spends the user's Claude usage. Run it at most 3 times in total, and record the cost if the CLI reports it.

- [ ] Steps:
  1. Script.
  2. First run.
  3. `skill.md` fixes.
  4. Second run.
  5. Write the report.
  6. Commit.
