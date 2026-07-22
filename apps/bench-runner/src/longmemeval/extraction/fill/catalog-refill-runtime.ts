import type { ExtractionAttemptLedgerSnapshot } from "../authority/attempt-ledger.js";
import { writeCatalogRefillResumeManifest } from
  "../authority/catalog-refill/resume-manifest.js";
import { ExtractionCacheInvariantError } from "../cache/cache-invariant-error.js";
import type { ExecutionExtractionAuthority } from "./fill-execution.js";
import type { newFillStats } from "./fill-stats.js";

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
