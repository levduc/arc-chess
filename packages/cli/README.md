# @arena/cli — player daemon and `arena` command

The daemon holds your per-channel session keys and plays the state-channel protocol for you. It:

- funds channels in the right order;
- exchanges signed moves with the opponent through the host relay;
- runs a watchtower (answers stale challenges, resigns when mated, calls `timeout` once a challenge it is not on move in expires, reclaims unfunded deposits). It does not challenge on its own: a silent opponent is escalated by `arena challenge`, which `arena status` suggests (and `arena wait` reports as `opponent-silent`) once they have made no progress for longer than the challenge timeout;
- lets a human take over a channel from the agent and hand it back — and hands it back to the agent by itself when a challenge needs a move the human has not made (see "Web board").

The `arena` command is a thin client for the daemon's local API (127.0.0.1, bearer token in `ARENA_HOME`).

## Install (published)

Once the owner has published a release (`.github/workflows/release-cli.yml`, built and run by them — see
"Building the package" below), run it with:

    npx -y <package>@<version> init --server <url>

Always pin the exact version this way — never `npx -y <package>@latest` — so a later publish can't silently
change what you're running underneath you. This needs Node `>=24`; check with `node --version` first and install
Node if it is older. When a host configures `cli` in its server config, its served `/skill.md` already fills in
the exact `npx` command for every step of its recipe (§3, `apps/server`'s README) — a fresh agent should copy that
page's commands verbatim rather than retype the package name and version from memory.

## Agent quick start

A fresh agent pointed at a running host (e.g. `pnpm dev:up`, see `apps/server`'s README) does not need this
README at all: read `<server>/skill.md`. Its first section, "Recipe: play N games at $X per game", is a
numbered install → fund → find an opponent → play → settle walkthrough, accurate to this exact CLI, with every
command already filled in using the server's own advertised command (`cliCommand` — `pnpm dev:up` writes
`<dir>/bin/arena`, an absolute-path wrapper, and prints an optional `export PATH=...` tip). On a dev server,
`arena init` auto-funds a brand-new wallet from `/faucet` (see "Setup" below), and `pnpm dev:up --house-bots N`
(default 2, `packages/cli/src/bot.ts`) keeps always-available opponents in the lobby — `tests/system/agent-
recipe.test.ts` exercises this exact flow end to end with a scripted, non-LLM agent. Everything below is
reference detail on the same commands.

## Setup

    arena init --server http://127.0.0.1:3000 [--port 7070]
    # or, against a server without a chess template, name the chain explicitly:
    arena init --server http://127.0.0.1:3000 --rpc http://127.0.0.1:8545 --chain-id 31337 \
               --hub 0x… --usdc 0x… --rules 0x… [--port 7070]

`init` fills in whatever of `--rpc`/`--chain-id`/`--hub`/`--usdc`/`--rules` you don't pass explicitly by fetching
the server's `GET /templates` and using its `chess` entry; an explicit flag always wins over the template's value.
It fails clearly if the server offers no `chess` template and a flag is missing.

On every run, explicit flags included, `init` then checks over the RPC it will use that `eth_chainId` matches and
that the hub, USDC and rules addresses hold code, and fails otherwise. It prints every chain value it adopted and a
`trust` line. The server never holds your funds or keys, but these addresses decide where your deposit goes and
the RPC decides what your watchtower sees. Verify them against a source you trust, or pass all five flags
explicitly, in which case `init` fetches nothing from the server (it still reads the RPC's gas price for the
default `--session-gas-wei`, unless you pass that too, except on a chain with a built-in profile, such as Arc).
Preferably use your own RPC. A non-loopback `http://`
server gets a warning on stderr, since anyone on the path could rewrite its answer.

Other `init` settings:

- `--session-gas-wei N`: the native balance (wei; on Arc, native gas is USDC) each channel's session key is kept at
  for dispute transactions. By default `init` derives it from the chain: 4 × 2.1M gas × max(the fee ceiling, 4 × the
  RPC's `eth_gasPrice`), and prints it. On a chain with a built-in profile (Arc), the default is instead 4 × 2.1M gas
  × the profile's 40 gwei ceiling = 0.336 USDC per channel, with no `eth_gasPrice` read, regardless of
  `--fee-ceiling-wei`: refills cover a fee spike. `--session-gas-wei` overrides either default. `--session-gas-floor N`
  (default half of it) is the balance below which the daemon refills a key while its channel is Open or Challenged.
- `--min-challenge-timeout SECONDS` (default 900): the daemon refuses to offer, accept or fund a channel with a
  shorter `challengeTimeout`. A missed challenge deadline can cost more than one stake, and a restart or an RPC
  outage can take longer than the hub's 60 s minimum.
- On a chain with a built-in profile (`CHAIN_PROFILES` in `src/chains.ts`: Arc, 5042, and Arc Testnet, 5042002),
  `init` **refuses** a USDC address other than the profile's and, once `KNOWN_DEPLOYMENTS` (`src/config.ts`) pins
  the chain, any other hub or rules -- whether they come from the server's `/templates` or from flags, on a fresh
  init or a re-run. Until a CLI release pins it, `init` refuses an Arc chain outright (final fix wave B, m-10): such
  a CLI cannot tell the real hub from one a hostile `/templates` names. The daemon re-checks the pin when it starts
  and refuses to start on a `config.json` that no longer matches (see "If the daemon refuses to start" below). On any
  other chain, `init` only warns loudly (`WARNING: hub … is not the canonical …`) when the hub, rules or USDC address
  differs from a `KNOWN_DEPLOYMENTS` entry.

`ARENA_HOME` (default `~/.arena`) holds `config.json`, `wallet.json`, `token.json`, `daemon.lock` and
`channels/<id>/`. All of these files are mode 0600.

**The daemon's wallet key (`--wallet-key`, or the one `init` generates) must not be used anywhere else.** The
daemon manages that key's nonces itself: on start, and whenever it finds a pending transaction on the key that it
did not send, it adopts that nonce and replaces the transaction with its own (Plan 4.5 Task 10). A transfer you send
from the same key with another wallet can be replaced and never land. And `withdraw --all` sends the key's whole
USDC balance, above the gas reserve, to the owner. `--fee-ceiling-wei` sets the most the wallet pays per gas for a
replacement (at least 4x the node's estimate; default 100 gwei, and on Arc 40 gwei); session keys have no ceiling
and are bounded only by their balance. On Arc, every fee the daemon sends, from the wallet or a session key, is at
least the 20 gwei base-fee floor (the mempool silently drops anything lower). The floor is applied last: it can lift
a fee above the ceiling, never above what the balance can pay, and a send the balance cannot pay at the floor is
refused rather than sent under it. `init` refuses a `--fee-ceiling-wei` below the floor.

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
regardless of whether it has been swept. A top-up's gas limit is its `estimateGas` plus 20 % and 5,000 (a failed
estimate sends nothing), and a top-up counts only once its receipt shows success. When a session key cannot be
refilled, `status` raises the `session-gas-low` attention, and its suggested action depends on the cause:
- **Insufficient funds:** "fund your wallet". This is the only cause that funding fixes. On Arc it asks for one
  channel's gas budget in USDC (`sessionGasWei` + 500,000 × the fee ceiling: 0.356 USDC by default).
- **A top-up that reverted:** "check the refill:".
- **A fee over the wallet's ceiling:** "wait:".
- **A failed estimate, or three refills in a row lost in transit:** "check the RPC:".

Each of the last three says that funding will not fix it, and names no amount.

## Funding your agent

The human is the agent's bank: there is no server faucet outside a local dev chain (31337 + Anvil). Work out what to
ask for, then wait for it:

    arena fund --games 3 --stake 1
    arena wallet --wait-for-usdc <usdc.need> --timeout 100   # repeat while reached is false

Add `--wait-for-native <native.need>` only on a chain where `fund` prints a `native` object; never on Arc.

`fund --games N --stake X [--deposit D]` reads the host's deposit cap and (dev only) faucet, the hub's
`feePerPlayer`, and this wallet's own balances — no daemon needed. `deposit` defaults to `min(N × X, cap)`, or
pass `--deposit D` directly to size the ask for a channel you will open yourself. To fund for a standing offer you
intend to accept, use `fund --offer <offerId>` instead: it reads that offer from the server's lobby and uses its
own deposit and stake, so you never convert the base units `offers` prints. (`--offer` excludes `--deposit` and
`--stake`; `--games` is optional with it. An offer that is no longer open exits 1.) It prints `{tellYourHuman,
disclosure, address, chainId, deposit, feePerPlayer, usdc: {have, need, shortfall}, native: {have, need, shortfall},
owner, message}` — `message` is a ready-to-relay sentence naming the exact USDC amount (6 decimals), the native
amount, the address and the chain, plus a reminder to give the owner address if none is recorded yet. Exit 0 here
just means the arithmetic succeeded, not that nothing is owed.

**Tell the human, in your own reply (H4).** In the first live run on Arc testnet, no agent put the ask in its own
words: each ran `fund`, then went straight to `wallet --wait-for-usdc`, and a human sees an agent's replies, not its
command output. So `fund`'s output leads with two fields:

- `tellYourHuman`: "Tell your human now, in your own reply, word for word, before you run wallet --wait-for-usdc
  (they cannot see this command's output): " (the "before you run" clause only when something is short), then
  `disclosure`, then `message`. The agent writes the text after the colon into its reply before any wait, and
  reminds the human of the missing amount after each wait that returns `reached: false`.
- `disclosure`: what the human is funding — the network (and on Arc whether it is mainnet or a test network), the
  hub address, the host's own `/templates` `audit` text (quoted, folded onto one line, with Unicode format
  characters such as bidi overrides removed, at most 300 characters; "Its host publishes no audit statement." when
  there is none), the per-player deposit cap as the host's own figure ("The host says each player may deposit at
  most …"), the hub's fee per player per channel, and that withdrawals go only to the owner (named, once recorded).

Every other field is unchanged, so scripts that read `message` or `usdc` (the live-run human watcher does) keep
working.

On Arc (gas is USDC, one balance) there is no `native` object: the gas is part of `usdc.need`, which also keeps one
`sessionGasWei` for each of the home's channels that is not finalized (`usdc.reserved`). There, `message` names USDC
only and names the network: "on Arc (chain id 5042), on the Arc network only", with a warning that USDC sent on
Ethereum, Base or any other network will not arrive, and the way in (Circle's CCTP bridge from another chain, or an
exchange or wallet that supports Arc; Circle's faucet on Arc Testnet). Its owner reminder asks for an address the
human controls on Arc, not an exchange deposit address unless that exchange supports USDC deposits on Arc, and not a
smart wallet deployed only on another chain.

That `usdc.need` is enough even when the daemon's funding is interrupted (live run #2): if a rate limit stops it
after the approve and the session-key top-up, before the deposit, the next pass needs only what is still to be
spent. The gas the channel's own approve and top-up paid (from their receipts, recorded in the channel's record as
`fundingGasPaid`) comes off the wallet-gas term, so the human is never asked again for gas already spent.

`wallet --wait-for-usdc A [--wait-for-native B] [--timeout SECONDS]` then polls the chain (every 5 s, `--timeout`
default 1800, max 3600; an agent whose tool has a 2-minute command limit should pass `--timeout 100` and repeat)
until both thresholds hold, and prints `wallet`'s usual JSON plus `{reached,
waitedSeconds}`. It exits 0 once reached, 2 on an actual timeout, and 1 on a read error or a malformed amount or
`--timeout` (never 2, so exit 2 here means a timeout). Only a flag given with no value at all is the CLI's usual
usage error, which exits 2 too; the recipe's commands always give one. After each timed-out wait, remind your human
of the missing amount before the next one; once about 30 minutes have passed, tell your human what has and has not
arrived, and stop — do not loop forever on your own.

When the wait is for exactly the `usdc.need` of the last `fund` that found something short (live run #2: one agent
of two still went from `fund` straight to the wait, and its human never saw the ask), it repeats that ask. Before
waiting, while nothing has arrived, its first line, on stderr, is "Your human must see this -- if you have not
written it in your reply, stop and do that now, word for word (they cannot see this command's output): <fund's
disclosure> <fund's message>". A timed-out result leads with the same text as `tellYourHuman`. It is kept in
`ARENA_HOME/fund-ask.json`, and cleared once the wait is met or a `fund` finds nothing short. A wait for any other
amount (a session-gas top-up's) repeats nothing.

## Owner and cash-out

`arena withdraw` only ever pays one address: the **owner**, recorded in `config.json`. Record it the first time
for free:

    arena owner set 0xYourHumanAddress

or pass `--owner` to `init` when you first set the wallet up. The **first** set is free. **Changing** an existing
owner needs the *current* owner's signature: run `arena owner set <new>` with no `--signature` to print the exact
`messageToSign` (and the exact command to run with it), have the current owner sign it (EIP-191 `personal_sign`,
off this tool, with their own wallet), then re-run the command with `--signature 0x…`. The signature is checked
**locally** (ECDSA recovery) — never through the RPC, because a re-`init` can repoint `rpcUrl`, and an RPC that
lies about an ERC-1271/6492 check could otherwise forge the change. That also means a smart-contract owner can
never be changed through the CLI; see the honesty note below for its only recovery. The owner can never be the
zero address, this wallet, the hub, the USDC token, the rules contract, or any session key this home holds.
Re-running `init` never resets the owner (and never resets `chainId`/`hub`/`usdc`/`rules` either — a fresh
`ARENA_HOME` is the only way to point a home at a different deployment).

`withdraw` pays the owner on this home's chain only, in one irreversible transfer. On Arc, the owner must be an
address the human controls on Arc: an exchange deposit address that does not credit USDC deposits on Arc, or a smart
wallet deployed only on another chain, loses the funds. `owner set` says so on stderr on Arc; its stdout stays
`{owner}`.

    arena withdraw --amount 5   # or: arena withdraw --all

`withdraw` takes **no destination** — `--to`, a bare address, anything like that is a usage error, on purpose.
It goes through the daemon (started in-process, and stopped again, if none is already running), because the
daemon owns this wallet's one transaction-nonce sequence. It is refused with a `409` while any channel still
awaits this wallet's own deposit, so it never starves a deposit the daemon is about to make — retry once that
channel is funded or its funding window has closed. `--all` sends everything above the reserve: `0` on a chain whose
gas is a separate native asset; on Arc, where gas is USDC, the session gas of every unsettled channel plus 500,000 ×
the fee ceiling (0.02 USDC at Arc's 40 gwei), rounded up. So on Arc `usdcAfter` is not 0 after `--all`, and
`--amount` never dips into the reserve.
Success means the transaction's receipt shows the USDC `Transfer` to the owner, never a balance delta (a same-
block inflow, or Arc's USDC gas, can skew a delta either way); `usdcAfter` can be `null`, with a note, if the
balance can't be re-read right after a confirmed send. Funds escrowed in open channels are not in the wallet:
close them first.

A transfer that went out but could not be confirmed (its receipt read failed on a rate-limited or timed-out RPC,
it is still pending, or the daemon stopped meanwhile) is answered `502` (`503` while stopping) naming its
transaction hashes, in the message and as `hashes`: check them on an explorer, or the balances, before retrying
(final fix wave B, I-1). It is recorded in `ARENA_HOME/withdraw-pending.json`, and the next withdraw, through this
daemon or a new one, checks it first. If it landed, that withdraw sends nothing and says the owner was paid; the
one after goes ahead. While it may still land, every withdraw is refused (`409`), until another transaction takes
its nonce or 10 minutes have passed since it was sent. "Another transaction took its nonce" is concluded only after
its receipt is read once more, after the nonce count: it may be this very transfer, mined during the check
(re-review n-1). A transfer known to be mined whose receipt cannot be read stays held whatever its age (n-2): its
nonce is used, so a new send would be a second transfer. The message tells the agent to tell its human, who checks
it on an explorer and, if it did not pay, removes `ARENA_HOME/withdraw-pending.json` to withdraw again.

**Honesty note.** The owner lock stops a confused or prompt-injected agent from redirecting funds through the CLI
or the daemon API — it cannot, by itself, send to any address but the recorded owner. It is **not** a defence
against code that can read `ARENA_HOME/wallet.json` (the raw private key) or hand-edit `ARENA_HOME/config.json`.
Hand-editing `config.json` is also the human's only recovery path when the owner can't sign a change at all — a
smart-contract owner wallet, or a dead RPC with a channel still open (see the RPC pin, above: `init`
refuses to change `rpcUrl` while any channel is unfinalized, precisely because an RPC that hides a challenge can
cost that channel). The agent itself must never hand-edit either file; that step belongs to the human.

## Running the daemon

    arena daemon            # or: arena daemon start -- in the foreground
    arena daemon --detach   # in the background, in a session of its own: what an agent runs

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

**If the daemon refuses to start** with `refusing to start on <chain> …: … names contracts this CLI does not accept
there` (final fix wave B, I-2): this home's `config.json` names a hub, rules or USDC that this CLI release does not
pin for that chain -- most likely the home was set up by an earlier release, before a newer hub was pinned. The
message tells the agent this is its human's decision. Do not edit `config.json` to the pinned addresses: the daemon
would then look for this home's channels on the new hub, find none, and retire them, and their deposits on the old
hub would never be watched or reclaimed. Do not move to a fresh `ARENA_HOME` while a channel of this one is unsettled
either: withdraw needs this home's daemon. Run the CLI release that set the home up to settle every channel and
withdraw, then set up a fresh home with the new release.

**`--detach` (H4).** In the first live run every agent started the daemon with its tool's background-task feature,
and ending the session killed it — once mid-game with a channel open (a `nohup … &` dies the same way when the
tool kills its process group). `arena daemon --detach [--timeout SECONDS]`:

- refuses at once, spawning nothing, when the home has no `config.json`;
- when a live pid already holds the home's lock, starts nothing and asks the holder who it is, through its own API
  (fix rounds 1 and 2, I2, N3; see "Who holds the lock" below), until the deadline, since it may be starting. This
  home's `arena daemon` prints `{"alreadyRunning":true,"healthy":true,"pid":…,"api":…,"log":…}` and exits 0. A lock
  pid that never answers -- still starting, stuck, or a pid since reused by another program -- exits 1 with "not
  answering": wait, check `channels` in a minute, then tell the human (the pid and the log). An `arena bot`, a
  withdraw, an answer that is not the lock's writer, and a holder this CLI cannot identify (m-2, below) each exit 1
  with what to do next. None of them sends the agent
  back to `--detach` as is, and none calls a lock stale while its pid lives;
- re-runs this same CLI directly — `<node> <node flags> <entry script> daemon`, never a wrapper or `npx` again:
  the `.arena-dev/bin/arena` and `.arena-testnet/bin/arena` wrappers `exec` node, and under `npx` the entry script
  is the installed bundle — as a detached child (its own session and process group, so a kill aimed at the
  caller's group never reaches it), with stdin closed and stdout and stderr appended to `ARENA_HOME/daemon.log`;
- waits up to `--timeout` (default 60 s, 1–600; `start()` reads the chain before the API listens, and a
  rate-limited RPC retries each read for up to 15.5 s) for the child's own start line in the log, its pid in
  `daemon.lock` and its `/health`, then prints one line, `{"detached":true,"healthy":true,"pid":…,
  "api":"http://127.0.0.1:<port>","log":"…/daemon.log"}`, and exits 0;
- at the deadline, a child that holds the lock is **never stopped** (fix round 1, I1): `ArenaDaemon.start()` arms its
  dispute timer before the chain reads that make a start slow, so it may already guard a channel. It prints
  `{"detached":true,"healthy":false,…,"hint":…}` (exit 0), and the hint says to check `status` in a minute and that
  `--timeout 100` waits longer;
- exits 1 with the log's last lines when the child exits during startup (if another daemon won the lock meanwhile,
  two `--detach` at once, that daemon is reported instead, as above), or never takes the lock by the deadline, in
  which case it is stopped (SIGTERM, then SIGKILL after 10 s) — by its own pid, and nothing else.

What `--detach` cannot escape (fix round 1, M8): a new session and process group survive a process-group kill and a
terminal hangup, but not the teardown of what contains them — systemd stopping the user's scope or slice (for
example logind's `KillUserProcesses=yes` at logout), a sandbox that runs each command in its own PID namespace or
cgroup and kills it afterwards, or a container being stopped. Where the agent's tool works that way, run the daemon
from somewhere that outlives it (the systemd unit below, or the host).

The "cannot reach the daemon" hints of every other command now say `start it with "arena daemon --detach"`, and
that if it keeps stopping, the end of `ARENA_HOME/daemon.log` says why. `init` on a home a daemon holds says the
home may already be set up (skip init), and names `daemon stop` for a re-init.

**Who holds the lock (H4 fix round 2).** Every `acquireHomeLock` writes `{"pid":…,"nonce":…}` to `daemon.lock`,
with a fresh random nonce. Asked `GET /health` with this home's bearer token, the daemon's API answers
`{"ok":true,"pid":…,"lock":<that nonce>,"role":"daemon"|"bot"|"withdraw"}`; without the token, still the bare
`{"ok":true}`. `daemon stop` and `daemon --detach` call the holder "this home's daemon" only when that answer's pid
and nonce are the lock's. A lock written by an older CLI has no nonce, and its holder is never confirmed (final fix
wave B, m-1): any process listening on the port could echo a pid, and only the nonce, in the 0600 lock, proves
anything. No clock and no `/proc` are involved, so it works the same on Linux and macOS, across wall-clock steps, and
a reused pid -- which answers nothing -- can never pass. A holder that answers without saying which process it is (a
daemon from an older CLI, or another home's on the same port), or a lock with no nonce, is an answer that waiting
does not change: `--detach` and `stop` exit 1 at once, telling the agent to tell its human (m-2; before, `--detach`
waited out its whole `--timeout`). The authenticated answer also lists the channels the daemon does not watch
(`degraded`).

**Stopping a daemon by hand (for the human).** After a CLI upgrade, a daemon still running from the older release
cannot be identified by the new `daemon stop`, and is never signalled by it; neither is a stuck one that does not
answer. Stop it yourself, only when no channel of the home is live (or you accept that nothing answers a challenge
until a daemon runs again): read the pid from `ARENA_HOME/daemon.lock` (or the daemon's start line in
`ARENA_HOME/daemon.log`), check that it is an arena daemon (`ps -o args= -p <pid>` ends in `daemon`), then
`kill <pid>` (SIGTERM, a clean shutdown that releases the lock). Start the new release's daemon with
`arena daemon --detach`. Both commands find the API at the home's configured port; a home whose
`config.json` has port 0 (tests only: `init` always writes a real port) cannot be asked, so its holder never counts
as answering.

**`arena daemon stop [--timeout SECONDS] [--yes-i-understand]` (H4).** Stops this home's running `arena daemon`,
and waits until it has exited (`--timeout`, default 60 s, 1–600). Then it prints `{"stopped":true,"pid":…}`. A
restart is `arena daemon stop`, then `arena daemon --detach`. It signals the pid that `daemon.lock` names, with
SIGTERM (a clean shutdown), only after the daemon's own API confirmed, in this same call, that it is that pid with
that lock's nonce and that its role is `daemon` (not `bot`, nor the short-lived daemon inside `withdraw`), and it
asks again right before the signal. A lock pid that does not answer is never signalled, whatever it is: "… so it is
not signalled: it may still be starting, be stuck, or not be a daemon at all. Wait a minute and run daemon stop
again; if it still does not answer, tell your human: pid N, its log …". Then it waits until the process is gone
(`/proc` where it exists, `ps` elsewhere; a zombie counts as gone). With no live lock holder it exits 1 with
`nothing to stop`.

It also refuses while any channel record of the home is not `finalized`, whatever its phase (fix round 2, N2): in
`None` this wallet's deposit may be in flight; in `Funding` the hub opens the channel by itself when the opponent
deposits, and it would then run with nobody watching; a deposit past its funding deadline needs this daemon to
reclaim it. A record is finalized once the channel is settled, reclaimed, or retired with none of this wallet's
money in it, so a retired record (it keeps `None` or `Funding` as its final phase) never blocks. A record that cannot
be read blocks too (final fix wave B, m-4), as in `init`'s RPC check: it cannot be shown to be settled. The message
names the live channels and says to settle first or run the daemon elsewhere, and that stopping anyway is the human's
decision; it does not print the override. Channels no daemon watches -- an unreadable record, or one the daemon
reports degraded (its session would not load, or it failed to open too often) -- are named apart: `close` cannot
settle them, so the agent is told to tell its human. **`--yes-i-understand`** is that override, for a human only: it skips this
check (never the identity one) and prints a note naming the live channels. skill.md never names it, and tells the
agent to keep the daemon and tell its human when `stop` refuses. The recipe ends with `daemon stop`, once every
channel is settled and swept, any offer the agent posted has expired, and the withdraw is done. A daemon run under
the restart loop below is started again by the loop.

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

Without systemd, a restart loop does the same (for a human's own shell; an agent's tool session kills it with the
session, so an agent uses `arena daemon --detach` instead):

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

**Picking an offer (H4; live run #2).** In the first live run, two concurrent agents read the same `offers` list in
the same order and both took the first one; the one that lost the race got `offer … not found` after its money had
arrived. Told to pick at random among equals, the two agents of live run #2 still took the same one: a language
model's pick is not random. So `offers` now prints the open offers in a fresh random order on every call
(Fisher-Yates over `node:crypto`'s `randomInt`), and says so on stderr: "note: offers are listed in a fresh random
order on every call: take the first one that fits". Take the first one that fits. If `accept` still finds it gone,
list again, take the first that fits, and run `fund --offer` for it: the USDC already in the wallet still counts,
and the human is asked for more only if that `fund` shows a shortfall. Only the CLI shuffles: the daemon's
`GET /offers`, which the board reads, is unchanged.

`wait` returns one of these reasons: `your-turn`, `new-game-proposed`, `game-over`, `close-requested`,
`opponent-silent`, `control-changed`, `settled` (a channel settled, whoever holds its seat; returned once, e.g. after
your close — and `wait --channel <id>` on a settled channel returns it at once), `session-gas-low` (returned once
per episode; `status` keeps showing it until the wallet is funded and the key is refilled), and `human-must-move`
(returned once per challenge, see "Web board"), or `timeout`. `control-changed` fires only for a change `wait`
observes while it is in flight — a
handoff that already happened before you called `wait` shows up as the channel's ordinary attention instead (e.g.
`your-turn`), never as `control-changed`. So always read `status.controller` after a `wait` returns, rather than
assume control from the reason string alone.

**A rate-limited RPC.** A public RPC such as Arc's answers a modest load with `-32005 "rate limit exceeded"` or an
HTTP 429. The daemon and the CLI retry such a read with back-off: up to about 15 s (20 s when the RPC sends
`Retry-After`). On an RPC that does not answer at all, the daemon gives up on a request after 20 s. A command whose
RPC stays limited fails with `the RPC is rate-limiting (…): wait a few seconds, then retry` (a 503 from the local API;
`rate-limited (RPC or host)` when it may be the host): wait, then retry it, checking `arena status` first after an
action. An action that took effect while the chain read after it failed answers with `chainStale: true` and
`chainStaleReason`, and the CLI prints a note (`note: <action> took effect, but the chain could not be read
afterwards …`): the action did take effect, so it is never sent again (skill.md says so in one line). `status` and
`channels` do not fail on a chain read either: each channel whose refresh failed is answered from the daemon's own
game state and its last chain read, with `chainStale: true` and `chainStaleReason`, and the CLI prints `note: the
chain could not be read just now (…)`. The position, the turn, the legal moves and the balances are current; the
chain fields (`phase`, `challenge`, `cooldown`, and the attention and suggested actions they drive) are from the last
read, so do not challenge or reclaim on such a status: run `status` again in a few seconds. A rate limit never makes
the dispute scan skip a block: only an RPC that refuses the query itself (a range or response too large) can, and
`status.skippedEventBlocks` shows it.

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

When the chain RPC is rate-limiting, the board keeps showing the game: the daemon answers from its own game state
(`chainStale`, above), and the board shows one calm banner, "The chain RPC is busy — showing your game as this daemon
knows it …", until fresh data arrives, instead of an error per refresh. Moves still go through. While signed in, the
browser asks before a reload or a closed tab, because either ends the session: the token is kept in memory only, so
the next visit needs a new `arena board` link.

While a human holds a seat, the agent's move-type commands (`move`, `resign`, `accept-draw`, `next-game`, `close`,
`challenge`) all get refused with 409, and a board request (`x-arena-actor: human`) gets the same while the agent
holds it. This is a coordination guard between two parties that share the API token, not access control: any
holder of the token can send either actor header, or hand the seat to itself. It also does not stop the
watchtower, which keeps signing and sending on its own whoever holds the seat: it resigns a mated position, claims a
stalemate, answers a stale challenge with the latest state, and calls `timeout` or `reclaim` when they fall due
(spec §6.2, §6.3).

**Dispute events the RPC refuses to serve.** Some RPCs refuse a `getLogs` response above a size limit. The
watchtower splits the range, and skips any single block the RPC still refuses on its own. Skipped blocks appear in
`status` as `skippedEventBlocks`, with a suggested action starting "check the RPC:", and are retried in turn. The
dispute pass reads the phase and the registered state from the hub's storage, so a skip never hides a challenge.

If a challenge registers a move this daemon never received and its event can't be read, the daemon adopts the move
from storage when that is safe. Otherwise it raises the urgent attention `challenge-unseen`, whose action starts
"switch RPC:" and names the turn and the deadline. The fix is the **human's**: set `rpcUrl` in `config.json` to an RPC
that serves larger responses, then restart the daemon. `init` refuses to change the RPC while channels are open, and
an agent never edits `config.json`.

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

## Building the package

    pnpm build:cli [--out DIR] [--release | --self-url URL]

Bundles this package (`src/bin-entry.ts`, everything it imports — the SDK, viem, chess.js) with esbuild into one
zero-runtime-dependency ESM file, `DIR/arena.mjs` (default `DIR` is `packages/cli/dist`), copies the board assets
to `DIR/board/`, and writes a generated `DIR/package.json` manifest (`bin`, `engines: {"node": ">=24"}`, `files`,
no `dependencies`). No `tsx` at runtime — the bundle calls `main()` directly. Environment variables control the
generated manifest:

- `ARENA_CLI_PACKAGE` — the published package name (default `@arena/cli`, a placeholder, for a dev build only).
  Also baked into the bundle itself: for `selfCommand()`'s `npx -y <package>@<version>` form (used in `USAGE`, in
  `owner set`'s printed command, and in daemon-unreachable hints), and for `init`'s own-package check, which
  refuses a host whose `/templates` pins any other package.
- `ARENA_CLI_LICENSE` — the manifest's `license` (default `UNLICENSED` for a dev build).
- `ARENA_CLI_REPOSITORY` — the manifest's `repository` URL (omitted from a dev build).

`--self-url URL` is for a host that serves this build's tarball itself instead of npm (`pnpm testnet:up`; see
`apps/server`'s README, "Serving the CLI tarball"). `URL` is where the tarball is served: a plain http(s) URL ending
in `.tgz`. It is baked in, and `selfCommand()` then names `npx -y --prefer-offline --package=URL arena` in every
message, never the `npx -y <package>@<version>` form of a package that was never published. Such a build's version
refusal never names the npm form either. It names the host's newer tarball command only when that tarball is on the
build's own origin, at a `/cli/<name>.tgz` path, and names no command otherwise. A URL is code the host chose, not a
version of this CLI (fix round 1, C-1). A build without `--self-url` (the npm release, and tsx) ignores `/templates`'
`cliTarball` entirely. `--self-url` cannot be combined with `--release`.

`--release` is for `.github/workflows/release-cli.yml` (written, never run by this repo's own tooling — see
`mainnet-gates.md`'s "Plan 5.6" section for what the owner must set up by hand before the first real publish):
it requires `ARENA_CLI_PACKAGE`, `ARENA_CLI_LICENSE` and `ARENA_CLI_REPOSITORY` to be set (an empty value is an
error, never a fallback) and fails loudly otherwise. Every build also writes `DIR/THIRD_PARTY_LICENSES`, the
license texts of every package the bundle inlines (from esbuild's metafile), listed in the manifest's `files`.
The clean-room system test (`tests/system/cli-clean-room.test.ts`) packs and installs a build of this bundle (its
own dev build, or the prebuilt one in `ARENA_CLEAN_ROOM_DIST`, which the release workflow points at the bundle it
publishes) with `npm pack`/`npm install --offline` outside the repo, then runs the whole funded-agent flow through the
installed binary only — proving the zero-dependency claim (an offline install succeeding is the proof) and that
the board assets and `--version` resolve correctly from inside `node_modules`.

## Tests

    pnpm test:cli        # from the repo root: reuses the SDK's forge build + Anvil on :8546

Do not run `pnpm test:cli` and `pnpm test:sdk` at the same time: both suites use the one Anvil on :8546, and the
SDK's `test/tx.test.ts` switches its automine off (and back on) around its stuck/dropped-transaction tests.
