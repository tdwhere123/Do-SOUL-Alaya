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
import { repairScopeKeys } from "../authority/repair/repair-scope.js";
import {
  assertCatalogRefillRootBinding,
  catalogRefillScopeKeys
} from "../authority/catalog-refill/scope.js";

export function createExtractionExecutionAuthority(
  receipt: ExtractionAuthorityReceipt,
  cacheRoot: string,
  targetSelection: ExtractionTargetSelectionReceipt | undefined = undefined,
  writeLease: ExtractionCacheWriteLease | undefined = undefined
): ExecutionExtractionAuthority {
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
  const repairKeys = receipt.repair_scope === undefined
    ? undefined
    : repairScopeKeys(receipt.repair_scope);
  const catalogRefillKeys = receipt.catalog_refill === undefined
    ? undefined
    : catalogRefillScopeKeys(receipt.catalog_refill);
  const ledger = openReceiptAttemptLedger(receipt, cacheRoot);
  assertCatalogRefillLedgerIsCurrent(receipt, ledger.snapshot());
  return {
    receipt,
    reserveAttempt: async (cacheKey, signal) => {
      assertScopeKeyAllowed(repairKeys, catalogRefillKeys, cacheKey);
      assertTarget();
      assertAuthorityDiskFloor(cacheRoot, receipt.limits.disk_floor_bytes);
      signal?.throwIfAborted();
      assertTarget();
      assertAuthorityDiskFloor(cacheRoot, receipt.limits.disk_floor_bytes);
      ledger.reserveAttempt(cacheKey);
    },
    abandonPendingShard: ledger.abandonPendingShard,
    commitSuccessfulShard: ledger.commitSuccessfulShard,
    commitDeterministicShard: receipt.catalog_refill === undefined
      ? ledger.commitDeterministicShard
      : () => {
          throw new ExtractionCacheInvariantError(
            "catalog refill cannot commit a deterministic shard"
          );
        },
    recordTransportOutcome: ledger.recordTransportOutcome,
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
    successfulShardCeiling: receipt.limits.successful_shard_ceiling
  });
}

function assertScopeKeyAllowed(
  repairKeys: ReadonlySet<string> | undefined,
  catalogRefillKeys: ReadonlySet<string> | undefined,
  cacheKey: string
): void {
  if (repairKeys !== undefined && !repairKeys.has(cacheKey)) {
    throw new ExtractionCacheInvariantError(
      "extraction repair authority refused an out-of-scope shard"
    );
  }
  if (catalogRefillKeys === undefined || catalogRefillKeys.has(cacheKey)) return;
  throw new ExtractionCacheInvariantError(
    "catalog refill authority refused an out-of-scope shard"
  );
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
