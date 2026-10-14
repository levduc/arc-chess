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
3. An XMTP message from anyone except the channel's opponent session key is dropped before it reaches the session.

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
- **Status:** `ChannelStatus` gains `transport: "relay" | "xmtp" | "none"`, the side currently used to send. The
  daemon start line gains `fallback: "xmtp" | "off"`.

## 3. XMTP identity and messages

- **Identity.** Each channel's own session key (`params.signers[me]`) is its XMTP identity, and the opponent's is
  `params.signers[other]`, so no discovery is needed. The XMTP client signs with the session key through the same
  signer object the relay join already uses. The private key never leaves the daemon (I5).
- **Client lifecycle.** The client is created when the channel is opened and joined, ahead of need. It is stopped
  when the channel is finalized or the daemon stops.
- **Storage.** The database is `<home>/xmtp/db/<channelId>.db3`. The encryption key is
  `keccak256(signer.signMessage("arena-xmtp-db/v1:" + channelId))`, 32 bytes. Signing is RFC 6979-deterministic,
  so the key is stable, there is no new secret to store, and the raw session key never reaches the XMTP code (I5).
  A persisted database avoids re-registering an installation. XMTP caps an inbox at 10 installations.
- **Wire format.** One XMTP text message per `RelayMessage`: `{"arena": 1, "msg": <RelayMessage wire JSON>}`. It
  uses the same encoding the host relay uses (`wire.ts`), at most 16 KiB.
- **Acceptance.** A message is accepted only when all of the following hold:
  - the XMTP sender's address equals the opponent's signer for `msg.channelId`;
  - the conversation is a DM with that address;
  - the payload parses and validates with the existing wire validators.

  Anything else is dropped and counted (`xmtpDropped`). Inbound messages are rate-limited per channel, with the
  same budget the host relay enforces. As today, every state and close signature is then verified by the session.
- **Environment.** `xmtp.env` is one of `"local" | "dev" | "production"`, plus optional `apiUrl` (tests, local
  node) and optional `gatewayHost` (production, once fees are enforced).

## 4. Packaging (the SDK is about 725 MB)

- The published CLI bundle stays zero-dependency, and the XMTP SDK is never bundled.
- `arena xmtp enable` installs the pinned `@xmtp/node-sdk@6.0.0` into `<home>/xmtp/sdk/` with
  `npm install --prefix <home>/xmtp/sdk --no-audit --no-fund --save-exact`. It then verifies the installed version.
  `arena xmtp status` reports `{enabled, version, env}`. `arena xmtp disable` removes the directory.
- The daemon loads the SDK with a dynamic import from that path, and only when it is present and `config.xmtp` is
  set. A load failure is logged once, and the daemon runs with `fallback: "off"`.
- The recipe (`skill.md`) gains one recommended step: enable the fallback before playing for real money. House bots
  enable it when the server publishes `xmtp`.

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
  directory, so tests never download 725 MB. Plus one opt-in real install check.
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
