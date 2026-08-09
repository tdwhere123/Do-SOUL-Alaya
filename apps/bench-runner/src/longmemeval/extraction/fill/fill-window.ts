import type { LongMemEvalVariant } from "../../ingestion/dataset.js";
import { loadDatasetWithIdentity } from "../../ingestion/fetch.js";
import type { PreparedExpansionFillAuthority } from "../expansion-fill-authority.js";
import {
  inspectTurnContentKeySpace,
  type LongMemEvalExtractionTurn
} from "../turn-contents.js";

interface ExtractionFillWindowOptions {
  readonly variant: LongMemEvalVariant;
  readonly limit?: number;
  readonly offset?: number;
  readonly questionBatchLimit?: number;
  readonly dataDir?: string;
  readonly pinnedMetaRoot?: string;
}

interface ExtractionFillWindow {
  readonly distinctTurns: readonly string[];
  readonly executionTurns: readonly string[];
  readonly distinctExtractionTurns: readonly LongMemEvalExtractionTurn[];
  readonly executionExtractionTurns: readonly LongMemEvalExtractionTurn[];
  readonly requestedTurns: number;
  readonly executionRequestedTurns: number;
  readonly windowUniqueCacheKeys: number;
  readonly windowTurnOccurrences: number;
  readonly executionTurnOccurrences: number;
  readonly questionCount: number;
  readonly datasetRevision: string;
  readonly windowOffset: number;
  readonly questionBatchLimit?: number;
}

export async function prepareExtractionFillWindow(
  options: ExtractionFillWindowOptions,
  expansion: PreparedExpansionFillAuthority | undefined
): Promise<ExtractionFillWindow> {
  if (expansion !== undefined) {
    return prepareExpansionWindow(options, expansion);
  }
  return await prepareDatasetWindow(options);
}

function prepareExpansionWindow(
  options: ExtractionFillWindowOptions,
  expansion: PreparedExpansionFillAuthority
): ExtractionFillWindow {
  if (options.questionBatchLimit !== undefined) {
    throw new Error("question-bounded extraction cannot mix an expansion capability");
  }
  const keySpace = inspectTurnContentKeySpace(expansion.nextQuestions);
  assertSameTurnWindow(keySpace.distinctExtractionTurns, expansion.nextTurns);
  const turnContents = expansion.nextTurns.map(({ turnContent }) => turnContent);
  return {
    distinctTurns: turnContents,
    executionTurns: turnContents,
    distinctExtractionTurns: expansion.nextTurns,
    executionExtractionTurns: expansion.nextTurns,
    requestedTurns: keySpace.distinctExtractionRequestCount,
    executionRequestedTurns: keySpace.distinctExtractionRequestCount,
    windowUniqueCacheKeys: keySpace.distinctExtractionRequestCount,
    windowTurnOccurrences: expansion.nextTurns.length,
    executionTurnOccurrences: expansion.nextTurns.length,
    questionCount: expansion.nextQuestions.length,
    datasetRevision: expansion.datasetRevision,
    windowOffset: 0
  };
}

async function prepareDatasetWindow(
  options: ExtractionFillWindowOptions
): Promise<ExtractionFillWindow> {
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
  const windowKeySpace = inspectTurnContentKeySpace(questions);
  const executionKeySpace = inspectTurnContentKeySpace(questions.slice(0, batchLimit));
  const distinctTurns = windowKeySpace.distinctTurnContents;
  const executionTurns = executionKeySpace.distinctTurnContents;
  return {
    distinctTurns,
    executionTurns,
    distinctExtractionTurns: windowKeySpace.distinctExtractionTurns,
    executionExtractionTurns: executionKeySpace.distinctExtractionTurns,
    requestedTurns: windowKeySpace.distinctExtractionRequestCount,
    executionRequestedTurns: executionKeySpace.distinctExtractionRequestCount,
    windowUniqueCacheKeys: windowKeySpace.distinctExtractionRequestCount,
    windowTurnOccurrences: windowKeySpace.turnOccurrences,
    executionTurnOccurrences: executionKeySpace.turnOccurrences,
    questionCount: questions.length,
    datasetRevision: dataset.sha256,
    windowOffset: offset,
    ...(options.questionBatchLimit === undefined ? {} : {
      questionBatchLimit: options.questionBatchLimit
    })
  };
}

function assertSameTurnWindow(
  actual: readonly LongMemEvalExtractionTurn[],
  expected: readonly LongMemEvalExtractionTurn[]
): void {
  if (actual.length === expected.length && actual.every((turn, index) =>
    sameExtractionTurn(turn, expected[index])
  )) {
    return;
  }
  throw new Error("expansion extraction turns disagree with the trusted message window");
}

function sameExtractionTurn(
  left: LongMemEvalExtractionTurn,
  right: LongMemEvalExtractionTurn | undefined
): boolean {
  return right !== undefined && left.turnContent === right.turnContent &&
    left.turnMessages.length === right.turnMessages.length &&
    left.turnMessages.every((message, index) =>
      message.role === right.turnMessages[index]?.role &&
      message.content === right.turnMessages[index]?.content
    );
}

function resolveQuestionBatchLimit(raw: number | undefined, questionCount: number): number {
  if (raw === undefined) return questionCount;
  if (!Number.isSafeInteger(raw) || raw < 1 || raw > questionCount) {
    throw new Error(`question batch limit must be within the ${questionCount}-question window`);
  }
  return raw;
}
