import { join } from "node:path";
import { readExtractionAuthorityReceipt, writeExtractionAuthorityReceiptExclusive,
  type ExtractionAuthorityReceipt } from "../../authority/receipt.js";
import type { ExtractionCacheWriteLease } from "../manifest/fill-root-guard.js";

function receiptPath(root: string, planIdentity: string): string {
  if (!/^[a-f0-9]{64}$/u.test(planIdentity)) throw new Error("invalid Batch authority reference");
  return join(root, `batch-authority-${planIdentity}.json`);
}

/** Retain the already-authorized receipt; this neither grants nor reserves an attempt. */
export function retainBatchAuthority(lease: ExtractionCacheWriteLease, planIdentity: string, receipt: ExtractionAuthorityReceipt): void {
  lease.assertOwned();
  writeExtractionAuthorityReceiptExclusive(receiptPath(lease.stableRootPath, planIdentity), receipt);
  lease.assertOwned();
}

export function readRetainedBatchAuthority(root: string, planIdentity: string, receiptDigest: string) {
  const receipt = readExtractionAuthorityReceipt(receiptPath(root, planIdentity));
  if (receipt.receipt_digest !== receiptDigest || receipt.observation.transport === undefined) {
    throw new Error("retained Batch authority binding mismatch");
  }
  return receipt;
}
