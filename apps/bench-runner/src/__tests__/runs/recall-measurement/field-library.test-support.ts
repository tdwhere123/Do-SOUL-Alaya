import { MemorySearchResultSchema, ORDINARY_NATIVE_FIELD_RESULT_VERSION, SoulInterpretationFieldRecallDeliverySchema,
  SOURCE_SEMANTIC_FIELD_LIBRARY_PROTOCOL_VERSION, SOURCE_SEMANTIC_LIBRARY_EXAMINATION_CAP,
  encodeSourceDisclosure, indexEntryCacheKey, sourceIndexEntry, sourceSemanticExecution,
  type RequestBudget, type SourceRecordIdentity } from "@do-soul/alaya-protocol";

/** A new artificial field delivery, deliberately not a v6 source-gold archive. */
export function fieldLibraryPage(record: SourceRecordIdentity, budget: RequestBudget, clock: string, text: string) {
  const entry = sourceIndexEntry({ workspace_id: record.workspace_id, root_kind: "source_record", root_id: record.identity,
    source_version: record.source_version, content_digest: record.content_digest,
    evidence_object_id: record.evidence_object_id, association_milligrades: 300 });
  const disclosure = encodeSourceDisclosure({ material_kind: "original_body", source_binding: "checked_record",
    evaluated_as_of: clock, validity: { kind: "unknown", reason: "not_recorded" }, temporal_state: "unknown",
    proof_use: { kind: "source_only", qualification: "not_current_proof" } });
  const row = MemorySearchResultSchema.parse({ target: entry.target, relevance_score: 0.5, content_preview: text,
    evidence_pointers: [], selection_reason: "native query order", source_channels: ["conditional_field"],
    score_factors: { activation: 0.5, relevance: 0.5 }, budget_state: { token_estimate: 1, max_entries: 1,
      max_total_tokens: 10, remaining_entries: 0, remaining_tokens: 9, within_budget: true },
    object_kind: "source_evidence", source_disclosure: disclosure, hypothesis_id: entry.hypothesis_id,
    output_binding: entry.output_binding, program_state: "accept", time_state: "as_of" });
  return SoulInterpretationFieldRecallDeliverySchema.parse({ operation: "recall", delivery_id: "field-delivery",
    request_identity: `sha256:${"f".repeat(64)}`, query_semantics_status: { status: "unavailable", reason: "absent" },
    protocol_version: SOURCE_SEMANTIC_FIELD_LIBRARY_PROTOCOL_VERSION, total_count: 1,
    index: { schema_version: 1, query_id: "field-query", snapshot_id: `sha256:${"c".repeat(64)}`,
      interpretation_id: "field-interpretation", as_of: clock, result_version: ORDINARY_NATIVE_FIELD_RESULT_VERSION,
      entries: [entry], completeness: { schema_version: 1, logical_index: "complete", observed_coverage: "complete",
        transport: "complete", payload: "complete", representation: "complete" }, continuation: null,
      representation: { schema_version: 1, policy: "construct_index_then_page_then_payload", page_budget: 1,
        identity_tie_break: "serialization" }, page_purpose: "membership" }, results: [row], page_purpose: "membership",
    discovery: { eligible_source_count: 1, visited_source_pages: 1, visited_source_interpretation_pages: 1,
      visited_source_interpretation_descriptors: 0, candidate_prefix: [], examined_source_interpretation_ids: [],
      unexamined_source_interpretation_count: 0, omitted_duplicate_bindings: 0,
      examination_cap: SOURCE_SEMANTIC_LIBRARY_EXAMINATION_CAP, open_residuals: false, truncated: false },
    order: { enumeration_policy: "native_query", tie_policy: "canonical_identity", occupancy: "tagged_target_identity",
      occupancy_prefix: 1, page_budget: 1 }, slot_qualifiers: [{ index: 0, evidence_kind: "source_evidence" }],
    source_disclosures: { [indexEntryCacheKey(entry)]: disclosure }, coverage: { discovery: "complete",
      source_interpretation: "unexercised", query_semantics: "unexercised", semantic_correspondence: "unexercised",
      conditional_computation: "unexercised", payload: "complete" },
    work: { native_work: 1, native_bytes: 2, logical_memory_bytes: 3, rss_bytes: 4 },
    execution: sourceSemanticExecution(), request_budget: budget });
}
