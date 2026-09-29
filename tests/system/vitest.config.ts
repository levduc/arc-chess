import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["./global-setup.ts"],
    // The harness spawns real OS processes (Anvil, the host server, `arena daemon`) per stack; running files in
    // parallel would multiply that load unpredictably and make port/log-timing failures harder to diagnose.
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 60_000,
    // Vitest's default ("passed-only") hides console output of passing tests. The chaos suite's seeds (fresh ones
    // included), kill plans and per-scenario timings must be visible on every run, so console output is on, but
    // filtered to the suites' own tagged lines (the harness's child-process chatter stays out).
    silent: false,
    // Pinned: outside a TTY (CI, agents) vitest otherwise picks its "minimal" reporter, which hides passing tests'
    // output regardless of `silent`.
    reporters: ["default"],
    onConsoleLog: (log) => /^\[(chaos|faulty-rpc|dispute|adversarial|load)/.test(log),
  },
});
