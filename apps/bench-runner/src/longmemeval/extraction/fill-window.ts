import type { LongMemEvalVariant } from "../dataset.js";
import { loadDatasetWithIdentity } from "../fetch.js";
import type { PreparedExpansionFillAuthority } from "./expansion-fill-authority.js";
import { collectDistinctTurnContents } from "./turn-contents.js";

export async function prepareExtractionFillWindow(
  options: {
    readonly variant: LongMemEvalVariant;
    readonly limit?: number;
    readonly offset?: number;
    readonly dataDir?: string;
    readonly pinnedMetaRoot?: string;
  },
  expansion: PreparedExpansionFillAuthority | undefined
) {
  if (expansion !== undefined) {
    return {
      distinctTurns: expansion.nextTurns,
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
  const distinctTurns = collectDistinctTurnContents(
    dataset.questions.slice(offset, sliceEnd)
  );
  return {
    distinctTurns,
    requestedTurns: distinctTurns.length,
    questionCount: dataset.questions.slice(offset, sliceEnd).length,
    datasetRevision: dataset.sha256,
    windowOffset: offset
  };
}
