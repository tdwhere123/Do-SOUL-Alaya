import { afterEach, describe, expect, it } from "vitest";
import {
  isEnvFlagDisabled,
  parseDefaultOnFlag,
  parseEnvBoolean,
  parseEnvOptionalNumber,
  parseEnvPositiveInt,
  parseRecallRuntimeConfigFromEnv,
  parseSourceRefRobust,
  readRecallUnitFloat,
  resetCoreConfigForTests
} from "../../../runtime/config/index.js";
import {
  isEnvFlagDisabled as isStorageEnvFlagDisabled,
  parseEnvPositiveInt as parseGatewayPositiveInt
} from "@do-soul/alaya-protocol";

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

describe("parseEnvOptionalNumber", () => {
  it("throws when a written number is not finite", () => {
    expect(() => parseEnvOptionalNumber("abc", "ALAYA_EMBEDDING_WORKSPACE_SCAN_CAP"))
      .toThrow(/ALAYA_EMBEDDING_WORKSPACE_SCAN_CAP must be a finite number/);
  });

  it("keeps unset optional numbers undefined", () => {
    expect(parseEnvOptionalNumber(undefined, "ALAYA_EMBEDDING_WORKSPACE_SCAN_CAP"))
      .toBeUndefined();
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
    expect(readRecallUnitFloat("ALAYA_RECALL_UNKNOWN", 0.5)).toBe(0.5);
  });
});

describe("parseEnvPositiveInt", () => {
  it("returns undefined when unset and throws on a suffixed timeout", () => {
    expect(parseEnvPositiveInt(undefined, "ALAYA_MCP_TOOL_TIMEOUT_MS")).toBeUndefined();
    expect(() => parseEnvPositiveInt("60000ms", "ALAYA_MCP_TOOL_TIMEOUT_MS"))
      .toThrow(/ALAYA_MCP_TOOL_TIMEOUT_MS must be a positive integer/);
  });
});

describe("env-value primitives stay consistent across former modules", () => {
  it.each(["1", "true", "TRUE", " 1 "] as const)("boolean synonyms parse %j", (raw) => {
    expect(parseEnvBoolean(raw, "FLAG")).toBe(true);
  });

  it.each(["0", "false", "FALSE", " 0 "] as const)("boolean off-synonyms parse %j", (raw) => {
    expect(parseEnvBoolean(raw, "FLAG")).toBe(false);
  });

  it("rejects illegal boolean tokens", () => {
    expect(() => parseEnvBoolean("maybe", "FLAG")).toThrow(/FLAG must be true, false, 1, or 0/);
  });

  it.each(["0", "false", "off", "no", "disabled"] as const)(
    "disable tokens match across core and storage for %s",
    (raw) => {
      expect(isEnvFlagDisabled(raw, "FLAG")).toBe(true);
      expect(isStorageEnvFlagDisabled(raw, "FLAG")).toBe(true);
      expect(parseDefaultOnFlag(raw, "FLAG")).toBe(false);
    }
  );

  it.each(["1", "true", "on", "yes", "enabled"] as const)(
    "enable tokens match across core and storage for %s",
    (raw) => {
      expect(isEnvFlagDisabled(raw, "FLAG")).toBe(false);
      expect(isStorageEnvFlagDisabled(raw, "FLAG")).toBe(false);
      expect(parseDefaultOnFlag(raw, "FLAG")).toBe(true);
    }
  );

  it("rejects illegal flag tokens in both core and storage", () => {
    expect(() => isEnvFlagDisabled("maybe", "FLAG")).toThrow(/FLAG must be on, off, true, false, 1, or 0/);
    expect(() => isStorageEnvFlagDisabled("maybe", "FLAG"))
      .toThrow(/FLAG must be on, off, true, false, 1, or 0/);
  });

  it("parses the same positive integers in core and engine-gateway", () => {
    expect(parseEnvPositiveInt("30", "KEY")).toBe(30);
    expect(parseGatewayPositiveInt("30", "KEY")).toBe(30);
    expect(parseEnvPositiveInt(undefined, "KEY")).toBeUndefined();
    expect(parseGatewayPositiveInt(undefined, "KEY")).toBeUndefined();
    expect(() => parseEnvPositiveInt("30ms", "KEY")).toThrow(/KEY must be a positive integer/);
    expect(() => parseGatewayPositiveInt("30ms", "KEY")).toThrow(/KEY must be a positive integer/);
  });
});
