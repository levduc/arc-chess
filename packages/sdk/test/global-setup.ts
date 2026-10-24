import { spawn, spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { resolve } from "node:path";

/** Plan 6 Task 3: which anvil binary this spins up -- `tools/bin/arc-anvil` for `pnpm test:arc`, plain
 *  `anvil` (today's behaviour) otherwise. */
const ANVIL_BIN = process.env.ARENA_ANVIL_BIN ?? "anvil";
/** Arc Foundry's anvil needs `--network arc` to model Arc's EVM semantics (the EIP-7708 native-transfer log;
 *  a 20 gwei base-fee floor that holds at this process's default chain id, 31337, and at 5042, but decays
 *  away by chain id 5042002 -- tools/arc-foundry.md point 3 has the full table; never pass `--chain-id`
 *  through here, so this always stays at 31337) -- inferred from `ANVIL_BIN`'s basename, so a caller only
 *  has to point ARENA_ANVIL_BIN at `arc-anvil` to get both. */
const ANVIL_NETWORK_ARGS = /(?:^|\/)arc-anvil$/.test(ANVIL_BIN) ? ["--network", "arc"] : [];
/** Plan 6 Task 4: true when this run's chain is `arc-anvil --network arc` (`pnpm test:arc`), read the same way, from
 *  ARENA_ANVIL_BIN's basename. A test that needs an anvil-only cheat Arc refuses (`anvil_setNextBlockBaseFeePerGas`),
 *  or a fee sized for stock anvil's ~1 gwei market (arc-anvil's is ~25 gwei: a 20 gwei floor plus a 1 gwei tip), reads
 *  it to take its Arc variant. A worker process inherits the variable, so this agrees with the node actually spawned. */
export const ON_ARC_ANVIL = ANVIL_NETWORK_ARGS.length > 0;
/** Plan 6 Task 3: ARENA_TEST_ANVIL_PORT overrides this fixed port for `pnpm test:arc`, so it never collides
 *  with a standard-anvil run sharing this same global setup on :8546 (the SDK/CLI suites). Unset, this is
 *  exactly today's 8546. */
export const ANVIL_PORT = process.env.ARENA_TEST_ANVIL_PORT ? Number(process.env.ARENA_TEST_ANVIL_PORT) : 8546;

async function waitForRpc(url: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      });
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`anvil did not start at ${url}`);
}

export default async function setup(): Promise<() => Promise<void>> {
  const env = { ...process.env, PATH: `${homedir()}/.foundry/bin:${process.env.PATH ?? ""}` };
  const contracts = resolve(import.meta.dirname, "../../../contracts");
  const build = spawnSync("forge", ["build"], { cwd: contracts, env, stdio: "inherit" });
  if (build.status !== 0) throw new Error("forge build failed");
  const anvil = spawn(ANVIL_BIN, ["--port", String(ANVIL_PORT), ...ANVIL_NETWORK_ARGS, "--silent"], { env, stdio: "ignore" });
  try {
    await waitForRpc(`http://127.0.0.1:${ANVIL_PORT}`);
  } catch (err) {
    anvil.kill();
    throw err;
  }
  return async () => {
    anvil.kill();
  };
}
