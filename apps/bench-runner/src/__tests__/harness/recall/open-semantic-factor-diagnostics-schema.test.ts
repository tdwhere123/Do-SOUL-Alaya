import { describe, expect, it } from "vitest";
import { digestRecallFieldIdentity } from "@do-soul/alaya-core";
import {
  OpenSemanticFactorActivationReceiptSchema,
  OpenSemanticFactorCompatibilityTraceSchema,
  OpenSemanticFactorCompositionReceiptSchema
} from "../../../harness/recall/semantic-factors/open-semantic-factor-diagnostics-schema.js";

const DIGEST = `sha256:${"a".repeat(64)}`;

describe("archived semantic-factor diagnostics", () => {
  it("reads sealed historical evidence and keeps unavailable remainder distinct", () => {
    const trace = archivedTrace();
    expect(OpenSemanticFactorCompatibilityTraceSchema.parse(JSON.parse(JSON.stringify(trace)))).toEqual(trace);
    expect(trace.entries).toHaveLength(1);
    expect(trace.unevaluated_evidence_ids).toEqual(["evidence-2", "evidence-3"]);
  });

  it.each([
    { unevaluated_evidence_ids: [] },
    { unevaluated_evidence_ids: ["evidence-3", "evidence-2"] },
    { unevaluated_evidence_ids: ["evidence-2", "evidence-2"] },
    { unevaluated_evidence_ids: ["evidence-1", "evidence-2"] },
    { observed_evidence_count: 4 },
    { evaluated_evidence_count: 2 },
    { incomparable_seal: "none" }
  ])("rejects a resealed inconsistent remainder %j", (patch) => {
    const { trace_digest: _digest, ...body } = archivedTrace();
    const altered = { ...body, ...patch };
    expect(OpenSemanticFactorCompatibilityTraceSchema.safeParse({
      ...altered, trace_digest: digestRecallFieldIdentity(altered)
    }).success).toBe(false);
  });

  it("rejects unknown versions, digests and a join operator in a pairwise receipt", () => {
    const trace = archivedTrace();
    expect(OpenSemanticFactorCompatibilityTraceSchema.safeParse({ ...trace, schema_version: 1 }).success).toBe(false);
    expect(OpenSemanticFactorCompatibilityTraceSchema.safeParse({ ...trace, trace_digest: DIGEST }).success).toBe(false);
    const entry = trace.entries[0]!;
    const receipt = { ...entry.receipt, operator_id: "open_semantic_factor_composition_v2" };
    const { trace_digest: _digest, ...body } = trace;
    const altered = { ...body, entries: [{ ...entry, receipt }] };
    expect(OpenSemanticFactorCompatibilityTraceSchema.safeParse({
      ...altered, trace_digest: digestRecallFieldIdentity(altered)
    }).success).toBe(false);
  });

  it("reads sealed archived composition and activation without loading an executor", () => {
    const composition = seal({
      schema_version: 2, operator_id: "open_semantic_factor_composition_v2", status: "no_match",
      compatibility_trace_digest: archivedTrace().trace_digest, query_capture_digest: DIGEST,
      result_variable_ids: [], search_step_count: 0, solution_count: 0,
      observed_binding_count: 0, binding_observation_count: 0, truncated: false,
      bindings: [], solutions: [], variable_collections: []
    });
    const activation = seal({
      schema_version: 2, operator_id: "open_semantic_solution_membership_activation_v2", status: "no_match",
      composition_receipt_digest: composition.receipt_digest, entry_count: 0, truncated: false,
      entries: [], missing_evidence_policy: "no_op", ranking_effect: "candidate_attribution"
    });
    expect(OpenSemanticFactorCompositionReceiptSchema.parse(composition)).toEqual(composition);
    expect(OpenSemanticFactorActivationReceiptSchema.parse(activation)).toEqual(activation);
    expect(OpenSemanticFactorCompositionReceiptSchema.safeParse({ ...composition, schema_version: 1 }).success).toBe(false);
    expect(OpenSemanticFactorActivationReceiptSchema.safeParse({ ...activation, receipt_digest: DIGEST }).success).toBe(false);
  });
});

function archivedTrace() {
  const receipt = seal({
    schema_version: 1, operator_id: "open_semantic_factor_compatibility_v6", status: "ineligible",
    evidence_capture_digest: DIGEST, query_capture_digest: DIGEST,
    evidence_graph_digest: null, query_graph_digest: null,
    query_proposition_count: 0, matched_query_proposition_count: 0,
    proposition_match_candidates: [], proposition_matches: []
  });
  const body = {
    schema_version: 2, operator_id: "open_semantic_factor_compatibility_trace_v2",
    query_capture_digest: DIGEST, observed_evidence_count: 3,
    matchable_evidence_count: 1, evaluated_evidence_count: 1,
    unavailable_evidence_ids: ["evidence-2", "evidence-3"],
    unevaluated_evidence_ids: ["evidence-2", "evidence-3"],
    incomparable_seal: "unavailable", truncated: false,
    entries: [{ evidence_id: "evidence-1", receipt }]
  };
  return { ...body, trace_digest: digestRecallFieldIdentity(body) };
}

function seal<T extends Record<string, unknown>>(body: T) {
  return { ...body, receipt_digest: digestRecallFieldIdentity(body) };
}
