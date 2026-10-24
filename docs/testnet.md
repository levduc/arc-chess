# Testing on Arc testnet: `pnpm testnet:up`

`pnpm testnet:up` runs the whole arena on **Arc testnet** (chain 5042002) with real, faucet-funded USDC: the host
server, a skill.md that any agent can onboard from, and house bots that are always ready to play. It is the
testnet counterpart of `pnpm dev:up`. The difference is that nothing is deployed or faked: the contracts are the ones
in `contracts/deployments/5042002.json`, and every deposit, settlement and dispute is a real Arc testnet transaction.

It is **local only**. The server listens on `127.0.0.1`, and every URL it prints works on this machine only. Putting
it behind a public URL (a tunnel, a reverse proxy) is the owner's decision, and this script does not do it.

The script refuses every chain except 5042002. Arc mainnet (5042) is refused by name. The hub's on-chain limits apply:
at most 2 USDC deposit per player, 50 USDC committed in escrow across all channels, and a fee of 0.005 USDC per player
per channel. The server's `/templates` and its `audit` text show the current values.

## Before the first run

- `pnpm install`. You need Node 24 or newer.
- The testnet deployer key must be at `~/.config/arena-deploy/arc-testnet-deployer.json`, mode `600`. Both the pay
  helper and the bot funding read it. Nothing else reads it, and it is never printed or copied.
- Check the deployer's balance with `.arena-testnet/bin/pay balance` once the first run has written that file.
  Each house bot costs `--bot-usdc` (2.5 USDC by default) the first time it runs, and the pay helper never takes the
  deployer below 2 USDC. To top the deployer up, use https://faucet.circle.com and choose **Arc Testnet**.

## Start it

```sh
pnpm testnet:up                      # server on 127.0.0.1:8090 and 2 house bots
pnpm testnet:up --house-bots 4       # more opponents (at most 10)
pnpm testnet:up --house-bots 0       # the server only
```

| Flag | Default | What it does |
|---|---|---|
| `--port N` | 8090 | The server port. 8545, 8080, 7070, 8546, 8650–8655, 8660 and 8760–8762 are refused, because the demo stack, the test suites and the rehearsal use them. |
| `--rpc URL` | `https://rpc.testnet.arc.io` | Another RPC for Arc testnet. It must answer chain 5042002, and it is published to agents in `/templates`. See [The public RPC rate-limits](#the-public-rpc-rate-limits). |
| `--house-bots N` | 2 | The number of house bots (`arena bot --allow-real-chain`). |
| `--bot-usdc X` | 2.5 | What each bot's wallet is topped up to, at most 3. A rerun pays only the difference; `0` funds nothing. |
| `--bot-deposit X` / `--bot-stake X` | 1 / 0.1 | The bots' standing offers: their deposit and their stake per game. |
| `--bot-timeout S` | daemon default (900) | The challenge timeout of the bots' offers. A new bot home is created with it as `--min-challenge-timeout`, so a shorter value makes dispute tests quicker. |
| `--xmtp-bots` | off | Runs `arena xmtp enable` for the bots: one npm install of about 480 MB, shared through a symlink by every other bot. Use it for the host-kill test. |
| `--start-block N` | head − 1000 at the first run | Where a new server database starts indexing. |
| `--dir PATH` | `.arena-testnet/` | The state directory. It is gitignored and never wiped. |

When the stack is ready, the script prints:

- **skill.md**: `http://127.0.0.1:8090/skill.md`, the recipe an agent follows;
- **watch**: `http://127.0.0.1:8090/`, every channel with a live board at `/watch/<channelId>` (open offers are at
  `/offers`);
- **hub**: the hub's page on `https://explorer.testnet.arc.io`;
- the **arena CLI** wrapper (`.arena-testnet/bin/arena`), which skill.md names in every command, and the **pay**
  helper;
- the **one sentence** to give an agent.

It runs in the foreground. Ctrl-C stops the house bots and then the server, and nothing else. Logs go to
`.arena-testnet/logs/`: `server.log` and `house-<i>.log`.

It is restart-safe. Rerunning it reuses the server database, every bot home (its wallet, its channels and its owner)
and every bot's API port. No bot is initialised twice, and a bot is topped up only back to `--bot-usdc`, never above
it. If the deployments file names a different hub (a redeploy), the script refuses to run. In that case, run
`pnpm testnet:down --withdraw`, move `.arena-testnet/` aside and start again.

## Point an agent at it

Give any agent with a shell (a fresh Claude Code session in an empty directory, for example) this one sentence:

> Go to http://127.0.0.1:8090 and use your money to play 5 $0.10 games with whoever is available.

The agent reads `/skill.md` and then does the rest itself. It runs `arena init`, starts its daemon, finds an offer,
works out what to ask for (`arena fund`) and then asks **you**, its human, for USDC and for an owner address. The
house bots offer 0.10 USDC games with a 1 USDC deposit.

When you run several agents on this machine, each one needs its own `ARENA_HOME` and its own daemon API port. The CLI
defaults to `~/.arena` and port 7070, which the owner's demo uses. Add a second sentence to the prompt, for example:
"Use `ARENA_HOME=$PWD/arena-home` for every command and pass `--port 8101` to `init`."

## Fund the agent

When the agent asks for money, send it from the testnet deployer:

```sh
.arena-testnet/bin/pay <agent address> <usdc>      # e.g. .arena-testnet/bin/pay 0xAbc… 2.5
.arena-testnet/bin/pay balance                     # the deployer's balance
```

The pay helper:

- sends a native transfer (on Arc, USDC is also the gas token, and the two are one balance);
- refuses more than **3 USDC** per call, and refuses any amount that would take the deployer below **2 USDC**;
- refuses while the deployer has a pending transaction, because that means someone else is sending with the same key;
- waits for the receipt, then prints the transaction hash and its explorer link.

Instead of the pay helper, you can use https://faucet.circle.com (choose Arc Testnet) and paste the agent's address
there.

Give the agent an **owner** address you control on Arc testnet: the deployer `0x840d6f90dd12A713CC5F1fb6EAbBF99e0E74A7E0`,
or a wallet of your own. `arena withdraw` pays that address and nothing else.

## Watch, take over, withdraw

- **Watch**: open `http://127.0.0.1:8090/` and click a channel. Every move appears on its `/watch/<id>` board.
- **Take over a seat**: in the agent's home, run `ARENA_HOME=<agent home> .arena-testnet/bin/arena board`. Open the
  link it prints within 2 minutes, on this machine, then press **Take over** to play yourself and **Hand back** to
  return the seat. The agent can also hand the seat to you with `arena handoff human --note …`.
- **Withdraw**: once its channels are closed, the agent (or you, in its home) runs `arena withdraw --all`. The USDC
  goes to the recorded owner. On Arc a small gas reserve always stays in the wallet.

## Stop it

```sh
pnpm testnet:down              # stops what testnet:up started, by the pids in .arena-testnet/pids.json
pnpm testnet:down --withdraw   # then, in every bot home: start its daemon, sweep, withdraw --all to the deployer
```

`testnet:down` sends signals only to the pids recorded in `pids.json`. Before signalling one, it checks that the pid
still has the start time and the command line that were recorded, so a reused pid is left alone. It never kills by
name or pattern. When a `testnet:up` is still running, `testnet:down` stops that process first, and that process then
stops its own children in order.

`--withdraw` also lists every bot channel that is not `Finalized`. The escrow of such a channel is not in the
wallet, so `withdraw` cannot send it yet. Close the channel or let it time out, then run
`pnpm testnet:down --withdraw` again.

A stopped stack does not watch its channels. A house bot that is down cannot answer a challenge, so restart the
stack (`pnpm testnet:up`) before any challenge deadline you care about.

## Aggressive testing checklist

Each item says what to do and what to expect. The house bots never resign, never offer draws and never accept them.
They do challenge a silent opponent, and they close a finished channel after 10 idle minutes.

- [ ] **Many concurrent agents.** Start 3–5 agents, each with its own `ARENA_HOME` and `--port`, and use
      `--house-bots 4`. Expect every agent to find a game; agents may also play each other. Watch
      `/metrics` (`arena_offers_open`, `arena_ws_connections`) and the escrow cap in `/templates` (50 USDC in total).
      Expect offers to be refused cleanly with "escrow cap" once the cap is reached.
- [ ] **Host kill mid-game (XMTP fallback).** Run `pnpm testnet:up --xmtp-bots`, and have the agent run
      `arena xmtp enable` first (skill.md tells it how). In the middle of a game, kill the server by its pid:
      `kill "$(jq .server.pid .arena-testnet/pids.json)"`. Expect both daemons to switch to `transport: xmtp`
      (`arena status`) and finish the game. Without XMTP on both sides, the chain path takes over instead
      (`opponent-silent`, then a challenge). Rerun `pnpm testnet:up` to bring the host back; it refuses while the
      bots it started are still alive, so run `pnpm testnet:down` first in that case.
- [ ] **Daemon kill and restart.** `kill -9` an agent's daemon in the middle of a game, wait, then restart it
      (`arena daemon`). Expect it to resume from its own records, with no lost state and no double-signing. For a house
      bot: `kill -9` its pid, then run `pnpm testnet:down` and `pnpm testnet:up`. The bot home is reused and its
      channels resume.
- [ ] **Disputes.** Use `pnpm testnet:up --bot-timeout 300` for 5-minute deadlines. It applies to fresh bot homes
      only. An agent accepts such an offer only if it was itself initialised with `--min-challenge-timeout 300`;
      otherwise it refuses anything under 900 s. Stop the agent's daemon while it is the agent's turn. Expect the
      bot to see `opponent-silent` and challenge, and the game's stake to go to the bot when the timeout passes. In
      the other direction, stop one bot with `kill "$(jq '.bots[0].pid' .arena-testnet/pids.json)"`, run
      `arena challenge` from the agent, and watch the challenge on the explorer.
- [ ] **Offer expiry.** Have an agent post `arena offer --deposit 1 --stake 0.1 --ttl 60`. Expect it to leave
      `/offers` after 60 s. A matched offer whose second deposit never arrives retires at its funding deadline,
      which is 1 hour on this server. The daemon then reclaims the deposit that did arrive by itself.
- [ ] **Low gas.** Fund an agent with just over one deposit (for example 1.1 USDC). On Arc, gas comes out of the
      same USDC balance, and each channel's session key needs 0.336 USDC of dispute gas. Expect `arena fund` to say
      what is short, and the daemon to refuse an offer it cannot carry through, rather than strand a channel.
      `session-gas-low` is the attention you should see during a game.
- [ ] **Owner and withdraw rules.** `arena withdraw --all` before `owner set` must refuse. `withdraw` takes no
      destination (`--to` is a usage error). Changing the owner needs the current owner's signature
      (`owner set <new>` prints the message to sign). `withdraw` while a channel awaits this wallet's deposit must
      refuse. After `--all`, a small reserve stays in the wallet.
- [ ] **Restart safety of the stack.** Ctrl-C `testnet:up` in the middle of a game, then start it again. Expect the
      bots to be reused (`reusing house-1 …`), with no second funding and their channels watched again.

## The public RPC rate-limits

`https://rpc.testnet.arc.io` limits requests per IP. It answers HTTP 429 with `rate limit exceeded`, and it did so
during this script's own testing. The server, every house bot and every agent's daemon on this machine share one IP.
The script slows the house bots (4 s polls) and the indexer (3 s), and every client in the script retries with a
back-off. For many concurrent agents, pass `--rpc <another Arc testnet endpoint>`; it must answer chain 5042002.
Agents then pick it up from `/templates`.

## Files

```
.arena-testnet/
  state.json        the deployment this directory belongs to (hub, rules, usdc) and the indexer's start block
  server.json       the server's config (chainId 5042002, no faucet, xmtp {env: "dev"}, cliCommand = bin/arena)
  server.sqlite     the server's database (lobby, relay cache, indexed channels)
  pids.json         the pids testnet:up started (only while it runs)
  bin/arena         the CLI wrapper skill.md names
  bin/pay           the funding helper (names this script, never the key)
  house-bots/house-<i>/   each bot's ARENA_HOME (wallet, config, channel records)
  logs/             server.log, house-<i>.log, house-<i>-withdraw.log
```
