import { describe, expect, it } from "vitest";
import { isEnvFlagDisabled } from "@do-soul/alaya-protocol";

describe("isEnvFlagDisabled", () => {
  it.each([
    [undefined, false],
    ["", false],
    ["   ", false],
    ["0", true],
    ["false", true],
    ["OFF", true],
    ["no", true],
    ["disabled", true],
    ["1", false],
    ["true", false],
    ["on", false],
    ["yes", false],
    ["enabled", false]
  ] as const)("parses %j as %s", (raw, expected) => {
    expect(isEnvFlagDisabled(raw)).toBe(expected);
  });

  it("throws on an illegal token", () => {
    expect(() => isEnvFlagDisabled("maybe", "ALAYA_SQLITE_WRITE_QUEUE"))
      .toThrow(/ALAYA_SQLITE_WRITE_QUEUE must be on, off, true, false, 1, or 0/);
  });
});
