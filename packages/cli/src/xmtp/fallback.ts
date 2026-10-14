import type { Hex } from "viem";
import type { Params, RelayClient, RelayMessage, RelaySigner } from "@arena/sdk";
import type { HostRelay } from "../host.js";
import { XmtpRelay } from "./relay.js";
import type { XmtpTransport } from "./transport.js";

/** Spec §2: a channel whose host relay has not been up for this long is *down*, and its sends go via XMTP. */
export const HOST_DOWN_GRACE_MS = 3000;
/** Spec §3: the largest XMTP text accepted or sent, in UTF-8 bytes. */
export const XMTP_MAX_PAYLOAD_BYTES = 16 * 1024;
/** Spec §3 (I-1): the most XMTP clients one daemon holds at once. A channel armed past it runs without the fallback
 *  (logged once): its sends go via the host relay alone, and its `transport` is `"relay"` or `"none"`, as without
 *  XMTP. A client counts from `arm` until its close has finished. */
export const XMTP_MAX_CLIENTS = 64;

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
  /** What `arm` opens the channel's XMTP client with. */
  params: Params;
  signer: RelaySigner;
  /** Set by `arm` (the channel is Open on chain) when a client slot was free: only then is there an XMTP side. Until
   *  then -- and for good once `noFallback` -- the channel behaves exactly as on the host relay alone. */
  armed: boolean;
  /** Armed past `maxClients`: this channel runs without the fallback (logged once). */
  noFallback: boolean;
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
  /** When a host `send` last threw although `isJoined` said yes; the channel counts as down from then until the
   *  host's next `onLinkChange` (with the real host this cannot happen: `isJoined` is the negation of the throw). */
  hostFailedSince: number | null;
  /** Resolved (and emptied) when the host has the channel again: ends an in-flight XMTP wait at once. */
  upWaiters: Set<() => void>;
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
 * The XMTP side of a channel exists only once the daemon arms it (`arm`), when the channel is Open on chain -- both
 * deposits in -- not when it is joined at match time: a match costs its acceptor nothing, so a client per match would
 * let anyone grow this process by accepting offers (I-1). Until then the channel is the host relay's alone: `send`
 * goes straight to it and `transportOf` is `"relay"` or `"none"`. At most `maxClients` (`XMTP_MAX_CLIENTS`) channels
 * are armed at once; one past that stays as it was, for good, with one log line.
 *
 * Receive: messages from both transports go to the same handlers. A message that arrives by both is harmless: the
 * session treats an exact repeat as a no-op, and the close path is idempotent. `onJoined` is the host's alone. An
 * XMTP message whose sender could not be determined reaches the handlers too (spec §3); the daemon hands a session
 * rejection of it back to `countRejected`.
 *
 * When a channel goes down, the last few messages it sent via the host (`HOST_SENT_KEPT`) are replayed once over
 * XMTP at the end of the window: a frame the host accepted just before it died is otherwise never re-sent, since
 * the daemon re-sends only on the host's `onJoined`. The receiver treats any it already has as repeats.
 *
 * Switching back is immediate: once the host has the channel again, the replay stops (the daemon's `onJoined`
 * re-send covers it), and an XMTP send still in flight is no longer waited for, so the next message goes via the
 * host at once. The window runs on a monotonic clock by default (`performance.now`).
 */
export class FallbackRelay implements RelayClient {
  private readonly host: HostRelay;
  private readonly xmtp: XmtpRelay;
  private readonly graceMs: number;
  private readonly now: () => number;
  private readonly log: (l: string) => void;
  private readonly maxClients: number;
  private readonly channels = new Map<Hex, Channel>();
  private readonly handlers = new Set<(msg: RelayMessage) => void>();
  private readonly unsubscribers: Array<() => void> = [];
  /** XMTP clients held now: channels armed and not yet left, plus those left whose close has not finished. */
  private clients = 0;
  private stopped = false;

  constructor(opts: {
    host: HostRelay;
    xmtp: XmtpTransport;
    graceMs?: number;
    now?: () => number;
    log?(l: string): void;
    maxClients?: number;
  }) {
    this.host = opts.host;
    this.graceMs = opts.graceMs ?? HOST_DOWN_GRACE_MS;
    this.maxClients = opts.maxClients ?? XMTP_MAX_CLIENTS;
    // Monotonic by default: a wall-clock step (NTP) must never stretch or skip the grace window.
    this.now = opts.now ?? (() => performance.now());
    this.log = opts.log ? (l) => opts.log?.(l) : () => undefined;
    this.xmtp = new XmtpRelay({ xmtp: opts.xmtp, maxPayloadBytes: XMTP_MAX_PAYLOAD_BYTES, now: this.now, log: this.log });
    this.unsubscribers.push(
      this.host.onMessage((m) => this.emit(m)),
      this.xmtp.onMessage((m) => this.emit(m)),
      this.host.onLinkChange(() => this.onLinkChange()),
    );
  }

  /** Joins the host relay exactly as before (its promise is the host's), and registers the channel. Its XMTP client
   *  is started later, by `arm`, once the channel is Open on chain. */
  join(channelId: Hex, params: Params, signer: RelaySigner): Promise<void> {
    const id = key(channelId);
    if (!this.channels.has(id)) {
      this.channels.set(id, {
        hostId: channelId,
        params,
        signer,
        armed: false,
        noFallback: false,
        downSince: this.host.isJoined(channelId) ? null : this.now(),
        outbox: [],
        hostSent: [],
        replayPending: false,
        onXmtp: false,
        hostFailedSince: null,
        upWaiters: new Set(),
        pumping: false,
        timer: undefined,
      });
    }
    return this.host.join(channelId, params, signer);
  }

  /** Spec §3 (I-1): the channel is Open on chain (both deposits in): start its XMTP client, in the background, if a
   *  client slot is free. Idempotent and cheap (the daemon calls it on every chain refresh); a channel not joined
   *  here, already armed, refused once, or left is ignored. */
  arm(channelId: Hex): void {
    const id = key(channelId);
    const ch = this.channels.get(id);
    if (!ch || ch.armed || ch.noFallback || this.stopped) return;
    if (this.clients >= this.maxClients) {
      ch.noFallback = true;
      this.log(`xmtp: channel ${id}: ${this.maxClients} XMTP clients already open (the cap); this channel runs without the XMTP fallback`);
      return;
    }
    ch.armed = true;
    this.clients += 1;
    this.xmtp.open(ch.hostId, ch.params, ch.signer).catch((err: unknown) => this.log(`xmtp: channel ${id}: ${errorText(err)}`));
    // Armed while the host is already down: what it last sent via the host is replayed over XMTP once past the window.
    this.observe(ch);
    if (ch.outbox.length > 0 || ch.replayPending) void this.pump(id, ch);
  }

  /** Whether the channel has an XMTP side now (armed): a channel that does not is the host relay's alone. */
  armed(channelId: Hex): boolean {
    return this.channels.get(key(channelId))?.armed === true;
  }

  send(msg: RelayMessage): Promise<void> {
    const id = key(msg.channelId);
    const ch = this.channels.get(id);
    if (!ch) return this.host.send(msg); // never joined through here: the host's behaviour, unchanged
    if (!ch.armed) {
      // No XMTP side (not Open yet, or over the cap): the host's behaviour, unchanged -- what it took is remembered,
      // for the replay should the channel be armed and the host go down.
      return this.host.send(msg).then(() => this.sentViaHost(ch, msg));
    }
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

  /** Leaves the channel for good (the daemon calls it once the channel is finalized): the host relay's leave, then
   *  the XMTP client is closed and the channel's XMTP DB deleted (I-1, m-1). */
  leave(channelId: Hex): void {
    const id = key(channelId);
    const ch = this.channels.get(id);
    if (ch) {
      this.channels.delete(id);
      clearTimeout(ch.timer);
      for (const p of ch.outbox.splice(0)) p.done(); // left for good: nothing more is sent on it
      this.releaseUpWaiters(ch);
    }
    this.host.leave(channelId);
    const closing = this.xmtp
      .close(channelId, { purge: true })
      .catch((err: unknown) => this.log(`xmtp: channel ${id}: close failed: ${errorText(err)}`));
    // The client's slot is free once its close has finished (bounded by the transport).
    if (ch?.armed) void closing.finally(() => (this.clients = Math.max(0, this.clients - 1)));
  }

  /** The side this channel's sends go to now: `"relay"` while the host has it joined, `"xmtp"` once it has been down
   *  for the grace window, `"none"` within the window (sends are held) or for a channel not joined here. A channel
   *  with no XMTP side (`arm` not called yet, or over the cap) is `"relay"` or `"none"`, as on the host relay alone. */
  transportOf(channelId: Hex): ChannelTransport {
    const id = key(channelId);
    const ch = this.channels.get(id);
    if (!ch) return "none";
    if (!ch.armed) return this.host.isJoined(ch.hostId) ? "relay" : "none";
    if (this.observe(ch)) return "relay";
    return this.pastGrace(ch) ? "xmtp" : "none";
  }

  /** Messages dropped by the XMTP acceptance checks, per channel (spec §3), including those the session rejected
   *  after XMTP could not determine their sender (`countRejected`). */
  dropped(channelId: Hex): number {
    return this.xmtp.dropped(channelId);
  }

  /** Spec §3: the daemon's session rejected `msg`. True when it came over XMTP with its sender undetermined: it is
   *  counted in `dropped`, and the daemon sets no `lastError` and logs nothing for it. False for every other message
   *  (the host relay's included), which the daemon reports exactly as before. */
  countRejected(msg: RelayMessage): boolean {
    return this.xmtp.countRejected(msg);
  }

  /** Spec §3: whether `msg` came over XMTP with its sender undetermined (it counts nothing). The daemon leaves
   *  `lastError` as it was on a repeat of such a message, a stranger's replay as likely as not; a host relay message
   *  is never one. */
  isUndetermined(msg: RelayMessage): boolean {
    return this.xmtp.isUndetermined(msg);
  }

  /** Stops every channel's XMTP client (their DBs are kept). The host connection is the caller's to close. */
  async stop(): Promise<void> {
    this.stopped = true;
    for (const u of this.unsubscribers.splice(0)) u();
    for (const ch of this.channels.values()) {
      clearTimeout(ch.timer);
      for (const p of ch.outbox.splice(0)) p.done();
      this.releaseUpWaiters(ch);
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

  /** Brings `downSince` up to date with the host's link and returns whether the host is up for this channel: joined,
   *  and no host send has thrown since the last link change. */
  private observe(ch: Channel): boolean {
    const up = this.host.isJoined(ch.hostId) && ch.hostFailedSince === null;
    if (up) {
      ch.downSince = null;
      ch.replayPending = false; // back up first: the daemon's onJoined re-send covers it
      if (ch.onXmtp) {
        ch.onXmtp = false;
        this.log(`relay: channel ${key(ch.hostId)}: back on the host relay`);
      }
      return true;
    }
    if (ch.downSince === null) {
      ch.downSince = ch.hostFailedSince ?? this.now();
      if (ch.hostSent.length > 0) ch.replayPending = true;
    }
    return false;
  }

  private sentViaHost(ch: Channel, msg: RelayMessage): void {
    ch.hostSent.push(msg);
    if (ch.hostSent.length > HOST_SENT_KEPT) ch.hostSent.shift();
  }

  private releaseUpWaiters(ch: Channel): void {
    for (const w of [...ch.upWaiters]) w();
    ch.upWaiters.clear();
  }

  private onLinkChange(): void {
    for (const [id, ch] of this.channels) {
      ch.hostFailedSince = null; // the link changed: give the host another try
      if (this.observe(ch)) this.releaseUpWaiters(ch);
      if (ch.armed && (ch.outbox.length > 0 || ch.replayPending)) void this.pump(id, ch);
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
    if (ch.pumping || !ch.armed) return;
    ch.pumping = true;
    try {
      while (this.channels.get(id) === ch) {
        if (this.observe(ch)) {
          const next = ch.outbox.shift();
          if (!next) return;
          try {
            await this.host.send(next.msg);
          } catch {
            // The socket went between the check and the send: the same message takes the not-joined path, and the
            // channel counts as down from now until the host's next link change.
            ch.outbox.unshift(next);
            ch.hostFailedSince = this.now();
            continue;
          }
          this.sentViaHost(ch, next.msg);
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
          const replay = ch.hostSent.splice(0);
          for (const m of replay) {
            // The host is back: stop here, its onJoined re-send covers the rest.
            if (this.channels.get(id) !== ch || this.observe(ch)) break;
            await this.viaXmtp(id, ch, m);
          }
          continue;
        }
        const next = ch.outbox.shift();
        if (!next) return;
        next.done(); // handed over: the daemon never waits on the XMTP network
        await this.viaXmtp(id, ch, next.msg);
      }
    } finally {
      ch.pumping = false;
    }
  }

  /** Sends one message over XMTP, waiting for it at most `XMTP_SEND_WAIT_MS`, or until the host has the channel
   *  again, whichever comes first (the send itself carries on). Never throws. */
  private async viaXmtp(id: Hex, ch: Channel, msg: RelayMessage): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let upWaiter: (() => void) | undefined;
    const sending = this.xmtp.send(msg).catch((err: unknown) => this.log(`xmtp: channel ${id}: send failed: ${errorText(err)}`));
    const waited = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        if (this.channels.get(id) === ch) this.log(`xmtp: channel ${id}: send still pending after ${XMTP_SEND_WAIT_MS} ms; moving on`);
        resolve();
      }, XMTP_SEND_WAIT_MS);
      timer.unref?.(); // never keeps a stopped daemon's process alive
    });
    const upAgain = new Promise<void>((resolve) => {
      upWaiter = resolve;
      ch.upWaiters.add(resolve);
    });
    await Promise.race([sending, waited, upAgain]);
    clearTimeout(timer);
    if (upWaiter) ch.upWaiters.delete(upWaiter);
  }
}
