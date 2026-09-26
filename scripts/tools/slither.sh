#!/usr/bin/env bash
# Slither static analysis for the arena contracts (Plan 4.5 Task 4).
#
# Runs from contracts/ against src/ only (lib/, test/, script/ and echidna/ excluded — none of those ship
# to mainnet). Pass bar (see task-4-report.md): zero High or Medium findings on src/, excluding src/dev/
# (MockUSDC is dev-only, never deployed). Low/Informational findings on Plan 4.5 code are fixed or
# annotated with `slither-disable-next-line <detector>` and a justification, matching the house style
# already used throughout ChannelHub.sol; pre-existing annotated findings are left as they are.
#
# Exit code: `--fail-medium` makes this exit 0 exactly when the pass bar above holds (zero Medium-or-High
# findings) and non-zero otherwise, instead of Slither's default of any non-zero finding count.
#
# Usage: pnpm analyze:slither   (or: scripts/tools/slither.sh)
# Requires: uv (uvx) and forge, both on PATH — https://docs.astral.sh/uv/. uv is expected at ~/.local/bin/uv
# if not already on PATH.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SLITHER_VERSION="0.11.6" # latest stable slither-analyzer uvx resolved on 2026-09-26; bump deliberately.

# crytic-compile's Foundry platform shells out to `forge`; make sure it, and uv, are found even if the
# caller didn't already put them on PATH (matches the PATH prefix `pnpm test:contracts` itself needs).
export PATH="$HOME/.local/bin:$HOME/.foundry/bin:$PATH"

cd "$ROOT"
exec uvx --from "slither-analyzer==${SLITHER_VERSION}" slither contracts \
  --filter-paths "lib/|test/|script/|echidna/" --fail-medium "$@"
