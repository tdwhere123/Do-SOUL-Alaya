import type { ExtractionFillResult } from "../../extraction-fill.js";
import type { ExecutionExtractionAuthority } from "../fill-execution.js";
import {
  finishExtractionFill,
  finishExtractionProbe,
  finishExtractionQuestionBatch
} from "../fill-execution.js";
import type { PreparedExtractionFill } from "../fill-preparation.js";
import type { ExtractionCacheWriteLease } from "../manifest/fill-root-guard.js";
import { newFillStats } from "../fill-stats.js";
import {
  catalogRefillTurnsThisRun,
  finalizeCatalogRefillSuccess
} from "../catalog-refill/runtime.js";
import {
  prepareCatalogRefillSupplementalReceipt
} from "../catalog-refill/supplemental.js";
import { supplementalSourceManifestBinding } from
  "../../cache/supplemental-source-receipt.js";

export function finishPreparedExtractionFill(
  prepared: PreparedExtractionFill,
  cacheRoot: string,
  stats: ReturnType<typeof newFillStats>,
  log: (message: string) => void,
  writeLease: ExtractionCacheWriteLease,
  authority: ExecutionExtractionAuthority | undefined,
  allowProviderTaskFailures: boolean
): ExtractionFillResult {
  const telemetry = authority?.snapshot();
  const repairScopeTurns = authority?.receipt.repair_scope?.shard_count;
  const catalogRefillTurns = catalogRefillTurnsThisRun(authority, telemetry, stats);
  if (authority?.receipt.action === "probe") {
    return finishExtractionProbe(prepared, cacheRoot, stats, log, writeLease, telemetry);
  }
  const builtAt = new Date().toISOString();
  const scope = authority?.receipt.catalog_refill;
  const successful = [...(telemetry?.successfulKeys ?? [])]
    .sort((left, right) => left.localeCompare(right));
  const settledCatalog = scope !== undefined && telemetry !== undefined &&
    telemetry.pendingKeys.length === 0 && telemetry.unresolvedAttempts.length === 0 &&
    sameStrings(successful, scope.keys);
  const supplemental = settledCatalog && prepared.existingManifest?.schema_version === 3
    ? prepareCatalogRefillSupplementalReceipt({
      authority, cacheRoot, ledger: telemetry,
      manifest: prepared.existingManifest, createdAt: builtAt
    })
    : undefined;
  const result = prepared.questionBatchLimit === undefined
    ? finishExtractionFill(
      prepared, cacheRoot, stats, log, writeLease, telemetry, repairScopeTurns,
      allowProviderTaskFailures, catalogRefillTurns,
      authority?.receipt.catalog_refill === undefined ? undefined : {
        builtAt,
        ...(supplemental === undefined ? {} : {
          supplementalSourceReceipt: supplementalSourceManifestBinding(supplemental)
        })
      }
    )
    : finishExtractionQuestionBatch(
      prepared, cacheRoot, stats, log, writeLease, telemetry, repairScopeTurns
    );
  finalizeCatalogRefillSuccess(authority, cacheRoot, result.manifest, supplemental);
  return result;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
