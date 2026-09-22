import { expect, it } from "vitest";
import {
  SOURCE_SEMANTIC_CORRESPONDENCE_SELECTION_CONTRACT,
  SourceSemanticCorrespondenceSelectionSchema, buildSourceSemanticCorrespondenceEndpointCatalog,
  materializeSourceSemanticCorrespondenceSelection
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

it("materializes local selections into canonical correspondences and refuses unknown handles", () => {
  const catalog = buildSourceSemanticCorrespondenceEndpointCatalog(query, [{ source_interpretation_handle: "source1", interpretation }]);
  const predicate = catalog.query_endpoints.find((row) => row.kind === "predicate")!;
  const frame = catalog.source_endpoints.find((row) => row.kind === "frame")!;
  const semantic_correspondence = materializeSourceSemanticCorrespondenceSelection({
    contract: SOURCE_SEMANTIC_CORRESPONDENCE_SELECTION_CONTRACT,
    source_interpretation_handle: "source1",
    selections: [{
      query: predicate.handle, source: frame.handle, query_excerpt: "accessioned",
      source_semantic_support: [{ kind: "lexical", mentions: ["mAccessioned"] }]
    }]
  }, catalog, { source_interpretation_id: digest, query_semantics_id: digest, producer_id: "ap", producer_version: "1" });
  expect(semantic_correspondence.correspondences[0]).toMatchObject({
    relation: "contextual_equivalence",
    query_endpoint: { kind: "predicate", alternative: 0, frame: "qAccession" },
    source_endpoint: { kind: "frame", frame: "fAccession" }
  });
  expect(() => materializeSourceSemanticCorrespondenceSelection({
    contract: SOURCE_SEMANTIC_CORRESPONDENCE_SELECTION_CONTRACT,
    selections: [{ query: "qe9", source: frame.handle, query_excerpt: "accessioned", source_semantic_support: [] }]
  }, catalog, { source_interpretation_id: digest, query_semantics_id: digest, producer_id: "ap", producer_version: "1" }))
    .toThrow(/undeclared local reference/u);
});

it("rejects legacy endpoint graphs at the catalog-selection boundary", () => {
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
  expect(SourceSemanticCorrespondenceSelectionSchema.safeParse(body).success).toBe(false);
});
