#!/usr/bin/env bash
# Plan 6 Task 3 (spec §3): the Arc subset. Runs the contract suite, the SDK/CLI money-moving tests (deposit,
# close, dispute, sweep, top-up, withdraw) and the system dispute e2e against Arc Foundry's `arc-anvil
# --network arc` instead of standard anvil, via the ARENA_ANVIL_BIN / ARENA_TEST_ANVIL_PORT overrides in
# packages/sdk/test/global-setup.ts and tests/system/harness.ts.
#
# Every other suite (`pnpm test:sdk`, `pnpm test:cli`, `pnpm test:contracts`, `pnpm test:system`) is untouched
# -- those overrides default to unset, which is today's behaviour exactly. This script needs no `flock`: its
# ports are distinct from the SDK/CLI suites' shared :8546, and from standard anvil, so it can run in parallel
# with them.
#
# Usage: pnpm test:arc
set -uo pipefail # not -e: every step must run so every Arc-semantics failure is recorded, not just the first

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DIR="$ROOT/tools/bin"

if [[ ! -x "$BIN_DIR/arc-anvil" || ! -x "$BIN_DIR/arc-forge" ]]; then
  echo "==> Arc Foundry not found in tools/bin/, installing"
  "$ROOT/scripts/install-arc-foundry.sh" || exit 1
fi

export ARENA_ANVIL_BIN="$BIN_DIR/arc-anvil"
# Fix round 1 (task-3-review.md Minor-2): each of the four vitest invocations below gets its own port, rather
# than rebinding one shared port back-to-back with no proven margin for the OS to release it between an
# exiting vitest process's anvil.kill() and the next invocation's bind attempt. All four stay inside the
# system-test harness's own 8600-8699 reserved range (tests/system/harness.ts), so its "an explicit preferred
# port outside the reserved range is refused outright" check needs no change for the system step.
ARENA_TEST_ANVIL_PORT_SDK="${ARENA_TEST_ANVIL_PORT_SDK:-8650}"
ARENA_TEST_ANVIL_PORT_CLI="${ARENA_TEST_ANVIL_PORT_CLI:-8651}"
ARENA_TEST_ANVIL_PORT_CLI_SWEEP="${ARENA_TEST_ANVIL_PORT_CLI_SWEEP:-8652}"
ARENA_TEST_ANVIL_PORT_SYSTEM="${ARENA_TEST_ANVIL_PORT_SYSTEM:-8653}"

FAILED=0
step() {
  local label="$1"
  shift
  echo
  echo "=== $label ==="
  if ! "$@"; then
    FAILED=1
    echo "--- FAILED: $label ---"
  fi
}

# A controller review (2026-10-24) caught this writing to the shared contracts/out and contracts/cache that
# every other suite's `forge build` (via packages/sdk/test/global-setup.ts) also targets: a build running
# concurrently with this one (another agent's `test:cli`, in practice) can see a transient ENOENT while this
# one rewrites those files. Arc-forge gets its own, separate, gitignored output/cache (.gitignore) so this step
# never touches contracts/out or contracts/cache at all -- it only ever reads contracts/src and contracts/test.
# `--out`/`--cache-path` resolve relative to `--root contracts`, so these land at contracts/out-arc and
# contracts/cache-arc (both gitignored), not a nested contracts/contracts/...
#
# NOTE: this step and the two below it still share `packages/sdk/test/global-setup.ts`'s plain `forge build`
# into the shared `contracts/out`/`contracts/cache` for the sdk/cli steps -- see tools/arc-foundry.md's "how
# the test infrastructure uses it" for that scope limit (fix round 1, Minor-1); only the dedicated arc-forge
# invocation right here is isolated.
step "contracts (arc-forge test -n arc)" bash -c "cd '$ROOT' && pnpm vectors && '$BIN_DIR/arc-forge' test --root contracts -n arc --out out-arc --cache-path cache-arc"
step "sdk money-moving (lifecycle, hub)" bash -c "cd '$ROOT/packages/sdk' && ARENA_TEST_ANVIL_PORT='$ARENA_TEST_ANVIL_PORT_SDK' pnpm exec vitest run test/lifecycle.test.ts test/hub.test.ts"
step "cli money-moving (daemon, lifecycle, withdraw)" bash -c "cd '$ROOT/packages/cli' && ARENA_TEST_ANVIL_PORT='$ARENA_TEST_ANVIL_PORT_CLI' pnpm exec vitest run test/daemon.test.ts test/lifecycle.test.ts test/withdraw.test.ts"
# Fix round 1 (task-3-review.md Important-1): spec §3 names `sweep` explicitly, and it was missing from this
# subset entirely -- the step above covers deposit/close/dispute/top-up/withdraw, but the only real on-chain,
# exact-accounting sweep test is hardening.test.ts's "Plan 5 Task 1: session-gas sweep" describe block (39
# tests). `-t` runs only that block, not the other 58 (reorg/RPC-retry/settled-index) tests in that 97-test
# file, which spec §3 does not ask for here. This is its own `step()` call, not chained with `&&` after the
# one above: a failure in daemon/lifecycle/withdraw must never silently skip sweep coverage (fix round 1's
# own first attempt at this got that wrong -- an unrelated withdraw.test.ts failure short-circuited past the
# sweep invocation entirely, masking whether sweep coverage ran at all).
step "cli sweep (hardening.test.ts, session-gas sweep only)" bash -c "cd '$ROOT/packages/cli' && ARENA_TEST_ANVIL_PORT='$ARENA_TEST_ANVIL_PORT_CLI_SWEEP' pnpm exec vitest run test/hardening.test.ts -t 'session-gas sweep'"
step "system dispute e2e" bash -c "cd '$ROOT/tests/system' && ARENA_TEST_ANVIL_PORT='$ARENA_TEST_ANVIL_PORT_SYSTEM' pnpm exec vitest run dispute.test.ts"

echo
if [[ "$FAILED" -eq 0 ]]; then
  echo "test:arc: all steps passed"
else
  echo "test:arc: one or more steps failed -- see output above"
fi
exit $FAILED
