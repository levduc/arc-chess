// Plan 5 Task 3: the board's pure half. Everything here maps a ChannelStatus (packages/cli/src/status.ts) plus a
// little UI state to plain data -- a view model, an intent, a label -- and never touches the DOM or the network,
// so it runs unchanged in the browser and under vitest (packages/cli/test/board.test.ts). app.js turns the view
// model into DOM nodes and sends the intents through api.js.

export const FILES = "abcdefgh";

/** Phases in which the channel's game can still be played on (spec §5: Open off-chain, Challenged on-chain). */
const LIVE_PHASES = new Set(["Open", "Challenged"]);
const SETTLED_PHASES = new Set(["Finalized", "Reclaimed"]);
const OVER_STATUSES = new Set(["white_won", "black_won", "draw"]);

const PIECE_NAMES = { k: "king", q: "queen", r: "rook", b: "bishop", n: "knight", p: "pawn" };
// The filled glyph set for both colours (coloured by CSS): the outline set renders inconsistently across system
// fonts. U+FE0E asks for text presentation, so the pawn never turns into an emoji.
const GLYPHS = { k: "♚", q: "♛", r: "♜", b: "♝", n: "♞", p: "♟" };

// ---------------------------------------------------------------- squares and orientation

/** The square at grid `index` (0-63, row-major from the top-left corner as the viewer sees it). */
export function squareAt(index, orientation) {
  const row = Math.floor(index / 8);
  const col = index % 8;
  return orientation === "black" ? `${FILES[7 - col]}${row + 1}` : `${FILES[col]}${8 - row}`;
}

/** The grid index of `square` for this orientation; the inverse of `squareAt`. */
export function indexOfSquare(square, orientation) {
  const file = FILES.indexOf(square[0]);
  const rank = Number(square[1]);
  const [row, col] = orientation === "black" ? [rank - 1, 7 - file] : [8 - rank, file];
  return row * 8 + col;
}

/** Keyboard navigation in screen space: ArrowUp always moves up the screen, whichever side is at the bottom.
 *  Clamped at the board's edges; any other key leaves the square unchanged. */
export function stepSquare(square, key, orientation) {
  const i = indexOfSquare(square, orientation);
  let row = Math.floor(i / 8);
  let col = i % 8;
  if (key === "ArrowUp") row--;
  else if (key === "ArrowDown") row++;
  else if (key === "ArrowLeft") col--;
  else if (key === "ArrowRight") col++;
  else if (key === "Home") col = 0;
  else if (key === "End") col = 7;
  row = Math.min(7, Math.max(0, row));
  col = Math.min(7, Math.max(0, col));
  return squareAt(row * 8 + col, orientation);
}

// ---------------------------------------------------------------- FEN

/** `{ e1: "K", d8: "q", ... }` from a FEN's piece-placement field; `{}` for anything malformed.
 *  @returns {Record<string, string>} */
export function piecesFromFen(fen) {
  /** @type {Record<string, string>} */
  const out = {};
  if (typeof fen !== "string") return out;
  const ranks = fen.split(" ")[0].split("/");
  if (ranks.length !== 8) return {};
  for (let r = 0; r < 8; r++) {
    let file = 0;
    for (const ch of ranks[r]) {
      if (ch >= "1" && ch <= "8") file += Number(ch);
      else if (/^[kqrbnp]$/i.test(ch) && file < 8) out[`${FILES[file++]}${8 - r}`] = ch;
      else return {};
    }
  }
  return out;
}

export function sideToMove(fen) {
  return typeof fen === "string" && fen.split(" ")[1] === "b" ? "black" : "white";
}

export function pieceColor(letter) {
  return letter === letter.toUpperCase() ? "white" : "black";
}

export function pieceName(letter) {
  return `${pieceColor(letter)} ${PIECE_NAMES[letter.toLowerCase()]}`;
}

export function pieceGlyph(letter) {
  return `${GLYPHS[letter.toLowerCase()]}︎`;
}

/** "e4 white pawn", "d5 empty", or with state suffixes: "e1 white king, in check". */
export function squareLabel(square, letter, extras = []) {
  const base = `${square} ${letter ? pieceName(letter) : "empty"}`;
  return extras.length > 0 ? `${base}, ${extras.join(", ")}` : base;
}

// ---------------------------------------------------------------- moves

/** The distinct target squares of the legal UCI moves starting on `from` (a promotion's four moves are one). */
export function targetsFrom(legalMovesUci, from) {
  const out = [];
  for (const uci of legalMovesUci ?? []) {
    if (uci.slice(0, 2) !== from) continue;
    const to = uci.slice(2, 4);
    if (!out.includes(to)) out.push(to);
  }
  return out;
}

/** Every legal UCI move from `from` to `to`: one, or four for a promotion. */
export function movesBetween(legalMovesUci, from, to) {
  return (legalMovesUci ?? []).filter((uci) => uci.slice(0, 2) === from && uci.slice(2, 4) === to);
}

export function isPromotion(legalMovesUci, from, to) {
  return movesBetween(legalMovesUci, from, to).some((uci) => uci.length === 5);
}

export function lastMoveSquares(lastMove) {
  return lastMove ? [lastMove.from, lastMove.to] : [];
}

/** The side-to-move king's square when the last move gave check (its SAN ends in "+" or "#"), else null. */
export function checkSquare(status) {
  const san = status?.lastMove?.san;
  if (typeof san !== "string" || !/[+#]$/.test(san)) return null;
  const king = sideToMove(status.fen) === "white" ? "K" : "k";
  const pieces = piecesFromFen(status.fen);
  return Object.keys(pieces).find((sq) => pieces[sq] === king) ?? null;
}

// ---------------------------------------------------------------- what the human may do

export function isLive(status) {
  return !!status && LIVE_PHASES.has(status.phase);
}

export function isSettled(status) {
  return !!status && SETTLED_PHASES.has(status.phase);
}

export function isGameOver(status) {
  return !!status && OVER_STATUSES.has(status.gameStatus);
}

/** Moves are clickable only when the human controls the seat, it is our turn, and the game is live. The daemon
 *  fills `legalMovesUci` on our turn whoever controls the seat, so the controller check has to happen here too. */
export function canMove(status) {
  return (
    !!status &&
    status.controller === "human" &&
    status.myTurn === true &&
    isLive(status) &&
    Array.isArray(status.legalMovesUci) &&
    status.legalMovesUci.length > 0
  );
}

/** True when `suggestedActions` lists `command`, exactly or followed by a space (its usage hint). */
function suggests(status, command) {
  return (status.suggestedActions ?? []).some((a) => a === command || a.startsWith(`${command} `));
}

/** Which controls are enabled. Everything that signs needs the human in control; the daemon enforces the same
 *  thing (409), this just avoids offering a button that can only fail. */
export function actionState(status) {
  const human = status?.controller === "human";
  const live = isLive(status);
  const act = (command) => human && live && suggests(status, command);
  const move = canMove(status);
  return {
    move,
    offerDraw: move,
    resign: act("arena resign"),
    acceptDraw: act("arena accept-draw"),
    nextGame: act("arena next-game"),
    close: act("arena close"),
    challenge: human && status?.phase === "Open" && suggests(status, "arena challenge") && (status.cooldown?.meSeconds ?? 0) === 0,
    takeOver: !!status && !human && !isSettled(status),
    handBack: human && !isSettled(status),
  };
}

// ---------------------------------------------------------------- board view model and click intents

/**
 * One click on `square`, given the current selection. Returns the next selection and at most one intent:
 * `{type: "move", uci}` or `{type: "promote", from, to, choices}` (app.js then asks which piece).
 */
export function clickSquare(status, ui, square) {
  if (!canMove(status)) return { selected: null, intent: null };
  const moves = status.legalMovesUci;
  const selected = ui?.selected ?? null;
  if (selected) {
    const ucis = movesBetween(moves, selected, square);
    if (ucis.length > 0) {
      if (ucis.some((u) => u.length === 5)) {
        return { selected, intent: { type: "promote", from: selected, to: square, choices: ucis.map((u) => u[4]) } };
      }
      return { selected: null, intent: { type: "move", uci: ucis[0] } };
    }
    if (square === selected) return { selected: null, intent: null };
  }
  if (targetsFrom(moves, square).length > 0) return { selected: square, intent: null };
  return { selected: null, intent: null };
}

/** The 64 squares in display order, each with everything app.js needs to draw it. */
export function boardView(status, ui) {
  const orientation = status?.orientation === "black" ? "black" : "white";
  const pieces = piecesFromFen(status?.fen);
  const last = lastMoveSquares(status?.lastMove);
  const check = status ? checkSquare(status) : null;
  const moves = canMove(status) ? status.legalMovesUci : [];
  const movable = new Set(moves.map((u) => u.slice(0, 2)));
  const selected = ui?.selected && movable.has(ui.selected) ? ui.selected : null;
  const targets = selected ? targetsFrom(moves, selected) : [];
  const out = [];
  for (let i = 0; i < 64; i++) {
    const square = squareAt(i, orientation);
    const fileIdx = FILES.indexOf(square[0]);
    const rank = Number(square[1]);
    const piece = pieces[square] ?? "";
    const flags = {
      lastMove: last.includes(square),
      selected: square === selected,
      target: targets.includes(square),
      capture: targets.includes(square) && piece !== "",
      check: square === check,
    };
    const extras = [];
    if (flags.check) extras.push("in check");
    if (flags.selected) extras.push("selected");
    if (flags.target) extras.push(flags.capture ? "legal capture" : "legal move");
    if (flags.lastMove) extras.push("last move");
    out.push({
      square,
      piece,
      dark: (fileIdx + rank - 1) % 2 === 0,
      movable: movable.has(square),
      ...flags,
      fileLabel: i >= 56 ? square[0] : "",
      rankLabel: i % 8 === 0 ? square[1] : "",
      label: squareLabel(square, piece, extras),
    });
  }
  return out;
}

// ---------------------------------------------------------------- channel list

/** One chip per channel: your turn, waiting, challenged, settled, and a few in-between states. */
export function channelChip(status) {
  if (status?.degraded) return { kind: "degraded", label: "Unavailable" };
  if (isSettled(status)) return { kind: "settled", label: "Settled" };
  if (status.phase === "Challenged") return { kind: "challenged", label: status.challenge?.mustMove ? "Must move" : "Challenged" };
  if (status.phase === "None" || status.phase === "Funding") return { kind: "funding", label: "Funding" };
  if (status.phase !== "Open") return { kind: "waiting", label: "Syncing" };
  if (status.myTurn) return { kind: "your-turn", label: "Your turn" };
  if (isGameOver(status)) {
    if (status.closing) return { kind: "game-over", label: "Closing" };
    if (status.newGame === "proposed_by_opponent") return { kind: "game-over", label: "New game?" };
    return { kind: "game-over", label: "Game over" };
  }
  return { kind: "waiting", label: "Waiting" };
}

/** Per-channel warnings for the list. The lobby error is daemon-wide, so app.js shows it once, not per channel. */
export function channelBanners(status) {
  if (!status || status.degraded) return [];
  const out = [];
  if (status.attention === "session-gas-low") out.push({ kind: "session-gas-low", text: "Session gas low: fund your wallet" });
  if (status.challenge?.mustMove) out.push({ kind: "must-move", text: "You must move before the deadline" });
  if (status.attention === "opponent-silent") out.push({ kind: "opponent-silent", text: "Opponent silent: consider a challenge" });
  return out;
}

/** The channel to show first: a forced move, then our turn (human-controlled first), then any live channel. */
export function pickDefaultChannel(list) {
  const ok = (list ?? []).filter((s) => s && !s.degraded);
  const pick =
    ok.find((s) => s.challenge?.mustMove) ??
    ok.find((s) => s.myTurn && s.controller === "human") ??
    ok.find((s) => s.myTurn) ??
    ok.find((s) => isLive(s)) ??
    ok.find((s) => !isSettled(s)) ??
    ok[0];
  return pick ? pick.channelId : null;
}

// ---------------------------------------------------------------- text

export function gameStatusText(status) {
  switch (status?.gameStatus) {
    case "playing":
      return "In progress";
    case "draw_offered":
      return "Draw offered";
    case "white_won":
      return status.color === "white" ? "White won (you)" : "White won";
    case "black_won":
      return status.color === "black" ? "Black won (you)" : "Black won";
    case "draw":
      return "Draw";
    default:
      return "Unknown";
  }
}

/** The one-line headline above the board. */
export function turnText(status) {
  if (!status) return "";
  if (status.phase === "Finalized") return "Channel settled";
  if (status.phase === "Reclaimed") return "Channel reclaimed: deposits returned";
  if (status.phase === "None" || status.phase === "Funding") return "Waiting for the channel to be funded";
  if (isGameOver(status)) {
    if (status.closing) return "Game over: closing the channel";
    if (status.newGame === "proposed_by_opponent") return "Game over: the opponent proposes a new game";
    if (status.newGame === "proposed_by_me") return "Game over: new game proposed, waiting for the opponent";
    return `Game over: ${gameStatusText(status)}`;
  }
  if (status.myTurn) return status.controller === "human" ? "Your move" : "Your turn: the agent is playing";
  return "Waiting for the opponent";
}

/** "0.900000" -> "0.90": at least two decimals, trailing zeros past them dropped. Anything else passes through. */
export function formatUsdc(amount) {
  const m = /^(\d+)\.(\d+)$/.exec(String(amount));
  if (!m) return String(amount);
  const frac = m[2].replace(/0+$/, "").padEnd(2, "0");
  return `${m[1]}.${frac}`;
}

/** A base-unit string ("1500000", as the offers list sends it) as a USDC amount ("1.50"). */
export function baseUnitsToUsdc(base) {
  if (!/^\d+$/.test(String(base))) return "?";
  const v = BigInt(base);
  return formatUsdc(`${v / 1_000_000n}.${(v % 1_000_000n).toString().padStart(6, "0")}`);
}

/** A USDC amount typed by the user ("1.5") as the base-unit string the API takes ("1500000"). Throws on anything
 *  that is not a plain non-negative decimal with at most 6 fractional digits. */
export function usdcToBaseUnits(input) {
  const s = String(input).trim();
  const m = /^(\d*)(?:\.(\d{0,6}))?$/.exec(s);
  if (!m || s === "" || s === "." || (m[1] === "" && !m[2])) {
    throw new Error("Enter an amount in USDC, for example 1.5 (at most 6 decimals)");
  }
  const whole = BigInt(m[1] === "" ? "0" : m[1]);
  const frac = BigInt((m[2] ?? "").padEnd(6, "0"));
  return (whole * 1_000_000n + frac).toString();
}

export function formatCountdown(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** The countdown ticked down locally: `secondsLeft` as of `syncedAtMs`, read at `nowMs`. */
export function remainingSeconds(secondsLeft, syncedAtMs, nowMs) {
  return Math.max(0, secondsLeft - Math.floor((nowMs - syncedAtMs) / 1000));
}

export function formatDuration(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  if (s < 60) return `${s} s`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

export function shortHex(hex) {
  const s = String(hex ?? "");
  return s.length > 14 ? `${s.slice(0, 6)}…${s.slice(-4)}` : s;
}

// ---------------------------------------------------------------- handoff note

/** Mirrors the daemon's own check (MAX_HANDOFF_NOTE_LENGTH and FORBIDDEN_NOTE_CHARS in daemon.ts), so the user
 *  sees the problem before sending; the daemon remains the authority. */
export const MAX_NOTE_LENGTH = 1024;
const FORBIDDEN_NOTE_CHARS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F‪-‮⁦-⁩]/;

export function normalizeNote(note) {
  return String(note ?? "").replace(/\r\n/g, "\n");
}

export function noteError(note) {
  if (note.length > MAX_NOTE_LENGTH) return `The note must be at most ${MAX_NOTE_LENGTH} characters (it has ${note.length})`;
  if (FORBIDDEN_NOTE_CHARS.test(note)) return "The note contains a control or bidi-override character";
  return null;
}
