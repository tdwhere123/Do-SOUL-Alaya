import type { ExtractionAuthorityReceipt } from "./receipt.js";

export function receiptExtractionCacheIdentity(
  receipt: ExtractionAuthorityReceipt
): {
  readonly model: string;
  readonly requestProfile: ExtractionAuthorityReceipt["observation"]["extraction"]["requestProfile"];
} {
  return {
    model: receipt.observation.extraction.model,
    requestProfile: receipt.observation.extraction.requestProfile
  };
}
