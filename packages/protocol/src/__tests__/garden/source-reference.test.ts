import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { buildSourceReferenceCatalog, sourceReferenceResolver } from "../../evidence/source-reference.js";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

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
