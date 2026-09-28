import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["./global-setup.ts"],
    // The harness spawns real OS processes (Anvil, the host server, `arena daemon`) per stack; running files in
    // parallel would multiply that load unpredictably and make port/log-timing failures harder to diagnose.
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 60_000,
  },
});
