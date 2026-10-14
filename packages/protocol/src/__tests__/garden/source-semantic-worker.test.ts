import { expect, it } from "vitest";
import { createHash } from "node:crypto";
import { hashSourceRecordId } from "../../recall/field-contract/canonical-identity.js";
import type { SourceRepresentation } from "../../recall/field-contract/source-span.js";
import { UNKNOWN_UTTERANCE_ATTRIBUTION } from "../../conversation/utterance-attribution.js";
import { MemorySearchResultSchema } from "../../surfaces/mcp-memory-search-types.js";
import { SourceInterpretationReasoningResultSchema } from "../../garden/source-interpretation-packet.js";
import { SourceSemanticAccessReceiptSchema } from "../../garden/source-semantic-access.js";
import { InformationIndexSchema, IndexEntrySchema, sourceIndexEntry, indexEntryCacheKey,
  memoryIndexEntry } from "../../recall/conditional-field/index-view.js";
import { SoulInterpretationRequestSchema, SoulInterpretationResponseSchema } from "../../surfaces/mcp-interpretation-types.js";
import { SourceSemanticQuerySchema } from "../../recall/conditional-field/semantic-query.js";
import { SourceDisclosureSchema } from "../../recall/source-disclosure.js";
import {
  SourceSemanticWorkerRequestSchema, SourceSemanticWorkerResultSchema,
  SourceSemanticLibraryContinuationSchema, SourceSemanticLibraryDeliverySchema, SourceSemanticLibraryProofSchema,
  SOURCE_SEMANTIC_LIBRARY_PROTOCOL_VERSION, SOURCE_SEMANTIC_LIBRARY_RESULT_VERSION, SOURCE_SEMANTIC_LIBRARY_PAGE_BUDGET,
  sourceSemanticProofQualifier, verifySourceSemanticLibraryDelivery
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

it("accepts historical disclosure bytes while binding disclosed source time to a checked record", () => {
  expect(SourceDisclosureSchema.safeParse(disclosure).success).toBe(true);
  expect(SourceDisclosureSchema.safeParse({ ...disclosure,
    source_time: { kind: "unknown", reason: "unbound" } }).success).toBe(true);
  expect(SourceDisclosureSchema.safeParse({ ...disclosure,
    source_time: { kind: "known", at: "2024-02-03T04:05:06Z" } }).success).toBe(false);
  const checked = { ...disclosure, source_binding: "checked_record",
    validity: { kind: "unknown", reason: "not_recorded" } };
  expect(SourceDisclosureSchema.safeParse({ ...checked,
    source_time: { kind: "known", at: "2024-02-03T04:05:06Z" } }).success).toBe(true);
  expect(SourceDisclosureSchema.safeParse({ ...checked,
    source_time: { kind: "unknown", reason: "unbound" } }).success).toBe(false);
});
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

it("admits bounded navigation hints only on query-conditioned preparation on public and worker surfaces", () => {
  const request = { original_query: "Why delayed?", budget };
  for (const input of [{}, { access_hint: "Harbor" }, { access_hint: "x".repeat(1024) }]) {
    expect(SoulInterpretationRequestSchema.safeParse({ operation: "prepare_query", ...request, ...input }).success).toBe(true);
    expect(SourceSemanticWorkerRequestSchema.safeParse({ kind: "prepare_query", ...request, ...input }).success).toBe(true);
  }
  for (const input of [{ access_hint: "" }, { access_hint: " \n\t" }, { access_hint: "x".repeat(1025) },
    { access_hint: "Harbor", source_handle: "source" }, { access_hint: "Harbor", access_policy: "canonical-v1" }]) {
    expect(SoulInterpretationRequestSchema.safeParse({ operation: "prepare_query", ...request, ...input }).success).toBe(false);
    expect(SourceSemanticWorkerRequestSchema.safeParse({ kind: "prepare_query", ...request, ...input }).success).toBe(false);
  }
  const recall = { ...request, access_hint: "Harbor", accepts_unreviewed_conditional_results: true, output_byte_limit: 1024 };
  expect(SoulInterpretationRequestSchema.safeParse({ operation: "recall", ...recall }).success).toBe(false);
  expect(SourceSemanticWorkerRequestSchema.safeParse({ kind: "recall", ...recall }).success).toBe(false);
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

const otherDigest = `sha256:${"b".repeat(64)}`;
it.each<{ label: string; representation?: SourceRepresentation }>([
  { label: "historical unknown" },
  { label: "retained excerpt", representation: { kind: "retained_excerpt" } },
  { label: "canonical projection", representation: { kind: "canonical_projection", source_record_ids: [digest, otherDigest] } }
])("verifies $label unproved source identity and rejects substituted identity material", ({ representation }) => {
  const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
  const source = { workspace_id: "workspace", source_id: "canonical-source", source_version: "v1", content_digest: digest,
    ...(representation === undefined ? {} : { source_representation: representation }) };
  const identity = hashSourceRecordId(source, sha256);
  const entry = sourceIndexEntry({ ...source, root_kind: "source_record", root_id: identity, evidence_object_id: null,
    hypothesis_id: digest, output_binding: "binding", role: "requested", association_milligrades: 0,
    claim: "unknown", explanation_ids: [] });
  const { coverage: _coverage, work: _work, ...base } = libraryDelivery();
  const raw = { ...base, total_count: 1,
    query_semantics_status: { status: "admitted", query_semantics_id: digest },
    index: { ...base.index, entries: [entry] },
    slot_qualifiers: [{ index: 0, evidence_kind: "source_evidence" }],
    source_disclosures: { [indexEntryCacheKey(entry)]: disclosure },
    unproved_computations: [{ kind: "complete_zero_binding", conclusion_scope: "conditional_on_interpretation",
      world_claim: "unknown", source_record: { ...source, identity }, source_interpretation_id: digest,
      query_semantics_id: digest, semantic_correspondence_id: digest, conditional_computation_id: digest,
      completeness: base.index.completeness }]
  };
  const valid = SourceSemanticLibraryDeliverySchema.parse(raw);
  expect(verifySourceSemanticLibraryDelivery(valid, sha256)).toBe(valid);
  const computation = valid.unproved_computations![0]!;
  expect(computation.source_record).toEqual({ ...source, identity });
  expect(() => verifySourceSemanticLibraryDelivery({ ...valid, unproved_computations: [{ ...computation,
    source_record: { ...computation.source_record, source_id: "substituted-source" }
  }] }, sha256)).toThrow(/unproved source record/u);
  if (representation !== undefined) {
    const { source_representation: _representation, ...withoutRepresentation } = computation.source_record;
    for (const tampered of [withoutRepresentation,
      { ...computation.source_record, source_representation: { kind: "original_body" as const } },
      ...(representation.kind === "canonical_projection" ? [{ ...computation.source_record,
        source_representation: { ...representation, source_record_ids: [...representation.source_record_ids].reverse() } }] : [])]) {
      expect(() => verifySourceSemanticLibraryDelivery({ ...valid, unproved_computations: [{ ...computation,
        source_record: tampered }] }, sha256)).toThrow(/unproved source record/u);
    }
  }
  const capsule = sourceIndexEntry({ ...source, root_kind: "evidence_capsule", root_id: identity, evidence_object_id: null,
    hypothesis_id: digest, output_binding: "binding", role: "requested", association_milligrades: 0,
    claim: "unknown", explanation_ids: [] });
  expect(SourceSemanticLibraryDeliverySchema.safeParse({ ...raw, index: { ...raw.index, entries: [capsule] },
    source_disclosures: { [indexEntryCacheKey(capsule)]: disclosure } }).success).toBe(false);
});
const secondCorrespondence = `sha256:${"c".repeat(64)}`;
function sourceEntry(explanationIds: readonly string[] = []) {
  return sourceIndexEntry({ workspace_id: "workspace", root_kind: "source_record", root_id: "record",
    source_version: "v1", content_digest: digest, evidence_object_id: null,
    hypothesis_id: digest, output_binding: "binding", role: "requested", association_milligrades: 0,
    claim: "unknown", explanation_ids: explanationIds });
}
function proofBearingEntry() {
  return IndexEntrySchema.parse({
    ...sourceEntry(["e1"]),
    interpretation_node: { packet_id: digest, hypothesis_id: digest, node_id: "n1" }
  });
}
function libraryProof(input: { correspondenceId?: string; rootId?: string } = {}) {
  const correspondenceId = input.correspondenceId ?? digest;
  const rootId = input.rootId ?? "record";
  const node = { packet_id: digest, hypothesis_id: digest, node_id: "n1" };
  return SourceSemanticLibraryProofSchema.parse({
    contract: "source-interpretation-reasoning-v5", outcome: { status: "interpreted", gaps: [] },
    conditional_computation_id: digest, source_interpretation_id: digest, query_semantics_id: digest,
    semantic_correspondence_id: correspondenceId, consumed_leaves: [],
    binding_results: [{ kind: "answer", binding_id: "binding", alternative: 0, bindings: { actor: node },
      returned: { actor: node }, explanation_ids: ["e1"], query_complete: true }],
    source_target: { kind: "source_evidence", workspace_id: "workspace", root_kind: "source_record", root_id: rootId,
      source_version: "v1", content_digest: digest, evidence_object_id: null },
    semantic_status: "unreviewed", conclusion_scope: "conditional_on_interpretation", world_claim: "unknown",
    original_query: "Alice uses tools?",
    source_record: {
      producer: "span", consumer: "projection_generation", identity: digest, replay_rule: "idempotent_same_identity",
      failure_disposition: "fail_closed", governance_effect: "none", deletion_behavior: "retain_identity",
      schema_version: 1, workspace_id: "workspace", source_id: "src", source_version: "v1", content_digest: digest,
      evidence_object_id: null, recorded_at: "2026-09-25T00:00:00Z", event_time: null, valid_from: null, valid_to: null,
      operator_id: "span"
    },
    interpretation: {
      contract: "source-interpretation-v4", k_version: "k1", normalizer_version: "n1",
      source: { source_id: "src", source_version: "v1", content_digest: digest,
        attribution_context: UNKNOWN_UTTERANCE_ATTRIBUTION },
      producer_id: "producer", producer_version: "p1", contract_version: "source-interpretation-v4",
      mentions: [{ id: "mUse", assertion_id: 1, source_ref: { first: "a1s0", last: "a1s0" }, text: "use", utf8_span: [0, 3] }],
      referents: [{ id: "rActor", referent_kind: "grouped", mentions: ["mUse"] }],
      frames: [{ id: "fUse", assertion_ids: [1], context_owner: { kind: "source_act", source_act: "assertion" },
        additional_support: [], predicate_support: { kind: "explicit", reading: "use", mentions: ["mUse"] },
        slots: [{ id: "agent", role_reading: "agent", support: [{ kind: "lexical", mentions: ["mUse"] }] }],
        bindings: [{ slot_id: "agent", target: { kind: "node", id: "rActor" }, support: [] }] }],
      operators: [], gaps: [], entry_roots: ["fUse"], asserted_at_scope: ["fUse"]
    },
    query: validQuery,
    semantic_correspondence: {
      contract: "source-semantic-correspondence-v3", source_interpretation_id: digest, query_semantics_id: digest,
      producer_id: "ap", producer_version: "1", contract_version: "source-semantic-correspondence-v3",
      correspondences: [{ relation: "contextual_equivalence",
        query_endpoint: { kind: "predicate", alternative: 0, frame: "qUse" },
        source_endpoint: { kind: "frame", frame: "fUse" },
        query_support: { kind: "query_text", excerpt: "use" },
        source_semantic_support: [{ kind: "lexical", mentions: ["mUse"] }] }]
    },
    context: { contract: "source-semantic-context-v3", source_interpretation_id: digest, query_semantics_id: digest,
      semantic_correspondence_id: correspondenceId, k_version: "k1", lowering_version: "l1" }
  });
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
    coverage: { ...coverage, query_semantics: "complete" }, slot_qualifiers: [proofSlot] })).toEqual([false, false]);
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

it("requires each semantic proof qualifier to occupy a delivered source slot", () => {
  const delivery = libraryDelivery();
  const accepts = (value: Record<string, unknown>) => [
    SourceSemanticWorkerResultSchema.safeParse({ kind: "recall", ...value }).success,
    SoulInterpretationResponseSchema.safeParse({ operation: "recall", results: [], provider_attempts: 0, ...value }).success
  ];
  const proofSlot = (index: number, correspondenceId = digest) => ({
    index, evidence_kind: "semantic_proof", source_interpretation_id: digest,
    query_semantics_id: digest, semantic_correspondence_id: correspondenceId, conditional_computation_id: digest,
    witnesses: [{ conditional_computation_id: digest, binding_id: "binding" }],
    support: { answer: "open", evidence_inputs: [], operation: "not_requested", compatibility: "unknown", distinctness: "unknown" }
  });
  const entry = sourceEntry();
  const key = indexEntryCacheKey(entry);
  const occupied = {
    ...delivery, total_count: 1,
    query_semantics_status: { status: "admitted", query_semantics_id: digest },
    coverage: { ...coverage, query_semantics: "complete" },
    index: { ...delivery.index, entries: [entry] }
  };
  const sourceOnlyDisclosure = { ...disclosure, material_kind: "original_body" };
  const proofDisclosure = { ...sourceOnlyDisclosure,
    proof_use: { kind: "conditional_support", qualification: "not_world_claim" } };
  const memory = memoryIndexEntry({ workspace_id: "workspace", object_id: "memory", source_revision: "v1",
    association_milligrades: 0 });
  expect(accepts({ ...delivery, query_semantics_status: { status: "admitted", query_semantics_id: digest },
    coverage: { ...coverage, query_semantics: "complete" }, slot_qualifiers: [proofSlot(0)] })).toEqual([false, false]);
  expect(accepts({ ...occupied, slot_qualifiers: [proofSlot(1)],
    source_disclosures: { [key]: sourceOnlyDisclosure } })).toEqual([false, false]);
  expect(accepts({
    ...occupied, index: { ...occupied.index, entries: [memory] },
    slot_qualifiers: [proofSlot(0)],
    source_disclosures: { [indexEntryCacheKey(memory)]: proofDisclosure }
  })).toEqual([false, false]);
  expect(accepts({ ...occupied,
    slot_qualifiers: [{ index: 0, evidence_kind: "source_evidence" }, proofSlot(0)],
    source_disclosures: { [key]: sourceOnlyDisclosure } })).toEqual([false, false]);
  expect(accepts({ ...occupied,
    slot_qualifiers: [{ index: 0, evidence_kind: "source_evidence" }, proofSlot(0)],
    source_disclosures: { [key]: proofDisclosure } })).toEqual([false, false]);
  expect(accepts({ ...occupied, slot_qualifiers: [proofSlot(0)],
    source_disclosures: { [key]: proofDisclosure } })).toEqual([false, false]);
  expect(accepts({ ...occupied, slot_qualifiers: [proofSlot(0), proofSlot(0, secondCorrespondence)],
    source_disclosures: { [key]: proofDisclosure } })).toEqual([false, false]);
  expect(accepts({ ...occupied, slot_qualifiers: [{ index: 0, evidence_kind: "source_evidence" }],
    source_disclosures: { [key]: sourceOnlyDisclosure } })).toEqual([true, true]);
});

it("requires proof qualifiers to bind delivered proof premises on a proof-bearing source slot", () => {
  const delivery = libraryDelivery();
  const accepts = (value: Record<string, unknown>) => [
    SourceSemanticWorkerResultSchema.safeParse({ kind: "recall", ...value }).success,
    SoulInterpretationResponseSchema.safeParse({ operation: "recall", results: [], provider_attempts: 0, ...value }).success
  ];
  const entry = proofBearingEntry();
  const key = indexEntryCacheKey(entry);
  const proof = libraryProof();
  const second = libraryProof({ correspondenceId: secondCorrespondence });
  const occupied = {
    ...delivery, total_count: 1,
    query_semantics_status: { status: "admitted", query_semantics_id: digest },
    coverage: { ...coverage, query_semantics: "complete" },
    index: { ...delivery.index, entries: [entry] }
  };
  const proofDisclosure = { ...disclosure, material_kind: "original_body",
    proof_use: { kind: "conditional_support", qualification: "not_world_claim" } };
  const bound = { ...occupied, proofs: [proof], source_disclosures: { [key]: proofDisclosure } };
  const qualifier = sourceSemanticProofQualifier(proof, 0);
  expect(accepts({ ...bound, slot_qualifiers: [qualifier] })).toEqual([true, true]);
  expect(accepts({ ...bound, slot_qualifiers: [{ ...qualifier, payload_support: "available",
    selection_basis: "direct_answer" }] })).toEqual([true, true]);
  expect(accepts({ ...occupied, proofs: [proof, second], slot_qualifiers: [
    sourceSemanticProofQualifier(proof, 0), sourceSemanticProofQualifier(second, 0)
  ], source_disclosures: { [key]: proofDisclosure } })).toEqual([true, true]);
  expect(accepts({ ...occupied, slot_qualifiers: [qualifier],
    source_disclosures: { [key]: proofDisclosure } })).toEqual([false, false]);
  expect(accepts({ ...bound, slot_qualifiers: [{ ...qualifier, source_interpretation_id: otherDigest }] })).toEqual([false, false]);
  expect(accepts({ ...bound, slot_qualifiers: [{ ...qualifier,
    witnesses: [{ conditional_computation_id: digest, binding_id: "forged" }] }] })).toEqual([false, false]);
  expect(accepts({ ...bound, slot_qualifiers: [{ ...qualifier,
    support: { ...qualifier.support!, answer: "open" } }] })).toEqual([false, false]);
  expect(accepts({ ...occupied, proofs: [libraryProof({ rootId: "other" })], slot_qualifiers: [
    sourceSemanticProofQualifier(libraryProof({ rootId: "other" }), 0)
  ], source_disclosures: { [key]: proofDisclosure } })).toEqual([false, false]);
  expect(accepts({ ...occupied, proofs: [proof], slot_qualifiers: [{ index: 0, evidence_kind: "source_evidence" }],
    source_disclosures: { [key]: { ...disclosure, material_kind: "original_body" } } })).toEqual([true, true]);
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
