import type { Address, Hex } from "viem";
import { channelId, parseParams, parseRelayMessage, recoverStateSigner, verifyRelayJoin } from "@arena/sdk";
import type { ArenaDomain, Params, PlayerIndex, RelayMessage, SignedState } from "@arena/sdk";
import type { ServerConfig } from "./config.js";
import type { Repo } from "./repo.js";
import type { Metrics } from "./server.js";
import type { ServerFrame } from "./ws.js";

/** What `Relay` needs from a connection: a way to push frames to it, its per-connection join table (shared with
 *  `ws.ts`'s connection state, so a `forward` sees exactly what a `join` set), the nonce it must sign joins over,
 *  and a `closed` flag `leave` sets so a `join` still in flight when the socket closes doesn't add a dead peer. */
export type RelayPeer = { send(frame: ServerFrame): void; joined: Map<Hex, PlayerIndex>; nonce: Hex; closed: boolean };

type ChannelState = {
  params: Params;
  members: Set<RelayPeer>;
  /** Highest-turn `state` message forwarded through this channel whose sender signature verified. Only ever set
   *  from `forward` (after that verification) or seeded from the repo's own verified cache on join -- so this
   *  never holds an unverified state. */
  latest: SignedState | null;
};

const HEX32_RE = /^0x[0-9a-f]{64}$/i;

/** A well-formed 32-byte hex string, lower-cased, or `null` if `v` isn't one -- used to decide whether an error
 *  frame can safely carry a `channelId` the caller will recognize. */
function knownChannelId(v: unknown): Hex | undefined {
  return typeof v === "string" && HEX32_RE.test(v) ? (v.toLowerCase() as Hex) : undefined;
}

/** Untrusted plumbing between a channel's two session keys: nonce-authenticated joins (only for channels this host
 *  knows), forwarding of messages the sender has already signed, and a per-sender cache of recent states plus the
 *  latest close that lets a rejoining member catch up. The relay does not enforce game rules or channel state
 *  machine transitions -- daemons re-verify everything they receive. */
export class Relay {
  private readonly channels = new Map<Hex, ChannelState>();
  private readonly domain: ArenaDomain;

  constructor(
    private readonly repo: Repo,
    private readonly cfg: ServerConfig,
    private readonly metrics: Metrics,
    private readonly log: (l: string) => void,
  ) {
    this.domain = { chainId: cfg.chainId, hub: cfg.hub };
  }

  /** The highest-turn `state` message cached for this channel in the repo, or `null`. Every entry in the repo's
   *  cache was verified before it was written (in `forward`), so no re-verification is needed here. */
  private highestCachedState(id: Hex): SignedState | null {
    let best: SignedState | null = null;
    for (const { message } of this.repo.cachedRelay(id)) {
      if (message.type !== "state") continue;
      if (!best || message.signed.state.turnNum > best.state.turnNum) best = message.signed;
    }
    return best;
  }

  /** Joins `peer` to the channel named by `frame`, or sends an `error` frame naming why not. On success, sends
   *  `joined` followed by a replay of the channel's cached messages from the *other* member: its states in
   *  ascending `turnNum` order, then its close. */
  async join(
    peer: RelayPeer,
    frame: { channelId: unknown; params: unknown; signer: unknown; sig: unknown },
  ): Promise<void> {
    try {
      const claimed = knownChannelId(frame.channelId);
      let params: Params;
      try {
        params = parseParams(frame.params);
      } catch {
        peer.send({ type: "error", error: "malformed join frame", channelId: claimed });
        return;
      }
      const expected = channelId(this.cfg.chainId, this.cfg.hub, params);
      if (claimed !== expected) {
        peer.send({ type: "error", error: "params do not match channel", channelId: claimed });
        return;
      }
      // anyone can mint params and keys for a throwaway channel; only channels matched by this host's lobby or
      // seen on-chain by its indexer may occupy the cache
      if (!this.repo.knownChannel(expected)) {
        peer.send({ type: "error", error: "unknown channel", channelId: expected });
        return;
      }
      const signer = frame.signer;
      const sig = frame.sig;
      if (typeof signer !== "string" || typeof sig !== "string") {
        peer.send({ type: "error", error: "malformed join frame", channelId: expected });
        return;
      }
      const idxRaw = params.signers.findIndex((s) => s.toLowerCase() === signer.toLowerCase());
      if (idxRaw !== 0 && idxRaw !== 1) {
        peer.send({ type: "error", error: "not a member of this channel", channelId: expected });
        return;
      }
      const idx = idxRaw as PlayerIndex;
      const ok = await verifyRelayJoin(expected, peer.nonce, signer as Address, sig as Hex);
      if (!ok) {
        peer.send({ type: "error", error: "bad join signature", channelId: expected });
        return;
      }
      // the only await in this function: the socket may have closed while we were verifying. Don't add a peer
      // whose connection is already gone -- it would never be removed from `channel.members` again.
      if (peer.closed) return;
      const alreadyJoined = peer.joined.has(expected);
      if (!alreadyJoined && peer.joined.size >= this.cfg.limits.maxJoinsPerConnection) {
        peer.send({ type: "error", error: "too many channels on this connection", channelId: expected });
        return;
      }
      peer.joined.set(expected, idx);
      let channel = this.channels.get(expected);
      if (!channel) {
        // repopulates params (and seeds the verified-latest cache) after a restart -- a fresh Relay's channel
        // map is empty until a member rejoins
        channel = { params, members: new Set<RelayPeer>(), latest: this.highestCachedState(expected) };
        this.channels.set(expected, channel);
      } else {
        channel.params = params;
      }
      channel.members.add(peer);
      peer.send({ type: "joined", channelId: expected });

      const cached = this.repo.cachedRelay(expected).filter((e) => e.sender !== idx);
      const turnOf = (e: (typeof cached)[number]) => (e.message.type === "state" ? e.message.signed.state.turnNum : 0n);
      const states = cached.filter((e) => e.message.type === "state").sort((x, y) => (turnOf(x) < turnOf(y) ? -1 : 1));
      const closes = cached.filter((e) => e.message.type === "close");
      for (const entry of [...states, ...closes]) peer.send({ type: "relay", message: entry.message });
    } catch (err) {
      this.log(
        JSON.stringify({ ts: new Date().toISOString(), level: "error", msg: "relay join failed", error: String(err) }),
      );
      peer.send({ type: "error", error: "internal", channelId: knownChannelId(frame.channelId) });
    }
  }

  /** Forwards `raw` (parsed as a `RelayMessage`) to every other member of its channel, provided `peer` has joined
   *  that channel and the message is validly attributed to `peer`'s player index. Sends an `error` frame, and does
   *  not forward, on any refusal. */
  async forward(peer: RelayPeer, raw: unknown): Promise<void> {
    // best-effort, independent of whether `raw` parses at all -- lets even a "malformed" or "internal" error
    // frame carry the channelId the CLI is filtering on, when the raw frame at least named one.
    const rawId = knownChannelId((raw as { channelId?: unknown } | null | undefined)?.channelId);
    try {
      let message: RelayMessage;
      try {
        message = parseRelayMessage(raw);
      } catch {
        peer.send({ type: "error", error: "malformed relay message", channelId: rawId });
        return;
      }
      const id = message.channelId;
      const idx = peer.joined.get(id);
      const channel = idx === undefined ? undefined : this.channels.get(id);
      if (idx === undefined || !channel) {
        peer.send({ type: "error", error: "not joined to this channel", channelId: id });
        return;
      }

      if (message.type === "state") {
        const sig = idx === 0 ? message.signed.sigA : message.signed.sigB;
        let signer: Address | null = null;
        try {
          signer = await recoverStateSigner(message.signed.state, sig, this.domain);
        } catch {
          signer = null;
        }
        if (!signer || signer.toLowerCase() !== channel.params.signers[idx].toLowerCase()) {
          peer.send({ type: "error", error: "state not signed by sender", channelId: id });
          return;
        }
        if (!channel.latest || message.signed.state.turnNum > channel.latest.state.turnNum) {
          channel.latest = message.signed;
        }
      } else {
        if (message.close.by !== idx) {
          peer.send({ type: "error", error: "close not from sender", channelId: id });
          return;
        }
      }

      this.repo.cacheRelay(id, idx, message);
      this.metrics.relayMessages += 1;
      for (const member of channel.members) {
        if (member.joined.get(id) !== idx) member.send({ type: "relay", message });
      }
    } catch (err) {
      this.log(
        JSON.stringify({
          ts: new Date().toISOString(),
          level: "error",
          msg: "relay forward failed",
          error: String(err),
        }),
      );
      peer.send({ type: "error", error: "internal", channelId: rawId });
    }
  }

  /** Removes `peer` from every channel *it* joined (via its own join table, not a scan of every channel this
   *  process knows about -- with many channels and frequent reconnects that scan is an easy self-inflicted DoS).
   *  Drops a channel entirely once its last member leaves: `latestState` falls back to the repo on a miss, and
   *  `join` re-seeds a channel's params and verified-latest cache from the repo the next time either side
   *  reconnects, so nothing is lost. Called on socket close; also marks the peer `closed` so a `join` still in
   *  flight for it won't add it back. */
  leave(peer: RelayPeer): void {
    peer.closed = true;
    for (const id of peer.joined.keys()) {
      const channel = this.channels.get(id);
      if (!channel) continue;
      channel.members.delete(peer);
      if (channel.members.size === 0) this.channels.delete(id);
    }
  }

  /** Removes `peer` from one channel at its request (a `leave` frame: the channel is settled on its side), freeing
   *  that slot under `maxJoinsPerConnection`. Leaving a channel it never joined is a silent no-op. */
  leaveChannel(peer: RelayPeer, rawId: unknown): void {
    const id = knownChannelId(rawId);
    if (!id) {
      peer.send({ type: "error", error: "malformed leave frame" });
      return;
    }
    if (!peer.joined.delete(id)) return;
    const channel = this.channels.get(id);
    if (!channel) return;
    channel.members.delete(peer);
    if (channel.members.size === 0) this.channels.delete(id);
  }

  /** The number of channels this process currently holds state for -- i.e. with at least one connected member.
   *  Test-only introspection for the leak fix above. */
  channelCount(): number {
    return this.channels.size;
  }

  /** The highest-turn cached `state` message whose sender signature verified, or `null` if the channel has none.
   *  Prefers the in-memory copy (already verified when it was cached, in `forward` or seeded on `join`); falls
   *  back to the repo's own verified cache on a cold cache (no channel joined yet in this process). */
  latestState(channelId: Hex): SignedState | null {
    const channel = this.channels.get(channelId);
    if (channel) return channel.latest;
    return this.highestCachedState(channelId);
  }
}
