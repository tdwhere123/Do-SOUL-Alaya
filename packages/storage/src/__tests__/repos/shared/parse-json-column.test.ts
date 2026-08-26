import { describe, expect, it } from "vitest";
import { StorageError } from "../../../shared/errors.js";
import {
  parseJsonColumn,
  parseJsonColumnWithSchema,
  parseNullableJsonColumn
} from "../../../repos/shared/parse-json-column.js";

const refsSchema = {
  parse(input: unknown): { readonly refs: readonly string[] } {
    if (
      typeof input !== "object" ||
      input === null ||
      !Array.isArray((input as { readonly refs?: unknown }).refs) ||
      (input as { readonly refs: readonly unknown[] }).refs.some((item) => typeof item !== "string")
    ) {
      throw new Error("refs must be a string array");
    }
    return { refs: (input as { readonly refs: readonly string[] }).refs };
  }
};

describe("parseJsonColumn", () => {
  it("parses valid JSON", () => {
    expect(parseJsonColumn(`{"refs":["a"]}`, "evidence_refs")).toEqual({ refs: ["a"] });
  });

  it("throws VALIDATION_FAILED for corrupt persisted JSON", () => {
    expect(() => parseJsonColumn("{not-json", "evidence_refs")).toThrow(StorageError);
    expect(() => parseJsonColumn("{not-json", "evidence_refs")).toThrow(
      expect.objectContaining({
        name: "StorageError",
        code: "VALIDATION_FAILED",
        message: expect.stringMatching(/Failed to parse evidence_refs JSON/)
      })
    );
  });
});

describe("parseNullableJsonColumn", () => {
  it("returns null for SQL NULL", () => {
    expect(parseNullableJsonColumn(null, "raw_payload_json")).toBeNull();
  });

  it("throws VALIDATION_FAILED for corrupt persisted JSON", () => {
    expect(() => parseNullableJsonColumn("]", "raw_payload_json")).toThrow(
      expect.objectContaining({ code: "VALIDATION_FAILED" })
    );
  });
});

describe("parseJsonColumnWithSchema", () => {
  it("returns schema-parsed JSON", () => {
    expect(parseJsonColumnWithSchema(`{"refs":["a"]}`, "path relation anchors", refsSchema)).toEqual({
      refs: ["a"]
    });
  });

  it("throws VALIDATION_FAILED when JSON is corrupt", () => {
    expect(() => parseJsonColumnWithSchema("{", "path relation anchors", refsSchema)).toThrow(
      expect.objectContaining({ code: "VALIDATION_FAILED" })
    );
  });

  it("throws VALIDATION_FAILED when JSON does not match the schema", () => {
    expect(() => parseJsonColumnWithSchema(`{"refs":1}`, "path relation anchors", refsSchema)).toThrow(
      expect.objectContaining({ code: "VALIDATION_FAILED" })
    );
  });
});
