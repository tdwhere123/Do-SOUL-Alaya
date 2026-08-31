import { afterEach, describe, expect, it } from "vitest";
import {
  parseDefaultOnFlag,
  parseEnvPositiveInt,
  parseRecallRuntimeConfigFromEnv,
  parseSourceRefRobust,
  readRecallUnitFloat,
  resetCoreConfigForTests
} from "../../../runtime/config/index.js";

describe("parseSourceRefRobust", () => {
  it.each([
    [undefined, false],
    ["", false],
    ["   ", false],
    ["true", true],
    ["TRUE", true],
    ["1", true],
    ["false", false],
    ["0", false]
  ] as const)("parses %j as %s", (raw, expected) => {
    expect(parseSourceRefRobust(raw)).toBe(expected);
  });

  it("throws on a written invalid value", () => {
    expect(() => parseSourceRefRobust("maybe")).toThrow(
      /ALAYA_RECALL_SOURCE_REF_ROBUST must be true, false, 1, or 0/
    );
  });
});

describe("parseRecallRuntimeConfigFromEnv numbers", () => {
  it("throws when a written recall number is not finite", () => {
    expect(() => parseRecallRuntimeConfigFromEnv({
      ALAYA_RECALL_CONF_RHO_PATH: "abc"
    })).toThrow(/ALAYA_RECALL_CONF_RHO_PATH must be a finite number/);
  });

  it("keeps unset optional numbers undefined", () => {
    expect(parseRecallRuntimeConfigFromEnv({}).confRhoPath).toBeUndefined();
  });
});

describe("parseDefaultOnFlag / ALAYA_RECALL_PROJECTIONS", () => {
  it("defaults on when unset", () => {
    expect(parseRecallRuntimeConfigFromEnv({}).projectionsEnabled).toBe(true);
    expect(parseDefaultOnFlag(undefined, "ALAYA_RECALL_PROJECTIONS")).toBe(true);
  });

  it.each(["off", "0", "false", "no", "disabled"] as const)(
    "turns off for %s",
    (value) => {
      expect(parseRecallRuntimeConfigFromEnv({
        ALAYA_RECALL_PROJECTIONS: value
      }).projectionsEnabled).toBe(false);
    }
  );

  it("throws on garbage instead of treating it as on", () => {
    expect(() => parseRecallRuntimeConfigFromEnv({
      ALAYA_RECALL_PROJECTIONS: "maybe"
    })).toThrow(/ALAYA_RECALL_PROJECTIONS/);
  });
});

describe("readRecallUnitFloat", () => {
  afterEach(() => {
    resetCoreConfigForTests();
  });

  it("uses the documented fallback when the value is unset", () => {
    expect(readRecallUnitFloat("ALAYA_RECALL_CONF_RHO_PATH", 0.5)).toBe(0.5);
  });
});

describe("parseEnvPositiveInt", () => {
  it("returns undefined when unset and throws on a suffixed timeout", () => {
    expect(parseEnvPositiveInt(undefined, "ALAYA_MCP_TOOL_TIMEOUT_MS")).toBeUndefined();
    expect(() => parseEnvPositiveInt("60000ms", "ALAYA_MCP_TOOL_TIMEOUT_MS"))
      .toThrow(/ALAYA_MCP_TOOL_TIMEOUT_MS must be a positive integer/);
  });
});
