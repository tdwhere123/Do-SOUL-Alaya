import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { z } from "zod";
import { buildSourceReferenceCatalog, sourceReferenceCapacityReason, SourceReferenceCapacityReasonSchema,
  SourceReferenceCatalogSchema, sourceReferenceResolver } from "../../evidence/source-reference.js";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

it("preserves existing catalog identities at the historical assertion boundary", () => {
  const assertions = Array.from({ length: 64 }, (_, index) => ({ assertion_id: index + 1, text: `Item ${index} is recorded.` }));
  expect(buildSourceReferenceCatalog(sha("historical"), assertions, sha).catalog_id).toMatchInlineSnapshot(`"sha256:94660619dd82a13aa6c5d6688219ec9dad2ebf4b31cb173b5a73afb2d316c8db"`);
});

it("gives repeated we distinct host IDs without counting occurrence in the response", () => {
  const text = "we promise; we believe";
  const catalog = buildSourceReferenceCatalog(sha(text), [{ assertion_id: 6, text }], sha);
  expect(catalog.assertions[0]!.segments).toEqual([
    { id: "a6s0", text: "we" }, { id: "a6s1", text: " " }, { id: "a6s2", text: "promise" },
    { id: "a6s3", text: ";" }, { id: "a6s4", text: " " }, { id: "a6s5", text: "we" },
    { id: "a6s6", text: " " }, { id: "a6s7", text: "believe" }
  ]);
  const references = sourceReferenceResolver(catalog, sha);
  expect(references.resolve(catalog.catalog_id, 6, { first: "a6s0", last: "a6s0" })).toEqual({ text: "we", span: [0, 2] });
  expect(references.resolve(catalog.catalog_id, 6, { first: "a6s5", last: "a6s5" })).toEqual({ text: "we", span: [12, 14] });
  // Both are mechanically grounded; only the second is the subject of 'believe'.
  expect(references.resolve(catalog.catalog_id, 6, { first: "a6s0", last: "a6s0" }).span).not.toEqual([12, 14]);
});

it("losslessly retains punctuation, whitespace and CJK/emoji scalar boundaries and rejects ASCII word-internal spans", () => {
  const text = "  ASCII_42\t中🙂文’s\r\n";
  const catalog = buildSourceReferenceCatalog(sha(text), [{ assertion_id: 1, text }], sha);
  const pieces = catalog.assertions[0]!.segments.map((row) => row.text);
  expect(pieces).toEqual([" ", " ", "ASCII_42", "\t", "中", "🙂", "文", "’", "s", "\r", "\n"]);
  expect(pieces.join("")).toBe(text);
  const references = sourceReferenceResolver(catalog, sha);
  expect(references.resolve(catalog.catalog_id, 1, { first: "a1s4", last: "a1s6" })).toEqual({ text: "中🙂文", span: [11, 15] });
  expect(() => references.referenceForSpan(1, [3, 5])).toThrow(/unsupported/u);
  expect(() => references.referenceForSpan(1, [12, 13])).toThrow(/unsupported/u);
  expect(() => buildSourceReferenceCatalog(sha("x"), [{ assertion_id: 1, text: "\ud800" }], sha)).toThrow(/surrogate/u);
});

it("rejects missing, reversed, cross-assertion, foreign-generation and corrupted directory references", () => {
  const assertions = [{ assertion_id: 1, text: "one two" }, { assertion_id: 2, text: "two" }];
  const catalog = buildSourceReferenceCatalog(sha("generation"), assertions, sha);
  const references = sourceReferenceResolver(catalog, sha);
  for (const value of [{ first: "a1s999", last: "a1s999" }, { first: "a1s2", last: "a1s0" }, { first: "a1s0", last: "a2s0" }]) {
    expect(() => references.resolve(catalog.catalog_id, 1, value)).toThrow();
  }
  const foreign = buildSourceReferenceCatalog(sha("foreign"), assertions, sha);
  expect(() => references.resolve(foreign.catalog_id, 1, { first: "a1s0", last: "a1s0" })).toThrow(/foreign/u);
  expect(() => sourceReferenceResolver({ ...catalog, assertions: [{ assertion_id: 1,
    segments: [{ id: "a1s0", text: "changed" }] }] }, sha)).toThrow(/mismatch/u);
  expect(() => buildSourceReferenceCatalog(sha("bound"), [{ assertion_id: 1, text: " ".repeat(32769) }], sha)).toThrow(/bound/u);
  expect(() => buildSourceReferenceCatalog(sha("bound"), [{ assertion_id: 1, text: "x".repeat(65537) }], sha)).toThrow(/bound/u);
});

it("retains a source-bound empty catalog without admitting any reference", () => {
  const catalog = buildSourceReferenceCatalog(sha(""), [], sha);
  expect(catalog.assertions).toEqual([]);
  const resolver = sourceReferenceResolver(catalog, sha);
  expect(() => resolver.resolve(catalog.catalog_id, 1, { first: "a1s0", last: "a1s0" })).toThrow();
  expect(buildSourceReferenceCatalog(sha("other"), [], sha).catalog_id).not.toBe(catalog.catalog_id);
});

it("classifies only valid sources that exceed the shared catalog capacity", () => {
  const assertions = Array.from({ length: 129 }, (_, index) => ({ assertion_id: index + 1, text: `Café ${index}.` }));
  expect(sourceReferenceCapacityReason(assertions.slice(0, 128))).toBeNull();
  const catalog = buildSourceReferenceCatalog(sha("boundary"), assertions.slice(0, 128), sha);
  expect(catalog.assertions).toHaveLength(128);
  expect(sourceReferenceResolver(catalog, sha).resolve(catalog.catalog_id, 128,
    { first: "a128s0", last: "a128s4" }).text).toBe("Café 127.");
  expect(sourceReferenceCapacityReason(assertions)).toEqual({ dimension: "assertions", actual: 129, limit: 128 });
  expect(() => buildSourceReferenceCatalog(sha("over"), assertions, sha)).toThrow(/129\/128/u);
  expect(() => sourceReferenceCapacityReason([...assertions.slice(0, 128), assertions[0]!])).toThrow(/duplicate/u);
  expect(() => sourceReferenceCapacityReason([...assertions.slice(0, 128), { assertion_id: 129, text: "\ud800" }]))
    .toThrow(/surrogate/u);
  expect(sourceReferenceCapacityReason([{ assertion_id: 1, text: " ".repeat(32769) }]))
    .toEqual({ dimension: "segments", actual: 32769, limit: 32768 });
});

it("reads historical and current assertion refusals while rejecting unknown or inconsistent limits", () => {
  for (const reason of [{ dimension: "assertions", actual: 95, limit: 64 },
    { dimension: "assertions", actual: 65, limit: 64 }, { dimension: "assertions", actual: 129, limit: 128 },
    { dimension: "text_units", actual: 65537, limit: 65536 }, { dimension: "segments", actual: 32769, limit: 32768 }]) {
    expect(SourceReferenceCapacityReasonSchema.parse(reason)).toEqual(reason);
  }
  for (const limit of [63, 96, 129, 256]) {
    expect(SourceReferenceCapacityReasonSchema.safeParse({ dimension: "assertions", actual: 300, limit }).success).toBe(false);
  }
  for (const limit of [64, 128]) {
    expect(SourceReferenceCapacityReasonSchema.safeParse({ dimension: "assertions", actual: limit, limit }).success).toBe(false);
  }
  expect(SourceReferenceCapacityReasonSchema.safeParse({ dimension: "text_units", actual: 65, limit: 64 }).success).toBe(false);
});

it("checks aggregate text and segment bounds before nested catalog parsing", () => {
  const envelope = { contract: "ascii-run-unicode-scalar-v1", source_digest: sha("raw"), catalog_id: `sha256:${sha("raw")}` };
  const unparsed = { get id(): string { throw new Error("nested catalog parser ran before capacity refusal"); }, text: "x".repeat(32769) };
  const textOverflow = { ...envelope, assertions: [
    { assertion_id: 1, segments: [unparsed] }, { assertion_id: 2, segments: [unparsed] }
  ] };
  expect(SourceReferenceCatalogSchema.safeParse(textOverflow).success).toBe(false);
  const segment = { get id(): string { throw new Error("nested catalog parser ran before capacity refusal"); }, text: " " };
  const segmentOverflow = { ...envelope, assertions: [
    { assertion_id: 1, segments: Array(16384).fill(segment) }, { assertion_id: 2, segments: Array(16385).fill(segment) }
  ] };
  expect(SourceReferenceCatalogSchema.safeParse(segmentOverflow).success).toBe(false);
  const assertionOverflow = { ...envelope, assertions: Array(129).fill({ get segments() { throw new Error("excess rows traversed"); } }) };
  expect(SourceReferenceCatalogSchema.safeParse(assertionOverflow).success).toBe(false);
  const textBoundary = buildSourceReferenceCatalog(sha("text-boundary"), [
    { assertion_id: 1, text: "x".repeat(32768) }, { assertion_id: 2, text: "y".repeat(32768) }
  ], sha);
  expect(SourceReferenceCatalogSchema.parse(textBoundary)).toEqual(textBoundary);
  const segmentBoundary = buildSourceReferenceCatalog(sha("segment-boundary"), [
    { assertion_id: 1, text: " ".repeat(16384) }, { assertion_id: 2, text: " ".repeat(16384) }
  ], sha);
  expect(SourceReferenceCatalogSchema.parse(segmentBoundary)).toEqual(segmentBoundary);
});

it("keeps the catalog object and row bounds visible to JSON schema consumers", () => {
  for (const io of ["input", "output"] as const) {
    expect(z.toJSONSchema(SourceReferenceCatalogSchema, { io })).toMatchObject({ type: "object",
      properties: { assertions: { type: "array", maxItems: 128, items: { properties: {
        segments: { type: "array", maxItems: 32768, items: { properties: { text: { maxLength: 65536 } } } }
      } } } } });
  }
});
