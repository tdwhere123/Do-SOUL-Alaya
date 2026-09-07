import type { BenchRecallOptions } from "../../../harness/daemon.js";
import type { RecallEvalRunContext } from "./recall-eval-run-context.js";

export function recallOptionsForQuestion(
  context: RecallEvalRunContext,
  questionText: string
): BenchRecallOptions {
  if (context.querySemanticFactorCache === null) {
    return context.recallOptions;
  }
  const capture = context.querySemanticFactorCache.captures_by_source_text.get(questionText);
  const receipt = context.querySemanticFactorCache.receipts_by_source_text.get(questionText);
  if (capture === undefined || (capture.status === "formed" && receipt === undefined)) {
    throw new Error("query semantic factor cache lost a required query source");
  }
  return {
    ...context.recallOptions,
    querySemanticFactorFormationCapture: capture,
    ...(receipt === undefined ? {} : { querySemanticFactorCompletenessReceipt: receipt })
  };
}
