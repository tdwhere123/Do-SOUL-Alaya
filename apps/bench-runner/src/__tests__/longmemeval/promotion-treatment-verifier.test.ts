import { describe, expect, it } from "vitest";
import {
  createDiagnosticsTreatmentState,
  verifyDiagnosticsTreatmentQuestion
} from "../../longmemeval/promotion/diagnostics-treatment-verifier.js";
import type { RecallEvalDiagnosticsEvidenceV2 } from
  "../../longmemeval/provenance/recall-eval-diagnostics.js";

type Row = RecallEvalDiagnosticsEvidenceV2["questions"][number];

describe("promotion treatment primitive verification", () => {
  it.each([0, 2])(
    "rejects a bi-encoder row with %s fresh-query inferences",
    (inferenceCalls) => {
      expect(() => verifyDiagnosticsTreatmentQuestion(
        createDiagnosticsTreatmentState(),
        biRow(inferenceCalls),
        { embedding_supplement: true, answer_rerank: false }
      )).toThrow(new RegExp(
        `q-1: expected=1 actual=${inferenceCalls}`,
        "u"
      ));
    }
  );

  it.each([
    ["provider state", { provider_state: "provider_failed" }, /q-1.*status=provider_failed/u],
    ["degradation", { provider_degradation_reason: "timeout" }, /q-1.*degraded=timeout/u],
    ["activation", { candidates: [] }, /q-1.*scored_candidates=0/u]
  ] as const)("rejects bi-encoder %s drift", (_label, diagnostics, error) => {
    expect(() => verifyDiagnosticsTreatmentQuestion(
      createDiagnosticsTreatmentState(),
      biRow(1, diagnostics),
      { embedding_supplement: true, answer_rerank: false }
    )).toThrow(error);
  });

  it("accepts a finite zero as observed bi-encoder evidence", () => {
    expect(() => verifyDiagnosticsTreatmentQuestion(
      createDiagnosticsTreatmentState(),
      biRow(1, { candidates: [{ answer_relevance_score: null, score_factors: {
        embedding_similarity: 0
      } }] }),
      { embedding_supplement: true, answer_rerank: false }
    )).not.toThrow();
  });

  it.each([
    ["zero", 0],
    ["undefined", undefined],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY]
  ])("rejects a disabled control with an embedding %s key", (_label, value) => {
    expect(() => verifyDiagnosticsTreatmentQuestion(
      createDiagnosticsTreatmentState(),
      controlRow({ candidates: [{ answer_relevance_score: null, score_factors: {
        embedding_similarity: value
      } }] }),
      { embedding_supplement: false, answer_rerank: false }
    )).toThrow(/disabled bi-encoder cell produced work/u);
  });

  it("does not promote a scanned-only bi-encoder row", () => {
    expect(() => verifyDiagnosticsTreatmentQuestion(
      createDiagnosticsTreatmentState(),
      biRow(1, {
        candidates: [],
        embedding_workspace_scanned_count: 2,
        embedding_workspace_truncated: false,
        embedding_workspace_provider_kind: "local_onnx",
        embedding_workspace_model_id: "fixture-bi",
        embedding_workspace_schema_version: 2
      }),
      { embedding_supplement: true, answer_rerank: false }
    )).toThrow(/scored_candidates=0/u);
  });

  it("rejects query warmup because LongMemEval query inference belongs in-timer", () => {
    const row = {
      ...biRow(1),
      query_embedding_warmup: {
        status: "ready",
        requested_count: 1,
        ready_count: 1,
        cache_hit_count: 1,
        provider_requested_count: 0,
        missing_count: 0,
        provider_kind: "local_onnx",
        model_id: "fixture-bi",
        schema_version: 2,
        d2q_input: "content_plus_hq"
      }
    } as Row;
    expect(() => verifyDiagnosticsTreatmentQuestion(
      createDiagnosticsTreatmentState(),
      row,
      { embedding_supplement: true, answer_rerank: false }
    )).toThrow(/inside recall/u);
  });

  it("rejects cross-encoder counts not projected by candidate scores", () => {
    const row = controlRow({
      answer_rerank_status: "returned",
      answer_rerank_expected_count: 2,
      answer_rerank_scored_count: 2,
      candidates: [{
        answer_relevance_score: 0.9,
        score_factors: {}
      }]
    });
    expect(() => verifyDiagnosticsTreatmentQuestion(
      createDiagnosticsTreatmentState(),
      row,
      { embedding_supplement: false, answer_rerank: true }
    )).toThrow(/cross-encoder treatment activation drift/u);
  });
});

function biRow(
  inferenceCalls: number,
  diagnostics: Readonly<Record<string, unknown>> = {}
): Row {
  return {
    ...controlRow({
      provider_state: "provider_returned",
      candidates: [{ answer_relevance_score: null, score_factors: {
        embedding_similarity: 0.5
      } }],
      ...diagnostics
    }),
    recall_token_economy: { embedding_inference_calls: inferenceCalls },
    document_embedding_warmup: {
      status: "ready",
      expected_count: 1,
      ready_count: 1,
      ready_rate: 1,
      pass_count: 1,
      missing_object_ids: [],
      provider_kind: "local_onnx",
      model_id: "fixture-bi",
      schema_version: 2,
      d2q_input: "content_plus_hq"
    }
  } as unknown as Row;
}

function controlRow(
  diagnostics: Readonly<Record<string, unknown>> = {}
): Row {
  return {
    question_id: "q-1",
    recall_token_economy: { embedding_inference_calls: 0 },
    document_embedding_warmup: null,
    query_embedding_warmup: null,
    diagnostics: {
      provider_state: "provider_not_requested",
      provider_degradation_reason: null,
      candidates: [],
      answer_rerank_status: "not_requested",
      answer_rerank_expected_count: 0,
      answer_rerank_scored_count: 0,
      ...diagnostics
    }
  } as unknown as Row;
}
