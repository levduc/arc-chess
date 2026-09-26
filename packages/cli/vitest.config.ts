import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Reuses the SDK's forge build + Anvil (port 8546) setup.
    globalSetup: ["../sdk/test/global-setup.ts"],
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 180_000,
  },
});
