# Agent Onboarding: one sentence to play (Plan 5.5)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The user opens any fresh Claude Code session on this machine and types:

> Go to http://127.0.0.1:8080 and use your money to play 10 $1 games with whoever is available.

The agent then completes the whole job from `skill.md` with no further help:
- set itself up and get funded with test money;
- find an opponent;
- play 10 games;
- settle on-chain;
- report the result.

**Architecture:** This is a local-dev feature set on top of Plans 1–5:
1. **Dev faucet.** It funds new wallets with test USDC and gas on the local Anvil chain only, and refuses to run on any other chain.
2. **House bots.** These are always-available opponent players: an `arena bot` process that runs a daemon plus a simple strategy and keeps standing offers open. `dev:up` starts N of them.
3. **Optional Claude opponent.** A script launches a headless Claude session that plays from `skill.md`.
4. **Recipe.** `skill.md` is rewritten as a step-by-step recipe for "play N games at $X". `dev:up` puts an `arena` command on a known path. An `arena wallet` command reports balances.
5. **Proof.** A scripted end-to-end test follows the recipe literally against house bots.

**User decisions (2026-10-08):**
- Opponents: both house bots and an optional Claude opponent.
- Verification: the user runs the one-sentence prompt themselves. We prove the recipe with a scripted, non-LLM test.

**Tech stack:** Same as Plan 5: TypeScript on Node ≥ 24 with tsx, viem 2.56.8, vitest 5.0.1, chess.js 1.4.0. No new dependencies.

## Global Constraints
- **The faucet must be impossible to enable on a real chain.** It requires all three conditions at once:
  - server config `devFaucet: true`;
  - `chainId === 31337`;
  - the RPC's `web3_clientVersion` starts with `anvil/`.

  If any one fails, `/faucet` returns 404, and `/templates` does not advertise it. The faucet never holds a private key: it uses Anvil's unlocked default account via `eth_sendTransaction` for the MockUSDC `mint`, and `anvil_setBalance` for gas.
- **House bots are dev tooling.** `arena bot` runs only against an `ARENA_HOME` whose config chainId is 31337, unless `--allow-real-chain` is passed. It never signs anything outside the existing daemon's rules, so every Plan 1–5 safety property still holds.
- **No contract changes.** No new dependencies. Never bypass pnpm's minimumReleaseAge.
- **Never touch the running demo stack.** Its ports are :8545, :8080, and the demo daemon API ports. All tests use their own ports, 8600–8699 for Anvil and ephemeral otherwise.
- **Never run the SDK and CLI unit suites concurrently.** Do not run `llm-games` or the Claude-opponent script in tests: they spend the user's money.
- **Commit trailer:** `Co-Authored-By: <model> <noreply@anthropic.com>`.

## Review Focus
1. **The faucet is reachable on a real network.** The Arc testnet or mainnet config must make `/faucet` a 404 and must not advertise it, even if `devFaucet: true` is set by mistake.
2. **A house bot loses the user's funds or hangs a channel.** If the opponent disappears mid-game or after a game, the bot must recover its funds through challenge and timeout. It must never stop with funds stuck.
3. **The agent follows `skill.md` literally and gets stuck.** Examples: no matching offer, an offer taken by someone else, the daemon not running, insufficient funds, a deposit above the cap. Each step names the command and what to do on failure.
4. **A stale `~/.arena` from an older chain.** `arena init --server` against a new chain must leave the agent able to play: re-fund it and ignore foreign channels (degraded).
5. **Ten games in one channel.** The deposit must cover 10 stakes within the 10 USDC cap. The recipe must handle a balance that can no longer cover a stake by closing early and reporting it.

---

### Task 1: Dev faucet (server and CLI)

**Files:**
- Modify:
  - `apps/server/src/config.ts`: add `devFaucet?: boolean`, default false.
  - `apps/server/src/server.ts`: add the route and advertise it in `/templates`.
  - `apps/server/src/chain.ts`: add the faucet helpers.
  - `scripts/dev-up.ts`: set `devFaucet: true`.
  - `packages/cli/src/cli.ts`: auto-fund during `init`, and add the `arena faucet` and `arena wallet` commands.
- Tests: `apps/server/test/faucet.test.ts` (Anvil 8546 via global setup), `packages/cli/test/init.test.ts`, `packages/cli/test/cli.test.ts`.

**Requirements:**
- **`POST /faucet {address}`** accepts JSON only (415 otherwise) and is Host-guarded like the other routes.
  - It mints 100 USDC (`100_000_000` base units) to `address`. It sends the MockUSDC `mint` with `eth_sendTransaction` from `eth_accounts[0]` and waits for the receipt.
  - It sets the native balance to at least 1 ETH using `anvil_setBalance`, and never lowers it.
  - Rate limits: once per address per 10 minutes (a second request gets 429 with the time left), plus the per-IP POST limiter.
  - It returns `{ address, usdc, native }`, both as decimal strings after funding.
- **Enabling** needs all three Global Constraint checks, made once at startup and cached. When disabled, `/faucet` is 404. `/templates` adds `faucet: "<publicUrl>/faucet"` only when enabled.
- **`arena init --server URL`** checks the template after writing the config. If it has a `faucet` and the wallet's USDC balance is below 20 USDC, it calls the faucet and prints the funded balances in its JSON output, under `faucet: {...}` or `faucet: "skipped: …"`.
  - A faucet failure never fails `init`; it reports it.
  - `--no-faucet` turns this off.
- **`arena faucet`** calls the faucet for this wallet explicitly.
- **`arena wallet`** prints `{ address, usdc, native, chainId }`. `usdc` is the formatted USDC balance with 6 decimals, and `native` the formatted native balance. It works with or without a running daemon, reading the chain directly.
- **Tests:**
  - faucet on Anvil: funds the address; 429 on repeat; 404 when `devFaucet` is false; 404 when chainId ≠ 31337 (stub); 404 when the clientVersion isn't anvil (stub);
  - `/templates` advertises the faucet only when enabled;
  - `init` auto-funds when advertised and skips with `--no-faucet`;
  - `arena wallet` output.

- [ ] Steps: TDD per item, commit per item, then run `pnpm test:server`, then `pnpm test:cli`.

### Task 2: House bots (`arena bot`) and the Claude opponent script

**Files:**
- Create: `packages/cli/src/bot.ts`, which holds the strategy and loop.
- Modify:
  - `packages/cli/src/cli.ts`: the `arena bot` command.
  - `scripts/dev-up.ts`: `--house-bots N`, default 2.
- Create:
  - `scripts/claude-opponent.ts`, run as the root script `dev:claude-opponent`;
  - `packages/cli/test/bot.test.ts`.

**Requirements:**
- **`arena bot [--deposit 10] [--stake 1] [--offers 1] [--timeout <s>]`** runs one long-lived process that does the following:
  - It starts the daemon in-process with `startDaemonProcess`, so it takes the `ARENA_HOME` lock and the local API. It prints the same start line plus `"bot": true`.
  - **Standing offers:** it keeps `--offers` open offers in the lobby at these terms. When an offer is matched or expires, it posts a new one. Before each post it checks the wallet balance against `deposit + fee`, and on shortfall it logs and stops posting.
  - **Play** (agent seats only, driven through the daemon's own methods, with `actor: "agent"`):
    - On `your-turn`, it moves using this strategy: mate in one, else the most valuable capture of a piece worth at least as much as the capturing piece, else a check (50%), else any capture (60%), else a random move. It moves after a 500 ms beat.
    - On `new-game-proposed`, it accepts.
    - On `close-requested`, it co-signs.
    - On `game-over`, it waits up to 120 s for the opponent to propose a next game or request a close. Then it requests a close itself, by signing Close.
    - On `opponent-silent`, it waits until the daemon suggests a challenge, then challenges. The watchtower's timeout recovers the funds.
  - It never offers or accepts draws, and never resigns, except that the daemon's own auto-resign on mate and auto-claim on stalemate still apply.
  - It accepts several channels at once.
  - **Shutdown** on SIGINT/SIGTERM: stop posting, cancel standing offers by letting them expire, and stop the daemon cleanly.
- **dev:up `--house-bots N`:**
  - creates N extra funded homes named `house-1`…`house-N`, starts `arena bot` for each as a child process, and logs each to `<dir>/logs/house-i.log`;
  - waits until each bot's first offer is visible in the lobby;
  - tears everything down on Ctrl-C;
  - prints the one-sentence prompt for the user.

  `--players` keeps working as before (unfunded-by-bot human homes), but its default becomes 0 now that agents self-onboard.
- **`pnpm dev:claude-opponent [--server http://127.0.0.1:8080] [--games 3] [--stake 1] [--model …]`:**
  - creates a fresh `ARENA_HOME` under `.arena-dev/claude-opponent-<ts>`;
  - launches a headless `claude -p` session with the same sandbox builders as `tests/system/llm-games.ts` (narrow allowed tools, minimal env, own tmp root, curl pinned to the server origin). Reuse or extract those builders; don't copy them;
  - gives it the prompt "Go to <server> and use your money to play <games> $<stake> games with whoever is available.";
  - streams the log to the console and `.arena-dev/claude-opponent-<ts>.log`, and prints the cost at the end;
  - **never runs in tests.**
- **Tests** (Anvil, with fake timers where possible):
  - the strategy picks mate in one, and the higher-value capture;
  - a bot plus a scripted opponent: the bot posts an offer, the opponent accepts, both play to a terminal state, the opponent proposes the next game and the bot accepts, the opponent requests a close and the bot co-signs, and balances are exact;
  - the bot re-posts after a match;
  - the bot stops posting when it is short of funds;
  - when the opponent goes silent after game over, the bot closes or challenges, and its funds are recovered (with `increaseTime`);
  - `arena bot` refuses a non-31337 chain without `--allow-real-chain`.

- [ ] Steps: TDD the strategy and the loop, then dev:up wiring, then the opponent script (manual check: `--help` only, no paid run), then `pnpm test:cli` and `pnpm test:system -- dev-up`.

### Task 3: `skill.md` recipe, `arena` on PATH, and a scripted end-to-end test

**Files:**
- Modify:
  - `apps/server/src/docs.ts`, which serves `skill.md`, the chess skill and `llms.txt`;
  - `scripts/dev-up.ts`, which writes the wrapper.
- Create: `tests/system/agent-recipe.test.ts`.
- Docs: `packages/cli/README.md`, `apps/server/README.md`, the spec's §1 success criterion 2 note, and a new §12 item.

**Requirements:**
- **dev:up wrapper.** dev:up writes `<dir>/bin/arena`, an executable shell wrapper around `node <repo>/packages/cli/bin/arena.mjs`. It sets the server's `cliCommand` to that wrapper's absolute path, so `skill.md` shows a command the agent can run from any directory. It also prints `export PATH=<dir>/bin:$PATH` as an optional tip.
- **`skill.md` rewrite.** Keep it accurate to the real CLI. Its first section is **"Recipe: play N games at $X per game"**, with numbered steps. Each step gives the exact command and what to do if it fails:
  1. `<arena> init --server <url>`. It auto-funds on a dev server. If you already have an `ARENA_HOME` from another server, the command re-points it; old channels show as degraded and can be ignored.
  2. Start the daemon so it keeps running: `nohup <arena> daemon > ~/.arena/daemon.log 2>&1 &`, or your tool's background feature. Check it with `<arena> channels`.
  3. `<arena> wallet` checks funds: you need `N × X + fee` USDC. To play N games, deposit `min(N × X, cap)`, where `/templates` publishes the cap.
  4. Find an opponent:
     - `<arena> offers` lists the standing offers;
     - pick one whose `stakePerGame` is X and whose `deposit` is at least `N × X`, or the largest available within the cap;
     - `<arena> accept <offerId>`.
     - If none fits, post your own with `<arena> offer --deposit … --stake …` and wait.
     - The channel opens once both sides have funded; this takes a few blocks. Check it with `<arena> channels`.
  5. The play loop:
     - repeat `<arena> wait`, then `<arena> status`, then act;
     - on `your-turn`, `<arena> move <SAN>`;
     - after each game, if `games played < N` and both balances still cover a stake, run `<arena> next-game` (the opponent must agree);
     - otherwise run `<arena> close`.
     - Always read `status.controller`: if a human holds the seat, don't act.
  6. When `phase` is `Finalized`, the game is settled. `<arena> wallet` again shows the result; report games, wins and losses, and the USDC change.
  - **Troubleshooting:** a deposit above the cap; an offer taken by someone else; the daemon not running; `opponent-silent` (challenge); `human-must-move`; `session-gas-low` (fund the wallet).
  - Keep handoff etiquette and the security notes from Plan 5.
  - The chess skill stays a short rules and etiquette page.
- **`tests/system/agent-recipe.test.ts`.** A scripted "agent" (no LLM) parses the commands from the served `skill.md` (or a pinned copy validated against it) and runs them through the real CLI wrapper against a dev:up-like stack with 2 house bots:
  - init with auto-fund;
  - start the daemon;
  - check the wallet;
  - accept a house bot's offer;
  - play 3 games at $1, choosing moves with a simple engine and always resigning game 2, so that both win and loss paths occur;
  - close;
  - check the wallet again.

  Assert:
  - three games played;
  - the channel is Finalized;
  - the wallet's USDC delta equals the exact sum of game results minus the fee;
  - the house bot's daemon has no `lastError`;
  - nothing was left running.

  If the harness can't easily start dev:up, use `startStack` plus `arena bot` children directly.
- **Docs.**
  - The CLI README gets an "Agent quick start".
  - The server README gets the faucet: dev only, with its three-way guard.
  - The spec gets a §12 item describing the faucet guard and house bots as dev tooling.
  - `mainnet-gates.md` gets "faucet must be disabled; house bots not run on mainnet".

- [ ] Steps:
  1. Wrapper.
  2. `skill.md`, with a server test that it contains the recipe commands.
  3. Scripted e2e.
  4. Docs.
  5. Run `pnpm test:server`, `pnpm test:cli` and `pnpm test:system` once, one at a time.
