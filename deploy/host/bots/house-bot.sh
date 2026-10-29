#!/bin/sh
# The house bot (docker-compose.yml, profile "bots"; README, "House bots"): one `arena bot` that keeps offers open on
# this host and plays whoever takes them, with the published CLI agents use. It runs in the server's image, for its
# Node and its bot-run.mjs.
#
# - The wallet is the file you created (HOUSE_BOT_WALLET_FILE, mounted as a Docker secret). ARENA_HOME/wallet.json is
#   a link to it, so the key is never copied onto the bot's volume, and it is never in the environment, on a command
#   line or in the image.
# - Every CLI command runs through bot-run.mjs, which redacts the bot's RPC URLs from what it prints.
# - Only the first start runs `arena init`. Once the bot's home has a config.json, a restart goes straight to
#   `arena bot`, whatever the arena server or the RPC settings say: the bot is the watchtower of its open channels, and
#   a crash loop would leave them unwatched. A new BOT_RPC_URL (or a new RPC the host publishes) is applied by
#   re-running init only when init can do it: no open channel, and the server reachable. Otherwise the bot keeps its
#   recorded RPC and says so.
# - `docker compose exec house-bot arena <command>` runs the same CLI against the same home.
#
# Test hooks (tests/system/self-host.test.ts): ARENA_SERVER_URL, HOUSE_BOT_SECRET and HOUSE_BOT_RUN replace the
# server URL, the secret's path and bot-run.mjs's path. Compose never sets them.
set -eu

server="${ARENA_SERVER_URL:-http://arena-server:3000}"
secret="${HOUSE_BOT_SECRET:-/run/secrets/house_bot_wallet}"
run="${HOUSE_BOT_RUN:-/app/bot-run.mjs}"
pkg="${ARENA_CLI_PACKAGE:-arc-chess}"
config="$ARENA_HOME/config.json"
offers="${BOT_OFFERS:-1}"

say() { echo "house-bot: $*" >&2; }
fail() {
  say "$*"
  exit 1
}

[ -r "$secret" ] || fail "cannot read the wallet file (HOUSE_BOT_WALLET_FILE, default secrets/house-bot-wallet.json). Create it as the README's \"House bots\" says, readable by uid 1000"
# The wallet file holds {"key": "0x<64 hex>"}, the CLI's own wallet.json format. Checked without printing it.
node -e '
  const k = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).key;
  if (typeof k !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(k)) process.exit(1);
' "$secret" || fail "the wallet file must hold {\"key\": \"0x\" followed by 64 hex characters}"

# One bot per volume. A kernel lock on a file in the volume, held for the container's whole life (the bot inherits the
# descriptor) and released when the container dies, however it dies. It refuses a second container on this volume on
# this machine (`docker compose up --scale house-bot=2`, a copy of the service), which daemon.lock cannot: a pid means
# nothing across containers.
mkdir -p "$HOME"
exec 9>>"$HOME/.house-bot.lock"
flock -n 9 || fail "another house-bot container is using this volume ($HOME): run one bot per volume"

# What the host publishes: its CLI version and its RPC. Empty when the server cannot be reached.
templates=$(node -e '
  fetch(process.argv[1] + "/templates", { signal: AbortSignal.timeout(10000) })
    .then((r) => r.json())
    .then((t) => console.log(`${t[0].cli.version}\n${t[0].rpcUrl}`))
    .catch(() => process.exit(1));
' "$server") || templates=""
host_version=$(printf '%s\n' "$templates" | sed -n 1p)
host_rpc=$(printf '%s\n' "$templates" | sed -n 2p)
[ -n "$templates" ] || say "cannot read $server/templates (the arena server may be restarting)"
if [ ! -f "$config" ]; then
  [ -n "${BOT_OWNER:-}" ] || fail "set BOT_OWNER in .env: an address you control on Arc. Withdrawals pay the bot's USDC there, and only there"
  [ -n "$templates" ] || fail "the bot's first start needs the arena server ($server): it is retried on the next start"
fi

# The CLI: ARENA_CLI_VERSION, else the host's, else the one already installed. Installed once per version from npm,
# which checks the tarball against the registry's integrity hash.
mkdir -p "$HOME/cli" "$HOME/bin"
installed=""
[ ! -f "$HOME/cli/current" ] || installed=$(cat "$HOME/cli/current")
version="${ARENA_CLI_VERSION:-${host_version:-$installed}}"
[ -n "$version" ] || fail "no CLI version to run: $server/templates cannot be read and none is installed yet. It is retried on the next start"
case "$version" in
  *[!0-9.]*) fail "the CLI version \"$version\" is not a plain x.y.z version" ;;
esac
if [ ! -f "$HOME/cli/$version/node_modules/$pkg/arena.mjs" ]; then
  if npm install --prefix "$HOME/cli/$version" --no-audit --no-fund --loglevel=error "$pkg@$version" >/dev/null; then
    :
  elif [ -n "$installed" ] && [ -f "$HOME/cli/$installed/node_modules/$pkg/arena.mjs" ]; then
    say "npm install $pkg@$version failed: running the installed $pkg@$installed"
    version="$installed"
  else
    fail "npm install $pkg@$version failed"
  fi
fi
echo "$version" > "$HOME/cli/current"
printf '#!/bin/sh\nexec node %s node %s "$@"\n' "$run" "$HOME/cli/$version/node_modules/$pkg/arena.mjs" > "$HOME/bin/arena.tmp"
chmod 755 "$HOME/bin/arena.tmp"
mv "$HOME/bin/arena.tmp" "$HOME/bin/arena"
arena() { "$HOME/bin/arena" "$@"; }

mkdir -p "$ARENA_HOME"
chmod 700 "$ARENA_HOME"
# Before any init: an init that found no wallet.json would make a new wallet.
[ -e "$ARENA_HOME/wallet.json" ] || ln -s "$secret" "$ARENA_HOME/wallet.json"

# Re-review N-1: a daemon.lock left by an unclean stop (an OOM kill, a reboot, `docker compose kill`) names a pid of
# the dead container, and this one, started afresh, gets the same pids again. arc-chess 0.1.0 calls a lock naming its
# own pid held, so the bot (and an init) would exit on every start. This container holds the volume lock above, so it
# is the only one using this home: the lock is stale unless its pid is an arena daemon running here right now.
lock_pid=$(node -e '
  const l = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  if (Number.isInteger(l.pid) && l.pid > 0) console.log(l.pid);
' "$ARENA_HOME/daemon.lock" 2>/dev/null) || lock_pid=""
if [ -n "$lock_pid" ]; then
  if [ -r "/proc/$lock_pid/cmdline" ] && tr '\000' ' ' < "/proc/$lock_pid/cmdline" | grep -qE 'arena\.mjs (bot|daemon)( |$)'; then
    say "daemon.lock names pid $lock_pid, an arena daemon running in this container: leaving it"
  else
    say "removing a stale daemon.lock (pid $lock_pid, left by an unclean stop)"
    rm -f "$ARENA_HOME/daemon.lock"
  fi
fi

# init's summary names the RPC URL: only its errors are shown (redacted).
set -- init --server "$server" --no-faucet
[ -z "${BOT_RPC_URL:-}" ] || set -- "$@" --rpc "$BOT_RPC_URL"
if [ ! -f "$config" ]; then
  arena "$@" --owner "$BOT_OWNER" >/dev/null || fail "arena init failed (see above)"
  # The address to fund. A restart skips this: the bot's own start line names it too.
  arena wallet || say "cannot read the wallet's balance right now (the RPC may be rate-limiting)"
else
  recorded=$(node -e 'console.log(JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).rpcUrl ?? "")' "$config" 2>/dev/null) || recorded=""
  want="${BOT_RPC_URL:-$host_rpc}"
  if [ -n "$want" ] && [ "$want" != "$recorded" ]; then
    # Re-review N-3: the log shows RPC URLs as their scheme and host only, so two URLs on one host look the same.
    same=$(node -e '
      try { console.log(new URL(process.argv[1]).host === new URL(process.argv[2]).host ? " (same host: the log shows both URLs the same)" : ""); }
      catch { console.log(""); }
    ' "$want" "$recorded")
    if arena "$@" >/dev/null; then
      say "the bot's RPC changed (BOT_RPC_URL, or the RPC the host publishes)$same"
    else
      say "kept the bot's recorded RPC: init cannot change it now (see above), for instance while a channel is open. The new one differs$same. It is retried on the next start"
    fi
  fi
fi

# Arc mainnet is real USDC: the bot opens offers there only with BOT_ALLOW_MAINNET=1. Without it, it still plays and
# watches the channels it already has.
chain=$(node -e 'console.log(JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).chainId)' "$config")
if [ "$chain" = 5042 ] && [ "${BOT_ALLOW_MAINNET:-}" != 1 ]; then
  say "Arc mainnet: BOT_ALLOW_MAINNET is not 1, so the bot opens no new offers (it still plays and watches its open channels)"
  offers=0
fi

say "$pkg@$version on chain $chain; it keeps $offers offer(s) of ${BOT_DEPOSIT:-1} USDC at ${BOT_STAKE:-0.1} USDC per game open once the wallet above is funded (README, \"House bots\")"
exec "$HOME/bin/arena" bot --allow-real-chain --deposit "${BOT_DEPOSIT:-1}" --stake "${BOT_STAKE:-0.1}" --offers "$offers"
