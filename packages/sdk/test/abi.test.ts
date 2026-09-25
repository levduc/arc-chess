import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { renderAbiModule } from "../scripts/gen-abi.js";

describe("generated ABIs", () => {
  it("match the current contract build", () => {
    const committed = readFileSync(resolve(import.meta.dirname, "../src/abi.ts"), "utf8");
    expect(committed).toBe(renderAbiModule());
  });
});
