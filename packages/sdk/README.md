# @arena/sdk

Protocol library for the Agent Chess Arena (spec: `docs/superpowers/specs/2026-09-24-agent-chess-arena-design.md`).

- `encoding` / `constants` — packed board, meta and move encodings (identical to `contracts/README.md`).
- `chess` — `successor(prev, move, params)`: a chess.js-backed mirror of `ChessRules.successor`, checked for
  parity against the deployed contract on every test run.
- `eip712` — `hashState`, `hashClose`, `signState`, `signClose` (domain `AgentArena`/`1`).
- `abiCodec` — `encodeParams` (payload of `deposit(bytes)`), `channelId`, SignedState/Proof codecs.
- `ChannelSession` — one player's channel state machine. It enforces:
  - every incoming state equals the rules' successor, is signed by the right session key and extends the latest state;
  - a move is only accepted on a NEW_GAME checkpoint that carries both signatures;
  - it never signs two states with the same turn number, and persists before returning any signature;
  - Close is signed only for the latest state, between games, with nothing later signed (on an opening or
    checkpoint state, only when this player is the one on move) — and then signing stops.
- `HubClient` — typed ChannelHub calls through a `TxSender`; reverts surface as `HubRevertError.errorName`.
- `LocalKeyTxSender` — sends from a local key (participant wallet on Anvil, or a session key for disputes).

## Tests

    pnpm test:sdk        # from the repo root: forge build + Anvil on :8546 + all SDK tests

Regenerate ABIs after contract changes: `pnpm --filter @arena/sdk abi`.
