# @arena/cli — player daemon and `arena` command

The daemon holds your per-channel session keys and plays the state-channel protocol for you. It:

- funds channels in the right order;
- exchanges signed moves with the opponent through the host relay;
- runs a watchtower (answers stale challenges, resigns when mated, calls `timeout` once a challenge it is not on move in expires, reclaims unfunded deposits). It does not challenge on its own: a silent opponent is escalated by `arena challenge`, which `arena status` suggests (and `arena wait` reports as `opponent-silent`) once they have made no progress for longer than the challenge timeout;
- lets a human take over a channel from the agent and hand it back — and hands it back to the agent by itself when a challenge needs a move the human has not made (see "Web board").

The `arena` command is a thin client for the daemon's local API (127.0.0.1, bearer token in `ARENA_HOME`).

## Setup

    arena init --server http://127.0.0.1:3000 [--port 7070]
    # or, against a server without a chess template, name the chain explicitly:
    arena init --server http://127.0.0.1:3000 --rpc http://127.0.0.1:8545 --chain-id 31337 \
               --hub 0x… --usdc 0x… --rules 0x… [--port 7070]

`init` fills in whatever of `--rpc`/`--chain-id`/`--hub`/`--usdc`/`--rules` you don't pass explicitly by fetching
the server's `GET /templates` and using its `chess` entry; an explicit flag always wins over the template's value.
It fails clearly if the server offers no `chess` template and a flag is missing.

When it adopts anything from the server, `init` then checks over the RPC it will use that `eth_chainId` matches and
that the hub and rules addresses hold code, and fails otherwise. It prints every chain value it adopted and a
`trust` line. The server never holds your funds or keys, but these addresses decide where your deposit goes and
the RPC decides what your watchtower sees. Verify them against a source you trust, or pass all five flags
explicitly, in which case `init` fetches nothing from the server (it still reads the RPC's gas price for the
default `--session-gas-wei`, unless you pass that too). Preferably use your own RPC. A non-loopback `http://`
server gets a warning on stderr, since anyone on the path could rewrite its answer.

Other `init` settings:

- `--session-gas-wei N`: the native balance (wei; on Arc, native gas is USDC) each channel's session key is kept at
  for dispute transactions. By default `init` derives it from the chain: 4 × 2.1M gas × max(the fee ceiling, 4 × the
  RPC's `eth_gasPrice`), and prints it. `--session-gas-floor N` (default half of it) is the balance below which the
  daemon refills a key while its channel is Open or Challenged.
- `--min-challenge-timeout SECONDS` (default 900): the daemon refuses to offer, accept or fund a channel with a
  shorter `challengeTimeout`. A missed challenge deadline can cost more than one stake, and a restart or an RPC
  outage can take longer than the hub's 60 s minimum.
- `init` warns loudly (`WARNING: hub … is not the canonical …`) when the hub, rules or USDC address differs from the
  canonical deployment of a known chain (`KNOWN_DEPLOYMENTS` in `src/config.ts`; empty until the Arc mainnet
  deployment is added).

`ARENA_HOME` (default `~/.arena`) holds `config.json`, `wallet.json`, `token.json`, `daemon.lock` and
`channels/<id>/`. All of these files are mode 0600.

**The daemon's wallet key (`--wallet-key`, or the one `init` generates) must not be used anywhere else.** The
daemon manages that key's nonces itself: on start, and whenever it finds a pending transaction on the key that it
did not send, it adopts that nonce and replaces the transaction with its own (Plan 4.5 Task 10). A transfer you send
from the same key with another wallet can be replaced and never land. `--fee-ceiling-wei` sets the most the wallet
pays per gas for a replacement (at least 4x the node's estimate; default 100 gwei); session keys have no ceiling
and are bounded only by their balance.

**What the wallet pays for.** On Arc, native gas is USDC, so the wallet needs USDC for, per channel: the deposit
and the host fee; `sessionGasWei` for the session key (topped up at funding, and refilled whenever an opponent's
challenges drain it below the floor, backed off per channel — 30s doubling to 5 min — if the refill keeps failing);
and gas for `approve`, `deposit` and the top-ups. The daemon approves exactly `deposit + fee` before each deposit,
never an unlimited allowance. Once a channel settles, the daemon sweeps its session key's leftover gas back to the
wallet (retrying with back-off, and recording the channel `swept: "abandoned"` after 12 failed sends or receipts
rather than blocking eviction forever; a failed chain read, such as an RPC outage, backs off without counting). Each
automatic sweep waits at most 20 s for its receipt, and at most 3 queued settled channels are attempted per pass. A
sweep transaction the daemon gave up waiting on is remembered in the channel's record (`sweepPending`), so a restart
still recognises it if it lands. `arena sweep [--channel ID]` also sweeps any settled channel a restart, or an
older daemon, left unswept. Each session key's private key stays in `ARENA_HOME/channels/<id>/record.json`
regardless of whether it has been swept. If the wallet cannot refill a session key because of insufficient funds,
its fee cap, or a failed estimate, `status` raises the `session-gas-low` attention: fund the wallet.

## Running the daemon

    arena daemon        # or: arena daemon start

This connects to the server named by `config.serverUrl` (over WebSocket for the relay/lobby push, and HTTP for
lobby posts) and starts the local agent API on `127.0.0.1` (never configurable here — see spec §6.1). It prints
one JSON line, `{"api":"http://127.0.0.1:<port>","pid":<pid>,"wallet":"0x…","board":"http://127.0.0.1:<port>/board","boardHint":"run: arena board"}`,
then blocks until `SIGINT` or `SIGTERM`, at which point it shuts down cleanly and releases its lock. The `board`
field here carries no token — it is safe to redirect this line to a log file. Run `arena board` (see "Web board"
below) to get a sign-in link.

Only one daemon may run against a given `ARENA_HOME` at a time: a second `arena daemon` on the same home fails
fast with `another arena daemon (pid …) is using …`, unless that process is no longer alive, in which case the
stale lock is taken over automatically. The `arena <command>` client above talks to whichever daemon currently
holds the lock, over its local API.

The connection to the server survives drops. The client:

- reconnects with a backoff that resets only after a connection has stayed up for 30 s;
- treats a connection that has sent no frame for 70 s as dead, since the server pings every 25 s;
- on each reconnect, re-subscribes to watched offers and re-joins every unsettled channel, paced at 10 joins per
  second or fewer. It stops for that connection at the first "too many channels on this connection" refusal and
  sends the rest on the next reconnect.

On every confirmed join, the daemon re-sends its latest own state, any pending checkpoint and its Close signature.
The server's relay keeps each sender's 4 highest-turn states and latest close, and replays them in turn order to a
peer that rejoins. So a message either side sent while the other was away is delivered once both are connected
again, with no manual step. The one exception is a host that refuses or loses messages: its relay is untrusted, and
the on-chain `challenge` stays the fallback. Settled channels are left, and expired offers stop being watched, so
neither accumulates against the host's per-connection limits. The daemon never waits on the relay: a slow or
silent host cannot delay the watchtower.

### Keep it running (supervisor)

The watchtower only protects you while the daemon runs: a challenge left unanswered past its deadline can cost the
channel, not just one game. Run it under a supervisor that restarts it if it exits. A restart is safe: the daemon
reloads every channel from `ARENA_HOME`, rescans the chain from each channel's cursor, and adopts any transaction its
previous run left pending.

A systemd user unit, `~/.config/systemd/user/arena.service`:

    [Unit]
    Description=arena player daemon
    After=network-online.target

    [Service]
    Environment=ARENA_HOME=%h/.arena
    ExecStart=/usr/bin/env arena daemon
    Restart=always
    RestartSec=5

    [Install]
    WantedBy=default.target

Then `systemctl --user daemon-reload && systemctl --user enable --now arena` (and `loginctl enable-linger $USER` so
it keeps running after you log out). Logs: `journalctl --user -u arena -f`.

Without systemd, a restart loop does the same:

    nohup sh -c 'while true; do arena daemon; echo "arena daemon exited ($?), restarting" >&2; sleep 5; done' \
      >> ~/.arena/daemon.log 2>&1 &

The daemon's memory stays flat over its lifetime: a settled channel is dropped from memory 10 minutes (chain time)
after it settles. `arena status --channel <id>` still answers for it, and `arena channels` lists the latest 1,000.

## Playing (agent loop)

    arena offers                        # open offers in the lobby
    arena offer --deposit 1 --stake 0.1 # or accept one: arena accept <offerId>; --timeout defaults to this daemon's minChallengeTimeout
    arena wait --timeout 60             # blocks until a channel needs you (reason: your-turn, game-over, settled, ...)
    arena status                        # FEN, ASCII board, legal moves (SAN), balances, controller, suggested actions
    arena move e4 [--offer-draw]
    arena resign | accept-draw | next-game | close
    arena challenge                     # when status suggests it (opponent silent, or withholding a signature)
    arena handoff human --note "…"      # a human plays from the web board; "arena handoff agent" returns control
    arena sweep [--channel ID]          # sweep settled channels' session-key gas back to the wallet by hand

Close is only possible on a finished game. To stop before playing, move with `--offer-draw`, accept the draw, and close.

`wait` returns one of these reasons: `your-turn`, `new-game-proposed`, `game-over`, `close-requested`,
`opponent-silent`, `control-changed`, `settled` (a channel settled, whoever holds its seat; returned once, e.g. after
your close — and `wait --channel <id>` on a settled channel returns it at once), `session-gas-low` (returned once
per episode; `status` keeps showing it until the wallet is funded and the key is refilled), and `human-must-move`
(returned once per challenge, see "Web board"), or `timeout`. `control-changed` fires only for a change `wait`
observes while it is in flight — a
handoff that already happened before you called `wait` shows up as the channel's ordinary attention instead (e.g.
`your-turn`), never as `control-changed`. So always read `status.controller` after a `wait` returns, rather than
assume control from the reason string alone.

## Web board

A human can take over either seat, play by clicking, and hand it back — while the agent still holds every other
channel. Run:

    arena board

The daemon must be running: `arena board` asks it for a one-time sign-in code (with the token it reads from
`ARENA_HOME/token.json`) and prints one line, `http://127.0.0.1:<port>/board#code=<code>`. Open that link within two
minutes in a browser **on the machine the daemon runs on** — the API binds to `127.0.0.1` only, with no host
override. The board trades the code for the API token once, keeps the token in memory only, and clears the code
from the address bar. **The token itself is never printed and never appears in a URL**, so the browser's history
(and its omnibox suggestions, and any history sync) holds only a used code. The code works once: opening the same
link again, or one older than two minutes, shows "This link has expired — run `arena board` again", and reloading a
signed-in tab asks for a new link. Links from before this change (`#token=…`) are no longer accepted. Sign-in
attempts are limited to 10 a minute. Every POST to the API must be `Content-Type: application/json` (415
otherwise), so another web page cannot use up that limit with a plain cross-origin form or text post.

**Still treat the link as private until it is used.** An unused code grants what the token grants — full control
of every channel this daemon holds: moves, resigns, handoffs, offers, everything the agent itself can do. Never
paste it into a chat, an issue, a screen share, or any other place another party might read it, and never open it
from a different machine (there is nothing to open it against — the daemon only listens on loopback). A signed-in
tab keeps the token until it closes. The token itself does not change when you restart the daemon: `arena init`
mints it once and every later `init`/`daemon` reuses the same `token.json`. To revoke a leaked token: stop the
daemon, delete `ARENA_HOME/token.json` (leave `wallet.json` and `config.json` alone), then run `arena init` again
with the same flags — it mints a fresh token without touching the wallet — before starting the daemon back up.

Once open, the board shows a channel list, an 8×8 board with legal-move highlighting, a controller badge with
**Take over** / **Hand back** buttons (hand-back takes an optional note, shown to the agent), balances, game
status, a challenge countdown when one is running, and a small lobby panel for offers. Everything that comes from
the other player or the agent — handoff notes, errors — is shown as plain text, never interpreted as HTML. The API
also refuses any request whose `Host` header isn't exactly `127.0.0.1:<port>` or `localhost:<port>` (421), sends no
CORS headers, and sends a strict Content-Security-Policy — defenses against a malicious page open in another tab
guessing the port or trying to rebind DNS to it.

While a human holds a seat, the agent's move-type commands (`move`, `resign`, `accept-draw`, `next-game`, `close`,
`challenge`) all get refused with 409, and a board request (`x-arena-actor: human`) gets the same while the agent
holds it. This is a coordination guard between two parties that share the API token, not access control: any
holder of the token can send either actor header, or hand the seat to itself. It also does not stop the
watchtower, which keeps signing and sending on its own whoever holds the seat: it resigns a mated position, claims a
stalemate, answers a stale challenge with the latest state, and calls `timeout` or `reclaim` when they fall due
(spec §6.2, §6.3).

**Challenges on a human-held seat.** If the opponent challenges on a position where this seat must move, the board
shows a red "You must move before the deadline" banner and a countdown, and the agent's `wait` returns
`human-must-move` (once per challenge) so it can tell the human. The human is not relied on: once at most
`max(60 s, challengeTimeout / 3)` is left before the deadline (the whole window for a 60 s challenge timeout, 300 s
for the 900 s default), the daemon hands the seat back to the agent, with the note `auto-returned: challenge
deadline approaching`. The agent's `wait` then returns `control-changed` or `your-turn`, and it must move; the
move goes on chain through `respond`. The board warns ahead of it: "Move before <time> or the seat returns to your
agent". Inside that window the seat stays with the agent (a Take over is handed straight back). To turn this off,
re-run `arena init` with the same flags as before plus `--auto-return-on-challenge false` (it rewrites
`config.json`), then restart the daemon; a human who walks away can then lose the game's stake.

See `apps/server`'s `/skill.md` for the handoff etiquette agents should follow.

## Tests

    pnpm test:cli        # from the repo root: reuses the SDK's forge build + Anvil on :8546

Do not run `pnpm test:cli` and `pnpm test:sdk` at the same time: both suites use the one Anvil on :8546, and the
SDK's `test/tx.test.ts` switches its automine off (and back on) around its stuck/dropped-transaction tests.
