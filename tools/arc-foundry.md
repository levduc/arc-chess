# Arc Foundry

Plan 6 Task 3 (spec §3; `docs/superpowers/arc-facts.md`, "Other differences"): standard `anvil` does not model
native USDC, so Arc-accurate local tests need Arc Foundry's own `arc-anvil --network arc`, `arc-forge` and
`arc-cast`.

## What it is

[`circlefin/arc-foundry`](https://github.com/circlefin/arc-foundry) is Circle's fork of
[Foundry](https://github.com/foundry-rs/foundry) with first-class Arc support. It is a superset of upstream
Foundry -- everything upstream supports keeps working, and `--network arc` / `-n arc` switches the toolkit to
Arc's execution semantics (EIP-7708 native-USDC transfer logs, the 20 gwei base-fee floor, etc.). Binaries are
installed under an `arc-` prefix (`arc-anvil`, `arc-forge`, `arc-cast`) so they can sit alongside a stock
Foundry install without colliding. Arc Foundry's own `chisel` is not yet supported on Arc and is not published
in this release's archives.

## Why this version

**Pinned: `v0.8.0-2`** (published 2026-09-18, the latest release on
[the releases page](https://github.com/circlefin/arc-foundry/releases) as of 2026-10-23, superseding `v0.8.0-1`
from 2026-09-08). Confirmed via `https://api.github.com/repos/circlefin/arc-foundry/releases/latest`.

Arc Foundry publishes precompiled binary archives for exactly three targets -- every one verifiable, so the
"no binary release" BLOCKED case does not apply:

| Target | Platform | Asset |
|---|---|---|
| `x86_64-unknown-linux-gnu` | Linux x86_64 (glibc) | `arc-foundry-v0.8.0-2-x86_64-unknown-linux-gnu.tar.gz` |
| `aarch64-unknown-linux-gnu` | Linux arm64 (glibc) | `arc-foundry-v0.8.0-2-aarch64-unknown-linux-gnu.tar.gz` |
| `aarch64-apple-darwin` | macOS Apple Silicon | `arc-foundry-v0.8.0-2-aarch64-apple-darwin.tar.gz` |

No archive is published for Intel macOS, Windows, or musl-based Linux; those are source-only (`cargo build
--release`) and `scripts/install-arc-foundry.sh` refuses outright on them rather than building from source
without approval.

This install (this environment: Linux x86_64) uses `x86_64-unknown-linux-gnu`.

## Verification

Each archive is published with a matching `<asset>.sha256` file -- the project's own checksum, preferred per
the Plan 6 supply-chain rule over one this task would compute itself. Downloaded and recorded on 2026-10-23;
every value below was cross-checked against two independent sources that agree exactly:
1. the content of the asset's own published `.sha256` file;
2. GitHub's own `digest` field for that asset, from
   `https://api.github.com/repos/circlefin/arc-foundry/releases/tags/v0.8.0-2`.

| Asset | SHA-256 |
|---|---|
| `arc-foundry-v0.8.0-2-x86_64-unknown-linux-gnu.tar.gz` | `088bdb96a84418b757f9825d491e702792f1d1d1e29a9145af305a6600a79556` |
| `arc-foundry-v0.8.0-2-aarch64-unknown-linux-gnu.tar.gz` | `6508a6425bfeab62188698702771478619d4229fda1db038fb01c1050476c805` |
| `arc-foundry-v0.8.0-2-aarch64-apple-darwin.tar.gz` | `90e3eefbf7dd80652fd283a7562e9263301a48797bc2224cc21a3964e2d5db87` |

`scripts/install-arc-foundry.sh` pins these three values, downloads only the asset matching the running
machine's `uname -s`/`uname -m`, re-verifies the archive's sha256 against the matching pinned value every run
(including an already-downloaded archive reused from a prior run -- nothing already on disk is trusted
without re-checking), and refuses to extract on any mismatch.

Only `x86_64-unknown-linux-gnu`'s archive was actually downloaded and run in this task (this environment); the
other two targets' checksums are recorded from the two sources above for when the script runs on those
platforms, but were not independently exercised here.

## What's installed

`scripts/install-arc-foundry.sh` extracts the archive's `anvil`, `cast` and `forge` binaries into
`tools/bin/` (gitignored: see the `tools/bin/` line in `.gitignore`), renamed `arc-anvil`, `arc-cast` and
`arc-forge` so they never shadow a stock Foundry install on `PATH`:

```
tools/bin/arc-anvil
tools/bin/arc-cast
tools/bin/arc-forge
```

Verified locally: `anvil Version: 1.7.1-dev` (commit `d497beea7096ff2a8e583c8b307941f24a61b06b`, built
2026-09-18T15:31:46Z) for all three binaries.

## How the test infrastructure uses it

- `pnpm test:arc` (`scripts/test-arc.sh`) installs Arc Foundry on demand (if `tools/bin/arc-anvil` is
  missing) and runs the Arc subset against it.
- `ARENA_ANVIL_BIN` (honoured by `packages/sdk/test/global-setup.ts` and `tests/system/harness.ts`) selects
  which anvil binary a test run spawns. Unset, both keep spawning plain `anvil` -- today's behaviour,
  unchanged. Set to an absolute path ending in `arc-anvil`, both auto-append `--network arc` to the spawn
  (inferred from the binary's basename, so no separate flag is needed) and otherwise keep every existing
  deploy/fund/test step exactly as it already is -- they talk to whatever node answers on the port, Arc
  Foundry's or stock Foundry's.
- `ARENA_TEST_ANVIL_PORT` selects the port that same anvil listens on. Unset, `global-setup.ts` keeps its
  fixed `:8546` (shared by the SDK and CLI unit suites) and `tests/system/harness.ts` keeps its existing
  dynamic free-port scan over `8600`-`8699`. Set, both instead listen on that one port -- chosen from within
  the harness's own `8600`-`8699` reserved range, so the system-test port picker's "an explicit preferred
  port outside the reserved range is refused outright" invariant needs no change. `scripts/test-arc.sh` (fix
  round 1, `task-3-review.md` Minor-2) gives each of its `vitest run` invocations (sdk, cli, cli's
  `hardening.test.ts` sweep filter, system, and Task 4's Arc-like harness `packages/cli/test/arc/`) a *distinct*
  port in that range (`8650`-`8654`) rather than rebinding one shared port back to back with no proven margin for
  the OS to release it between one invocation's `anvil.kill()` and the next invocation's bind attempt.
- Plan 6 Task 4: `ON_ARC_ANVIL` (exported by `global-setup.ts`, re-exported by `packages/sdk/test/helpers/chain.ts`)
  is true when `ARENA_ANVIL_BIN` names `arc-anvil`. A test that needs an anvil-only cheat Arc refuses, or a fee
  sized for stock anvil's market, takes its Arc variant on it; the `packages/cli/test/arc/` files skip themselves
  without it (stock anvil has no native-USDC proxy), so `pnpm test:cli` reports them as skipped.

Neither override touches `ports 8545/8080/7070`, `~/.arena`, or `.arena-dev/` (Plan 6 Global Constraints);
they only ever affect anvil instances these test suites start and stop themselves.

**Scope limit (fix round 1, Minor-1): the arc-forge contracts step's isolation is not total.** Only the
dedicated contracts step (`arc-forge test --root contracts -n arc --out out-arc --cache-path cache-arc`)
avoids the shared `contracts/out`/`contracts/cache`. The sdk/cli/system steps still run through
`packages/sdk/test/global-setup.ts`'s plain `forge build` into that same shared `contracts/out` (unchanged by
this task, required by hardcoded paths in e.g. `packages/sdk/test/helpers/chain.ts`) -- so `pnpm test:arc` run
concurrently with `pnpm test:sdk`/`pnpm test:cli` (or another agent's run of either, in a shared checkout)
can still race on `contracts/out`, exactly as any two of today's existing suites already could. This is not
new risk this task introduced, and it is not fixable from this task's files alone. The race was reproduced in the
Task 4 review, so the ruling is: **run `pnpm test:arc` alone**, with no other suite running in the checkout.

## Notable local-simulation gaps found while installing

Running `arc-forge test -n arc --root contracts` (the full existing contract suite, 168 tests, 1500 invariant
runs) against Arc Foundry's execution semantics passed with **zero failures** -- see
`.superpowers/sdd/2026-10-23-arc-launch/task-3-report.md` for the full run. Several things worth recording for
Task 4, found by direct RPC probing against a bare `arc-anvil --network arc` (outside any test suite), none a
contract bug:

1. **The EIP-7708 native-transfer log is emitted** on `arc-anvil --network arc` (from
   `0xffffFFFfFFffffffffffffffFfFFFfffFFFfFFfE`, matching `arc-facts.md`) for a plain native-value transfer,
   confirmed via `eth_sendTransaction` + `eth_getTransactionReceipt`.
2. **`eth_estimateGas` for that same plain native transfer returns exactly `21000`**, which is also what real
   Arc charges (`arc-facts.md`, corrected 2026-10-24: the earlier 21,225 came from a probe to the SHA-256
   precompile). Task 4 therefore never asserts "above 21,000": `packages/cli/test/arc/settlement.test.ts`
   asserts the top-up's gas limit is at least the node's estimate (`topUpGasLimit(estimate)`, 30,200 here).
3. **The 20 gwei fee floor on `arc-anvil` is chain-id-dependent, and only holds for the chain ids this task's
   infrastructure actually uses.** Confirmed directly (15 `evm_mine` calls on an empty mempool, each
   configuration its own fresh node, re-checked twice):
   - no `--chain-id` (this infrastructure's default, Anvil's `31337`) and `--chain-id 5042` (mainnet): base fee
     stays flat at exactly 20 gwei through at least 15 empty blocks, and a `maxFeePerGas` below it is rejected
     **immediately, with an explicit JSON-RPC error** (`-32003 "max fee per gas less than block base fee"`) --
     not the silent, receipt-less mempool drop `arc-facts.md` describes for real Arc.
   - `--chain-id 5042002` (testnet): base fee decays from 20 gwei to **974 wei by the 15th empty block** (not
     a slow, standard EIP-1559 ~12.5%-per-block decrease -- far steeper), after which a sub-20-gwei
     `maxFeePerGas` transaction is simply **mined**, floor or not.

   An earlier version of this note (and an independent audit, `.superpowers/sdd/2026-10-23-arc-launch/
   audit-daemon.md`, I-4) reported the floor does not hold on `arc-anvil` at all, from a probe against
   `5042002`; that is correct for that chain id and is the one Task 4's `CHAIN_PROFILES`-gated assertions will
   actually exercise (`nativeIsUsdc`/the fee floor only activate at `5042`/`5042002`, never at this
   infrastructure's `31337`). **Task 4 cannot rely on `arc-anvil` to enforce or silently drop a below-floor
   fee at testnet's chain id** -- per the audit, assert the floor at the sender (`SerialTxSender`) instead,
   not by sending a real below-floor transaction to a local testnet-chain-id node and expecting the chain to
   reject or drop it. A Task 4 assertion written as "the transaction never appears, no error" will not
   reproduce on either chain id as `arc-facts.md` describes it for real Arc.

   **Task 4 resolution (ledger ruling, "Task 4 harness").** The Arc-like harness stays at `31337`, where the floor
   *does* hold, and puts a test-only Arc profile there instead of using `5042`/`5042002` (whose
   `KNOWN_DEPLOYMENTS` pins refuse a local hub). `packages/cli/test/arc/floor.test.ts` asserts that a
   `maxFeePerGas` of 20 gwei - 1 is refused with `-32003` and mines nothing; that a `SerialTxSender` handed an
   estimate under the floor emits a transaction the node refuses when it has no `minFeePerGas`, and pays exactly
   20 gwei and lands when it has the profile's floor; and that the daemon's wallet and session senders carry it.
   `settlement.test.ts` records every `eth_sendRawTransaction` the daemons make (refused ones too, through a
   JSON-RPC pass-through) and asserts none was under 20 gwei. That last check cannot fail on arc-anvil from the
   market alone: its market (about 25 gwei: 1.2 x the 20 gwei base fee plus a 1 gwei tip) is above the floor. The
   silent drop itself is still asserted only at the sender level (`packages/sdk/test/feeFloor.test.ts`), as audit
   I-4 asked.
4. **The one-balance native-USDC model is already live on `arc-anvil --network arc`, independent of chain
   id.** A predeployed proxy contract exists at the ERC-20 USDC address (`0x3600…0000`); calling its
   `balanceOf(account)` returns exactly `eth_getBalance(account) / 1e12` for every default dev account,
   confirmed by direct probe. `anvil_setBalance` sets that one balance (both views move). The existing SDK/CLI/
   system-test helpers still deploy their own ordinary `MockUSDC`, so they never exercise it. **Task 4's Arc-like
   harness does** (`packages/cli/test/arc/harness.ts`): arc-anvil at `31337`, the hub deployed with
   `token = 0x3600…0000`, fresh wallets funded with `anvil_setBalance`, and a test-only `CHAIN_PROFILES[31337]`
   copied from the `5042` profile (USDC `0x3600…`, `nativeIsUsdc`, 20 gwei floor, 40 gwei ceiling). Exact balances
   are reconciled from receipts (`gasUsed x effectiveGasPrice`), because a gas deduction emits no log.
5. **arc-anvil models the blocklist, and a local test can drive it (Task 4, confirmed by probe).** The USDC at
   `0x3600…0000` is a FiatToken-style `AdminUpgradeabilityProxy` (implementation `0xc6ad…3ca6`, proxy admin anvil
   dev account 9). Its roles are anvil dev accounts with known keys: `blacklister()` is account 7
   (`0x14dC…9955`); `owner()`, `masterMinter()`, `pauser()` and `rescuer()` are account 8 (`0x2361…1E8f`). A
   `blacklist(address)` from account 7 reaches `NativeCoinControl` (the precompiles at `0x1800…0000` to
   `0x1800…0004` each hold the one-byte code `0xef`):
   - a native transfer to a blocklisted address is refused at submission: `-32603 "transaction rejected: address
     … is blocklisted by NativeCoinControl"`;
   - a blocklisted sender cannot send anything, a zero-value contract call included (refused with `-32603`, or
     with `-32003 "Blocked address"` at the gas estimate);
   - an ERC-20 `transfer` to it reverts with `"Blocked address"`, so the hub's `_pay` low-level call fails and the
     payout is credited to `owed` (`PayoutDeferred`).
   `unBlacklist(address)` undoes it. `settlement.test.ts` blocklists one player's wallet after a game, has the
   other close, and asserts `owed`, the `PayoutDeferred` log, the other side's exact payout and the fee; then it
   unblocks the wallet and claims. Not modelled: Arc's "a gas-consuming revert produces no receipt" -- arc-anvil
   refuses a blocklisted transaction outright, before anything is mined.
6. **The chain id used by this task's `test:arc` subset is left at Anvil's default `31337`** (`--network arc`
   is passed without `--chain-id`), deliberately: every existing SDK/CLI/system-test helper hardcodes viem's
   `foundry` chain (id `31337`); passing `--chain-id 5042` was confirmed (by hand, outside the suites) to still
   produce the same base-fee floor and EIP-7708 log, but would make every existing `chain: foundry` viem
   client send a transaction with a mismatched chain id and have it rejected. The CLI's chain-id-keyed
   `CHAIN_PROFILES` (`packages/cli/src/chains.ts`, Task 1) therefore does **not** key in on `31337` here --
   Arc-specific CLI behaviour gated on `profile.nativeIsUsdc` etc. needs its own coverage. **Task 4** gives it a
   test-only Arc profile at `31337` (point 4), not `--chain-id 5042`/`5042002`: those chain ids are pinned in
   `KNOWN_DEPLOYMENTS`, and `5042002` loses the floor (point 3).
7. **(Fix round 1) `anvil_setNextBlockBaseFeePerGas` is refused outright on `arc-anvil --network arc`**, with
   an explicit RPC error: `"the next block base fee cannot be overridden on Arc; it is derived from the
   parent block's carrier"` (code `-32602`). `packages/sdk/test/helpers/chain.ts`'s `setBaseFeePerGas` helper
   (used by several hardening/fee-boundary tests) calls exactly this method -- any test that depends on it to
   pin an exact fee boundary will throw on `arc-anvil`, not silently do nothing. Found by running `pnpm
   test:arc`'s cli-sweep step for real (`packages/cli/test/hardening.test.ts`'s "Plan 5 Task 1: session-gas
   sweep" block): `"fix round 2, minor 5: the dust boundary is exact"` fails with exactly this error. Two
   further tests in the same file/run also failed, immediately after it in file order, sharing the same
   arc-anvil instance -- plausibly a knock-on effect of the base-fee call throwing mid-test rather than
   independent findings; not disentangled further here (not this task's code to fix). Full detail and the
   third (ambiguous) failure: `.superpowers/sdd/2026-10-23-arc-launch/task-3-report.md`'s "Fix round 1"
   section.

   **Task 4 resolution.** Only that one test was Arc-caused. On arc-anvil it now skips the cheat and asserts the
   base fee sits at the 20 gwei floor (`ON_ARC_ANVIL` in `packages/sdk/test/global-setup.ts`). The other two
   were test fee assumptions, not knock-on effects: both pinned F = 1.5 gwei (scenario E2) or used a 1e15-wei
   top-up (minor 4), sized for stock anvil's ~1 gwei market. At arc-anvil's ~25 gwei, E2's sweep could not pay
   its own send, and minor 4's top-up was dust, which the daemon correctly reported as "already". On arc-anvil
   both now size F, or the top-up, from the market. `task-4-report.md` has the full diagnosis.
