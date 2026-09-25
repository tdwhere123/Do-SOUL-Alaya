import { assertSampleKeys, assertSampleReceipt, isInteractiveSourceSampleReceipt } from "../authority/sample-scope.js";
import { STEP_SEMANTIC_REQUEST_PROFILE } from "../../compile-seed/http/semantic-provider-http.js";
import { readRootBatchRuns } from "./batch/store.js";
import { ExtractionCacheInvariantError } from "../cache/cache-invariant-error.js";
import { inspectExtractionAuthorityDisk } from "../authority/inspection.js";
import {
  openExtractionAttemptLedger,
  type ExtractionAttemptLedgerSnapshot
} from "../authority/attempt-ledger.js";
import {
  assertDirectExtractionSpendRootBinding
} from "../authority/direct-spend.js";
import {
  assertExtractionTargetSelectionRootBinding,
  type ExtractionTargetSelectionReceipt
} from "../authority/target-selection/receipt.js";
import { receiptExtractionCacheIdentity } from "../authority/receipt-cache-identity.js";
import type { ExtractionAuthorityReceipt } from "../authority/receipt.js";
import type { ExecutionExtractionAuthority } from "./fill-execution.js";
import type { ExtractionCacheWriteLease } from "./manifest/fill-root-guard.js";
import { assertExtractionAuthorityKeyInScope } from "../authority/receipt/scope.js";
import { assertCatalogRefillRootBinding } from "../authority/catalog-refill/scope.js";

export function createExtractionExecutionAuthority(
  receipt: ExtractionAuthorityReceipt,
  cacheRoot: string,
  targetSelection: ExtractionTargetSelectionReceipt | undefined = undefined,
  writeLease: ExtractionCacheWriteLease | undefined = undefined
): ExecutionExtractionAuthority {
  assertSampleReceipt(receipt);
  return receipt.limits.maximum_attempts === 0
    ? createExhaustedExecutionAuthority(receipt)
    : createLedgerExecutionAuthority(
      receipt, cacheRoot, targetSelection, writeLease
    );
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
    commitDeterministicShard: () => {
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
  targetSelection: ExtractionTargetSelectionReceipt | undefined,
  writeLease: ExtractionCacheWriteLease | undefined
): ExecutionExtractionAuthority {
  const assertTarget = createTargetAssertion(
    receipt, cacheRoot, targetSelection, writeLease
  );
  assertTarget();
  const ledger = openReceiptAttemptLedger(receipt, cacheRoot);
  const snapshot = ledger.snapshot();
  for (const key of new Set([
    ...snapshot.unresolvedAttempts.map(attempt => attempt.cacheKey),
    ...snapshot.settledAttempts.map(attempt => attempt.cacheKey),
    ...snapshot.successfulEntries.map(entry => entry.cacheKey),
    ...snapshot.transportFailures.map(failure => failure.cacheKey),
    ...snapshot.pendingKeys
  ])) assertExtractionAuthorityKeyInScope(receipt, key);
  assertCatalogRefillLedgerIsCurrent(receipt, snapshot);
  const reserveAttemptOrdinal = async (cacheKey: string, signal?: AbortSignal): Promise<number> => {
    assertExtractionAuthorityKeyInScope(receipt, cacheKey);
    assertTarget();
    assertAuthorityDiskFloor(cacheRoot, receipt.limits.disk_floor_bytes);
    signal?.throwIfAborted();
    assertTarget();
    assertAuthorityDiskFloor(cacheRoot, receipt.limits.disk_floor_bytes);
    return ledger.reserveAttemptOrdinal(cacheKey);
  };
  return {
    receipt,
    reserveAttempt: async (cacheKey, signal) => {
      if (receipt.sample_scope !== undefined && !isInteractiveSourceSampleReceipt(receipt)) {
        throw new Error("sample requires the exact Batch submission reservation");
      }
      return reserveAttemptOrdinal(cacheKey, signal);
    },
    reserveAttemptOrdinal: receipt.sample_scope === undefined || isInteractiveSourceSampleReceipt(receipt)
      ? reserveAttemptOrdinal : undefined,
    reserveSampleBatch: receipt.sample_scope === undefined || isInteractiveSourceSampleReceipt(receipt) ? undefined : async (keys, signal) => {
      assertSampleKeys(receipt.sample_scope!, keys);
      assertTarget();
      if (writeLease === undefined) throw new Error("sample requires the cache write lease");
      const jobs = readRootBatchRuns(writeLease).flatMap((run) => run.state.jobs)
        .filter((job) => job.submittedAt !== undefined);
      if (jobs.length !== 1 || jobs[0]!.status !== "submission_unknown" ||
          jobs[0]!.attemptOrdinals !== undefined || ledger.snapshot().attempts !== 0) {
        throw new Error("sample reservation requires its single fresh durable submission intent");
      }
      assertSampleKeys(receipt.sample_scope!, jobs[0]!.lineKeys);
      const ordinals: Record<string, number> = {};
      for (const key of keys) ordinals[key] = await reserveAttemptOrdinal(key, signal);
      return Object.freeze(ordinals);
    },
    abandonPendingShard: (key, ordinal) => {
      assertExtractionAuthorityKeyInScope(receipt, key);
      ledger.abandonPendingShard(key, ordinal);
    },
    commitSuccessfulShard: (key) => {
      assertExtractionAuthorityKeyInScope(receipt, key);
      ledger.commitSuccessfulShard(key);
    },
    commitDeterministicShard: receipt.catalog_refill === undefined && receipt.sample_scope === undefined
      ? (key) => {
          assertExtractionAuthorityKeyInScope(receipt, key);
          ledger.commitDeterministicShard(key);
        }
      : () => {
          throw new ExtractionCacheInvariantError(
            "catalog refill cannot commit a deterministic shard"
          );
        },
    recordTransportOutcome: (key, outcome, ordinal) => {
      assertExtractionAuthorityKeyInScope(receipt, key);
      return ledger.recordTransportOutcome(key, outcome, ordinal);
    },
    snapshot: ledger.snapshot
  };
}

function assertCatalogRefillLedgerIsCurrent(
  receipt: ExtractionAuthorityReceipt,
  snapshot: ExtractionAttemptLedgerSnapshot
): void {
  if (receipt.catalog_refill === undefined ||
      snapshot.successfulEntries.every((entry) => entry.successKind !== "legacy-unclassified")) {
    return;
  }
  throw new ExtractionCacheInvariantError(
    "catalog refill cannot resume a legacy attempt ledger without typed transport provenance"
  );
}

function openReceiptAttemptLedger(receipt: ExtractionAuthorityReceipt, cacheRoot: string) {
  return openExtractionAttemptLedger({
    cacheRoot,
    lineageDigest: receipt.lineage_digest,
    cacheIdentity: receiptExtractionCacheIdentity(receipt),
    startingMissing: receipt.limits.starting_missing,
    maximumAttempts: receipt.limits.maximum_attempts,
    ...((receipt.observation.extraction.requestProfile === STEP_SEMANTIC_REQUEST_PROFILE &&
      receipt.observation.extraction.sourcePacking === "complete-source" ||
      isInteractiveSourceSampleReceipt(receipt))
      ? { maximumAttemptsPerKey: 1 } : {}),
    successfulShardCeiling: receipt.limits.successful_shard_ceiling
  });
}

function createTargetAssertion(
  receipt: ExtractionAuthorityReceipt,
  cacheRoot: string,
  targetSelection: ExtractionTargetSelectionReceipt | undefined,
  writeLease: ExtractionCacheWriteLease | undefined
): () => void {
  return () => {
    writeLease?.assertOwned();
    if (receipt.direct_spend !== undefined) {
      assertDirectExtractionSpendRootBinding({
        authorization: receipt.direct_spend,
        cacheRoot,
        ...(writeLease === undefined ? {} : { writeLease })
      });
    }
    if (targetSelection !== undefined) {
      assertExtractionTargetSelectionRootBinding(targetSelection, cacheRoot, writeLease);
    }
    if (receipt.catalog_refill !== undefined) {
      assertCatalogRefillRootBinding(receipt.catalog_refill.root_binding, cacheRoot);
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
