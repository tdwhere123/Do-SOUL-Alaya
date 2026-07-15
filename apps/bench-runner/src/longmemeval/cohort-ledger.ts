import { computeLongMemEvalQuestionIdDigest } from "@do-soul/alaya-eval";
import type { LongMemEvalQuestionDiagnostic } from "./diagnostics-types.js";
import { classifyLongMemEvalDatasetCohort } from "./selection/dataset-cohort.js";
import {
  assertSelectionCohortBinding,
  selectionContractIdentity,
  type LongMemEvalSelectionContract
} from "./selection/contract.js";

export const LONGMEMEVAL_COHORT_LEDGER_FILENAME =
  "longmemeval-cohort-ledger.json";

export function renderLongMemEvalCohortLedger(
  questions: readonly LongMemEvalQuestionDiagnostic[],
  failedQuestionIds: readonly string[] = [],
  selectionContract?: LongMemEvalSelectionContract
): string {
  const diagnosticIds = new Set(questions.map((question) => question.question_id));
  const duplicateFailures = failedQuestionIds.filter((id) => diagnosticIds.has(id));
  if (duplicateFailures.length > 0) {
    throw new Error(`LongMemEval cohort ledger duplicates failed question: ${duplicateFailures[0]}`);
  }
  const rows = buildCohortRows(questions, failedQuestionIds, selectionContract);
  const ids = rows.map((row) => row.question_id);
  if (new Set(ids).size !== ids.length) {
    throw new Error("LongMemEval cohort ledger refuses duplicate question IDs");
  }
  if (selectionContract !== undefined) {
    assertSelectionCohortBinding(selectionContract, rows);
  }
  return `${JSON.stringify({
    schema_version: 1,
    question_count: rows.length,
    question_id_digest: computeLongMemEvalQuestionIdDigest(ids),
    ...(selectionContract === undefined
      ? {}
      : { selection_contract: selectionContractIdentity(selectionContract) }),
    rows
  }, null, 2)}\n`;
}

function buildCohortRows(
  questions: readonly LongMemEvalQuestionDiagnostic[],
  failedQuestionIds: readonly string[],
  contract: LongMemEvalSelectionContract | undefined
) {
  const cohortById = new Map(contract?.assignments.map((row) =>
    [row.question_id, row.dataset_cohort] as const
  ));
  const rows = questions.map(diagnosticCohortRow);
  rows.push(...failedQuestionIds.map((id) => failedQuestionCohortRow(id, cohortById.get(id))));
  if (contract === undefined) return rows;
  if (rows.length !== contract.assignments.length) {
    throw new Error("selection cohort binding row count differs from immutable contract");
  }
  const byId = new Map(rows.map((row) => [row.question_id, row] as const));
  return contract.assignments.map((assignment) => {
    const row = byId.get(assignment.question_id);
    if (row === undefined) throw new Error(`selection cohort binding missing ${assignment.question_id}`);
    return row;
  });
}

function diagnosticCohortRow(question: LongMemEvalQuestionDiagnostic) {
  if (question.cohort_ledger === undefined) {
    throw new Error(`LongMemEval cohort ledger missing for ${question.question_id}`);
  }
  return { question_id: question.question_id, ...question.cohort_ledger };
}

function failedQuestionCohortRow(
  questionId: string,
  expectedCohort?: "answerable" | "abstention"
) {
  const cohort = expectedCohort ?? classifyLongMemEvalDatasetCohort({ question_id: questionId });
  const abstention = cohort === "abstention";
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
