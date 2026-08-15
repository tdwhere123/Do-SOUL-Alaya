import {
  extractionModelFamily,
  readExtractionCacheManifest,
  writeExtractionCacheManifest,
  type ExtractionCacheManifest
} from "../../cache/extraction-cache-manifest.js";
import { computeExtractionKeySetSha256 } from "../../content-closure.js";
import { inspectExtractionCacheRawContentClosure } from "../../fill/fill-completion.js";
import type { ExtractionAttemptLedgerSnapshot } from "../attempt-ledger.js";
import type { ExtractionRequestProfile } from "../../request-profile.js";

interface ExpectedInterruptedFillManifest {
  readonly model: string;
  readonly modelFamily: string;
  readonly requestProfile: ExtractionRequestProfile;
  readonly providerUrl: string;
  readonly systemPromptSha256: string;
  readonly cacheKeyAlgorithm: string;
  readonly datasetVariant: string;
  readonly datasetRevisionSha256: string;
  readonly windowOffset: number;
  readonly windowLimit: number;
  readonly expectedTurns: number;
  readonly expectedKeySetSha256: string;
}

export function recoverInterruptedExtractionFillManifest(input: {
  readonly cacheRoot: string;
  readonly ledger: ExtractionAttemptLedgerSnapshot;
  readonly expected: ExpectedInterruptedFillManifest;
  readonly builtAt?: string;
}): ExtractionCacheManifest {
  assertSettledFullFillLedger(input.ledger, input.expected.expectedTurns);
  const manifest = requireInProgressManifest(input.cacheRoot);
  assertExpectedManifest(manifest, input.expected, input.ledger.successfulShards);
  assertLedgerClosesRawInventory(input.cacheRoot, input.ledger, input.expected);
  const coverage = input.ledger.successfulShards / input.expected.expectedTurns;
  if (manifest.cached_turns === input.ledger.successfulShards && manifest.coverage === coverage) {
    return manifest;
  }
  const recovered = {
    ...manifest,
    cached_turns: input.ledger.successfulShards,
    coverage,
    built_at: input.builtAt ?? new Date().toISOString()
  };
  writeExtractionCacheManifest(input.cacheRoot, recovered);
  return requireInProgressManifest(input.cacheRoot);
}

function assertSettledFullFillLedger(
  ledger: ExtractionAttemptLedgerSnapshot,
  expectedTurns: number
): void {
  if (ledger.startingMissing !== expectedTurns ||
      ledger.successfulShardCeiling !== expectedTurns ||
      ledger.pendingKeys.length > 0 || ledger.unresolvedAttempts.length > 0) {
    throw new Error("interrupted manifest recovery requires a settled empty-start full-fill ledger");
  }
}

function requireInProgressManifest(cacheRoot: string): ExtractionCacheManifest {
  const manifest = readExtractionCacheManifest(cacheRoot);
  if (manifest?.schema_version !== 3 || manifest.fill_status !== "in_progress") {
    throw new Error("interrupted manifest recovery requires a v3 in-progress manifest");
  }
  return manifest;
}

function assertExpectedManifest(
  manifest: ExtractionCacheManifest,
  expected: ExpectedInterruptedFillManifest,
  successfulShards: number
): void {
  if (manifest.extraction_model !== expected.model ||
      extractionModelFamily(manifest) !== expected.modelFamily ||
      manifest.request_profile !== expected.requestProfile ||
      manifest.provider_url !== expected.providerUrl ||
      manifest.system_prompt_sha256 !== expected.systemPromptSha256 ||
      manifest.cache_key_algo !== expected.cacheKeyAlgorithm ||
      manifest.dataset !== expected.datasetVariant.replace(/_/u, "-") ||
      manifest.dataset_revision !== expected.datasetRevisionSha256 ||
      manifest.window_offset !== expected.windowOffset ||
      manifest.window_limit !== expected.windowLimit ||
      manifest.requested_turns !== expected.expectedTurns ||
      manifest.expected_turns !== expected.expectedTurns ||
      manifest.expected_key_set_sha256 !== expected.expectedKeySetSha256 ||
      manifest.cached_turns === undefined || manifest.cached_turns > successfulShards) {
    throw new Error("interrupted manifest recovery identity or scope drifted");
  }
}

function assertLedgerClosesRawInventory(
  cacheRoot: string,
  ledger: ExtractionAttemptLedgerSnapshot,
  expected: ExpectedInterruptedFillManifest
): void {
  const inventory = inspectExtractionCacheRawContentClosure({
    cacheRoot,
    model: expected.model,
    requestProfile: expected.requestProfile
  });
  if (inventory.invalidTurns !== 0 ||
      inventory.shardTurns !== ledger.successfulShards ||
      inventory.validTurns !== ledger.successfulShards ||
      inventory.keySetSha256 !== computeExtractionKeySetSha256(ledger.successfulKeys)) {
    throw new Error("interrupted manifest recovery found non-ledger inventory");
  }
}
