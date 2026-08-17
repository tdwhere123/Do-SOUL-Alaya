import {
  mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openExtractionAttemptLedger,
  readExtractionAttemptLedger,
  readSettledExtractionAttemptLedger
} from "../../../../bench/extraction/authority/attempt-ledger.js";
import { persistContinuationAuthority } from
  "../../../../cli/extraction-authority/continuation.js";
import { createSameRootExtractionContinuation } from
  "../../../../bench/extraction/authority/continuation/continuation.js";
import {
  createExtractionAuthorityReceipt,
  type ExtractionAuthorityObservation
} from "../../../../bench/extraction/authority/receipt.js";
import { computeExtractionFillAttemptCeiling } from
  "../../../../bench/extraction/authority/receipt-limits.js";
import { createExtractionPreservedValidClosure } from
  "../../../../bench/extraction/authority/repair/preserved-valid-closure.js";
import {
  createFreshRetiredSourceRebuildTargetSelection,
  createSameRootContinuationTargetSelectionReceipt
} from "../../../../bench/extraction/authority/target-selection/receipt.js";
import {
  EXTRACTION_CACHE_KEY_ALGO,
  EXTRACTION_CACHE_MANIFEST_VERSION,
  readExtractionCacheManifestIdentity,
  writeExtractionCacheManifest
} from "../../../../bench/extraction/cache/extraction-cache-manifest.js";
import {
  computeExtractionKeySetSha256,
  computeExtractionRawJsonSha256
} from "../../../../bench/extraction/content-closure.js";
import { buildExtractionTransportProvenance } from
  "../../../../bench/extraction/transport-route.js";

export const model = "gpt-5.4-mini";
export const requestProfile = "provider-default-v1" as const;
export const firstKey = "1".repeat(64);
export const secondKey = "2".repeat(64);
const rawJson = '{"signals":[]}';
const roots: string[] = [];

export function cleanupContinuationRoots(): void {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
}

export function createContinuationScenario() {
  const predecessor = createPredecessorArtifacts();
  const successor = createSuccessorArtifacts(predecessor);
  const predecessorLedgerPath = join(
    predecessor.cacheRoot,
    `extraction-attempt-ledger.${predecessor.predecessorReceipt.lineage_digest}.json`
  );
  const manifestPath = join(predecessor.cacheRoot, "manifest.json");
  return {
    ...predecessor,
    ...successor,
    predecessorLedgerPath,
    originalLedgerBytes: readFileSync(predecessorLedgerPath),
    manifestPath,
    startingManifestBytes: readFileSync(manifestPath)
  };
}

export function createAuthorityRenewalScenario(
  outputTokenCap = 1_024,
  maximumInputTokens = 300,
  transportProviderUrl?: string
) {
  const predecessor = createPredecessorArtifacts();
  const successorObservation = observation({
    revision: predecessor.predecessorObservation.revision,
    manifestSha256: predecessor.manifestSha256,
    rawContentClosureSha256: predecessor.preservedValidClosure.content_closure_sha256,
    validTurns: 1,
    missingTurns: 1,
    transportProviderUrl
  });
  const successorSelection = predecessor.predecessorSelection;
  const inspection = continuationInspection(
    successorObservation, predecessor.preservedValidClosure
  );
  const continuation = createSameRootExtractionContinuation({
    cacheRoot: predecessor.cacheRoot,
    predecessor: predecessor.predecessorReceipt,
    predecessorLedger: predecessor.predecessorLedger,
    targetSelection: successorSelection,
    inspection
  });
  const successorReceipt = createReceipt({
    observation: successorObservation,
    targetSelectionDigest: successorSelection.receipt_digest,
    continuation,
    outputTokenCap,
    maximumInputTokens
  });
  return {
    ...predecessor,
    successorObservation,
    successorSelection,
    inspection,
    continuation,
    successorReceipt,
    outputPath: join(predecessor.cacheRoot, "..", "renewed-authority.json"),
    prepared: {
      predecessor: predecessor.predecessorReceipt,
      predecessorLedger: predecessor.predecessorLedger,
      evidence: continuation
    }
  };
}

function createPredecessorArtifacts() {
  const cacheRoot = temporaryCacheRoot();
  const predecessorObservation = observation();
  const predecessorSelection = createFreshRetiredSourceRebuildTargetSelection({
    cacheRoot, operator: "local-operator", observation: predecessorObservation
  });
  const predecessorReceipt = createReceipt({
    observation: predecessorObservation,
    targetSelectionDigest: predecessorSelection.receipt_digest
  });
  seedSuccessfulPredecessor(cacheRoot, predecessorReceipt.lineage_digest);
  const predecessorLedger = readSettledExtractionAttemptLedger({
    cacheRoot,
    lineageDigest: predecessorReceipt.lineage_digest,
    cacheIdentity: { model, requestProfile }
  });
  const preservedValidClosure = createExtractionPreservedValidClosure([{
    cacheKey: firstKey,
    model,
    requestProfile,
    rawJsonSha256: computeExtractionRawJsonSha256(rawJson),
    rawSignalCount: 0,
    parsedDraftCount: 0
  }]);
  writeManifest(cacheRoot);
  const manifestSha256 = readExtractionCacheManifestIdentity(cacheRoot)!.manifestSha256;
  return {
    cacheRoot, predecessorObservation, predecessorSelection, predecessorReceipt,
    predecessorLedger, preservedValidClosure, manifestSha256
  };
}

function createSuccessorArtifacts(predecessor: ReturnType<typeof createPredecessorArtifacts>) {
  const successorObservation = observation({
    revision: `git-worktree-v1:${"3".repeat(40)}:${"4".repeat(64)}`,
    manifestSha256: predecessor.manifestSha256,
    rawContentClosureSha256: predecessor.preservedValidClosure.content_closure_sha256,
    validTurns: 1,
    missingTurns: 1
  });
  const successorSelection = createSameRootContinuationTargetSelectionReceipt({
    predecessor: predecessor.predecessorSelection,
    predecessorAuthorityReceiptDigest: predecessor.predecessorReceipt.receipt_digest,
    observation: successorObservation
  });
  const inspection = continuationInspection(
    successorObservation, predecessor.preservedValidClosure
  );
  const continuation = createSameRootExtractionContinuation({
    cacheRoot: predecessor.cacheRoot,
    predecessor: predecessor.predecessorReceipt,
    predecessorLedger: predecessor.predecessorLedger,
    targetSelection: successorSelection,
    inspection
  });
  const successorReceipt = createReceipt({
    observation: successorObservation,
    targetSelectionDigest: successorSelection.receipt_digest,
    continuation
  });
  return {
    successorObservation, successorSelection, inspection, continuation, successorReceipt,
    outputPath: join(predecessor.cacheRoot, "..", "successor-authority.json"),
    prepared: {
      predecessor: predecessor.predecessorReceipt,
      predecessorLedger: predecessor.predecessorLedger,
      evidence: continuation
    }
  };
}

export type ContinuationScenario = ReturnType<typeof createContinuationScenario>;

export function persistScenario(
  scenario: ContinuationScenario,
  dependencies?: Parameters<typeof persistContinuationAuthority>[0]["dependencies"]
): void {
  persistContinuationAuthority({
    cacheRoot: scenario.cacheRoot,
    outputPath: scenario.outputPath,
    receipt: scenario.successorReceipt,
    prepared: scenario.prepared,
    ...(dependencies === undefined ? {} : { dependencies })
  });
}

export function readSuccessorLedger(scenario: ContinuationScenario) {
  return readExtractionAttemptLedger({
    cacheRoot: scenario.cacheRoot,
    lineageDigest: scenario.successorReceipt.lineage_digest,
    cacheIdentity: { model, requestProfile }
  });
}

export function createSiblingReceipt(scenario: ContinuationScenario) {
  const selection = createSameRootContinuationTargetSelectionReceipt({
    predecessor: scenario.predecessorSelection,
    predecessorAuthorityReceiptDigest: scenario.predecessorReceipt.receipt_digest,
    observation: scenario.successorObservation,
    now: new Date("2026-07-22T01:00:00.000Z")
  });
  return createReceipt({
    observation: scenario.successorObservation,
    targetSelectionDigest: selection.receipt_digest,
    continuation: scenario.continuation
  });
}

export function spendLegacySuccessor(scenario: ContinuationScenario): void {
  const ledger = openExtractionAttemptLedger({
    cacheRoot: scenario.cacheRoot,
    lineageDigest: scenario.successorReceipt.lineage_digest,
    cacheIdentity: { model, requestProfile },
    startingMissing: 2,
    maximumAttempts: computeExtractionFillAttemptCeiling(2),
    successfulShardCeiling: 2
  });
  recordFailedAttempt(ledger, secondKey, "8".repeat(64));
}

export function createAndPersistGrandchild(scenario: ContinuationScenario) {
  const childLedger = readSettledExtractionAttemptLedger({
    cacheRoot: scenario.cacheRoot,
    lineageDigest: scenario.successorReceipt.lineage_digest,
    cacheIdentity: { model, requestProfile }
  });
  const observationValue = observation({
    revision: `git-worktree-v1:${"6".repeat(40)}:${"7".repeat(64)}`,
    manifestSha256: scenario.manifestSha256,
    rawContentClosureSha256: scenario.preservedValidClosure.content_closure_sha256,
    validTurns: 1,
    missingTurns: 1
  });
  const selection = createSameRootContinuationTargetSelectionReceipt({
    predecessor: scenario.successorSelection,
    predecessorAuthorityReceiptDigest: scenario.successorReceipt.receipt_digest,
    observation: observationValue
  });
  return persistGrandchild(scenario, childLedger, observationValue, selection);
}

function persistGrandchild(
  scenario: ContinuationScenario,
  predecessorLedger: ReturnType<typeof readSettledExtractionAttemptLedger>,
  observationValue: ExtractionAuthorityObservation,
  selection: ReturnType<typeof createSameRootContinuationTargetSelectionReceipt>
) {
  const inspection = { ...scenario.inspection, observation: observationValue };
  const continuation = createSameRootExtractionContinuation({
    cacheRoot: scenario.cacheRoot,
    predecessor: scenario.successorReceipt,
    predecessorLedger,
    targetSelection: selection,
    inspection,
    predecessorBaseInspection: scenario.inspection
  });
  const receipt = createReceipt({
    observation: observationValue,
    targetSelectionDigest: selection.receipt_digest,
    continuation
  });
  persistContinuationAuthority({
    cacheRoot: scenario.cacheRoot,
    outputPath: join(scenario.cacheRoot, "..", "grandchild-authority.json"),
    receipt,
    prepared: { predecessor: scenario.successorReceipt, predecessorLedger, evidence: continuation }
  });
  return receipt;
}

export function addFailedPredecessorAttempt(scenario: ContinuationScenario): void {
  const ledger = openExtractionAttemptLedger({
    cacheRoot: scenario.cacheRoot,
    lineageDigest: scenario.predecessorReceipt.lineage_digest,
    cacheIdentity: { model, requestProfile },
    startingMissing: 2,
    maximumAttempts: computeExtractionFillAttemptCeiling(2),
    successfulShardCeiling: 2
  });
  recordFailedAttempt(ledger, secondKey, "7".repeat(64));
}

function seedSuccessfulPredecessor(cacheRoot: string, lineageDigest: string): void {
  const ledger = openExtractionAttemptLedger({
    cacheRoot,
    lineageDigest,
    cacheIdentity: { model, requestProfile },
    startingMissing: 2,
    maximumAttempts: computeExtractionFillAttemptCeiling(2),
    successfulShardCeiling: 2
  });
  ledger.reserveAttempt(firstKey);
  ledger.recordTransportOutcome(firstKey, { retryCount: 0, rateLimitRetries: 0 });
  writeShard(cacheRoot, firstKey);
  ledger.commitSuccessfulShard(firstKey);
}

function recordFailedAttempt(
  ledger: ReturnType<typeof openExtractionAttemptLedger>,
  cacheKey: string,
  fingerprint: string
): void {
  ledger.reserveAttempt(cacheKey);
  ledger.recordTransportOutcome(cacheKey, {
    retryCount: 0,
    rateLimitRetries: 0,
    terminalRetryClassification: "failure_non_retryable_4xx",
    transportFailures: [{
      attempt: 1,
      kind: "http_error",
      phase: "response_status",
      httpStatus: 400,
      fingerprint
    }]
  });
  ledger.abandonPendingShard(cacheKey);
}

export function observation(overrides: {
  readonly revision?: string;
  readonly manifestSha256?: string | null;
  readonly rawContentClosureSha256?: string | null;
  readonly validTurns?: number;
  readonly missingTurns?: number;
  readonly transportProviderUrl?: string;
} = {}): ExtractionAuthorityObservation {
  return {
    revision: overrides.revision ?? `git-worktree-v1:${"a".repeat(40)}:${"b".repeat(64)}`,
    commandDigest: "c".repeat(64),
    selectionDigest: "d".repeat(64),
    keyDigest: computeExtractionKeySetSha256([firstKey, secondKey]),
    dataset: {
      variant: "longmemeval_s",
      revisionSha256: "f".repeat(64),
      windowOffset: 0,
      windowLimit: 100,
      windowTurnOccurrences: 2,
      windowUniqueCacheKeys: 2,
      authorizedQuestionCount: 100,
      authorizedTurnOccurrences: 2,
      authorizedUniqueCacheKeys: 2,
      expectedKeySetSha256: computeExtractionKeySetSha256([firstKey, secondKey])
    },
    extraction: {
      model,
      modelFamily: model,
      requestProfile,
      providerUrl: "https://example.test/v1",
      systemPromptSha256: "5".repeat(64),
      cacheKeyAlgorithm: EXTRACTION_CACHE_KEY_ALGO,
      manifestSha256: overrides.manifestSha256 ?? null,
      rawContentClosureSha256: overrides.rawContentClosureSha256 ?? null
    },
    ...(overrides.transportProviderUrl === undefined ? {} : {
      transport: {
        providerUrl: overrides.transportProviderUrl,
        model: "provider-model-alias"
      }
    }),
    inventory: {
      expectedTurns: 2,
      validTurns: overrides.validTurns ?? 0,
      missingTurns: overrides.missingTurns ?? 2,
      invalidTurns: 0,
      orphanTurns: 0
    }
  };
}

function continuationInspection(
  observationValue: ExtractionAuthorityObservation,
  preservedValidClosure: ReturnType<typeof createExtractionPreservedValidClosure>
) {
  return {
    observation: observationValue,
    missingKeys: [secondKey],
    invalidShards: [],
    preservedValidClosure,
    writerLock: "absent" as const,
    disk: { status: "available" as const, freeBytes: 10_000 },
    credentialStatus: "present" as const,
    modelReadiness: "not_probed" as const
  };
}

export function createReceipt(input: {
  readonly observation: ExtractionAuthorityObservation;
  readonly targetSelectionDigest: string;
  readonly continuation?: Parameters<typeof createExtractionAuthorityReceipt>[0]["continuation"];
  readonly outputTokenCap?: number;
  readonly maximumInputTokens?: number;
}) {
  return createExtractionAuthorityReceipt({
    action: "fill",
    observation: input.observation,
    targetSelectionDigest: input.targetSelectionDigest,
    cumulativeLimits: {
      startingMissing: 2,
      maximumAttempts: computeExtractionFillAttemptCeiling(2),
      successfulShardCeiling: 2
    },
    outputTokenCap: { field: "max_tokens", value: input.outputTokenCap ?? 512 },
    priceEstimate: {
      inputUsdPerMillion: 1,
      outputUsdPerMillion: 2,
      maximumInputTokensPerAttempt: input.maximumInputTokens ?? 300
    },
    diskFloorBytes: 0,
    inspection: {
      writerLock: "absent",
      disk: { status: "available", freeBytes: 10_000 },
      credentialStatus: "present",
      modelReadiness: "not_probed"
    },
    ...(input.continuation === undefined ? {} : { continuation: input.continuation })
  });
}

function temporaryCacheRoot(): string {
  const parent = mkdtempSync(join(tmpdir(), "alaya-continuation-"));
  roots.push(parent);
  return join(parent, "cache");
}

function writeManifest(cacheRoot: string): void {
  writeExtractionCacheManifest(cacheRoot, {
    schema_version: EXTRACTION_CACHE_MANIFEST_VERSION,
    extraction_model: model,
    model_family: model,
    request_profile: requestProfile,
    provider_url: "https://example.test/v1",
    system_prompt_sha256: "5".repeat(64),
    cache_key_algo: EXTRACTION_CACHE_KEY_ALGO,
    dataset: "longmemeval-s",
    dataset_revision: "f".repeat(64),
    requested_turns: 2,
    cached_turns: 1,
    coverage: 0.5,
    fill_status: "in_progress",
    window_offset: 0,
    window_limit: 100,
    expected_turns: 2,
    expected_key_set_sha256: computeExtractionKeySetSha256([firstKey, secondKey]),
    storage: "git-tracked",
    built_at: "2026-07-21T00:00:00.000Z",
    builder: "test"
  });
}

function writeShard(cacheRoot: string, cacheKey: string): void {
  const directory = join(cacheRoot, cacheKey.slice(0, 2));
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, `${cacheKey}.json`), JSON.stringify({
    model,
    request_profile: requestProfile,
    cache_key: cacheKey,
    raw_json: rawJson,
    transport_provenance: buildExtractionTransportProvenance({
      providerUrl: "https://example.test/v1", model
    })
  }), "utf8");
}
