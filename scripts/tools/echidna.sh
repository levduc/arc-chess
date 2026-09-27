#!/usr/bin/env bash
# Echidna property fuzzer for ChannelHub (Plan 4.5 Task 4), a second opinion on top of Task 3's deep
# Foundry invariant/fuzz suite. Runs contracts/echidna/HubProperties.sol, a self-contained harness that
# restates invariants 1, 2, 4 and 7 of ChannelHub.invariant.t.sol as `echidna_*` properties.
#
# On first run this downloads the pinned Echidna release archive for linux x86_64 into tools/bin/
# (gitignored) and records its sha256 below; every run re-verifies that checksum against the archive, then
# re-extracts the binary from it (so a tampered *extracted* binary can never be trusted just because it
# already exists on disk).
#
# Echidna 2.x shells out to a separate `crytic-compile` executable (it does not bundle one) found by a plain
# PATH lookup, so this script also writes a tiny pinned wrapper at tools/bin/crytic-compile that runs it via
# `uvx` on demand — repo-local and gitignored, rather than mutating global `uv tool` state.
#
# Usage: pnpm fuzz:echidna   (or: scripts/tools/echidna.sh [extra echidna args...])
# Requires: uv (uvx), forge, curl, sha256sum, tar — uv is expected at ~/.local/bin/uv if not already on PATH.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BIN_DIR="$ROOT/tools/bin"
ECHIDNA_VERSION="2.3.3" # latest stable release on 2026-09-26: https://github.com/crytic/echidna/releases
ECHIDNA_URL="https://github.com/crytic/echidna/releases/download/v${ECHIDNA_VERSION}/echidna-${ECHIDNA_VERSION}-x86_64-linux.tar.gz"
ECHIDNA_SHA256="436d26cb5af34c6c525812b857ac53f218c7f6ad07d69495ef88bc4cdc85c764" # computed on first download
CRYTIC_COMPILE_VERSION="0.4.2" # latest stable crytic-compile uv resolved on 2026-09-26; bump deliberately.

# Foundry (crytic-compile's Foundry platform shells out to `forge`) and uv may not already be on the
# caller's PATH; put tools/bin first so our own crytic-compile wrapper below is what Echidna finds.
export PATH="$BIN_DIR:$HOME/.local/bin:$HOME/.foundry/bin:$PATH"

ECHIDNA_BIN="$BIN_DIR/echidna-${ECHIDNA_VERSION}"
ARCHIVE="$BIN_DIR/echidna-${ECHIDNA_VERSION}-x86_64-linux.tar.gz"

mkdir -p "$BIN_DIR"

if [[ ! -f "$ARCHIVE" ]]; then
  echo "==> Downloading echidna ${ECHIDNA_VERSION} to $ARCHIVE"
  curl -fsSL -o "$ARCHIVE" "$ECHIDNA_URL"
fi

echo "==> Verifying sha256 of $ARCHIVE"
ACTUAL_SHA256="$(sha256sum "$ARCHIVE" | awk '{print $1}')"
if [[ "$ACTUAL_SHA256" != "$ECHIDNA_SHA256" ]]; then
  echo "FATAL: sha256 mismatch for $ARCHIVE" >&2
  echo "  expected: $ECHIDNA_SHA256" >&2
  echo "  actual:   $ACTUAL_SHA256" >&2
  rm -f "$ARCHIVE" # don't leave a bad archive around to be silently reused (or re-"verified") next run
  exit 1
fi

echo "==> Extracting $ECHIDNA_BIN from the verified archive"
tar -xzf "$ARCHIVE" -C "$BIN_DIR" echidna
mv -f "$BIN_DIR/echidna" "$ECHIDNA_BIN"
chmod +x "$ECHIDNA_BIN"

cat > "$BIN_DIR/crytic-compile" <<EOF
#!/usr/bin/env bash
# Repo-local, pinned wrapper (written by scripts/tools/echidna.sh) — lets Echidna's plain PATH lookup for
# "crytic-compile" find a pinned version without a global \`uv tool install\`.
exec uvx --from "crytic-compile==${CRYTIC_COMPILE_VERSION}" crytic-compile "\$@"
EOF
chmod +x "$BIN_DIR/crytic-compile"

cd "$ROOT/contracts"
exec "$ECHIDNA_BIN" echidna/HubProperties.sol --contract HubProperties --config echidna/echidna.yaml "$@"
