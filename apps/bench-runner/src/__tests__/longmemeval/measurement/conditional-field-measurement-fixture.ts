import { compileConditionalFieldQuery, interpretationIdentity } from "@do-soul/alaya-core";
import { InformationIndexSchema, SoulMemorySearchResponseSchema, type MemorySearchResult } from "@do-soul/alaya-protocol";
import { FirstExposureSession } from "../../../runs/measurement/first-exposure-session.js";

export const NOW = "2026-09-08T00:00:00.000Z";
export const SNAPSHOT = `sha256:${"a".repeat(64)}`;
export const BUDGET = { schema_version: 1 as const, work_units: 10000, memory_bytes: 1000000,
  page_budget: 10, finalization_reserve: 100, min_envelope: 10 };
export const SECRET = "private source body must never appear in a measurement artifact";

export function conditionalFieldMeasurementFixture(ids = ["gold"] ) {
  const compile_input = { source: "ordinary" as const, text: "deployment checklist",
    snapshot_id: SNAPSHOT, budget: BUDGET, interpretation_clock: NOW };
  const query_id = compileConditionalFieldQuery(compile_input).query_id;
  const interpretation_id = interpretationIdentity({ interpretation_clock: NOW });
  const execution_receipt = { schema_version: 1 as const, workspace_id: "workspace", requested_budget: BUDGET,
    compile_input, query_id, interpretation_id, snapshot_id: SNAPSHOT, interpretation_clock: NOW };
  const index = InformationIndexSchema.parse({
    schema_version: 1, query_id, snapshot_id: SNAPSHOT, result_version: "v1",
    interpretation_id, as_of: NOW,
    entries: ids.map((object_id, offset) => ({ schema_version: 1, object_id,
      target: { kind: "memory_entry" as const, workspace_id: "workspace", object_id, source_revision: "rev" },
      hypothesis_id: `h${offset}`, output_binding: `binding${offset}`, role: "requested",
      association_milligrades: 850, claim: "unknown", explanation_ids: ["unresolved-explanation"],
      program_state: "matched", time_state: "current" })),
    completeness: { schema_version: 1, logical_index: "open", observed_coverage: "open",
      interpretation_coverage: "open", transport: "partial", payload: "complete", representation: "complete" },
    continuation: { schema_version: 1, continuation_id: "next", query_id,
      snapshot_id: SNAPSHOT, result_version: "v1", cursor: "cursor", expires_at: "2099-01-01T00:00:00.000Z",
      interpretation_id, interpretation_clock: NOW },
    representation: { schema_version: 1, policy: "construct_index_then_page_then_payload",
      page_budget: 10, identity_tie_break: "serialization" }
  });
  const results: MemorySearchResult[] = index.entries.map((entry) => ({
    object_id: entry.object_id, object_kind: "memory_entry", target: entry.target, relevance_score: 0.85,
    content_preview: SECRET, evidence_pointers: [], selection_reason: "observed association",
    hypothesis_id: entry.hypothesis_id, output_binding: entry.output_binding,
    program_state: entry.program_state, time_state: entry.time_state,
    source_channels: ["conditional_field"], score_factors: { activation: 0.85, relevance: 0.85 },
    budget_state: { token_estimate: 1, max_entries: 10, max_total_tokens: 2000,
      remaining_entries: 0, remaining_tokens: 0, within_budget: true }
  }));
  const recallResult = { delivery_id: "delivery", protocol_version: 1, index, results,
    total_count: results.length,
    provider_calls: 0, garden_enqueue: 0, request_budget: BUDGET, execution_receipt };
  const deliveredResults = results.slice(0, 10).map((row, offset) => ({
    object_id: row.object_id, target: row.target, object_kind: row.object_kind, rank: offset + 1, relevance_score: row.relevance_score
    , hypothesis_id: row.hypothesis_id, output_binding: row.output_binding, program_state: row.program_state, time_state: row.time_state
  }));
  return { recallResult: { ...recallResult, first_exposure_page: new FirstExposureSession().record(SoulMemorySearchResponseSchema.parse({ delivery_id: recallResult.delivery_id, protocol_version: 1, index, results, total_count: results.length })) }, deliveredResults, queryText: "deployment checklist", workspaceId: "workspace", referenceTime: NOW,
    expectedIndexSnapshotId: SNAPSHOT, requestBudget: BUDGET, recallLatencyMs: 12 };
}
