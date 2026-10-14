import type { Address, Hex } from "viem";
import { decodeWire, parseRelayMessage, toWire, type Params, type RelayMessage, type RelaySigner } from "@arena/sdk";
import { UNDETERMINED, XMTP_CATCH_UP_MESSAGES, type XmtpTransport } from "./transport.js";

/**
 * Plan 5.7 (spec §3): the per-channel inbound budget. These are the host relay's own numbers
 * (`apps/server/src/config.ts` DEFAULT_LIMITS `wsFrameBurst` / `wsFramePerSec`, enforced by `limits.ts`'s token
 * bucket), re-declared because the CLI must not depend on the server. The server applies them per connection; here
 * they apply per channel, to messages that have already passed the sender checks, so a stranger can never spend
 * the opponent's budget.
 */
export const XMTP_INBOUND_BURST = 4000;
export const XMTP_INBOUND_PER_SEC = 400;

/** The drop summary is logged at most this often per channel (the first drop at once), with the running count. */
export const XMTP_DROP_LOG_INTERVAL_MS = 10_000;

/** A failed `open` (the XMTP network unreachable, say) is retried after this long, doubling up to the cap. */
const OPEN_RETRY_MIN_MS = 1_000;
const OPEN_RETRY_MAX_MS = 60_000;

type Channel = {
  channelId: Hex;
  signer: RelaySigner;
  opponent: Address;
  opened: boolean;
  opening: Promise<void> | null;
  openRetryMs: number;
  retryTimer: ReturnType<typeof setTimeout> | undefined;
  bucket: { tokens: number; last: number };
};

/** A channel's drop count, and when (this relay's clock) and at what count the summary was last logged. */
type Drops = { n: number; loggedAt: number; loggedN: number };

const errorText = (err: unknown) => (err instanceof Error ? err.message.split("\n")[0] : String(err));
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const key = (id: Hex) => id.toLowerCase() as Hex;

/**
 * Plan 5.7: the XMTP side of `FallbackRelay`. Frames each `RelayMessage` as one XMTP text,
 * `{"arena":1,"msg":<RelayMessage wire JSON>}` (the host relay's own `toWire` encoding), and accepts an inbound text
 * only when, in this order:
 * 1. it is at most `maxPayloadBytes` (UTF-8);
 * 2. its XMTP sender is the channel's opponent signer, or `UNDETERMINED`;
 * 3. it arrived in the DM with that same address, or one `UNDETERMINED`;
 * 4. the channel's inbound token bucket has a token (`XMTP_INBOUND_BURST` / `XMTP_INBOUND_PER_SEC`);
 * 5. it decodes as wire JSON with `arena === 1`, its `msg` passes `parseRelayMessage`, and `msg.channelId` is the
 *    channel whose client received it.
 * Anything else is dropped and counted (`dropped`): a known stranger at 2 or 3, before it can spend the channel's
 * budget. The session still verifies every state and close signature. A text turned away at 4 is reported back to
 * the transport as not taken, so it is not marked delivered, and the transport is asked for a catch-up once the
 * bucket has refilled (K1: `XmtpTransport.catchUp`), which delivers it again without a stream restart.
 *
 * Spec §3: a message whose sender or conversation the transport could not determine passes on to the session like
 * any other; it is tagged, and when the session rejects it, `countRejected` counts it as dropped instead of the daemon
 * reporting an error -- during a lookup outage it may well be a stranger's.
 */
export class XmtpRelay {
  private readonly xmtp: XmtpTransport;
  private readonly maxPayloadBytes: number;
  private readonly now: () => number;
  private readonly log: (l: string) => void;
  private readonly burst: number;
  private readonly perSec: number;
  private readonly channels = new Map<Hex, Channel>();
  private readonly drops = new Map<Hex, Drops>();
  private readonly handlers = new Set<(msg: RelayMessage) => void>();
  /** Accepted messages whose sender or conversation was `UNDETERMINED` (held weakly: gone with the message). */
  private readonly undetermined = new WeakSet<RelayMessage>();
  private readonly unsubscribe: () => void;
  private stopped = false;

  constructor(opts: {
    xmtp: XmtpTransport;
    maxPayloadBytes: number;
    now?: () => number;
    log?: (l: string) => void;
    rate?: { burst: number; perSec: number };
  }) {
    this.xmtp = opts.xmtp;
    this.maxPayloadBytes = opts.maxPayloadBytes;
    this.now = opts.now ?? (() => performance.now()); // monotonic: the token bucket never sees a clock step
    this.log = opts.log ?? (() => undefined);
    this.burst = opts.rate?.burst ?? XMTP_INBOUND_BURST;
    this.perSec = opts.rate?.perSec ?? XMTP_INBOUND_PER_SEC;
    // The transport marks a message delivered only when it is taken: one turned away by the rate limit is not, so
    // a later catch-up can deliver it again.
    this.unsubscribe = this.xmtp.onText((channelId, from, dm, text) => this.receive(channelId, from, dm, text));
  }

  /** Registers the channel and starts its XMTP client. A failure is retried in the background (with back-off)
   *  until it succeeds or the channel is closed; the returned promise reports only this first attempt. */
  open(channelId: Hex, params: Params, signer: RelaySigner): Promise<void> {
    const id = key(channelId);
    const me = params.signers.findIndex((s) => same(s, signer.address));
    if (me < 0) return Promise.reject(new Error(`xmtp: ${signer.address} is not a signer of channel ${channelId}`));
    if (this.stopped) return Promise.reject(new Error("xmtp: stopped"));
    let ch = this.channels.get(id);
    if (!ch) {
      ch = {
        channelId: id,
        signer,
        opponent: params.signers[me === 0 ? 1 : 0],
        opened: false,
        opening: null,
        openRetryMs: OPEN_RETRY_MIN_MS,
        retryTimer: undefined,
        bucket: { tokens: this.burst, last: this.now() },
      };
      this.channels.set(id, ch);
    }
    return this.ensureOpen(ch);
  }

  private ensureOpen(ch: Channel): Promise<void> {
    if (ch.opened) return Promise.resolve();
    if (ch.opening) return ch.opening;
    clearTimeout(ch.retryTimer);
    ch.retryTimer = undefined;
    const attempt = this.xmtp.open(ch.channelId, ch.signer, ch.opponent).then(
      () => {
        ch.opened = true;
        ch.opening = null;
        ch.openRetryMs = OPEN_RETRY_MIN_MS;
      },
      (err: unknown) => {
        ch.opening = null;
        if (this.channels.get(ch.channelId) === ch && !this.stopped) {
          const delay = ch.openRetryMs;
          ch.openRetryMs = Math.min(OPEN_RETRY_MAX_MS, ch.openRetryMs * 2);
          this.log(`xmtp: channel ${ch.channelId}: client failed to start (${errorText(err)}); retrying in ${delay / 1000}s`);
          ch.retryTimer = setTimeout(() => {
            ch.retryTimer = undefined;
            if (this.channels.get(ch.channelId) === ch) this.ensureOpen(ch).catch(() => undefined);
          }, delay);
        }
        throw err;
      },
    );
    ch.opening = attempt;
    return attempt;
  }

  /** Sends one message over XMTP. Throws when the channel is not registered, the payload is too large, or the
   *  transport fails; the caller (`FallbackRelay`) logs it and never passes it on to the daemon. */
  async send(msg: RelayMessage): Promise<void> {
    const ch = this.channels.get(key(msg.channelId));
    if (!ch) throw new Error(`xmtp: channel ${msg.channelId} is not open`);
    const text = toWire({ arena: 1, msg });
    if (Buffer.byteLength(text, "utf8") > this.maxPayloadBytes) {
      throw new Error(`xmtp: message for ${msg.channelId} is over ${this.maxPayloadBytes} bytes`);
    }
    await this.ensureOpen(ch);
    await this.xmtp.send(ch.channelId, text);
  }

  onMessage(handler: (msg: RelayMessage) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  /** Messages dropped by the acceptance checks for this channel since it was opened. */
  dropped(channelId: Hex): number {
    return this.drops.get(key(channelId))?.n ?? 0;
  }

  /** Whether `msg` came from XMTP with its sender or conversation undetermined. Unlike `countRejected`, it counts
   *  nothing and can be asked again. */
  isUndetermined(msg: RelayMessage): boolean {
    return this.undetermined.has(msg);
  }

  /** Spec §3: the session rejected `msg`. True when it came from XMTP with its sender undetermined: it is then counted
   *  in `dropped` (logged only by the throttled drop summary), and the caller reports nothing. False for anything
   *  else -- the host relay's messages and the opponent's own -- which the caller handles as before. */
  countRejected(msg: RelayMessage): boolean {
    if (!this.undetermined.delete(msg)) return false;
    const id = key(msg.channelId);
    if (this.channels.has(id)) this.drop(id, "rejected by the session; its sender could not be determined");
    return true;
  }

  /** Forgets the channel (its counters too) and stops its XMTP client. With `purge` (the channel is finalized), its
   *  XMTP DB is deleted too -- even when this process never opened it (a DB from an earlier run). */
  async close(channelId: Hex, opts: { purge?: boolean } = {}): Promise<void> {
    const id = key(channelId);
    const ch = this.channels.get(id);
    this.drops.delete(id);
    if (ch) {
      this.channels.delete(id);
      clearTimeout(ch.retryTimer);
    } else if (opts.purge !== true) return;
    await this.xmtp.close(id, opts.purge === true ? { purge: true } : undefined);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.unsubscribe();
    for (const ch of this.channels.values()) clearTimeout(ch.retryTimer);
    this.channels.clear();
    this.drops.clear();
    this.handlers.clear();
    await this.xmtp.stop();
  }

  /** Counts a drop. The summary line is throttled by time, at most one per channel per `XMTP_DROP_LOG_INTERVAL_MS`
   *  (the first at once), so a flood never becomes a log flood. */
  private drop(id: Hex, reason: string): void {
    const d = this.drops.get(id) ?? { n: 0, loggedAt: Number.NEGATIVE_INFINITY, loggedN: 0 };
    this.drops.set(id, d);
    d.n += 1;
    const t = this.now();
    if (t - d.loggedAt < XMTP_DROP_LOG_INTERVAL_MS) return;
    const since = d.n - d.loggedN;
    const tail = since > 1 ? ` (${since} since the last line)` : "";
    this.log(`xmtp: channel ${id}: dropped an inbound message (${reason}); ${d.n} dropped so far${tail}`);
    d.loggedAt = t;
    d.loggedN = d.n;
  }

  private takeToken(ch: Channel): boolean {
    const t = this.now();
    const b = ch.bucket;
    b.tokens = Math.min(this.burst, b.tokens + (Math.max(0, t - b.last) / 1000) * this.perSec);
    b.last = t;
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  /** One inbound text. False only when the rate limit turned it away (it may be delivered again later); true when it
   *  was handed on or dropped for good. */
  private receive(channelId: Hex, from: Address, dm: Address, text: string): boolean {
    const id = key(channelId);
    const ch = this.channels.get(id);
    if (!ch) return true; // not (or no longer) one of ours: nothing to count it against
    const dropped = (reason: string) => {
      this.drop(id, reason);
      return true;
    };
    if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > this.maxPayloadBytes) return dropped("oversized");
    // A known stranger is dropped here, before the bucket; an undetermined sender or conversation goes on.
    const fromUndetermined = typeof from === "string" && same(from, UNDETERMINED);
    const dmUndetermined = typeof dm === "string" && same(dm, UNDETERMINED);
    if (!fromUndetermined && (typeof from !== "string" || !same(from, ch.opponent))) return dropped("not from the opponent");
    if (!dmUndetermined && (typeof dm !== "string" || !same(dm, ch.opponent))) return dropped("not in the DM with the opponent");
    if (!this.takeToken(ch)) {
      this.drop(id, "rate limited");
      // K1: delivered again by a catch-up once the bucket holds a catch-up's worth of tokens (the transport keeps
      // at most one pending per channel, at least a second apart), never by a stream restart.
      const refillMs = (Math.max(0, XMTP_CATCH_UP_MESSAGES - ch.bucket.tokens) / this.perSec) * 1000;
      this.xmtp.catchUp?.(id, Math.ceil(refillMs));
      return false;
    }
    let msg: RelayMessage;
    try {
      const outer = decodeWire(text) as { arena?: unknown; msg?: unknown } | null;
      if (typeof outer !== "object" || outer === null || Array.isArray(outer) || outer.arena !== 1) {
        return dropped("not an arena v1 message");
      }
      msg = parseRelayMessage(outer.msg);
    } catch (err) {
      return dropped(`malformed: ${errorText(err)}`);
    }
    if (!same(msg.channelId, id)) return dropped("for another channel");
    if (fromUndetermined || dmUndetermined) this.undetermined.add(msg);
    for (const h of this.handlers) {
      try {
        h(msg);
      } catch (err) {
        this.log(`xmtp: onMessage handler threw: ${errorText(err)}`);
      }
    }
    return true;
  }
}
