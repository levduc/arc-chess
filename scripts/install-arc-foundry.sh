#!/usr/bin/env bash
# Installs Arc Foundry (circlefin/arc-foundry) -- a fork of Foundry with first-class Arc support -- into
# tools/bin/ (gitignored) as arc-anvil, arc-forge and arc-cast. Plan 6 Task 3 (docs/superpowers/arc-facts.md,
# "Other differences": standard `anvil` does not model native USDC; Arc-accurate local tests need
# `arc-anvil --network arc`, `arc-forge`, `arc-cast`).
#
# Supply-chain rules (Plan 6 Global Constraints):
#   - install from an official pinned release asset only -- never a curl-to-shell installer;
#   - verify its SHA-256 against a value recorded here (the project's own published `.sha256` asset, not just
#     a value this script computed itself);
#   - never run an unverified binary.
#
# Pinned release: circlefin/arc-foundry v0.8.0-2 (published 2026-09-18, latest as of 2026-10-23). See
# tools/arc-foundry.md for the full record (version, source URLs, checksums, and why this version).
#
# Usage: scripts/install-arc-foundry.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DIR="$ROOT/tools/bin"
VERSION="v0.8.0-2"
REPO="circlefin/arc-foundry"

# Supported release targets and their SHA-256, as published by the project itself at
# https://github.com/circlefin/arc-foundry/releases/download/${VERSION}/arc-foundry-${VERSION}-<target>.tar.gz.sha256
# -- downloaded once on 2026-10-23 and cross-checked against GitHub's own `digest` field for each asset
# (api.github.com/repos/circlefin/arc-foundry/releases/tags/${VERSION}): both agree for every target below.
declare -A TARGET_SHA256=(
  [x86_64-unknown-linux-gnu]="088bdb96a84418b757f9825d491e702792f1d1d1e29a9145af305a6600a79556"
  [aarch64-unknown-linux-gnu]="6508a6425bfeab62188698702771478619d4229fda1db038fb01c1050476c805"
  [aarch64-apple-darwin]="90e3eefbf7dd80652fd283a7562e9263301a48797bc2224cc21a3964e2d5db87"
)

# Map this machine to one of the published targets. Arc Foundry has no binary release for Intel macOS,
# Windows or musl-based Linux (tools/arc-foundry.md); on those, refuse rather than silently building from
# source.
OS="$(uname -s)"
ARCH="$(uname -m)"
case "$OS-$ARCH" in
  Linux-x86_64)  TARGET="x86_64-unknown-linux-gnu" ;;
  Linux-aarch64) TARGET="aarch64-unknown-linux-gnu" ;;
  Linux-arm64)   TARGET="aarch64-unknown-linux-gnu" ;;
  Darwin-arm64)  TARGET="aarch64-apple-darwin" ;;
  *)
    echo "FATAL: no verifiable Arc Foundry binary release for $OS-$ARCH." >&2
    echo "  Published targets: ${!TARGET_SHA256[*]}" >&2
    echo "  Arc Foundry is otherwise source-only here (cargo build --release); do not build from source" >&2
    echo "  without approval -- see tools/arc-foundry.md." >&2
    exit 1
    ;;
esac

EXPECTED_SHA256="${TARGET_SHA256[$TARGET]}"
ASSET="arc-foundry-${VERSION}-${TARGET}.tar.gz"
URL="https://github.com/${REPO}/releases/download/${VERSION}/${ASSET}"
ARCHIVE="$BIN_DIR/$ASSET"

mkdir -p "$BIN_DIR"

download() {
  echo "==> Downloading $ASSET ($VERSION, $TARGET)"
  curl -fsSL -o "$ARCHIVE.part" "$URL"
  mv -f "$ARCHIVE.part" "$ARCHIVE"
}

verify() {
  echo "==> Verifying sha256 of $ARCHIVE"
  local actual
  actual="$(sha256sum "$ARCHIVE" | awk '{print $1}')"
  if [[ "$actual" != "$EXPECTED_SHA256" ]]; then
    echo "FATAL: sha256 mismatch for $ARCHIVE" >&2
    echo "  expected: $EXPECTED_SHA256" >&2
    echo "  actual:   $actual" >&2
    rm -f "$ARCHIVE" # never leave a bad archive around to be silently reused next run
    exit 1
  fi
}

if [[ -f "$ARCHIVE" ]]; then
  # Re-verify an already-downloaded archive too -- never trust an existing file on disk without checking it.
  verify
else
  download
  verify
fi

echo "==> Extracting arc-anvil, arc-forge, arc-cast from the verified archive"
TMP_EXTRACT="$(mktemp -d)"
trap 'rm -rf "$TMP_EXTRACT"' EXIT
tar -xzf "$ARCHIVE" -C "$TMP_EXTRACT"
for pair in "anvil:arc-anvil" "forge:arc-forge" "cast:arc-cast"; do
  src="${pair%%:*}"
  dst="${pair##*:}"
  if [[ ! -f "$TMP_EXTRACT/$src" ]]; then
    echo "FATAL: expected '$src' inside $ASSET, not found" >&2
    exit 1
  fi
  install -m 0755 "$TMP_EXTRACT/$src" "$BIN_DIR/$dst"
done

echo "==> Installed:"
for bin in arc-anvil arc-forge arc-cast; do
  printf '    %s -- %s\n' "$bin" "$("$BIN_DIR/$bin" --version | head -1)"
done
