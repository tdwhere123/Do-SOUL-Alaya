import { describe, expect, it } from "vitest";
import { digestRecallFieldIdentity } from "@do-soul/alaya-core";
import { buildQuestionDiagnostic } from
  "../../../bench/diagnostics/diagnostics-question.js";
import { LongMemEvalQuestionDiagnosticSchema } from
  "../../../bench/diagnostics/schema/diagnostics-schema.js";

const captureDigest = `sha256:${"1".repeat(64)}`;

describe("LongMemEval open semantic factor diagnostics", () => {
  it("archives the exact formation, compatibility, composition, and activation receipts", () => {
    const formation = {
      schema_version: 1 as const,
      operator_id: "open_semantic_factor_formation_v1" as const,
      status: "unavailable" as const,
      producer_operator_id: null,
      source_sha256: null,
      graph: null,
      capture_digest: captureDigest
    };
    const compatibility = sealTrace({
      schema_version: 2 as const,
      operator_id: "open_semantic_factor_compatibility_trace_v2" as const,
      query_capture_digest: formation.capture_digest,
      observed_evidence_count: 1,
      matchable_evidence_count: 0,
      evaluated_evidence_count: 0,
      unavailable_evidence_ids: ["evidence-missing"],
      unevaluated_evidence_ids: ["evidence-missing"],
      incomparable_seal: "unavailable" as const,
      truncated: false,
      entries: []
    });
    const composition = sealReceipt({
      schema_version: 2 as const,
      operator_id: "open_semantic_factor_composition_v2" as const,
      status: "unavailable" as const,
      compatibility_trace_digest: compatibility.trace_digest,
      query_capture_digest: formation.capture_digest,
      result_variable_ids: [],
      search_step_count: 0,
      solution_count: 0,
      observed_binding_count: 0,
      binding_observation_count: 0,
      truncated: false,
      bindings: [],
      solutions: [],
      variable_collections: []
    });
    const activation = sealReceipt({
      schema_version: 2 as const,
      operator_id: "open_semantic_solution_membership_activation_v2" as const,
      status: "unavailable" as const,
      composition_receipt_digest: composition.receipt_digest,
      entry_count: 0,
      truncated: false,
      entries: [],
      missing_evidence_policy: "no_op" as const,
      ranking_effect: "candidate_attribution" as const
    });
    const row = buildQuestionDiagnostic({
      questionId: "q-open-semantic-factor-receipts",
      goldMemoryIds: [],
      answerSessionIds: [],
      deliveredResults: [],
      hitAt1: false,
      hitAt5: false,
      hitAt10: false,
      degradationReason: null,
      embeddingMode: "disabled",
      recallResult: { diagnostics: {
        query_open_semantic_factor_formation: formation,
        open_semantic_factor_compatibility_trace: compatibility,
        open_semantic_factor_composition: composition,
        open_semantic_factor_activation: activation,
        candidates: []
      } }
    });

    expect(LongMemEvalQuestionDiagnosticSchema.parse(row)).toMatchObject({
      query_open_semantic_factor_formation: formation,
      open_semantic_factor_compatibility_trace: compatibility,
      open_semantic_factor_composition: composition,
      open_semantic_factor_activation: activation
    });
  });

  it("round-trips graded activation values and archived unit activations", () => {
    const formation = {
      schema_version: 1 as const,
      operator_id: "open_semantic_factor_formation_v1" as const,
      status: "unavailable" as const,
      producer_operator_id: null,
      source_sha256: null,
      graph: null,
      capture_digest: captureDigest
    };
    const compatibility = sealTrace({
      schema_version: 2 as const,
      operator_id: "open_semantic_factor_compatibility_trace_v2" as const,
      query_capture_digest: formation.capture_digest,
      observed_evidence_count: 0,
      matchable_evidence_count: 0,
      evaluated_evidence_count: 0,
      unavailable_evidence_ids: [],
      unevaluated_evidence_ids: [],
      incomparable_seal: "none" as const,
      truncated: false,
      entries: []
    });
    const composition = sealReceipt({
      schema_version: 2 as const,
      operator_id: "open_semantic_factor_composition_v2" as const,
      status: "composed" as const,
      compatibility_trace_digest: compatibility.trace_digest,
      query_capture_digest: formation.capture_digest,
      result_variable_ids: [],
      search_step_count: 1,
      solution_count: 1,
      observed_binding_count: 0,
      binding_observation_count: 0,
      truncated: false,
      bindings: [],
      solutions: [],
      variable_collections: []
    });

    for (const activationValue of [1, 0.5]) {
      const activation = sealReceipt({
        schema_version: 2 as const,
        operator_id: "open_semantic_solution_membership_activation_v2" as const,
        status: "composed" as const,
        composition_receipt_digest: composition.receipt_digest,
        entry_count: 1,
        truncated: false,
        entries: [{
          evidence_id: "evidence-a",
          state: "observed" as const,
          activation: activationValue,
          solution_count: 1,
          proposition_match_count: 1
        }],
        missing_evidence_policy: "no_op" as const,
        ranking_effect: "candidate_attribution" as const
      });
      const row = buildQuestionDiagnostic({
        questionId: "q-open-semantic-graded-activation",
        goldMemoryIds: [],
        answerSessionIds: [],
        deliveredResults: [],
        hitAt1: false,
        hitAt5: false,
        hitAt10: false,
        degradationReason: null,
        embeddingMode: "disabled",
        recallResult: { diagnostics: {
          query_open_semantic_factor_formation: formation,
          open_semantic_factor_compatibility_trace: compatibility,
          open_semantic_factor_composition: composition,
          open_semantic_factor_activation: activation,
          candidates: []
        } }
      });
      expect(LongMemEvalQuestionDiagnosticSchema.parse(row)
        .open_semantic_factor_activation?.entries[0]?.activation).toBe(activationValue);
    }
  });

  it("archives a stale v1 OSF trace without dropping query probes or candidates", () => {
    const row = buildQuestionDiagnostic({
      questionId: "q-stale-trace",
      goldMemoryIds: [],
      answerSessionIds: [],
      deliveredResults: [],
      hitAt1: false,
      hitAt5: true,
      hitAt10: true,
      degradationReason: null,
      embeddingMode: "disabled",
      recallResult: { diagnostics: {
        query_probes: {
          normalized_query: "where",
          object_ids: [],
          subject_hints: [],
          evidence_refs: [],
          run_ids: [],
          surface_ids: [],
          file_paths: [],
          command_names: [],
          package_names: [],
          task_refs: [],
          dimensions: [],
          scope_classes: [],
          domain_tags: [],
          lexical_terms: [],
          expanded_terms: ["where"],
          phrases: [],
          char_ngrams: [],
          date_terms: []
        },
        open_semantic_factor_compatibility_trace: {
          schema_version: 1,
          operator_id: "open_semantic_factor_compatibility_trace_v1",
          query_capture_digest: captureDigest,
          observed_evidence_count: 0,
          matchable_evidence_count: 0,
          evaluated_evidence_count: 0,
          unavailable_evidence_ids: [],
          incomparable_seal: "none",
          truncated: false,
          entries: [],
          trace_digest: captureDigest
        },
        candidates: [{
          candidate_key: "workspace_local:memory_entry:kept",
          object_id: "kept",
          object_kind: "memory_entry",
          origin_plane: "workspace_local",
          fused_rank: 1,
          fused_score: 0.5,
          final_rank: 1
        }],
        total_scanned: 1,
        candidate_pool_count: 1,
        pre_budget_count: 1,
        delivered_count: 1,
        embedding_provider_status: "provider_not_requested",
        embedding_supplement_status: "disabled",
        provider_degradation_reason: null,
        answer_rerank_status: "not_requested",
        answer_rerank_expected_count: 0,
        answer_rerank_scored_count: 0,
        answer_rerank_failure_class: null,
        graph_expansion_plane_count_per_hop: [0, 0],
        graph_expansion_plane_count_per_edge_type: {
          derives_from: 0, recalls: 0, supports: 0
        },
        fusion_breakdown: []
      } }
    });

    expect(row.query_probes?.expanded_terms).toEqual(["where"]);
    expect(row.candidates).toHaveLength(1);
    expect(row.open_semantic_factor_compatibility_trace).toBeNull();
    expect(row.open_semantic_factor_archive).toEqual({
      replayable: false,
      reason: "stale_schema"
    });
    expect(LongMemEvalQuestionDiagnosticSchema.parse({
      ...row,
      open_semantic_factor_compatibility_trace: {
        schema_version: 1,
        operator_id: "open_semantic_factor_compatibility_trace_v1"
      }
    }).open_semantic_factor_archive).toEqual({
      replayable: false,
      reason: "stale_schema"
    });
  });

  it("archives a v2 trace whose nested compatibility receipt is still v5", () => {
    const row = buildQuestionDiagnostic({
      questionId: "q-nested-v5-receipt",
      goldMemoryIds: [],
      answerSessionIds: [],
      deliveredResults: [],
      hitAt1: false,
      hitAt5: true,
      hitAt10: true,
      degradationReason: null,
      embeddingMode: "disabled",
      recallResult: { diagnostics: {
        query_probes: {
          normalized_query: "where",
          object_ids: [],
          subject_hints: [],
          evidence_refs: [],
          run_ids: [],
          surface_ids: [],
          file_paths: [],
          command_names: [],
          package_names: [],
          task_refs: [],
          dimensions: [],
          scope_classes: [],
          domain_tags: [],
          lexical_terms: [],
          expanded_terms: ["where"],
          phrases: [],
          char_ngrams: [],
          date_terms: []
        },
        open_semantic_factor_compatibility_trace: {
          schema_version: 2,
          operator_id: "open_semantic_factor_compatibility_trace_v2",
          query_capture_digest: captureDigest,
          observed_evidence_count: 1,
          matchable_evidence_count: 1,
          evaluated_evidence_count: 1,
          unavailable_evidence_ids: [],
          unevaluated_evidence_ids: [],
          incomparable_seal: "none",
          truncated: false,
          entries: [{
            evidence_id: "stale-nested",
            receipt: {
              schema_version: 1,
              operator_id: "open_semantic_factor_compatibility_v5",
              status: "compatible",
              evidence_capture_digest: captureDigest,
              query_capture_digest: captureDigest,
              evidence_graph_digest: null,
              query_graph_digest: null,
              query_proposition_count: 1,
              matched_query_proposition_count: 1,
              proposition_match_candidates: [],
              proposition_matches: [],
              receipt_digest: captureDigest
            }
          }],
          trace_digest: captureDigest
        },
        candidates: [{
          candidate_key: "workspace_local:memory_entry:kept",
          object_id: "kept",
          object_kind: "memory_entry",
          origin_plane: "workspace_local",
          fused_rank: 1,
          fused_score: 0.5,
          final_rank: 1
        }],
        total_scanned: 1,
        candidate_pool_count: 1,
        pre_budget_count: 1,
        delivered_count: 1,
        embedding_provider_status: "provider_not_requested",
        embedding_supplement_status: "disabled",
        provider_degradation_reason: null,
        answer_rerank_status: "not_requested",
        answer_rerank_expected_count: 0,
        answer_rerank_scored_count: 0,
        answer_rerank_failure_class: null,
        graph_expansion_plane_count_per_hop: [0, 0],
        graph_expansion_plane_count_per_edge_type: {
          derives_from: 0, recalls: 0, supports: 0
        },
        fusion_breakdown: []
      } }
    });

    expect(row.query_probes?.expanded_terms).toEqual(["where"]);
    expect(row.candidates).toHaveLength(1);
    expect(row.open_semantic_factor_compatibility_trace).toBeNull();
    expect(row.open_semantic_factor_composition).toBeNull();
    expect(row.open_semantic_factor_activation).toBeNull();
    expect(row.open_semantic_factor_archive).toEqual({
      replayable: false,
      reason: "stale_schema"
    });
  });
});

function sealTrace<T extends Record<string, unknown>>(body: T) {
  return { ...body, trace_digest: digestRecallFieldIdentity(body) };
}

function sealReceipt<T extends Record<string, unknown>>(body: T) {
  return { ...body, receipt_digest: digestRecallFieldIdentity(body) };
}
