import type { Address, Hex } from "viem";
import { decodeWire, parseRelayMessage, toWire, type Params, type RelayMessage, type RelaySigner } from "@arena/sdk";
import type { XmtpTransport } from "./transport.js";

/**
 * Plan 5.7 (spec §3): the per-channel inbound budget. These are the host relay's own numbers
 * (`apps/server/src/config.ts` DEFAULT_LIMITS `wsFrameBurst` / `wsFramePerSec`, enforced by `limits.ts`'s token
 * bucket), re-declared because the CLI must not depend on the server. The server applies them per connection; here
 * they apply per channel, to messages that have already passed the sender checks, so a stranger can never spend
 * the opponent's budget.
 */
export const XMTP_INBOUND_BURST = 4000;
export const XMTP_INBOUND_PER_SEC = 400;

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

const errorText = (err: unknown) => (err instanceof Error ? err.message.split("\n")[0] : String(err));
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const key = (id: Hex) => id.toLowerCase() as Hex;

/**
 * Plan 5.7: the XMTP side of `FallbackRelay`. Frames each `RelayMessage` as one XMTP text,
 * `{"arena":1,"msg":<RelayMessage wire JSON>}` (the host relay's own `toWire` encoding), and accepts an inbound text
 * only when, in this order:
 * 1. it is at most `maxPayloadBytes` (UTF-8);
 * 2. its XMTP sender is the channel's opponent signer;
 * 3. it arrived in the DM with that same address;
 * 4. the channel's inbound token bucket has a token (`XMTP_INBOUND_BURST` / `XMTP_INBOUND_PER_SEC`);
 * 5. it decodes as wire JSON with `arena === 1`, its `msg` passes `parseRelayMessage`, and `msg.channelId` is the
 *    channel whose client received it.
 * Anything else is dropped and counted (`dropped`). The session still verifies every state and close signature.
 */
export class XmtpRelay {
  private readonly xmtp: XmtpTransport;
  private readonly maxPayloadBytes: number;
  private readonly now: () => number;
  private readonly log: (l: string) => void;
  private readonly burst: number;
  private readonly perSec: number;
  private readonly channels = new Map<Hex, Channel>();
  private readonly drops = new Map<Hex, number>();
  private readonly handlers = new Set<(msg: RelayMessage) => void>();
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
    return this.drops.get(key(channelId)) ?? 0;
  }

  /** Forgets the channel (its counters too) and stops its XMTP client. */
  async close(channelId: Hex): Promise<void> {
    const id = key(channelId);
    const ch = this.channels.get(id);
    this.drops.delete(id);
    if (!ch) return;
    this.channels.delete(id);
    clearTimeout(ch.retryTimer);
    await this.xmtp.close(id);
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

  private drop(id: Hex, reason: string): void {
    const n = (this.drops.get(id) ?? 0) + 1;
    this.drops.set(id, n);
    // The first drop and every 100th after it: a flood must not become a log flood.
    if (n === 1 || n % 100 === 0) this.log(`xmtp: channel ${id}: dropped an inbound message (${reason}); ${n} dropped so far`);
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

  private receive(channelId: Hex, from: Address, dm: Address, text: string): void {
    const id = key(channelId);
    const ch = this.channels.get(id);
    if (!ch) return; // not (or no longer) one of ours: nothing to count it against
    if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > this.maxPayloadBytes) return this.drop(id, "oversized");
    if (typeof from !== "string" || !same(from, ch.opponent)) return this.drop(id, "not from the opponent");
    if (typeof dm !== "string" || !same(dm, ch.opponent)) return this.drop(id, "not in the DM with the opponent");
    if (!this.takeToken(ch)) return this.drop(id, "rate limited");
    let msg: RelayMessage;
    try {
      const outer = decodeWire(text) as { arena?: unknown; msg?: unknown } | null;
      if (typeof outer !== "object" || outer === null || Array.isArray(outer) || outer.arena !== 1) {
        return this.drop(id, "not an arena v1 message");
      }
      msg = parseRelayMessage(outer.msg);
    } catch (err) {
      return this.drop(id, `malformed: ${errorText(err)}`);
    }
    if (!same(msg.channelId, id)) return this.drop(id, "for another channel");
    for (const h of this.handlers) {
      try {
        h(msg);
      } catch (err) {
        this.log(`xmtp: onMessage handler threw: ${errorText(err)}`);
      }
    }
  }
}
