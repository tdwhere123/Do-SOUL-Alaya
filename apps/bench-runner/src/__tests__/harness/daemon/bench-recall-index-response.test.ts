import { describe, expect, it } from "vitest";
import { InformationIndexSchema, RecallCandidateSchema } from "@do-soul/alaya-protocol";
import { encodeIndexResults, frameEncodedIndex } from "@do-soul/alaya/recall/index-response";
import { buildBenchDiagnosticRecallPolicy } from "../../../harness/daemon/daemon-support.js";
import {
  buildBenchRecallResponse,
  encodeBenchRecallResults,
  validateBenchRecallIndex
} from "../../../harness/daemon/handle/bench-recall-response.js";

type Result = Parameters<typeof encodeBenchRecallResults>[0];
const policy = buildBenchDiagnosticRecallPolicy("surface", 2, false);
const budget = { schema_version: 1 as const, work_units: 10_000, memory_bytes: 1_000_000,
  page_budget: 2, finalization_reserve: 100, min_envelope: 10 };

function fixture(): Result {
  const index = InformationIndexSchema.parse({
    schema_version: 1, query_id: "query", snapshot_id: `sha256:${"a".repeat(64)}`,
    result_version: "v1", interpretation_id: "interpretation", as_of: "2026-09-06T00:00:00.000Z",
    entries: ["first", "second"].map((object_id) => ({
      schema_version: 1, object_id, hypothesis_id: "h0", output_binding: object_id,
      program_state: "accept", time_state: "as_of", role: "requested",
      association_milligrades: 850, claim: "unknown", explanation_ids: []
    })),
    completeness: { schema_version: 1, logical_index: "open", observed_coverage: "complete",
      interpretation_coverage: "open", transport: "complete", payload: "complete", representation: "complete" },
    continuation: null,
    representation: { schema_version: 1, policy: "construct_index_then_page_then_payload",
      page_budget: 2, identity_tie_break: "serialization" }
  });
  return {
    index, candidates: [], active_constraints: [], active_constraints_count: null,
    active_constraints_completeness: "incomplete", total_scanned: 0, coarse_filter_count: 0,
    fine_assessment_count: 0, degradation_reason: null, synthesis: { status: "absent" },
    provider_calls: 0, garden_enqueue: 0, working_projection: null
  };
}

describe("bench conditional field index response", () => {
  it("rejects a response representation that contradicts the sent budget before delivery encoding", () => {
    expect(() => encodeBenchRecallResults(fixture(), policy, { ...budget, page_budget: 1 }))
      .toThrow(/page budget differs/);
  });
  it("uses the normal MCP encoder and preserves product coordinates and incomplete constraints", () => {
    const result = fixture();
    const rows = encodeBenchRecallResults(result, policy);
    const response = buildBenchRecallResponse("delivery", rows, result, budget);
    expect(rows).toEqual(encodeIndexResults(result.index, new Map(), policy.fine_assessment.budgets.max_total_tokens));
    expect(response.index).toEqual(result.index);
    expect(response.results.map((row) => [row.object_id, row.hypothesis_id, row.output_binding,
      row.program_state, row.time_state])).toEqual([
      ["first", "h0", "first", "accept", "as_of"],
      ["second", "h0", "second", "accept", "as_of"]
    ]);
    expect(response.active_constraints_count).toBeNull();
    expect(response.active_constraints_completeness).toBe("incomplete");
    expect(response.provider_calls).toBe(0);
    expect(response.garden_enqueue).toBe(0);
    expect(response.request_budget).toEqual(budget);
    expect(response.strategy_mix.precomputed_rank).toBe(false);
    expect(response.strategy_mix.semantic_supplement).toBe(false);
  });

  it("keeps the raw logical index when the payload budget truncates encoding", () => {
    const result = fixture();
    const tight = { ...policy, fine_assessment: { ...policy.fine_assessment,
      budgets: { ...policy.fine_assessment.budgets, max_total_tokens: 20 } } };
    const rows = encodeBenchRecallResults(result, tight);
    const response = buildBenchRecallResponse("delivery", rows, result, budget);
    expect(rows).toHaveLength(1);
    expect(response.index).toEqual(frameEncodedIndex(result.index, rows));
    expect(response.index?.entries).toHaveLength(2);
    expect(response.index?.completeness.payload).toBe("omitted");
    expect(response.index?.completeness.logical_index).toBe("open");
  });

  it("copies source previews without allowing candidate order to replace the index order", () => {
    const result = {
      ...fixture(),
      candidates: ["second", "first"].map((object_id) => RecallCandidateSchema.parse({
        object_id, object_kind: "memory_entry", activation_score: 0.5, relevance_score: 0.5,
        content_preview: `preview ${object_id}`, token_estimate: 5,
        manifestation: "excerpt", dimension: "fact", scope_class: "project"
      }))
    };
    const rows = encodeBenchRecallResults(result, policy);
    expect(rows.map((row) => [row.object_id, row.content_preview])).toEqual([
      ["first", "preview first"], ["second", "preview second"]
    ]);
  });

  it("preserves pointer granularity and supplied warnings through the shared encoder", () => {
    const result = { ...fixture(), source_metadata: { first: {
      evidence_refs: ["source-capsule"],
      staged_warnings: [{ kind: "evidence_missing" as const, severity: "warning" as const,
        policy: "fixture", summary: "Needs review", resolution_options: ["request_evidence" as const] }]
    } } };
    const rows = encodeBenchRecallResults(result, policy);
    expect(rows[0]?.evidence_pointers).toEqual(["source-capsule"]);
    expect(rows[0]?.staged_warnings).toMatchObject([{ target_object_id: "first", kind: "evidence_missing" }]);
    expect(result.index.entries[0]?.explanation_ids).toEqual([]);
    const tight = { ...policy, fine_assessment: { ...policy.fine_assessment,
      budgets: { ...policy.fine_assessment.budgets, max_total_tokens: 20 } } };
    expect(encodeBenchRecallResults(result, tight)).toEqual([]);
  });

  it.each([undefined, {}, { ...fixture().index, snapshot_id: "unbound" }])(
    "rejects a missing or malformed index before accepting zero-call evidence", (index) => {
      expect(() => validateBenchRecallIndex({ ...fixture(), index } as Result)).toThrow();
    }
  );

  it.each([
    { provider_calls: undefined }, { provider_calls: 1 },
    { garden_enqueue: undefined }, { garden_enqueue: 1 }
  ])("does not invent zero calls for absent or contradictory counters", (counts) => {
    expect(() => validateBenchRecallIndex({ ...fixture(), ...counts } as Result))
      .toThrow(/observed zero/);
  });
});
