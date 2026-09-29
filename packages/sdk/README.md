# @arena/sdk

Protocol library for the Agent Chess Arena (spec: `docs/superpowers/specs/2026-09-24-agent-chess-arena-design.md`).

- `encoding` / `constants` — packed board, meta and move encodings (identical to `contracts/README.md`).
- `chess` — `successor(prev, move, params)`: a chess.js-backed mirror of `ChessRules.successor`, checked for
  parity against the deployed contract on every test run.
- `eip712` — `hashState`, `hashClose`, `signState`, `signClose` (domain `AgentArena`/`1`).
- `abiCodec` — `encodeParams` (payload of `deposit(bytes)`), `channelId`, SignedState/Proof codecs.
- `ChannelSession` — one player's channel state machine. It enforces:
  - every incoming state equals the rules' successor, is signed by the right session key and extends the latest state;
  - a move is only accepted on a NEW_GAME checkpoint that carries both signatures — or on the checkpoint this
    player proposed, since the opponent's signed move on it endorses it even if their countersignature was lost
    (spec §12 item 14, R9);
  - it never signs two states with the same turn number, and persists before returning any signature;
  - Close is signed only for the latest state, only when that state is terminal (a finished game), with no
    new-game proposal pending and nothing later signed — and then signing stops (spec §12 item 13, R8). Close on
    the opening or on a checkpoint is refused for both players: the opponent could keep the signature, challenge
    that state and let `timeout` forfeit the frozen closer.
- `HubClient` — typed ChannelHub calls through a `TxSender`; reverts surface as `HubRevertError.errorName`.
- `LocalKeyTxSender` — sends from a local key (participant wallet on Anvil, or a session key for disputes).

## Exiting a channel

- **Between games:** close on the finished game instead of proposing the next one (`signClose` on both sides,
  exchange with `receiveClose`, then submit `closeTransaction()` via `HubClient.closeCooperative`).
- **Before game 0:** the player to move plays a move with `{ offerDraw: true }`, the opponent calls
  `acceptDraw()`, and both close on the resulting DRAW state. Balances are unchanged.
- **Opponent stalls on move:** challenge the latest state with `challengeProof()` instead of closing.

## Tests

    pnpm test:sdk        # from the repo root: forge build + Anvil on :8546 + all SDK tests

Do not run `pnpm test:sdk` and `pnpm test:cli` at the same time: both suites use the one Anvil on :8546, and
`test/tx.test.ts` switches its automine off (and back on) around its stuck/dropped-transaction tests.

Regenerate ABIs after contract changes: `pnpm --filter @arena/sdk abi`.
