import { describe, expect, it } from "vitest";
import { CoreError } from "../../shared/errors.js";
import {
  normalizeOptionalNonEmptyString,
  parseNonEmptyString,
  parseObjectId
} from "../../shared/validators.js";

describe("normalizeOptionalNonEmptyString", () => {
  it("returns null for null, undefined, and blank input", () => {
    expect(normalizeOptionalNonEmptyString(null)).toBeNull();
    expect(normalizeOptionalNonEmptyString(undefined)).toBeNull();
    expect(normalizeOptionalNonEmptyString("")).toBeNull();
    expect(normalizeOptionalNonEmptyString("   ")).toBeNull();
  });

  it("trims and returns non-empty input", () => {
    expect(normalizeOptionalNonEmptyString("  hello  ")).toBe("hello");
    expect(normalizeOptionalNonEmptyString("world")).toBe("world");
  });
});

describe("parseObjectId", () => {
  it("returns the value unchanged when non-blank", () => {
    expect(parseObjectId("obj-1")).toBe("obj-1");
  });

  it("throws a VALIDATION CoreError on blank input", () => {
    expect(() => parseObjectId("   ")).toThrowError(CoreError);
    try {
      parseObjectId("");
    } catch (error) {
      expect(error).toBeInstanceOf(CoreError);
      expect((error as CoreError).code).toBe("VALIDATION");
      expect((error as CoreError).message).toContain("object_id");
    }
  });

  it("uses the provided context in the error message", () => {
    expect(() => parseObjectId("", "memory_id")).toThrow("memory_id is required");
  });
});

describe("parseNonEmptyString", () => {
  it("returns the value unchanged when non-blank", () => {
    expect(parseNonEmptyString("value", "title")).toBe("value");
  });

  it("throws a VALIDATION CoreError naming the field on blank input", () => {
    try {
      parseNonEmptyString("   ", "title");
      throw new Error("expected CoreError");
    } catch (error) {
      expect(error).toBeInstanceOf(CoreError);
      expect((error as CoreError).code).toBe("VALIDATION");
      expect((error as CoreError).message).toBe("title is required");
    }
  });
});
