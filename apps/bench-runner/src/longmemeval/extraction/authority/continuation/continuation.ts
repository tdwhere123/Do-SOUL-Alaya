import {
  EXTRACTION_CACHE_MANIFEST_VERSION,
  extractionModelFamily,
  readExtractionCacheManifestIdentity
} from "../../cache/extraction-cache-manifest.js";
import { computeExtractionKeySetSha256 } from "../../content-closure.js";
import type {
  ExtractionAttemptLedgerSnapshot
} from "../attempt-ledger.js";
import { assertMonotonicExtractionAttemptLedgerFork } from
  "../attempt-ledger/fork-contract.js";
import {
  assertSameRootExtractionContinuation,
  type SameRootExtractionContinuation
} from "./contract.js";
import type { ExtractionAuthorityInspection } from "../inspection.js";
import type {
  ExtractionAuthorityObservation,
  ExtractionAuthorityReceipt
} from "../receipt.js";
import { assertPreservedValidClosureUnchanged } from
  "../repair/preserved-valid-closure.js";
import type { ExtractionTargetSelectionReceipt } from
  "../target-selection/receipt.js";

export function createSameRootExtractionContinuation(input: {
  readonly cacheRoot: string;
  readonly predecessor: ExtractionAuthorityReceipt;
  readonly predecessorLedger: ExtractionAttemptLedgerSnapshot;
  readonly targetSelection: ExtractionTargetSelectionReceipt;
  readonly inspection: ExtractionAuthorityInspection;
}): SameRootExtractionContinuation {
  assertPredecessorEvidence(input.predecessor, input.predecessorLedger);
  assertIdentityContinuity(input.predecessor.observation, input.inspection.observation);
  assertSelectionAncestry(input.targetSelection, input.predecessor);
  assertInitialPreservedState(input.inspection, input.predecessorLedger);
  assertManifestMatchesInspection(input.cacheRoot, input.inspection);
  const predecessor = input.predecessorLedger;
  const continuation = {
    schema_version: 2 as const,
    kind: "same-root-settled-predecessor" as const,
    successor_revision: input.inspection.observation.revision,
    starting_manifest_sha256: requireDigest(
      input.inspection.observation.extraction.manifestSha256,
      "same-root continuation requires an in-progress manifest"
    ),
    predecessor: {
      receipt_digest: input.predecessor.receipt_digest,
      lineage_digest: input.predecessor.lineage_digest,
      ledger_sha256: predecessor.ledgerSha256,
      ledger_raw_sha256: predecessor.rawLedgerSha256,
      attempts_consumed: predecessor.attempts,
      maximum_attempts: predecessor.maximumAttempts,
      remaining_attempts: predecessor.maximumAttempts - predecessor.attempts,
      successful_shards: predecessor.successfulShards,
      successful_shard_ceiling: predecessor.successfulShardCeiling,
      remaining_successful_shards:
        predecessor.successfulShardCeiling - predecessor.successfulShards
    },
    preserved_valid_closure: Object.freeze({ ...input.inspection.preservedValidClosure })
  };
  assertSameRootExtractionContinuation(continuation);
  if (continuation.predecessor.remaining_attempts < 1 ||
      continuation.predecessor.remaining_successful_shards !==
        input.inspection.observation.inventory.missingTurns) {
    throw new Error("predecessor extraction authority has no exact continuation budget");
  }
  return Object.freeze(continuation);
}

export function assertSameRootExtractionContinuationRuntime(input: {
  readonly cacheRoot: string;
  readonly receipt: ExtractionAuthorityReceipt;
  readonly predecessor: ExtractionAuthorityReceipt;
  readonly predecessorLedger: ExtractionAttemptLedgerSnapshot;
  readonly successorLedger: ExtractionAttemptLedgerSnapshot;
  readonly targetSelection: ExtractionTargetSelectionReceipt;
  readonly inspection: ExtractionAuthorityInspection;
  readonly postPinManifestSha256?: string;
}): void {
  const continuation = input.receipt.continuation;
  assertSameRootExtractionContinuation(continuation);
  assertContinuationBinding(continuation, input.receipt, input.predecessor);
  assertPredecessorEvidence(input.predecessor, input.predecessorLedger);
  assertBoundPredecessorLedger(continuation, input.predecessorLedger);
  assertIdentityContinuity(input.predecessor.observation, input.receipt.observation);
  assertSelectionAncestry(input.targetSelection, input.predecessor);
  assertMonotonicExtractionAttemptLedgerFork({
    predecessor: input.predecessorLedger,
    successor: input.successorLedger,
    successorLineageDigest: input.receipt.lineage_digest
  });
  assertCurrentInventory(input.inspection, input.successorLedger);
  assertPreservedValidClosureUnchanged(
    continuation.preserved_valid_closure,
    input.inspection.preservedValidClosure
  );
  const expectedManifestSha256 = input.postPinManifestSha256 ??
    (input.successorLedger.attempts === input.predecessorLedger.attempts
      ? continuation.starting_manifest_sha256
      : undefined);
  assertManifestMatchesInspection(
    input.cacheRoot, input.inspection, expectedManifestSha256
  );
}

export function continuationNewSuccessfulKeys(
  predecessor: ExtractionAttemptLedgerSnapshot,
  successor: ExtractionAttemptLedgerSnapshot | undefined
): readonly string[] {
  if (successor === undefined) return [];
  const inherited = new Set(predecessor.successfulKeys);
  return successor.successfulKeys.filter((key) => !inherited.has(key));
}

function assertContinuationBinding(
  continuation: SameRootExtractionContinuation,
  receipt: ExtractionAuthorityReceipt,
  predecessor: ExtractionAuthorityReceipt
): void {
  const bound = continuation.predecessor;
  if (continuation.successor_revision !== receipt.observation.revision ||
      continuation.starting_manifest_sha256 !==
        receipt.observation.extraction.manifestSha256 ||
      bound.receipt_digest !== predecessor.receipt_digest ||
      bound.lineage_digest !== predecessor.lineage_digest) {
    throw new Error("same-root extraction continuation ancestry drifted");
  }
}

function assertPredecessorEvidence(
  predecessor: ExtractionAuthorityReceipt,
  ledger: ExtractionAttemptLedgerSnapshot
): void {
  if (predecessor.action !== "fill" || predecessor.direct_spend !== undefined ||
      predecessor.repair_scope !== undefined || predecessor.target_selection_digest === undefined ||
      ledger.lineageDigest !== predecessor.lineage_digest ||
      ledger.startingMissing !== predecessor.limits.starting_missing ||
      ledger.maximumAttempts !== predecessor.limits.maximum_attempts ||
      ledger.successfulShardCeiling !== predecessor.limits.successful_shard_ceiling ||
      ledger.attempts > ledger.maximumAttempts ||
      ledger.successfulShards > ledger.successfulShardCeiling ||
      ledger.pendingKeys.length !== 0 || ledger.unresolvedAttempts.length !== 0) {
    throw new Error("predecessor extraction authority ledger is not settled and bound");
  }
}

function assertBoundPredecessorLedger(
  continuation: SameRootExtractionContinuation,
  ledger: ExtractionAttemptLedgerSnapshot
): void {
  const bound = continuation.predecessor;
  if (bound.ledger_sha256 !== ledger.ledgerSha256 ||
      (bound.ledger_raw_sha256 !== undefined &&
        bound.ledger_raw_sha256 !== ledger.rawLedgerSha256) ||
      bound.attempts_consumed !== ledger.attempts ||
      bound.successful_shards !== ledger.successfulShards ||
      bound.maximum_attempts !== ledger.maximumAttempts ||
      bound.successful_shard_ceiling !== ledger.successfulShardCeiling) {
    throw new Error("same-root continuation predecessor ledger binding drifted");
  }
}

function assertIdentityContinuity(
  predecessor: ExtractionAuthorityObservation,
  successor: ExtractionAuthorityObservation
): void {
  const predecessorExtraction = semanticExtractionIdentity(predecessor);
  const successorExtraction = semanticExtractionIdentity(successor);
  if (predecessor.revision === successor.revision ||
      predecessor.commandDigest !== successor.commandDigest ||
      predecessor.selectionDigest !== successor.selectionDigest ||
      predecessor.keyDigest !== successor.keyDigest ||
      JSON.stringify(predecessor.dataset) !== JSON.stringify(successor.dataset) ||
      JSON.stringify(predecessorExtraction) !== JSON.stringify(successorExtraction)) {
    throw new Error("same-root extraction continuation semantic identity drifted");
  }
}

function semanticExtractionIdentity(observation: ExtractionAuthorityObservation) {
  const extraction = observation.extraction;
  return {
    model: extraction.model,
    modelFamily: extraction.modelFamily,
    requestProfile: extraction.requestProfile,
    providerUrl: extraction.providerUrl,
    systemPromptSha256: extraction.systemPromptSha256,
    cacheKeyAlgorithm: extraction.cacheKeyAlgorithm
  };
}

function assertSelectionAncestry(
  targetSelection: ExtractionTargetSelectionReceipt,
  predecessor: ExtractionAuthorityReceipt
): void {
  const basis = targetSelection.selection_basis;
  if (basis.kind !== "same_root_continuation" ||
      basis.predecessor_target_selection_digest !== predecessor.target_selection_digest ||
      basis.predecessor_authority_receipt_digest !== predecessor.receipt_digest) {
    throw new Error("same-root continuation target selection ancestry drifted");
  }
}

function assertInitialPreservedState(
  inspection: ExtractionAuthorityInspection,
  predecessor: ExtractionAttemptLedgerSnapshot
): void {
  const inventory = inspection.observation.inventory;
  const closure = inspection.preservedValidClosure;
  if (inventory.invalidTurns !== 0 || inventory.orphanTurns !== 0 ||
      inventory.validTurns !== predecessor.successfulShards ||
      inventory.missingTurns !== inventory.expectedTurns - predecessor.successfulShards ||
      closure.shard_count !== predecessor.successfulShards ||
      closure.key_set_sha256 !== computeExtractionKeySetSha256(predecessor.successfulKeys) ||
      inspection.observation.extraction.rawContentClosureSha256 !==
        closure.content_closure_sha256) {
    throw new Error("current extraction cache is not the exact predecessor successful closure");
  }
}

function assertCurrentInventory(
  inspection: ExtractionAuthorityInspection,
  successor: ExtractionAttemptLedgerSnapshot
): void {
  const inventory = inspection.observation.inventory;
  if (inventory.invalidTurns !== 0 || inventory.orphanTurns !== 0 ||
      inventory.validTurns !== successor.successfulShards ||
      inventory.missingTurns !== successor.startingMissing - successor.successfulShards) {
    throw new Error("same-root continuation inventory escaped its forked ledger");
  }
}

function assertManifestMatchesInspection(
  cacheRoot: string,
  inspection: ExtractionAuthorityInspection,
  expectedManifestSha256: string | undefined = undefined
): void {
  const identity = readExtractionCacheManifestIdentity(cacheRoot);
  const observation = inspection.observation;
  const manifest = identity?.manifest;
  if (identity === undefined || manifest === undefined ||
      manifest.schema_version !== EXTRACTION_CACHE_MANIFEST_VERSION ||
      identity.manifestSha256 !== observation.extraction.manifestSha256 ||
      (expectedManifestSha256 !== undefined &&
        identity.manifestSha256 !== expectedManifestSha256) ||
      manifest.extraction_model !== observation.extraction.model ||
      extractionModelFamily(manifest) !== observation.extraction.modelFamily ||
      manifest.request_profile !== observation.extraction.requestProfile ||
      manifest.provider_url !== observation.extraction.providerUrl ||
      manifest.system_prompt_sha256 !== observation.extraction.systemPromptSha256 ||
      manifest.cache_key_algo !== observation.extraction.cacheKeyAlgorithm ||
      manifest.dataset_revision !== observation.dataset.revisionSha256 ||
      manifest.window_offset !== observation.dataset.windowOffset ||
      manifest.window_limit !== observation.dataset.windowLimit ||
      manifest.expected_turns !== observation.inventory.expectedTurns ||
      manifest.expected_key_set_sha256 !== observation.dataset.expectedKeySetSha256 ||
      manifest.cached_turns !== observation.inventory.validTurns) {
    throw new Error("same-root continuation manifest does not close over current inventory");
  }
}

function requireDigest(value: string | null, message: string): string {
  if (value === null) throw new Error(message);
  return value;
}
