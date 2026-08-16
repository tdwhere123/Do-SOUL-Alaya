import {
  extractionModelFamily,
  readExtractionCacheManifest,
  writeExtractionCacheManifest,
  type ExtractionCacheManifest
} from "../../cache/extraction-cache-manifest.js";
import {
  computeExtractionContentClosureSha256,
  computeExtractionKeySetSha256
} from "../../content-closure.js";
import { inspectExtractionCacheInventory } from "../../cache-audit/inventory.js";
import {
  inspectExtractionCacheContentClosureExcluding,
  inspectExtractionCacheRawContentClosure
} from "../../fill/fill-completion.js";
import type { ExtractionRequestProfile } from "../../request-profile.js";
import type { ExtractionPreservedValidClosure } from
  "../repair/preserved-valid-closure.js";
import type { ExtractionAttemptLedgerSnapshot } from "../attempt-ledger.js";
import type { ExtractionAuthorityReceipt } from "../receipt.js";

export interface ExpectedInterruptedFillManifest {
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
  readonly preservedValidClosure?: ExtractionPreservedValidClosure;
  readonly inheritedSuccessfulKeys?: readonly string[];
  readonly authorizedNewKeys?: readonly string[];
  readonly ledgerSuccessfulShardCeiling?: number;
}

export function interruptedFillRecoveryEvidence(
  receipt: ExtractionAuthorityReceipt
): Pick<ExpectedInterruptedFillManifest,
  "preservedValidClosure" | "inheritedSuccessfulKeys" | "authorizedNewKeys" |
  "ledgerSuccessfulShardCeiling"> {
  if (receipt.catalog_refill !== undefined && receipt.continuation !== undefined) {
    throw new Error("interrupted manifest recovery authority has competing continuation scopes");
  }
  if (receipt.catalog_refill !== undefined) {
    return {
      preservedValidClosure: receipt.catalog_refill.preserved_valid_closure,
      inheritedSuccessfulKeys: Object.freeze([]),
      authorizedNewKeys: receipt.catalog_refill.keys,
      ledgerSuccessfulShardCeiling: receipt.limits.successful_shard_ceiling
    };
  }
  if (receipt.continuation !== undefined) {
    const schemaVersion = receipt.continuation.schema_version;
    const inheritedSuccessfulKeys = receipt.continuation.predecessor.successful_keys;
    if ((schemaVersion !== 6 && schemaVersion !== 7) ||
        inheritedSuccessfulKeys === undefined) {
      throw new Error("interrupted continuation recovery requires successful-key ancestry");
    }
    return {
      preservedValidClosure: receipt.continuation.preserved_valid_closure,
      inheritedSuccessfulKeys,
      authorizedNewKeys: undefined,
      ledgerSuccessfulShardCeiling: receipt.limits.successful_shard_ceiling
    };
  }
  if (receipt.observation.inventory.validTurns !== 0) {
    throw new Error("interrupted manifest recovery lacks a preserved cache closure");
  }
  return {
    preservedValidClosure: emptyPreservedClosure(),
    inheritedSuccessfulKeys: Object.freeze([]),
    authorizedNewKeys: undefined,
    ledgerSuccessfulShardCeiling: receipt.limits.successful_shard_ceiling
  };
}

export function recoverInterruptedExtractionFillManifest(input: {
  readonly cacheRoot: string;
  readonly ledger: ExtractionAttemptLedgerSnapshot;
  readonly expected: ExpectedInterruptedFillManifest;
  readonly builtAt?: string;
}): ExtractionCacheManifest {
  const scope = resolveRecoveryScope(input.ledger, input.expected);
  assertSettledLedger(input.ledger, input.expected, scope);
  const manifest = requireInProgressManifest(input.cacheRoot);
  assertExpectedManifest(manifest, input.expected, scope.cachedTurns);
  assertRecoveryInventory(input.cacheRoot, input.ledger, input.expected, scope);
  const coverage = scope.cachedTurns / input.expected.expectedTurns;
  if (manifest.cached_turns === scope.cachedTurns && manifest.coverage === coverage) {
    return manifest;
  }
  const recovered = {
    ...manifest,
    cached_turns: scope.cachedTurns,
    coverage,
    built_at: input.builtAt ?? new Date().toISOString()
  };
  writeExtractionCacheManifest(input.cacheRoot, recovered);
  return requireInProgressManifest(input.cacheRoot);
}

interface RecoveryScope {
  readonly preserved: ExtractionPreservedValidClosure;
  readonly newSuccessfulKeys: readonly string[];
  readonly cachedTurns: number;
}

function resolveRecoveryScope(
  ledger: ExtractionAttemptLedgerSnapshot,
  expected: ExpectedInterruptedFillManifest
): RecoveryScope {
  const preserved = expected.preservedValidClosure ?? emptyPreservedClosure();
  const inherited = [...(expected.inheritedSuccessfulKeys ?? [])].sort();
  if (new Set(inherited).size !== inherited.length ||
      inherited.some((key) => !ledger.successfulKeys.includes(key))) {
    throw new Error("interrupted manifest recovery inherited ledger closure drifted");
  }
  const inheritedSet = new Set(inherited);
  const newSuccessfulKeys = ledger.successfulKeys.filter((key) => !inheritedSet.has(key));
  const authorized = expected.authorizedNewKeys === undefined
    ? undefined
    : new Set(expected.authorizedNewKeys);
  if (authorized !== undefined && newSuccessfulKeys.some((key) => !authorized.has(key))) {
    throw new Error("interrupted manifest recovery found an out-of-scope success");
  }
  return {
    preserved,
    newSuccessfulKeys,
    cachedTurns: preserved.shard_count + newSuccessfulKeys.length
  };
}

function assertSettledLedger(
  ledger: ExtractionAttemptLedgerSnapshot,
  expected: ExpectedInterruptedFillManifest,
  scope: RecoveryScope
): void {
  const authorizedMissing = expected.expectedTurns - scope.preserved.shard_count;
  const ledgerCeiling = expected.ledgerSuccessfulShardCeiling ?? authorizedMissing;
  const canonicalCeiling = authorizedMissing +
    (expected.inheritedSuccessfulKeys?.length ?? 0);
  if (authorizedMissing < 0 || ledgerCeiling !== canonicalCeiling ||
      ledger.startingMissing !== ledgerCeiling ||
      ledger.successfulShardCeiling !== ledgerCeiling ||
      ledger.pendingKeys.length > 0 || ledger.unresolvedAttempts.length > 0) {
    throw new Error("interrupted manifest recovery requires a settled authority-bound ledger");
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
  cachedTurns: number
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
      manifest.cached_turns === undefined || manifest.cached_turns > cachedTurns) {
    throw new Error("interrupted manifest recovery identity or scope drifted");
  }
}

function assertRecoveryInventory(
  cacheRoot: string,
  ledger: ExtractionAttemptLedgerSnapshot,
  expected: ExpectedInterruptedFillManifest,
  scope: RecoveryScope
): void {
  const identity = { model: expected.model, requestProfile: expected.requestProfile };
  const full = inspectExtractionCacheRawContentClosure({ cacheRoot, ...identity });
  const preserved = inspectExtractionCacheContentClosureExcluding({
    cacheRoot, ...identity, excludeCacheKeys: scope.newSuccessfulKeys
  });
  if (full.invalidTurns !== 0 || full.shardTurns !== scope.cachedTurns ||
      preserved.invalidTurns !== 0 ||
      preserved.shardTurns !== scope.preserved.shard_count ||
      preserved.keySetSha256 !== scope.preserved.key_set_sha256 ||
      preserved.contentClosureSha256 !== scope.preserved.content_closure_sha256) {
    throw new Error("interrupted manifest recovery found non-authority inventory");
  }
  assertSuccessfulShards(cacheRoot, ledger, expected, scope.newSuccessfulKeys);
}

function assertSuccessfulShards(
  cacheRoot: string,
  ledger: ExtractionAttemptLedgerSnapshot,
  expected: ExpectedInterruptedFillManifest,
  keys: readonly string[]
): void {
  const expectedHashes = new Map(ledger.successfulEntries.map((entry) => [
    entry.cacheKey, entry.rawJsonSha256
  ]));
  const inventory = inspectExtractionCacheInventory({
    cacheRoot, cacheKeys: keys, model: expected.model,
    requestProfile: expected.requestProfile
  });
  if (inventory.counts.hit !== keys.length || inventory.counts.invalid !== 0 ||
      inventory.counts.missing !== 0 || inventory.shards.some((shard) =>
        shard.status !== "hit" || shard.rawJsonSha256 !== expectedHashes.get(shard.cacheKey))) {
    throw new Error("interrupted manifest recovery ledger shard closure drifted");
  }
}

function emptyPreservedClosure(): ExtractionPreservedValidClosure {
  return Object.freeze({
    shard_count: 0,
    key_set_sha256: computeExtractionKeySetSha256([]),
    content_closure_sha256: computeExtractionContentClosureSha256([])
  });
}
