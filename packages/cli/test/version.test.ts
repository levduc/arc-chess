import { describe, expect, it } from "vitest";
import { cliVersion, compareSemver, selfCommand } from "../src/version.js";
import { runCli } from "../src/cli.js";

describe("version", () => {
  it("cliVersion() matches packages/cli/package.json in the dev entry", async () => {
    const pkg = JSON.parse(await (await import("node:fs/promises")).readFile(new URL("../package.json", import.meta.url), "utf8"));
    expect(cliVersion()).toBe(pkg.version);
    expect(pkg.version).toBe("0.1.0");
  });
  it("compareSemver orders x.y.z numerically and rejects anything else", () => {
    expect(compareSemver("0.1.0", "0.1.0")).toBe(0);
    expect(compareSemver("0.2.0", "0.10.0")).toBe(-1);
    expect(compareSemver("1.0.0", "0.99.99")).toBe(1);
    expect(() => compareSemver("1.0", "1.0.0")).toThrow(TypeError);
    expect(() => compareSemver("1.0.0-beta", "1.0.0")).toThrow(TypeError);
  });
  it("arena --version and arena version print the bare version", async () => {
    for (const argv of [["--version"], ["version"]]) {
      const out: string[] = [];
      const code = await runCli(argv, { env: {}, fetch, out: (s) => out.push(s), err: () => {} });
      expect(code).toBe(0);
      expect(out).toEqual([cliVersion()]);
    }
  });
  it("Plan 5.6 Task 4 (ruling 3): selfCommand() is the bare word \"arena\" under tsx (no __ARENA_CLI_PACKAGE__ define)", () => {
    expect(selfCommand()).toBe("arena");
  });
});
