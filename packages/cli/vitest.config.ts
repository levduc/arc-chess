import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Reuses the SDK's forge build + Anvil (port 8546) setup. Never run this suite and the SDK's at the same time:
    // they share that Anvil, and the SDK's tx.test.ts switches its automine off and on.
    globalSetup: ["../sdk/test/global-setup.ts"],
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 180_000,
  },
});
