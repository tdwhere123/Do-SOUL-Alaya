import type { LongMemEvalVariant } from "../../../ingestion/dataset.js";
import type { ExtractionAuthorityReceipt } from "../receipt.js";

interface BoundedRepairOptions {
  readonly variant: LongMemEvalVariant;
  readonly limit?: number;
  readonly offset?: number;
  readonly questionBatchLimit?: number;
}

export function isBoundedExistingCacheRepair(
  options: BoundedRepairOptions,
  receipt: ExtractionAuthorityReceipt | undefined
): boolean {
  if (receipt?.repair_scope === undefined || receipt.action !== "fill") return false;
  const dataset = receipt.observation.dataset;
  const inventory = receipt.observation.inventory;
  const authorizedQuestions = dataset.authorizedQuestionCount;
  return options.variant === "longmemeval_s" && dataset.variant === options.variant &&
    (options.offset ?? 0) === dataset.windowOffset && dataset.windowOffset === 0 &&
    options.limit === dataset.windowLimit && dataset.windowLimit === 500 &&
    authorizedQuestions !== undefined && authorizedQuestions > 0 &&
    authorizedQuestions < dataset.windowLimit &&
    options.questionBatchLimit === authorizedQuestions &&
    inventory.missingTurns === 0 && inventory.invalidTurns > 0 &&
    receipt.repair_scope.shard_count === inventory.invalidTurns;
}
