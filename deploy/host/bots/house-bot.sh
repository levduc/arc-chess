#!/bin/sh
# The house bot (docker-compose.yml, profile "bots"; README, "House bots"): one `arena bot` that keeps an offer open
# on this host and plays whoever takes it, with the published CLI agents use. Its wallet is the file you created
# (HOUSE_BOT_WALLET_FILE, mounted as a Docker secret): ARENA_HOME/wallet.json is a link to it, so the key is never
# copied onto the bot's volume, and it is never in the environment, on a command line or in the image.
# `docker compose exec house-bot arena <command>` runs the same CLI against the same home (wallet, channels, withdraw).
set -eu

secret=/run/secrets/house_bot_wallet
server=http://arena-server:3000

fail() {
  echo "house-bot: $*" >&2
  exit 1
}

[ -n "${BOT_OWNER:-}" ] || fail "set BOT_OWNER in .env: an address you control on Arc. Withdrawals pay the bot's USDC there, and only there"
[ -r "$secret" ] || fail "cannot read the wallet file (HOUSE_BOT_WALLET_FILE, default secrets/house-bot-wallet.json). Create it as the README's \"House bots\" says, readable by uid 1000"

# The CLI version this host advertises in /templates, unless .env pins ARENA_CLI_VERSION.
version="${ARENA_CLI_VERSION:-}"
if [ -z "$version" ]; then
  version=$(node -e '
    fetch(process.argv[1] + "/templates")
      .then((r) => r.json())
      .then((t) => console.log(t[0].cli.version))
      .catch((e) => { console.error(e.message); process.exit(1); });
  ' "$server") || fail "cannot read the CLI version from $server/templates"
fi
case "$version" in
  "" | *[!0-9.]*) fail "the CLI version \"$version\" is not a plain x.y.z version" ;;
esac

# The wallet file holds {"key": "0x<64 hex>"}, the CLI's own wallet.json format. Checked without printing it.
node -e '
  const k = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).key;
  if (typeof k !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(k)) process.exit(1);
' "$secret" || fail "the wallet file must hold {\"key\": \"0x\" followed by 64 hex characters}"

mkdir -p "$ARENA_HOME"
chmod 700 "$ARENA_HOME"
[ -e "$ARENA_HOME/wallet.json" ] || ln -s "$secret" "$ARENA_HOME/wallet.json"

# The CLI, installed once per version from npm (which checks the tarball against the registry's integrity hash), and
# an `arena` command for `docker compose exec`.
cli="$HOME/cli/$version"
if [ ! -f "$cli/node_modules/$ARENA_CLI_PACKAGE/arena.mjs" ]; then
  npm install --prefix "$cli" --no-audit --no-fund --loglevel=error "$ARENA_CLI_PACKAGE@$version" >/dev/null || fail "npm install $ARENA_CLI_PACKAGE@$version failed"
fi
mkdir -p "$HOME/bin"
printf '#!/bin/sh\nexec node %s "$@"\n' "$cli/node_modules/$ARENA_CLI_PACKAGE/arena.mjs" > "$HOME/bin/arena.tmp"
chmod 755 "$HOME/bin/arena.tmp"
mv "$HOME/bin/arena.tmp" "$HOME/bin/arena"

# init's summary names the RPC URL, which may carry a provider key: only its errors are shown.
set -- init --server "$server" --owner "$BOT_OWNER" --no-faucet
[ -z "${RPC_URL:-}" ] || set -- "$@" --rpc "$RPC_URL"
"$HOME/bin/arena" "$@" >/dev/null || fail "arena init failed (see above)"
"$HOME/bin/arena" wallet
echo "house-bot: $ARENA_CLI_PACKAGE@$version, owner $BOT_OWNER; fund the wallet above (README, \"House bots\"), then it keeps $BOT_OFFERS offer(s) of $BOT_DEPOSIT USDC at $BOT_STAKE USDC per game open"
exec "$HOME/bin/arena" bot --allow-real-chain --deposit "$BOT_DEPOSIT" --stake "$BOT_STAKE" --offers "$BOT_OFFERS"
