import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Anvil on :8546, shared with the CLI suite: never run the two at the same time (tx.test.ts switches automine).
    globalSetup: ["./test/global-setup.ts"],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 180_000,
  },
});
