import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import { createPublicClient, defineChain, http, maxUint256, type Chain, type Hex, type PublicClient } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  ArenaProtocolError,
  ChannelSession,
  HubClient,
  HubRevertError,
  LocalKeyTxSender,
  channelId as computeChannelId,
  checkMatchParams,
  isGameOver,
  mover,
  offerId as computeOfferId,
  outcome,
  signAcceptance,
  signOffer,
  type ArenaDomain,
  type LobbyClient,
  type MatchEvent,
  type Offer,
  type RelayClient,
  type RelayMessage,
  type SignedState,
} from "@arena/sdk";
import { arenaPaths, isCanonicalId, type ArenaConfig } from "./config.js";
import { FileSessionStore } from "./fileStore.js";
import { RecordStore, type ChannelRecord, type Controller } from "./records.js";
import { buildStatus, type ChannelStatus } from "./status.js";

export type Actor = "agent" | "human";

export class DaemonError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = "DaemonError";
  }
}

export type ChainView = {
  phase: string;
  funded: readonly [boolean, boolean];
  deadline: bigint;
  challenger: number;
  registeredTurn: bigint | null;
  cooldownUntil: readonly [bigint, bigint];
  now: bigint;
};

export type ChannelHandle = {
  record: ChannelRecord;
  session: ChannelSession;
  sessionSender: LocalKeyTxSender;
  processedEvents: number;
  chain: ChainView | null;
  lastError: string | null;
  /** R9/3b: counts every `watch()` attempt for this channel — lets tests confirm an explicit `tick()` actually ran a pass (as opposed to being swallowed by the concurrent-tick guard) instead of just assuming it. */
  passes: number;
  /** I2: chain time of the last observed progress on this channel (in memory only; set on the first refresh after start). */
  lastProgressAt: bigint | null;
  /** I2: fingerprint of the session/phase at `lastProgressAt`; any change counts as progress. */
  progressKey: string | null;
  /** M-c: set while an autoPlay (relay- or tick-driven) runs, so the two never both try to resign the same mate. */
  autoPlaying: boolean;
};

/** I1: a channel whose files could not be loaded; reported by `channels()`, ignored by `pick()` and the watchtower. */
export type DegradedChannel = { channelId: string; degraded: true; error: string };

export type DaemonOptions = {
  home: string;
  config: ArenaConfig;
  walletKey: Hex;
  lobby: LobbyClient;
  relay: RelayClient;
  log?: (line: string) => void;
};

const errorText = (err: unknown) => (err instanceof Error ? err.message.split("\n")[0] : String(err));

export class ArenaDaemon {
  readonly client: PublicClient;
  readonly hub: HubClient;
  readonly wallet: LocalKeyTxSender;
  protected readonly chain: Chain;
  protected readonly domain: ArenaDomain;
  protected readonly records: RecordStore;
  protected readonly live = new Map<Hex, ChannelHandle>();
  /** I1: channel entries that could not be loaded at start(), by directory name, with the reason. Never watched or picked. */
  protected readonly degraded = new Map<string, string>();
  protected readonly changes = new EventEmitter();
  private timer: NodeJS.Timeout | undefined;
  private unsubscribers: Array<() => void> = [];
  private ticking = false;
  private approved = false;
  /** M1: set by stop(); every handler checks this before any side effect (open/join/fund) it hasn't started yet. */
  private stopped = false;
  /** I3: offerIds currently being turned into a channel — guards against two match events racing the same offer. */
  private readonly claiming = new Set<Hex>();

  constructor(protected readonly opts: DaemonOptions) {
    const c = opts.config;
    this.chain = defineChain({
      id: c.chainId,
      name: `arena-${c.chainId}`,
      nativeCurrency: { name: "Native", symbol: "NATIVE", decimals: 18 },
      rpcUrls: { default: { http: [c.rpcUrl] } },
    });
    this.client = createPublicClient({ chain: this.chain, transport: http(c.rpcUrl) });
    this.hub = new HubClient(c.hub, this.client);
    this.wallet = new LocalKeyTxSender(opts.walletKey, c.rpcUrl, this.chain);
    this.domain = { chainId: c.chainId, hub: c.hub };
    this.records = new RecordStore(opts.home);
    this.changes.setMaxListeners(0);
  }

  // ------------------------------------------------------------------ lifecycle

  async start(): Promise<void> {
    this.unsubscribers.push(this.opts.lobby.onMatch((m) => void this.onMatch(m)));
    this.unsubscribers.push(this.opts.relay.onMessage((m) => void this.onRelay(m)));
    // I1: every channel entry is loaded in isolation. A corrupt record or session file, or a record that does not
    // match this hub/chain, is logged and reported as degraded (see channels()) instead of aborting start() —
    // which would leave every other channel, including ones mid-dispute, unwatched.
    for (const entry of this.records.scanChannels()) {
      if (this.stopped) break;
      if (entry.record === null) {
        this.markDegraded(entry.channelId, entry.error);
        continue;
      }
      if (entry.record.finalized) continue;
      try {
        await this.openChannel(entry.record);
      } catch (err) {
        const opened = this.live.get(entry.record.channelId);
        if (opened) {
          // The session loaded and the channel is watched; only the relay join/re-send failed.
          opened.lastError = `relay: ${errorText(err)}`;
          this.log(`channel ${entry.channelId}: ${opened.lastError}`);
        } else {
          this.markDegraded(entry.channelId, errorText(err));
        }
      }
    }
    // R8.3: populate `chain` for restored channels immediately, so status()/channels()/wait() can see
    // attention right after a restart instead of waiting up to pollMs for the first periodic tick.
    if (!this.stopped) await this.tick();
    this.timer = setInterval(() => void this.tick(), this.opts.config.pollMs);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    for (const u of this.unsubscribers) u();
    this.unsubscribers = [];
    while (this.ticking) await new Promise((r) => setTimeout(r, 10));
    this.changes.removeAllListeners();
  }

  /** R9/3b: resolves once no tick is currently in flight — call before an explicit `tick()` in a test that needs it deterministic, so that call isn't a no-op against the periodic timer's own concurrent tick. */
  async idle(): Promise<void> {
    while (this.ticking) await new Promise((r) => setTimeout(r, 5));
  }

  channelIds(): Hex[] {
    return [...this.live.keys()];
  }

  /** Direct access to a channel's session and senders — for tests and tooling, not for the agent API. */
  handle(id: Hex): ChannelHandle {
    const l = this.live.get(id);
    if (!l) throw new DaemonError(404, `unknown channel ${id}`);
    return l;
  }

  // ------------------------------------------------------------------ lobby

  async createOffer(o: { deposit: bigint; stakePerGame: bigint; challengeTimeout: bigint }): Promise<{ offerId: Hex }> {
    // I4: refuse offers the hub would never let anyone fund (ChannelHub rejects these params on deposit), so a
    // matched channel can never sit unfundable while its deposit reverts on every tick.
    if (o.stakePerGame <= 0n) throw new DaemonError(400, "stakePerGame must be greater than 0");
    if (o.deposit < o.stakePerGame) throw new DaemonError(400, "deposit must be at least stakePerGame");
    const bounds = await this.hub.timeoutBounds();
    if (o.challengeTimeout < bounds.min || o.challengeTimeout > bounds.max) {
      throw new DaemonError(400, `challengeTimeout must be between ${bounds.min} and ${bounds.max} seconds`);
    }
    const sessionKey = generatePrivateKey();
    // R1 deviation (Task 7 review): expiresAt must be measured on the same clock `onMatch` checks it against
    // (the chain's block timestamp), not wall-clock Date.now() — a test (or a real deployment) that has moved
    // the chain clock away from wall-clock time via increaseTime/other activity would otherwise mint offers
    // that read as already expired the instant they're matched.
    const chainNow = (await this.client.getBlock()).timestamp;
    const offer: Offer = {
      template: "chess",
      player: this.wallet.address,
      signer: privateKeyToAccount(sessionKey).address,
      deposit: o.deposit,
      stakePerGame: o.stakePerGame,
      challengeTimeout: o.challengeTimeout,
      expiresAt: chainNow + 3600n,
      nonce: `0x${randomBytes(32).toString("hex")}`,
    };
    const id = computeOfferId(offer);
    this.records.saveOffer({ offerId: id, offer, sessionKey, role: "offerer" });
    await this.opts.lobby.postOffer({ offer, sig: await signOffer(sessionKey, offer) });
    return { offerId: id };
  }

  async listOffers(): Promise<Array<{ offerId: Hex; offer: Offer; mine: boolean }>> {
    const offers = await this.opts.lobby.listOffers();
    return offers.map((so) => ({
      offerId: computeOfferId(so.offer),
      offer: so.offer,
      mine: so.offer.player.toLowerCase() === this.wallet.address.toLowerCase(),
    }));
  }

  async acceptOffer(offerIdInput: Hex): Promise<void> {
    const offerId = (typeof offerIdInput === "string" ? offerIdInput.toLowerCase() : "") as Hex;
    if (!isCanonicalId(offerId)) throw new DaemonError(400, "offerId must be 0x followed by 64 hex characters");
    // M-d: accepting is idempotent — an existing acceptance is never replaced by one under a new session key
    // (the host may already have matched the first one; a new key would make this daemon reject that match).
    const channel = this.channelForOffer(offerId);
    if (channel) throw new DaemonError(409, `offer ${offerId} was already accepted (channel ${channel})`);
    const existing = this.records.offer(offerId);
    if (existing) {
      if (existing.role !== "accepter") throw new DaemonError(400, "cannot accept your own offer");
      if (!existing.acceptance) throw new DaemonError(409, `offer ${offerId} was already accepted`);
      // A retry re-sends the stored acceptance: same session key, same signature.
      try {
        await this.opts.lobby.accept(existing.acceptance);
      } catch (err) {
        throw new DaemonError(409, `offer ${offerId} was already accepted; the host did not take it again: ${errorText(err)}`);
      }
      return;
    }
    const so = (await this.opts.lobby.listOffers()).find((o) => computeOfferId(o.offer) === offerId);
    if (!so) throw new DaemonError(404, `offer ${offerId} not found`);
    if (so.offer.player.toLowerCase() === this.wallet.address.toLowerCase()) {
      throw new DaemonError(400, "cannot accept your own offer");
    }
    const sessionKey = generatePrivateKey();
    const acceptance = {
      offerId,
      player: this.wallet.address,
      signer: privateKeyToAccount(sessionKey).address,
      nonce: `0x${randomBytes(32).toString("hex")}` as Hex,
    };
    const signed = { acceptance, sig: await signAcceptance(sessionKey, acceptance) };
    // Crash ordering: the record (with the signed acceptance) is on disk before the acceptance leaves.
    this.records.saveOffer({ offerId, offer: so.offer, sessionKey, role: "accepter", acceptance: signed });
    await this.opts.lobby.accept(signed);
  }

  private async onMatch(m: MatchEvent): Promise<void> {
    if (this.stopped) return;
    // C1: `m.offerId` comes from the host and serves both as the claim key below and as a file name. Accept only
    // the canonical form, so an alias (`./0x…`, `.//0x…`, upper-case hex, …) can neither slip past the claim nor
    // resolve, via path joining, to the same offer file as the canonical id.
    const offerId = m.offerId;
    if (!isCanonicalId(offerId)) {
      this.log(`ignoring match: malformed offerId ${JSON.stringify(String(offerId)).slice(0, 80)}`);
      return;
    }
    // I3: claim the offerId synchronously, before any await, so a second match event for the same offer
    // (concurrent or back-to-back) bails here instead of racing this call to open a second channel.
    if (this.claiming.has(offerId)) return;
    this.claiming.add(offerId);
    // I3: released on every path that does not end in removeOffer() below (i.e. every rejection or error),
    // so a later, corrected match event for the same offer can still be considered.
    let claimed = true;
    const release = () => {
      if (claimed) {
        this.claiming.delete(offerId);
        claimed = false;
      }
    };
    try {
      const rec = this.records.offer(offerId);
      if (!rec) return release();
      // C1: the stored offer must be the one this id names (a record filed under the wrong name is never used).
      if (computeOfferId(rec.offer) !== offerId) {
        this.log(`ignoring match for offer ${offerId}: the stored offer does not hash to this id`);
        return release();
      }
      // C1: one offer funds at most one channel. Also covers a crash (or fs failure) between saveChannel and
      // removeOffer below, which would otherwise leave the offer record behind for a second match.
      const existing = this.channelForOffer(offerId);
      if (existing) {
        this.log(`ignoring match for offer ${offerId}: channel ${existing} already exists for it`);
        return release();
      }
      // I2: never trust the host's participant/signer ordering in m.params — derive `me` from which role this
      // player took when it created or accepted the offer, so a host that swaps indices is caught below by
      // checkMatchParams (params[me] no longer names this player's wallet/signer) rather than trusted.
      const me = rec.role === "offerer" ? 0 : 1;
      const signer = privateKeyToAccount(rec.sessionKey).address;
      const fee = await this.hub.feeConfig();
      if (this.stopped) return release();
      const now = (await this.client.getBlock()).timestamp;
      // M4: an offer the host matched after it expired must never be funded.
      if (now >= rec.offer.expiresAt) {
        this.log(`ignoring match for offer ${offerId}: offer has expired`);
        return release();
      }
      // M3: fee equality — accept only the hub's current fee, and only if it is within this player's ceiling.
      const maxFeePerPlayer = fee.feePerPlayer < this.opts.config.maxFeePerPlayer ? fee.feePerPlayer : this.opts.config.maxFeePerPlayer;
      const problem = checkMatchParams(m.params, {
        me,
        player: this.wallet.address,
        signer,
        rules: this.opts.config.rules,
        deposit: rec.offer.deposit,
        stakePerGame: rec.offer.stakePerGame,
        challengeTimeout: rec.offer.challengeTimeout,
        feeRecipient: fee.feeRecipient,
        minFeePerPlayer: fee.feePerPlayer,
        maxFeePerPlayer,
        now,
        maxFundingWindow: 7200n,
      });
      if (problem) {
        this.log(`ignoring match for offer ${offerId}: ${problem}`);
        return release();
      }
      const id = computeChannelId(this.domain.chainId, this.domain.hub, m.params);
      if (this.live.has(id)) return release();
      if (this.stopped) return release();
      const record: ChannelRecord = {
        channelId: id,
        params: m.params,
        me,
        sessionKey: rec.sessionKey,
        offerId,
        createdBlock: await this.client.getBlockNumber(),
        controller: "agent",
        note: "",
        finalized: false,
      };
      this.records.saveChannel(record);
      this.records.removeOffer(offerId);
      // The offer record is gone and a channel record carries this offerId: a duplicate match event now bails at
      // `!rec` or `channelForOffer` above, so the claim can be released.
      release();
      if (this.stopped) return;
      await this.openChannel(record);
      this.notify();
      void this.tick();
    } catch (err) {
      release();
      this.log(`match handling failed: ${errorText(err)}`);
    }
  }

  /** C1: the id of a channel (live, or recorded on disk) that was opened for `offerId`, if any. */
  private channelForOffer(offerId: Hex): Hex | null {
    const same = (r: ChannelRecord) => typeof r.offerId === "string" && r.offerId.toLowerCase() === offerId;
    for (const l of this.live.values()) if (same(l.record)) return l.record.channelId;
    for (const e of this.records.scanChannels()) if (e.record && same(e.record)) return e.record.channelId;
    return null;
  }

  private async openChannel(record: ChannelRecord): Promise<void> {
    if (this.stopped) return;
    // I1: a record whose params do not hash to its channelId under this hub/chain (e.g. `arena init` re-run
    // against another deployment) must not be watched under the wrong id — checked before the session store is
    // touched, so no snapshot for another channel is ever written into this channel's directory.
    const expected = computeChannelId(this.domain.chainId, this.domain.hub, record.params);
    if (expected !== record.channelId) {
      throw new Error(`record ${record.channelId} does not match this hub and chain (its params give ${expected})`);
    }
    const store = new FileSessionStore(arenaPaths(this.opts.home).channelSession(record.channelId));
    const session = await ChannelSession.open({
      params: record.params,
      me: record.me,
      sessionKey: record.sessionKey,
      domain: this.domain,
      store,
    });
    // I3/M1: re-check immediately before mutating `live` — the await above is a window another call (or a
    // stop()) could have used to already open this same channel, or to stop the daemon.
    if (this.stopped || this.live.has(record.channelId)) return;
    const sessionSender = new LocalKeyTxSender(record.sessionKey, this.opts.config.rpcUrl, this.chain);
    this.live.set(record.channelId, { record, session, sessionSender, processedEvents: 0, chain: null, lastError: null, passes: 0, lastProgressAt: null, progressKey: null, autoPlaying: false });
    await this.opts.relay.join(record.channelId, record.sessionKey);
    // Crash recovery (Review Focus 5): re-send our latest own state so a message lost at the crash is delivered.
    const latest = session.latest;
    const mine = record.me === 0 ? latest.sigA : latest.sigB;
    if (latest.state.turnNum > 0n && mine !== "0x") {
      await this.opts.relay.send({ type: "state", channelId: record.channelId, signed: latest }).catch(() => undefined);
    }
  }

  /** Approve once, give the session key gas for disputes, then deposit (spec §3.1, §5). */
  protected async fund(l: ChannelHandle): Promise<void> {
    if (this.stopped) return;
    const p = l.record.params;
    if (!this.approved) {
      await this.hub.approve(this.wallet, this.opts.config.usdc, maxUint256);
      this.approved = true;
    }
    if (this.stopped) return;
    if (this.opts.config.sessionGasWei > 0n) {
      // I1: top up only the shortfall, and only while the session key is actually below the target — otherwise
      // a deposit that keeps reverting (e.g. insufficient USDC) tops up the session key on every tick forever.
      const balance = await this.client.getBalance({ address: l.sessionSender.address });
      if (balance < this.opts.config.sessionGasWei) {
        if (this.stopped) return;
        const hash = await this.wallet.send({
          to: l.sessionSender.address,
          data: "0x",
          value: this.opts.config.sessionGasWei - balance,
        });
        await this.client.waitForTransactionReceipt({ hash });
      }
    }
    if (this.stopped) return;
    await this.hub.deposit(this.wallet, p);
  }

  // ------------------------------------------------------------------ relay

  private async onRelay(msg: RelayMessage): Promise<void> {
    if (this.stopped) return;
    const l = this.live.get(msg.channelId);
    if (!l) return;
    try {
      if (msg.type === "state") {
        await l.session.receive(msg.signed);
        if (this.stopped) return;
        await this.autoPlay(l);
      } else {
        await l.session.receiveClose(msg.close);
        if (this.stopped) return;
        await this.trySubmitClose(l);
      }
      l.lastError = null;
    } catch (err) {
      l.lastError = errorText(err);
      this.log(`channel ${msg.channelId}: ${l.lastError}`);
    }
    if (this.stopped) return;
    this.notify();
  }

  /** Spec §6.3: sign RESIGN when checkmated and CLAIM_STALEMATE when stalemated, regardless of controller. */
  protected async autoPlay(l: ChannelHandle): Promise<void> {
    if (l.autoPlaying) return; // the run in progress will finish the job
    l.autoPlaying = true;
    try {
      if (!l.session.isMyTurn()) return;
      const o = outcome(l.session.latest.state);
      if (o === "checkmate") await this.sendState(l, await l.session.resign());
      else if (o === "stalemate") await this.sendState(l, await l.session.claimStalemate());
    } finally {
      l.autoPlaying = false;
    }
  }

  protected async sendState(l: ChannelHandle, signed: SignedState): Promise<void> {
    await this.opts.relay.send({ type: "state", channelId: l.record.channelId, signed }).catch((err) => {
      l.lastError = `relay: ${errorText(err)}`;
    });
    await this.respondIfChallenged(l);
  }

  /** If a challenge is pending and we now hold a newer supported state, answer it on-chain from the session key. */
  protected async respondIfChallenged(l: ChannelHandle): Promise<void> {
    const id = l.record.channelId;
    const info = await this.hub.channelInfo(id);
    if (info.phase !== "Challenged") return;
    const registered = await this.hub.registeredState(id);
    if (l.session.latest.state.turnNum <= registered.turnNum) return;
    try {
      await this.hub.respond(l.sessionSender, l.session.challengeProof());
    } catch (err) {
      l.lastError = `respond: ${errorText(err)}`;
    }
  }

  private async trySubmitClose(l: ChannelHandle): Promise<void> {
    const tx = l.session.closeTransaction();
    if (!tx) return;
    const info = await this.hub.channelInfo(l.record.channelId);
    if (info.phase !== "Open" && info.phase !== "Challenged") return;
    try {
      await this.hub.closeCooperative(this.wallet, tx);
    } catch (err) {
      if (!(err instanceof HubRevertError)) throw err;
      // Both sides race to submit the same cooperative close once they hold both signatures (each one's own
      // call, and the other's relayed close message, land within the same window). The loser's simulate can
      // still see phase "Open" (the winner hasn't mined yet), so it only reverts once mined — a status revert
      // with no decodable reason, unlike the (rarer) already-stale-simulate case that decodes as "WrongPhase".
      // Either way, once the channel is no longer Open/Challenged, the close already went through: not an error.
      if (err.errorName !== "WrongPhase") {
        const after = await this.hub.channelInfo(l.record.channelId);
        if (after.phase === "Open" || after.phase === "Challenged") throw err;
      }
    }
  }

  // ------------------------------------------------------------------ actions

  async move(ref: string | undefined, input: string, opts: { offerDraw?: boolean; actor: Actor }): Promise<void> {
    const l = this.pick(ref);
    this.requireController(l, opts.actor);
    await this.sendState(l, await this.guard(() => l.session.move(input, { offerDraw: opts.offerDraw })));
    this.notify();
  }

  async resign(ref: string | undefined, actor: Actor): Promise<void> {
    const l = this.pick(ref);
    this.requireController(l, actor);
    await this.sendState(l, await this.guard(() => l.session.resign()));
    this.notify();
  }

  async acceptDraw(ref: string | undefined, actor: Actor): Promise<void> {
    const l = this.pick(ref);
    this.requireController(l, actor);
    await this.sendState(l, await this.guard(() => l.session.acceptDraw()));
    this.notify();
  }

  async nextGame(ref: string | undefined, actor: Actor): Promise<void> {
    const l = this.pick(ref);
    this.requireController(l, actor);
    await this.sendState(l, await this.guard(() => l.session.proposeNewGame()));
    this.notify();
  }

  async close(ref: string | undefined, actor: Actor): Promise<void> {
    const l = this.pick(ref);
    this.requireController(l, actor);
    const cs = await this.guard(() => l.session.signClose());
    await this.opts.relay.send({ type: "close", channelId: l.record.channelId, close: cs }).catch((err) => {
      l.lastError = `relay: ${errorText(err)}`;
    });
    await this.guard(() => this.trySubmitClose(l));
    this.notify();
  }

  async challenge(ref: string | undefined, actor: Actor): Promise<void> {
    const l = this.pick(ref);
    this.requireController(l, actor);
    await this.guard(() => this.hub.challenge(l.sessionSender, l.session.challengeProof()));
    this.notify();
  }

  async reclaim(ref: string | undefined): Promise<void> {
    const l = this.pick(ref);
    // R9/I1: dispute operations go through the session key (spec §3.1), so they keep working after the
    // Circle session backing the wallet key has expired.
    await this.guard(() => this.hub.reclaim(l.sessionSender, l.record.channelId));
    this.notify();
  }

  async handoff(ref: string | undefined, to: Controller, note: string): Promise<void> {
    const l = this.pick(ref);
    l.record = { ...l.record, controller: to, note };
    this.records.saveChannel(l.record);
    this.notify();
  }

  // ------------------------------------------------------------------ watchtower (Task 6)

  async tick(): Promise<void> {
    if (this.stopped || this.ticking) return;
    this.ticking = true;
    try {
      for (const l of this.live.values()) {
        if (this.stopped) break;
        if (l.record.finalized) continue;
        l.passes++;
        try {
          await this.watch(l);
        } catch (err) {
          l.lastError = errorText(err);
        }
      }
    } finally {
      this.ticking = false;
      if (!this.stopped) this.notify();
    }
  }

  /** One watchtower pass for one channel (spec §6.3). Runs regardless of the controller. */
  protected async watch(l: ChannelHandle): Promise<void> {
    const id = l.record.channelId;
    const p = l.record.params;
    const info = await this.hub.channelInfo(id);
    const now = (await this.client.getBlock()).timestamp;
    const me = l.record.me;

    // 1. Funding in order (spec §5), or reclaim after the deadline if this player already funded.
    if (now <= p.fundingDeadline) {
      if (info.phase === "None" && me === 0) await this.fund(l);
      else if (info.phase === "Funding" && !info.funded[me] && (me === 0 || info.funded[0])) await this.fund(l);
    } else if (info.phase === "Funding" && info.funded[me]) {
      if (this.stopped) return;
      // R9/I1: dispute operations go through the session key (spec §3.1), not the wallet.
      await this.hub.reclaim(l.sessionSender, id);
      // Bug fix (Task 6 review): reclaim() always finalizes to "Reclaimed" in the same transaction (see
      // ChannelHub.sol) — mark it here, synchronously with our own confirmed tx, instead of only via the
      // "after" re-read below, which loses a race against a test's own direct-RPC poll under load.
      l.record = { ...l.record, finalized: true };
      this.records.saveChannel(l.record);
    } else if (info.phase === "None" || (info.phase === "Funding" && !info.funded[me])) {
      // I4: the funding window closed and none of our money is in the channel (nobody funded, or only the
      // opponent did — theirs is theirs to reclaim). The channel can never open: retire it (abandoned), so it
      // stops being polled and leaves pick()'s active set. `info` was read before `now`, so confirm on a fresh
      // read taken after the deadline (no deposit can land after it) that ours really is not in — a retired
      // channel is never reclaimed by this daemon.
      if (this.stopped) return;
      const fresh = await this.hub.channelInfo(id);
      if (!(fresh.phase === "None" || (fresh.phase === "Funding" && !fresh.funded[me]))) return;
      this.log(`channel ${id}: funding window closed without our deposit; retiring it`);
      l.record = { ...l.record, finalized: true };
      this.records.saveChannel(l.record);
      await this.refreshChain(l);
      return;
    }

    // 2. Adopt on-chain states from dispute events, in order. Stop at the first ingest failure (R9/4) and
    // retry it next tick — advancing past a failed event would permanently skip it, since events are never
    // revisited once `processedEvents` passes them.
    if (this.stopped) return;
    const events = await this.hub.disputeEvents(id, l.record.createdBlock);
    let processed = l.processedEvents;
    for (; processed < events.length; processed++) {
      try {
        await l.session.ingestOnChain(events[processed].signed);
      } catch (err) {
        l.lastError = `ingest: ${errorText(err)}`;
        break;
      }
    }
    l.processedEvents = processed;

    // 3. Disputes (spec §6.3).
    if (this.stopped) return;
    if (info.phase === "Open") {
      // M-c: self-heal a crash between receiving a mating (or stalemating) move and answering it — the relay
      // path that normally calls autoPlay will not see that move again.
      await this.autoPlay(l);
    } else if (info.phase === "Challenged") {
      const registered = await this.hub.registeredState(id);
      const latest = l.session.latest.state;
      if (now < info.deadline && latest.turnNum > registered.turnNum) {
        // Stale challenge, and there is still time to answer it: we hold a newer supported state.
        await this.respondIfChallenged(l);
      } else if (latest.turnNum === registered.turnNum && !isGameOver(latest) && mover(latest) === me) {
        // We are on move in the registered state: auto-resign if checkmated, auto-claim if stalemated,
        // otherwise leave it for the controller (status shows mustMove).
        await this.autoPlay(l);
      } else if (now >= info.deadline && (isGameOver(registered) || mover(registered) !== me)) {
        // R9/I2: past the deadline, a newer state we hold is no longer answerable (respond would revert
        // DeadlinePassed), so this is the fallback once the respond branch above is no longer available.
        // Never call timeout while we are on move in the registered state — that would forfeit our own
        // stake — so this only fires when the opponent is on move there, or the registered game is over.
        if (this.stopped) return;
        // R9/I1: dispute operations go through the session key (spec §3.1), not the wallet.
        await this.hub.timeout(l.sessionSender, id);
        // Bug fix (Task 6 review): timeout() always finalizes in the same transaction (see ChannelHub.sol) —
        // mark it here, synchronously with our own confirmed tx, rather than waiting for the next tick's
        // re-read below. This narrows, but cannot close, the window for a caller polling the chain directly:
        // `timeout()` itself only resolves one RPC round trip after Anvil mines the tx and flips the on-chain
        // phase, so a direct on-chain read can still observe "Finalized" fractionally before this line runs.
        l.record = { ...l.record, finalized: true };
        this.records.saveChannel(l.record);
      }
    }

    // 4. Settled channels are done.
    if (this.stopped) return;
    const after = await this.hub.channelInfo(id);
    if (after.phase === "Finalized" || after.phase === "Reclaimed") {
      l.record = { ...l.record, finalized: true };
      this.records.saveChannel(l.record);
    }
    await this.refreshChain(l);
  }

  // ------------------------------------------------------------------ status

  async status(ref?: string): Promise<ChannelStatus> {
    const l = this.pick(ref);
    await this.refreshChain(l);
    return this.statusOf(l);
  }

  /** Every live channel's status, followed by the channels that could not be loaded (I1). */
  async channels(): Promise<Array<ChannelStatus | DegradedChannel>> {
    const out: Array<ChannelStatus | DegradedChannel> = [];
    for (const l of this.live.values()) {
      await this.refreshChain(l);
      out.push(this.statusOf(l));
    }
    for (const [channelId, error] of this.degraded) out.push({ channelId, degraded: true, error });
    return out;
  }

  /**
   * Long-poll: resolves as soon as a watched channel needs the agent, its controller changes (R8.2 — a
   * handoff that produces no `attention` must still wake a waiter), or after `timeoutMs`.
   */
  async wait(opts: { ref?: string; timeoutMs: number }): Promise<{ channelId: Hex | null; reason: string }> {
    const end = Date.now() + opts.timeoutMs;
    // Controllers seen per channel so far: recorded the first time each channel is observed (whether that's at
    // entry, or later if `opts.ref` is unset and a new channel joins `live` mid-wait), so a fresh sighting never
    // trips a spurious control-changed, but a real change on any watched channel does.
    const controllers = new Map<Hex, Controller>();
    for (;;) {
      const targets = opts.ref ? [this.pick(opts.ref)] : [...this.live.values()];
      for (const l of targets) {
        const id = l.record.channelId;
        const prev = controllers.get(id);
        if (prev === undefined) controllers.set(id, l.record.controller);
        else if (prev !== l.record.controller) return { channelId: id, reason: "control-changed" };
        const st = this.statusOf(l);
        if (st.attention) return { channelId: id, reason: st.attention };
      }
      const left = end - Date.now();
      if (left <= 0) return { channelId: null, reason: "timeout" };
      await this.nextChange(Math.min(left, 1000));
    }
  }

  private statusOf(l: ChannelHandle): ChannelStatus {
    return buildStatus({
      record: l.record,
      snapshot: l.session.snapshot(),
      myTurn: l.session.isMyTurn(),
      chain: l.chain,
      lastError: l.lastError,
      lastProgressAt: l.lastProgressAt,
    });
  }

  private async refreshChain(l: ChannelHandle): Promise<void> {
    const id = l.record.channelId;
    const [info, block] = await Promise.all([this.hub.channelInfo(id), this.client.getBlock()]);
    const registeredTurn = info.hasRegistered ? (await this.hub.registeredState(id)).turnNum : null;
    l.chain = {
      phase: info.phase,
      funded: info.funded,
      deadline: info.deadline,
      challenger: info.challenger,
      registeredTurn,
      cooldownUntil: info.cooldownUntil,
      now: block.timestamp,
    };
    // I2: progress is any change to the states and signatures held (our move, a received move, a checkpoint
    // proposed or completed, a Close signature either way, an on-chain adoption) or to the phase (the channel
    // opening, a challenge being answered). Observed here — every tick and every status call — on chain time.
    const snap = l.session.snapshot();
    const sig = (x: Hex) => (x === "0x" ? "-" : "s");
    const key = [
      info.phase,
      snap.latest.state.turnNum,
      sig(snap.latest.sigA) + sig(snap.latest.sigB),
      snap.pendingCheckpoint ? "p" : "-",
      snap.incomingCheckpoint ? "i" : "-",
      snap.closeState ? "c" : "-",
      sig(snap.closeSigs[0]) + sig(snap.closeSigs[1]),
    ].join("|");
    if (key !== l.progressKey) {
      l.progressKey = key;
      l.lastProgressAt = block.timestamp;
    }
  }

  private nextChange(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.changes.off("change", done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.changes.on("change", done);
    });
  }

  // ------------------------------------------------------------------ helpers

  protected pick(ref: string | undefined): ChannelHandle {
    const active = [...this.live.values()].filter((l) => !l.record.finalized);
    if (ref) {
      const hits = [...this.live.values()].filter((l) => l.record.channelId.toLowerCase().startsWith(ref.toLowerCase()));
      if (hits.length === 1) return hits[0];
      // I1: degraded channels are never picked, but naming one explains why instead of "unknown channel".
      const broken = hits.length === 0 ? [...this.degraded].filter(([id]) => id.toLowerCase().startsWith(ref.toLowerCase())) : [];
      if (broken.length === 1) throw new DaemonError(409, `channel ${broken[0][0]} could not be loaded: ${broken[0][1]}`);
      throw new DaemonError(hits.length === 0 ? 404 : 400, hits.length === 0 ? `unknown channel ${ref}` : `ambiguous channel ${ref}`);
    }
    if (active.length === 1) return active[0];
    throw new DaemonError(400, active.length === 0 ? "no active channel" : "several channels are active: pass --channel");
  }

  protected requireController(l: ChannelHandle, actor: Actor): void {
    if (actor !== l.record.controller) {
      throw new DaemonError(409, `the ${l.record.controller} is in control of this channel (use "arena handoff")`);
    }
  }

  protected async guard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof ArenaProtocolError || err instanceof HubRevertError) throw new DaemonError(409, err.message);
      throw err;
    }
  }

  protected notify(): void {
    try {
      this.changes.emit("change");
    } catch {
      // M8: a throwing listener must never break the caller (a move, a relay message, a tick).
    }
  }

  private markDegraded(channelId: string, error: string): void {
    this.degraded.set(channelId, error);
    this.log(`channel ${channelId} is degraded and not watched: ${error}`);
  }

  protected log(line: string): void {
    (this.opts.log ?? (() => undefined))(line);
  }
}
