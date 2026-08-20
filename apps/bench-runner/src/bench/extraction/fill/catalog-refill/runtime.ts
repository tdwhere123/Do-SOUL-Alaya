import type { ExtractionAttemptLedgerSnapshot } from "../../authority/attempt-ledger.js";
import {
  removeSettledCatalogRefillResumeManifest,
  writeCatalogRefillResumeManifest
} from
  "../../authority/catalog-refill/resume-manifest.js";
import { writeCatalogRefillCompletionWitness } from
  "../../authority/catalog-refill/completion-witness.js";
import {
  readExtractionCacheManifestIdentity, type ExtractionCacheManifest,
  type ExtractionCacheManifestV3
} from "../../cache/extraction-cache-manifest.js";
import { ExtractionCacheInvariantError } from "../../cache/cache-invariant-error.js";
import type { ExecutionExtractionAuthority } from "../fill-execution.js";
import { isDeepStrictEqual } from "node:util";
import type { SupplementalSourceReceipt } from "../../cache/supplemental-source-receipt.js";
import { prepareCatalogRefillSupplementalReceipt } from "./supplemental.js";
import type { ExtractionFillResult } from "../../extraction-fill.js";
import { newFillStats, readFillRetryTelemetry } from "../fill-stats.js";
import { triggerCatalogRefillResumeTestSigkillAfter } from
  "./resume-failpoint.js";

export function catalogRefillTurnsThisRun(
  authority: ExecutionExtractionAuthority | undefined,
  telemetry: ExtractionAttemptLedgerSnapshot | undefined,
  stats: ReturnType<typeof newFillStats>
): number | undefined {
  const scopeTurns = authority?.receipt.catalog_refill?.shard_count;
  if (scopeTurns === undefined) return undefined;
  const successfulBeforeRun = (telemetry?.successfulShards ?? 0) - stats.llmCalls;
  const turns = scopeTurns - successfulBeforeRun;
  if (!Number.isSafeInteger(turns) || turns < 0) {
    throw new ExtractionCacheInvariantError("catalog refill ledger progress is inconsistent");
  }
  return turns;
}

export function recordCatalogRefillResumeManifest(
  authority: ExecutionExtractionAuthority | undefined,
  cacheRoot: string,
  manifestSha256: string | undefined
): void {
  if (authority?.receipt.catalog_refill === undefined || manifestSha256 === undefined) return;
  const ledger = authority.snapshot();
  if (ledger === undefined) {
    throw new ExtractionCacheInvariantError("catalog refill resume ledger is unavailable");
  }
  writeCatalogRefillResumeManifest({ cacheRoot, receipt: authority.receipt, ledger, manifestSha256 });
}

export function hasSettledCatalogRefillLedger(
  authority: ExecutionExtractionAuthority | undefined
): boolean {
  const scope = authority?.receipt.catalog_refill;
  const ledger = authority?.snapshot();
  if (scope === undefined || ledger === undefined || ledger.pendingKeys.length !== 0 ||
      ledger.unresolvedAttempts.length !== 0) return false;
  const successful = [...ledger.successfulKeys].sort((left, right) => left.localeCompare(right));
  return successful.length === scope.keys.length &&
    successful.every((key, index) => key === scope.keys[index]);
}

export function finalizeCatalogRefillSuccess(
  authority: ExecutionExtractionAuthority | undefined,
  cacheRoot: string,
  manifest: ExtractionCacheManifest,
  supplementalSourceReceipt: SupplementalSourceReceipt | undefined = undefined
): void {
  if (authority?.receipt.catalog_refill === undefined) return;
  const ledger = authority.snapshot();
  const identity = readExtractionCacheManifestIdentity(cacheRoot);
  if (ledger === undefined || identity === undefined ||
      !isDeepStrictEqual(identity.manifest, manifest)) {
    throw new ExtractionCacheInvariantError("catalog refill completion identity is unavailable");
  }
  if (manifest.fill_status !== "complete") {
    triggerCatalogRefillResumeTestSigkillAfter("in-progress-result-manifest-published");
    writeCatalogRefillResumeManifest({
      cacheRoot, receipt: authority.receipt, ledger,
      manifestSha256: identity.manifestSha256
    });
    return;
  }
  finalizeSettledCatalogRefill(
    authority, cacheRoot, identity, ledger, supplementalSourceReceipt
  );
}

export function reconcileSettledCatalogRefillCompletion(
  authority: ExecutionExtractionAuthority | undefined,
  cacheRoot: string
): ExtractionFillResult | undefined {
  if (authority?.receipt.catalog_refill === undefined) return undefined;
  const identity = readExtractionCacheManifestIdentity(cacheRoot);
  if (identity?.manifest.schema_version !== 3 ||
      identity.manifest.fill_status !== "complete") return undefined;
  const ledger = authority.snapshot();
  if (ledger === undefined) {
    throw new ExtractionCacheInvariantError("catalog refill completion ledger is unavailable");
  }
  const supplementalSourceReceipt = prepareCatalogRefillSupplementalReceipt({
    authority, cacheRoot, ledger, manifest: identity.manifest,
    createdAt: identity.manifest.built_at
  });
  finalizeSettledCatalogRefill(
    authority, cacheRoot, identity, ledger, supplementalSourceReceipt
  );
  const counts = requireCompleteManifestCounts(identity.manifest);
  return Object.freeze({
    requestedTurns: counts.requestedTurns,
    cacheHits: counts.cachedTurns,
    newlyExtracted: 0,
    coverage: counts.coverage,
    ...readFillRetryTelemetry(newFillStats()),
    authorityTelemetry: ledger,
    manifest: identity.manifest
  });
}

function requireCompleteManifestCounts(manifest: ExtractionCacheManifestV3): {
  readonly requestedTurns: number;
  readonly cachedTurns: number;
  readonly coverage: number;
} {
  if (!Number.isSafeInteger(manifest.requested_turns) ||
      !Number.isSafeInteger(manifest.cached_turns) ||
      typeof manifest.coverage !== "number" || manifest.coverage !== 1) {
    throw new ExtractionCacheInvariantError("catalog refill complete manifest counts are invalid");
  }
  return {
    requestedTurns: manifest.requested_turns!,
    cachedTurns: manifest.cached_turns!,
    coverage: manifest.coverage
  };
}

function finalizeSettledCatalogRefill(
  authority: ExecutionExtractionAuthority,
  cacheRoot: string,
  identity: NonNullable<ReturnType<typeof readExtractionCacheManifestIdentity>>,
  ledger: ExtractionAttemptLedgerSnapshot,
  supplementalSourceReceipt: SupplementalSourceReceipt | undefined
): void {
  if (identity.manifest.schema_version !== 3) {
    throw new ExtractionCacheInvariantError("catalog refill requires a V3 final manifest");
  }
  writeCatalogRefillCompletionWitness({
    cacheRoot, receipt: authority.receipt, ledger,
    manifest: identity.manifest, manifestSha256: identity.manifestSha256,
    ...(supplementalSourceReceipt === undefined ? {} : { supplementalSourceReceipt })
  });
  removeSettledCatalogRefillResumeManifest({
    cacheRoot, receipt: authority.receipt, ledger
  });
}
