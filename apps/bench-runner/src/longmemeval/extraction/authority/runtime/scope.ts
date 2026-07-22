import type { PreparedExpansionFillAuthority } from "../../expansion-fill-authority.js";
import type { ExtractionFillOptions } from "../../extraction-fill.js";
import { ExtractionCacheInvariantError } from "../../cache/cache-invariant-error.js";
import type { ExtractionAuthorityReceipt } from "../receipt.js";

export function assertDirectExtractionMetadataScope(
  options: ExtractionFillOptions,
  receipt: ExtractionAuthorityReceipt
): void {
  if (receipt.direct_spend !== undefined && options.pinnedMetaRoot !== undefined) {
    throw new ExtractionCacheInvariantError(
      "direct extraction cannot use pinnedMetaRoot (--pinned-meta-root)"
    );
  }
}

export function assertReceiptBoundExpansionSpend(
  receipt: ExtractionAuthorityReceipt,
  expansion: PreparedExpansionFillAuthority
): void {
  const approval = expansion.r3SpendApproval.approval;
  const limits = receipt.limits;
  if (receipt.action !== "fill" ||
      receipt.observation.dataset.variant !== "longmemeval_s" ||
      receipt.observation.dataset.windowOffset !== 0 ||
      receipt.observation.dataset.windowLimit !== 500 ||
      receipt.observation.extraction.manifestSha256 !== approval.r2.final_cache_identity_sha256 ||
      receipt.observation.inventory.missingTurns !== approval.spend.starting_missing ||
      limits.starting_missing !== approval.spend.starting_missing ||
      limits.maximum_attempts !== approval.spend.maximum_attempts ||
      limits.successful_shard_ceiling !== approval.spend.successful_shard_ceiling ||
      limits.disk_floor_bytes < approval.spend.disk_floor_bytes ||
      receipt.price.estimated_upper_usd > approval.spend.estimated_cost_usd) {
    throw new ExtractionCacheInvariantError(
      "500Q extraction authority receipt does not match the approved R3 spend envelope"
    );
  }
}
