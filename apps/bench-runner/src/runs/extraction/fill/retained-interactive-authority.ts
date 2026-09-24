import { AlayaError } from "@do-soul/alaya-protocol";
import { join } from "node:path";
import { boundedArtifactEntryExists } from "../cache-audit/bounded-artifact-reader.js";
import { readExtractionAuthorityReceipt, writeExtractionAuthorityReceiptExclusive,
  type ExtractionAuthorityReceipt } from "../authority/receipt.js";
import type { ExtractionCacheWriteLease } from "./manifest/fill-root-guard.js";
import { isGeminiGenerateContentProfile } from "./batch/native-codec.js";

function receiptPath(root: string, digest: string): string {
  if (!/^[a-f0-9]{64}$/u.test(digest)) throw new AlayaError("CONFLICT", "invalid interactive authority reference");
  return join(root, `interactive-authority-${digest}.json`);
}

/** Retain the authorized physical route before writing a raw attempt. */
export function retainInteractiveAuthority(lease: ExtractionCacheWriteLease, receipt: ExtractionAuthorityReceipt): void {
  lease.assertOwned();
  const path = receiptPath(lease.stableRootPath, receipt.receipt_digest);
  if (boundedArtifactEntryExists(path)) {
    readRetainedInteractiveAuthority(lease.stableRootPath, receipt.receipt_digest, receipt.lineage_digest);
    return;
  }
  writeExtractionAuthorityReceiptExclusive(path, receipt);
  lease.assertOwned();
}

export function readRetainedInteractiveAuthority(root: string, digest: string, lineageDigest: string): ExtractionAuthorityReceipt {
  const receipt = readExtractionAuthorityReceipt(receiptPath(root, digest));
  if (receipt.receipt_digest !== digest || receipt.lineage_digest !== lineageDigest ||
      receipt.observation.transport === undefined ||
      (receipt.observation.extraction.requestProfile !== "step-3.5-2603-low-json-schema-v1" &&
        !isGeminiGenerateContentProfile(receipt.observation.extraction.requestProfile))) {
    throw new AlayaError("CONFLICT", "retained interactive authority binding mismatch");
  }
  return receipt;
}
