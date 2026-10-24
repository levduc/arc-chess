#!/usr/bin/env bash
# Verifies ChessRules and ChannelHub source on a Blockscout explorer (Plan 6, Task 5's rehearsal doc,
# "Source verification"). Mainnet reuses this unchanged by pointing ARENA_CHAIN_ID/ARENA_EXPLORER_URL at the
# mainnet chain/explorer: addresses come from contracts/deployments/<chainId>.json and constructor tx hashes
# from contracts/broadcast/Deploy.s.sol/<chainId>/run-latest.json -- both written by Deploy.s.sol itself.
#
# This script sends no transaction: every request is a read (GET) or a submission to an explorer/verifier's
# own HTTP API (POST), never an RPC call that reaches the chain's mempool.
#
# Why two services, in this order:
#   1. Blockscout's own standard-input recompile-and-match (the "normal" path; tried first, optimistically).
#      On the Arc testnet explorer as of 2026-10-24, this reliably FAILS for both contracts -- confirmed by
#      submitting via two independent routes (direct, and Sourcify's own forwarding of the identical
#      standard-json input to the same Blockscout endpoint) and seeing the same generic
#      "Fail - Unable to verify" both times, despite Blockscout's own /verification/config listing the exact
#      solc build and cancun evmVersion as supported, and dozens of other contracts verifying fine on this
#      instance. Of a 120-contract sample of already-verified contracts here, zero used viaIR -- consistent
#      with (not proof of) this instance's local matcher having a viaIR-specific bug, since both of our
#      contracts are viaIR builds (contracts/foundry.toml: via_ir = true) and both failed identically.
#   2. Sourcify's independent recompiler (https://sourcify.dev), fed the exact same standard-json input,
#      returns creationMatch/runtimeMatch "exact_match" for both contracts in under 6 seconds each -- proving
#      the standard-json input itself (viaIR, solc version, optimizer, evmVersion, remappings, metadata
#      settings) is correct and that step 1's failure is on Blockscout's side, not ours.
#   3. Once Sourcify has a match, fetching its stored metadata.json + sources and POSTing them to
#      Blockscout's own `/verification/via/sourcify` import endpoint DOES flip Blockscout's `is_verified` to
#      true -- it imports Sourcify's already-computed match instead of re-deriving one with the same local
#      matcher that fails in step 1. This is what actually gets the explorer page to show verified source.
#
# Usage:
#   scripts/verify-arc.sh                       # verify both contracts for chain 5042002
#   scripts/verify-arc.sh chessRules             # verify only ChessRules
#   scripts/verify-arc.sh channelHub             # verify only ChannelHub
#
# Env overrides (all optional; defaults match the testnet rehearsal):
#   ARENA_CHAIN_ID       default 5042002
#   ARENA_EXPLORER_URL   default https://explorer.testnet.arc.io  (a Blockscout instance)
#   ARENA_SOURCIFY_URL   default https://sourcify.dev/server
#   ARENA_LICENSE_TYPE   default "none" (one of /api/v2/smart-contracts/verification/config's license_types)
#   ARENA_VERIFY_CONTACT an email/URL for Sourcify's User-Agent, per its "send a descriptive User-Agent" rule
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTRACTS_DIR="$ROOT/contracts"
export PATH="$HOME/.foundry/bin:$PATH"

CHAIN_ID="${ARENA_CHAIN_ID:-5042002}"
EXPLORER_URL="${ARENA_EXPLORER_URL:-https://explorer.testnet.arc.io}"
SOURCIFY_URL="${ARENA_SOURCIFY_URL:-https://sourcify.dev/server}"
LICENSE_TYPE="${ARENA_LICENSE_TYPE:-none}"
CONTACT="${ARENA_VERIFY_CONTACT:-noreply@example.com}"
DEPLOYMENTS_FILE="$CONTRACTS_DIR/deployments/$CHAIN_ID.json"
RUN_LATEST="$CONTRACTS_DIR/broadcast/Deploy.s.sol/$CHAIN_ID/run-latest.json"

if [[ ! -f "$DEPLOYMENTS_FILE" ]]; then
  echo "FATAL: $DEPLOYMENTS_FILE not found -- deploy first (contracts/script/Deploy.s.sol)." >&2
  exit 1
fi
if [[ ! -f "$RUN_LATEST" ]]; then
  echo "FATAL: $RUN_LATEST not found -- can't recover constructor tx hashes for Sourcify." >&2
  exit 1
fi

CHESS_ADDR="$(jq -r '.chessRules' "$DEPLOYMENTS_FILE")"
HUB_ADDR="$(jq -r '.channelHub' "$DEPLOYMENTS_FILE")"

# The short solc version (e.g. "0.8.28") pinned in contracts/foundry.toml's [profile.default]. Read from
# foundry.toml itself, not hardcoded, so a solc bump there doesn't need a matching edit here -- mainnet's
# foundry.toml is the same file, so this needs no override unless ARENA_SOLC_VERSION is set explicitly.
SOLC_VERSION="${ARENA_SOLC_VERSION:-$(grep -E '^\s*solc_version\s*=' "$CONTRACTS_DIR/foundry.toml" | head -1 | sed -E 's/^[^"]*"([^"]+)".*/\1/')}"
if [[ -z "$SOLC_VERSION" ]]; then
  echo "FATAL: could not read solc_version from $CONTRACTS_DIR/foundry.toml -- set ARENA_SOLC_VERSION." >&2
  exit 1
fi

tx_hash_for() {
  jq -r --arg name "$1" '.transactions[] | select(.contractName == $name) | .hash' "$RUN_LATEST"
}

WHAT="${1:-both}"
WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

# Short solc version (e.g. "0.8.28") as pinned in contracts/foundry.toml, resolved against the explorer's own
# verification/config list to the exact "v<ver>+commit.<hash>" string it (and Sourcify) expect -- so a solc
# point-release bump doesn't silently go stale here.
blockscout_compiler_version() {
  local short="$1"
  curl -fsS -m 20 "$EXPLORER_URL/api/v2/smart-contracts/verification/config" \
    | jq -r --arg v "$short" '.solidity_compiler_versions[] | select(startswith("v" + $v + "+"))' \
    | head -1
}

is_verified() {
  curl -fsS -m 15 "$EXPLORER_URL/api/v2/smart-contracts/$1" 2>/dev/null \
    | jq -r '.is_verified // false' 2>/dev/null || echo false
}

# Step 1: optimistic, best-effort standard-input submission straight to Blockscout. Non-fatal on failure --
# see the header comment for why this is currently expected to fail on Arc testnet but is cheap to keep
# trying (a future Blockscout update may fix the local viaIR matcher, at which point this step alone
# succeeds and steps 2-3 become unnecessary, harmless no-ops).
try_blockscout_standard_input() {
  local addr="$1" contract_path_name="$2" autodetect="$3" ctor_args_hex="${4:-}"
  local input_file="$WORKDIR/$addr.std.json"
  (cd "$CONTRACTS_DIR" && forge verify-contract --show-standard-json-input "$addr" "$contract_path_name") \
    > "$input_file"
  local cv
  cv="$(blockscout_compiler_version "$SOLC_VERSION")"
  echo "    (best-effort) submitting standard-input to Blockscout, compiler_version=$cv"
  if [[ "$autodetect" == "true" ]]; then
    curl -fsS -m 30 -X POST "$EXPLORER_URL/api/v2/smart-contracts/$addr/verification/via/standard-input" \
      -F "compiler_version=$cv" -F "license_type=$LICENSE_TYPE" \
      -F "autodetect_constructor_args=true" \
      -F "files[0]=@$input_file;type=application/json;filename=input.json" \
      > /dev/null 2>&1 || true
  else
    curl -fsS -m 30 -X POST "$EXPLORER_URL/api/v2/smart-contracts/$addr/verification/via/standard-input" \
      -F "compiler_version=$cv" -F "license_type=$LICENSE_TYPE" \
      -F "autodetect_constructor_args=false" -F "constructor_args=$ctor_args_hex" \
      -F "files[0]=@$input_file;type=application/json;filename=input.json" \
      > /dev/null 2>&1 || true
  fi
}

# Step 2: submit the same standard-json input to Sourcify, which runs its own independent compiler --
# unaffected by whatever makes Blockscout's local matcher fail. Polls its job (usually done in under 10s).
sourcify_verify() {
  local addr="$1" contract_id="$2" tx_hash="$3"
  local input_file="$WORKDIR/$addr.std.json"
  local cv
  cv="$(blockscout_compiler_version "$SOLC_VERSION" | sed 's/^v//')"
  local body_file="$WORKDIR/$addr.sourcify-body.json"
  jq -n --slurpfile std "$input_file" --arg cv "$cv" --arg cid "$contract_id" --arg tx "$tx_hash" \
    '{stdJsonInput: $std[0], compilerVersion: $cv, contractIdentifier: $cid, creationTransactionHash: $tx}' \
    > "$body_file"

  echo "    submitting to Sourcify ($contract_id)"
  local submit
  submit="$(curl -fsS -m 30 -X POST "$SOURCIFY_URL/v2/verify/$CHAIN_ID/$addr" \
    -H "Content-Type: application/json" \
    -H "User-Agent: agent-chess-arena-verify-arc.sh/1.0 (contact: $CONTACT)" \
    --data-binary "@$body_file")"
  local verification_id
  verification_id="$(echo "$submit" | jq -r '.verificationId // empty')"
  if [[ -z "$verification_id" ]]; then
    echo "    Sourcify submission did not return a verificationId: $submit" >&2
    return 1
  fi

  local delays=(5 10 15 20) elapsed=0
  for d in "${delays[@]}"; do
    sleep "$d"
    elapsed=$((elapsed + d))
    local status
    status="$(curl -fsS -m 20 "$SOURCIFY_URL/v2/verify/$verification_id")"
    if [[ "$(echo "$status" | jq -r '.isJobCompleted // false')" == "true" ]]; then
      local match
      match="$(echo "$status" | jq -r '.contract.match // "null"')"
      echo "    Sourcify job done after ${elapsed}s: match=$match"
      [[ "$match" == "exact_match" || "$match" == "match" ]]
      return $?
    fi
    echo "    Sourcify job still running after ${elapsed}s"
  done
  echo "    Sourcify job did not complete within $elapsed s" >&2
  return 1
}

# Step 3: fetch Sourcify's own metadata.json + source files for this (now-matched) contract, and hand them to
# Blockscout's /verification/via/sourcify import endpoint, which trusts an externally-computed match rather
# than recompiling locally -- this is the step that actually flips Blockscout's is_verified to true.
import_sourcify_into_blockscout() {
  local addr="$1"
  local import_dir="$WORKDIR/$addr-import"
  mkdir -p "$import_dir"

  local resp
  resp="$(curl -fsS -m 20 "$SOURCIFY_URL/v2/contract/$CHAIN_ID/$addr?fields=metadata,sources")"
  echo "$resp" | jq '.metadata' > "$import_dir/metadata.json"

  local paths curl_args
  mapfile -t paths < <(echo "$resp" | jq -r '.sources | keys[]')
  curl_args=(-F "files[0]=@$import_dir/metadata.json;type=application/json;filename=metadata.json")
  local i=1
  for p in "${paths[@]}"; do
    local dest="$import_dir/$p"
    mkdir -p "$(dirname "$dest")"
    echo "$resp" | jq -r --arg p "$p" '.sources[$p].content' > "$dest"
    curl_args+=(-F "files[$i]=@$dest;type=text/plain;filename=$p")
    i=$((i + 1))
  done

  echo "    importing Sourcify's match into Blockscout ($((i)) files)"
  local result
  result="$(curl -fsS -m 60 -X POST "$EXPLORER_URL/api/v2/smart-contracts/$addr/verification/via/sourcify" \
    "${curl_args[@]}")"
  echo "    Blockscout import response: $result"
}

verify_one() {
  local label="$1" addr="$2" contract_path_name="$3" contract_id="$4" tx_hash="$5" autodetect="$6" ctor_args_hex="${7:-}"
  echo "==> $label ($addr)"

  if [[ "$(is_verified "$addr")" == "true" ]]; then
    echo "    already verified on Blockscout -- skipping"
    return 0
  fi

  try_blockscout_standard_input "$addr" "$contract_path_name" "$autodetect" "$ctor_args_hex"
  if [[ "$(is_verified "$addr")" == "true" ]]; then
    echo "    verified on Blockscout directly"
    return 0
  fi

  if sourcify_verify "$addr" "$contract_id" "$tx_hash"; then
    import_sourcify_into_blockscout "$addr"
  else
    echo "    Sourcify did not produce a match either -- see the bytecode diff guidance in" \
      "docs/superpowers/arc-testnet-rehearsal.md" >&2
  fi

  # Blockscout's import only *starts* verification ("Smart-contract verification started"): is_verified flips
  # seconds later. Plan 6 Task 5's redeploy read it at once, saw false, and set -e stopped the run before
  # ChannelHub -- so poll for up to 90 s.
  local final waited=0
  final="$(is_verified "$addr")"
  while [[ "$final" != "true" && "$waited" -lt 90 ]]; do
    sleep 5
    waited=$((waited + 5))
    final="$(is_verified "$addr")"
  done
  echo "    final Blockscout is_verified=$final (after ${waited}s) -- $EXPLORER_URL/address/$addr#code"
  [[ "$final" == "true" ]]
}

verify_chess_rules() {
  verify_one "ChessRules" "$CHESS_ADDR" "src/chess/ChessRules.sol:ChessRules" \
    "src/chess/ChessRules.sol:ChessRules" "$(tx_hash_for ChessRules)" true
}

verify_channel_hub() {
  if [[ "$(is_verified "$HUB_ADDR")" == "true" ]]; then
    echo "==> ChannelHub ($HUB_ADDR)"
    echo "    already verified on Blockscout -- skipping (no ARENA_OWNER/ARENA_FEE_RECIPIENT needed)"
    return 0
  fi

  # ChannelHub takes constructor args; Blockscout's standard-input path needs them explicit (ABI-encoded),
  # read from the same ARENA_* env vars contracts/script/Deploy.s.sol reads, with the same defaults, so
  # mainnet needs nothing but different values for these vars (and ARENA_EXPLORER_URL/ARENA_CHAIN_ID). Only
  # required once we actually need to submit -- not just to check whether it's already verified.
  local owner fee_recipient fee_per_player max_fee_per_player max_deposit_per_player max_committed_escrow token
  owner="${ARENA_OWNER:?set ARENA_OWNER (same value used at deploy time)}"
  fee_recipient="${ARENA_FEE_RECIPIENT:?set ARENA_FEE_RECIPIENT (same value used at deploy time)}"
  fee_per_player="${ARENA_FEE_PER_PLAYER:-5000}"
  max_fee_per_player="${ARENA_MAX_FEE_PER_PLAYER:-1000000}"
  max_deposit_per_player="${ARENA_MAX_DEPOSIT_PER_PLAYER:-10000000}"
  max_committed_escrow="${ARENA_MAX_COMMITTED_ESCROW:-1000000000}"
  token="${ARENA_TOKEN:-$(jq -r '.token' "$DEPLOYMENTS_FILE")}"

  local ctor_args
  ctor_args="$(cast abi-encode \
    "constructor(address,address,address,uint256,uint256,uint256,uint256)" \
    "$token" "$owner" "$fee_recipient" "$fee_per_player" "$max_fee_per_player" \
    "$max_deposit_per_player" "$max_committed_escrow" | sed 's/^0x//')"

  verify_one "ChannelHub" "$HUB_ADDR" "src/ChannelHub.sol:ChannelHub" \
    "src/ChannelHub.sol:ChannelHub" "$(tx_hash_for ChannelHub)" false "$ctor_args"
}

case "$WHAT" in
  chessRules) verify_chess_rules ;;
  channelHub) verify_channel_hub ;;
  both)
    verify_chess_rules
    verify_channel_hub
    ;;
  *)
    echo "FATAL: unknown target '$WHAT' (expected chessRules, channelHub or both)" >&2
    exit 1
    ;;
esac
