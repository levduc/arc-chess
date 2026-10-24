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
  dynamic free-port scan over `8600`-`8699`. Set (only by `scripts/test-arc.sh`), both instead listen on that
  one port -- chosen from within the harness's own `8600`-`8699` reserved range, so the system-test port
  picker's "an explicit preferred port outside the reserved range is refused outright" invariant needs no
  change.

Neither override touches `ports 8545/8080/7070`, `~/.arena`, or `.arena-dev/` (Plan 6 Global Constraints);
they only ever affect anvil instances these test suites start and stop themselves.

## Notable local-simulation gaps found while installing

Running `arc-forge test -n arc --root contracts` (the full existing contract suite, 168 tests, 1500 invariant
runs) against Arc Foundry's execution semantics passed with **zero failures** -- see
`.superpowers/sdd/2026-10-23-arc-launch/task-3-report.md` for the full run. Several things worth recording for
Task 4, found by direct RPC probing against a bare `arc-anvil --network arc` (outside any test suite), none a
contract bug:

1. **The EIP-7708 native-transfer log is emitted** on `arc-anvil --network arc` (from
   `0xffffFFFfFFffffffffffffffFfFFFfffFFFfFFfE`, matching `arc-facts.md`) for a plain native-value transfer,
   confirmed via `eth_sendTransaction` + `eth_getTransactionReceipt`.
2. **`eth_estimateGas` for that same plain native transfer still returns exactly `21000`**, not the `21225`
   `arc-facts.md` reports as observed on real Arc mainnet (the extra ~225 gas for the EIP-7708 log itself).
   `arc-anvil`'s gas estimator does not appear to price that log in. Any Task 4 assertion written as "the
   top-up gas estimate is above 21,000" will not reproduce on `arc-anvil` as installed here. (The independent
   audit above, I-2, confirms 21,000 is also what real Arc mainnet and testnet charge for this transfer on
   12 live transactions it checked -- `arc-facts.md`'s 21,225 figure itself needs correcting, not just this
   simulator's estimate of it.)
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
4. **The one-balance native-USDC model is already live on `arc-anvil --network arc`, independent of chain
   id.** A predeployed proxy contract exists at the ERC-20 USDC address (`0x3600…0000`); calling its
   `balanceOf(account)` returns exactly `eth_getBalance(account) / 1e12` for every default dev account,
   confirmed by direct probe. **This task's `test:arc` subset does not exercise it**: every existing SDK/CLI/
   system-test helper deploys its own ordinary `MockUSDC` and never points the daemon/SDK at
   `0x3600…0000`, and doing so needs `CHAIN_PROFILES` (Task 1) to key in, which needs chain id `5042`/`5042002`
   -- incompatible with every helper's hardcoded viem `foundry` chain (id `31337`) used throughout this
   infrastructure (see point 5). Task 4's one-balance assertions (Review Focus item 1) need a harness variant
   built around that, not just re-running the existing suites.
5. **A blocklist mechanism exists in `arc-anvil`**: its binary contains a `NativeCoinControl`
   precompile with `is_blocklisted`/blocklist-storage logic, and Arc's own docs place a `NativeCoinControl`
   precompile at `0x1800…0001` ("an address blocklist for the native coin", one of five Arc precompiles in the
   `0x1800…` range). A probe of `0x0000000000000000000000000000001800000001` returned empty code in this task
   (wrong address encoding, most likely, not evidence it's absent) -- **not pinned down here**; Task 4 should
   find the exact address/ABI (`docs.arc.io`'s execution-layer reference) and confirm whether it can mark an
   address blocklisted from a local test, which is what spec §3's "if arc-anvil can model the blocklist"
   depends on.
6. **The chain id used by this task's `test:arc` subset is left at Anvil's default `31337`** (`--network arc`
   is passed without `--chain-id`), deliberately: every existing SDK/CLI/system-test helper hardcodes viem's
   `foundry` chain (id `31337`); passing `--chain-id 5042` was confirmed (by hand, outside the suites) to still
   produce the same base-fee floor and EIP-7708 log, but would make every existing `chain: foundry` viem
   client send a transaction with a mismatched chain id and have it rejected. The CLI's chain-id-keyed
   `CHAIN_PROFILES` (`packages/cli/src/chains.ts`, Task 1) therefore does **not** key in on `31337` here --
   Arc-specific CLI behaviour gated on `profile.nativeIsUsdc` etc. needs its own explicit `--chain-id
   5042`/`5042002` coverage, which is Task 4's to add, not assumed by this infrastructure.
