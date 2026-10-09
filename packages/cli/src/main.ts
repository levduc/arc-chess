import { runCli } from "./cli.js";

export async function main(argv: string[]): Promise<number> {
  return runCli(argv, {
    env: process.env,
    fetch,
    out: (s) => process.stdout.write(`${s}\n`),
    err: (s) => process.stderr.write(`${s}\n`),
  });
}
