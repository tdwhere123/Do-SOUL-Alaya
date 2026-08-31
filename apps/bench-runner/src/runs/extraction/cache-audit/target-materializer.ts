import type { ExtractionTargetSelectionReceipt } from
  "../authority/target-selection/receipt.js";
import {
  acquireOrderedExtractionCacheWriteLeases,
  type ExtractionCacheWriteLeaseSet
} from "../fill/manifest/fill-root-guard.js";
import type { ExtractionCacheInventory } from "./inventory.js";
import type { ExtractionCacheAuditReceipt } from "./receipt.js";
import { preflightMaterialization } from "./materialization/preflight.js";
import { materializationReceiptFromCommit, type ExtractionCacheMaterializationReceipt } from
  "./materialization/receipt.js";
import { runMaterializationTransaction } from "./materialization/transaction.js";
import { verifyCommittedMaterializationSuccessor } from
  "./materialization/successor-verifier.js";
import type { ExtractionCacheMaterializationCommit } from
  "./materialization/contract.js";

export type { ExtractionCacheMaterializationReceipt } from
  "./materialization/receipt.js";

export function materializeAuditedExtractionCacheTarget(input: {
  readonly sourceRoot: string;
  readonly targetRoot: string;
  readonly auditReceipt: ExtractionCacheAuditReceipt;
  readonly inventory: ExtractionCacheInventory;
  readonly targetSelection: ExtractionTargetSelectionReceipt;
  readonly auditedSourceManifestRaw: string;
  readonly now: () => string;
  readonly maxShardBytes?: number;
  readonly onCommitted?: (receipt: ExtractionCacheMaterializationReceipt) => void;
}): ExtractionCacheMaterializationReceipt {
  let leases: ExtractionCacheWriteLeaseSet;
  try {
    leases = acquireOrderedExtractionCacheWriteLeases([input.sourceRoot, input.targetRoot]);
  } catch (cause) {
    const guidance = cause instanceof Error ? cause.message : String(cause);
    throw new Error(
      `source/target materialization lease acquisition failed: ${guidance}`,
      { cause }
    );
  }
  let failure: unknown;
  try {
    const sourceLease = leases.leaseFor(input.sourceRoot);
    const targetLease = leases.leaseFor(input.targetRoot);
    const preflight = preflightMaterialization({ ...input, sourceLease, targetLease });
    const commit = runMaterializationTransaction({
      ...input, preflight, sourceLease, targetLease
    });
    const receipt = materializationReceiptFromCommit(commit);
    input.onCommitted?.(receipt);
    return receipt;
  } catch (cause) {
    failure = cause;
    throw cause;
  } finally {
    try {
      leases.release();
    } catch (releaseFailure) {
      if (failure !== undefined) {
        throw new AggregateError(
          [failure, releaseFailure],
          "cache materialization failed and ordered leases could not be released"
        );
      }
      throw releaseFailure;
    }
  }
}

export function verifyCommittedAuditedExtractionCacheSuccessor(input: {
  readonly targetRoot: string;
}): ExtractionCacheMaterializationCommit {
  return withVerifiedCommittedAuditedExtractionCacheSuccessor(
    input, ({ commit }) => commit
  );
}

export function withVerifiedCommittedAuditedExtractionCacheSuccessor<T>(
  input: { readonly targetRoot: string },
  operation: (value: Readonly<{
    readonly commit: ExtractionCacheMaterializationCommit;
    readonly receipt: ExtractionCacheMaterializationReceipt;
  }>) => T
): T {
  const leases = acquireLeases([input.targetRoot]);
  let failure: unknown;
  try {
    const commit = verifyCommittedMaterializationSuccessor({
      targetRoot: input.targetRoot,
      targetLease: leases.leaseFor(input.targetRoot)
    });
    return operation(Object.freeze({
      commit, receipt: materializationReceiptFromCommit(commit)
    }));
  } catch (cause) {
    failure = cause;
    throw cause;
  } finally {
    releaseLeases(leases, failure);
  }
}

function acquireLeases(roots: readonly string[]): ExtractionCacheWriteLeaseSet {
  try {
    return acquireOrderedExtractionCacheWriteLeases(roots);
  } catch (cause) {
    const guidance = cause instanceof Error ? cause.message : String(cause);
    throw new Error(
      `source/target materialization lease acquisition failed: ${guidance}`,
      { cause }
    );
  }
}

function releaseLeases(leases: ExtractionCacheWriteLeaseSet, failure: unknown): void {
  try {
    leases.release();
  } catch (releaseFailure) {
    if (failure !== undefined) {
      throw new AggregateError(
        [failure, releaseFailure],
        "cache materialization failed and ordered leases could not be released"
      );
    }
    throw releaseFailure;
  }
}
