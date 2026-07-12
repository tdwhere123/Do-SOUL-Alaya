import { createHash } from "node:crypto";
import type { LongMemEvalQuestionDiagnostic } from "./diagnostics-types.js";

export const LONGMEMEVAL_COHORT_LEDGER_FILENAME =
  "longmemeval-cohort-ledger.json";

export function renderLongMemEvalCohortLedger(
  questions: readonly LongMemEvalQuestionDiagnostic[],
  failedQuestionIds: readonly string[] = []
): string {
  const diagnosticIds = new Set(questions.map((question) => question.question_id));
  const duplicateFailures = failedQuestionIds.filter((id) => diagnosticIds.has(id));
  if (duplicateFailures.length > 0) {
    throw new Error(`LongMemEval cohort ledger duplicates failed question: ${duplicateFailures[0]}`);
  }
  const ids = [...questions.map((question) => question.question_id), ...failedQuestionIds];
  if (new Set(ids).size !== ids.length) {
    throw new Error("LongMemEval cohort ledger refuses duplicate question IDs");
  }
  const rows = questions.map((question) => {
    if (question.cohort_ledger === undefined) {
      throw new Error(`LongMemEval cohort ledger missing for ${question.question_id}`);
    }
    return { question_id: question.question_id, ...question.cohort_ledger };
  });
  rows.push(...failedQuestionIds.map(failedQuestionCohortRow));
  return `${JSON.stringify({
    schema_version: 1,
    question_count: rows.length,
    question_id_digest: createHash("sha256").update(ids.join("\0"), "utf8").digest("hex"),
    rows
  }, null, 2)}\n`;
}

function failedQuestionCohortRow(questionId: string) {
  const abstention = questionId.endsWith("_abs");
  return {
    question_id: questionId,
    measurement_status: abstention
      ? "abstention_unscorable" as const
      : "evaluator_identity_unscorable" as const,
    dataset_cohort: abstention ? "abstention" as const : "answerable" as const,
    extraction_materialization: {
      status: "unknown" as const,
      emitted_memory_count: 0,
      reason: null
    },
    evaluator_gold_identity: { status: "absent" as const, object_ids: [] },
    retrieval_status: "not_applicable" as const,
    evidence_status: "missing" as const,
    evaluation_issue_reason: abstention ? null : "missing_diagnostics" as const,
    candidate_pool_complete: false,
    stage_ranks: [],
    final_verdict: abstention
      ? "abstention_uncalibrated" as const
      : "evaluation_unscorable" as const
  };
}
