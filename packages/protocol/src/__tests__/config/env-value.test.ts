import { describe, expect, it } from "vitest";
import {
  ENV_BOOLEAN_FALSE_TOKENS,
  ENV_BOOLEAN_TRUE_TOKENS,
  ENV_BOOLEAN_VOCABULARY_ERROR,
  isEnvFlagDisabled,
  parseDefaultOnFlag,
  parseEnvBoolean,
  parseEnvOptionalBoolean,
  parseEnvOptionalNumber,
  parseEnvPositiveInt,
  parseSourceRefRobust
} from "../../config/env-value.js";

describe("protocol env-value parsers", () => {
  it.each([
    [undefined, false],
    ["true", true],
    ["0", false],
    ["on", true],
    ["yes", true],
    ["enabled", true],
    ["off", false],
    ["no", false],
    ["disabled", false]
  ] as const)("parseEnvBoolean(%j)", (raw, expected) => {
    expect(parseEnvBoolean(raw, "FLAG")).toBe(expected);
  });

  it("rejects 2 and other non-vocabulary tokens on every public parser", () => {
    const error = new RegExp(`FLAG ${ENV_BOOLEAN_VOCABULARY_ERROR}`);
    expect(() => parseEnvBoolean("2", "FLAG")).toThrow(error);
    expect(() => parseEnvBoolean("maybe", "FLAG")).toThrow(error);
    expect(() => parseDefaultOnFlag("2", "FLAG")).toThrow(error);
    expect(() => parseEnvOptionalBoolean("2", "FLAG")).toThrow(error);
    expect(() => isEnvFlagDisabled("2", "FLAG")).toThrow(error);
    expect(() => parseSourceRefRobust("2")).toThrow(/ALAYA_RECALL_SOURCE_REF_ROBUST/);
  });

  it("accepts on/yes on every public boolean parser", () => {
    for (const token of ENV_BOOLEAN_TRUE_TOKENS) {
      expect(parseEnvBoolean(token, "FLAG")).toBe(true);
      expect(parseDefaultOnFlag(token, "FLAG")).toBe(true);
      expect(parseEnvOptionalBoolean(token, "FLAG")).toBe(true);
      expect(isEnvFlagDisabled(token, "FLAG")).toBe(false);
    }
    for (const token of ENV_BOOLEAN_FALSE_TOKENS) {
      expect(parseEnvBoolean(token, "FLAG")).toBe(false);
      expect(parseDefaultOnFlag(token, "FLAG")).toBe(false);
      expect(parseEnvOptionalBoolean(token, "FLAG")).toBe(false);
      expect(isEnvFlagDisabled(token, "FLAG")).toBe(true);
    }
  });

  it("parseSourceRefRobust rejects garbage", () => {
    expect(() => parseSourceRefRobust("maybe")).toThrow(/ALAYA_RECALL_SOURCE_REF_ROBUST/);
  });

  it("parseDefaultOnFlag defaults on when unset", () => {
    expect(parseDefaultOnFlag(undefined, "FLAG")).toBe(true);
    expect(parseDefaultOnFlag("off", "FLAG")).toBe(false);
  });

  it("parseEnvOptionalBoolean keeps unset distinct from false", () => {
    expect(parseEnvOptionalBoolean(undefined, "FLAG")).toBeUndefined();
    expect(parseEnvOptionalBoolean("", "FLAG")).toBeUndefined();
    expect(parseEnvOptionalBoolean("false", "FLAG")).toBe(false);
  });

  it("parseEnvOptionalNumber rejects non-finite values", () => {
    expect(() => parseEnvOptionalNumber("abc", "KEY")).toThrow(/KEY must be a finite number/);
  });

  it("parseEnvPositiveInt rejects suffixed integers", () => {
    expect(() => parseEnvPositiveInt("30ms", "KEY")).toThrow(/KEY must be a positive integer/);
  });

  it.each(["0", "false", "off"] as const)("isEnvFlagDisabled(%s)", (raw) => {
    expect(isEnvFlagDisabled(raw, "FLAG")).toBe(true);
  });
});
