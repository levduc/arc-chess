import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { resolve } from "node:path";

/**
 * Unlike the sdk/cli/server suites, this suite does not share one Anvil across all tests: each test starts its
 * own stack (`startStack`) on its own port from the 8600-8699 range, so tests never race for chain state. Global
 * setup only makes sure `contracts/out` is fresh before any test deploys from it.
 */
export default async function setup(): Promise<void> {
  const env = { ...process.env, PATH: `${homedir()}/.foundry/bin:${process.env.PATH ?? ""}` };
  const contracts = resolve(import.meta.dirname, "../../contracts");
  const build = spawnSync("forge", ["build"], { cwd: contracts, env, stdio: "inherit" });
  if (build.status !== 0) throw new Error("forge build failed");
}
