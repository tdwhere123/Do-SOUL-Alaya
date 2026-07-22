import {
  readExtractionTargetSelectionReceipt,
  requiresExtractionTargetSelection,
  type ExtractionTargetSelectionReceipt
} from "../authority/target-selection/receipt.js";
import { ExtractionCacheInvariantError } from "../cache/cache-invariant-error.js";
import type { ExtractionAuthorityReceipt } from "../authority/receipt.js";
import type { ExtractionFillOptions } from "../extraction-fill.js";

export function loadReceiptTargetSelection(
  options: ExtractionFillOptions,
  receipt: ExtractionAuthorityReceipt
): ExtractionTargetSelectionReceipt | undefined {
  const required = receipt.direct_spend === undefined &&
    receipt.repair_scope === undefined && receipt.catalog_refill === undefined &&
    options.extractorFactory === undefined &&
    requiresExtractionTargetSelection(receipt.observation);
  if (receipt.target_selection_digest === undefined) {
    if (options.targetSelectionReceiptPath !== undefined) {
      throw new ExtractionCacheInvariantError(
        "extraction authority receipt does not bind the supplied target selection"
      );
    }
    if (required) {
      throw new ExtractionCacheInvariantError(
        "canonical normal LongMemEval-S live extraction authority requires a target selection receipt"
      );
    }
    return undefined;
  }
  if (options.targetSelectionReceiptPath === undefined) {
    throw new ExtractionCacheInvariantError(
      "extraction authority receipt requires --extraction-target-selection"
    );
  }
  const targetSelection = readExtractionTargetSelectionReceipt(options.targetSelectionReceiptPath);
  if (targetSelection.receipt_digest !== receipt.target_selection_digest) {
    throw new ExtractionCacheInvariantError(
      "extraction authority receipt does not match the target selection receipt"
    );
  }
  return targetSelection;
}
