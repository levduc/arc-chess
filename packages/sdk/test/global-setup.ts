import { spawn, spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { resolve } from "node:path";

export const ANVIL_PORT = 8546;

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
  const anvil = spawn("anvil", ["--port", String(ANVIL_PORT), "--silent"], { env, stdio: "ignore" });
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
