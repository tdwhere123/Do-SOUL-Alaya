import { buildQuestionDiagnostic } from
  "../../../bench/diagnostics/diagnostics-question.js";
import type { LongMemEvalQuestionDiagnostic } from
  "../../../bench/diagnostics/schema/diagnostics-types.js";

export function assembledQuestion(input: {
  readonly questionId: string;
  readonly isAbstention?: boolean;
  readonly goldMemoryIds?: readonly string[];
}): LongMemEvalQuestionDiagnostic {
  return buildQuestionDiagnostic({
    questionId: input.questionId,
    goldMemoryIds: input.goldMemoryIds ?? [],
    answerSessionIds: input.goldMemoryIds !== undefined && input.goldMemoryIds.length > 0
      ? ["s1"]
      : [],
    deliveredResults: [],
    hitAt1: false,
    hitAt5: false,
    hitAt10: false,
    isAbstention: input.isAbstention === true,
    degradationReason: null,
    embeddingMode: "disabled",
    recallResult: { diagnostics: { candidates: [] } }
  });
}

export function flagOnlyQuestion(questionId: string): LongMemEvalQuestionDiagnostic {
  return assembledQuestion({ questionId, isAbstention: true });
}

export function cohortOnlyQuestion(questionId: string): LongMemEvalQuestionDiagnostic {
  const row = assembledQuestion({ questionId });
  return {
    ...row,
    miss_taxonomy: null,
    cohort_ledger: { ...row.cohort_ledger, dataset_cohort: "abstention" }
  };
}
