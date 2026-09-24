import { expect, it } from "vitest";
import {
  SOURCE_SEMANTIC_CORRESPONDENCE_ASSESSMENT_CONTRACT,
  SourceSemanticCorrespondenceAssessmentSchema, buildSourceSemanticCorrespondenceEndpointCatalog,
  countSourceSemanticCorrespondenceJsonBytes, materializeSourceSemanticCorrespondenceAssessment
} from "../../../recall/conditional-field/index.js";
import type { SourceSemanticQuery } from "../../../recall/conditional-field/semantic-query.js";
import type { SourceSemanticInterpretation } from "../../../garden/source-semantic-interpretation.js";

const digest = `sha256:${"a".repeat(64)}`;

const query = {
  contract: "source-semantic-query-v3", original_query_digest: digest,
  producer_id: "qp", producer_version: "1", contract_version: "source-semantic-query-v3",
  variables: [
    { id: "folio", sort: "entity" },
    { id: "bay", sort: "entity", reference: { kind: "query_text", excerpt: "bay B" } },
    { id: "accession", sort: "proposition" }
  ],
  alternatives: [{
    frames: [{
      id: "qAccession", variable: "accession", predicate_reading: "accession",
      role_requirements: [{
        id: "object", role_reading: "folio", target_variable: "folio",
        support: { kind: "query_text", excerpt: "folio" }
      }]
    }],
    context_obligations: [{ frame: "qAccession", kind: "asserted_at_source" }]
  }],
  return_variables: ["folio"],
  gaps: []
} as unknown as SourceSemanticQuery;

const interpretation = {
  frames: [{
    id: "fAccession",
    predicate_support: { kind: "explicit", reading: "accession", mentions: ["mAccessioned"] },
    slots: [{ id: "object", role_reading: "folio", support: [] }]
  }],
  referents: [
    { id: "rFolio", referent_kind: "grouped", mentions: ["mFolio"] },
    { id: "rUnknown", referent_kind: "unresolved", mentions: ["mItem"] }
  ]
} as unknown as SourceSemanticInterpretation;

it("counts escaped and multibyte correspondence JSON by the serialized UTF-8 size", () => {
  const values = ["quote\" slash\\ control\n 猫😀", [null, true, -0, { note: "\ud800" }],
    { a: undefined, b: 1, c: ["x", undefined] }];
  for (const value of values) {
    const bytes = Buffer.byteLength(JSON.stringify(value));
    expect(countSourceSemanticCorrespondenceJsonBytes(value, bytes)).toBe(bytes);
    expect(() => countSourceSemanticCorrespondenceJsonBytes(value, bytes - 1))
      .toThrow(/exceeds input budget/u);
  }
});

it("advertises named query referents, predicates, and slots without pairing or unresolved source referents", () => {
  const catalog = buildSourceSemanticCorrespondenceEndpointCatalog(query, [
    { source_interpretation_handle: "source1", interpretation }
  ]);
  expect(catalog.query_endpoints.map((row) => row.kind)).toEqual(["referent", "predicate", "slot"]);
  expect(catalog.query_endpoints.find((row) => row.kind === "referent")?.variable).toBe("bay");
  expect(catalog.query_endpoints.find((row) => row.kind === "referent")?.named).toBe(true);
  expect(catalog.source_endpoints.map((row) => row.kind)).toEqual(["referent", "frame", "slot"]);
  expect(catalog.source_endpoints.some((row) => row.referent === "rUnknown")).toBe(false);
  expect(JSON.stringify(catalog)).not.toMatch(/sha256:/u);
});

it("requires every query endpoint to be assessed and lowers only positive equivalents", () => {
  const catalog = buildSourceSemanticCorrespondenceEndpointCatalog(query, [{ source_interpretation_handle: "source1", interpretation }]);
  const predicate = catalog.query_endpoints.find((row) => row.kind === "predicate")!;
  const frame = catalog.source_endpoints.find((row) => row.kind === "frame")!;
  const unresolved = catalog.query_endpoints.filter((row) => row.handle !== predicate.handle).map((row) => ({
    query: row.handle, status: "unresolved", query_excerpt: "folio", explanation: "The endpoint relation is not established."
  }));
  const envelope = { original_query: "which folio was accessioned into bay B?",
    source_interpretation_id: digest, query_semantics_id: digest, producer_id: "ap", producer_version: "1" };
  const semantic_correspondence = materializeSourceSemanticCorrespondenceAssessment({
    contract: SOURCE_SEMANTIC_CORRESPONDENCE_ASSESSMENT_CONTRACT,
    source_interpretation_handle: "source1",
    assessments: [...unresolved, { query: predicate.handle, status: "supported", equivalents: [{
      source: frame.handle, query_excerpt: "accessioned", grounding: "The asserted local accession relation.",
      source_semantic_support: [{ kind: "lexical", mentions: ["mAccessioned"] }]
    }] }]
  }, catalog, envelope);
  expect(semantic_correspondence.correspondences[0]).toMatchObject({
    relation: "contextual_equivalence",
    query_endpoint: { kind: "predicate", alternative: 0, frame: "qAccession" },
    source_endpoint: { kind: "frame", frame: "fAccession" }
  });
  expect(() => materializeSourceSemanticCorrespondenceAssessment({
    contract: SOURCE_SEMANTIC_CORRESPONDENCE_ASSESSMENT_CONTRACT,
    source_interpretation_handle: "source1",
    assessments: [{ query: "qe9", status: "supported", equivalents: [{ source: frame.handle,
      query_excerpt: "accessioned", source_semantic_support: [], grounding: "Local relation." }] }]
  }, catalog, envelope))
    .toThrow(/undeclared local reference/u);
  expect(() => materializeSourceSemanticCorrespondenceAssessment({
    contract: SOURCE_SEMANTIC_CORRESPONDENCE_ASSESSMENT_CONTRACT, source_interpretation_handle: "source1",
    assessments: unresolved
  }, catalog, envelope)).toThrow(/missing query endpoint assessment/u);
  expect(materializeSourceSemanticCorrespondenceAssessment({
    contract: SOURCE_SEMANTIC_CORRESPONDENCE_ASSESSMENT_CONTRACT, source_interpretation_handle: "source1",
    assessments: catalog.query_endpoints.map((row) => ({ query: row.handle, status: "unresolved",
      query_excerpt: "folio", explanation: "The relation is not established." }))
  }, catalog, envelope).correspondences).toEqual([]);
});

it("rejects duplicate, foreign, mis-scoped, and non-exact assessments", () => {
  const catalog = buildSourceSemanticCorrespondenceEndpointCatalog(query, [
    { source_interpretation_handle: "source1", interpretation },
    { source_interpretation_handle: "source2", interpretation }
  ]);
  const open = catalog.query_endpoints.map((row) => ({ query: row.handle, status: "unresolved",
    query_excerpt: "folio", explanation: "No equivalent is established." }));
  const envelope = { original_query: "which folio was accessioned into bay B?",
    source_interpretation_id: digest, query_semantics_id: digest, producer_id: "ap", producer_version: "1" };
  const body = (assessments: unknown, source_interpretation_handle = "source1") => ({
    contract: SOURCE_SEMANTIC_CORRESPONDENCE_ASSESSMENT_CONTRACT, source_interpretation_handle, assessments
  });
  expect(() => materializeSourceSemanticCorrespondenceAssessment(body([...open, open[0]]), catalog, envelope))
    .toThrow(/duplicate query endpoint assessment/u);
  expect(() => materializeSourceSemanticCorrespondenceAssessment(body([
    ...open.slice(1), { ...open[0], query: "qe99" }
  ]), catalog, envelope)).toThrow(/undeclared local reference/u);
  expect(() => materializeSourceSemanticCorrespondenceAssessment(body([
    ...open.slice(1), { ...open[0], query_excerpt: "invented" }
  ]), catalog, envelope)).toThrow(/query excerpt is not in the original query/u);
  const foreignFrame = catalog.source_endpoints.find((row) => row.kind === "frame" && row.source_interpretation_handle === "source2")!;
  expect(() => materializeSourceSemanticCorrespondenceAssessment(body([
    ...open.slice(1), { query: open[0]!.query, status: "supported", equivalents: [{
      source: foreignFrame.handle, query_excerpt: "folio", source_semantic_support: [], grounding: "A foreign frame."
    }] }
  ]), catalog, envelope)).toThrow(/not on the bound interpretation/u);
  expect(() => materializeSourceSemanticCorrespondenceAssessment(body([
    ...open.slice(1), { query: open[0]!.query, status: "supported", equivalents: [{
      source: "se99", query_excerpt: "folio", source_semantic_support: [], grounding: "Unknown source."
    }] }
  ]), catalog, envelope)).toThrow(/undeclared local reference/u);
});

it("preserves multiple equivalents and enforces the aggregate native bound", () => {
  const second = { ...interpretation, frames: [...interpretation.frames, {
    ...interpretation.frames[0]!, id: "fAccession2", slots: []
  }] } as SourceSemanticInterpretation;
  const catalog = buildSourceSemanticCorrespondenceEndpointCatalog(query, [{ source_interpretation_handle: "source1", interpretation: second }]);
  const predicate = catalog.query_endpoints.find((row) => row.kind === "predicate")!;
  const frames = catalog.source_endpoints.filter((row) => row.kind === "frame");
  const envelope = { original_query: "which folio was accessioned into bay B?",
    source_interpretation_id: digest, query_semantics_id: digest, producer_id: "ap", producer_version: "1" };
  const equivalent = (source: string, grounding: string) => ({ source, query_excerpt: "accessioned",
    source_semantic_support: [], grounding });
  const assessments = catalog.query_endpoints.map((row) => row.handle === predicate.handle
    ? { query: row.handle, status: "supported", equivalents: frames.map((frame) => equivalent(frame.handle, "Cited local frame.")) }
    : { query: row.handle, status: "unresolved", query_excerpt: "folio", explanation: "No equivalent is established." });
  const body = { contract: SOURCE_SEMANTIC_CORRESPONDENCE_ASSESSMENT_CONTRACT,
    source_interpretation_handle: "source1", assessments };
  expect(materializeSourceSemanticCorrespondenceAssessment(body, catalog, envelope).correspondences).toHaveLength(2);
  const changed = structuredClone(body);
  (changed.assessments.find((row) => row.status === "supported") as { equivalents: { grounding: string }[] })
    .equivalents[0]!.grounding = "A different unreviewed explanation.";
  expect(materializeSourceSemanticCorrespondenceAssessment(changed, catalog, envelope))
    .toEqual(materializeSourceSemanticCorrespondenceAssessment(body, catalog, envelope));
  const oversizedCatalog = { query_endpoints: Array.from({ length: 256 }, (_, index) => ({
    ...predicate, handle: `qe${index + 1}`
  })), source_endpoints: frames };
  const oversized = { ...body, assessments: oversizedCatalog.query_endpoints.map((row, index) => ({
    query: row.handle, status: "supported", equivalents: index === 0
      ? frames.map((frame) => equivalent(frame.handle, "Local frame."))
      : [equivalent(frames[0]!.handle, "Local frame.")]
  })) };
  expect(() => materializeSourceSemanticCorrespondenceAssessment(oversized, oversizedCatalog, envelope))
    .toThrow(/correspondence bound/u);
  expect(() => materializeSourceSemanticCorrespondenceAssessment({ ...body, extra: "x".repeat(1_000_000) }, catalog, envelope))
    .toThrow(/byte bound/u);
});

it("rejects legacy endpoint graphs at the endpoint-assessment boundary", () => {
  const body = {
    correspondences: [{
      relation: "contextual_equivalence" as const,
      query_endpoint: { kind: "predicate" as const, alternative: 0, frame: "qAccession" },
      source_endpoint: { kind: "frame" as const, frame: "fAccession" },
      query_support: { kind: "query_text" as const, excerpt: "accessioned" },
      source_semantic_support: []
    }],
    source_interpretation_handle: "source1"
  };
  expect(SourceSemanticCorrespondenceAssessmentSchema.safeParse(body).success).toBe(false);
});
