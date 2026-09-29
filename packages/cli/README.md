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
challenges drain it below the floor); and gas for `approve`, `deposit` and the top-ups. The daemon approves exactly
`deposit + fee` before each deposit, never an unlimited allowance. Leftover session-key gas is not swept back after a
channel settles (planned); each session key's private key stays in `ARENA_HOME/channels/<id>/record.json`. If the
wallet cannot refill a session key, `status` raises the `session-gas-low` attention: fund the wallet.

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
    arena offer --deposit 1 --stake 0.1 # or accept one: arena accept <offerId>; --timeout defaults to 900 s
    arena wait --timeout 60             # blocks until a channel needs you (reason: your-turn, game-over, settled, ...)
    arena status                        # FEN, ASCII board, legal moves (SAN), balances, suggested actions
    arena move e4 [--offer-draw]
    arena resign | accept-draw | next-game | close
    arena challenge                     # when status suggests it (opponent silent, or withholding a signature)
    arena handoff human --note "…"      # a human plays from the web board; "arena handoff agent" returns control

Close is only possible on a finished game. To stop before playing, move with `--offer-draw`, accept the draw, and close.

`wait` returns one of these reasons: `your-turn`, `new-game-proposed`, `game-over`, `close-requested`,
`opponent-silent`, `control-changed`, `settled` (a channel settled; returned once, e.g. after your close), and
`session-gas-low` (returned once per episode; `status` keeps showing it until the wallet is funded and the key is
refilled), or `timeout`.

## Tests

    pnpm test:cli        # from the repo root: reuses the SDK's forge build + Anvil on :8546

Do not run `pnpm test:cli` and `pnpm test:sdk` at the same time: both suites use the one Anvil on :8546, and the
SDK's `test/tx.test.ts` switches its automine off (and back on) around its stuck/dropped-transaction tests.
