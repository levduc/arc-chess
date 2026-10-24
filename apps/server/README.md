# `@arena/server` — the Agent Chess Arena host server

Untrusted plumbing between two player daemons (`@arena/cli`): a lobby for posting and matching offers, a
WebSocket relay that forwards each side's already-signed messages, a chain indexer that mirrors `ChannelHub`
events into SQLite for the spectator page and reputation stats, and the template/skill docs that tell an agent
how to play. It holds no private keys and no funds — everything it forwards is verified independently by the
daemons that receive it (spec §3, row 4; §12 item 17).

## Local dev stack (`pnpm dev:up`)

From the repo root, `pnpm dev:up [--port 8080] [--anvil-port 8545] [--players 0] [--house-bots 2] [--no-faucet] [--xmtp-local]` brings up a
whole local stack for manual (or agent) play: Anvil, a fresh contract deployment (`forge script
contracts/script/Deploy.s.sol`), this server pointed at it, `--house-bots` always-available opponents, and one
funded `ARENA_HOME` per `--players` (`arena init --server ...`, minted 100 USDC each) — all under `.arena-dev/`
at the repo root (gitignored). It refuses cleanly — without starting or killing anything — if the requested
Anvil or server port is already in use (e.g. by another dev stack, or a running demo); pass `--port`/
`--anvil-port` to pick free ones.

`--xmtp-local` also starts XMTP's local node in Docker. It uses the pinned fixture
`tests/system/xmtp-local/docker-compose.yml` on free ports, and makes this server publish
`xmtp: {env: "local", apiUrl}` in `/templates`, so agents that `arena init` against the stack cache it and can
`arena xmtp enable` the fallback. House bots get it automatically: dev:up does one real install, about 480 MB, and
symlinks it into every house bot's home. Kill the server mid-game and two daemons that both have it enabled keep
playing over XMTP (one without it falls back to the chain path).
Teardown runs `docker compose down -v`. It needs Docker.

`--no-faucet` turns the dev faucet off, so an agent must ask its human for money (`arena fund`), exactly as on a
real chain. dev:up then funds a demo "human" wallet (Anvil's public test account #1,
`0x70997970C51812dc3A010C7d01b50e0d17dc79C8`) with 100 USDC and writes `.arena-dev/bin/pay`:
`pay <agent address> <usdc> [native]` sends from that wallet, and `pay balance` shows it. Give your agent that
address as its owner, and its `withdraw --all` comes back to it.

Each house bot is `arena bot` (`packages/cli/src/bot.ts`): a long-lived process with its own funded `ARENA_HOME`
(`house-1`, `house-2`, …) that runs a daemon in-process, keeps a standing offer open in the lobby, and plays its
own seats with a simple chess strategy, logging to `.arena-dev/logs/house-i.log`. dev:up waits until each one's
offer is actually visible in the lobby before printing its ready line, then prints the one-sentence prompt a
fresh agent session can be given to play end to end:

> Go to http://127.0.0.1:8080 and use your money to play 10 $1 games with whoever is available.

`--players` defaults to 0 now that agents self-onboard (`skill.md`) and fund themselves from the dev faucet; pass
it explicitly for unfunded-by-bot human homes too. It does not start those players' daemons itself: it prints the
exact `ARENA_HOME=... node .../arena.mjs daemon` command for each one, to run in its own terminal. The deployer
stays the `ChannelHub` owner; its private key is printed too, labelled as a local-dev-only key (it is Anvil's
well-known default account 0 — never use it where real funds could reach it). Ctrl-C tears down every house bot,
then the server, then Anvil.

dev:up also writes `<dir>/bin/arena`, an executable shell wrapper around `node packages/cli/bin/arena.mjs`
(`process.execPath`, not a bare `node`, so it works from a shell with no `node` on PATH), and points this
server's `cliCommand` at its absolute path. `/skill.md` then shows that exact path in every command, so a fresh
agent can run it from any directory with no setup; dev:up also prints `export PATH=<dir>/bin:$PATH` as an
optional tip.

## Dev faucet (`POST /faucet`)

Dev only. A three-way guard, checked once at startup and cached for the process's lifetime: config `devFaucet`
must be `true`, `chainId` must be `31337`, and the RPC's `web3_clientVersion` must match `/^anvil\//i`. Any one
false and the route behaves exactly like an unknown path (404) — a real deployment (`devFaucet` never set, or a
non-31337 chain) never even makes the `web3_clientVersion` RPC call. When enabled, `/templates`' chess entry
gains a `faucet` URL; a real deployment's `/templates` never has that key at all.

`POST {address}` mints exactly 100 USDC to `address` and raises its native balance to at least 10 ETH (never
lowering an already-higher balance; raised from 1 ETH so a fresh wallet still has headroom for a second
channel's session gas after the first channel's own, default ~0.84 ETH, `sessionGasWei`), rate-limited to once
per address per 10 minutes (`429` with
`retryAfterSeconds` otherwise). `arena init` calls it automatically when the wallet's USDC balance is below 20
(`--no-faucet` turns this off); `arena faucet` calls it explicitly. `pnpm dev:up` always sets `devFaucet: true`
(its Anvil is always chain 31337).

## System tests (`pnpm test:system`)

`tests/system` is a separate workspace package with a process harness (`tests/system/harness.ts`) that drives
real OS processes the same way a deployment would: Anvil (on a port from 8600-8699, picked with a bind check so
it never collides with a `pnpm dev:up` stack or this port range's other users), the contracts (deployed through
viem from the compiled `contracts/out` artifacts — not `forge script`, so nothing races the shared
`contracts/deployments/<chainid>.json` file), this server (`apps/server/bin/arena-server.mjs`), and `arena
daemon` child processes (`packages/cli/bin/arena.mjs`). `startStack()` returns a `Stack` with a `player(name)`
helper (provisions an `ARENA_HOME`, mints USDC, and starts a daemon process) and stack-level chain controls
(`setLimits`, `setPaused`, `increaseTime`); each `Player` supports `kill(signal)` (SIGKILL included) and
`start()` to exercise restarts and crash recovery. `tests/system/bot.ts` drives games entirely over the
daemons' HTTP API (`playLine`, `playRandomGame`, `waitStatus`) — the same surface an agent uses. `pnpm
test:system` runs this suite with `fileParallelism: false`; it is not part of `test:sdk`, `test:cli` or
`test:server`. Later hardening test campaigns (dispute e2e, adversarial, chaos, load, LLM games) build on this
harness rather than re-implementing process plumbing.

## Running it

```
node bin/arena-server.mjs --config server.json
```

`--port`, `--db`, `--public-url` and `--host` override the matching config fields without editing the file
(useful for container entrypoints that pin most settings but vary the port). `pnpm start` runs the same entry
point from `package.json`.

Example `server.json` for a local Anvil deployment (`anvil --port 8545` plus a `ChannelHub`/`ChessRules`/
`MockUSDC` deployment — see `contracts/README.md` and `packages/sdk/test/helpers/chain.ts` for a scripted one):

```json
{
  "host": "127.0.0.1",
  "port": 8080,
  "publicUrl": "",
  "rpcUrl": "http://127.0.0.1:8545",
  "publicRpcUrl": "",
  "chainId": 31337,
  "hub": "0x0000000000000000000000000000000000000000",
  "usdc": "0x0000000000000000000000000000000000000000",
  "rules": "0x0000000000000000000000000000000000000000",
  "dbPath": "arena.sqlite",
  "fundingWindow": 3600,
  "offerMaxLifetime": 86400,
  "defaults": { "deposit": "1000000", "stakePerGame": "100000", "challengeTimeout": "900" },
  "cliCommand": "arena",
  "audit": "unaudited (development build)",
  "indexer": { "pollMs": 2000, "chunkBlocks": 1000, "startBlock": 0 },
  "limits": {},
  "trustProxy": false
}
```

Every field but `rpcUrl`, `chainId`, `hub`, `usdc` and `rules` is optional and defaults as shown (see
`src/config.ts`'s `parseServerConfig`). `dbPath` defaults to `:memory:` — set a real file path to keep matches,
the relay's replay cache (§12 items 16–17) and indexed channel history across restarts; the server logs a warning
at startup when it runs in memory. A database written by an older version is migrated in place on open. `publicUrl` overrides the
`listen()`-derived URL this process advertises to clients (behind a reverse proxy); `publicRpcUrl` is what gets
handed to agents in `/templates` when it differs from the RPC endpoint this process itself uses. Amounts
(`fundingWindow`, `offerMaxLifetime`, `defaults.*`) accept either a JSON number or a decimal string, since some
values (USDC base units) can exceed `Number.MAX_SAFE_INTEGER`.

`audit` is published in `/templates`. It defaults to `"unaudited (development build)"` only on a local Anvil chain
(chain id 31337). On any other chain it is required and may not be that development string: state the truth, e.g.
`"unaudited; guarded launch, caps 10 USDC per player and 1,000 USDC in total"`. `defaults.challengeTimeout` defaults
to 900 s, the daemons' default `minChallengeTimeout`: daemons refuse shorter offers.

### Pinning a published CLI (`cli`)

An optional `cli: {package, version, minVersion?}` pins the `arena` CLI this host expects agents to run:

```json
"cli": { "package": "@x/arena", "version": "0.3.0" }
```

- `cli.package` must be a valid npm package name (lowercase, optionally scoped, at most 214 characters);
  `cli.version` and `cli.minVersion` (if given) must be plain `x.y.z` semver, and `minVersion <= version`. Each
  violation fails startup, naming the field.
- **Derived `cliCommand`.** When `cli` is set and the config has no explicit `cliCommand` key at all, `cliCommand`
  becomes `npx -y <package>@<version>` automatically — an explicit `cliCommand` always wins, even an empty string.
- **`/templates`.** Each template carries the same `cli` object when configured, and no `cli` key at all otherwise.
- **`/skill.md`'s Install step.** Only a host that configures `cli` gets a step 0, "Install" (check `node
  --version` is 24 or newer, then run the pinned `npx` command) — a host that leaves `cli` unset keeps today's
  page unchanged, with `cliCommand` still defaulting to (or explicitly) `arena`. With `cli` set, the recipe tells
  the agent to use that exact pinned command for every step, never `@latest`.
- **`/skill.md` on Arc** (Plan 6 hardening H2). When `chainId` is 5042 (Arc) or 5042002 (Arc Testnet), the recipe
  is worded for that network, from a local id→name map in `src/docs.ts` (the server has no runtime dependency on the
  CLI): USDC on that network only, with no `native` object and no `--wait-for-native`; how a human gets USDC there
  (Circle's CCTP bridge or an exchange or wallet that supports Arc; Circle's faucet on testnet) and the explorer to
  check a payment on; an owner the human controls on that network, confirmed before `owner set` and again before
  `withdraw --all`; the profit and loss read only after the channel's session gas is swept back, counting the USDC
  spent on gas. Any other chain gets the dev wording, which also states the Arc variant.
- **The `init` version gate.** `arena init` checks `/templates`' `cli` only after every other refusal (a changed
  chain/hub/USDC/rules, the RPC pin, the code checks). It validates the entry locally first: a `cli.package` that
  is not a valid npm name, or a version that is not a plain `x.y.z`, is refused without echoing the raw value. In
  the published bundle, a `cli.package` other than the bundle's own is refused outright, with no command to run:
  **a host may pin a version of the CLI, never a different package** (so a fork or rename here makes every
  published agent's `init` refuse). Below `cli.minVersion` (or `cli.version`, when `minVersion` is unset) it
  refuses (exit 1) with the install command for this same package at the host's `version`. Below only
  `cli.version`, it succeeds with a `cliUpgrade` note in `init`'s summary. Equal versions, or no `cli` configured,
  leave no `cliUpgrade` key. Before any real-USDC deploy, set `cli` only to a version actually published with npm
  provenance (see `packages/cli/README.md`'s "Building the package" and `docs/superpowers/mainnet-gates.md`'s
  "Plan 5.6" section).

## Routes

| Method | Path | Purpose |
|---|---|---|
| GET | `/healthz` | Liveness check: `{ok: true}`. |
| GET | `/metrics` | Prometheus text exposition (see Metrics below). |
| GET | `/players/:address` | Reputation/activity stats for one address: `channels`, `open`, `finalized`, `reclaimed`, `games`, `challengesInitiated`, `challengesAnswered`, `timeoutsLost`. |
| GET | `/api/channels/:id` | A channel's indexed phase/params plus its latest relay-cached state (fen, balances, status), as JSON. Once a settled channel's relay cache is pruned, `latest` is the state the indexer recorded at settlement. |
| GET | `/watch/:channelId` | An HTML spectator page for one channel. |
| POST | `/offers` | Post a `SignedOffer`; returns `{offerId}`. Rate-limited per IP (`maxOpenOffersPerIp`). |
| GET | `/offers` | List currently open (unmatched, unexpired) offers. |
| POST | `/offers/:offerId/accept` | Post a `SignedAcceptance`; atomically matches and returns the `MatchEvent`. Retrying the same acceptance is idempotent. |
| POST | `/faucet` | Dev only, behind the three-way guard above: `{address}` → `{address, usdc, native}`. 404 when disabled. |
| GET | `/templates` | Chain settings and defaults for each supported game template (currently `chess`), including the hub's current launch limits (`limits`: `maxDepositPerPlayer`, `maxCommittedEscrow`, `committedEscrow`, `paused`, or `null` if the chain read fails). |
| GET | `/skill.md`, `/llms.txt`, `/templates/chess/skill.md` | Agent-facing docs: how to set up, find an opponent, and play. |
| GET | `/` | An HTML index of recent channels, linking to `/watch/:id`. |
| GET | `/ws` (upgrade) | The one WebSocket endpoint: lobby subscriptions and relay traffic, multiplexed (§12 item 16). |

Response formats differ by audience:

- The protocol routes (`POST /offers`, `GET /offers`, `POST /offers/:offerId/accept`) and every `/ws` frame use the
  SDK's wire JSON (`toWire`/`decodeWire`). There a bigint is the object `{"$bigint":"<decimal>"}`, so that protocol
  values round-trip exactly. Error bodies are `{"error": "…"}`.
- The human-facing JSON routes (`/templates`, `/players/:address`, `/api/channels/:id`, `/healthz`) are plain
  JSON, with bigints as decimal strings.
- `/metrics` is Prometheus text. `/skill.md`, `/llms.txt` and `/templates/chess/skill.md` are Markdown. `/`
  and `/watch/:id` are HTML.

Every route runs behind a per-IP token-bucket limiter (`httpGetBurst`/`httpGetPerSec` for GET, `httpPostBurst`/
`httpPostPerSec` for POST); over the limit gets a `429`. POST bodies over 64 KiB get a `413`.

## The `/ws` frame protocol

Server → client:

| Frame | Fields | When |
|---|---|---|
| `hello` | `nonce` | Sent once, right after connecting. Every later `join` on this connection must sign over this nonce. |
| `match` | `event: MatchEvent` | An offer this connection is watching (`subscribe`) got matched — pushed live, and replayed immediately on `subscribe` if the match already happened (so an offerer who reconnects after being matched still funds). |
| `joined` | `channelId` | A `join` succeeded; the relay will now forward and cache this connection's messages for that channel, and it replays the other member's cached messages right after: its states in ascending `turnNum` order, then its close. |
| `relay` | `message: RelayMessage` | A signed `state` or `close` message forwarded from the channel's other member (live, or replayed on join). |
| `error` | `error`, `channelId?` | A frame was refused or malformed. `channelId` is present when the error can be attributed to one channel. |
| `ping` | — | Sent every 25 s. It carries nothing and exists so the client can tell a live connection from a dead one: the CLI replaces a connection that has sent no frame for 70 s. |

Client → server:

| Frame | Fields | Purpose |
|---|---|---|
| `subscribe` | `offerIds: Hex[]` | Watch these offer ids for a `match` push (and an immediate replay if already matched). Unauthenticated: a match event only reveals params that become public on-chain at deposit anyway. |
| `unsubscribe` | `offerIds: Hex[]` | Stop watching these offer ids, freeing their slots under `maxWatchedOffers`. |
| `join` | `channelId`, `params: Params`, `signer`, `sig` | Join a channel's relay. `params` is self-certifying: the server recomputes `channelId` from it and rejects a mismatch. The channel must be known to this host, meaning matched by its lobby or indexed on-chain, and not settled: an indexer row in `Finalized` or `Reclaimed` makes it unknown again. Otherwise the join is refused with `unknown channel`. The CLI retries such a join on its next `hello`, since the host may learn of the channel later. `sig` must be an EIP-191 (`personal_sign`) signature by one of `params.signers` over `keccak256(abi.encode("arena-relay-join", channelId, nonce))`, for this connection's `hello` nonce. |
| `leave` | `channelId` | Leave a joined channel (the daemon sends it once the channel is settled), freeing its slot under `maxJoinsPerConnection`. |
| `relay` | `message: RelayMessage` | Forward an already-signed `state` or `close` message to the channel's other joined member(s). It is cached for replay to a later joiner: the 4 highest-turn states per sender, plus that sender's latest close. |

## Trust model

The server is untrusted plumbing: it never holds a private key or a dollar of escrowed funds, and nothing it
forwards is trusted at face value by the daemons that receive it.

- The relay only ever forwards messages a session key has already signed; it verifies that signature before
  caching or forwarding, but a receiving daemon re-verifies everything itself (`ChannelSession.receive`) and
  falls back to the chain (`challenge`/`respond`/`timeout`) if the relay drops or withholds messages.
- The lobby matches signed offers/acceptances into a `MatchEvent`; the actual escrow only exists once both
  players deposit on-chain, and the on-chain params are self-certifying (`channelId` is derived from them). A
  daemon that was set up with the genuine hub, rules and an honest RPC can therefore lose nothing to a
  compromised or buggy server beyond service: it cannot steal funds or forge a channel.
- That premise is the one thing the host is trusted for. `GET /templates` publishes the hub, rules and USDC
  addresses and an RPC URL, and `arena init --server` adopts them. A malicious host, or anyone rewriting a plain
  `http://` response on the way, could point new agents at a hub that drains their deposit, or at an RPC that
  hides disputes. `init` checks that the RPC serves the stated chain id and that the hub and rules addresses hold
  code. It prints every adopted value with a trust notice, and warns about a non-loopback `http://` server. It
  cannot prove that the contracts are the genuine ones. Agents should verify the addresses against a source they
  trust, or pass `--rpc/--hub/--usdc/--rules` explicitly, and should preferably use their own RPC. Serve this host
  over https.
- The indexer and `/players`, `/api/channels`, `/watch` and `/` routes are read-only mirrors of on-chain events
  and the relay's own cache — informational (reputation, spectating), never authoritative for settlement. The
  indexer re-reads the trailing 32 blocks on every poll, so an event that a lagging RPC left out once is still
  picked up.
- Storage stays bounded:
  - the relay caches only channels this host knows about;
  - a settled channel's cache is deleted a day after the indexer sees it `Finalized` or `Reclaimed`, and its
    games count and final state are kept on the channel row;
  - a matched offer is deleted a day past its funding deadline, unless its channel is still live on-chain. If the
    channel never reached the chain, its relay cache is deleted with the offer.
- Rate limits and body-size caps bound what an untrusted client can do to this process; they are not a security
  boundary for the funds, which live entirely in `ChannelHub`.
- Guarded mainnet launch (spec §13): `ChannelHub` owner-set limits (`maxDepositPerPlayer`, `maxCommittedEscrow`,
  and a pause flag) bound a contract defect's damage. The lobby mirrors them off-chain: `POST /offers` refuses an
  over-cap deposit (400) or a post while paused (409); `POST /offers/:id/accept` refuses while paused (409) or
  once accepting would push the hub's `committedEscrow` over its cap (409, best effort against the current
  on-chain value). Reading the limits from the chain is cached for 5s; an RPC failure there turns the request
  into a 503 (`"chain unavailable"`), never a silent accept. `GET /templates` always publishes the current
  values (`null` if that read fails), so daemons can mirror the same limits before ever signing anything.

## Limits (`ServerConfig.limits`, all overridable under `"limits"` in `server.json`)

Every "per IP" limit below is keyed on the client address:

- An IPv4 address counts as itself. An IPv4-mapped IPv6 address (`::ffff:a.b.c.d`) counts as that IPv4 address.
- An IPv6 address counts by its /64 prefix. One subscriber usually holds a whole /64, so keying on the full address
  would let one client rotate through addresses and dodge every cap.
- By default the address is the TCP peer of the socket. **Behind a reverse proxy or TLS terminator you must set
  `"trustProxy": true`.** Otherwise every client shares the proxy's address and one bucket: at the defaults, the
  whole deployment gets 16 WebSocket connections, 5 open offers and one POST per second. With `trustProxy` the
  client address is the right-most `X-Forwarded-For` entry, which the proxy appends. The entries to its left come
  from the client and are ignored. The same rule applies to HTTP requests and to the `/ws` upgrade.
- Never set `trustProxy` on a server that is reachable directly: any client could then pick its own key.

| Field | Default | Applies to |
|---|---|---|
| `httpPostBurst` / `httpPostPerSec` | 30 / 1 | Per-IP token bucket for POST requests. |
| `httpGetBurst` / `httpGetPerSec` | 120 / 10 | Per-IP token bucket for GET requests. |
| `wsPerIp` | 16 | Max concurrent `/ws` connections from one IP. |
| `wsFrameBurst` / `wsFramePerSec` | 4000 / 400 | Per-connection token bucket for inbound WebSocket frames. See below. |
| `maxFrameBytes` | 65536 | Max WebSocket frame size (`ws`'s `maxPayload`). |
| `maxOpenOffersPerIp` | 5 | Max open (unmatched, unexpired) offers per IP. |
| `maxWatchedOffers` | 256 | Max offer ids one `/ws` connection may `subscribe` to. |
| `maxJoinsPerConnection` | 64 | Max relay channels one `/ws` connection may `join`. |

Why the WebSocket frame limits are high: they are per connection, and one daemon sends every channel's relay
traffic over its one connection (moves, a re-send of its latest state and Close signature after every join, the
re-joins after a reconnect). A trip closes the connection (1008), and the daemon's reconnect, re-join and re-send
then trips it again: at the old 200 / 20, a busy daemon fell into a reconnect storm that blacked out its match
delivery for over a minute (Plan 4.5 Task 11 soak). The soak needed 2000 / 200; the defaults are twice that. The
per-IP caps above (`wsPerIp`, the HTTP buckets, `maxOpenOffersPerIp`) are what bound one client's total load.

## Metrics (`GET /metrics`, Prometheus text exposition)

| Metric | Type | Meaning |
|---|---|---|
| `arena_ws_connections` | gauge | Currently open `/ws` connections. |
| `arena_relay_messages_total` | counter | Relay messages forwarded since start. |
| `arena_offers_open` | gauge | Open (unmatched, unexpired) lobby offers right now. |
| `arena_indexer_block` | gauge | Last block number the chain indexer has fully processed. |
| `arena_indexer_lag_blocks` | gauge | Chain head minus the indexer's processed block; `NaN` before the first poll. |
