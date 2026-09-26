import { randomBytes } from "node:crypto";
import { keccak256, toHex, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { channelId, initialState, signState } from "@arena/sdk";
import type { ArenaDomain, Params, SignedState, State } from "@arena/sdk";
import type { ServerConfig } from "../../src/config.js";

/** A channel with fresh random participants and two fresh session keys (`kA` signs for `signers[0]`, `kB` for
 *  `signers[1]`), plus its `channelId` and the EIP-712 `domain` states over it are signed with. Shared by relay
 *  tests (Task 5) and daemon/CLI-facing server tests (Task 6). */
export type ChannelFixture = {
  params: Params;
  id: Hex;
  domain: ArenaDomain;
  kA: Hex;
  kB: Hex;
};

export function makeChannelFixture(cfg: ServerConfig): ChannelFixture {
  const kA = generatePrivateKey();
  const kB = generatePrivateKey();
  const params: Params = {
    participants: [
      privateKeyToAccount(generatePrivateKey()).address,
      privateKeyToAccount(generatePrivateKey()).address,
    ],
    signers: [privateKeyToAccount(kA).address, privateKeyToAccount(kB).address],
    rules: cfg.rules,
    feeRecipient: "0x00000000000000000000000000000000000000fe" as Address,
    feePerPlayer: 5_000n,
    deposit: 1_000_000n,
    stakePerGame: 100_000n,
    challengeTimeout: 600n,
    fundingDeadline: 2_000_000_000n,
    salt: keccak256(toHex(`fixture-${randomBytes(16).toString("hex")}`)),
  };
  const id = channelId(cfg.chainId, cfg.hub, params);
  const domain: ArenaDomain = { chainId: cfg.chainId, hub: cfg.hub };
  return { params, id, domain, kA, kB };
}

/** A `State` at `turnNum`, otherwise the channel's opening state -- the relay does not check game rules, only the
 *  sender's signature, so tests don't need real move history to exercise it. */
export function rawStateAt(fx: ChannelFixture, turnNum: bigint): State {
  return { ...initialState(fx.id, fx.params), turnNum };
}

/** Signs `state` as signer `idx` (`sigA` for 0, `sigB` for 1); the other signature is left absent (`"0x"`), as a
 *  real sender-forwarded message would carry only its own signature (spec §12 R4). */
export async function signStateAs(fx: ChannelFixture, state: State, idx: 0 | 1): Promise<SignedState> {
  const sig = await signState(idx === 0 ? fx.kA : fx.kB, state, fx.domain);
  return idx === 0 ? { state, sigA: sig, sigB: "0x" } : { state, sigA: "0x", sigB: sig };
}
