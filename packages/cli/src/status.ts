import { Chess } from "chess.js";
import type { Hex } from "viem";
import {
  KIND,
  PROMO_LETTER,
  STATUS,
  decodeMove,
  fenOf,
  isGameOver,
  legalMoves,
  outcome,
  squareName,
  unpackMeta,
  type Outcome,
  type PlayerIndex,
  type SessionSnapshot,
} from "@arena/sdk";
import type { ChainView } from "./daemon.js";
import type { ChannelRecord, Controller } from "./records.js";

export type ChannelStatus = {
  channelId: Hex;
  phase: string;
  me: PlayerIndex;
  color: "white" | "black";
  /** Plan 5 Task 2: the board's own orientation for this seat -- always equal to `color`. */
  orientation: "white" | "black";
  controller: Controller;
  note: string;
  /** Plan 5 Task 2: the last move applied to reach `fen` from the state before it, as `{from, to, san}` (computed
   *  with chess.js from the previous FEN and the decoded move). `null` at the start of a game (no previous state)
   *  and for a non-move latest state (resign, accept-draw, claim-stalemate, a new-game checkpoint). */
  lastMove: { from: string; to: string; san: string } | null;
  /** Plan 5 Task 2: who controls this seat, this seat's handoff note, and when that was last set (ISO 8601), or
   *  `null` if this channel has never been handed off. `controller`/`note` duplicate the top-level fields of the
   *  same name (kept there for existing callers); this groups them with `since` for the board's controller panel. */
  handoff: { controller: Controller; note: string; since: string | null };
  gameIndex: number;
  turnNum: string;
  fen: string;
  board: string;
  legalMoves: string[];
  /** Plan 5 Task 2: the same legal moves as `legalMoves`, as UCI strings (e.g. "e7e8q") -- for the board's click
   *  targets. Empty unless it is my turn, exactly like `legalMoves`. */
  legalMovesUci: string[];
  myTurn: boolean;
  gameStatus: "playing" | "draw_offered" | "white_won" | "black_won" | "draw";
  outcome: Outcome;
  balances: { me: string; opponent: string };
  cooldown: { meSeconds: number; opponentSeconds: number };
  newGame: "none" | "proposed_by_me" | "proposed_by_opponent";
  closing: boolean;
  opponentWantsToClose: boolean;
  /** `autoReturnAt` (final fix wave I1): the chain time (unix seconds, like `deadline`) at which the daemon hands
   *  this seat back to the agent -- set only while a human holds a seat that must move and auto-return is on. */
  challenge: null | {
    deadline: string;
    secondsLeft: number;
    mustMove: boolean;
    challenger: "me" | "opponent";
    autoReturnAt: string | null;
  };
  attention:
    | null
    | "session-gas-low"
    | "human-must-move"
    | "your-turn"
    | "new-game-proposed"
    | "game-over"
    | "close-requested"
    | "opponent-silent"
    | "settled";
  /** Plan 5 Task 3 fix round: what a human holding the seat should see that `attention` deliberately leaves out.
   *  `attention` stays agent-only apart from session-gas-low and human-must-move (final fix wave I1), because
   *  `wait()` wakes on any `attention` and must stay quiet while a human controls the channel (spec §6.2). Today that is `opponent-silent` alone, with
   *  `arena challenge` first in `suggestedActions` exactly as for the agent. Null while the agent is in control. */
  humanAttention: null | "opponent-silent";
  suggestedActions: string[];
  lastError: string | null;
  /** Plan 4.5 Task 11 fix round (C2): the daemon-wide "too many watched offers" (or other subscribe-refusal)
   *  message, if the host has ever refused a subscribe on this daemon's connection, else null. Not specific to
   *  this channel -- it means new offers/accepts are refused until this daemon restarts (see checkLobbyHealthy in
   *  daemon.ts) -- but every channel's status carries it, since there is no daemon-wide endpoint to put it on. */
  lobbyError: string | null;
  /** Plan 5 fix round (I2): the record's own sweep outcome -- `null` while not finalized or not yet swept,
   *  `true`/`"dust"`/`"abandoned"` once the sweep (or the abandon back-off) has run. See `ChannelRecord.swept`. */
  swept: true | "dust" | "abandoned" | null;
  /** Plan 5 fix round: the swept amount (base units of native gas), set alongside `swept: true`. The latest
   *  entry of `sweeps`, kept for compatibility. */
  sweptAmount: string | null;
  /** Plan 5 fix round: the sweep transaction's hash, set alongside `swept: true`. The latest entry of `sweeps`,
   *  kept for compatibility. */
  sweptTx: Hex | null;
  /** Fix round 3, M-4: every real sweep this channel's session key has had, oldest first -- a late top-up
   *  (minor 4) or a retried-and-succeeded abandoned channel (important 1) can mean more than one over its
   *  lifetime; `sweptAmount`/`sweptTx` alone only ever show the latest. Empty if it has never been swept. */
  sweeps: Array<{ amount: string; tx: Hex; at: number }>;
};

export type StatusInput = {
  record: ChannelRecord;
  snapshot: SessionSnapshot;
  myTurn: boolean;
  chain: ChainView | null;
  lastError: string | null;
  /**
   * I2: chain time at which the daemon last saw this channel progress (a state, checkpoint, Close signature or
   * phase change), or null if not yet observed. Drives `opponent-silent`.
   */
  lastProgressAt?: bigint | null;
  /** Plan 4.5 Task 11 fix round (C2): see ChannelStatus.lobbyError. */
  lobbyError?: string | null;
  /** Final review C1: why the session key's dispute gas is low and the wallet could not refill it, or null. */
  sessionGasLow?: string | null;
  /** Final review m4: the channel settled while the daemon watched it and no `wait()` has woken for it yet. */
  settled?: boolean;
  /** Final fix wave (I1): seconds before the deadline at which the daemon returns a human-held seat that must move
   *  to the agent (`autoReturnSecondsOf`), or null/absent when auto-return is off. */
  autoReturnSeconds?: number | null;
  /** Final fix wave (I1): `wait()` has already woken for this challenge's `human-must-move`. */
  ignoreHumanMustMove?: boolean;
};

const GAME_STATUS = ["playing", "draw_offered", "white_won", "black_won", "draw"] as const;

export function usdc(amount: bigint): string {
  const whole = amount / 1_000_000n;
  const frac = (amount % 1_000_000n).toString().padStart(6, "0");
  return `${whole}.${frac}`;
}

/**
 * Plan 5 Task 2: `latest`'s move, described against `prev` (the state directly before it) as `{from, to, san}`,
 * or `null` when there is nothing to describe -- no `prev` at all (the opening state), a non-move latest state
 * (resign, accept-draw, claim-stalemate, or a NEW_GAME checkpoint), or (defensively) a `prev` that turns out not
 * to be latest's immediate predecessor after all. `ChannelSession.advanceLatest` sets `prev` to the old `latest`
 * on every normal move, so the turnNum/gameIndex check below should never actually fail in practice; it exists so
 * an unexpected shape falls back to `null` instead of feeding chess.js a mismatched position.
 */
function lastMoveOf(snapshot: SessionSnapshot): ChannelStatus["lastMove"] {
  const { prev, latest } = snapshot;
  if (!prev) return null;
  const decoded = decodeMove(latest.state.move);
  if (decoded.kind !== KIND.NORMAL && decoded.kind !== KIND.NORMAL_OFFER_DRAW) return null;
  if (prev.state.turnNum + 1n !== latest.state.turnNum || prev.state.gameIndex !== latest.state.gameIndex) return null;
  const from = squareName(decoded.from);
  const to = squareName(decoded.to);
  try {
    const game = new Chess(fenOf(prev.state));
    const played = game.move({ from, to, ...(decoded.promo ? { promotion: PROMO_LETTER[decoded.promo] } : {}) });
    return { from, to, san: played.san };
  } catch {
    return null;
  }
}

export function buildStatus(input: StatusInput): ChannelStatus {
  const { record, snapshot, myTurn, chain } = input;
  const s = snapshot.latest.state;
  const me = record.me;
  const color = s.gameIndex % 2 === me ? "white" : "black";
  const game = new Chess(fenOf(s));
  const status = unpackMeta(s.meta).status;
  const [mine, theirs] = me === 0 ? [s.balanceA, s.balanceB] : [s.balanceB, s.balanceA];
  const newGame = snapshot.pendingCheckpoint
    ? "proposed_by_me"
    : snapshot.incomingCheckpoint
      ? "proposed_by_opponent"
      : "none";
  const opponent = me === 0 ? 1 : 0;
  const closing = snapshot.closeState !== null;
  const opponentWantsToClose = snapshot.closeSigs[opponent] !== "0x";
  const phase = chain?.phase ?? "Unknown";
  let challenge: ChannelStatus["challenge"] = null;
  if (chain && phase === "Challenged") {
    const mustMove = myTurn && chain.registeredTurn !== null && chain.registeredTurn === s.turnNum;
    const autoReturn = input.autoReturnSeconds ?? null;
    challenge = {
      deadline: chain.deadline.toString(),
      secondsLeft: Math.max(0, Number(chain.deadline - chain.now)),
      mustMove,
      challenger: chain.challenger === me ? "me" : "opponent",
      autoReturnAt:
        mustMove && record.controller === "human" && autoReturn !== null ? (chain.deadline - BigInt(autoReturn)).toString() : null,
    };
  }
  const cooldown = chain
    ? {
        meSeconds: Math.max(0, Number(chain.cooldownUntil[me] - chain.now)),
        opponentSeconds: Math.max(0, Number(chain.cooldownUntil[opponent] - chain.now)),
      }
    : { meSeconds: 0, opponentSeconds: 0 };
  const over = isGameOver(s);
  const live = phase === "Open" || phase === "Challenged";
  const open = phase === "Open";

  // I2: the channel waits on the opponent — their move, their countersignature on our new-game proposal, or their
  // Close signature once we have signed ours. Silence beyond challengeTimeout (chain time) escalates (spec §7).
  const waitingOnOpponent =
    open && !myTurn && (!over || newGame === "proposed_by_me" || (closing && !opponentWantsToClose));
  const lastProgressAt = input.lastProgressAt ?? null;
  const silent =
    waitingOnOpponent && chain !== null && lastProgressAt !== null && chain.now - lastProgressAt > record.params.challengeTimeout;

  let attention: ChannelStatus["attention"] = null;
  // Final review C1: first, and whoever controls the channel -- a session key that cannot pay cannot answer a
  // challenge, and an unanswered one can roll the channel back.
  const gasLow = live && input.sessionGasLow ? input.sessionGasLow : null;
  if (gasLow) attention = "session-gas-low";
  else if (live && record.controller === "agent") {
    if (myTurn) attention = "your-turn";
    else if (newGame === "proposed_by_opponent" && !closing) attention = "new-game-proposed";
    // I2: only a request we can honour — `arena close` works only on a finished game with no proposal pending.
    else if (opponentWantsToClose && over && !closing && newGame === "none") attention = "close-requested";
    else if (over && !closing && newGame === "none") attention = "game-over";
    else if (silent) attention = "opponent-silent";
  } else if (live && challenge?.mustMove && !input.ignoreHumanMustMove) {
    // Final fix wave (I1): a human holds a seat that must move before the challenge deadline. Raised for the agent
    // too (wait() wakes once per challenge): the human may have walked away, and a missed deadline forfeits.
    attention = "human-must-move";
  } else if (input.settled && (phase === "Finalized" || phase === "Reclaimed")) {
    // Final review m4: one wake for the settlement (e.g. after this player's close), consumed by `wait()`. Final
    // fix wave (M2): whoever holds the seat -- a settled channel has no seat left to protect.
    attention = "settled";
  }

  const humanAttention: ChannelStatus["humanAttention"] = record.controller === "human" && silent ? "opponent-silent" : null;

  const suggestedActions: string[] = [];
  // I2: the on-chain escape from a stalled or withheld state (only while Open; once Challenged it is under way).
  let challengeHint: string | null = null;
  if (phase === "None" || phase === "Funding") {
    suggestedActions.push(
      record.finalized
        ? "done: the funding window closed without this channel opening; nothing is left to do"
        : "wait: the channel is being funded",
    );
    // Task 2 (spec §13): names the cause when funding is blocked by the hub's pause, rather than leaving the
    // agent to guess why a channel is not progressing.
    if (!record.finalized && input.lastError?.startsWith("funding: Paused")) {
      suggestedActions.push(
        "wait: the hub is paused; funding resumes automatically when it is unpaused (or reclaim after the funding deadline)",
      );
    }
  } else if (phase === "Finalized") suggestedActions.push("done: the channel is settled");
  else if (phase === "Reclaimed") suggestedActions.push("done: the channel was never funded and deposits were returned");
  else if (closing) {
    suggestedActions.push("wait: close signed; waiting for the opponent's close signature");
    if (open && !opponentWantsToClose) challengeHint = "arena challenge   (settles the finished game on-chain if they never sign)";
  } else if (myTurn) {
    suggestedActions.push(`arena move <move>   (one of: ${game.moves().slice(0, 8).join(", ")}${game.moves().length > 8 ? ", …" : ""})`);
    suggestedActions.push("arena move <move> --offer-draw", "arena resign");
    if (status === STATUS.DRAW_OFFERED) suggestedActions.push("arena accept-draw");
  } else if (over) {
    if (newGame === "proposed_by_me") {
      // `arena close` always fails while our own proposal is pending, so it is not offered here.
      suggestedActions.push("wait: new game proposed");
      if (open) challengeHint = "arena challenge   (settles the finished game on-chain if the opponent never answers)";
    } else if (opponentWantsToClose) {
      // Final review I2: `arena next-game` now refuses once the opponent has signed Close (daemon.ts's
      // nextGame), so it must not be suggested here either -- the only way forward is `close`.
      suggestedActions.push("arena close");
    } else {
      suggestedActions.push("arena next-game", "arena close");
    }
  } else {
    suggestedActions.push("arena wait");
    if (open) challengeHint = "arena challenge   (if the opponent stops responding)";
  }
  if (silent) {
    suggestedActions.unshift(
      `arena challenge   (the opponent has made no progress for over ${record.params.challengeTimeout}s; forces an answer on-chain)`,
    );
  } else if (challengeHint) {
    suggestedActions.push(challengeHint);
  }
  if (challenge?.mustMove && record.controller === "human") {
    suggestedActions.unshift(
      `tell your human: a challenge needs their move on the board within ${challenge.secondsLeft}s` +
        (challenge.autoReturnAt !== null
          ? `; with ${input.autoReturnSeconds}s left the daemon hands the seat back to you, and then you must move (arena move)`
          : "; if they cannot, take the seat back (arena handoff agent) and move"),
    );
  }
  if (input.lobbyError) {
    suggestedActions.unshift(`restart this daemon: the host refused a subscribe (${input.lobbyError}) -- new offers/accepts are refused until then`);
  }
  if (gasLow) {
    suggestedActions.unshift(
      `fund your wallet: dispute gas for channel ${record.channelId} is low (${gasLow}); the daemon refills it on its next pass`,
    );
  }

  return {
    channelId: record.channelId,
    phase,
    me,
    color,
    orientation: color,
    controller: record.controller,
    note: record.note,
    lastMove: lastMoveOf(snapshot),
    handoff: {
      controller: record.controller,
      note: record.note,
      since: record.handoffAt !== undefined ? new Date(record.handoffAt).toISOString() : null,
    },
    gameIndex: s.gameIndex,
    turnNum: s.turnNum.toString(),
    fen: game.fen(),
    board: game.ascii(),
    legalMoves: myTurn ? game.moves() : [],
    legalMovesUci: myTurn ? legalMoves(s) : [],
    myTurn,
    gameStatus: GAME_STATUS[status] ?? "playing",
    outcome: outcome(s),
    balances: { me: usdc(mine), opponent: usdc(theirs) },
    cooldown,
    newGame,
    closing,
    opponentWantsToClose,
    challenge,
    attention,
    humanAttention,
    suggestedActions,
    lastError: input.lastError,
    lobbyError: input.lobbyError ?? null,
    swept: record.swept ?? null,
    sweptAmount: record.sweptAmount !== undefined ? record.sweptAmount.toString() : null,
    sweptTx: record.sweptTx ?? null,
    sweeps: (record.sweeps ?? []).map((s) => ({ amount: s.amount.toString(), tx: s.tx, at: s.at })),
  };
}
