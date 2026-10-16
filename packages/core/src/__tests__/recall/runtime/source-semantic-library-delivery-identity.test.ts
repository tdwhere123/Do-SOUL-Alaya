import { expect, it } from "vitest";
import { SourceSemanticWorkerResultSchema, hashSourceRecordId, indexEntryCacheKey, sourceIndexEntry,
  SOURCE_SEMANTIC_LIBRARY_PROTOCOL_VERSION, SOURCE_SEMANTIC_LIBRARY_RESULT_VERSION } from "@do-soul/alaya-protocol";
import { fieldContractSha256 } from "../../../shared/field-hash.js";
import { encodeSourceSemanticLibraryResponse, SOURCE_SEMANTIC_LIBRARY_ORDER } from
  "../../../recall/runtime/source-semantic-library-recall.js";

it("checks unproved source identity before encoding the public library response", () => {
  const digest = `sha256:${"a".repeat(64)}`;
  const source = { workspace_id: "workspace", source_id: "source", source_version: "v1", content_digest: digest };
  const identity = hashSourceRecordId(source, fieldContractSha256);
  const entry = sourceIndexEntry({ ...source, root_kind: "source_record", root_id: identity, evidence_object_id: null,
    hypothesis_id: digest, output_binding: "source-evidence", role: "requested", association_milligrades: 0,
    claim: "unknown", explanation_ids: [] });
  const completeness = { schema_version: 1, logical_index: "complete", observed_coverage: "complete",
    transport: "complete", payload: "complete", representation: "complete" };
  const result = SourceSemanticWorkerResultSchema.parse({ kind: "recall", delivery_id: "delivery", request_identity: digest,
    query_semantics_status: { status: "admitted", query_semantics_id: digest },
    protocol_version: SOURCE_SEMANTIC_LIBRARY_PROTOCOL_VERSION, total_count: 1, page_purpose: "membership",
    index: { schema_version: 1, query_id: "query", snapshot_id: digest, result_version: SOURCE_SEMANTIC_LIBRARY_RESULT_VERSION,
      entries: [entry], completeness, continuation: null, page_purpose: "membership",
      representation: { schema_version: 1, policy: "construct_index_then_page_then_payload", page_budget: 5, identity_tie_break: "serialization" } },
    discovery: { eligible_source_count: 1, visited_source_pages: 1, visited_source_interpretation_pages: 1,
      visited_source_interpretation_descriptors: 0, candidate_prefix: [], examined_source_interpretation_ids: [],
      unexamined_source_interpretation_count: 0, omitted_duplicate_bindings: 0, examination_cap: 32, open_residuals: false, truncated: false },
    order: SOURCE_SEMANTIC_LIBRARY_ORDER, slot_qualifiers: [{ index: 0, evidence_kind: "source_evidence" }],
    source_disclosures: { [indexEntryCacheKey(entry)]: [1, "original_body", "checked_record", null, "2026-10-13T00:00:00Z", null,
      { kind: "unknown", reason: "not_recorded" }, "unknown", { kind: "source_only", qualification: "not_current_proof" }] },
    unproved_computations: [{ kind: "complete_zero_binding", conclusion_scope: "conditional_on_interpretation", world_claim: "unknown",
      source_record: { ...source, identity }, source_interpretation_id: digest, query_semantics_id: digest,
      semantic_correspondence_id: digest, conditional_computation_id: digest, completeness }],
    previews: { [indexEntryCacheKey(entry)]: "Source bytes" },
    coverage: { discovery: "complete", source_interpretation: "complete", query_semantics: "complete",
      semantic_correspondence: "complete", conditional_computation: "complete", payload: "complete" },
    work: { native_work: 1, native_bytes: 12, logical_memory_bytes: 12, rss_bytes: 0 },
    execution: "native_reasoning_only"
  });
  if (result.kind !== "recall") throw new Error("expected library result");
  expect(encodeSourceSemanticLibraryResponse(result)).toMatchObject({
    operation: "recall", total_count: 1, execution: "native_reasoning_only"
  });
  expect(() => encodeSourceSemanticLibraryResponse({ ...result, execution: undefined }))
    .toThrow(/requires actual execution accounting/u);
  const computation = result.unproved_computations![0]!;
  expect(() => encodeSourceSemanticLibraryResponse({ ...result, unproved_computations: [{ ...computation,
    source_record: { ...computation.source_record, source_id: "substituted-source" }
  }] })).toThrow(/unproved source record/u);
});
