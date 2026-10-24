import { describe, expect, it } from "vitest";
import {
  ASSOCIATION_DOMAIN_ID,
  HARD_IDENTITY_TRANSFER_ID,
  HARD_IDENTITY_TRANSFER_VERSION,
  IDENTITY_NORMALIZATION_ID,
  InformationIndexSchema,
  RecallCandidateSchema,
  unavailableSourceQueryPreparation
} from "@do-soul/alaya-protocol";
import { runConditionalFieldRecallWithReceipt } from "@do-soul/alaya-core";
import { encodeIndexResults, frameEncodedIndex } from "@do-soul/alaya-core";
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

function fixture(enumerationPolicy?: "canonical" | "associative"): Result {
  const executed = runConditionalFieldRecallWithReceipt({
    workspace_id: "workspace", query_text: "needle", budget,
    snapshot_id: `sha256:${"a".repeat(64)}`,
    interpretation_clock: "2026-09-06T00:00:00.000Z", as_of: "2026-09-06T00:00:00.000Z",
    expires_at: "2099-01-01T00:00:00.000Z", readers: {},
    ...(enumerationPolicy === undefined ? {} : {
      enumeration_policy: enumerationPolicy,
      ...(enumerationPolicy === "associative" ? {
        cap_contracts: [{
          domain_id: ASSOCIATION_DOMAIN_ID,
          normalization: IDENTITY_NORMALIZATION_ID,
          transfer_id: HARD_IDENTITY_TRANSFER_ID,
          transfer_version: HARD_IDENTITY_TRANSFER_VERSION
        }]
      } : {})
    })
  });
  const index = InformationIndexSchema.parse({
    schema_version: 1, query_id: executed.execution_receipt.query_id, snapshot_id: executed.execution_receipt.snapshot_id,
    result_version: "v1", interpretation_id: executed.execution_receipt.interpretation_id, as_of: "2026-09-06T00:00:00.000Z",
    entries: ["first", "second"].map((object_id) => ({
      schema_version: 1, object_id, hypothesis_id: "h0", output_binding: object_id,
      target: { kind: "memory_entry" as const, workspace_id: "workspace", object_id, source_revision: "rev" },
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
    execution_receipt: executed.execution_receipt,
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
    expect(response.index).toEqual(frameEncodedIndex(result.index, rows));
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
    expect(response).not.toHaveProperty("strategy_mix");
  });

  it("keeps the raw logical index when the payload budget truncates encoding", () => {
    const result = fixture();
    const tight = { ...policy, fine_assessment: { ...policy.fine_assessment,
      budgets: { ...policy.fine_assessment.budgets, max_total_tokens: 2 } } };
    const rows = encodeBenchRecallResults(result, tight);
    const response = buildBenchRecallResponse("delivery", rows, result, budget);
    expect(rows.map((row) => row.object_id)).toEqual(["first", "second"]);
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
    const requiredMetadataBytes = Buffer.byteLength(JSON.stringify({
      evidencePointers: rows[0]!.evidence_pointers, stagedWarnings: rows[0]!.staged_warnings
    }));
    const tight = { ...policy, fine_assessment: { ...policy.fine_assessment,
      budgets: { ...policy.fine_assessment.budgets, max_total_tokens: requiredMetadataBytes } } };
    const tightRows = encodeBenchRecallResults(result, tight);
    expect(tightRows.map((row) => row.object_id)).toEqual(["first", "second"]);
    expect(tightRows.every((row) => row.content_preview === "[payload omitted]")).toBe(true);
    expect(tightRows[0]?.evidence_pointers).toEqual(rows[0]!.evidence_pointers);
    expect(tightRows[0]?.staged_warnings).toEqual(rows[0]!.staged_warnings);
    const insufficient = { ...tight, fine_assessment: { ...tight.fine_assessment,
      budgets: { ...tight.fine_assessment.budgets, max_total_tokens: requiredMetadataBytes - 1 } } };
    const omitted = encodeBenchRecallResults(result, insufficient);
    expect(omitted).toEqual([]);
    expect(frameEncodedIndex(result.index, omitted).completeness.payload).toBe("omitted");
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

  it("retains declared query preparation evidence instead of imputing a measured zero", () => {
    const base = fixture();
    const preparation = unavailableSourceQueryPreparation("acquisition_channel_not_requested", "not_requested");
    const result = { ...base,
      execution_receipt: { ...base.execution_receipt!, query_preparation: preparation } };
    const response = buildBenchRecallResponse("delivery", encodeBenchRecallResults(result, policy), result, budget);
    expect(response.execution_receipt.query_preparation).toEqual(preparation);
    expect(response.execution_receipt.query_preparation?.token_count).toBeNull();
    // A receipt whose preparation is unparseable is an execution refusal, never dropped or zeroed.
    const malformed = { ...base, execution_receipt: { ...base.execution_receipt!,
      query_preparation: { status: "ready" } } } as Result;
    expect(() => encodeBenchRecallResults(malformed, policy)).toThrow();
  });

  it("binds omitted filters to the live native-query receipt and refuses legacy policy receipts", () => {
    const expected = {
      queryText: "needle",
      workspaceId: "workspace",
      referenceTime: "2026-09-06T00:00:00.000Z",
      requestBudget: budget
    };
    const native = fixture();
    expect(() => encodeBenchRecallResults(native, policy, budget, { ...expected, requestFilters: {} }))
      .not.toThrow();
    expect(() => encodeBenchRecallResults(native, policy, budget, {
      ...expected, requestFilters: { authorized_scopes: null }
    })).toThrow(/differs from the invoked request/);
    // A historical expectation must not silently match the current receipt, and
    // the frozen adapter cannot execute a legacy enumeration policy at all.
    for (const requestFilters of [
      { enumeration_policy: "canonical" as const },
      { enumeration_policy: "associative" as const, cap_contracts: [{
        domain_id: ASSOCIATION_DOMAIN_ID,
        normalization: IDENTITY_NORMALIZATION_ID,
        transfer_id: HARD_IDENTITY_TRANSFER_ID,
        transfer_version: HARD_IDENTITY_TRANSFER_VERSION
      }] }
    ]) {
      expect(() => encodeBenchRecallResults(native, policy, budget, { ...expected, requestFilters }))
        .toThrow(/differs from the invoked request/);
    }
    for (const legacy of ["canonical", "associative"] as const) {
      expect(() => fixture(legacy)).toThrow(/requires native_query/u);
    }
  });
});
