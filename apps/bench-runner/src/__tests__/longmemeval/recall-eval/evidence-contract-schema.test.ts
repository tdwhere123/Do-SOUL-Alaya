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

describe("LongMemEval evidence contract schema", () => {
  it("accepts aggregate observations that retain target and relation evidence", () => {
    expect(RecallCandidateAnswerSupportSchema.parse({
      schema_version: 1,
      shape: "count",
      status: "observation_only",
      eligible: true,
      value_supported: false,
      target_supported: true,
      relation_supported: true,
      matched_target_terms: ["books"],
      matched_relation_terms: ["read"]
    })).toMatchObject({ status: "observation_only", target_supported: true });
  });

  it("accepts ineligible projections that retain observed compatibility", () => {
    expect(RecallCandidateAnswerSupportSchema.parse({
      schema_version: 1,
      shape: "place",
      status: "ineligible",
      eligible: false,
      value_supported: true,
      target_supported: true,
      relation_supported: true,
      matched_target_terms: ["alice"],
      matched_relation_terms: ["work"]
    })).toMatchObject({ status: "ineligible", value_supported: true });
  });

  it("adds an explicit reconstructable cohort while old rows still parse", () => {
    const missing = diagnostic({ id: "q-missing" });
    expect(missing.cohort_ledger).toMatchObject({
      dataset_cohort: "answerable",
      extraction_materialization: { status: "unknown", emitted_memory_count: 0 },
      evaluator_gold_identity: { status: "absent", object_ids: [] },
      retrieval_status: "not_applicable",
      evidence_status: "missing",
      evaluation_issue_reason: "missing_diagnostics",
      candidate_pool_complete: false,
      final_verdict: "evaluation_unscorable"
    });

    const oldShape = { ...missing, cohort_ledger: undefined };
    expect(LongMemEvalQuestionDiagnosticSchema.parse(oldShape).question_id).toBe("q-missing");
  });

  it("separates extraction drops and abstentions from ambiguous gold failures", () => {
    const dropped = diagnostic({
      id: "q-drop",
      seedDropReasons: { candidate_absent: 0, materialization_drop: 2 },
      recallResult: { diagnostics: { candidates: [] } }
    });
    expect(dropped.miss_taxonomy).toBe("materialization_drop");
    expect(dropped.cohort_ledger).toMatchObject({
      dataset_cohort: "answerable",
      extraction_materialization: {
        status: "drop",
        emitted_memory_count: 0,
        reason: "materialization_drop"
      },
      evaluator_gold_identity: { status: "absent" },
      evaluation_issue_reason: "extraction_materialization_drop"
    });

    const abstention = diagnostic({ id: "q_abs", abstention: true });
    expect(abstention.miss_taxonomy).toBeNull();
    expect(abstention.cohort_ledger).toMatchObject({
      measurement_status: "abstention_unscorable",
      dataset_cohort: "abstention",
      retrieval_status: "not_applicable",
      evaluation_issue_reason: null,
      final_verdict: "abstention_uncalibrated"
    });
    expect(buildLongMemEvalQualityMetrics([abstention])).toMatchObject({
      measurement_cohort_counts: {
        evaluated: 1,
        non_abstention: 0,
        abstention: 1,
        scorable_answerable: 0,
        unscorable_answerable: 0,
        hit_at_5: 0,
        miss_at_5: 0
      },
      unscorable_reason_distribution: { abstention_uncalibrated: 1 }
    });
  });

});
