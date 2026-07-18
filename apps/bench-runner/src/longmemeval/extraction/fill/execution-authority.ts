import { ExtractionCacheInvariantError } from "../cache/cache-invariant-error.js";
import { inspectExtractionAuthorityDisk } from "../authority/inspection.js";
import { openExtractionAttemptLedger } from "../authority/attempt-ledger.js";
import {
  assertDirectDeepSeek500RootBinding
} from "../authority/direct-deepseek-500.js";
import { createRequestStartPacer } from
  "../authority/direct-deepseek-500/request-pacer.js";
import { openDirectDeepSeekRequestStartState } from
  "../authority/direct-deepseek-500/request-start-state.js";
import {
  assertExtractionTargetSelectionRootBinding,
  type ExtractionTargetSelectionReceipt
} from "../authority/target-selection/receipt.js";
import { receiptExtractionCacheIdentity } from "../authority/receipt-cache-identity.js";
import type { ExtractionAuthorityReceipt } from "../authority/receipt.js";
import type { ExecutionExtractionAuthority } from "./fill-execution.js";

export function createExtractionExecutionAuthority(
  receipt: ExtractionAuthorityReceipt,
  cacheRoot: string,
  targetSelection: ExtractionTargetSelectionReceipt | undefined = undefined
): ExecutionExtractionAuthority {
  return receipt.limits.maximum_attempts === 0
    ? createExhaustedExecutionAuthority(receipt)
    : createLedgerExecutionAuthority(receipt, cacheRoot, targetSelection);
}

function createExhaustedExecutionAuthority(
  receipt: ExtractionAuthorityReceipt
): ExecutionExtractionAuthority {
  return {
    receipt,
    reserveAttempt: async () => {
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
  cacheRoot: string,
  targetSelection: ExtractionTargetSelectionReceipt | undefined
): ExecutionExtractionAuthority {
  const assertTarget = createTargetAssertion(receipt, cacheRoot, targetSelection);
  assertTarget();
  const ledger = openExtractionAttemptLedger({
    cacheRoot,
    lineageDigest: receipt.lineage_digest,
    cacheIdentity: receiptExtractionCacheIdentity(receipt),
    startingMissing: receipt.limits.starting_missing,
    maximumAttempts: receipt.limits.maximum_attempts,
    successfulShardCeiling: receipt.limits.successful_shard_ceiling
  });
  const directPacer = receipt.direct_spend === undefined
    ? undefined
    : createRequestStartPacer({
      requestsPerMinute: receipt.direct_spend.requests_per_minute,
      state: openDirectDeepSeekRequestStartState({
        cacheRoot,
        authorization: receipt.direct_spend
      })
    });
  return {
    receipt,
    reserveAttempt: async (cacheKey, signal) => {
      assertTarget();
      assertAuthorityDiskFloor(cacheRoot, receipt.limits.disk_floor_bytes);
      await directPacer?.wait(signal);
      signal?.throwIfAborted();
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

function createTargetAssertion(
  receipt: ExtractionAuthorityReceipt,
  cacheRoot: string,
  targetSelection: ExtractionTargetSelectionReceipt | undefined
): () => void {
  if (receipt.direct_spend === undefined && targetSelection === undefined) return () => undefined;
  return () => {
    if (receipt.direct_spend !== undefined) {
      assertDirectDeepSeek500RootBinding({ authorization: receipt.direct_spend, cacheRoot });
    }
    if (targetSelection !== undefined) {
      assertExtractionTargetSelectionRootBinding(targetSelection, cacheRoot);
    }
  };
}

function assertAuthorityDiskFloor(cacheRoot: string, floorBytes: number): void {
  const disk = inspectExtractionAuthorityDisk(cacheRoot);
  if (disk.status !== "available" || disk.freeBytes < floorBytes) {
    throw new ExtractionCacheInvariantError(
      "extraction authority disk floor is unavailable or exhausted"
    );
  }
}
