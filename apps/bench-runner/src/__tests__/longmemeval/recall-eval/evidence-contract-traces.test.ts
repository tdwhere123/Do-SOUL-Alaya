import { describe, expect, it } from "vitest";
import { LongMemEvalQuestionDiagnosticSchema } from "../../../diagnostics/schema/diagnostics-schema.js";
import {
  RecallAnswerSupportObservationSchema,
  RecallAnswerShapePlanSchema,
  RecallCandidateAnswerSupportSchema,
  RecallDeepHeadTraceSchema
} from "../../../harness/recall/answer-trace-schema.js";
import {
  buildLongMemEvalQualityMetrics,
  buildQuestionDiagnostic,
  stripReplayCandidatePoolsForGateWrite,
  type LongMemEvalDiagnosticsSidecar
} from "../../../diagnostics/diagnostics.js";
import {
  buildLongMemEvalEvidenceManifest,
  verifyLongMemEvalEvidenceManifest
} from "../../../runs/provenance/evidence-manifest.js";
import { collectPairedEnvironment } from "../../../runs/provenance/run.js";
import { completeAnswerFeatures, diagnostic } from "./evidence-contract-test-support.js";

describe("LongMemEval evidence contract traces", () => {
  it("rejects semantically contradictory answer-trace states", () => {
    expect(RecallAnswerShapePlanSchema.safeParse({
      schema_version: 1,
      status: "high_confidence",
      shape: null,
      target_terms: [],
      relation_terms: []
    }).success).toBe(false);
    expect(RecallCandidateAnswerSupportSchema.safeParse({
      schema_version: 1,
      shape: "place",
      status: "compatible",
      eligible: false,
      value_supported: false,
      target_supported: false,
      relation_supported: false,
      matched_target_terms: [],
      matched_relation_terms: []
    }).success).toBe(false);
    const legacyCompatible = {
      schema_version: 1,
      shape: "place",
      status: "compatible",
      eligible: true,
      value_supported: true,
      target_supported: true,
      relation_supported: true,
      matched_target_terms: ["bookshelf"],
      matched_relation_terms: ["buy"]
    } as const;
    expect(RecallCandidateAnswerSupportSchema.safeParse(legacyCompatible).success)
      .toBe(true);
    expect(RecallCandidateAnswerSupportSchema.safeParse({
      ...legacyCompatible,
      authority: {
        schema_version: 1,
        provenance_status: "verified_user_assertion",
        subject_status: "bound",
        target_status: "bound",
        relation_status: "bound",
        event_status: "asserted",
        time_status: "not_requested",
        binding_status: "missing_or_ambiguous",
        behavior_eligible: false,
        evidence_ref: "evidence-bookshelf"
      }
    }).success).toBe(true);
    expect(RecallCandidateAnswerSupportSchema.safeParse({
      ...legacyCompatible,
      authority: {
        schema_version: 1,
        provenance_status: "verified_user_assertion",
        subject_status: "conflicted",
        target_status: "bound",
        relation_status: "bound",
        event_status: "asserted",
        time_status: "not_requested",
        binding_status: "unique",
        behavior_eligible: true,
        evidence_ref: "forged-evidence"
      }
    }).success).toBe(false);
    const turnObservation = {
      schema_version: 1,
      source_identity: "evidence_ref:evidence-turn",
      support_identity: null,
      evidence_ref: "evidence-turn",
      source_role: "user",
      projection_kind: "turn_projection",
      provenance_status: "verified_user_turn",
      query_status: "compatible",
      event_status: "unknown",
      time_status: "unknown",
      behavior_eligible: false
    } as const;
    expect(RecallAnswerSupportObservationSchema.safeParse({
      ...turnObservation,
      support_identity: "forged-atomic-support"
    }).success).toBe(false);
    expect(RecallAnswerSupportObservationSchema.safeParse({
      ...turnObservation,
      behavior_eligible: true
    }).success).toBe(false);
    expect(RecallAnswerSupportObservationSchema.safeParse({
      ...turnObservation,
      source_identity: "evidence_ref:other-evidence"
    }).success).toBe(false);
    expect(RecallAnswerSupportObservationSchema.safeParse({
      ...turnObservation,
      provenance_status: "verified_user_assertion"
    }).success).toBe(false);
    const atomicObservation = {
      ...turnObservation,
      support_identity: "verified_user_assertion:evidence-turn:sha256:digest",
      projection_kind: "atomic_assertion",
      provenance_status: "verified_user_assertion",
      query_status: "compatible",
      event_status: "asserted",
      time_status: "compatible",
      behavior_eligible: true
    } as const;
    expect(RecallAnswerSupportObservationSchema.safeParse(atomicObservation).success)
      .toBe(true);
    expect(RecallAnswerSupportObservationSchema.safeParse({
      ...atomicObservation,
      query_status: "value_only"
    }).success).toBe(true);
    for (const invalid of [
      { query_status: "unsupported" },
      { event_status: "prospective" },
      { time_status: "unknown" }
    ] as const) {
      expect(RecallAnswerSupportObservationSchema.safeParse({
        ...atomicObservation,
        ...invalid
      }).success).toBe(false);
    }
    expect(RecallDeepHeadTraceSchema.safeParse({
      lexical_agreement: 0.9,
      evidence_agreement: 0.5,
      resolved_evidence: 0.2,
      embedding_signal: null,
      fusion_baseline_used: false,
      resolved_score: 0.2,
      score_source: "inactive"
    }).success).toBe(false);
    expect(RecallDeepHeadTraceSchema.safeParse({
      lexical_agreement: 0,
      evidence_agreement: 0,
      resolved_evidence: 0,
      embedding_signal: 0.4,
      fusion_baseline_used: true,
      resolved_score: 0.52,
      score_source: "fusion_embedding_evidence"
    }).success).toBe(true);
    expect(RecallDeepHeadTraceSchema.safeParse({
      lexical_agreement: 0,
      evidence_agreement: 0,
      resolved_evidence: 0,
      embedding_signal: null,
      fusion_baseline_used: true,
      resolved_score: 0.2,
      score_source: "field_baseline",
      formula_operator_id: "lightweight_deep_head_prob_or_v1"
    }).success).toBe(true);
    expect(RecallDeepHeadTraceSchema.safeParse({
      lexical_agreement: 0,
      evidence_agreement: 0,
      resolved_evidence: 0,
      embedding_signal: 0.4,
      fusion_baseline_used: false,
      resolved_score: 0.4,
      score_source: "embedding_evidence",
      formula_operator_id: "lightweight_deep_head_prob_or_v1",
      activation: {
        schema_version: 1,
        operator_id: "candidate_semantic_max_v1",
        state: "observed",
        score: 0.4,
        winner: { channel: "effective_factor", score: 0.4 },
        observations: [
          { channel: "effective_factor", state: "observed", score: 0.4 }
        ],
        missing_channel_policy: "no_op"
      }
    }).success).toBe(true);
    expect(RecallDeepHeadTraceSchema.safeParse({
      lexical_agreement: 0,
      evidence_agreement: 0,
      resolved_evidence: 0,
      embedding_signal: null,
      fusion_baseline_used: false,
      resolved_score: null,
      score_source: "inactive",
      activation: {
        schema_version: 1,
        operator_id: "candidate_semantic_max_v1",
        state: "absent",
        score: 0.2,
        winner: null,
        observations: [],
        missing_channel_policy: "no_op"
      }
    }).success).toBe(false);
  });

  it("binds complete evidence-semantic receipts to activation and projection forms", () => {
    const winner = {
      score: 0.7,
      evidenceObjectId: "evidence-1",
      documentIdentity: "fact_key:5",
      projection: {
        projection_id: 5,
        projection_kind: "fact_key",
        matched_fact_key_forms: [{
          kind: "leave_one_slot_out",
          omitted_slot: { slot_index: 4, role: "time" }
        }]
      }
    } as const;
    const semanticReceipt = {
      schema_version: 1,
      operator_id: "evidence_document_max_v1",
      state: "observed",
      score: 0.7,
      winner,
      observations: [winner, {
        score: 0.5,
        evidenceObjectId: "evidence-2",
        documentIdentity: "owner",
        projection: {
          projection_id: null,
          projection_kind: "owner",
          matched_fact_key_forms: []
        }
      }],
      observation_completeness: "complete",
      missing_channel_policy: "no_op"
    } as const;
    const trace = {
      lexical_agreement: 0,
      evidence_agreement: 0,
      resolved_evidence: 0,
      embedding_signal: 0.8,
      fusion_baseline_used: false,
      resolved_score: 0.8,
      score_source: "embedding_evidence",
      activation: {
        schema_version: 1,
        operator_id: "candidate_semantic_max_v1",
        state: "observed",
        score: 0.8,
        winner: { channel: "effective_factor", score: 0.8 },
        observations: [
          { channel: "evidence_semantic", state: "observed", score: 0.7 },
          { channel: "effective_factor", state: "observed", score: 0.8 }
        ],
        missing_channel_policy: "no_op"
      },
      evidence_semantic_activation: semanticReceipt
    } as const;

    expect(RecallDeepHeadTraceSchema.safeParse(trace).success).toBe(true);
    expect(RecallDeepHeadTraceSchema.safeParse({
      ...trace,
      activation: {
        ...trace.activation,
        observations: [{
          channel: "evidence_semantic",
          state: "observed",
          score: 0.6
        }]
      }
    }).success).toBe(false);
    expect(RecallDeepHeadTraceSchema.safeParse({
      ...trace,
      evidence_semantic_activation: {
        ...semanticReceipt,
        winner: {
          ...winner,
          projection: {
            ...winner.projection,
            matched_fact_key_forms: [{ kind: "complete" }]
          }
        }
      }
    }).success).toBe(false);
    expect(RecallDeepHeadTraceSchema.safeParse({
      ...trace,
      evidence_semantic_activation: {
        ...semanticReceipt,
        observations: [...semanticReceipt.observations].reverse()
      }
    }).success).toBe(false);
  });

  it("binds effective ranking switches into paired provenance", () => {
    expect(collectPairedEnvironment({
      ALAYA_RECALL_CONF_RHO_PATH: "0.5",
      UNRELATED_SECRET: "not-recorded"
    })).toEqual({
      ALAYA_RECALL_CONF_RHO_PATH: "0.5",
      ALAYA_OFFICIAL_GARDEN_API_KEY_STATE: "unset",
      ALAYA_OFFICIAL_GARDEN_SECRET_REF_STATE: "unset"
    });
  });
});
