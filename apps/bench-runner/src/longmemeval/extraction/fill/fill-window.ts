import type { LongMemEvalVariant } from "../../ingestion/dataset.js";
import { loadDatasetWithIdentity } from "../../ingestion/fetch.js";
import type { PreparedExpansionFillAuthority } from "../expansion-fill-authority.js";
import { collectDistinctTurnContents } from "../turn-contents.js";

export async function prepareExtractionFillWindow(
  options: {
    readonly variant: LongMemEvalVariant;
    readonly limit?: number;
    readonly offset?: number;
    readonly questionBatchLimit?: number;
    readonly dataDir?: string;
    readonly pinnedMetaRoot?: string;
  },
  expansion: PreparedExpansionFillAuthority | undefined
) {
  if (expansion !== undefined) {
    if (options.questionBatchLimit !== undefined) {
      throw new Error("question-bounded extraction cannot mix an expansion capability");
    }
    return {
      distinctTurns: expansion.nextTurns,
      executionTurns: expansion.nextTurns,
      requestedTurns: expansion.nextTurns.length,
      questionCount: expansion.nextQuestions.length,
      datasetRevision: expansion.datasetRevision,
      windowOffset: 0
    };
  }
  const dataset = await loadDatasetWithIdentity(options.variant, {
    dataDir: options.dataDir,
    pinnedMetaRoot: options.pinnedMetaRoot
  });
  const offset = Math.max(0, options.offset ?? 0);
  const sliceEnd = options.limit === undefined
    ? dataset.questions.length
    : offset + options.limit;
  const questions = dataset.questions.slice(offset, sliceEnd);
  const batchLimit = resolveQuestionBatchLimit(options.questionBatchLimit, questions.length);
  const distinctTurns = collectDistinctTurnContents(questions);
  const executionTurns = collectDistinctTurnContents(questions.slice(0, batchLimit));
  return {
    distinctTurns,
    executionTurns,
    requestedTurns: distinctTurns.length,
    questionCount: questions.length,
    datasetRevision: dataset.sha256,
    windowOffset: offset,
    ...(options.questionBatchLimit === undefined ? {} : {
      questionBatchLimit: options.questionBatchLimit
    })
  };
}

function resolveQuestionBatchLimit(raw: number | undefined, questionCount: number): number {
  if (raw === undefined) return questionCount;
  if (!Number.isSafeInteger(raw) || raw < 1 || raw > questionCount) {
    throw new Error(`question batch limit must be within the ${questionCount}-question window`);
  }
  return raw;
}
