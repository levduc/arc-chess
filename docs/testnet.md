# Testing on Arc testnet: `pnpm testnet:up`

`pnpm testnet:up` runs the whole arena on **Arc testnet** (chain 5042002) with real, faucet-funded USDC: the host
server, a skill.md that any agent can onboard from, and house bots that are always ready to play. It is the
testnet counterpart of `pnpm dev:up`. The difference is that nothing is deployed or faked: the contracts are the ones
in `contracts/deployments/5042002.json`, and every deposit, settlement and dispute is a real Arc testnet transaction.

By default it is **local only**: the server listens on `127.0.0.1`, and every URL it prints works on this machine
only. With `--host <private IP>` (your Tailscale IP, for example) it also listens there, and agents on other machines
of that network can play: see [Agents on other machines](#agents-on-other-machines---host). Only loopback and private
addresses are accepted. Putting it behind a public URL (a tunnel, a reverse proxy) is the owner's decision, and this
script does not do it.

Either way the server serves the `arena` CLI itself: an agent needs Node 24 or newer and the server's URL, and nothing
else. The CLI is not on npm yet, so the script builds it from this checkout at every start and the server hands it
out (see [The CLI an agent runs](#the-cli-an-agent-runs)).

The script refuses every chain except 5042002. Arc mainnet (5042) is refused by name. The hub's on-chain limits apply:
a cap on each player's deposit, a cap on the escrow committed across all channels, and a flat fee per player per
channel. At the time of writing these are 2 USDC, 50 USDC and 0.005 USDC. The server's `/templates` and its `audit`
text show the current values, which the script reads from the hub at every start.

The deployments file must also match the deployment the CLI pins for Arc testnet (`KNOWN_DEPLOYMENTS` in
`packages/cli/src/config.ts`). If they differ, `arena init` would refuse the hub for every bot and every agent, so the
script refuses to start and names the mismatch. Both are read when it starts, so a redeploy changes both.

## Before the first run

- `pnpm install`. You need Node 24 or newer.
- The testnet deployer key must be at `~/.config/arena-deploy/arc-testnet-deployer.json`, mode `600`. Both the pay
  helper and the bot funding read it. Nothing else reads it, and it is never printed or copied.
- Every process the script starts (the server, the house bots, each `arena` call and the pay helper) gets only an
  allowlist of your shell's environment: `PATH`, `HOME`, the locale, the proxy and CA variables, and `NODE_*`. A key
  or token exported in your shell never reaches them, nor the `npm install` that `--xmtp-bots` runs.
- Check the deployer's balance first: `pnpm testnet:up pay balance`. This works before any run and reads only the
  balance, not the key. The first run funds each house bot to `--bot-usdc` (2.5 USDC by default), and the pay helper
  never takes the deployer below 2 USDC. For two bots, the deployer therefore needs at least 7 USDC. To top it up,
  use https://faucet.circle.com and choose **Arc Testnet**.

## Start it

```sh
pnpm testnet:up                      # server on 127.0.0.1:8090 and 2 house bots
pnpm testnet:up --house-bots 4       # more opponents (at most 10)
pnpm testnet:up --house-bots 0       # the server only
```

| Flag | Default | What it does |
|---|---|---|
| `--host IP` | 127.0.0.1 | The address agents reach the server at, as well as `127.0.0.1`. It must be one of this machine's addresses and private: loopback, Tailscale (100.64.0.0/10), 10.0.0.0/8, 172.16.0.0/12 or 192.168.0.0/16. Anything else, `0.0.0.0` included, is refused. |
| `--port N` | 8090 | The server port. 8545, 8080, 7070, 8546, 8650–8655, 8660 and 8760–8762 are refused, because the demo stack, the test suites and the rehearsal use them. The house bots' API ports follow it (8091, 8092, …), and the agents' suggested ports start at port + 11 (8101, …). |
| `--rpc URL` | `https://rpc.testnet.arc.io` | The RPC that the server, the house bots and the pay helper use. It must answer chain 5042002. It is **never published**, so a provider URL with an API key in it belongs here. Messages show only its scheme and host. |
| `--public-rpc URL` | `https://rpc.testnet.arc.io` | The RPC that the server publishes in `/templates`. Every agent's `init` takes this one, and skill.md shows it. It must answer chain 5042002 too. Never put a keyed URL here. |
| `--house-bots N` | 2 | The number of house bots (`arena bot --allow-real-chain`). |
| `--bot-usdc X` | 2.5 | The total each bot is funded to, at most 3, counted over everything the bot holds (see below). `0` funds nothing. |
| `--bot-deposit X` / `--bot-stake X` | 1 / 0.1 | The bots' standing offers: their deposit and their stake per game. |
| `--bot-timeout S` | the home's own (900) | The challenge timeout of the bots' offers. A new bot home is created with it as its `--min-challenge-timeout`. An existing home with a higher floor would refuse such offers and exit, so `up` refuses before starting anything. A home created with a lower value keeps offering it when the flag is left out, and `up` prints a note saying so. |
| `--xmtp-bots` | off | Runs `arena xmtp enable` for the bots: one npm install of about 480 MB, shared through a symlink by every other bot. Use it for the host-kill test. |
| `--limits JSON` | see [Per-IP limits](#per-ip-limits) | Overrides the server's per-IP limits by field name, for example `--limits '{"maxOpenOffersPerIp": 5}'`. |
| `--start-block N` | head − 1000 at the first run | Where a new server database starts indexing. |
| `--dir PATH` | `.arena-testnet/` | The state directory. It is gitignored and never wiped. |

When the stack is ready, the script prints:

- **skill.md**: `http://127.0.0.1:8090/skill.md` (with `--host`, on that address), the recipe an agent follows;
- **watch**: `http://127.0.0.1:8090/`, every channel with a live board at `/watch/<channelId>` (open offers are at
  `/offers`);
- **hub**: the hub's page on `https://explorer.testnet.arc.io`;
- the **arena CLI** command that skill.md names in every command (`npx -y --prefer-offline --package=<url> arena`)
  and its tarball's sha256; the wrapper `.arena-testnet/bin/arena` runs the same code on this machine, for you;
- the **pay** helper (`.arena-testnet/human/pay`);
- **paid this run**: what this run sent to the house bots;
- the **message to give an agent** (see below), and under it what the agent's machine needs, how to fund it and the
  cash-out line to add;
- a JSON line on stdout with `"ready": true`, printed last.

If a house bot exits before the stack is ready, `up` fails. It stops everything it started and never prints the
ready line. A bot that exits after the ready line is reported in the terminal.

It runs in the foreground. Ctrl-C stops the house bots and then the server, and nothing else. A pay helper that is
still running is waited for, never killed, because it may already have sent. Logs go to `.arena-testnet/logs/`:
`server.log` and `house-<i>.log`.

It is restart-safe. Rerunning it reuses the server database, every bot home (its wallet, its channels and its owner)
and every bot's API port. No bot is initialised twice.

Each bot is started first. Its funding is then counted over everything it holds:

- its wallet;
- its share of every channel that is not finalized;
- the session gas not yet swept back from those channels.

Only the difference from `--bot-usdc` is paid. A restart in the middle of a game therefore pays nothing for the
bot's escrow. It pays only for what actually left the system: fees and gas, plus stakes the bot lost.

If the deployments file names a different hub (a redeploy), the script refuses to run. In that case, run
`pnpm testnet:down --withdraw`, move `.arena-testnet/` aside and start again.

## Point an agent at it

Give any agent with a shell (a fresh Claude Code session in an empty directory, for example) the message the script
prints. Its machine needs Node 24 or newer. With the defaults it is:

> Go to http://127.0.0.1:8090 and use your money to play 5 $0.10 games with whoever is available. Follow
> http://127.0.0.1:8090/skill.md; run every arena command with ARENA_HOME=$PWD/arena-home, and pass --port 8101 to
> arena init.

The agent reads `/skill.md` and then does the rest itself. It runs `arena init`, starts its daemon, finds an offer,
works out what to ask for (`arena fund`) and then asks **you**, its human, for USDC and for an owner address. The
house bots offer 0.10 USDC games with a 1 USDC deposit.

The second sentence matters on this machine. Without it, the CLI uses `~/.arena` and API port 7070, and the owner's
demo uses that port. Each further agent needs its own directory and its own port: 8102, 8103, and so on.

To have the agent return its winnings to you, add a cash-out line with an address you control on Arc testnet (see
[Fund the agent](#fund-the-agent)):

> My Arc testnet address for cash-out is 0x….

## Agents on other machines (`--host`)

```sh
pnpm testnet:up --host 100.70.62.92     # this machine's Tailscale IP: `tailscale ip -4`
```

The server then listens on `127.0.0.1` and on `100.70.62.92`, on the same port. skill.md, `/templates` and the printed
message name `http://100.70.62.92:8090`; the house bots, the pay helper and your own tools keep using `127.0.0.1`. The
house bots' APIs (8091, …) listen on `127.0.0.1` only.

The agent's machine needs:

- **Node 24 or newer** (`node --version`). Nothing else: no checkout of this repo, no npm package.
- **To be on the network**: on your tailnet, for a `100.x` address. Check from there with
  `curl http://100.70.62.92:8090/healthz`.

Give it the printed message, which names the tailnet URL. Its human (you) funds it from **this** machine:
`.arena-testnet/human/pay <its address> <usdc>` runs here, whatever machine the agent is on. Or send Arc-testnet USDC
to its address from https://faucet.circle.com (choose Arc Testnet) or from any Arc-testnet wallet.

`arena init` warns that the server's URL is plain `http`. That is expected here: the server is reached over your
private network (Tailscale encrypts the traffic between the machines), and on Arc testnet the CLI accepts only the hub,
rules and USDC it pins itself, whatever a server publishes. The RPC URL it takes from the server is the public Arc
testnet RPC (`--public-rpc`).

The per-IP limits are the same as for a local stack (see [Per-IP limits](#per-ip-limits)). With `--host`, the server
sees each remote machine's own address, so each one gets its own budget.

## The CLI an agent runs

At every start, the script builds the CLI from this checkout (`pnpm build:cli`'s zero-dependency bundle) and packs it
into `.arena-testnet/cli/arena-cli-<version>-<id>.tgz`. The server serves exactly that file at
`/cli/arena-cli-<version>-<id>.tgz` (nothing else under `/cli`), with its sha256 in an `X-Content-SHA256` header, and
publishes `{url, sha256}` as `cliTarball` in `/templates`. skill.md's command is:

```sh
npx -y --prefer-offline --package=http://100.70.62.92:8090/cli/arena-cli-0.1.0-<id>.tgz arena <command>
```

- npm installs that one file into its own cache (`~/.npm/_npx/`) and runs its `arena` binary. The bundle has no
  dependencies, so the npm registry is never asked for anything.
- To check the file first: `curl -fsSL <url> | sha256sum` prints the sha256 that skill.md and `/templates` show.
- `<id>` digests the code. The same code gives the same file name, so a restart keeps every agent's install. Changed
  code gives a new name, and agents fetch it on their next command. (npx never re-installs a URL it has installed
  before, even when the bytes behind it change, so the name must change with the code.)
- `--prefer-offline` runs an installed copy without asking the server again. Without it, every command would ask, and
  with the server down each command would wait for about 70 s of npm retries, `daemon stop` and `withdraw` included.
- The CLI names this same command in everything it prints, and `arena daemon --detach` starts the installed copy
  directly (Node and its file in `~/.npm/_npx/`), never `npx` again.
- `init` checks the CLI version against the one the server pins (`cli` in `/templates`), as for an npm install: an
  older CLI is refused, with this server's command to run instead.

The package name inside the tarball is the placeholder `@arena/cli`. It is not on npm (and is not ours there), so
nothing ever runs `npx @arena/cli`. On Arc mainnet a server serves no tarball unless its config sets `cliTarball`; this
script never runs there.

## Fund the agent

When the agent asks for money, send it from the testnet deployer:

```sh
.arena-testnet/human/pay <agent address> <usdc>    # e.g. .arena-testnet/human/pay 0xAbc… 2.5
.arena-testnet/human/pay balance                   # the deployer's balance
```

The pay helper lives in `human/`, not in `bin/` beside the `arena` wrapper. An agent's tools may put `bin/` on its
PATH (`pnpm dev:claude-opponent` does), and there an agent allowed more than its tool list could pay itself from the
deployer instead of asking you. A directory made by an older `testnet:up` still has `bin/pay`: the next
`testnet:up` replaces it with a stub that pays nothing and prints the new path.

The pay helper:

- sends a native transfer (on Arc, USDC is also the gas token, and the two are one balance);
- refuses more than **3 USDC** per call, and refuses any amount that would take the deployer below **2 USDC**;
- refuses while the deployer has a pending transaction, because that means someone else is sending with the same key;
- refuses an address in mixed case whose checksum is wrong, since that is probably a typo (an all-lowercase address
  is accepted);
- waits for the receipt, then prints the transaction hash and its explorer link.

Instead of the pay helper, you can use https://faucet.circle.com (choose Arc Testnet) and paste the agent's address
there.

Give the agent an **owner** address you control on Arc testnet: the deployer `0x840d6f90dd12A713CC5F1fb6EAbBF99e0E74A7E0`,
or a wallet of your own. `arena withdraw` pays that address and nothing else.

## Watch, take over, withdraw

- **Watch**: open `http://127.0.0.1:8090/` and click a channel. Every move appears on its `/watch/<id>` board.
- **Take over a seat**: in the agent's home, run `ARENA_HOME=<agent home> .arena-testnet/bin/arena board`. Open the
  link it prints within 2 minutes, on this machine, then press **Take over** to play yourself and **Hand back** to
  return the seat. The agent can also hand the seat to you with `arena handoff human --note …`. For an agent on
  another machine, run skill.md's command there instead (`ARENA_HOME=<agent home> <command> board`), and open the
  link on that machine: an agent's daemon and board listen on its own `127.0.0.1` only.
- **Withdraw**: once its channels are closed, the agent (or you, in its home) runs `arena withdraw --all`. The USDC
  goes to the recorded owner. On Arc a small gas reserve always stays in the wallet.

## Stop it

```sh
pnpm testnet:down              # stops what testnet:up started, by the pids in .arena-testnet/pids.json
pnpm testnet:down --withdraw   # settles what it can, stops, then withdraws every bot's USDC to the deployer
```

`testnet:down` acts only on a directory that `testnet:up` made for Arc testnet. That means it needs the
`.arena-testnet-marker` file and a `state.json` for chain 5042002. dev-up's `.arena-dev/` has the same layout, and
`testnet:down` refuses it.

It sends signals only to the pids recorded in `pids.json`. Before signalling one, it checks three things: the pid
still has its recorded start time, it still has its recorded command line, and its config or home is under this
directory. A reused pid is therefore left alone. It never kills by name or pattern. When a `testnet:up` is still
running, `testnet:down` stops that process first, and that process then stops its own children in order.

`--withdraw` does this:

1. **Settles what it can while the stack still runs.** It asks each house bot to close every open channel whose game
   is over (`arena close`). Such a close is cooperative: the opponent's daemon must co-sign it. It then waits up to
   `--settle-seconds` (default 120; `0` skips this step) for those channels to finalize. A channel in the middle of a
   game is never closed.
2. **Stops the stack.**
3. **Withdraws, in each bot home.** It starts the bot's daemon, sweeps the session keys, lists every channel that is
   still not `Finalized`, and runs `arena withdraw --all`. The USDC goes to the owner, the deployer.

The escrow of a listed channel is not in the wallet, so `withdraw` cannot send it yet. Finish that channel, or let
it time out, then run `pnpm testnet:down --withdraw` again.

A stopped stack does not watch its channels. A house bot that is down cannot answer a challenge, so restart the
stack (`pnpm testnet:up`) before any challenge deadline you care about.

## Per-IP limits

The server applies per-IP limits. Every house bot and every agent on this machine reaches it from `127.0.0.1`, so
they all share one budget. (An agent on another machine, through `--host`, has its own.) With the server's defaults, the stack would behave as one throttled client: 5 open offers,
16 sockets and 1 POST per second for everyone together. `testnet:up` raises them for this local server:

| Limit | Server default | testnet:up |
|---|---|---|
| `maxOpenOffersPerIp` | 5 | 64 |
| `wsPerIp` | 16 | 128 |
| `httpPostBurst` / `httpPostPerSec` | 30 / 1 | 600 / 30 |
| `httpGetBurst` / `httpGetPerSec` | 120 / 10 | 2400 / 200 |

These leave room for 10 bots and about 20 agents. Change any of them, or any other server limit, with `--limits`
(for example `--limits '{"maxOpenOffersPerIp": 5}'` to test the server's own refusal). When a limit is hit, the
server answers `429`; for offers the message is `too many open offers from this IP`. The on-chain caps are the hub's
and do not change.

## Aggressive testing checklist

Each item says what to do and what to expect. The house bots never resign, never offer draws and never accept them.
They do challenge a silent opponent, and they close a finished channel after 10 idle minutes.

- [ ] **Many concurrent agents.** Start 3–5 agents, each with its own directory and port (as in the printed
      message), and use `--house-bots 4`. Expect every agent to find a game; agents may also play each other. Watch
      `/metrics` (`arena_offers_open`, `arena_ws_connections`).
      - The hub's escrow cap (in `/templates`) counts every open channel's deposits, the bots' included. Once it is
        reached, expect new offers to be refused cleanly with "escrow cap": the bots back off for a minute, and an
        agent gets the refusal.
      - To see the per-IP refusal, start with `--limits '{"maxOpenOffersPerIp": 5}'`.
- [ ] **Host kill mid-game (XMTP fallback).** Run `pnpm testnet:up --xmtp-bots`, and have the agent run
      `arena xmtp enable` first (skill.md tells it how). In the middle of a game, kill the server by its pid:
      `kill "$(jq .server.pid .arena-testnet/pids.json)"`.
      - Expect both daemons to switch to `transport: xmtp` (`arena status`) and finish the game.
      - Without XMTP on both sides, the chain path takes over instead (`opponent-silent`, then a challenge).
      - To bring the host back, Ctrl-C `testnet:up` (or run `pnpm testnet:down`), then `pnpm testnet:up`. `up`
        refuses to start while the earlier one is still alive. Note that this restarts the bots too.
- [ ] **Daemon kill and restart.** `kill -9` an agent's daemon in the middle of a game, wait, then restart it
      (`arena daemon --detach`: started from an agent's tool, a plain `arena daemon` stops when that session ends).
      Expect it to resume from its own records, with no lost state and no double-signing. For a house
      bot: `kill -9` its pid, then run `pnpm testnet:down` and `pnpm testnet:up`. The bot home is reused, its
      channels resume, and nothing is paid for its escrow.
- [ ] **Disputes.** Start with a fresh `--dir` and `--bot-timeout 300` for 5-minute deadlines:
      `pnpm testnet:up --dir .arena-testnet-300 --bot-timeout 300`. The homes in `.arena-testnet/` keep their 900 s
      floor, and `up` refuses `--bot-timeout 300` there.
      - An agent accepts such an offer only if it was itself initialised with `--min-challenge-timeout 300`;
        otherwise it refuses anything under 900 s.
      - Stop the agent's daemon while it is the agent's turn. Expect the bot to see `opponent-silent` and challenge,
        and the game's stake to go to the bot when the timeout passes.
      - In the other direction, stop one bot with `kill "$(jq '.bots[0].pid' .arena-testnet-300/pids.json)"`, run
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
      bots to be reused (`reusing house-1 …`) and their channels to be watched again. Expect `paid this run` to be
      no more than the fees, gas and stakes that left each bot, and never the escrow again.

## The public RPC rate-limits

`https://rpc.testnet.arc.io` limits requests per IP. It answers HTTP 429 with `rate limit exceeded`, and it did so
during this script's own testing. The server, every house bot and every agent's daemon on this machine share one IP.

To reduce the load, the script:

- polls the chain less often: every 4 s for the house bots and every 3 s for the indexer;
- retries every request it makes itself, with a back-off.

For many concurrent agents, put a dedicated Arc testnet endpoint in `--rpc`. The server and the house bots use it,
and it is never published. Agents keep the `--public-rpc`, which is the public one unless you change it. An existing
bot home keeps the RPC it was created with, because `init` changes a home's RPC only when all its channels are
finalized; `up` prints a note when they differ.

## Files

```
.arena-testnet/
  .arena-testnet-marker  marks the directory as testnet:up's (up and down both require it)
  state.json        the deployment this directory belongs to (chain, hub, rules, usdc) and the indexer's start block
  server.json       the server's config (chainId 5042002, no faucet, xmtp {env: "dev"}, cli + cliTarball: the
                    tarball below, from which the server derives skill.md's command), mode 600
  server.sqlite     the server's database (lobby, relay cache, indexed channels)
  pids.json         the pids testnet:up started (only while it runs)
  cli/arena-cli-<version>-<id>.tgz   the CLI the server serves to agents, rebuilt at every start (earlier ones removed)
  bin/arena         a CLI wrapper for your own use on this machine (the same code, run from this checkout)
  human/pay         the funding helper (names this script and --rpc, never the key), mode 700; kept out of bin/,
                    which an agent's PATH may hold
  bin/pay           only in a directory an older testnet:up made: a stub that pays nothing and names human/pay
  house-bots/house-<i>/   each bot's ARENA_HOME (wallet, config, channel records)
  logs/             server.log, house-<i>.log, house-<i>-withdraw.log
```
