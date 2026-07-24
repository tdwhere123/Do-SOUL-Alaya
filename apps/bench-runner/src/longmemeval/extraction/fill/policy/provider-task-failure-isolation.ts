import { ExtractionCacheInvariantError } from
  "../../cache/cache-invariant-error.js";
import type { ExtractionAuthorityReceipt } from
  "../../authority/receipt.js";
import type { ExtractionTargetSelectionReceipt } from
  "../../authority/target-selection/receipt.js";

type FailureIsolationReceipt = Pick<
  ExtractionAuthorityReceipt,
  "action" | "target_selection_digest" | "probe_key" | "repair_scope" | "direct_spend"
>;

type FailureIsolationTargetSelection = Pick<
  ExtractionTargetSelectionReceipt,
  "receipt_digest"
>;

interface ProviderTaskFailureIsolationScope {
  readonly requested: boolean;
  readonly questionBatchLimit: number | undefined;
  readonly authority: {
    readonly receipt: FailureIsolationReceipt;
    readonly targetSelection?: FailureIsolationTargetSelection;
  } | undefined;
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
      receipt.direct_spend !== undefined) {
    throw new ExtractionCacheInvariantError(
      "provider task failure isolation requires a target-selection-bound fill authority"
    );
  }
}

export function resolveProviderTaskFailureTolerance(input: {
  readonly requested: boolean;
  readonly questionBatchLimit: number | undefined;
  readonly receipt: FailureIsolationReceipt | undefined;
  readonly expansion: boolean;
}): boolean {
  if (input.receipt?.action !== "fill") return false;
  if (input.questionBatchLimit !== undefined) return false;
  return input.requested || input.expansion ||
    input.receipt.direct_spend?.kind === "deepseek_newapi_direct_500" ||
    input.receipt.repair_scope !== undefined;
}
