import type { BenchRecallOptions } from "../../../harness/daemon.js";
import type { RecallEvalRunContext } from "./recall-eval-run-context.js";

export function recallOptionsForQuestion(
  context: RecallEvalRunContext,
  _questionText: string
): BenchRecallOptions {
  if (context.querySemanticFactorCache === null) {
    return context.recallOptions;
  }
  throw new Error("query semantic factor cache input is retired for conditional-field Recall");
}
