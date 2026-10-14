import type { Hex } from "viem";
import type { Params, RelayClient, RelayMessage, RelaySigner } from "@arena/sdk";
import type { HostRelay } from "../host.js";
import { XmtpRelay } from "./relay.js";
import type { XmtpTransport } from "./transport.js";

/** Spec §2: a channel whose host relay has not been up for this long is *down*, and its sends go via XMTP. */
export const HOST_DOWN_GRACE_MS = 3000;
/** Spec §3: the largest XMTP text accepted or sent, in UTF-8 bytes. */
export const XMTP_MAX_PAYLOAD_BYTES = 16 * 1024;

/** The side a channel's sends currently go to (`ChannelStatus.transport`). */
export type ChannelTransport = "relay" | "xmtp" | "none";

/** How many of a channel's latest messages sent via the host are kept, to replay over XMTP when the host goes down
 *  (see `FallbackRelay`). The daemon's own re-send covers at most three: its latest state, a pending new-game
 *  proposal, and its Close signature. */
const HOST_SENT_KEPT = 4;
/** The floor on a re-check timer, so a clock that has not moved yet (an injected `now`) never spins. */
const MIN_WAKE_MS = 10;
/** A channel's queue stops waiting on one XMTP send after this long (the send itself carries on), so a hung XMTP
 *  call can never hold up the channel's later messages -- or the host relay, once it is back. */
export const XMTP_SEND_WAIT_MS = 30_000;

type Pending = { msg: RelayMessage; done: () => void };

type Channel = {
  /** The channel id exactly as `join` was given it, for every call to the host relay. */
  hostId: Hex;
  /** When the host relay was last seen going down for this channel (or when it was joined, if it never came up);
   *  null while it is up. */
  downSince: number | null;
  /** Sends not yet handed to a transport, oldest first. */
  outbox: Pending[];
  /** The latest messages that went via the host, oldest first (at most `HOST_SENT_KEPT`). */
  hostSent: RelayMessage[];
  /** Set when the host goes down with `hostSent` non-empty; cleared once they are replayed over XMTP or the host is
   *  back up first. */
  replayPending: boolean;
  /** Set by the first XMTP send of an outage (which is logged), cleared when the host has the channel again. */
  onXmtp: boolean;
  pumping: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
};

const errorText = (err: unknown) => (err instanceof Error ? err.message.split("\n")[0] : String(err));
const key = (id: Hex) => id.toLowerCase() as Hex;

/**
 * Plan 5.7 (spec §2): the daemon's `RelayClient` when the XMTP fallback is on -- the host relay first, XMTP when the
 * host is down for a channel. Daemon game logic does not change.
 *
 * Send rule, per channel: while `host.isJoined(id)`, a message goes via the host. Once the channel has not been
 * joined for `graceMs`, it goes via XMTP as `{"arena":1,"msg":…}`. In between, it is held (in order) and retried on
 * the host's `onLinkChange` or a timer at the end of the window, whichever comes first. `send` resolves once its
 * message has been handed to a transport, so a slow XMTP never holds up a move; it never rejects for a transport
 * reason (failures are logged, and the daemon's own paths re-send).
 *
 * "Down" means not joined: the socket is closed, or open with the channel not (yet) joined -- the half-up host of
 * Review Focus 1. A host that has joined the channel but silently drops its frames is out of scope here: the
 * chain fallback (challenge and respond) covers it, as before.
 *
 * Receive: messages from both transports go to the same handlers. A message that arrives by both is harmless: the
 * session treats an exact repeat as a no-op, and the close path is idempotent. `onJoined` is the host's alone.
 *
 * When a channel goes down, the last few messages it sent via the host (`HOST_SENT_KEPT`) are replayed once over
 * XMTP at the end of the window: a frame the host accepted just before it died is otherwise never re-sent, since
 * the daemon re-sends only on the host's `onJoined`. The receiver treats any it already has as repeats.
 */
export class FallbackRelay implements RelayClient {
  private readonly host: HostRelay;
  private readonly xmtp: XmtpRelay;
  private readonly graceMs: number;
  private readonly now: () => number;
  private readonly log: (l: string) => void;
  private readonly channels = new Map<Hex, Channel>();
  private readonly handlers = new Set<(msg: RelayMessage) => void>();
  private readonly unsubscribers: Array<() => void> = [];

  constructor(opts: { host: HostRelay; xmtp: XmtpTransport; graceMs?: number; now?: () => number; log?(l: string): void }) {
    this.host = opts.host;
    this.graceMs = opts.graceMs ?? HOST_DOWN_GRACE_MS;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ? (l) => opts.log?.(l) : () => undefined;
    this.xmtp = new XmtpRelay({ xmtp: opts.xmtp, maxPayloadBytes: XMTP_MAX_PAYLOAD_BYTES, now: this.now, log: this.log });
    this.unsubscribers.push(
      this.host.onMessage((m) => this.emit(m)),
      this.xmtp.onMessage((m) => this.emit(m)),
      this.host.onLinkChange(() => this.onLinkChange()),
    );
  }

  /** Joins the host relay exactly as before (its promise is the host's), and starts the channel's XMTP client in
   *  the background, so a slow XMTP never delays the host join. */
  join(channelId: Hex, params: Params, signer: RelaySigner): Promise<void> {
    const id = key(channelId);
    if (!this.channels.has(id)) {
      this.channels.set(id, {
        hostId: channelId,
        downSince: this.host.isJoined(channelId) ? null : this.now(),
        outbox: [],
        hostSent: [],
        replayPending: false,
        onXmtp: false,
        pumping: false,
        timer: undefined,
      });
    }
    this.xmtp.open(channelId, params, signer).catch((err: unknown) => this.log(`xmtp: channel ${id}: ${errorText(err)}`));
    return this.host.join(channelId, params, signer);
  }

  send(msg: RelayMessage): Promise<void> {
    const id = key(msg.channelId);
    const ch = this.channels.get(id);
    if (!ch) return this.host.send(msg); // never joined through here: the host's behaviour, unchanged
    return new Promise<void>((resolve) => {
      ch.outbox.push({ msg, done: resolve });
      void this.pump(id, ch);
    });
  }

  onMessage(handler: (msg: RelayMessage) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  onJoined(handler: (channelId: Hex) => void): () => void {
    return this.host.onJoined(handler);
  }

  leave(channelId: Hex): void {
    const id = key(channelId);
    const ch = this.channels.get(id);
    if (ch) {
      this.channels.delete(id);
      clearTimeout(ch.timer);
      for (const p of ch.outbox.splice(0)) p.done(); // left for good: nothing more is sent on it
    }
    this.host.leave(channelId);
    this.xmtp.close(channelId).catch((err: unknown) => this.log(`xmtp: channel ${id}: close failed: ${errorText(err)}`));
  }

  /** The side this channel's sends go to now: `"relay"` while the host has it joined, `"xmtp"` once it has been down
   *  for the grace window, `"none"` within the window (sends are held) or for a channel not joined here. */
  transportOf(channelId: Hex): ChannelTransport {
    const id = key(channelId);
    const ch = this.channels.get(id);
    if (!ch) return "none";
    this.observe(ch);
    if (this.host.isJoined(ch.hostId)) return "relay";
    return this.pastGrace(ch) ? "xmtp" : "none";
  }

  /** Messages dropped by the XMTP acceptance checks, per channel (spec §3). */
  dropped(channelId: Hex): number {
    return this.xmtp.dropped(channelId);
  }

  /** Stops every channel's XMTP client. The host connection is the caller's to close. */
  async stop(): Promise<void> {
    for (const u of this.unsubscribers.splice(0)) u();
    for (const ch of this.channels.values()) {
      clearTimeout(ch.timer);
      for (const p of ch.outbox.splice(0)) p.done();
    }
    this.channels.clear();
    this.handlers.clear();
    await this.xmtp.stop();
  }

  // ---------------------------------------------------------------- internals

  private emit(msg: RelayMessage): void {
    for (const h of this.handlers) {
      try {
        h(msg);
      } catch (err) {
        this.log(`relay: onMessage handler threw: ${errorText(err)}`);
      }
    }
  }

  private pastGrace(ch: Channel): boolean {
    return ch.downSince !== null && this.now() - ch.downSince >= this.graceMs;
  }

  /** Brings `downSince` up to date with the host's link: null while joined, set on the first look after it drops. */
  private observe(ch: Channel): void {
    if (this.host.isJoined(ch.hostId)) {
      ch.downSince = null;
      ch.replayPending = false; // back up first: the daemon's onJoined re-send covers it
      if (ch.onXmtp) {
        ch.onXmtp = false;
        this.log(`relay: channel ${key(ch.hostId)}: back on the host relay`);
      }
      return;
    }
    if (ch.downSince === null) {
      ch.downSince = this.now();
      if (ch.hostSent.length > 0) ch.replayPending = true;
    }
  }

  private onLinkChange(): void {
    for (const [id, ch] of this.channels) {
      this.observe(ch);
      if (ch.outbox.length > 0 || ch.replayPending) void this.pump(id, ch);
    }
  }

  private scheduleWake(id: Hex, ch: Channel): void {
    if (ch.timer !== undefined || ch.downSince === null) return;
    const delay = Math.max(MIN_WAKE_MS, ch.downSince + this.graceMs - this.now());
    ch.timer = setTimeout(() => {
      ch.timer = undefined;
      if (this.channels.get(id) === ch) void this.pump(id, ch);
    }, delay);
  }

  /** Hands this channel's held sends (and any pending replay) to a transport, in order, until it must wait. One
   *  pump per channel at a time; a send or link change during a pump is picked up by its loop. */
  private async pump(id: Hex, ch: Channel): Promise<void> {
    if (ch.pumping) return;
    ch.pumping = true;
    let hostFailed = false;
    try {
      while (this.channels.get(id) === ch) {
        this.observe(ch);
        if (!hostFailed && this.host.isJoined(ch.hostId)) {
          const next = ch.outbox.shift();
          if (!next) return;
          try {
            await this.host.send(next.msg);
          } catch {
            // The socket went between the check and the send: the same message takes the not-joined path below.
            ch.outbox.unshift(next);
            hostFailed = true;
            if (ch.downSince === null) {
              ch.downSince = this.now();
              if (ch.hostSent.length > 0) ch.replayPending = true;
            }
            continue;
          }
          ch.hostSent.push(next.msg);
          if (ch.hostSent.length > HOST_SENT_KEPT) ch.hostSent.shift();
          next.done();
          continue;
        }
        if (!this.pastGrace(ch)) {
          if (ch.outbox.length > 0 || ch.replayPending) this.scheduleWake(id, ch);
          return;
        }
        if (!ch.replayPending && ch.outbox.length === 0) return;
        if (!ch.onXmtp) {
          ch.onXmtp = true;
          this.log(`relay: channel ${id}: host relay down for over ${this.graceMs} ms, sending via XMTP`);
        }
        if (ch.replayPending) {
          ch.replayPending = false;
          for (const m of ch.hostSent.splice(0)) await this.viaXmtp(id, m);
          continue;
        }
        const next = ch.outbox.shift();
        if (!next) return;
        next.done(); // handed over: the daemon never waits on the XMTP network
        await this.viaXmtp(id, next.msg);
      }
    } finally {
      ch.pumping = false;
    }
  }

  private async viaXmtp(id: Hex, msg: RelayMessage): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const sending = this.xmtp.send(msg).catch((err: unknown) => this.log(`xmtp: channel ${id}: send failed: ${errorText(err)}`));
    const waited = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        this.log(`xmtp: channel ${id}: send still pending after ${XMTP_SEND_WAIT_MS} ms; moving on`);
        resolve();
      }, XMTP_SEND_WAIT_MS);
    });
    await Promise.race([sending, waited]);
    clearTimeout(timer);
  }
}
