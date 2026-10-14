# XMTP Gateway operations (Plan 5.7)

The arena's daemons fall back to XMTP when the host website is unreachable mid-game (spec:
`docs/superpowers/specs/2026-10-13-xmtp-fallback-design.md`, §6). XMTP charges a fee per message, paid by whoever
runs the sending client's gateway. The arena pays that fee on behalf of every agent, so a game in progress never
stalls because an agent's own wallet has no USDC to spend on messaging. **The host, not the agent, pays.**

## What the gateway does

The XMTP Gateway Service is a Go program (`github.com/xmtp/xmtpd/pkg/gateway`) that sits between a client's XMTP
SDK and the XMTP network. It holds a hot **payer** private key, funded with USDC, and pays the network's
per-message fee on behalf of every client that connects through it. Without a gateway, each client would need its
own funded wallet just to send messages; with one, the arena's daemons send over XMTP for free from their own
point of view, exactly as they do over the host's WebSocket relay today.

This is operations-only: no code in this repository runs the gateway. It is deployed and operated by hand (or by
whatever infra tooling the host uses outside this repo), using the compose file here as a starting point.

## The image

```
ghcr.io/xmtp/xmtpd-gateway:main@sha256:03fdbe3cba629746df13bd52138475c8f9d1b530d134ddf63b92611ae5efd968
```

XMTP's docs (<https://docs.xmtp.org/fund-agents-apps/run-gateway>, fetched 2026-10-13) name this image
`xmtp/xmtpd-gateway:main`, which implies Docker Hub. As of 2026-10-13 that repository was **not pullable**
(`pull access denied: repository does not exist or may require authorization`); the same tag resolves on GHCR,
and the digest above is what `docker buildx imagetools inspect ghcr.io/xmtp/xmtpd-gateway:main` returned that day.
Re-check both registries the next time this is re-pinned, in case XMTP later publishes to Docker Hub too.

**XMTP's own docs say this prebuilt image "authorizes all requests without authentication" and "Never use it in
production."** It is fine for ad hoc local testing of the gateway itself, but see "Rate-limiting and client
authentication" below before using it against mainnet traffic. (It is *not* what the arena's own tests run: no
test or CI job in this repository starts this gateway at all -- see "Tests never run this" below. The arena's
system tests run only XMTP's local *node*, `tests/system/xmtp-local/docker-compose.yml`, which has no gateway
service in it.)

## Environment variables

Every `XMTPD_*` variable XMTP's docs document for this service, verbatim:

| Variable | Required | Meaning |
| --- | --- | --- |
| `XMTPD_PAYER_PRIVATE_KEY` | yes | secp256k1 private key of the funded payer account. Treat as a hot wallet key: anyone with it can spend the payer's USDC on messaging fees. |
| `XMTPD_APP_CHAIN_RPC_URL` | yes | RPC endpoint for the XMTP app chain. |
| `XMTPD_SETTLEMENT_CHAIN_RPC_URL` | yes | RPC endpoint for Base (the settlement chain). |
| `XMTPD_APP_CHAIN_WSS_URL` | yes | WebSocket endpoint for the XMTP app chain. |
| `XMTPD_SETTLEMENT_CHAIN_WSS_URL` | yes | WebSocket endpoint for Base. |
| `XMTPD_CONTRACTS_ENVIRONMENT` | yes | One of `anvil`, `testnet`, `mainnet`. |
| `XMTPD_REDIS_CONNECTION_STRING` | no | Optional Redis instance, used for nonce management (and, per XMTP's docs, rate-limiting support). |

`docker-compose.yml` here requires every variable above except the Redis one (`${VAR:?message}` syntax: compose
refuses to start if any required variable is unset or empty), so a misconfigured deploy fails loudly instead of
starting half-configured.

### Host-side port mapping (not upstream config)

Three more variables appear in `docker-compose.yml`'s `ports:` block, but they are **not** part of XMTP's
`XMTPD_*` config surface -- they only choose which host port each container port is published on, and are never
passed into the container's environment. They deliberately don't carry the `XMTPD_` prefix, so a reader grepping
for that prefix to find real upstream config isn't misled into thinking these configure the gateway process
itself:

| Variable | Default | Publishes host port for container port |
| --- | --- | --- |
| `GATEWAY_PORT` | `5050` | `5050` (message traffic) |
| `GATEWAY_PORT_2` | `5055` | `5055` (message traffic) |
| `GATEWAY_METRICS_PORT` | `8008` | `8008` (Prometheus metrics) |

## Funding the payer (USDC on Base)

1. Create or designate the payer's Ethereum account; its private key becomes `XMTPD_PAYER_PRIVATE_KEY`.
2. Acquire USDC on Base. On testnet, get testnet USDC from Circle's faucet: <https://faucet.circle.com/>. On
   mainnet, buy or transfer real USDC to the payer address on Base.
3. Connect the payer wallet to XMTP's Funding Portal and allocate funds through its dashboard. Testnet portal:
   <https://testnet.fund.xmtp.org/>. (XMTP's docs did not give a separate mainnet portal URL as of 2026-10-13;
   use the same portal and confirm it is pointed at mainnet before funding real USDC.)
4. Confirm the funded balance is visible in the portal before pointing live traffic at the gateway.

## Run on infrastructure separate from the website

The gateway must **run on infrastructure separate from the website**. The whole point of the XMTP fallback (spec §1) is
that a game in progress keeps moving when the host website is down. If the gateway runs on the same host, process
group, or infrastructure as `apps/server`, a website outage takes the gateway down with it, and the fallback the
arena is paying for stops working at exactly the moment it's needed. Deploy it on its own box, container host, or
at minimum its own failure domain.

## Rate-limiting and client authentication

XMTP's client auth tokens (`gatewayAuthTokenFetcher`, passed when a client connects through a gateway) are marked
**"coming soon"** in XMTP's docs as of 2026-10-13 -- there is no shipped way yet for the gateway to authenticate
*which* client is connecting. Two things stand in for that today:

- **Default identity is the client's IP.** Absent any other authorization, each connecting client's identity is
  its source IP address.
- **`WithAuthorizers(...)`**, a hook in the Go gateway library, lets an operator reject requests before they're
  paid for. XMTP's docs give this shape (building a custom gateway binary, not a config knob on the prebuilt
  image):

  ```go
  payerService, err := payer.NewPayerServiceBuilder(payer.MustLoadConfig()).
    WithAuthorizers(func(ctx context.Context, identity payer.Identity, req payer.PublishRequest) (bool, error) {
      allowedIPs := []string{"127.0.0.1"} // replace with the actual allow/rate-limit policy
      if !slices.Contains(allowedIPs, identity.Identity) {
        return false, payer.ErrUnauthorized
      }
      return true, nil
    }).
    Build()
  ```

  Multiple authorizers can run together; any one returning `false` rejects the request. An IP-based rate limit
  (not just an allowlist) belongs here, or in `XMTPD_REDIS_CONNECTION_STRING`-backed nonce/rate tracking if that's
  sufficient for the deployment.
- **The prebuilt image (`ghcr.io/xmtp/xmtpd-gateway:main`, pinned above) has no rate limiter built in** -- it
  authorizes everything. Until this repo builds a custom gateway binary with its own `WithAuthorizers` IP
  rate-limit, put the equivalent limit in front of it (reverse proxy or firewall rate-limiting on ports 5050/5055
  per source IP) rather than exposing the bare prebuilt image to the internet.
- **Upgrade path.** Once XMTP ships `gatewayAuthTokenFetcher`, replace IP-based gating with authenticating each
  connecting client's session key, and -- per the design spec's gate (§6) -- authorize only session keys of
  currently open channels, not every client that happens to present a token.

## Payer cap (~$20)

XMTP publishes an all-in estimate of about **$5 per 100,000 messages**, assuming 1&nbsp;KB messages and 90-day
retention (<https://docs.xmtp.org/fund-agents-apps/calculate-fees>, fetched 2026-10-13). A cap of about **$20**
keeps the payer's at-risk balance to roughly:

```
$20 / ($5 / 100,000 messages) = 400,000 messages
```

at that assumed size and retention. The arena's own wire messages can be up to `XMTP_MAX_PAYLOAD_BYTES` (16 KiB,
spec §2/§3) -- 16x XMTP's 1 KB assumption -- so the real per-message storage-fee component may be higher than
the published $5/100k baseline for messages near that size; treat 400,000 as optimistic, not a guarantee, and
re-derive it from actual message sizes once there's production traffic to measure. Keep the payer topped up to
roughly this cap, not indefinitely further, so a bug or an attack can only burn a bounded amount before someone
notices (see monitoring, below).

## Monitoring the payer balance

- **XMTP's Funding Portal dashboard** (the same one used to fund the payer) shows its current balance; check it
  there periodically, or via whatever account/API access the portal offers.
- **The payer's on-chain USDC balance on Base** is the ground truth and can be read directly from any Base RPC,
  independent of the portal.
- **Prometheus metrics on port 8008** (the container's own metrics port; published on the host via
  `GATEWAY_METRICS_PORT`, default 8008 -- see "Host-side port mapping" above) are exposed by the gateway process
  itself; wire them into whatever metrics stack the host already runs. XMTP's docs do not publish a specific
  metric name for the payer balance as of 2026-10-13 -- confirm what the `/metrics` endpoint actually exposes
  before building an alert on a named series, and in the meantime alert on the on-chain balance and the Funding
  Portal dashboard instead.
- Alert well before the ~$20 cap is exhausted (e.g. at 50% and 80% of cap), since running out mid-game means
  every XMTP-fallback send starts failing for every daemon at once.

## Fee enforcement is not yet confirmed

Whether paid messaging through XMTP's mainnet is *currently enforced* is unclear from XMTP's own docs as of
2026-10-13. The funding-portal page (<https://docs.xmtp.org/fund-agents-apps/fund-your-app>, fetched 2026-10-13)
states that "full audits from Trail of Bits and Octane will be published before paid messaging is enforced,"
implying enforcement is gated on those audits landing, with no published date found on the pages fetched for
this work. Separately, this plan's own research notes mention XMTP's docs stating "Until November 1: Testnet-only
period" elsewhere -- that specific line was not confirmed on the pages fetched 2026-10-13, so treat it as a
secondhand pointer to re-verify, not a confirmed fact. Treat mainnet fee enforcement as **not yet confirmed
either way** -- verify current status against XMTP's docs before relying on either "it's free for now" or "it's
already enforced." Per `docs/superpowers/mainnet-gates.md`, no gateway is needed while fees are not enforced; one
is required, funded and monitored, once they are.

## Tests never run this

`tests/system/xmtp-local/docker-compose.yml` runs XMTP's *local node* (no fees, no real chain) for system tests.
This gateway -- real Base RPCs, a real funded payer, real USDC -- is never started by any test or CI job in this
repository. It needs real infrastructure and real funds, which is exactly what tests must not depend on.
