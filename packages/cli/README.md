# @arena/cli — player daemon and `arena` command

The daemon holds your per-channel session keys and plays the state-channel protocol for you. It:

- funds channels in the right order;
- exchanges signed moves with the opponent through the host relay;
- runs a watchtower (answers stale challenges, resigns when mated, calls `timeout` once a challenge it is not on move in expires, reclaims unfunded deposits). It does not challenge on its own: a silent opponent is escalated by `arena challenge`, which `arena status` suggests (and `arena wait` reports as `opponent-silent`) once they have made no progress for longer than the challenge timeout;
- lets a human take over a channel from the agent and hand it back.

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
explicitly, in which case `init` makes no network call. Preferably use your own RPC. A non-loopback `http://`
server gets a warning on stderr, since anyone on the path could rewrite its answer.

`ARENA_HOME` (default `~/.arena`) holds `config.json`, `wallet.json`, `token.json`, `daemon.lock` and
`channels/<id>/`. All of these files are mode 0600.

## Running the daemon

    arena daemon        # or: arena daemon start

This connects to the server named by `config.serverUrl` (over WebSocket for the relay/lobby push, and HTTP for
lobby posts) and starts the local agent API on `127.0.0.1` (never configurable here — see spec §6.1). It prints
one JSON line, `{"api":"http://127.0.0.1:<port>","pid":<pid>,"wallet":"0x…"}`, then blocks until `SIGINT` or
`SIGTERM`, at which point it shuts down cleanly and releases its lock.

Only one daemon may run against a given `ARENA_HOME` at a time: a second `arena daemon` on the same home fails
fast with `another arena daemon (pid …) is using …`, unless that process is no longer alive, in which case the
stale lock is taken over automatically. The `arena <command>` client above talks to whichever daemon currently
holds the lock, over its local API.

The connection to the server survives drops. The client:

- reconnects with a backoff that resets only after a connection has stayed up for 30 s;
- treats a connection that has sent no frame for 70 s as dead, since the server pings every 25 s;
- on each reconnect, re-subscribes to watched offers and re-joins every unsettled channel, paced at 50 joins per
  second or fewer.

On every confirmed join, the daemon re-sends its latest own state, any pending checkpoint and its Close signature.
The server's relay keeps each sender's 4 highest-turn states and latest close, and replays them in turn order to a
peer that rejoins. So a message either side sent while the other was away is delivered once both are connected
again, with no manual step. The one exception is a host that refuses or loses messages: its relay is untrusted, and
the on-chain `challenge` stays the fallback. Settled channels are left, and expired offers stop being watched, so
neither accumulates against the host's per-connection limits. The daemon never waits on the relay: a slow or
silent host cannot delay the watchtower.

## Playing (agent loop)

    arena offers                        # open offers in the lobby
    arena offer --deposit 1 --stake 0.1 # or accept one: arena accept <offerId>
    arena wait --timeout 60             # blocks until a channel needs you
    arena status                        # FEN, ASCII board, legal moves (SAN), balances, suggested actions
    arena move e4 [--offer-draw]
    arena resign | accept-draw | next-game | close
    arena challenge                     # when status suggests it (opponent silent, or withholding a signature)
    arena handoff human --note "…"      # a human plays from the web board; "arena handoff agent" returns control

Close is only possible on a finished game. To stop before playing, move with `--offer-draw`, accept the draw, and close.
