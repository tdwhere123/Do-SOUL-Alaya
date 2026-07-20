import { ExtractionCacheInvariantError } from
  "../../cache/cache-invariant-error.js";
import type { ExtractionAuthorityReceipt } from
  "../../authority/receipt.js";
import type { ExtractionTargetSelectionReceipt } from
  "../../authority/target-selection/receipt.js";
import type { PreparedExpansionFillAuthority } from
  "../../expansion-fill-authority.js";

interface ProviderTaskFailureIsolationScope {
  readonly requested: boolean;
  readonly questionBatchLimit: number | undefined;
  readonly authority: {
    readonly receipt: ExtractionAuthorityReceipt;
    readonly targetSelection?: ExtractionTargetSelectionReceipt;
  } | undefined;
  readonly expansion: PreparedExpansionFillAuthority | undefined;
}

export function assertProviderTaskFailureIsolationScope(
  input: ProviderTaskFailureIsolationScope
): void {
  if (!input.requested) return;
  if (input.questionBatchLimit !== undefined) {
    throw new ExtractionCacheInvariantError(
      "provider task failure isolation is full-window only and rejects question batch execution"
    );
  }
  const receipt = input.authority?.receipt;
  const targetSelection = input.authority?.targetSelection;
  if (receipt?.action !== "fill" || targetSelection === undefined ||
      receipt.target_selection_digest !== targetSelection.receipt_digest ||
      receipt.probe_key !== undefined || receipt.repair_scope !== undefined ||
      receipt.direct_spend !== undefined || input.expansion !== undefined) {
    throw new ExtractionCacheInvariantError(
      "provider task failure isolation requires a normal target-selection-bound fill authority"
    );
  }
}
