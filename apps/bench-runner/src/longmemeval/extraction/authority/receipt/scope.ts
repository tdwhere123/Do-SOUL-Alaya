import { assertCatalogRefillScopeMatchesReceipt } from "../catalog-refill/scope.js";
import type { ExtractionAuthorityReceipt } from "../receipt.js";

export function assertExtractionAuthorityReceiptScope(
  receipt: ExtractionAuthorityReceipt
): void {
  assertContinuationScope(receipt);
  assertCatalogRefillScope(receipt);
  assertRepairScope(receipt);
}

function assertContinuationScope(receipt: ExtractionAuthorityReceipt): void {
  if (receipt.continuation !== undefined &&
      (receipt.action !== "fill" || receipt.target_selection_digest === undefined ||
       receipt.direct_spend !== undefined || receipt.repair_scope !== undefined ||
       receipt.catalog_refill !== undefined)) {
    throw new Error("same-root continuation authority scope is inconsistent");
  }
}

function assertCatalogRefillScope(receipt: ExtractionAuthorityReceipt): void {
  if (receipt.catalog_refill === undefined) return;
  assertCatalogRefillScopeMatchesReceipt(receipt.catalog_refill, receipt.observation);
  if (receipt.action !== "fill" || receipt.target_selection_digest === undefined ||
      receipt.direct_spend !== undefined || receipt.repair_scope !== undefined ||
      receipt.continuation !== undefined) {
    throw new Error("catalog refill authority scope is inconsistent");
  }
}

function assertRepairScope(receipt: ExtractionAuthorityReceipt): void {
  if ((receipt.repair_scope === undefined) !==
        (receipt.observation.inventory.invalidTurns === 0) ||
      (receipt.repair_scope !== undefined &&
        (receipt.action !== "fill" || receipt.repair_scope.shard_count !==
          receipt.observation.inventory.invalidTurns ||
          receipt.repair_scope.preserved_valid_closure.shard_count !==
            receipt.observation.inventory.validTurns))) {
    throw new Error("extraction repair authority scope is inconsistent");
  }
}
