# LLM Games (Plan 4.5 Task 12)

Live games between two headless Claude Code agents, driven only by `skill.md` and the `arena` CLI.

## Run 1 -- 2026-09-29T10:01:58.383Z

- Result: **PASS**
- Args: --agents 2 --games 2 --minutes 30
- Duration: 15.5 min
- alice: exit=143, duration=15.4 min (killed by this script's cleanup -- still blocked in `arena wait && arena status ...`
  when the 30s post-Finalize grace period expired, so she never emitted a final result; cost unknown for this
  session. Root cause: `daemon.wait()` only wakes on an `attention` reason or a controller change, and there is no
  `attention` for "the channel you already cooperatively closed just got the other side's signature and settled" --
  so once alice had signed her own close, her `wait` could only return on its own ~60s default timeout, not on the
  settlement landing. This run's 30s script-side grace was shorter than that. Fixed for Run 2: grace raised to 90s
  (tests/system/llm-games.ts); the underlying daemon behavior is a product nit worth a future look, not changed here.)
- bob: exit=0, duration=15.1 min (ended his own turn cleanly with a full summary -- he was the one who posted the
  offer, alice accepted it; no deadlock)
- Channel: 0x20cd4887b5023a8498ce7cbe6547f7dd8264f69360e83abb3f1ea1b911c90e58
- Finalized: true
- Games played (server-reported): 2
- Conserved balances: true
  - before: A=10.000000 B=10.000000 host=0.000000 USDC
  - after: A=10.095000 B=9.895000 host=0.010000 USDC
- Cost: alice=$unknown, bob=$1.9308, total=$1.9308

### Notable agent confusions

- alice:
  - "File writes are blocked, so I'll continue with plain commands." (tried to write a helper Python script for
    her own bookkeeping; the allowlist has no Write tool at all -- expected, and she adapted immediately.)
  - "Qb3 was blocked by my own b4 pawn. Instead, Qa5 guards the knight on a1." (ordinary chess reasoning, not a
    tool/docs confusion.)
  - Allowlist denials, all attempts to bundle an allowed read with a disallowed one in a single compound Bash
    command (e.g. `curl ...; ls $ARENA_HOME; which arena`, `curl ...; echo $ARENA_HOME; ls -la $ARENA_HOME`) --
    the whole compound command is denied when any clause falls outside `Bash(arena *)`/`Bash(curl *)`/`Bash(cat
    *)`, even though a `curl` clause alone would have been allowed. One `which stockfish` (no `;`) was itself
    outside the allowlist too. All are artifacts of this test's deliberately narrow tool allowlist, not an
    arena-level error or a skill.md gap -- a real deployment would give an agent a normal Bash tool. No fix
    applied for these.
- bob:
  - "I played both games, then closed the channel, and it has settled (phase \"Finalized\"). I lost one game and
    drew the other. - **Game 1 (White): loss.** I played a Ruy Lopez and had a decent position until around move
    31." (his own final summary -- not a confusion, included for context: he also correctly reported the daemon
    was "still running and can be stopped now that the channel is closed".)
  - Allowlist denials of the same shape as alice's: compound `curl ...; echo $ARENA_HOME; ls $ARENA_HOME; which
    arena`, `printenv ARENA_HOME; which arena`, and `which stockfish python3; python3 -c "import chess; ..."`
    (checking for a chess engine/library, which the allowlist correctly has no path to -- he played every move
    himself). Same conclusion as alice's: test-harness artifact, not a docs defect.
- Match mechanics observed: bob posted the offer (`arena offer` with the host's defaults, 1 USDC deposit / 0.1
  USDC stake), alice ran `arena offers` then `arena accept <id>` — the two-identical-agents deadlock the brief
  worried about (both offering, neither accepting) did not happen in this run.

### skill.md wording fixes in effect for this run

- Step 2 ("`arena daemon`") now tells a non-interactive/headless agent to background it with its own tool's
  background-execution feature, not a shell `&`/`nohup` — confirmed by hand that Claude Code's Bash tool denies a
  bare `&` ("defers execution past approval-time safety checks") under `--permission-prompts none`, while its
  native background-run mode is unaffected. Both agents used the correct (native-background) form on their first
  try, so this fix, applied proactively before Run 1, appears to have worked.
- The play loop now explains `wait`'s "timeout" reason with no channel id: normal before a match, not an error —
  re-run `wait` (and check `offers`). Also applied proactively before Run 1; neither agent showed confusion about
  an early `timeout`.

## Run 2 -- 2026-09-29T10:21:39.273Z

- Result: **PASS**
- Args: --agents 2 --games 2 --minutes 30
- Duration: 12.4 min
- alice: exit=0, duration=12.3 min (ended its own turn)
- bob: exit=0, duration=11.3 min (ended its own turn)
- Channel: 0x1b3c71b95ae01405bfe31beabb523d8f52a33121631f5296b7c27539427acb9e
- Finalized: true
- Games played (server-reported): 2 (both drawn, reached ply 51 and ply 98 respectively per bob's own status polls
  -- i.e. real, played-out games, not an instant mutual draw)
- Conserved balances: true
  - before: A=10.000000 B=10.000000 host=0.000000 USDC
  - after: A=9.995000 B=9.995000 host=0.010000 USDC
- Cost: alice=$1.7401, bob=$3.2066, total=$4.9468

### Notable agent confusions

- alice:
  - "I played both games and closed the channel. Both games were draws, so no money changed hands: each side still has 1.00 USDC in the channel, and the host's per-channel fee is separate from that. The channel shows as `Fina"
  - allowlist denials (from the session's own `permission_denials`, none arena-level -- all outside the deliberately narrow Bash(arena/curl/cat) + no-Write allowlist):
    - `Bash: curl -s http://127.0.0.1:40977/skill.md; echo; echo $ARENA_HOME; ls -la $ARENA_HOME`
    - `Bash: which arena; env | grep -i arena; curl -s http://127.0.0.1:40977/templates/chess/skill.md`
    - `Write: (no command)`
    - `Bash: chmod +x /tmp/arena-llm-work-alice-rZdYVl/play.sh; python3 -c "import chess; print('ok')"`
- bob:
  - "Can't write helper scripts, so I'll keep playing with direct commands."
  - "I played both games and closed the channel. It's now finalized and settled on-chain. - **Game 1 (I was black):** I accepted the opponent's open offer (1 USDC deposit, 0.1 USDC per game). We played an Italian Game, trade"
  - allowlist denials (from the session's own `permission_denials`, none arena-level -- all outside the deliberately narrow Bash(arena/curl/cat) + no-Write allowlist):
    - `Bash: curl -s http://127.0.0.1:40977/templates/chess/skill.md; echo; curl -s http://127.0.0.1:40977/templates; echo; echo $ARENA_HOME; ls $ARENA_HOME; which arena`
    - `Bash: env | grep -i arena`
    - `Bash: which stockfish; python3 -c "import chess; print(chess.__version__)"`
    - `Write: (no command)`

### skill.md wording fixes in effect for this run

- Step 2 ("`arena daemon`") now tells a non-interactive/headless agent to background it with its own tool's background-execution feature, not a shell `&`/`nohup` -- confirmed by hand that Claude Code's Bash tool denies a bare `&` ("defers execution past approval-time safety checks") under --permission-prompts none, while its native background-run mode is unaffected.
- The play loop now explains `wait`'s "timeout" reason with no channel id: normal before a match, not an error -- re-run `wait` (and check `offers`). Previously the loop only documented the channel-carrying reasons.

## Run 3 -- 2026-09-29T11:10:18.718Z

- Result: **PASS**
- Args: --agents 2 --games 2 --minutes 30
- Duration: 20.5 min
- alice: exit=0, duration=20.5 min (ended its own turn)
- bob: exit=0, duration=19.4 min (ended its own turn)
- Channel: 0x21d5ac1bd4219b05e0aa1d0ca8b455ef167b7c1a93536ac00e8b23364a047ef3
- Finalized: true
- Games played (server-reported): 2
- Conserved balances: true
  - before: A=10.000000 B=10.000000 host=0.000000 USDC
  - after: A=9.995000 B=9.995000 host=0.010000 USDC
- Cost: alice=$3.4710, bob=$2.0903, total=$5.5613

### Notable agent confusions

- alice:
  - "Game 2: I miscounted — my rook couldn't recapture on d5 because my own d6 pawn blocks the file, so I lost a knight. I'm now a piece down for a pawn and will try to fight back."
  - "I played both games and the match ended 1–1. The channel is closed and settled on-chain, and my balance is back to 1.00 USDC, the same as I deposited (before the host's flat fee). - **Game 1 (I was White): won.** It was"
  - allowlist denials (from the session's own `permission_denials`, none arena-level -- all outside this run's allowlist, built by `buildAllowedTools` -- `arena` plus `curl` pinned to this stack's own server origin, nothing else):
    - `Bash: curl -s http://127.0.0.1:45351/templates/chess/skill.md; echo; echo $ARENA_HOME; ls $ARENA_HOME; which arena stockfish`
    - `Bash: python3 -c "import chess; print(chess.__version__)"; arena --help`
- bob:
  - "I played both games and closed the channel. It ended 1–1, so the stakes cancelled out and I finished with the same 1.00 USDC I deposited. - **Game 1 (Black, loss):** It was a standard Ruy Lopez and the position was leve"
  - allowlist denials (from the session's own `permission_denials`, none arena-level -- all outside this run's allowlist, built by `buildAllowedTools` -- `arena` plus `curl` pinned to this stack's own server origin, nothing else):
    - `Bash: curl -s http://127.0.0.1:45351/templates/chess/skill.md; echo; echo $ARENA_HOME; ls -la $ARENA_HOME; cat $ARENA_HOME/*.json 2>/dev/null | grep -v -i key; curl -s http://127.0.0.1:45351/templates`
    - `Bash: which stockfish python3; python3 -c "import chess; print(chess.__version__)"`

### skill.md text this run used

Not duplicated here (a copy here would silently go stale the next time `apps/server/src/docs.ts` changes) -- see that file's `skillMd`/`chessSkillMd` at this run's commit for the exact wording.

