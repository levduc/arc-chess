// Plan 5 Task 3: the board's wiring. Reads the token from the URL fragment, drives board.js's pure view model into
// the DOM, and talks to the daemon through api.js.
//
// CSP (api.ts): no inline script or style, no style="" attributes, no inline handlers -- so every node is built
// with DOM APIs and styled by class. Untrusted text (notes, errors, addresses, offer fields) only ever goes into
// textContent or an attribute value, never innerHTML.

import {
  actionState,
  baseUnitsToUsdc,
  boardView,
  canMove,
  channelBanners,
  channelChip,
  clickSquare,
  formatCountdown,
  formatDuration,
  formatUsdc,
  gameStatusText,
  isGameOver,
  isLive,
  MAX_NOTE_LENGTH,
  normalizeNote,
  noteError,
  pickDefaultChannel,
  pieceGlyph,
  piecesFromFen,
  secondsUntil,
  shortHex,
  sideToMove,
  squareAt,
  stepSquare,
  syncDeadline,
  turnText,
  usdcToBaseUnits,
} from "./board.js";
import { ApiError, backoffDelay, createClient, createCoalescer, createThrottle } from "./api.js";

const STATUS_POLL_MS = 5_000; // fallback while the event stream is down
const CHANNELS_MIN_INTERVAL_MS = 10_000;
const OFFERS_POLL_MS = 15_000;
const SSE_STALL_MS = 45_000; // the daemon pings every 15 s; three missed pings means the stream is dead
const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const PROMOTION_ORDER = ["q", "r", "b", "n"];
const PROMOTION_NAMES = { q: "Queen", r: "Rook", b: "Bishop", n: "Knight" };

const state = {
  /** @type {ReturnType<typeof createClient> | null} */
  client: null,
  channels: [],
  channelsLoaded: false,
  selectedId: null,
  status: null,
  deadline: null, // syncDeadline() of the selected channel's challenge, if any
  selected: null, // the board's selected origin square
  focus: null, // the board's roving-tabindex square
  promotion: null,
  busy: false,
  offers: [],
  offersLoaded: false,
  offersError: null,
  sseOpen: false,
  stopped: false,
};

// ------------------------------------------------------------------ DOM helpers

function $(id) {
  const node = document.getElementById(id);
  if (!node) throw new Error(`board: missing #${id}`);
  return node;
}

/** Creates an element. `text` goes through textContent; `attrs` never carries style or on* (see the CSP note). */
function h(tag, opts = {}, ...children) {
  const node = document.createElement(tag);
  if (opts.className) node.className = opts.className;
  if (opts.text !== undefined) node.textContent = opts.text;
  if (opts.testid) node.dataset.testid = opts.testid;
  for (const [k, v] of Object.entries(opts.attrs ?? {})) node.setAttribute(k, v);
  for (const c of children) if (c) node.append(c);
  return node;
}

const cls = (...names) => names.filter(Boolean).join(" ");
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : "");

// ------------------------------------------------------------------ token and boot

/** The token from `#token=…`, then removed from the address bar (and so from history). Memory only. */
function readToken() {
  const hash = location.hash.replace(/^#/, "");
  const token = new URLSearchParams(hash).get("token");
  if (location.hash) history.replaceState(null, "", location.pathname + location.search);
  return token && token.trim() ? token.trim() : null;
}

function showGate(reason) {
  $("boot").hidden = true;
  $("app").hidden = true;
  $("missing-token").hidden = false;
  $("gate-reason").textContent =
    reason === "rejected"
      ? "The daemon did not accept this link's token. It may have restarted with a new one."
      : "This page needs the private link that carries its access token.";
}

/** Any 401: stop every timer and stream, and show the missing-token view. */
function lockOut() {
  if (state.stopped) return;
  state.stopped = true;
  stopTimers();
  sseAbort?.abort();
  closeConfirm(false);
  showGate("rejected");
}

// A new link pasted into this same tab only changes the fragment (no navigation): reload to pick it up.
window.addEventListener("hashchange", () => {
  if (/(^#|&)token=/.test(location.hash)) location.reload();
});

// ------------------------------------------------------------------ toasts and confirmation

function toast(kind, title, message, timeoutMs = kind === "error" ? 0 : 6_000) {
  const box = $("toasts");
  const close = h("button", { className: "toast-close", text: "×", attrs: { type: "button", "aria-label": "Dismiss" } });
  const node = h(
    "div",
    { className: `toast toast-${kind}`, testid: "toast", attrs: { role: kind === "error" ? "alert" : "status" } },
    h("div", { className: "toast-body" }, h("strong", { text: title }), h("span", { className: "wrap-anywhere", text: message })),
    close,
  );
  const remove = () => node.remove();
  close.addEventListener("click", remove);
  if (timeoutMs > 0) setTimeout(remove, timeoutMs);
  box.append(node);
  while (box.children.length > 4) box.firstElementChild?.remove();
}

function errorText(err) {
  return err instanceof Error ? err.message : String(err);
}

let confirmResolve = null;

function closeConfirm(result) {
  const dlg = /** @type {HTMLDialogElement} */ ($("confirm-dialog"));
  const resolve = confirmResolve;
  confirmResolve = null;
  if (dlg.open) dlg.close();
  resolve?.(result);
}

/** An in-page confirmation (window.confirm is unstyled and blocks the page). Resolves true only on Confirm. */
function confirmDialog({ title, message, details = [], confirmLabel = "Confirm", danger = false }) {
  const dlg = /** @type {HTMLDialogElement} */ ($("confirm-dialog"));
  if (confirmResolve) closeConfirm(false);
  $("confirm-title").textContent = title;
  $("confirm-message").textContent = message;
  $("confirm-details").replaceChildren(
    ...details.flatMap(([k, v]) => [h("dt", { text: k }), h("dd", { className: "wrap-anywhere", text: v })]),
  );
  const ok = $("confirm-ok");
  ok.textContent = confirmLabel;
  ok.className = cls("btn", danger ? "btn-danger-solid" : "btn-primary");
  return new Promise((resolve) => {
    confirmResolve = resolve;
    dlg.showModal();
    $("confirm-cancel").focus();
  });
}

function wireConfirm() {
  const dlg = $("confirm-dialog");
  $("confirm-ok").addEventListener("click", () => closeConfirm(true));
  $("confirm-cancel").addEventListener("click", () => closeConfirm(false));
  dlg.addEventListener("cancel", (e) => {
    e.preventDefault();
    closeConfirm(false);
  });
  // A click on the backdrop lands on the dialog element itself.
  dlg.addEventListener("click", (e) => {
    if (e.target === dlg) closeConfirm(false);
  });
}

// ------------------------------------------------------------------ connection state

let lastBackgroundError = "";

function setConn(kind) {
  const labels = { connecting: "Connecting", live: "Live", polling: "Reconnecting, polling every 5 s", offline: "Daemon unreachable" };
  const node = $("conn");
  node.className = `conn conn-${kind}`;
  node.textContent = labels[kind];
}

function markReachable() {
  lastBackgroundError = "";
  if ($("conn").classList.contains("conn-offline")) setConn(state.sseOpen ? "live" : "polling");
}

/** A failed background refresh: one toast per distinct message, not one per poll. */
function backgroundError(err) {
  if (state.stopped || (err instanceof ApiError && err.status === 401)) return;
  if (err instanceof ApiError && err.status === 0) setConn("offline");
  const message = errorText(err);
  if (message === lastBackgroundError) return;
  lastBackgroundError = message;
  toast("error", "Could not refresh", message);
}

// ------------------------------------------------------------------ data refresh

const refreshStatus = createCoalescer(async () => {
  const id = state.selectedId;
  if (!id || state.stopped) return;
  const st = await state.client.status(id);
  markReachable();
  if (state.selectedId === id && st && st.channelId) applyStatus(st);
}, backgroundError);

const loadChannels = createCoalescer(async () => {
  if (state.stopped) return;
  const list = await state.client.channels();
  markReachable();
  state.channels = Array.isArray(list) ? list : [];
  state.channelsLoaded = true;
  const current = state.channels.find((c) => c.channelId === state.selectedId && !c.degraded);
  if (!current) {
    const id = pickDefaultChannel(state.channels);
    if (id) selectChannel(id);
    else {
      state.selectedId = null;
      state.status = null;
    }
  } else if (!state.status) {
    applyStatus(current);
  }
  renderAll();
}, backgroundError);

const channelsThrottle = createThrottle(() => void loadChannels(), CHANNELS_MIN_INTERVAL_MS);

const refreshOffers = createCoalescer(async () => {
  if (state.stopped) return;
  try {
    const list = await state.client.offers();
    state.offers = Array.isArray(list) ? list : [];
    state.offersError = null;
    markReachable();
  } catch (err) {
    if (err instanceof ApiError && (err.status === 401 || err.status === 0)) throw err;
    state.offersError = errorText(err);
  } finally {
    state.offersLoaded = true;
    renderLobby();
  }
}, backgroundError);

function applyStatus(st) {
  const prev = state.status;
  const moved = !prev || prev.channelId !== st.channelId || prev.fen !== st.fen;
  state.status = st;
  state.deadline = syncDeadline(prev?.channelId === st.channelId ? state.deadline : null, st.challenge, Date.now());
  const i = state.channels.findIndex((c) => c.channelId === st.channelId);
  if (i >= 0) state.channels[i] = st;
  if (moved) state.selected = null;
  if (state.promotion && (moved || !canMove(st))) closePromotion();
  renderAll();
}

function selectChannel(id) {
  if (state.selectedId === id) return;
  state.selectedId = id;
  state.selected = null;
  state.focus = null;
  closePromotion();
  state.status = state.channels.find((c) => c.channelId === id && !c.degraded) ?? null;
  state.deadline = syncDeadline(null, state.status?.challenge, Date.now());
  /** @type {HTMLTextAreaElement} */ ($("hand-back-note")).value = "";
  /** @type {HTMLInputElement} */ ($("offer-draw-toggle")).checked = false;
  renderAll();
  void refreshStatus();
}

// ------------------------------------------------------------------ live updates

let sseAbort = null;
let pollTimer = null;
const timers = [];

function startPolling() {
  if (pollTimer || state.stopped) return;
  pollTimer = setInterval(() => {
    void refreshStatus();
    channelsThrottle.request();
  }, STATUS_POLL_MS);
}

function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

function stopTimers() {
  stopPolling();
  channelsThrottle.cancel();
  for (const t of timers) clearInterval(t);
  timers.length = 0;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Keeps GET /events open, reconnecting with back-off; polls /status every 5 s whenever it is down. */
async function runEvents() {
  let attempt = 0;
  while (!state.stopped) {
    const ctrl = new AbortController();
    sseAbort = ctrl;
    let stall = null;
    let openedAt = 0;
    const kick = () => {
      if (stall) clearTimeout(stall);
      stall = setTimeout(() => ctrl.abort(), SSE_STALL_MS);
    };
    try {
      kick();
      await state.client.events({
        signal: ctrl.signal,
        onOpen: () => {
          openedAt = Date.now();
          state.sseOpen = true;
          setConn("live");
          stopPolling();
          // Anything that changed while the stream was down has no event of its own.
          void refreshStatus();
          channelsThrottle.request();
        },
        onActivity: kick,
        onEvent: (ev) => {
          if (ev.event !== "change") return;
          void refreshStatus();
          channelsThrottle.request();
        },
      });
    } catch {
      // Refused (429, 5xx) or broken: fall through to polling and a delayed reconnect.
    } finally {
      if (stall) clearTimeout(stall);
    }
    state.sseOpen = false;
    if (state.stopped) return;
    if (openedAt && Date.now() - openedAt > 30_000) attempt = 0;
    if (!$("conn").classList.contains("conn-offline")) setConn("polling");
    startPolling();
    await sleep(backoffDelay(attempt++));
  }
}

// ------------------------------------------------------------------ actions

/** Runs one user action: optional confirmation, one at a time, the returned status applied, errors toasted. */
async function runAction(label, fn, { confirm, onSuccess } = {}) {
  if (state.busy || state.stopped) return;
  if (confirm && !(await confirmDialog(confirm))) return;
  state.busy = true;
  state.selected = null;
  renderAll();
  try {
    const result = await fn();
    if (result && typeof result === "object" && result.channelId && result.channelId === state.selectedId) applyStatus(result);
    onSuccess?.(result);
    channelsThrottle.now();
  } catch (err) {
    if (!(err instanceof ApiError && err.status === 401)) toast("error", `${label} failed`, errorText(err));
    void refreshStatus();
  } finally {
    state.busy = false;
    renderAll();
  }
}

function sendMove(uci) {
  const id = state.selectedId;
  const toggle = /** @type {HTMLInputElement} */ ($("offer-draw-toggle"));
  const offerDraw = toggle.checked;
  return runAction("Move", () => state.client.move(id, uci, offerDraw), {
    onSuccess: () => {
      toggle.checked = false;
    },
  });
}

function channelAction(label, call, confirm) {
  const id = state.selectedId;
  if (!id) return;
  void runAction(label, () => call(id), confirm ? { confirm } : {});
}

function wireActions() {
  $("take-over").addEventListener("click", () =>
    channelAction("Take over", (id) => state.client.handoff(id, "human", "")),
  );
  const noteInput = /** @type {HTMLTextAreaElement} */ ($("hand-back-note"));
  noteInput.addEventListener("input", () => {
    $("note-count").textContent = `${noteInput.value.length} / ${MAX_NOTE_LENGTH}`;
  });
  $("hand-back-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const note = normalizeNote(noteInput.value);
    const problem = noteError(note);
    if (problem) {
      toast("error", "Hand back failed", problem);
      return;
    }
    const id = state.selectedId;
    if (!id) return;
    void runAction("Hand back", () => state.client.handoff(id, "agent", note), {
      onSuccess: () => {
        noteInput.value = "";
        $("note-count").textContent = `0 / ${MAX_NOTE_LENGTH}`;
      },
    });
  });
  $("btn-resign").addEventListener("click", () =>
    channelAction("Resign", (id) => state.client.resign(id), {
      title: "Resign this game?",
      message: "You lose this game and its stake. The channel stays open for a next game or a close.",
      confirmLabel: "Resign",
      danger: true,
    }),
  );
  $("btn-accept-draw").addEventListener("click", () => channelAction("Accept draw", (id) => state.client.acceptDraw(id)));
  $("btn-next-game").addEventListener("click", () => channelAction("Next game", (id) => state.client.nextGame(id)));
  $("btn-close").addEventListener("click", () =>
    channelAction("Close", (id) => state.client.close(id), {
      title: "Close this channel?",
      message:
        "This signs a close for the final balances. Once your opponent signs too, the channel settles on-chain and no more games can be played in it.",
      details: state.status ? [["You receive", `${formatUsdc(state.status.balances.me)} USDC`]] : [],
      confirmLabel: "Close channel",
      danger: true,
    }),
  );
  $("btn-challenge").addEventListener("click", () =>
    channelAction("Challenge", (id) => state.client.challenge(id), {
      title: "Challenge on-chain?",
      message:
        "This registers the latest state on-chain and forces your opponent to answer before the challenge deadline. It costs gas and starts a cooldown.",
      confirmLabel: "Challenge",
    }),
  );
  $("channels-refresh").addEventListener("click", () => {
    channelsThrottle.now();
    void refreshStatus();
  });
  $("lobby-refresh").addEventListener("click", () => void refreshOffers());
  $("create-offer-form").addEventListener("submit", (e) => {
    e.preventDefault();
    void createOffer();
  });
}

async function createOffer() {
  const depositInput = /** @type {HTMLInputElement} */ ($("offer-deposit"));
  const stakeInput = /** @type {HTMLInputElement} */ ($("offer-stake"));
  const error = $("offer-error");
  let deposit;
  let stake;
  try {
    deposit = usdcToBaseUnits(depositInput.value);
    stake = usdcToBaseUnits(stakeInput.value);
  } catch (err) {
    error.textContent = errorText(err);
    return;
  }
  if (BigInt(stake) <= 0n) {
    error.textContent = "The stake per game must be more than 0.";
    return;
  }
  if (BigInt(deposit) < BigInt(stake)) {
    error.textContent = "The deposit must be at least the stake per game.";
    return;
  }
  error.textContent = "";
  await runAction("Post offer", () => state.client.createOffer(deposit, stake), {
    confirm: {
      title: "Post this offer?",
      message:
        "Anyone in the lobby can accept it. When someone does, your deposit is committed to a new channel and stays locked until that channel settles.",
      details: [
        ["Deposit", `${baseUnitsToUsdc(deposit)} USDC`],
        ["Stake per game", `${baseUnitsToUsdc(stake)} USDC`],
        ["Challenge window", "your daemon's default"],
      ],
      confirmLabel: "Post offer",
    },
    onSuccess: (r) => {
      toast("info", "Offer posted", `Offer ${shortHex(r?.offerId)} is in the lobby.`);
      /** @type {HTMLFormElement} */ ($("create-offer-form")).reset();
      void refreshOffers();
    },
  });
}

function acceptOffer(o) {
  const offer = o.offer ?? {};
  void runAction("Accept offer", () => state.client.acceptOffer(o.offerId), {
    confirm: {
      title: "Accept this offer?",
      message: "Accepting commits your deposit to a new channel against this player. It stays locked until the channel settles.",
      details: [
        ["Deposit", `${baseUnitsToUsdc(offer.deposit)} USDC`],
        ["Stake per game", `${baseUnitsToUsdc(offer.stakePerGame)} USDC`],
        ["Challenge window", formatDuration(offer.challengeTimeout)],
        ["Opponent", String(offer.player ?? "unknown")],
      ],
      confirmLabel: "Accept and fund",
    },
    onSuccess: () => {
      toast("info", "Offer accepted", "The channel appears in the list; it opens once both deposits are in.");
      void refreshOffers();
    },
  });
}

// ------------------------------------------------------------------ the board

const squares = new Map(); // square -> { cell, piece, rank, file }
let builtFor = null;

function buildBoard(orientation) {
  const rows = [];
  for (let r = 0; r < 8; r++) {
    const row = h("div", { className: "board-row", attrs: { role: "row" } });
    for (let c = 0; c < 8; c++) {
      const sq = squareAt(r * 8 + c, orientation);
      let entry = squares.get(sq);
      if (!entry) {
        const cell = h("div", { className: "sq", testid: `square-${sq}`, attrs: { role: "gridcell", tabindex: "-1" } });
        cell.dataset.square = sq;
        const piece = h("span", { className: "piece", attrs: { "aria-hidden": "true" } });
        const rank = h("span", { className: "coord coord-rank", attrs: { "aria-hidden": "true" } });
        const file = h("span", { className: "coord coord-file", attrs: { "aria-hidden": "true" } });
        cell.append(piece, rank, file);
        entry = { cell, piece, rank, file };
        squares.set(sq, entry);
      }
      row.append(entry.cell);
    }
    rows.push(row);
  }
  $("board").replaceChildren(...rows);
  builtFor = orientation;
}

function defaultFocus(st) {
  const pieces = piecesFromFen(st?.fen ?? START_FEN);
  const king = st?.color === "black" ? "k" : "K";
  return Object.keys(pieces).find((sq) => pieces[sq] === king) ?? "e4";
}

function renderBoard() {
  const st = state.status;
  const orientation = st?.orientation === "black" ? "black" : "white";
  const focusWasOnBoard = document.activeElement instanceof HTMLElement && $("board").contains(document.activeElement);
  if (builtFor !== orientation) buildBoard(orientation);
  const view = boardView(st ?? { fen: START_FEN, orientation }, { selected: state.selected });
  if (state.selected && !view.some((v) => v.selected)) state.selected = null;
  if (!state.focus || !squares.has(state.focus)) state.focus = defaultFocus(st);
  const enabled = canMove(st) && !state.busy;
  for (const v of view) {
    const e = squares.get(v.square);
    e.cell.className = cls(
      "sq",
      v.dark ? "sq-dark" : "sq-light",
      v.lastMove && "is-last",
      v.selected && "is-selected",
      v.target && (v.capture ? "is-capture" : "is-target"),
      v.check && "is-check",
      enabled && v.movable && "is-movable",
    );
    e.cell.dataset.piece = v.piece;
    e.cell.setAttribute("aria-label", v.label);
    e.cell.setAttribute("aria-selected", String(v.selected));
    e.cell.tabIndex = v.square === state.focus ? 0 : -1;
    e.piece.textContent = v.piece ? pieceGlyph(v.piece) : "";
    e.piece.className = v.piece ? cls("piece", v.piece === v.piece.toUpperCase() ? "piece-w" : "piece-b") : "piece";
    e.rank.textContent = v.rankLabel;
    e.file.textContent = v.fileLabel;
  }
  const board = $("board");
  board.classList.toggle("is-idle", !st);
  board.classList.toggle("is-playable", enabled);
  board.classList.toggle("is-busy", state.busy);
  board.setAttribute("aria-disabled", String(!enabled));
  if (focusWasOnBoard && !board.contains(document.activeElement)) squares.get(state.focus)?.cell.focus();
}

function activateSquare(sq) {
  const st = state.status;
  if (!st || state.busy || state.promotion) return;
  const r = clickSquare(st, { selected: state.selected }, sq);
  state.selected = r.selected;
  state.focus = sq;
  renderBoard();
  if (r.intent?.type === "move") void sendMove(r.intent.uci);
  else if (r.intent?.type === "promote") openPromotion(r.intent);
}

function wireBoard() {
  const board = $("board");
  board.addEventListener("click", (e) => {
    const cell = e.target instanceof Element ? e.target.closest(".sq") : null;
    if (cell instanceof HTMLElement && cell.dataset.square) activateSquare(cell.dataset.square);
  });
  board.addEventListener("keydown", (e) => {
    const cell = e.target instanceof Element ? e.target.closest(".sq") : null;
    if (!(cell instanceof HTMLElement) || !cell.dataset.square) return;
    const sq = cell.dataset.square;
    if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) {
      e.preventDefault();
      state.focus = stepSquare(sq, e.key, builtFor ?? "white");
      renderBoard();
      squares.get(state.focus)?.cell.focus();
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      activateSquare(sq);
    } else if (e.key === "Escape" && state.selected) {
      state.selected = null;
      renderBoard();
    }
  });
  $("promotion-cancel").addEventListener("click", () => {
    closePromotion();
    squares.get(state.focus)?.cell.focus();
  });
  $("promotion").addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      closePromotion();
      squares.get(state.focus)?.cell.focus();
    }
  });
}

function openPromotion(intent) {
  state.promotion = intent;
  const white = state.status?.color !== "black";
  const buttons = PROMOTION_ORDER.filter((p) => intent.choices.includes(p)).map((p) => {
    const letter = white ? p.toUpperCase() : p;
    const b = h(
      "button",
      { className: "promo-btn", testid: `promotion-${p}`, attrs: { type: "button", "aria-label": `Promote to ${PROMOTION_NAMES[p].toLowerCase()}` } },
      h("span", { className: cls("piece", white ? "piece-w" : "piece-b"), text: pieceGlyph(letter), attrs: { "aria-hidden": "true" } }),
      h("span", { className: "promo-name", text: PROMOTION_NAMES[p] }),
    );
    b.addEventListener("click", () => {
      const p0 = state.promotion;
      closePromotion();
      if (p0) void sendMove(`${p0.from}${p0.to}${p}`);
    });
    return b;
  });
  $("promotion-choices").replaceChildren(...buttons);
  $("promotion").hidden = false;
  buttons[0]?.focus();
}

function closePromotion() {
  state.promotion = null;
  $("promotion").hidden = true;
  $("promotion-choices").replaceChildren();
}

// ------------------------------------------------------------------ rendering

function renderAll() {
  if (state.stopped) return;
  renderChannels();
  renderBoardArea();
  renderPanel();
  renderLobbyBusy();
}

function channelItem(s) {
  const chip = channelChip(s);
  const selected = s.channelId === state.selectedId;
  const btn = h(
    "button",
    {
      className: cls("channel-item", selected && "is-selected"),
      testid: `channel-item-${s.channelId}`,
      attrs: { type: "button", title: s.channelId },
    },
    h(
      "span",
      { className: "ci-top" },
      h("span", { className: "ci-id mono", text: shortHex(s.channelId) }),
      h("span", { className: `chip chip-${chip.kind}`, text: chip.label }),
    ),
    h("span", {
      className: "ci-meta",
      text: `${cap(s.color)} · Game ${Number(s.gameIndex) + 1} · ${s.controller === "human" ? "Human" : "Agent"}`,
    }),
    h("span", {
      className: "ci-meta mono",
      text: `You ${formatUsdc(s.balances?.me ?? "")} · Opp ${formatUsdc(s.balances?.opponent ?? "")}`,
    }),
  );
  btn.dataset.channelId = s.channelId;
  if (selected) btn.setAttribute("aria-current", "true");
  const banners = channelBanners(s);
  if (banners.length > 0) {
    btn.append(h("span", { className: "ci-banners" }, ...banners.map((b) => h("span", { className: `mini-banner mini-${b.kind}`, text: b.text }))));
  }
  btn.addEventListener("click", () => selectChannel(s.channelId));
  return h("li", {}, btn);
}

function degradedItem(c) {
  const btn = h(
    "button",
    { className: "channel-item is-degraded", testid: `channel-item-${c.channelId}`, attrs: { type: "button", title: String(c.channelId) } },
    h(
      "span",
      { className: "ci-top" },
      h("span", { className: "ci-id mono", text: shortHex(c.channelId) }),
      h("span", { className: "chip chip-degraded", text: "Unavailable" }),
    ),
    h("span", { className: "ci-meta wrap-anywhere", text: String(c.error ?? "could not be loaded") }),
  );
  btn.disabled = true;
  return h("li", {}, btn);
}

function renderChannels() {
  const list = $("channel-list");
  const active = document.activeElement instanceof HTMLElement ? document.activeElement.dataset.channelId : undefined;
  const items = state.channels.map((c) => {
    if (c.degraded) return degradedItem(c);
    const fresh = c.channelId === state.selectedId && state.status?.channelId === c.channelId ? state.status : c;
    return channelItem(fresh);
  });
  list.replaceChildren(...items);
  if (active) /** @type {HTMLElement | null} */ (list.querySelector(`[data-channel-id="${CSS.escape(active)}"]`))?.focus();
  $("channels-empty").hidden = !state.channelsLoaded || state.channels.length > 0;
  const lobbyError = state.channels.find((c) => !c.degraded && c.lobbyError)?.lobbyError ?? null;
  for (const id of ["lobby-error-banner", "lobby-error"]) {
    const banner = $(id);
    banner.hidden = !lobbyError;
    banner.textContent = lobbyError ? `Lobby unavailable until the daemon restarts: ${lobbyError}` : "";
  }
}

function setPlayerRow(rowId, nameId, balanceId, name, balance, toMove) {
  $(nameId).textContent = name;
  $(balanceId).textContent = balance;
  $(rowId).classList.toggle("is-to-move", toMove);
}

function renderBoardArea() {
  const st = state.status;
  $("board-empty").hidden = !!st || !state.channelsLoaded;
  $("must-move-banner").hidden = !st?.challenge?.mustMove;
  $("board-title").textContent = st ? turnText(st) : state.channelsLoaded ? "No channel selected" : "Loading";
  const chan = $("board-channel");
  chan.textContent = st ? shortHex(st.channelId) : "";
  chan.title = st ? st.channelId : "";
  if (st) {
    const oppColor = st.color === "white" ? "black" : "white";
    const playing = isLive(st) && !isGameOver(st);
    const toMove = sideToMove(st.fen);
    setPlayerRow("opp-row", "opp-name", "opp-balance", `Opponent (${oppColor})`, `${formatUsdc(st.balances.opponent)} USDC`, playing && toMove === oppColor);
    setPlayerRow("me-row", "me-name", "me-balance", `You (${st.color})`, `${formatUsdc(st.balances.me)} USDC`, playing && toMove === st.color);
  } else {
    setPlayerRow("opp-row", "opp-name", "opp-balance", "Opponent", "", false);
    setPlayerRow("me-row", "me-name", "me-balance", "You", "", false);
  }
  let hint = "";
  if (st && canMove(st)) hint = "Click a piece, then a highlighted square. Keyboard: arrow keys to move around, Enter to pick.";
  else if (st && st.myTurn && isLive(st) && st.controller !== "human") hint = "The agent is choosing this move. Take over to play it yourself.";
  $("board-hint").textContent = hint;
  renderBoard();
}

function renderPanel() {
  const st = state.status;
  const a = st ? actionState(st) : null;
  const human = st?.controller === "human";

  const badge = $("controller-badge");
  badge.textContent = st ? (human ? "Human" : "Agent") : "—";
  badge.className = cls("badge", st && (human ? "badge-human" : "badge-agent"));
  $("controller-hint").textContent = !st
    ? ""
    : human
      ? "You control this seat. The agent will not move until you hand it back."
      : "Your agent is playing this seat. Take over to play it yourself.";

  const takeOver = /** @type {HTMLButtonElement} */ ($("take-over"));
  takeOver.hidden = !a?.takeOver;
  takeOver.disabled = !a?.takeOver || state.busy;
  const handBackForm = $("hand-back-form");
  handBackForm.hidden = !a?.handBack;
  /** @type {HTMLButtonElement} */ ($("hand-back")).disabled = !a?.handBack || state.busy;
  /** @type {HTMLTextAreaElement} */ ($("hand-back-note")).disabled = !a?.handBack || state.busy;

  const note = st?.handoff?.note ?? st?.note ?? "";
  $("handoff-note").textContent = note;
  const since = st?.handoff?.since ? new Date(st.handoff.since) : null;
  $("handoff-since").textContent = since && !Number.isNaN(since.getTime()) ? `Handed to the ${st.handoff.controller} ${since.toLocaleString()}` : "";

  const ch = st?.challenge ?? null;
  $("challenge-box").hidden = !ch;
  if (ch) {
    $("challenge-meta").textContent = `${ch.challenger === "me" ? "You challenged" : "Your opponent challenged"}. ${
      ch.mustMove ? "You must move before the deadline." : "Waiting for the other side to answer."
    }`;
    tickCountdown();
  }

  $("fact-game").textContent = st ? `${Number(st.gameIndex) + 1} (index ${st.gameIndex})` : "—";
  $("fact-status").textContent = st ? gameStatusText(st) : "—";
  $("fact-color").textContent = st ? cap(st.color) : "—";
  $("fact-me").textContent = st ? `${formatUsdc(st.balances.me)} USDC` : "—";
  $("fact-opp").textContent = st ? `${formatUsdc(st.balances.opponent)} USDC` : "—";
  $("fact-phase").textContent = st ? st.phase : "—";

  const setBtn = (id, enabled) => {
    /** @type {HTMLButtonElement | HTMLInputElement} */ ($(id)).disabled = !enabled || state.busy;
  };
  setBtn("offer-draw-toggle", a?.offerDraw);
  setBtn("btn-resign", a?.resign);
  setBtn("btn-accept-draw", a?.acceptDraw);
  setBtn("btn-next-game", a?.nextGame);
  setBtn("btn-close", a?.close);
  setBtn("btn-challenge", a?.challenge);
  const toggle = /** @type {HTMLInputElement} */ ($("offer-draw-toggle"));
  if (!a?.offerDraw) toggle.checked = false;

  let hint = "";
  if (st && !human && isLive(st)) hint = "Take over to use these controls.";
  else if (st && human && (st.cooldown?.meSeconds ?? 0) > 0) hint = `Challenge available again in ${formatDuration(st.cooldown.meSeconds)}.`;
  $("actions-hint").textContent = hint;

  const lastError = st?.lastError ?? null;
  $("last-error-box").hidden = !lastError;
  $("last-error").textContent = lastError ?? "";

  $("suggested").replaceChildren(...(st?.suggestedActions ?? []).map((s) => h("li", {}, h("code", { text: s }))));
}

function tickCountdown() {
  if (!state.status?.challenge || !state.deadline) return;
  const left = secondsUntil(state.deadline.endsAt, Date.now());
  const node = $("countdown");
  node.textContent = formatCountdown(left);
  node.classList.toggle("is-urgent", left <= 60);
}

function offerCell(label, value, extra) {
  return h(
    "span",
    { className: cls("offer-cell", extra) },
    h("span", { className: "offer-label", text: label }),
    h("span", { className: "offer-value wrap-anywhere", text: value }),
  );
}

function offerRow(o) {
  const offer = o.offer ?? {};
  const id = String(o.offerId);
  const row = h(
    "li",
    { className: cls("offer-row", o.mine && "is-mine"), testid: `lobby-offer-${id}`, attrs: { title: id } },
    offerCell("Deposit", `${baseUnitsToUsdc(offer.deposit)} USDC`),
    offerCell("Stake / game", `${baseUnitsToUsdc(offer.stakePerGame)} USDC`),
    offerCell("Challenge window", formatDuration(offer.challengeTimeout)),
    offerCell("Player", o.mine ? "You" : shortHex(offer.player), "mono"),
  );
  const btn = h("button", {
    className: cls("btn btn-small", o.mine ? "btn-ghost" : "btn-primary"),
    text: o.mine ? "Yours" : "Accept",
    testid: `accept-offer-${id}`,
    attrs: { type: "button", "aria-label": o.mine ? "Your own offer" : `Accept offer from ${String(offer.player ?? "unknown")}` },
  });
  btn.disabled = !!o.mine || state.busy;
  btn.addEventListener("click", () => acceptOffer(o));
  row.append(btn);
  return row;
}

function renderLobby() {
  if (state.stopped) return;
  const mineLast = [...state.offers].sort((x, y) => Number(!!x.mine) - Number(!!y.mine));
  $("offer-list").replaceChildren(...mineLast.map(offerRow));
  const empty = $("offers-empty");
  empty.hidden = !state.offersLoaded || state.offers.length > 0;
  empty.textContent = state.offersError ? `Could not load offers: ${state.offersError}` : "No open offers right now.";
}

/** Keeps the lobby's buttons in step with `busy` without rebuilding the list on every status render. */
function renderLobbyBusy() {
  for (const b of $("offer-list").querySelectorAll("button")) {
    const row = b.closest(".offer-row");
    /** @type {HTMLButtonElement} */ (b).disabled = state.busy || !!row?.classList.contains("is-mine");
  }
  const submit = $("create-offer-form").querySelector("button[type=submit]");
  if (submit) /** @type {HTMLButtonElement} */ (submit).disabled = state.busy;
}

// ------------------------------------------------------------------ start

function start(token) {
  state.client = createClient(token, { onUnauthorized: lockOut });
  $("boot").hidden = true;
  $("app").hidden = false;
  wireConfirm();
  wireBoard();
  wireActions();
  renderAll();
  setConn("connecting");
  channelsThrottle.now();
  void refreshOffers();
  timers.push(setInterval(tickCountdown, 1_000));
  timers.push(setInterval(() => void refreshOffers(), OFFERS_POLL_MS));
  window.addEventListener("pagehide", () => sseAbort?.abort());
  void runEvents();
}

const token = readToken();
if (token) start(token);
else showGate("missing");
