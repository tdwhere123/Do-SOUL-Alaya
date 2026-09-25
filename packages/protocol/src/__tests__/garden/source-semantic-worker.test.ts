import { expect, it } from "vitest";
import { UNKNOWN_UTTERANCE_ATTRIBUTION } from "../../conversation/utterance-attribution.js";
import { MemorySearchResultSchema } from "../../surfaces/mcp-memory-search-types.js";
import { SourceInterpretationReasoningResultSchema } from "../../garden/source-interpretation-packet.js";
import { SourceSemanticAccessReceiptSchema } from "../../garden/source-semantic-access.js";
import { InformationIndexSchema, sourceIndexEntry, indexEntryCacheKey } from "../../recall/conditional-field/index-view.js";
import { SoulInterpretationRequestSchema, SoulInterpretationResponseSchema } from "../../surfaces/mcp-interpretation-types.js";
import { SourceSemanticQuerySchema } from "../../recall/conditional-field/semantic-query.js";
import {
  SourceSemanticWorkerRequestSchema, SourceSemanticWorkerResultSchema,
  SourceSemanticLibraryContinuationSchema, SourceSemanticLibraryDeliverySchema,
  SOURCE_SEMANTIC_LIBRARY_PROTOCOL_VERSION, SOURCE_SEMANTIC_LIBRARY_RESULT_VERSION, SOURCE_SEMANTIC_LIBRARY_PAGE_BUDGET
} from "../../garden/source-semantic-worker.js";

const digest = `sha256:${"a".repeat(64)}`;
const budget = {
  schema_version: 1 as const, work_units: 10, memory_bytes: 1000,
  page_budget: 1, finalization_reserve: 0, min_envelope: 0
};
const coverage = {
  discovery: "complete" as const, source_interpretation: "unexercised" as const,
  query_semantics: "unexercised" as const, semantic_correspondence: "unexercised" as const,
  conditional_computation: "unexercised" as const, payload: "complete" as const
};
const work = { native_work: 1, native_bytes: 2, logical_memory_bytes: 3, rss_bytes: 4 };
const disclosure = { material_kind: "interpretation", source_binding: "unbound",
  evaluated_as_of: "2026-09-25T00:00:00Z", validity: { kind: "unknown", reason: "unbound" },
  temporal_state: "unknown", proof_use: { kind: "source_only", qualification: "not_current_proof" } };
const validQuery = SourceSemanticQuerySchema.parse({
  contract: "source-semantic-query-v4", original_query_digest: digest,
  approved_fixed_context: null, attribution_context: UNKNOWN_UTTERANCE_ATTRIBUTION,
  producer_id: "qp", producer_version: "1", contract_version: "source-semantic-query-v4",
  variables: [{ id: "actor", sort: "entity" }, { id: "fUse", sort: "proposition" }],
  alternatives: [{ frames: [{ id: "qUse", variable: "fUse", predicate_reading: "use",
    role_requirements: [{ id: "agent", role_reading: "agent", target_variable: "actor",
      support: { kind: "query_text", excerpt: "Alice" } }] }],
  context_obligations: [{ frame: "qUse", kind: "asserted_at_source" }] }],
  return_variables: ["actor"], gaps: []
});

it("binds access trace counts and source completeness to the observed pool", () => {
  const access = { contract: "source-semantic-access-v1", policy: "canonical-v1", input_id: digest, pool_id: digest,
    observed_source_count: 2, observed_interpretation_count: 0,
    source_candidates: [{ source_id: "source-2", record_id: digest, read_bytes: 1, body_bytes: 1,
      complete: true, signal: { source_text_score: null, interpretation_reading_score: 0 } }],
    interpretation_candidates: [], unvisited_sources: false, unvisited_interpretations: false,
    stopping_reasons: [], trace: { kind: "preparation_page", source_offset: 1, interpretation_offset: 0,
      omitted_source_count: 1, omitted_interpretation_count: 0 } };
  expect(SourceSemanticAccessReceiptSchema.safeParse(access).success).toBe(true);
  expect(SourceSemanticAccessReceiptSchema.safeParse({ ...access,
    trace: { ...access.trace, omitted_source_count: 0 } }).success).toBe(false);
  expect(SourceSemanticAccessReceiptSchema.safeParse({ ...access,
    trace: { ...access.trace, source_offset: 2 } }).success).toBe(false);
  expect(SourceSemanticAccessReceiptSchema.safeParse({ ...access,
    source_candidates: [{ ...access.source_candidates[0], read_bytes: 0 }] }).success).toBe(false);
  expect(SourceSemanticAccessReceiptSchema.safeParse({ ...access,
    source_candidates: [{ ...access.source_candidates[0], body_bytes: null }] }).success).toBe(false);
  const selection = { ...access, trace: { kind: "library_selection", omitted_source_count: 1,
    omitted_interpretation_count: 0 } };
  expect(SourceSemanticAccessReceiptSchema.safeParse(selection).success).toBe(true);
  expect(SourceSemanticAccessReceiptSchema.safeParse({ ...selection,
    trace: { ...selection.trace, omitted_source_count: 0 } }).success).toBe(false);
});

it("rejects an unavailable declaration beside valid query semantics on public and worker requests", () => {
  for (const operation of ["prepare_query", "recall"] as const) {
    const shared = { original_query: "Alice uses tools?", query_semantics: validQuery,
      query_semantics_unavailable: "producer_failure", budget };
    const recall = operation === "recall" ? { accepts_unreviewed_conditional_results: true, output_byte_limit: 1024 } : {};
    expect(SourceSemanticWorkerRequestSchema.safeParse({ kind: operation, ...shared, ...recall }).success).toBe(false);
    expect(SoulInterpretationRequestSchema.safeParse({ operation, ...shared, ...recall }).success).toBe(false);
    expect(SourceSemanticWorkerRequestSchema.safeParse({ kind: operation, ...shared,
      query_semantics_unavailable: undefined, ...recall }).success).toBe(true);
    expect(SoulInterpretationRequestSchema.safeParse({ operation, ...shared,
      query_semantics_unavailable: undefined, ...recall }).success).toBe(true);
  }
});

it("admits prepare and one-shot reason without a continuation token", () => {
  expect(SourceSemanticWorkerRequestSchema.parse({
    kind: "prepare_source", source_id: "artifact-1", budget
  }).kind).toBe("prepare_source");
  expect(SourceSemanticWorkerRequestSchema.safeParse({
    kind: "reason", accepts_unreviewed_conditional_results: true, budget, output_byte_limit: 1024
  }).success).toBe(false);
  expect(SourceSemanticWorkerRequestSchema.safeParse({
    kind: "recall", accepts_unreviewed_conditional_results: true, budget, output_byte_limit: 1024
  }).success).toBe(false);
  expect(SourceSemanticWorkerRequestSchema.parse({
    kind: "recall", accepts_unreviewed_conditional_results: true, query_handle: "query-handle",
    budget, output_byte_limit: 1024
  }).kind).toBe("recall");
  expect(SourceSemanticWorkerRequestSchema.parse({
    kind: "recall", accepts_unreviewed_conditional_results: true, original_query: "question",
    budget, output_byte_limit: 1024
  }).kind).toBe("recall");
  expect(SourceSemanticWorkerRequestSchema.safeParse({
    kind: "recall", accepts_unreviewed_conditional_results: true, original_query: "question",
    query_semantics_unavailable: "producer_failure", query_semantics: {}, budget, output_byte_limit: 1024
  }).success).toBe(false);
  expect(SourceSemanticWorkerRequestSchema.parse({
    kind: "recall", accepts_unreviewed_conditional_results: true, query_handle: "query-handle",
    budget, output_byte_limit: 1024,
    continuation: {
      schema_version: 1, continuation_id: "page-10", query_id: "q1", snapshot_id: digest,
      result_version: SOURCE_SEMANTIC_LIBRARY_RESULT_VERSION, expires_at: "2099-01-01T00:00:00.000Z",
      cursor: "offset-10"
    }
  }).kind).toBe("recall");
  const result = SourceSemanticWorkerResultSchema.parse({
    kind: "reason",
    source_disclosure: disclosure,
    result: {
      contract: "source-interpretation-reasoning-v5",
      outcome: { status: "truncated" }, consumed_leaves: [],
      semantic_status: "unreviewed", conclusion_scope: "conditional_on_interpretation",
      world_claim: "unknown"
    },
    coverage: { ...coverage, payload: "truncated", conditional_computation: "open" }, work
  });
  expect("continuation" in result).toBe(false);
  if (result.kind !== "reason") throw new Error("expected a reasoning result");
  expect(result.result.semantic_status).toBe("unreviewed");
  expect(result.result.world_claim).toBe("unknown");
  expect(MemorySearchResultSchema.safeParse(result).success).toBe(false);
  expect(SourceInterpretationReasoningResultSchema.safeParse(result).success).toBe(false);
  expect(digest.startsWith("sha256:")).toBe(true);
});

function libraryDelivery() {
  return { delivery_id: "delivery", request_identity: digest, query_semantics_status: { status: "unavailable", reason: "absent" },
    protocol_version: SOURCE_SEMANTIC_LIBRARY_PROTOCOL_VERSION, total_count: 0,
    index: { schema_version: 1, query_id: "library-query", snapshot_id: digest, result_version: SOURCE_SEMANTIC_LIBRARY_RESULT_VERSION,
      entries: [], completeness: { schema_version: 1, logical_index: "complete", observed_coverage: "complete",
        transport: "complete", payload: "complete", representation: "complete" }, continuation: null,
      representation: { schema_version: 1, policy: "construct_index_then_page_then_payload", page_budget: SOURCE_SEMANTIC_LIBRARY_PAGE_BUDGET, identity_tie_break: "serialization" },
      page_purpose: "membership" },
    page_purpose: "membership", discovery: { eligible_source_count: 0, visited_source_pages: 1, visited_source_interpretation_pages: 1,
      visited_source_interpretation_descriptors: 0, candidate_prefix: [], examined_source_interpretation_ids: [],
      unexamined_source_interpretation_count: 0, omitted_duplicate_bindings: 0, examination_cap: 32, open_residuals: false, truncated: false },
    order: { enumeration_policy: "evidence_support", tie_policy: "canonical_identity", occupancy: "source_gold_root_identity", occupancy_prefix: 5, page_budget: SOURCE_SEMANTIC_LIBRARY_PAGE_BUDGET },
    slot_qualifiers: [], source_disclosures: {}, coverage, work };
}

it("shares current delivery version, membership and page budget admission between worker and public surfaces", () => {
  const delivery = libraryDelivery();
  const accepts = (value: unknown) => [
    SourceSemanticWorkerResultSchema.safeParse(Object.assign({ kind: "recall" }, value)).success,
    SoulInterpretationResponseSchema.safeParse(Object.assign({ operation: "recall", results: [], provider_attempts: 0 }, value)).success
  ];
  expect(accepts(delivery)).toEqual([true, true]);
  expect(accepts({ ...delivery, query_semantics_status: { status: "unavailable", reason: "producer_failure" } })).toEqual([true, true]);
  expect(accepts({ ...delivery, query_semantics_status: { status: "admitted", query_semantics_id: digest } })).toEqual([true, true]);
  for (const version of ["source-semantic-library-v1", "source-semantic-library-v3", "not-a-native-library-result"]) {
    const index = { ...delivery.index, result_version: version };
    expect(InformationIndexSchema.safeParse(index).success).toBe(true);
    expect(accepts({ ...delivery, index })).toEqual([false, false]);
  }
  for (const changed of [ { ...delivery, protocol_version: 4 }, { ...delivery, request_identity: "unbound" }, { ...delivery, page_purpose: "update" },
    { ...delivery, order: { ...delivery.order, page_budget: 9 } },
    { ...delivery, index: { ...delivery.index, representation: { ...delivery.index.representation, page_budget: 9 } } },
    { ...delivery, index: { ...delivery.index, page_purpose: "update" } } ]) expect(accepts(changed)).toEqual([false, false]);
});

it("binds availability, semantic coverage and qualified slots on both delivery surfaces", () => {
  const delivery = libraryDelivery();
  const accepts = (value: Record<string, unknown>) => [
    SourceSemanticWorkerResultSchema.safeParse({ kind: "recall", ...value }).success,
    SoulInterpretationResponseSchema.safeParse({ operation: "recall", results: [], provider_attempts: 0, ...value }).success
  ];
  const proofSlot = { index: 0, evidence_kind: "semantic_proof", source_interpretation_id: digest,
    query_semantics_id: digest, semantic_correspondence_id: digest, conditional_computation_id: digest,
    witnesses: [{ conditional_computation_id: digest, binding_id: "binding" }],
    support: { answer: "open", evidence_inputs: [], operation: "not_requested", compatibility: "unknown", distinctness: "unknown" } };
  expect(accepts(delivery)).toEqual([true, true]);
  expect(accepts({ ...delivery, coverage: { ...coverage, query_semantics: "complete" } })).toEqual([false, false]);
  expect(accepts({ ...delivery, slot_qualifiers: [proofSlot] })).toEqual([false, false]);
  const { coverage: _coverage, work: _work, ...baseDelivery } = delivery;
  expect(SourceSemanticLibraryDeliverySchema.safeParse(baseDelivery).success).toBe(true);
  expect(SourceSemanticLibraryDeliverySchema.safeParse({ ...baseDelivery, slot_qualifiers: [proofSlot] }).success).toBe(false);
  expect(accepts({ ...delivery, query_semantics_status: { status: "admitted", query_semantics_id: digest },
    coverage: { ...coverage, query_semantics: "complete" }, slot_qualifiers: [proofSlot] })).toEqual([true, true]);
  expect(accepts({ ...delivery, query_semantics_status: { status: "admitted", query_semantics_id: `sha256:${"b".repeat(64)}` },
    coverage: { ...coverage, query_semantics: "complete" }, slot_qualifiers: [proofSlot] })).toEqual([false, false]);
});

it("requires a disclosure for each delivered source and rejects metadata for an undelivered source", () => {
  const entry = sourceIndexEntry({ workspace_id: "workspace", root_kind: "source_record", root_id: "record",
    source_version: "v1", content_digest: digest, evidence_object_id: null,
    hypothesis_id: "h0", output_binding: "source-evidence", role: "requested", association_milligrades: 0,
    claim: "unknown", explanation_ids: [] });
  const key = indexEntryCacheKey(entry);
  const { coverage: _coverage, work: _work, ...baseDelivery } = libraryDelivery();
  const delivery = { ...baseDelivery, total_count: 1,
    index: { ...baseDelivery.index, entries: [entry] },
    slot_qualifiers: [{ index: 0, evidence_kind: "source_evidence" }],
    source_disclosures: { [key]: { ...disclosure, material_kind: "original_body" } } };
  const accepted = SourceSemanticLibraryDeliverySchema.safeParse(delivery);
  expect(accepted.success, accepted.success ? "" : JSON.stringify(accepted.error.issues)).toBe(true);
  expect(SourceSemanticLibraryDeliverySchema.safeParse({ ...delivery, source_disclosures: {} }).success).toBe(false);
  expect(SourceSemanticLibraryDeliverySchema.safeParse({ ...delivery,
    source_disclosures: { ...delivery.source_disclosures, extra: disclosure } }).success).toBe(false);
});

it("rejects every missing mandatory delivery field and partial deliveries disguised as outcomes", () => {
  const delivery = libraryDelivery();
  for (const key of ["delivery_id", "request_identity", "query_semantics_status", "protocol_version", "total_count", "index", "page_purpose", "discovery", "order", "slot_qualifiers", "source_disclosures"]) {
    const partial = { ...delivery };
    Reflect.deleteProperty(partial, key);
    expect(SourceSemanticWorkerResultSchema.safeParse({ kind: "recall", ...partial }).success, key).toBe(false);
    expect(SoulInterpretationResponseSchema.safeParse({ operation: "recall", results: [], provider_attempts: 0,
      outcome: { status: "preparation_required", missing: "query_semantics" }, ...partial }).success, key).toBe(false);
  }
  expect(SoulInterpretationResponseSchema.safeParse({ operation: "recall", ...delivery, provider_attempts: 0 }).success).toBe(false);
  const outcome = { operation: "recall", outcome: { status: "preparation_required", missing: "query_semantics" }, coverage, work, provider_attempts: 0 };
  expect(SoulInterpretationResponseSchema.safeParse(outcome).success).toBe(true);
  for (const partial of [{ protocol_version: 3 }, { request_identity: digest }, { results: [] }, { request_budget: budget }, { proofs: [] }]) {
    expect(SoulInterpretationResponseSchema.safeParse({ ...outcome, ...partial }).success).toBe(false);
  }
});

it("binds library continuations to their current frozen delivery contract without claiming canonical enumeration", () => {
  const cursor = { schema_version: 1, continuation_id: "page-5", query_id: "query", snapshot_id: digest,
    result_version: SOURCE_SEMANTIC_LIBRARY_RESULT_VERSION, expires_at: "2099-01-01T00:00:00.000Z", cursor: "offset-5" };
  expect(SourceSemanticLibraryContinuationSchema.safeParse(cursor).success).toBe(true);
  expect(SourceSemanticLibraryContinuationSchema.safeParse({ ...cursor, enumeration_policy: "canonical" }).success).toBe(false);
  expect(SourceSemanticLibraryContinuationSchema.safeParse({ ...cursor, result_version: "source-semantic-library-v3" }).success).toBe(false);
});
