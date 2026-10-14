# XMTP fallback transport — design

Date: 2026-10-13. Status: approved in conversation. This is the written spec for Plan 5.7, which comes before Plan 6.
Parent spec: `docs/superpowers/specs/2026-09-24-agent-chess-arena-design.md`.

## 1. Goal

A game in progress keeps moving at full speed when the host website (lobby + WebSocket relay) is unreachable.
Daemons fall back to XMTP, a messaging network keyed by Ethereum addresses. The chain (challenge and respond)
remains the last resort, as today.

### Decisions (owner, 2026-10-13)
- The **host relay stays primary**. XMTP is a fallback, not a replacement.
- **The host pays for XMTP fees** through an XMTP Gateway Service. The gateway runs on infrastructure separate from
  the website, so it survives a website outage.
- **Build and test before launch.** Plan 6 (Arc and Circle) comes after this plan.

### Success criteria
1. A system test runs two daemons against XMTP's local node (Docker). It starts a game, kills the host server
   mid-game, finishes the game over XMTP, closes cooperatively, and settles on-chain. It then restarts the server and
   shows the daemons back on the relay.
2. With XMTP not enabled, behaviour is byte-for-byte today's: every existing test passes unchanged.
3. An XMTP message from a sender **known** not to be the opponent is dropped before it reaches the session. A
   message whose sender cannot be determined (a lookup error, timeout or unresolved conversation) reaches the
   session. There, as with every relayed message, nothing changes without the channel's own session-key
   signatures. *(Amended 2026-10-14 after three review rounds: a lookup that can fail must never cost liveness.)*

### Non-goals
- XMTP as the primary transport.
- Lobby or discovery over XMTP. While the site is down, **no new matches** can be made; only games already in
  progress continue.
- Free-text chat between agents.
- Per-client gateway authentication. XMTP marks its client auth-token support "coming soon"; until it ships, the
  gateway rate-limits by IP.

## 2. Transport

- The daemon talks to the relay only through `RelayClient`: `join`, `send`, `onMessage`, `onJoined` and `leave`
  (`packages/sdk/src/wire.ts`). A new **`FallbackRelay`** implements `RelayClient` by composing the host relay
  (`connectHost(...).relay`) and an **`XmtpRelay`**. Daemon game logic does not change.
- **Receive:** messages from both transports are always accepted and fed to the same handlers. Duplicates are
  harmless: the session treats an exact duplicate of `latest` as a no-op, and the close-signature path is
  idempotent. `onJoined` is driven by the host relay only. Its reconnect re-send of the latest state and the close
  signature is unchanged.
- **Send:** a message goes via the host relay while the host relay is *up for that channel*: the socket is open and
  the channel is joined. Otherwise it goes via XMTP. A channel counts as *down* once it has not been up for
  `HOST_DOWN_GRACE_MS = 3000`. Until then, sends are held briefly and retried on whichever side is up first. A send
  never throws to the daemon for a transport reason; failures are logged and retried by the daemon's existing paths.
- **Switch back:** when the host relay rejoins the channel, the existing `onJoined` re-send runs, and later sends go
  via the host again.
- **Status:** `ChannelStatus` gains `transport: "relay" | "xmtp" | "none"`, the side currently used to send, and
  `xmtpDropped`, the channel's count of dropped inbound XMTP messages (0 with XMTP off). The daemon start line gains
  `fallback: "xmtp" | "off"`, and the daemon's API a read-only `GET /fallback` returning `{fallback, reason?}`.

## 3. XMTP identity and messages

- **Identity.** Each channel's own session key (`params.signers[me]`) is its XMTP identity, and the opponent's is
  `params.signers[other]`, so no discovery is needed. The XMTP client signs with the session key through the same
  signer object the relay join already uses. The private key never leaves the daemon (I5).
- **Client lifecycle.** *(Amended 2026-10-14, final fix wave I-1.)* The client is created once the channel is
  **Open on chain** -- both deposits in -- not when it is matched and joined: an accept costs its sender nothing, so
  a client per match would let anyone grow a daemon by accepting its offers. The daemon arms it from its chain
  refresh (phase `Open` or `Challenged`), still ahead of need; the host relay join at match time is unchanged, and
  until armed a channel is the host relay's alone. A daemon holds at most `XMTP_MAX_CLIENTS = 64` clients at once
  (a client counts until its close has finished); a channel past the cap runs without the fallback, logged once,
  its `transport` `"relay"` or `"none"` as without XMTP. The client is closed with `Client.close()` (bounded) when
  the channel is finalized -- its database files are then deleted, since its inbox is never used again -- or when
  the daemon stops (the files are kept, so a restart resumes the same installation).
- **Storage.** The database is `<home>/xmtp/db/<channelId>.db3` (with its `-wal`/`-shm`), one connection per client
  (`useSingleConnection`). The encryption key is
  `keccak256(signer.signMessage("arena-xmtp-db/v1:" + channelId))`, 32 bytes. Signing is RFC 6979-deterministic,
  so the key is stable, there is no new secret to store, and the raw session key never reaches the XMTP code (I5).
  A persisted database avoids re-registering an installation. XMTP caps an inbox at 10 installations.
- **Wire format.** One XMTP text message per `RelayMessage`: `{"arena": 1, "msg": <RelayMessage wire JSON>}`. It
  uses the same encoding the host relay uses (`wire.ts`), at most 16 KiB.
- **Acceptance.**
  - **Fast path.** `open()` creates the DM to the peer and remembers its conversation id(s). A message in a known
    opponent DM needs no lookup.
  - **Otherwise**, the sender is looked up. A **known stranger** (lookup succeeded, address != the opponent's
    signer, or a DM with someone else) is dropped and counted (`xmtpDropped`), before it consumes any rate-limit
    budget. An **undetermined** sender (lookup failed or timed out) is delivered in arrival order to the session,
    which verifies every state and close signature (`session.receive`, `session.receiveClose`) exactly as it does
    for host-relay traffic. There is no holding or "gap" machinery.
  - **Who the opponent is (C-N1).** The opponent is identified only by verified member addresses, never by the
    recovery identifier:
    - a sender's inbox state is matched by its member identifiers (Ethereum kind) alone -- each was added with its
      own signature -- never by its recovery identifier, which any inbox can set to any address unsigned;
    - the opponent's inbox id is set only by answers keyed by the opponent's own address (its DM, found with
      `createDmWithIdentifier`, and the network's `fetchInboxIdByIdentifier`), and each such answer replaces the
      stored one; a sender's own inbox state classifies that one message and never sets it;
    - a stranger's DM is denied, but never the DM found by the opponent's address, nor any conversation whose
      peer is the opponent's inbox; one of the opponent's denied earlier is allowed again.
  - **Every message also passes:** the 16 KiB cap; `arena === 1`; the existing wire validators; per-channel rate
    limiting with the host relay's budget; dedupe by XMTP message id.
  - **Rejections.** A session rejection of an undetermined-sender message is counted in `xmtpDropped`. It never
    sets `lastError` and is never logged per message, so a stranger flood during a lookup outage cannot spam
    `status`.
  - **Rate limit (K1).** A message the channel's budget turns away is not marked delivered; once the bucket has
    refilled, a catch-up re-reads the opponent DM's latest messages and delivers it, in order, without restarting
    the stream (a catch-up turned away again backs off, 1 s doubling to 30 s).
  - **Accepted residual.** During a lookup outage, strangers' messages share the channel's inbound budget with the
    opponent's; an opponent message they push out is re-delivered by the catch-up once the flood ends, if it is
    still among the DM's latest `XMTP_CATCH_UP_MESSAGES`. The chain fallback covers a resulting stall. What the SDK
    stores regardless, in the channel's own encrypted DB until the channel is finalized: each stranger's welcome
    (the new conversation), the messages it delivered before its deny, and its inbox's identity record.
- **Environment.** `xmtp.env` is one of `"local" | "dev" | "production"`, plus optional `apiUrl` (tests, local
  node) and optional `gatewayHost` (dev or production, once fees are enforced).

## 4. Packaging (the SDK is about 480 MB installed)

- The published CLI bundle stays zero-dependency, and the XMTP SDK is never bundled.
- `arena xmtp enable` installs the pinned `@xmtp/node-sdk@6.1.0` into `<home>/xmtp/sdk/` with
  `npm install --prefix <home>/xmtp/sdk --no-audit --no-fund --save-exact`. It then verifies the installed version.
  *(6.0.0 until the final fix wave: 6.1.0 adds `Client.close()`, without which a client was never released.)*
  `arena xmtp status` reports `{enabled, version, env}`, plus `daemon`: what the **running** daemon loaded
  (`"xmtp"` or `"off"` with `daemonReason`, from its `GET /fallback`), or `"not running"`. `arena xmtp disable`
  removes the directory.
- The daemon loads the SDK with a dynamic import from that path, and only when it is present and `config.xmtp` is
  set -- once, at start: an `xmtp enable` after that needs a daemon restart. A load failure is logged once, and the
  daemon runs with `fallback: "off"`. An invalid `xmtp` in `config.json` does the same (one warning; every command
  still runs); only `init` refuses one.
- The recipe (`skill.md`) gains one recommended step, before the daemon is started: enable the fallback before
  playing for real money, then check `xmtp status` shows `"daemon": "xmtp"`. House bots enable it when the server
  publishes `xmtp`.

## 5. Configuration

- **Server.** The server config gains optional `xmtp: {env, apiUrl?, gatewayHost?}`, published in `/templates`.
- **`init`.** `init` copies it into `config.json`, and the daemon reads it from there. The site may be down exactly
  when it is needed, so the daemon never fetches it at fallback time.
- **`dev:up`.** `dev:up` publishes `xmtp` only when started with `--xmtp-local`. That flag starts XMTP's local node
  via the pinned compose file of §7.

## 6. The host-paid gateway (operations)

- The XMTP Gateway Service is a Go service (`github.com/xmtp/xmtpd/pkg/gateway`; image `xmtp/xmtpd-gateway`). It
  holds a hot payer key funded with USDC on Base through XMTP's Funding Portal.
- `deploy/xmtp-gateway/` gets:
  - a compose file with the image pinned by digest;
  - the required `XMTPD_*` environment variables, documented;
  - an IP rate-limit authorizer setting;
  - a README covering funding, the separate-infrastructure requirement, a payer cap of about $20 (roughly 400k
    messages at XMTP's published ~$5 per 100k), and monitoring.
- The arena never runs the gateway in tests: it needs Base and real funds.
- **Mainnet gates.**
  - While XMTP fees are not enforced, no gateway is needed.
  - Once they are, the gateway must be running on separate infrastructure, funded and monitored, and the server
    must publish `gatewayHost`.
  - When XMTP ships client auth tokens, the gateway must authorize only session keys of open channels.

## 7. Testing

- **Unit (CLI)**, against a fake XMTP transport:
  - the send rule, including the 3 s grace window and switching both ways;
  - receive from both, with dedupe;
  - wrong sender, wrong conversation, oversized or malformed payloads all dropped;
  - per-channel rate limit;
  - `transport` and `fallback` in status;
  - no behaviour change when XMTP is disabled.
- **Packaging.** `xmtp enable`, `status` and `disable` against a local npm-registry stub, or a pre-populated
  directory, so tests never download the SDK. Plus one opt-in real install check, and an opt-in real-SDK check that
  clients opened and closed release their file descriptors.
- **System**, against XMTP's local node (`tests/system/xmtp-local/docker-compose.yml`, a copy of
  `xmtp/xmtp-local-node` pinned by image digest, with ports chosen per run through `apiUrl`):
  - the kill-the-host scenario of success criterion 1;
  - a flapping host (down, up, down);
  - a house bot with XMTP;
  - an injected third-party XMTP message is ignored.

  These tests run in `pnpm test:system` when Docker is available, and are reported as skipped, loudly, otherwise.
  The release workflow requires Docker.
- **Manual.** A smoke script against XMTP's public `dev` network.

## 8. Spec and gate updates

- Parent spec: add §12 items for `FallbackRelay`, XMTP identity and acceptance, packaging, configuration, and the
  gateway.
- `mainnet-gates.md`, Plan 5.7:
  - the gateway is funded and running on separate infrastructure when fees are enforced;
  - gateway authentication once XMTP ships it;
  - XMTP production verified end to end before launch;
  - the supply-chain note for the pinned native SDK.
