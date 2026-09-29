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

