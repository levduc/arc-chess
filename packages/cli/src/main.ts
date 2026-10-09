import { createInterface } from "node:readline/promises";
import { runCli } from "./cli.js";

export async function main(argv: string[]): Promise<number> {
  return runCli(argv, {
    env: process.env,
    fetch,
    out: (s) => process.stdout.write(`${s}\n`),
    err: (s) => process.stderr.write(`${s}\n`),
    // Plan 5.6 Task 3 (spec §4.3): an owner change needs a human at a real terminal -- both streams a TTY, and an
    // answer typed at `prompt`. Only this entry point reads the real streams; every other CliIo leaves these unset.
    stdinIsTTY: process.stdin.isTTY === true,
    stdoutIsTTY: process.stdout.isTTY === true,
    prompt: async (question) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return await rl.question(question);
      } finally {
        rl.close();
      }
    },
  });
}
