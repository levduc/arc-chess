# Arc launch (local-key wallets): design

Date: 2026-10-23. Status: approved in conversation ("yes go ahead"). This is the written spec for Plan 6.
Parent spec: `docs/superpowers/specs/2026-09-24-agent-chess-arena-design.md`. Chain facts:
`docs/superpowers/arc-facts.md`, verified on Arc mainnet on 2026-10-19.

## 1. Goal

Launch the arena on **Arc mainnet** (chain 5042) with **local-key wallets**, guarded by the on-chain launch limits
(spec §13). Before mainnet, a full dress rehearsal runs on **Arc testnet** (5042002).

### Decisions (owner)
- **Launch on Arc** (2026-10-19).
- **No Circle at launch** (2026-10-23). Circle agent wallets become an optional wallet type in a later plan.
- **The mainnet deploy happens only after the owner's explicit "go"** at that step. The owner provides:
  - the owner address (ideally a multisig) and the fee recipient;
  - confirmation of the limits: 10 USDC per player per channel, 1,000 USDC total escrow, a fee of 0.005 USDC per
    player;
  - deploy gas.

### Success criteria
1. Every unit, contract and system suite passes on standard anvil. A designated subset also passes against Arc's
   own simulator (`arc-anvil --network arc`, from Arc Foundry), which models USDC as the gas token.
2. On Arc testnet:
   - the contracts are deployed and their source is verified;
   - two real agent daemons play a full game, close, and settle with exact balances;
   - a dispute (challenge, respond, timeout) completes on-chain;
   - one game survives a host kill over XMTP's `dev` network.
3. The mainnet deployment is pinned in the CLI. `init` against any other hub, rules or USDC address on chain 5042
   or 5042002 is refused.

## 2. Arc correctness in the daemon and CLI

All of these are keyed by a **built-in chain profile** in the CLI. They are never taken from the host:

```ts
// packages/cli/src/chains.ts
export type ChainProfile = { name: string; usdc: Address; nativeIsUsdc: boolean; minFeePerGas: bigint; feeCeilingWei: bigint };
export const CHAIN_PROFILES: Record<number, ChainProfile> = {
  5042:    { name: "Arc",         usdc: "0x3600000000000000000000000000000000000000", nativeIsUsdc: true, minFeePerGas: 20_000_000_000n, feeCeilingWei: 40_000_000_000n },
  5042002: { name: "Arc Testnet", usdc: "0x3600000000000000000000000000000000000000", nativeIsUsdc: true, minFeePerGas: 20_000_000_000n, feeCeilingWei: 40_000_000_000n },
};
```

1. **One balance.** When `nativeIsUsdc` is set:
   - `wallet` prints a single `usdc` value. The source of truth is the native balance, which has 18 decimals,
     shown with 6 decimal places and rounded down. The separate `native` line is dropped.
   - `fund` folds the gas need into `usdc.need`, converting 18 decimals to 6 and rounding up. The message asks
     for USDC only.
   - `withdrawReserve()` = (live channels × `sessionGasWei`) + 500,000 × `feeCeilingWei`, converted and rounded
     up. `withdraw --all` keeps that much, and `withdraw --amount` refuses to dip into it. *Amended 2026-10-24
     (audit-daemon I-5):* the reserve of the other unsettled channels also gates the opening paths
     (`createOffer`, `acceptOffer`, `fund()`'s top-up and deposit), and `arena fund` counts it, so a new channel can
     never spend a live channel's refill money.
2. **Gas for session-key top-ups.** Before Plan 6, the daemon hard-coded `gas: 21_000n` for these value transfers. They are
   now estimated with `estimateGas`, plus a margin of +20 % and +5,000. This is hardening: a native transfer costs 21,000 gas on Arc, as the 2026-10-24 correction to `arc-facts.md` shows. Every top-up must check its receipt status (audit-daemon I-1).
3. **Fee floor.** `SerialTxSender` gains a `minFeePerGas` option, set from the profile. Every send and replacement
   uses `maxFeePerGas` ≥ `minFeePerGas`, and `maxPriorityFeePerGas` ≤ `maxFeePerGas`. The floor is applied after
   the balance clamp. A fee is clamped up, or the send is refused when the balance cannot pay the floor; it is
   never clamped down below it (audit-daemon I-6). A `--fee-ceiling-wei` below
   the floor is refused at `init`.
4. **Session gas.** The profile's `feeCeilingWei` (40 gwei) is the default fee ceiling on Arc. On profile chains,
   `sessionGasWei` defaults to `SESSION_GAS_RESPONDS × RESPOND_GAS_BUDGET × profile.feeCeilingWei`
   = 4 × 2.1M × 40 gwei = **0.336 USDC** per channel, returned by the sweep. This replaces the
   `max(ceiling, 4 × gasPrice)` term there, which gives at least 0.672 USDC on Arc (4 × the 20 gwei floor) and 0.84 at
   the 25 gwei `eth_gasPrice` seen on 2026-10-23. Refills cover any fee spike, and
   `--session-gas-wei` still overrides the default. Profile-less chains keep today's formula.
5. **Pinned deployments.** `KNOWN_DEPLOYMENTS[5042]` and `[5042002]` hold the deployed hub, rules and USDC
   addresses, filled in after each deploy. On a chain listed there, `init` **refuses** a mismatch. Today it only
   warns, through `knownDeploymentWarnings`.

   Also, for any chain that has a profile, `init` **refuses** a USDC address that differs from `profile.usdc`.
   This holds even before a hub is pinned.
6. **Receipts.** Arc may give no receipt for a gas-consuming revert caused by the blocklist. Every receipt wait is
   already bounded. Confirm the paths: deposit, close, dispute, sweep and withdraw. A wait that times out must
   never be reported as success.

## 3. Arc-accurate testing

- Arc Foundry provides `arc-anvil`, `arc-forge` and `arc-cast`. Install a **pinned** release, record its version
  and checksum in `tools/arc-foundry.md`, and add an install script. Never run a curl-to-shell installer without
  checksum verification.
- **Arc subset** (`pnpm test:arc`), run against `arc-anvil --network arc` on a free port:
  - the contract suite;
  - the SDK and daemon tests that move money: deposit, close, dispute, sweep, top-up, withdraw;
  - the system dispute e2e.

  Assert the Arc-specific behaviours: one balance; a top-up gas limit of at least its own estimate (a plain transfer
  costs 21,000 on Arc, so the estimate is not above it; audit-daemon I-2); a transaction below the
  20 gwei floor dropped; a blocklisted payout lands in `owed`, if arc-anvil can model the blocklist; otherwise say
  so explicitly.
- The existing suites stay on standard anvil, unchanged.

## 4. Testnet dress rehearsal

- **Deployer.** `0x840d6f90dd12A713CC5F1fb6EAbBF99e0E74A7E0`. Its key is in
  `~/.config/arena-deploy/arc-testnet-deployer.json` (mode 0600); never print it or commit it. The owner funds it
  from the Circle faucet.
- **Deploy.** `Deploy.s.sol` with `ARENA_TOKEN=0x3600…0000`, the deployer as owner and as fee recipient
  (testnet only), and testnet limits: 2 USDC per player, 50 USDC total escrow.
  - Use `--with-gas-price` ≥ 20 gwei.
  - Verify the source on `explorer.testnet.arc.io`, using whichever verifier it supports (research that).
  - Commit `contracts/deployments/5042002.json` and pin it in `KNOWN_DEPLOYMENTS`.
- **Run.**
  1. A local server, configured for Arc testnet (`chainId` 5042002, `rpcUrl`/`publicRpcUrl` = the testnet RPC,
     limits, honest `audit` text, and `xmtp: {env: "dev"}`).
  2. Two agent homes funded from the deployer: about 1.5 USDC each.
  3. A scripted game with stake 0.1, then close; balances must be exact.
  4. A dispute: challenge, respond, then timeout on a second channel.
  5. A host kill mid-game, with the game finishing over XMTP `dev`.
- **Output.** A report of transaction hashes and gas used, plus a cost table (deploy, deposit, close, challenge,
  respond, sweep).

## 5. Mainnet deploy (gated)

- **Owner inputs, at that step:**
  - the owner address (multisig if available) and the fee recipient;
  - the limits and fee;
  - a funded deployer: the owner's own wallet or a fresh key, holding a few USDC on Arc;
  - an explicit "go".
- **Then:**
  - deploy with the same script, with the key in a Foundry encrypted keystore (`--account`) or a hardware wallet:
    never `--private-key` on argv, never an exported variable (mainnet-gates item 4);
  - verify the source;
  - commit `contracts/deployments/5042.json`;
  - pin `KNOWN_DEPLOYMENTS[5042]`;
  - if the owner is a multisig, complete the `Ownable2Step` acceptance.
- **Production server config template:** `docs/deploy/arc-mainnet.server.json.example` with Arc mainnet values,
  the launch limits, and `cli` and `xmtp` left for the owner to fill in once those exist.

## 6. Out of scope

Circle wallets (a later plan); hosting and domain provisioning (owner); the npm publish (owner); house bots on
mainnet (a policy decision; off by default); auditing.

## 7. Spec and gate updates

- Parent spec §12: add a "Plan 6 refinements" block for the chain profiles, one-balance accounting, the fee floor,
  top-up gas, pinned deployments, and the Arc test subset. *Done 2026-10-24 (hardening wave H2): items 60–66, with items 22.4, 29, 31 and 37 amended.*
- `mainnet-gates.md`: tick items 1, 2, 3 and 4 as they are completed, with evidence (transaction hashes, explorer
  links).
