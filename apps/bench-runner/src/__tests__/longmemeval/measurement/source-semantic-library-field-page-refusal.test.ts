import { afterAll, describe, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
afterAll(() => { isolation.restore(); expect(isolation.violations).toEqual([]); });
import {
  ContinuationSchema, MemorySearchResultSchema, ORDINARY_NATIVE_FIELD_RESULT_VERSION,
  SOURCE_SEMANTIC_FIELD_LIBRARY_PROTOCOL_VERSION, SOURCE_SEMANTIC_LIBRARY_EXAMINATION_CAP,
  SoulInterpretationFieldRecallDeliverySchema, SourceSemanticFieldLibraryWorkerResultSchema,
  encodeSourceDisclosure, indexEntryCacheKey,
  memoryIndexEntry, sourceIndexEntry, sourceSemanticExecution
} from "@do-soul/alaya-protocol";
import { encodeSourceSemanticLibraryResponse } from "@do-soul/alaya-core";
import { CLOCK, DIGEST, GOLD, REQUEST, assemble, sourceOnly, workerRecall } from "./source-semantic-library-measurement-fixture.js";
import { recordSourceSemanticLibraryFirstExposure } from "../../../runs/measurement/source-semantic-library-recall.js";
import {
  admitSourceSemanticLibraryContinuation, admitSourceSemanticLibraryResponse,
  measureSourceSemanticLibraryResponse
} from "../../../runs/measurement/source-semantic-library-measurement.js";

const memoryEntry = memoryIndexEntry({ workspace_id: "ws", object_id: "memory-1",
  source_revision: "v1", association_milligrades: 400 });
const sourceEntry = sourceIndexEntry({ workspace_id: "ws", root_kind: "source_record",
  root_id: "record-1", source_version: "1", content_digest: DIGEST, evidence_object_id: null,
  association_milligrades: 300 });
const sourceRowDisclosure = encodeSourceDisclosure({ material_kind: "original_body",
  source_binding: "checked_record", evaluated_as_of: CLOCK,
  validity: { kind: "unknown", reason: "not_recorded" }, temporal_state: "unknown",
  proof_use: { kind: "source_only", qualification: "not_current_proof" } });

function memoryRow() {
  return MemorySearchResultSchema.parse({ target: memoryEntry.target, relevance_score: 0.5,
    content_preview: "memory preview", evidence_pointers: [], selection_reason: "native query order",
    source_channels: ["conditional_field"], score_factors: { activation: 0.5, relevance: 0.5 },
    budget_state: { token_estimate: 1, max_entries: 2, max_total_tokens: 10,
      remaining_entries: 1, remaining_tokens: 9, within_budget: true },
    object_id: memoryEntry.object_id, object_kind: "memory_entry",
    hypothesis_id: memoryEntry.hypothesis_id, output_binding: memoryEntry.output_binding,
    program_state: "accept", time_state: "as_of" });
}

function sourceRow() {
  return MemorySearchResultSchema.parse({ target: sourceEntry.target, relevance_score: 0.5,
    content_preview: "source preview", evidence_pointers: [], selection_reason: "native query order",
    source_channels: ["conditional_field"], score_factors: { activation: 0.5, relevance: 0.5 },
    budget_state: { token_estimate: 1, max_entries: 2, max_total_tokens: 10,
      remaining_entries: 1, remaining_tokens: 9, within_budget: true },
    object_kind: "source_evidence", source_disclosure: sourceRowDisclosure,
    hypothesis_id: sourceEntry.hypothesis_id, output_binding: sourceEntry.output_binding,
    program_state: "accept", time_state: "as_of" });
}

/** A current field library page: tagged memory + source targets in delivered order. */
function fieldDelivery() {
  return {
    delivery_id: "field-delivery", request_identity: DIGEST,
    query_semantics_status: { status: "unavailable", reason: "absent" },
    protocol_version: SOURCE_SEMANTIC_FIELD_LIBRARY_PROTOCOL_VERSION, total_count: 2,
    index: { schema_version: 1, query_id: "field-query", snapshot_id: DIGEST,
      interpretation_id: "field-interpretation", as_of: CLOCK,
      result_version: ORDINARY_NATIVE_FIELD_RESULT_VERSION, entries: [memoryEntry, sourceEntry],
      completeness: { schema_version: 1, logical_index: "complete",
        observed_coverage: "complete", transport: "complete", payload: "complete",
        representation: "complete" },
      continuation: null, representation: { schema_version: 1,
        policy: "construct_index_then_page_then_payload", page_budget: 2,
        identity_tie_break: "serialization" },
      page_purpose: "membership" },
    results: [memoryRow(), sourceRow()], page_purpose: "membership",
    discovery: { eligible_source_count: 1, visited_source_pages: 1,
      visited_source_interpretation_pages: 1, visited_source_interpretation_descriptors: 0,
      candidate_prefix: [], examined_source_interpretation_ids: [],
      unexamined_source_interpretation_count: 0, omitted_duplicate_bindings: 0,
      examination_cap: SOURCE_SEMANTIC_LIBRARY_EXAMINATION_CAP,
      open_residuals: false, truncated: false },
    order: { enumeration_policy: "native_query", tie_policy: "canonical_identity",
      occupancy: "tagged_target_identity", occupancy_prefix: 2, page_budget: 2 },
    slot_qualifiers: [{ index: 1, evidence_kind: "source_evidence" }],
    source_disclosures: { [indexEntryCacheKey(sourceEntry)]: sourceRowDisclosure },
    coverage: { discovery: "complete", source_interpretation: "unexercised",
      query_semantics: "unexercised", semantic_correspondence: "unexercised",
      conditional_computation: "unexercised", payload: "complete" },
    work: { native_work: 1, native_bytes: 2, logical_memory_bytes: 3, rss_bytes: 4 },
    execution: sourceSemanticExecution(),
    request_budget: REQUEST
  };
}

function fieldWorkerPage() {
  return SourceSemanticFieldLibraryWorkerResultSchema.parse({ kind: "recall", ...fieldDelivery() });
}

function fieldPublicPage() {
  return SoulInterpretationFieldRecallDeliverySchema.parse({ operation: "recall", ...fieldDelivery() });
}

describe("current tagged field pages are unsupported by the v3/v4 measurement", () => {
  it("refuses a schema-admitted worker field page as an invalid response", () => {
    const page = fieldWorkerPage();
    const exposure = recordSourceSemanticLibraryFirstExposure({ delivery_id: page.delivery_id,
      index: page.index, results: page.results, total_count: page.total_count });
    const input = { recallResult: page, firstExposurePage: exposure,
      requestBudget: REQUEST, goldSourceUnits: [GOLD] };
    // Refused as invalid, never as a measured-empty page.
    expect(admitSourceSemanticLibraryResponse(input))
      .toEqual({ schema_version: 1, status: "invalid", reason: "invalid_response" });
    expect(measureSourceSemanticLibraryResponse(input).measurement)
      .toEqual({ schema_version: 1, status: "invalid", reason: "invalid_response" });
    expect(measureSourceSemanticLibraryResponse(input).validatedProofRanks).toEqual([]);
  });

  it("refuses a schema-admitted public field page as an invalid response", () => {
    const page = fieldPublicPage();
    const input = { recallResult: page, firstExposurePage: recordSourceSemanticLibraryFirstExposure({
      delivery_id: page.delivery_id, index: page.index, results: page.results,
      total_count: page.total_count }), requestBudget: REQUEST, goldSourceUnits: [GOLD] };
    expect(admitSourceSemanticLibraryResponse(input))
      .toEqual({ schema_version: 1, status: "invalid", reason: "invalid_response" });
    expect(measureSourceSemanticLibraryResponse(input)).toMatchObject({
      measurement: { status: "invalid", reason: "invalid_response" },
      sourceBearingUnion: null, validatedProofRanks: [] });
  });

  it("reports the unsupported family through the continuation caller instead of a continuation defect", () => {
    const page = fieldPublicPage();
    const input = { recallResult: page, firstExposurePage: recordSourceSemanticLibraryFirstExposure({
      delivery_id: page.delivery_id, index: page.index, results: page.results,
      total_count: page.total_count }), requestBudget: REQUEST };
    const continuation = ContinuationSchema.parse({ schema_version: 1,
      continuation_id: "field-page-2", query_id: page.index.query_id, snapshot_id: DIGEST,
      result_version: ORDINARY_NATIVE_FIELD_RESULT_VERSION,
      expires_at: "2099-01-01T00:00:00.000Z", cursor: "offset-2",
      enumeration_policy: "native_query" });
    expect(admitSourceSemanticLibraryContinuation({ ...input, previous: input,
      requestContinuation: continuation, requestIdentity: page.request_identity }))
      .toEqual({ schema_version: 1, status: "invalid", reason: "invalid_response" });
  });

  it("keeps the archived protocol 8 worker and public deliveries measurable", () => {
    const worker = workerRecall(assemble([sourceOnly("gold")], []));
    const exposure = recordSourceSemanticLibraryFirstExposure(worker);
    const input = { firstExposurePage: exposure, requestBudget: REQUEST, goldSourceUnits: [GOLD] };
    expect(admitSourceSemanticLibraryResponse({ ...input, recallResult: worker }))
      .toMatchObject({ status: "admitted" });
    expect(admitSourceSemanticLibraryResponse({ ...input,
      recallResult: encodeSourceSemanticLibraryResponse(worker) })).toMatchObject({ status: "admitted" });
    expect(measureSourceSemanticLibraryResponse({ ...input, recallResult: worker }).measurement)
      .toMatchObject({ status: "validated", contract: "source-semantic-library-delivered-slots-v3" });
  });
});
