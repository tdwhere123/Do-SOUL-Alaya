import type { BenchRecallOptions } from "../../../harness/daemon.js";
import type { RecallEvalRunContext } from "./recall-eval-run-context.js";

export function recallOptionsForQuestion(
  context: RecallEvalRunContext,
  questionText: string,
  selectionBoundaryObserver: BenchRecallOptions["selectionBoundaryObserver"]
): BenchRecallOptions {
  if (context.querySemanticFactorCache === null) {
    return selectionBoundaryObserver === undefined
      ? context.recallOptions
      : { ...context.recallOptions, selectionBoundaryObserver };
  }
  const capture = context.querySemanticFactorCache.captures_by_source_text.get(questionText);
  if (capture === undefined) {
    throw new Error("query semantic factor cache lost a required query source");
  }
  return {
    ...context.recallOptions,
    ...(selectionBoundaryObserver === undefined ? {} : { selectionBoundaryObserver }),
    querySemanticFactorFormationCapture: capture
  };
}
