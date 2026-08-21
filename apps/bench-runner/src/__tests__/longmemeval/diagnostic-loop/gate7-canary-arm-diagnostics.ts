import { digestRecallFieldIdentity, materializeOpenSemanticFactorFormation } from
  "@do-soul/alaya-core";
import { OPEN_SEMANTIC_FACTOR_QUERY_OPERATOR_ID } from "@do-soul/alaya-soul";
import { buildQuestionDiagnostic } from
  "../../../bench/diagnostics/diagnostics-question.js";
import {
  GATE7_CANARY_Q1,
  GATE7_CANARY_Q2,
  GATE7_CANARY_Q3,
  GATE7_CANARY_QUERY_TEXTS
} from "../../../bench/diagnostics/stage-attribution/exposure/gate7-canary-ids.js";
import { candidateAttribution } from "../diagnostics/phase/exposure-receipt-fixture.js";

export function controlCanaryDiagnostics() {
  return [
    controlQuestion(GATE7_CANARY_Q1),
    controlQuestion(GATE7_CANARY_Q2),
    controlQuestion(GATE7_CANARY_Q3)
  ];
}

export function passingTreatmentCanaryDiagnostics() {
  return [
    exposedQuestion(GATE7_CANARY_Q1),
    negativeQuestion(GATE7_CANARY_Q2),
    negativeQuestion(GATE7_CANARY_Q3)
  ];
}

export function failingTreatmentCanaryDiagnostics() {
  return [
    negativeQuestion(GATE7_CANARY_Q1),
    negativeQuestion(GATE7_CANARY_Q2),
    negativeQuestion(GATE7_CANARY_Q3)
  ];
}

function controlQuestion(questionId: string) {
  return question(questionId, unavailableFormation(questionId), false, false);
}

function exposedQuestion(questionId: string) {
  return question(questionId, formedFormation(questionId), true, true);
}

function negativeQuestion(questionId: string) {
  return question(questionId, formedFormation(questionId), false, false);
}

function question(
  questionId: string,
  formation: ReturnType<typeof formedFormation>,
  exposed: boolean,
  hitAt5: boolean
) {
  const compatibility = exposed ? compatibleTrace(formation.capture_digest) :
    emptyTrace(formation.capture_digest);
  const composition = sealReceipt({
    schema_version: 2 as const,
    operator_id: "open_semantic_factor_composition_v2" as const,
    status: exposed ? "composed" as const : "no_match" as const,
    compatibility_trace_digest: compatibility.trace_digest,
    query_capture_digest: formation.capture_digest,
    result_variable_ids: [],
    search_step_count: exposed ? 1 : 0,
    solution_count: exposed ? 1 : 0,
    observed_binding_count: 0,
    binding_observation_count: 0,
    truncated: false,
    bindings: [],
    solutions: exposed ? [{
      result_bindings: [],
      evidence_ids: ["e1"],
      proposition_matches: []
    }] : [],
    variable_collections: []
  });
  const activation = sealReceipt({
    schema_version: 2 as const,
    operator_id: "open_semantic_solution_membership_activation_v2" as const,
    status: exposed ? "composed" as const : "no_match" as const,
    composition_receipt_digest: composition.receipt_digest,
    entry_count: exposed ? 1 : 0,
    truncated: false,
    entries: exposed ? [{
      evidence_id: "e1",
      state: "observed" as const,
      activation: 1,
      solution_count: 1,
      proposition_match_count: 1
    }] : [],
    missing_evidence_policy: "no_op" as const,
    ranking_effect: "candidate_attribution" as const
  });
  const row = buildQuestionDiagnostic({
    questionId,
    goldMemoryIds: [],
    answerSessionIds: [],
    deliveredResults: hitAt5 ? [{
      object_id: "memory:1",
      object_kind: "memory_entry" as const,
      rank: 1,
      relevance_score: 1
    }] : [],
    hitAt1: hitAt5,
    hitAt5,
    hitAt10: hitAt5,
    degradationReason: null,
    embeddingMode: "disabled",
    recallResult: { diagnostics: {
      query_open_semantic_factor_formation: formation,
      open_semantic_factor_compatibility_trace: compatibility,
      open_semantic_factor_composition: composition,
      open_semantic_factor_activation: activation,
      open_semantic_factor_candidate_activations: exposed
        ? candidateAttribution(true).entries : [],
      candidates: exposed ? [{
        candidate_key: "candidate:f3",
        object_id: "memory:1",
        object_kind: "memory_entry",
        origin_plane: "workspace_local",
        fused_rank: 1,
        fused_score: 1,
        final_rank: 1,
        selection_order: 1,
        admission_attempts: [{
          pass: "final_selector",
          selection_order: 1,
          admitted: true,
          dropped_reason: null
        }]
      }] : [],
      total_scanned: exposed ? 1 : 0,
      candidate_pool_count: exposed ? 1 : 0,
      pre_budget_count: exposed ? 1 : 0,
      delivered_count: exposed ? 1 : 0,
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
  if (!exposed) {
    return { ...row, open_semantic_factor_candidate_activations: [] };
  }
  const selected = selectedCandidate();
  return {
    ...row,
    open_semantic_factor_candidate_activations: candidateAttribution(true).entries,
    candidates: row.candidates.length === 0
      ? [selected]
      : row.candidates.map((candidate, index) => ({
        ...candidate,
        selection_order: candidate.selection_order ?? index + 1,
        admission_attempts: candidate.admission_attempts.length > 0
          ? candidate.admission_attempts
          : selected.admission_attempts
      }))
  };
}

function selectedCandidate() {
  return {
    object_id: "memory:1",
    object_kind: "memory_entry" as const,
    candidate_key: "candidate:f3",
    origin_plane: "workspace_local" as const,
    dimension: null,
    final_rank: 1,
    pre_budget_rank: 1,
    selection_order: 1,
    admission_attempts: [{
      pass: "final_selector" as const,
      selection_order: 1,
      admitted: true,
      dropped_reason: null
    }],
    evidence_projection_matches: [],
    fused_rank: 1,
    fused_score: 1,
    answer_relevance_score: null,
    answer_relevance_rank: null,
    per_stream_rank: null,
    fused_rank_contribution_per_stream: null,
    per_axis_rank: null,
    per_axis_contribution: null,
    flood_potential: null,
    flood_fuel_coverage: null,
    plane_first_admitted: null,
    plane_winning_admission: null,
    source_planes: [],
    source_channels: [],
    lexical_rank: null,
    structural_score: null,
    budget_drop_reason: null,
    rank_after_fusion: 1,
    rank_after_feature_rerank: null,
    rank_after_lexical_priority: null,
    rank_after_synthesis_reserve: null,
    rank_after_structural_reserve: null,
    rank_after_coverage_selector: null,
    rank_after_session_coverage: null,
    coverage_selector_action: null,
    session_coverage_action: null,
    session_key: null,
    source_cohort_key: null,
    reserved_by: null,
    answer_features: null,
    deep_head_trace: null,
    coverage_marginal_gain: null,
    selector_observation: null,
    path_suppression_score: null,
    score_factors: {}
  };
}

function formedFormation(questionId: string) {
  const sourceText = GATE7_CANARY_QUERY_TEXTS[
    questionId as keyof typeof GATE7_CANARY_QUERY_TEXTS
  ] ?? questionId;
  const tokens = sourceText.split(/\s+/u).map((token) => token.replace(/[^\p{L}\p{N}]/gu, ""))
    .filter((token) => token.length > 0);
  const actor = tokens.find((token) => token === "I" || token === "my") ?? tokens[1] ?? tokens[0]!;
  const predicate = tokens.find((token) => token !== actor && token !== tokens[0]) ?? tokens[0]!;
  const wh = tokens[0]!;
  return materializeOpenSemanticFactorFormation({
    source_kind: "query",
    source_text: sourceText,
    proposal: {
      schema_version: 1,
      producer_operator_id: OPEN_SEMANTIC_FACTOR_QUERY_OPERATOR_ID,
      source_text: sourceText,
      graph: {
        schema_version: 2,
        source_kind: "query",
        factors: [
          {
            factor_id: "actor", surface: actor, semantic_identity: actor.toLowerCase(),
            source_occurrence: 0
          },
          {
            factor_id: "predicate", surface: predicate, semantic_identity: predicate.toLowerCase(),
            source_occurrence: 0
          }
        ],
        variables: [{ variable_id: "answer", surface: wh, source_occurrence: 0 }],
        result_variable_ids: ["answer"],
        propositions: [{
          proposition_id: "query",
          predicate_factor_id: "predicate",
          arguments: [
            {
              position: 0, reference_kind: "factor",
              reference_id: "actor", binding_identity: "agent"
            },
            {
              position: 1, reference_kind: "variable",
              reference_id: "answer", binding_identity: "object"
            }
          ]
        }]
      }
    }
  });
}

function unavailableFormation(questionId: string) {
  const sourceText = GATE7_CANARY_QUERY_TEXTS[
    questionId as keyof typeof GATE7_CANARY_QUERY_TEXTS
  ] ?? questionId;
  return materializeOpenSemanticFactorFormation({
    source_kind: "query",
    source_text: sourceText
  });
}

function compatibleTrace(queryCaptureDigest: string) {
  const receipt = sealReceipt({
    schema_version: 1 as const,
    operator_id: "open_semantic_factor_compatibility_v6" as const,
    status: "compatible" as const,
    evidence_capture_digest: queryCaptureDigest,
    query_capture_digest: queryCaptureDigest,
    evidence_graph_digest: null,
    query_graph_digest: null,
    query_proposition_count: 1,
    matched_query_proposition_count: 1,
    proposition_match_candidates: [],
    proposition_matches: []
  });
  return sealTrace({
    schema_version: 2 as const,
    operator_id: "open_semantic_factor_compatibility_trace_v2" as const,
    query_capture_digest: queryCaptureDigest,
    observed_evidence_count: 1,
    matchable_evidence_count: 1,
    evaluated_evidence_count: 1,
    unavailable_evidence_ids: [],
    unevaluated_evidence_ids: [],
    incomparable_seal: "none" as const,
    truncated: false,
    entries: [{ evidence_id: "e1", receipt }]
  });
}

function emptyTrace(queryCaptureDigest: string) {
  return sealTrace({
    schema_version: 2 as const,
    operator_id: "open_semantic_factor_compatibility_trace_v2" as const,
    query_capture_digest: queryCaptureDigest,
    observed_evidence_count: 0,
    matchable_evidence_count: 0,
    evaluated_evidence_count: 0,
    unavailable_evidence_ids: [],
    unevaluated_evidence_ids: [],
    incomparable_seal: "none" as const,
    truncated: false,
    entries: []
  });
}

function sealTrace<T extends Record<string, unknown>>(body: T) {
  return { ...body, trace_digest: digestRecallFieldIdentity(body) };
}

function sealReceipt<T extends Record<string, unknown>>(body: T) {
  return { ...body, receipt_digest: digestRecallFieldIdentity(body) };
}
