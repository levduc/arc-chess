import { Chess } from "chess.js";
import type { Hex } from "viem";
import { STATUS, fenOf, isGameOver, outcome, unpackMeta, type Outcome, type PlayerIndex, type SessionSnapshot } from "@arena/sdk";
import type { ChainView } from "./daemon.js";
import type { ChannelRecord, Controller } from "./records.js";

export type ChannelStatus = {
  channelId: Hex;
  phase: string;
  me: PlayerIndex;
  color: "white" | "black";
  controller: Controller;
  note: string;
  gameIndex: number;
  turnNum: string;
  fen: string;
  board: string;
  legalMoves: string[];
  myTurn: boolean;
  gameStatus: "playing" | "draw_offered" | "white_won" | "black_won" | "draw";
  outcome: Outcome;
  balances: { me: string; opponent: string };
  cooldown: { meSeconds: number; opponentSeconds: number };
  newGame: "none" | "proposed_by_me" | "proposed_by_opponent";
  closing: boolean;
  opponentWantsToClose: boolean;
  challenge: null | { deadline: string; secondsLeft: number; mustMove: boolean; challenger: "me" | "opponent" };
  attention:
    | null
    | "session-gas-low"
    | "your-turn"
    | "new-game-proposed"
    | "game-over"
    | "close-requested"
    | "opponent-silent"
    | "settled";
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
};

const GAME_STATUS = ["playing", "draw_offered", "white_won", "black_won", "draw"] as const;

export function usdc(amount: bigint): string {
  const whole = amount / 1_000_000n;
  const frac = (amount % 1_000_000n).toString().padStart(6, "0");
  return `${whole}.${frac}`;
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
  const challenge =
    chain && phase === "Challenged"
      ? {
          deadline: chain.deadline.toString(),
          secondsLeft: Math.max(0, Number(chain.deadline - chain.now)),
          mustMove: myTurn && chain.registeredTurn !== null && chain.registeredTurn === s.turnNum,
          challenger: (chain.challenger === me ? "me" : "opponent") as "me" | "opponent",
        }
      : null;
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
  } else if (input.settled && (phase === "Finalized" || phase === "Reclaimed") && record.controller === "agent") {
    // Final review m4: one wake for the settlement (e.g. after this player's close), consumed by `wait()`.
    attention = "settled";
  }

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
    controller: record.controller,
    note: record.note,
    gameIndex: s.gameIndex,
    turnNum: s.turnNum.toString(),
    fen: game.fen(),
    board: game.ascii(),
    legalMoves: myTurn ? game.moves() : [],
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
    suggestedActions,
    lastError: input.lastError,
    lobbyError: input.lobbyError ?? null,
    swept: record.swept ?? null,
    sweptAmount: record.sweptAmount !== undefined ? record.sweptAmount.toString() : null,
    sweptTx: record.sweptTx ?? null,
    sweeps: (record.sweeps ?? []).map((s) => ({ amount: s.amount.toString(), tx: s.tx, at: s.at })),
  };
}
