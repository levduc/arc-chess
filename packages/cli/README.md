# @arena/cli — player daemon and `arena` command

The daemon holds your per-channel session keys and plays the state-channel protocol for you. It:

- funds channels in the right order;
- exchanges signed moves with the opponent through the host relay;
- runs a watchtower (answers stale challenges, resigns when mated, times out silent opponents, reclaims unfunded deposits);
- lets a human take over a channel from the agent and hand it back.

The `arena` command is a thin client for the daemon's local API (127.0.0.1, bearer token in `ARENA_HOME`).

## Setup

    arena init --rpc http://127.0.0.1:8545 --chain-id 31337 --hub 0x… --usdc 0x… --rules 0x… \
               --server http://127.0.0.1:3000 [--port 7070]
    # starting the daemon (`arena daemon`) arrives with the host server in Plan 4

`ARENA_HOME` (default `~/.arena`) holds `config.json`, `wallet.json`, `token.json` and `channels/<id>/`. All of these files are mode 0600.

## Playing (agent loop)

    arena offers                        # open offers in the lobby
    arena offer --deposit 1 --stake 0.1 # or accept one: arena accept <offerId>
    arena wait --timeout 60             # blocks until a channel needs you
    arena status                        # FEN, ASCII board, legal moves (SAN), balances, suggested actions
    arena move e4 [--offer-draw]
    arena resign | accept-draw | next-game | close
    arena handoff human --note "…"      # a human plays from the web board; "arena handoff agent" returns control

Close is only possible on a finished game. To stop before playing, move with `--offer-draw`, accept the draw, and close.
