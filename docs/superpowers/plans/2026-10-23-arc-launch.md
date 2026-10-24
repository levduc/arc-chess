# Arc Launch Implementation Plan (Plan 6)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the arena correct on Arc and prove it on Arc's simulator and on Arc testnet. Then deploy to Arc mainnet, but only after the owner says "go".

**Architecture:**
- **Chain profile.** A built-in chain profile (`packages/cli/src/chains.ts`) drives four Arc behaviours: one-balance USDC accounting, a 20 gwei fee floor, a fee ceiling, and the expected USDC address. It never comes from the host.
- **Estimated top-up gas.** Session-key top-ups use estimated gas instead of a hard-coded 21,000.
- **Pinned deployments.** On a chain in the profile table, `init` refuses any hub, rules or USDC address other than the pinned deployment.
- **Arc test subset.** A subset of the suites runs on `arc-anvil --network arc` (Arc Foundry).
- **Testnet rehearsal.** A rehearsal on Arc testnet produces real transaction hashes and a cost table.

**Tech Stack:** TypeScript on Node ≥ 24; viem 2.56.8; vitest 5.0.1; Foundry plus Arc Foundry, pinned.

**Spec:** `docs/superpowers/specs/2026-10-23-arc-launch-design.md`. Chain facts are in `docs/superpowers/arc-facts.md`.

## Global Constraints
- **Mainnet is gated.** Never send a transaction to Arc mainnet (chain 5042) in this plan except in Task 6, and only after the controller relays the owner's explicit "go". Read-only mainnet RPC calls are fine.
- **The testnet deployer key** lives in `~/.config/arena-deploy/arc-testnet-deployer.json` (mode 0600). Its address is `0x840d6f90dd12A713CC5F1fb6EAbBF99e0E74A7E0`.
  - Never print, log or commit the private key.
  - Pass it to tools through an environment variable read from the file inside the same command, never as a literal on the command line.
  - Never put it in a test fixture.
- **The chain profile is authoritative.**
  - Arc mainnet is chain 5042 and Arc testnet is chain 5042002.
  - USDC is `0x3600000000000000000000000000000000000000` on both.
  - `minFeePerGas` is 20 gwei, and the Arc `feeCeilingWei` default is 40 gwei.
  - The profile is never overridden by `/templates`.
- **Behaviour on other chains is unchanged.** On chains without a profile (anvil 31337, every existing test), behaviour stays exactly as today, and all existing suites must pass unmodified.
- **Dependencies and tools.**
  - viem stays at 2.56.8.
  - Never bypass pnpm's `minimumReleaseAge`.
  - No new workspace dependencies.
  - Arc Foundry is a pinned binary release with a recorded SHA-256. Never run an unverified curl-to-shell installer.
- **Never touch the user's environment.** That means ports 8545, 8080 and 7070, `~/.arena`, `.arena-dev/`, and the user's processes. Every CLI run uses a temp `HOME`/`ARENA_HOME`. Kill only the pids you started.
- **Test runs.** Wrap unit suites in `flock /tmp/claude-1000/arena-8546.lock`. Run suites in the foreground, one at a time.
- **Commits** end with `Co-Authored-By: <model> <noreply@anthropic.com>`.

## Review Focus
1. **One balance double-spend.** On Arc, `withdraw --all` must never leave a live channel unable to pay for its dispute gas. `fund` must never ask the human for "USDC + gas" as if they were two different assets.
2. **Silent drops below the fee floor.** Every send and every replacement on Arc must use a `maxFeePerGas` of at least 20 gwei. A replacement that is bumped from an estimate must still respect the floor.
3. **A fake hub on Arc.** `init` must refuse a non-pinned hub, rules or USDC address on 5042 and 5042002. This holds even when `/templates` publishes those addresses and even when they are passed as explicit flags.
4. **Top-up gas too low.** The daemon's session-key top-up must succeed on `arc-anvil`, where a value transfer costs more than 21,000 gas.
5. **A receipt that never comes.** On Arc a blocklist revert may produce no receipt. A bounded wait that times out must never be reported as success in deposit, close, dispute, sweep or withdraw.

## Parallelism
- **Wave 1:** Task 1 (CLI chain profile and one balance) runs in parallel with Task 3 (the Arc Foundry install and the arc-anvil test infrastructure). Their files are disjoint.
- **Wave 2:** Task 2 (fee floor and top-up gas), which shares `daemon.ts`, `cli.ts` and `config.ts` with Task 1.
- **Wave 3:** Task 4 (the Arc-specific assertions on arc-anvil).
- **Wave 4:** Task 5 (the testnet rehearsal). It needs the owner to fund the deployer.
- **Task 6** (the mainnet deploy) is gated on the owner.

---

### Task 1: Chain profile, one-balance accounting, pinned deployments (CLI)
**Files:**
- Create `packages/cli/src/chains.ts`.
- Modify:
  - `packages/cli/src/config.ts`: `KNOWN_DEPLOYMENTS` becomes a hard refusal, with an empty placeholder for 5042 and 5042002 that Task 5 fills;
  - `packages/cli/src/cli.ts`: `wallet`, `fund`, `init`;
  - `packages/cli/src/funding.ts`;
  - `packages/cli/src/daemon.ts`: `withdrawReserve`.
- Test: `packages/cli/test/chains.test.ts`, plus updates to the `funding`, `cli`, `init` and `withdraw` tests.

**Requirements** (spec §2 items 1 and 5):
- `CHAIN_PROFILES` exactly as in the spec.
- `wallet`:
  - On a profile with `nativeIsUsdc`, it prints `{address, chainId, usdc}`. `usdc` is the native balance divided by 10^12, rounded down to 6 decimal places.
  - Elsewhere it keeps today's four keys.
- `fund`:
  - On `nativeIsUsdc`, `usdc.need` = deposit + fee + ceil((sessionGasWei + 500,000 × feeCeiling) / 10^12). The `native` key is absent, and `message` names only USDC. Pin the exact message string in a test.
  - Elsewhere it is unchanged.
- `withdrawReserve()`:
  - On `nativeIsUsdc`, it is (live, unsettled channels × sessionGasWei + 500,000 × feeCeiling), converted to 6 decimals and rounded up.
  - Elsewhere it stays 0.
  - `withdraw --all` keeps the reserve. `--amount` above (balance − reserve) is refused with a message naming the reserve.
- `init` on a profile chain:
  - A `usdc` other than `profile.usdc` is refused.
  - When `KNOWN_DEPLOYMENTS[chainId]` is set, any hub or rules mismatch is refused.
  - Both hold whether the addresses come from `/templates` or from explicit flags.
  - Unprofiled chains keep today's warning-only behaviour.
- **Tests:**
  - each rule above;
  - a profile-less chain (31337) is byte-identical to today;
  - the reserve with 0, 1 and 3 live channels;
  - the 18-to-6 conversion edge cases: 1 wei, 10^12 − 1, 10^12 and 10^12 + 1.
- Run `flock … pnpm test:cli` and the typecheck, then commit.

### Task 2: Fee floor, top-up gas, Arc fee ceiling (SDK and CLI)
**Files:**
- Modify:
  - `packages/sdk/src/tx.ts`: `SerialTxSender` gains `minFeePerGas`;
  - `packages/cli/src/daemon.ts`: the session-key top-up gas, and the profile wired into both senders;
  - `packages/cli/src/config.ts` and `cli.ts`: the profile default for `feeCeilingWei`, and refusing a ceiling below the floor.
- Test: `packages/sdk/test/tx.test.ts` and `packages/cli/test/daemon.test.ts` (or a new `arc-fees.test.ts`).

**Requirements** (spec §2 items 2–4):
- Every send and every same-nonce replacement satisfies all three:
  - `maxFeePerGas ≥ minFeePerGas`;
  - `maxPriorityFeePerGas ≤ maxFeePerGas`;
  - the existing fee-cap logic, bounded by the balance.
- The top-up gas becomes `estimateGas` + 20 % + 5,000 instead of `21_000n`. If the estimate fails, the channel gets the existing `session-gas-low` handling; it is never sent with 21,000.
- On a profile chain, `feeCeilingWei` defaults to the profile's value. `init --fee-ceiling-wei` below `minFeePerGas` is refused.
- **Tests:**
  - the floor applies to fresh sends and to replacements;
  - a profile-less chain is unchanged;
  - the top-up gas comes from the estimate, against standard anvil with a stubbed estimate.
- Run `flock … pnpm test:sdk`, then `flock … pnpm test:cli` (never both at once), and the typechecks. Then commit.

### Task 3: Arc Foundry and the arc-anvil test infrastructure
**Files:**
- Create `tools/arc-foundry.md` and `scripts/install-arc-foundry.sh`.
- Add a root script `"test:arc"` and an anvil-binary override: `ARENA_ANVIL_BIN`, honoured by `packages/sdk/test/global-setup.ts` and `tests/system/harness.ts`.
- Add an arc-anvil port override, so the test:arc run does not use :8546. For example, `ARENA_TEST_ANVIL_PORT`, used only in this mode.
- Test: the existing suites, run against arc-anvil.

**Requirements** (spec §3):
- Find Arc Foundry's official release: its repo, release asset, version and SHA-256.
  - The install script downloads that exact asset into `tools/bin/` (gitignored), verifies the SHA-256 and refuses on a mismatch.
  - Record the version, the source URL and the reason for each choice in `tools/arc-foundry.md`.
  - If Arc Foundry has no binary release that can be verified, report BLOCKED with what you found, and do not improvise.
- `pnpm test:arc` runs, against `arc-anvil --network arc` on a free port:
  - `forge test` via `arc-forge`, if it is needed for Arc semantics;
  - the SDK and CLI money-moving tests: deposit, close, dispute, sweep, top-up, withdraw;
  - `tests/system/dispute.test.ts`.
- Report every failure the Arc semantics cause. Do NOT fix product code in this task; list the failures for Task 4.
- Commit.

### Task 4: Arc-specific assertions and fixes on arc-anvil
**Files:**
- Tests under `packages/cli/test/arc/` and `tests/system/arc-*.test.ts`.
- Product fixes for any arc-anvil failure that Task 3 reported.

**Requirements:**
- On arc-anvil, assert:
  - one balance: `wallet` matches the native balance, and `fund` and `withdraw` keep the reserve;
  - the top-up succeeds, with gas above 21,000;
  - a transaction below 20 gwei never lands, and our sender never produces one;
  - a full game, close and dispute settle with exact balances;
  - a blocklisted payout lands in `owed`, if arc-anvil can model a blocklist (otherwise document why not).
- Fix whatever Task 3 found, within the Global Constraints.
- Run `pnpm test:arc` and all the standard suites, then commit.

### Task 5: Arc testnet dress rehearsal
**Prerequisite:** the owner has funded `0x840d6f90dd12A713CC5F1fb6EAbBF99e0E74A7E0` from `faucet.circle.com`. Check its balance before starting.

**Files:**
- `contracts/script/Deploy.s.sol`: only if Arc needs a tweak, such as the gas price.
- `contracts/deployments/5042002.json`.
- `packages/cli/src/config.ts`: pin `KNOWN_DEPLOYMENTS[5042002]`.
- `scripts/arc-rehearsal.ts`.
- `docs/superpowers/arc-testnet-rehearsal.md`, the report.
- `docs/superpowers/mainnet-gates.md`: tick the items with evidence.

**Requirements** (spec §4):
- Deploy with `ARENA_TOKEN=0x3600…0000`, with the deployer as both owner and fee recipient. Use testnet limits: `ARENA_MAX_DEPOSIT_PER_PLAYER=2000000` and `ARENA_MAX_COMMITTED_ESCROW=50000000`. Use a gas price of at least 20 gwei.
- Verify the source on `explorer.testnet.arc.io`. Research which verifier it supports, and document it.
- **The rehearsal script.**
  - It starts a local server configured for Arc testnet (chainId 5042002, the testnet RPC, `xmtp: {env: "dev"}`), and creates two agent homes funded from the deployer with about 1.5 USDC each.
  - It plays 3 games with deposit 1 and stake 0.1, then closes; the balances must be exact.
  - It runs a dispute (challenge, respond, timeout) on a second channel.
  - With XMTP enabled in both homes, it kills the host mid-game, and the game finishes over XMTP `dev`.
  - It sweeps the session gas and withdraws the agents back to the deployer.
- **The report.** Every transaction hash with an explorer link, gas used and cost in USDC per action, timings, and anything that surprised you.
- Commit.

### Task 6: Mainnet deploy (gated; the controller runs this only after the owner's "go")
**Owner inputs** (relayed by the controller):
- the owner address;
- the fee recipient;
- the limits and the fee;
- the deployer: either the owner's wallet, run by the owner, or a fresh key we generate and the owner funds.

**Requirements:**
- Deploy, verify the source, commit `contracts/deployments/5042.json` and pin `KNOWN_DEPLOYMENTS[5042]`.
- If the owner is a multisig, the owner completes the `Ownable2Step` acceptance; document the exact transaction for them to run.
- Write `docs/deploy/arc-mainnet.server.json.example`.
- Tick the mainnet gates with evidence.
