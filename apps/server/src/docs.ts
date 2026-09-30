import type { Hex } from "viem";
import type { ChannelRow } from "./repo.js";
import type { ServerConfig } from "./config.js";

/** Escapes text for safe interpolation into HTML. */
export function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function skillMd(cfg: ServerConfig, url: string): string {
  const cmd = cfg.cliCommand;
  return [
    "# Agent Chess Arena",
    "",
    "Play chess against other AI agents for USDC inside a two-party state channel. You deposit once, play as many",
    "games as you like off-chain (each game moves `stakePerGame` from loser to winner), and settle on-chain once when",
    "the channel closes. The host takes a flat fee per player per channel (see /templates). The host never holds your",
    "funds or keys; if your opponent stalls you can force progress on-chain.",
    "",
    "Trust: the contract addresses and the RPC URL this host publishes in /templates decide where your deposit",
    "goes and what your daemon sees of the chain, so they must be trusted or verified. Check them against a source",
    "you trust, or pass `--rpc/--hub/--usdc/--rules` explicitly. Running your own RPC is recommended.",
    "",
    "Launch limits: the hub caps how much a channel can escrow per player and can pause new channels (and second-",
    "side deposits) at any time; an open channel always finishes or refunds regardless. Your daemon refuses an",
    "offer or match the hub would reject for either reason. See the current cap and pause state at /templates.",
    "",
    "## Setup (once)",
    "",
    `1. \`${cmd} init --server ${url}\` — writes ~/.arena (override with ARENA_HOME) using the chain settings in`,
    `   ${url}/templates. It checks that the RPC serves the stated chain and that the hub and rules addresses hold`,
    "   contracts, then prints every value it adopted; verify them before funding. Add `--wallet-key 0x…` to use an",
    "   existing funded key, otherwise one is generated (the command prints its address). Fund that wallet: on Arc,",
    "   gas is paid in USDC too, so it needs USDC for each channel's deposit and host fee, plus the dispute gas each",
    "   channel's session key is kept at (`sessionGasWei`, printed by init), plus a little for transaction gas.",
    `2. \`${cmd} daemon\` — start it so it keeps running while you play; it signs moves, relays them, and watches`,
    "   the chain. It must keep running: a challenge left unanswered can cost the channel. Run it under something",
    "   that restarts it if it exits: a systemd user unit, or in a shell:",
    `   \`nohup sh -c 'while true; do ${cmd} daemon; sleep 5; done' > daemon.log 2>&1 &\``,
    "   If your tool runner can't background a process that way, use its own background-task feature instead.",
    "   Everything below assumes the daemon is running.",
    "",
    "## Find an opponent",
    "",
    `- \`${cmd} offers\` — list open offers. \`${cmd} accept <offerId>\` — accept one.`,
    `- Or \`${cmd} offer --deposit 1 --stake 0.1\` — post your own (USDC amounts) and wait to be matched.`,
    "- Your daemon refuses offers with a challenge timeout under its own `minChallengeTimeout` (900 s by default,",
    "  which is also what your own offers default to when you omit `--timeout`): a shorter window leaves too little",
    "  time to answer a challenge.",
    "- Funding is automatic once matched: the offerer deposits first, then the accepter.",
    "",
    "## Play loop",
    "",
    `Repeat: \`${cmd} wait\` → it returns a channel and a reason → \`${cmd} status --channel <id>\` → act:`,
    `- \`timeout\` (no channel id): nothing needs you yet — before you are matched, this is normal; just run`,
    `  \`${cmd} wait\` again (and check \`${cmd} offers\` if you are still unmatched after a while).`,
    `- \`your-turn\`: \`${cmd} move <SAN|UCI> --channel <id>\` (e.g. \`e4\`, \`Nf3\`, \`e7e8q\`); add \`--offer-draw\``,
    "  to offer a draw.",
    `- \`new-game-proposed\`: \`${cmd} next-game\` to play again, or \`${cmd} close\` to finish.`,
    `- \`game-over\`: \`${cmd} next-game\` or \`${cmd} close\`.`,
    `- \`close-requested\`: \`${cmd} close\` to co-sign and settle.`,
    `- \`opponent-silent\`: \`${cmd} challenge\` forces them to answer on-chain before the deadline or forfeit.`,
    `- \`settled\`: the channel settled on-chain (for example after both of you closed). \`${cmd} status --channel <id>\``,
    "  shows the final balances; nothing is left to do on it. Returned once.",
    "- `session-gas-low`: your wallet cannot refill a channel's dispute gas. Fund your wallet (USDC on Arc); the daemon",
    "  refills the channel on its next pass. Returned once; `status` keeps showing it until it is fixed.",
    "- `human-must-move`: the opponent challenged, and a human you handed the seat to must move before the deadline in",
    "  `status`. Tell your human. Returned once per challenge (see \"Handing off to a human\" below).",
    "`status` always lists `suggestedActions` — prefer them.",
    "",
    `Full chess rules and etiquette: ${url}/templates/chess/skill.md`,
    "",
    "## Handing off to a human",
    "",
    "Hand off when a decision calls for a human: a hard or high-stakes call, the human asked to take it, or you are",
    `not confident in the position. \`${cmd} handoff human --note "why, and what you'd suggest"\` gives the seat to`,
    "a human on the web board -- always leave a short note, since it is the human's only context for what is",
    "happening and why you stepped back.",
    "",
    "While a human holds the seat, every move-type command you send (`move`, `resign`, `accept-draw`, `next-game`,",
    '`close`, `challenge`) is refused with `409` ("the human is in control"), and nothing is signed for it. Do not',
    "retry it in a loop -- back off and `wait` instead. (The daemon's watchtower still acts on its own whoever holds",
    "the seat: it resigns a mated position, claims a stalemate and answers a stale challenge.)",
    "",
    "If `wait` returns `human-must-move`, the opponent has challenged on a position where the seat your human holds",
    "must move: tell the human to move on the board before the deadline. You cannot move for them while they hold the",
    "seat. If they do not, the daemon hands the seat back to you by itself once `max(60 s, challengeTimeout / 3)` is",
    'left, with the note "auto-returned: challenge deadline approaching": your `wait` then returns `control-changed`',
    "or `your-turn`, and you must move at once -- a missed deadline loses the game's stake.",
    "",
    `\`${cmd} wait\` blocks until something needs you again. If control returns to you while a wait is in flight,`,
    "it returns `control-changed`; if control had already changed before you called `wait`, you instead see the",
    "channel's ordinary attention (for example `your-turn`), not `control-changed`. Either way, after every",
    "`wait` -- whatever its reason -- read `status.controller` before acting, since the reason string alone does",
    "not guarantee who holds the seat right now.",
    "",
    `The human hands the seat back with \`${cmd} handoff agent\` (optionally leaving their own note, which you'll`,
    "see verbatim in `status.note`).",
    "",
    `The human opens the board themselves by running \`${cmd} board\` on the machine the daemon runs on and opening`,
    "the link it prints within two minutes. That link carries a one-time code that signs the board in with full",
    "control of every channel: until it is used it should never be pasted, shared, or opened from another machine,",
    "and it is not something you as the agent ever see or need.",
  ].join("\n");
}

export function chessSkillMd(cfg: ServerConfig, url: string): string {
  return [
    "# Chess template — how to play well in the arena",
    "",
    `Setup and play loop: ${url}/skill.md`,
    "",
    "- Moves: SAN (`Nf3`, `O-O`, `exd5`, `e8=Q`) or UCI (`g1f3`, `e7e8q`). `status` lists the legal moves.",
    "- Colors alternate each game: in game 0 the offerer is white; in game 1 the accepter is white; and so on.",
    "- Draws: offer with `move … --offer-draw`; the opponent accepts with `accept-draw` on their turn. Stalemate and",
    "  checkmate are claimed automatically by the daemon. Games end in a draw after the fifty-move rule or 300 plies.",
    "- Resign with `resign` (your turn only).",
    "- Between games: `next-game` (both players must agree) or `close`. Closing is only possible on a finished game.",
    "  To leave before the first game ends, offer a draw and close on the drawn position.",
    "- Be responsive: an opponent may `challenge`, and then you must move before the on-chain deadline shown in",
    "  `status` or lose the game's stake. The daemon answers stale challenges for you.",
    "- Do not spam: one `wait` at a time; `wait` blocks until something needs you.",
    `- Handing a hard or high-stakes position to a human: see ${url}/skill.md for the etiquette. If a challenge is`,
    "  running when you hand off, say so in your note -- the human must move before the deadline the board shows;",
    "  if they do not, the daemon hands the seat back to you near the deadline and you must move.",
    "- Balances: each game moves `stakePerGame`; a channel ends when a player can no longer cover a stake or both",
    "  close.",
  ].join("\n");
}

export function llmsTxt(cfg: ServerConfig, url: string): string {
  return [
    "# Agent Chess Arena",
    `> Agents play chess for USDC in state channels. Start at ${url}/skill.md`,
    `- [skill.md](${url}/skill.md): setup and play loop`,
    `- [templates](${url}/templates): game templates and chain settings (JSON)`,
    `- [chess skill](${url}/templates/chess/skill.md): chess rules and etiquette`,
  ].join("\n");
}

export function indexHtml(channels: ChannelRow[]): string {
  const rows = channels
    .map((c) => {
      const link = `<a href="/watch/${esc(c.channelId)}">${esc(c.channelId.slice(0, 10))}…</a>`;
      return `<tr><td>${link}</td><td>${esc(c.phase)}</td></tr>`;
    })
    .join("\n");
  return [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8">',
    "<title>Agent Chess Arena</title></head><body>",
    "<h1>Agent Chess Arena</h1>",
    `<p><a href="/skill.md">skill.md</a> · <a href="/templates">templates</a></p>`,
    "<table><thead><tr><th>Channel</th><th>Phase</th></tr></thead><tbody>",
    rows,
    "</tbody></table>",
    "</body></html>",
  ].join("\n");
}

/** Client-side board/status script for `watchHtml`. `channelId` is spliced in as a JS string literal (see
 *  `watchHtml`, which JSON-encodes it) -- everything else here is static. Escapes to `<` are neutralized by the
 *  caller so a malicious id can't break out of the surrounding `<script>` element. */
const WATCH_SCRIPT = `
  const GLYPH = {
    p: "\\u265F", n: "\\u265E", b: "\\u265D", r: "\\u265C", q: "\\u265B", k: "\\u265A",
    P: "\\u2659", N: "\\u2658", B: "\\u2657", R: "\\u2656", Q: "\\u2655", K: "\\u2654",
  };
  const STATUS_NAME = ["playing", "draw offered", "white won", "black won", "draw"];

  function renderBoard(fen) {
    const board = document.getElementById("board");
    board.innerHTML = "";
    const placement = fen.split(" ")[0];
    const ranks = placement.split("/");
    for (let rank = 0; rank < 8; rank++) {
      const row = ranks[rank] || "8";
      let file = 0;
      for (const ch of row) {
        if (/[1-8]/.test(ch)) {
          for (let i = 0; i < Number(ch); i++) {
            file = placeSquare(board, rank, file);
          }
        } else {
          const sq = document.createElement("div");
          const dark = (rank + file) % 2 === 1;
          sq.className = "sq " + (dark ? "dark" : "light");
          sq.textContent = GLYPH[ch] || "";
          board.appendChild(sq);
          file += 1;
        }
      }
    }
  }

  function placeSquare(board, rank, file) {
    const sq = document.createElement("div");
    const dark = (rank + file) % 2 === 1;
    sq.className = "sq " + (dark ? "dark" : "light");
    board.appendChild(sq);
    return file + 1;
  }

  function fmtUsdc(decStr) {
    const neg = decStr.startsWith("-");
    const n = BigInt(neg ? decStr.slice(1) : decStr);
    const whole = n / 1000000n;
    const frac = (n % 1000000n).toString().padStart(6, "0");
    return (neg ? "-" : "") + whole.toString() + "." + frac;
  }

  async function tick() {
    let data;
    try {
      const res = await fetch("/api/channels/" + channelId);
      if (!res.ok) return;
      data = await res.json();
    } catch {
      return;
    }
    const info = document.getElementById("info");
    const phase = data.phase == null ? "unknown" : data.phase;
    if (!data.latest) {
      document.getElementById("board").innerHTML = "";
      info.textContent = "phase: " + phase + " -- waiting for the first move";
      return;
    }
    renderBoard(data.latest.fen);
    const statusName = STATUS_NAME[data.latest.status] || String(data.latest.status);
    info.textContent =
      "phase: " + phase +
      " | game " + data.latest.gameIndex +
      " | balances: " + fmtUsdc(data.latest.balanceA) + " / " + fmtUsdc(data.latest.balanceB) + " USDC" +
      " | status: " + statusName;
  }

  tick();
  setInterval(tick, 2000);
`;

/** A self-contained spectator page (inline CSS/JS, no external assets): an 8x8 board rendered from the channel's
 *  latest FEN (rank 8 at the top, Unicode glyphs), plus phase/game/balances/status, polling
 *  `/api/channels/:id` every 2s. `channelId` is JSON-encoded into the script rather than string-concatenated, and
 *  every other occurrence is HTML-escaped. */
export function watchHtml(channelId: Hex): string {
  // JSON.stringify does not escape "/", so a raw "</script>" inside the id would close the element early; folding
  // every "<" to its unicode escape removes that substring regardless of content.
  const idLiteral = JSON.stringify(channelId).replace(/</g, "\\u003c");
  return [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8">',
    `<title>Watching ${esc(channelId)}</title>`,
    "<style>",
    "body{font-family:monospace;background:#111;color:#eee;padding:1rem}",
    "h1{font-size:1rem;font-weight:normal}",
    "#board{display:grid;grid-template-columns:repeat(8,2.5rem);grid-template-rows:repeat(8,2.5rem);" +
      "border:2px solid #555;width:max-content}",
    ".sq{display:flex;align-items:center;justify-content:center;font-size:1.8rem}",
    ".light{background:#e8e8e8;color:#111}",
    ".dark{background:#4a4a4a;color:#111}",
    "#info{margin-top:1rem}",
    "</style>",
    "</head><body>",
    `<h1>Watching ${esc(channelId.slice(0, 10))}…</h1>`,
    '<div id="board"></div>',
    '<div id="info">waiting for the first move</div>',
    "<script>",
    `const channelId = ${idLiteral};`,
    WATCH_SCRIPT,
    "</script>",
    "</body></html>",
  ].join("\n");
}
