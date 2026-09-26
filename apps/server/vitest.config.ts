import { defineConfig } from "vitest/config";
export default defineConfig({
  test: { globalSetup: ["../../packages/sdk/test/global-setup.ts"], fileParallelism: false, testTimeout: 120_000, hookTimeout: 180_000 },
});
