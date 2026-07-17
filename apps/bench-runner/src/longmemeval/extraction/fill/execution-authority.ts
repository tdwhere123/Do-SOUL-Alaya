import { ExtractionCacheInvariantError } from "../cache/cache-invariant-error.js";
import { inspectExtractionAuthorityDisk } from "../authority/inspection.js";
import { openExtractionAttemptLedger } from "../authority/attempt-ledger.js";
import { assertDirectDeepSeek500RootBinding } from "../authority/direct-deepseek-500.js";
import { receiptExtractionCacheIdentity } from "../authority/receipt-cache-identity.js";
import type { ExtractionAuthorityReceipt } from "../authority/receipt.js";
import type { ExecutionExtractionAuthority } from "./fill-execution.js";

export function createExtractionExecutionAuthority(
  receipt: ExtractionAuthorityReceipt,
  cacheRoot: string
): ExecutionExtractionAuthority {
  return receipt.limits.maximum_attempts === 0
    ? createExhaustedExecutionAuthority(receipt)
    : createLedgerExecutionAuthority(receipt, cacheRoot);
}

function createExhaustedExecutionAuthority(
  receipt: ExtractionAuthorityReceipt
): ExecutionExtractionAuthority {
  return {
    receipt,
    reserveAttempt: () => {
      throw new ExtractionCacheInvariantError(
        "extraction authority has no remaining provider attempt capacity"
      );
    },
    abandonPendingShard: () => undefined,
    commitSuccessfulShard: () => {
      throw new ExtractionCacheInvariantError(
        "extraction authority has no remaining successful-shard capacity"
      );
    },
    recordTransportOutcome: () => undefined,
    snapshot: () => undefined
  };
}

function createLedgerExecutionAuthority(
  receipt: ExtractionAuthorityReceipt,
  cacheRoot: string
): ExecutionExtractionAuthority {
  const ledger = openExtractionAttemptLedger({
    cacheRoot,
    lineageDigest: receipt.lineage_digest,
    cacheIdentity: receiptExtractionCacheIdentity(receipt),
    startingMissing: receipt.limits.starting_missing,
    maximumAttempts: receipt.limits.maximum_attempts,
    successfulShardCeiling: receipt.limits.successful_shard_ceiling
  });
  const assertTarget = createDirectTargetAssertion(receipt, cacheRoot);
  return {
    receipt,
    reserveAttempt: (cacheKey) => {
      assertTarget();
      assertAuthorityDiskFloor(cacheRoot, receipt.limits.disk_floor_bytes);
      ledger.reserveAttempt(cacheKey);
    },
    abandonPendingShard: ledger.abandonPendingShard,
    commitSuccessfulShard: ledger.commitSuccessfulShard,
    recordTransportOutcome: ledger.recordTransportOutcome,
    snapshot: ledger.snapshot
  };
}

function createDirectTargetAssertion(
  receipt: ExtractionAuthorityReceipt,
  cacheRoot: string
): () => void {
  if (receipt.direct_spend === undefined) return () => undefined;
  return () => assertDirectDeepSeek500RootBinding({
    authorization: receipt.direct_spend!,
    cacheRoot
  });
}

function assertAuthorityDiskFloor(cacheRoot: string, floorBytes: number): void {
  const disk = inspectExtractionAuthorityDisk(cacheRoot);
  if (disk.status !== "available" || disk.freeBytes < floorBytes) {
    throw new ExtractionCacheInvariantError(
      "extraction authority disk floor is unavailable or exhausted"
    );
  }
}
