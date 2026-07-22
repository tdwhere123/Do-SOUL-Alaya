import {
  ensureForkedExtractionAttemptLedger,
  readSettledExtractionAttemptLedger,
  type ExtractionAttemptLedgerSnapshot
} from "../../longmemeval/extraction/authority/attempt-ledger.js";
import { readExtractionCacheManifestIdentity } from
  "../../longmemeval/extraction/cache/extraction-cache-manifest.js";
import {
  claimExtractionContinuationChild,
  createExtractionContinuationChildClaim
} from "../../longmemeval/extraction/authority/continuation/child-claim.js";
import {
  createSameRootExtractionContinuation
} from "../../longmemeval/extraction/authority/continuation/continuation.js";
import { writeContinuationAuthorityReceiptExclusive } from
  "../../longmemeval/extraction/authority/continuation/writer.js";
import type { ExtractionAuthorityInspection } from
  "../../longmemeval/extraction/authority/inspection.js";
import {
  assertExtractionAuthorityReceipt,
  readExtractionAuthorityReceipt,
  type ExtractionAuthorityReceipt
} from "../../longmemeval/extraction/authority/receipt.js";
import type { ExtractionTargetSelectionReceipt } from
  "../../longmemeval/extraction/authority/target-selection/receipt.js";

export interface PreparedAuthorityContinuation {
  readonly predecessor: ExtractionAuthorityReceipt;
  readonly predecessorLedger: ExtractionAttemptLedgerSnapshot;
  readonly evidence: ReturnType<typeof createSameRootExtractionContinuation>;
}

export interface AuthorityContinuationDependencies {
  readonly readPredecessorAuthority?: typeof readExtractionAuthorityReceipt;
  readonly readSettledLedger?: typeof readSettledExtractionAttemptLedger;
  readonly ensureForkedLedger?: typeof ensureForkedExtractionAttemptLedger;
  readonly claimChild?: typeof claimExtractionContinuationChild;
  readonly readManifest?: typeof readExtractionCacheManifestIdentity;
  readonly writeContinuation?: typeof writeContinuationAuthorityReceiptExclusive;
}

export function prepareAuthorityContinuation(input: {
  readonly predecessorAuthorityPath: string | undefined;
  readonly cacheRoot: string;
  readonly inspection: ExtractionAuthorityInspection;
  readonly targetSelection: ExtractionTargetSelectionReceipt | undefined;
  readonly dependencies?: AuthorityContinuationDependencies;
}): PreparedAuthorityContinuation | undefined {
  if (input.predecessorAuthorityPath === undefined) return undefined;
  if (input.targetSelection === undefined) {
    throw new Error("same-root continuation requires a successor target selection");
  }
  const deps = input.dependencies ?? {};
  const predecessor = (deps.readPredecessorAuthority ?? readExtractionAuthorityReceipt)(
    input.predecessorAuthorityPath
  );
  assertExtractionAuthorityReceipt(predecessor, predecessor.observation);
  const predecessorLedger = (deps.readSettledLedger ?? readSettledExtractionAttemptLedger)({
    cacheRoot: input.cacheRoot,
    lineageDigest: predecessor.lineage_digest,
    cacheIdentity: {
      model: predecessor.observation.extraction.model,
      requestProfile: predecessor.observation.extraction.requestProfile
    }
  });
  const evidence = createSameRootExtractionContinuation({
    cacheRoot: input.cacheRoot,
    predecessor,
    predecessorLedger,
    targetSelection: input.targetSelection,
    inspection: input.inspection
  });
  return Object.freeze({ predecessor, predecessorLedger, evidence });
}

export function persistContinuationAuthority(input: {
  readonly cacheRoot: string;
  readonly outputPath: string;
  readonly receipt: ExtractionAuthorityReceipt;
  readonly prepared: PreparedAuthorityContinuation;
  readonly dependencies?: AuthorityContinuationDependencies;
}): void {
  const deps = input.dependencies ?? {};
  const livePredecessor = (deps.readSettledLedger ?? readSettledExtractionAttemptLedger)({
    cacheRoot: input.cacheRoot,
    lineageDigest: input.prepared.predecessor.lineage_digest,
    cacheIdentity: {
      model: input.receipt.observation.extraction.model,
      requestProfile: input.receipt.observation.extraction.requestProfile
    }
  });
  assertExactPreparedLedger(input.prepared.predecessorLedger, livePredecessor);
  const manifest = (deps.readManifest ?? readExtractionCacheManifestIdentity)(input.cacheRoot);
  if (manifest?.manifestSha256 !== input.prepared.evidence.starting_manifest_sha256) {
    throw new Error("same-root continuation starting manifest drifted before issuance");
  }
  (deps.claimChild ?? claimExtractionContinuationChild)({
    cacheRoot: input.cacheRoot,
    claim: createExtractionContinuationChildClaim({
      predecessorReceiptDigest: input.prepared.predecessor.receipt_digest,
      predecessorLedger: livePredecessor,
      successor: input.receipt
    })
  });
  (deps.ensureForkedLedger ?? ensureForkedExtractionAttemptLedger)({
    cacheRoot: input.cacheRoot,
    predecessorLineageDigest: input.prepared.predecessor.lineage_digest,
    predecessorLedgerSha256: livePredecessor.ledgerSha256,
    predecessorRawLedgerSha256: livePredecessor.rawLedgerSha256,
    successorLineageDigest: input.receipt.lineage_digest,
    cacheIdentity: {
      model: input.receipt.observation.extraction.model,
      requestProfile: input.receipt.observation.extraction.requestProfile
    }
  });
  (deps.writeContinuation ?? writeContinuationAuthorityReceiptExclusive)(
    input.outputPath, input.receipt
  );
}

export function assertExactContinuationIssuanceInspection(
  prepared: ExtractionAuthorityInspection,
  live: ExtractionAuthorityInspection
): void {
  if (JSON.stringify(prepared.observation) !== JSON.stringify(live.observation) ||
      JSON.stringify(prepared.missingKeys) !== JSON.stringify(live.missingKeys) ||
      JSON.stringify(prepared.invalidShards) !== JSON.stringify(live.invalidShards) ||
      JSON.stringify(prepared.preservedValidClosure) !==
        JSON.stringify(live.preservedValidClosure)) {
    throw new Error("same-root continuation cache drifted during authority issuance");
  }
}

function assertExactPreparedLedger(
  prepared: ExtractionAttemptLedgerSnapshot,
  live: ExtractionAttemptLedgerSnapshot
): void {
  if (prepared.rawLedgerSha256 !== live.rawLedgerSha256 ||
      prepared.ledgerSha256 !== live.ledgerSha256 ||
      prepared.attempts !== live.attempts ||
      prepared.successfulShards !== live.successfulShards ||
      prepared.pendingKeys.length !== live.pendingKeys.length ||
      prepared.unresolvedAttempts.length !== live.unresolvedAttempts.length) {
    throw new Error("predecessor extraction ledger drifted during continuation issuance");
  }
}
