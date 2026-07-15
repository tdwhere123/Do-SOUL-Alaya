import { describe, expect, it } from "vitest";
import type { LongMemEvalQuestionDiagnostic } from
  "../../longmemeval/diagnostics-types.js";
import {
  answerableRecallAt5,
  summarizeAnswerableRecall
} from "../../longmemeval/measurement/answerable-recall.js";
import { cohort, streamedQuestion } from "../cli/cli-merge-evidence-fixture.js";

describe("answerable recall", () => {
  it("excludes abstention and answerable identity failures", () => {
    const diagnostics = [
      diagnostic("hit", "scorable", true),
      diagnostic("miss", "scorable", false),
      diagnostic("abstention_abs", "abstention", false),
      diagnostic("identity", "identity_unscorable", false)
    ];

    expect(summarizeAnswerableRecall(diagnostics)).toEqual({
      scorableCount: 2,
      rAt1: 0.5,
      rAt5: 0.5,
      rAt10: 0.5
    });
    expect(answerableRecallAt5(diagnostics.slice(0, 3))).toBe(0.5);
  });

  it("returns zero rates for a zero answerable denominator", () => {
    const diagnostics = [diagnostic("abstention_abs", "abstention", false)];

    expect(summarizeAnswerableRecall(diagnostics)).toEqual({
      scorableCount: 0,
      rAt1: 0,
      rAt5: 0,
      rAt10: 0
    });
  });
});

type MeasurementStatus = "scorable" | "abstention" | "identity_unscorable";

function diagnostic(
  questionId: string,
  status: MeasurementStatus,
  hit: boolean
): LongMemEvalQuestionDiagnostic {
  return {
    ...streamedQuestion(questionId),
    is_abstention: status === "abstention",
    hit_at_1: hit,
    hit_at_5: hit,
    hit_at_10: hit,
    miss_classification: hit ? "hit_at_5" : "candidate_absent",
    cohort_ledger: measurementLedger(status, hit)
  };
}

function measurementLedger(status: MeasurementStatus, hit: boolean) {
  if (status === "scorable") {
    return {
      ...cohort(),
      measurement_status: "scorable" as const,
      retrieval_status: hit ? "hit_at_5" as const : "miss_at_5" as const,
      final_verdict: hit ? "hit_at_5" as const : "miss_at_5" as const
    };
  }
  if (status === "abstention") return abstentionLedger();
  return identityUnscorableLedger();
}

function abstentionLedger() {
  return {
    ...cohort(),
    measurement_status: "abstention_unscorable" as const,
    dataset_cohort: "abstention" as const,
    retrieval_status: "not_applicable" as const,
    final_verdict: "abstention_uncalibrated" as const
  };
}

function identityUnscorableLedger() {
  return {
    ...cohort(),
    measurement_status: "evaluator_identity_unscorable" as const,
    retrieval_status: "not_applicable" as const,
    evaluation_issue_reason: "evaluator_data_identity_inconsistency" as const,
    final_verdict: "evaluator_data_identity_inconsistency" as const
  };
}
