import {
  readExtractionAttemptLedger,
  readSettledExtractionAttemptLedger,
  type ExtractionAttemptLedgerSnapshot
} from "../attempt-ledger.js";
import type { ExtractionAuthorityInspection } from "../inspection.js";
import {
  assertExtractionAuthorityReceipt,
  readExtractionAuthorityReceipt,
  type ExtractionAuthorityReceipt
} from "../receipt.js";
import type { ExtractionTargetSelectionReceipt } from
  "../target-selection/receipt.js";
import {
  assertContinuationChildClaimBinding,
  assertExtractionAuthorityHasNoContinuationChild
} from "./child-claim.js";
import {
  assertSameRootExtractionContinuationRuntime,
  continuationNewSuccessfulKeys
} from "./continuation.js";

export interface LoadedSameRootContinuation {
  readonly predecessor: ExtractionAuthorityReceipt;
  readonly predecessorLedger: ExtractionAttemptLedgerSnapshot;
}

export function loadSameRootExtractionContinuation(input: {
  readonly predecessorAuthorityReceiptPath: string | undefined;
  readonly cacheRoot: string;
  readonly receipt: ExtractionAuthorityReceipt;
}): LoadedSameRootContinuation | undefined {
  assertExtractionAuthorityHasNoContinuationChild({
    cacheRoot: input.cacheRoot,
    authority: input.receipt
  });
  if (input.receipt.continuation === undefined) {
    if (input.predecessorAuthorityReceiptPath !== undefined) {
      throw new Error("non-continuation authority cannot use a predecessor receipt");
    }
    return undefined;
  }
  if (input.predecessorAuthorityReceiptPath === undefined) {
    throw new Error("same-root continuation requires --extraction-predecessor-authority");
  }
  const predecessor = readExtractionAuthorityReceipt(input.predecessorAuthorityReceiptPath);
  assertExtractionAuthorityReceipt(predecessor, predecessor.observation);
  const predecessorLedger = readSettledExtractionAttemptLedger({
    cacheRoot: input.cacheRoot,
    lineageDigest: predecessor.lineage_digest,
    cacheIdentity: {
      model: predecessor.observation.extraction.model,
      requestProfile: predecessor.observation.extraction.requestProfile
    }
  });
  assertContinuationChildClaimBinding({
    cacheRoot: input.cacheRoot,
    predecessorReceiptDigest: predecessor.receipt_digest,
    predecessorLedger,
    successor: input.receipt
  });
  return Object.freeze({ predecessor, predecessorLedger });
}

export function inspectContinuationLedgerState(input: {
  readonly cacheRoot: string;
  readonly receipt: ExtractionAuthorityReceipt;
  readonly continuation: LoadedSameRootContinuation | undefined;
}): {
  readonly successorLedger: ExtractionAttemptLedgerSnapshot | undefined;
  readonly newSuccessfulKeys: readonly string[];
} {
  const successorLedger = readExtractionAttemptLedger({
    cacheRoot: input.cacheRoot,
    lineageDigest: input.receipt.lineage_digest,
    cacheIdentity: {
      model: input.receipt.observation.extraction.model,
      requestProfile: input.receipt.observation.extraction.requestProfile
    }
  });
  return {
    successorLedger,
    newSuccessfulKeys: input.continuation === undefined
      ? successorLedger?.successfulKeys ?? []
      : continuationNewSuccessfulKeys(
          input.continuation.predecessorLedger, successorLedger
        )
  };
}

export function assertLoadedSameRootContinuation(input: {
  readonly cacheRoot: string;
  readonly receipt: ExtractionAuthorityReceipt;
  readonly continuation: LoadedSameRootContinuation | undefined;
  readonly successorLedger: ExtractionAttemptLedgerSnapshot | undefined;
  readonly targetSelection: ExtractionTargetSelectionReceipt | undefined;
  readonly inspection: ExtractionAuthorityInspection;
  readonly postPinManifestSha256?: string;
}): void {
  assertExtractionAuthorityHasNoContinuationChild({
    cacheRoot: input.cacheRoot,
    authority: input.receipt
  });
  if (input.receipt.continuation === undefined) return;
  if (input.continuation === undefined || input.successorLedger === undefined ||
      input.targetSelection === undefined) {
    throw new Error("same-root continuation runtime evidence is incomplete");
  }
  const identity = input.continuation.predecessor.observation.extraction;
  const livePredecessorLedger = readSettledExtractionAttemptLedger({
    cacheRoot: input.cacheRoot,
    lineageDigest: input.continuation.predecessor.lineage_digest,
    cacheIdentity: { model: identity.model, requestProfile: identity.requestProfile }
  });
  assertContinuationChildClaimBinding({
    cacheRoot: input.cacheRoot,
    predecessorReceiptDigest: input.continuation.predecessor.receipt_digest,
    predecessorLedger: livePredecessorLedger,
    successor: input.receipt
  });
  assertSameRootExtractionContinuationRuntime({
    cacheRoot: input.cacheRoot,
    receipt: input.receipt,
    predecessor: input.continuation.predecessor,
    predecessorLedger: livePredecessorLedger,
    successorLedger: input.successorLedger,
    targetSelection: input.targetSelection,
    inspection: input.inspection,
    ...(input.postPinManifestSha256 === undefined ? {} : {
      postPinManifestSha256: input.postPinManifestSha256
    })
  });
}
