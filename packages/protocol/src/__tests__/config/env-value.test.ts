import { describe, expect, it } from "vitest";
import {
  isEnvFlagDisabled,
  parseDefaultOnFlag,
  parseEnvBoolean,
  parseEnvOptionalNumber,
  parseEnvPositiveInt,
  parseSourceRefRobust
} from "../../config/env-value.js";

describe("protocol env-value parsers", () => {
  it.each([
    [undefined, false],
    ["true", true],
    ["0", false]
  ] as const)("parseEnvBoolean(%j)", (raw, expected) => {
    expect(parseEnvBoolean(raw, "FLAG")).toBe(expected);
  });

  it("parseSourceRefRobust rejects garbage", () => {
    expect(() => parseSourceRefRobust("maybe")).toThrow(/ALAYA_RECALL_SOURCE_REF_ROBUST/);
  });

  it("parseDefaultOnFlag defaults on when unset", () => {
    expect(parseDefaultOnFlag(undefined, "FLAG")).toBe(true);
    expect(parseDefaultOnFlag("off", "FLAG")).toBe(false);
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
