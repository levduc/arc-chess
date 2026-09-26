import type { Hex } from "viem";
import {
  buildParams,
  channelId as computeChannelId,
  offerId as computeOfferId,
  parseSignedAcceptance,
  parseSignedOffer,
  verifyAcceptance,
  verifyOffer,
  WireFormatError,
  type MatchEvent,
  type SignedAcceptance,
  type SignedOffer,
} from "@arena/sdk";
import type { ChainReader } from "./chain.js";
import type { ServerConfig } from "./config.js";
import type { Repo } from "./repo.js";

/** Thrown by `Lobby` methods; `status` is the HTTP status the route handler should send. */
export class LobbyError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const OFFER_ID_RE = /^0x[0-9a-f]{64}$/;

const same = (x: string, y: string) => x.toLowerCase() === y.toLowerCase();

/** True when `stored` and `sa` are the very same acceptance (idempotent retry), not a competing one. */
function sameAcceptance(stored: SignedAcceptance, sa: SignedAcceptance): boolean {
  return (
    same(stored.acceptance.signer, sa.acceptance.signer) &&
    same(stored.acceptance.nonce, sa.acceptance.nonce) &&
    same(stored.sig, sa.sig)
  );
}

/** Signed offers, atomic accept-to-match, and the in-process match fan-out that `ws.ts` subscribes to. */
export class Lobby {
  private readonly handlers = new Set<(m: MatchEvent) => void>();

  constructor(
    private readonly repo: Repo,
    private readonly chain: ChainReader,
    private readonly cfg: ServerConfig,
  ) {}

  async post(body: unknown, ip: string): Promise<{ offerId: Hex }> {
    let so: SignedOffer;
    try {
      so = parseSignedOffer(body);
    } catch (err) {
      throw new LobbyError(400, err instanceof WireFormatError ? err.message : "malformed offer");
    }
    if (!(await verifyOffer(so))) throw new LobbyError(400, "bad offer signature");

    const { offer } = so;
    if (offer.stakePerGame <= 0n) throw new LobbyError(400, "stakePerGame must be greater than 0");
    if (offer.deposit < offer.stakePerGame) throw new LobbyError(400, "deposit must be at least stakePerGame");
    const bounds = await this.chain.timeoutBounds();
    if (offer.challengeTimeout < bounds.min || offer.challengeTimeout > bounds.max) {
      throw new LobbyError(400, `challengeTimeout must be between ${bounds.min} and ${bounds.max} seconds`);
    }

    const now = await this.chain.now();
    if (offer.expiresAt <= now) throw new LobbyError(400, "expiresAt must be in the future");
    if (offer.expiresAt > now + this.cfg.offerMaxLifetime) {
      throw new LobbyError(400, `expiresAt must be at most ${this.cfg.offerMaxLifetime} seconds from now`);
    }

    if (this.repo.openOfferCount(ip, now) >= this.cfg.limits.maxOpenOffersPerIp) {
      throw new LobbyError(429, "too many open offers from this IP");
    }

    const id = computeOfferId(offer);
    if (!this.repo.insertOffer(id, so, ip)) throw new LobbyError(409, "duplicate offer id");
    return { offerId: id };
  }

  async list(): Promise<SignedOffer[]> {
    return this.repo.openOffers(await this.chain.now());
  }

  async accept(offerIdFromPath: string, body: unknown): Promise<MatchEvent> {
    if (!OFFER_ID_RE.test(offerIdFromPath)) throw new LobbyError(400, "invalid offer id");
    const id = offerIdFromPath as Hex;

    let sa: SignedAcceptance;
    try {
      sa = parseSignedAcceptance(body);
    } catch (err) {
      throw new LobbyError(400, err instanceof WireFormatError ? err.message : "malformed acceptance");
    }
    if (sa.acceptance.offerId !== id) throw new LobbyError(400, "acceptance offerId must match the path");

    const entry = this.repo.offer(id);
    if (!entry) throw new LobbyError(404, "offer not found");

    if (entry.match) return this.resolveAlreadyMatched(entry, sa);

    const { offer } = entry.signed;
    const now = await this.chain.now();
    if (offer.expiresAt <= now) throw new LobbyError(410, "offer expired");

    if (!(await verifyAcceptance(sa))) throw new LobbyError(400, "bad acceptance signature");
    if (same(sa.acceptance.player, offer.player) || same(sa.acceptance.signer, offer.signer)) {
      throw new LobbyError(400, "cannot accept your own offer");
    }

    const feeConfig = await this.chain.feeConfig();
    const terms = {
      rules: this.cfg.rules,
      feeRecipient: feeConfig.feeRecipient,
      feePerPlayer: feeConfig.feePerPlayer,
      fundingWindow: this.cfg.fundingWindow,
    };
    const params = buildParams(offer, sa.acceptance, terms, now);
    const event: MatchEvent = { offerId: id, params };

    const channel = computeChannelId(this.cfg.chainId, this.cfg.hub, params);
    if (!this.repo.recordMatch(id, sa, event, channel)) {
      // lost the race to another acceptance: re-read and apply the idempotency/conflict rule
      const fresh = this.repo.offer(id);
      if (fresh?.match) return this.resolveAlreadyMatched(fresh, sa);
      throw new LobbyError(409, "offer already matched");
    }
    for (const h of this.handlers) {
      try {
        h(event);
      } catch {
        // a throwing subscriber must not turn a successfully recorded match into a 500 for the accepting player
      }
    }
    return event;
  }

  private resolveAlreadyMatched(
    entry: { acceptance: SignedAcceptance | null; match: MatchEvent | null },
    sa: SignedAcceptance,
  ): MatchEvent {
    if (entry.acceptance && entry.match && sameAcceptance(entry.acceptance, sa)) return entry.match;
    throw new LobbyError(409, "offer already matched");
  }

  onMatch(handler: (m: MatchEvent) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  matchFor(offerId: Hex): MatchEvent | null {
    return this.repo.offer(offerId)?.match ?? null;
  }
}
