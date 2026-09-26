import type { Address, Hex } from "viem";
import { channelId, parseParams, parseRelayMessage, recoverStateSigner, verifyRelayJoin } from "@arena/sdk";
import type { ArenaDomain, Params, PlayerIndex, RelayMessage, SignedState } from "@arena/sdk";
import type { ServerConfig } from "./config.js";
import type { Repo } from "./repo.js";
import type { Metrics } from "./server.js";
import type { ServerFrame } from "./ws.js";

/** What `Relay` needs from a connection: a way to push frames to it, its per-connection join table (shared with
 *  `ws.ts`'s connection state, so a `forward` sees exactly what a `join` set), and the nonce it must sign joins
 *  over. */
export type RelayPeer = { send(frame: ServerFrame): void; joined: Map<Hex, PlayerIndex>; nonce: Hex };

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

/** Untrusted plumbing between a channel's two session keys: nonce-authenticated joins, forwarding of messages the
 *  sender has already signed, and a last-message-per-sender cache that lets a rejoining member catch up. The relay
 *  does not enforce game rules or channel state machine transitions -- daemons re-verify everything they receive. */
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
   *  `joined` followed by a replay of the channel's cached messages from the *other* member (state, then close). */
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
      const states = cached.filter((e) => e.message.type === "state");
      const closes = cached.filter((e) => e.message.type === "close");
      for (const entry of [...states, ...closes]) peer.send({ type: "relay", message: entry.message });
    } catch (err) {
      this.log(
        JSON.stringify({ ts: new Date().toISOString(), level: "error", msg: "relay join failed", error: String(err) }),
      );
      peer.send({ type: "error", error: "internal" });
    }
  }

  /** Forwards `raw` (parsed as a `RelayMessage`) to every other member of its channel, provided `peer` has joined
   *  that channel and the message is validly attributed to `peer`'s player index. Sends an `error` frame, and does
   *  not forward, on any refusal. */
  async forward(peer: RelayPeer, raw: unknown): Promise<void> {
    try {
      let message: RelayMessage;
      try {
        message = parseRelayMessage(raw);
      } catch {
        peer.send({ type: "error", error: "malformed relay message" });
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
      peer.send({ type: "error", error: "internal" });
    }
  }

  /** Removes `peer` from every channel it was a member of. Called on socket close; `peer.joined` itself is left
   *  alone since the connection (and the peer) is going away with it. */
  leave(peer: RelayPeer): void {
    for (const channel of this.channels.values()) channel.members.delete(peer);
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
