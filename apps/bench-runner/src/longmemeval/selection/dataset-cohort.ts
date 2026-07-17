import type { LongMemEvalQuestion } from "../ingestion/dataset.js";

export type LongMemEvalDatasetCohort = "answerable" | "abstention";

export function classifyLongMemEvalDatasetCohort(
  question: Pick<LongMemEvalQuestion, "question_id">
): LongMemEvalDatasetCohort {
  return question.question_id.endsWith("_abs") ? "abstention" : "answerable";
}
