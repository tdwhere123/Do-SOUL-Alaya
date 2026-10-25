import { afterAll, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
afterAll(() => { isolation.restore(); expect(isolation.violations).toEqual([]); });
import {
  MemorySearchResultSchema, ORDINARY_NATIVE_FIELD_RESULT_VERSION, SOURCE_SEMANTIC_FIELD_LIBRARY_PROTOCOL_VERSION,
  SOURCE_SEMANTIC_LIBRARY_EXAMINATION_CAP, SoulInterpretationFieldRecallDeliverySchema,
  encodeSourceDisclosure, indexEntryCacheKey, sourceIndexEntry, sourceSemanticExecution
} from "@do-soul/alaya-protocol";
import { encodeSourceSemanticLibraryResponse } from "@do-soul/alaya-core";
import { ReplayRowSchema, ReplaySchema } from "../../../runs/recall-measurement/replay.js";
import { CLOCK, DIGEST, assemble, sourceOnly, workerRecall } from "../../longmemeval/measurement/source-semantic-library-measurement-fixture.js";

// The recorded replay row keeps one response rule: the public interpretation
// response family. These fixtures are the archived producer (protocol 8) and the
// current tagged field page; nothing here re-ranks either delivery.
const archivedResponse = encodeSourceSemanticLibraryResponse(workerRecall(assemble([sourceOnly("gold")], [])));

const fieldEntry = sourceIndexEntry({ workspace_id: "ws", root_kind: "source_record", root_id: "record-1",
  source_version: "1", content_digest: DIGEST, evidence_object_id: null, association_milligrades: 300 });
const fieldDisclosure = encodeSourceDisclosure({ material_kind: "original_body", source_binding: "checked_record",
  evaluated_as_of: CLOCK, validity: { kind: "unknown", reason: "not_recorded" }, temporal_state: "unknown",
  proof_use: { kind: "source_only", qualification: "not_current_proof" } });
const fieldResponse = SoulInterpretationFieldRecallDeliverySchema.parse({
  delivery_id: "field-delivery", request_identity: DIGEST,
  query_semantics_status: { status: "unavailable", reason: "absent" },
  protocol_version: SOURCE_SEMANTIC_FIELD_LIBRARY_PROTOCOL_VERSION, total_count: 1,
  index: { schema_version: 1, query_id: "field-query", snapshot_id: DIGEST,
    interpretation_id: "field-interpretation", as_of: CLOCK,
    result_version: ORDINARY_NATIVE_FIELD_RESULT_VERSION, entries: [fieldEntry],
    completeness: { schema_version: 1, logical_index: "complete", observed_coverage: "complete",
      transport: "complete", payload: "complete", representation: "complete" },
    continuation: null,
    representation: { schema_version: 1, policy: "construct_index_then_page_then_payload",
      page_budget: 1, identity_tie_break: "serialization" },
    page_purpose: "membership" },
  results: [MemorySearchResultSchema.parse({ target: fieldEntry.target, relevance_score: 0.5,
    content_preview: "source preview", evidence_pointers: [], selection_reason: "native query order",
    source_channels: ["conditional_field"], score_factors: { activation: 0.5, relevance: 0.5 },
    budget_state: { token_estimate: 1, max_entries: 1, max_total_tokens: 10,
      remaining_entries: 0, remaining_tokens: 9, within_budget: true },
    object_kind: "source_evidence", source_disclosure: fieldDisclosure,
    hypothesis_id: fieldEntry.hypothesis_id, output_binding: fieldEntry.output_binding,
    program_state: "accept", time_state: "as_of" })],
  page_purpose: "membership",
  discovery: { eligible_source_count: 1, visited_source_pages: 1,
    visited_source_interpretation_pages: 1, visited_source_interpretation_descriptors: 0,
    candidate_prefix: [], examined_source_interpretation_ids: [],
    unexamined_source_interpretation_count: 0, omitted_duplicate_bindings: 0,
    examination_cap: SOURCE_SEMANTIC_LIBRARY_EXAMINATION_CAP, open_residuals: false, truncated: false },
  order: { enumeration_policy: "native_query", tie_policy: "canonical_identity",
    occupancy: "tagged_target_identity", occupancy_prefix: 1, page_budget: 1 },
  slot_qualifiers: [{ index: 0, evidence_kind: "source_evidence" }],
  source_disclosures: { [indexEntryCacheKey(fieldEntry)]: fieldDisclosure },
  operation: "recall",
  coverage: { discovery: "complete", source_interpretation: "unexercised",
    query_semantics: "unexercised", semantic_correspondence: "unexercised",
    conditional_computation: "unexercised", payload: "complete" },
  work: { native_work: 1, native_bytes: 2, logical_memory_bytes: 3, rss_bytes: 4 },
  execution: sourceSemanticExecution()
});

function replayRow(response: unknown) {
  return { query_key: "q1", status: "replayed" as const, response, first_exposure: null,
    correspondence_outcomes: [{ key: null, raw_digest: null }], preparation_trace: null,
    preparation_elapsed_ms: 1, native_elapsed_ms: 2 };
}

function replay(rows: unknown[]) {
  return { contract: "source-semantic-chain-replay-v3", plan_identity: "plan-identity",
    identity: "replay-identity", arm: "retained" as const, provider_calls: 0, rows };
}

it("decodes archived and current response families through the same replay row rule", () => {
  expect(ReplayRowSchema.safeParse(replayRow(archivedResponse)).success).toBe(true);
  expect(ReplayRowSchema.safeParse(replayRow(fieldResponse)).success).toBe(true);
  // The aggregate schema owns the same row instance; it is not a second rule.
  expect(ReplaySchema.safeParse(replay([replayRow(archivedResponse)])).success).toBe(true);
  expect(ReplaySchema.safeParse(replay([replayRow(fieldResponse)])).success).toBe(true);
  expect(ReplaySchema.parse(replay([replayRow(fieldResponse)])).rows[0]!.response)
    .toEqual(fieldResponse);
});

it("keeps row validation and rejection at the declared boundary", () => {
  for (const invalid of [
    { query_key: "q1" },
    { ...replayRow(archivedResponse), status: "ready" },
    { ...replayRow(archivedResponse), query_key: 1 },
    { ...replayRow(archivedResponse), response: { operation: "recall", protocol_version: 8 } },
    { ...replayRow(archivedResponse), response: { operation: "recall", protocol_version: 10 } },
    { ...replayRow(archivedResponse), response: { operation: "rerank" } },
    { ...replayRow(archivedResponse), preparation_elapsed_ms: -1 }
  ]) {
    expect(ReplayRowSchema.safeParse(invalid).success).toBe(false);
    expect(ReplaySchema.safeParse(replay([invalid])).success).toBe(false);
  }
});

it("preserves unvalidated passthrough row fields used by measurement", () => {
  const parsed = ReplayRowSchema.parse({ ...replayRow(archivedResponse), source_records: [] });
  expect(parsed.source_records).toEqual([]);
});
