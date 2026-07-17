import process from "node:process";
import {
  EXTRACTION_CACHE_ROOT,
  type BenchSignalExtractor,
  type CompileSeedExtractionConfig
} from "./compile-seed.js";
import { readExtractionCacheManifestIdentity, type ExtractionCacheManifest } from
  "./extraction-cache-manifest.js";
import {
  acquireExtractionCacheWriteLease,
  withExtractionCacheWriteLease,
  type ExtractionCacheWriteLease
} from "./extraction/fill-root-guard.js";
import { ExtractionCacheInvariantError } from "./extraction/cache-invariant-error.js";
import {
  prepareExpansionFillAuthority,
  type PreparedExpansionFillAuthority
} from "./extraction/expansion-fill-authority.js";
import type { LongMemEvalVariant } from "./dataset.js";
import type { LongMemEvalExpansionCapability } from
  "./promotion/expansion-capability.js";
import {
  inspectExtractionAuthority,
  inspectExtractionAuthorityDisk,
  readCurrentExtractionAuthorityRevision
} from "./extraction/authority/inspection.js";
import {
  assertExtractionAuthorityReceipt,
  assertExtractionAuthorityRuntimeReadiness,
  readExtractionAuthorityReceipt,
  type ExtractionAuthorityReceipt
} from "./extraction/authority/receipt.js";
import {
  openExtractionAttemptLedger,
  readExtractionAttemptLedger,
  type ExtractionAttemptLedgerSnapshot
} from "./extraction/authority/attempt-ledger.js";
import { createExtractionNoProgressWatchdog } from
  "./extraction/authority/no-progress-watchdog.js";
import {
  inspectExtractionFillPreparation,
  pinInspectedExtractionFill,
  prepareExtractionFill,
  restoreInspectedExtractionFill
} from "./extraction/fill-preparation.js";
import {
  executeExtractionFill,
  finishExtractionFill,
  finishExtractionProbe,
  refreshIncompleteFill,
  type ExecutionExtractionAuthority
} from "./extraction/fill-execution.js";
import { newFillStats, type FillRetryTelemetry } from "./extraction/fill-stats.js";

export { collectDistinctTurnContents } from "./extraction/turn-contents.js";

export const EXTRACTION_FILL_DEFAULT_CONCURRENCY = 32;
export const EXTRACTION_FILL_MAX_CONCURRENCY = 32;

export interface ExtractionFillOptions {
  readonly variant: LongMemEvalVariant;
  readonly limit?: number;
  readonly offset?: number;
  readonly concurrency?: number;
  readonly cacheRoot?: string;
  readonly dataDir?: string;
  readonly pinnedMetaRoot?: string;
  readonly extractorFactory?: (
    config: CompileSeedExtractionConfig
  ) => BenchSignalExtractor;
  readonly log?: (message: string) => void;
  readonly signal?: AbortSignal;
  readonly authorityReceiptPath?: string;
  readonly expansionCapability?: LongMemEvalExpansionCapability;
}

export interface ExtractionFillResult extends FillRetryTelemetry {
  readonly requestedTurns: number;
  readonly cacheHits: number;
  readonly newlyExtracted: number;
  readonly coverage: number;
  readonly manifest: ExtractionCacheManifest;
  readonly authorityTelemetry?: ExtractionAttemptLedgerSnapshot;
}

export async function runExtractionFill(
  options: ExtractionFillOptions
): Promise<ExtractionFillResult> {
  const cacheRoot = options.cacheRoot ?? EXTRACTION_CACHE_ROOT;
  const authority = options.authorityReceiptPath === undefined
    ? undefined
    : await loadExtractionAuthority(options, cacheRoot);
  const concurrency = resolveExtractionFillConcurrency(options.concurrency);
  if (authority !== undefined && concurrency > authority.receipt.limits.max_concurrency) {
    throw new Error(
      `extraction-fill concurrency ${concurrency} exceeds authority maximum ` +
      `${authority.receipt.limits.max_concurrency}`
    );
  }
  const initialIdentity = readExtractionCacheManifestIdentity(cacheRoot);
  const expansion = await prepareExpansionFillAuthority(options, cacheRoot);
  if (authority !== undefined && expansion !== undefined) {
    throw new Error("receipt-bound extraction authority does not permit expansion fills");
  }
  if (initialIdentity?.manifestSha256 !==
      readExtractionCacheManifestIdentity(cacheRoot)?.manifestSha256) {
    throw new ExtractionCacheInvariantError(
      "extraction cache manifest changed during authority preparation"
    );
  }
  const lease = acquireExtractionCacheWriteLease(cacheRoot);
  return withExtractionCacheWriteLease(
    lease,
    () => runLockedExtractionFill(options, cacheRoot, lease, expansion, concurrency, authority)
  );
}

async function runLockedExtractionFill(
  options: ExtractionFillOptions,
  cacheRoot: string,
  writeLease: ExtractionCacheWriteLease,
  expansion: PreparedExpansionFillAuthority | undefined,
  concurrency: number,
  authority: ReceiptBoundExtractionAuthority | undefined
): Promise<ExtractionFillResult> {
  const log = options.log ?? ((message: string) => process.stderr.write(`${message}\n`));
  const prepared = authority === undefined
    ? await prepareExtractionFill(options, cacheRoot, concurrency, log, expansion)
    : await prepareReceiptBoundExtractionFill(
      options, cacheRoot, concurrency, log, expansion, authority, writeLease
    );
  const stats = newFillStats();
  const executionAuthority = authority === undefined
    ? undefined
    : createExecutionAuthority(authority, cacheRoot);
  const watchdog = executionAuthority === undefined
    ? undefined
    : createExtractionNoProgressWatchdog({
      timeoutMs: executionAuthority.receipt.limits.no_progress_timeout_ms,
      ...(options.signal === undefined ? {} : { externalSignal: options.signal })
    });
  try {
    await executeExtractionFill(
      options,
      prepared,
      cacheRoot,
      executionAuthority?.receipt.action === "probe" ? 1 : concurrency,
      stats,
      log,
      writeLease,
      executionAuthority,
      watchdog?.signal ?? options.signal,
      watchdog?.markProgress
    );
    (watchdog?.signal ?? options.signal)?.throwIfAborted();
    const authorityTelemetry = executionAuthority?.snapshot();
    return executionAuthority?.receipt.action === "probe"
      ? finishExtractionProbe(prepared, cacheRoot, stats, log, writeLease, authorityTelemetry)
      : finishExtractionFill(prepared, cacheRoot, stats, log, writeLease, authorityTelemetry);
  } catch (cause) {
    try {
      refreshIncompleteFill(prepared, cacheRoot, writeLease);
    } catch (refreshFailure) {
      throw new AggregateError(
        [cause, refreshFailure],
        "extraction-fill failed and its partial manifest could not be refreshed"
      );
    }
    throw cause;
  } finally {
    watchdog?.dispose();
  }
}

async function prepareReceiptBoundExtractionFill(
  options: ExtractionFillOptions,
  cacheRoot: string,
  concurrency: number,
  log: (message: string) => void,
  expansion: PreparedExpansionFillAuthority | undefined,
  authority: ReceiptBoundExtractionAuthority,
  writeLease: ExtractionCacheWriteLease
) {
  const inspected = await inspectExtractionFillPreparation(options, cacheRoot, expansion);
  await revalidateExtractionAuthority(options, cacheRoot, authority, writeLease);
  const prepared = pinInspectedExtractionFill(inspected, cacheRoot, concurrency, log);
  try {
    await revalidateExtractionAuthority(options, cacheRoot, authority, writeLease);
  } catch (cause) {
    try {
      restoreInspectedExtractionFill(inspected, prepared, cacheRoot);
    } catch (rollbackFailure) {
      throw new AggregateError(
        [cause, rollbackFailure],
        "extraction authority revalidation failed and manifest rollback could not complete"
      );
    }
    throw cause;
  }
  return prepared;
}

function resolveExtractionFillConcurrency(raw: number | undefined): number {
  const value = raw ?? EXTRACTION_FILL_DEFAULT_CONCURRENCY;
  if (!Number.isSafeInteger(value) || value < 1 || value > EXTRACTION_FILL_MAX_CONCURRENCY) {
    throw new Error(
      `extraction-fill concurrency must be an integer from 1 to ${EXTRACTION_FILL_MAX_CONCURRENCY}`
    );
  }
  return value;
}

interface ReceiptBoundExtractionAuthority {
  readonly receipt: ExtractionAuthorityReceipt;
}

async function loadExtractionAuthority(
  options: ExtractionFillOptions,
  cacheRoot: string
): Promise<ReceiptBoundExtractionAuthority> {
  const receipt = readExtractionAuthorityReceipt(options.authorityReceiptPath!);
  const inspection = await inspectReceiptAuthority(options, cacheRoot, receipt);
  assertAuthorityInspection(receipt, inspection);
  return Object.freeze({ receipt });
}

async function revalidateExtractionAuthority(
  options: ExtractionFillOptions,
  cacheRoot: string,
  authority: ReceiptBoundExtractionAuthority,
  writeLease: ExtractionCacheWriteLease
): Promise<void> {
  writeLease.assertOwned();
  const inspection = await inspectReceiptAuthority(options, cacheRoot, authority.receipt);
  assertAuthorityInspection(authority.receipt, inspection, true);
}

async function inspectReceiptAuthority(
  options: ExtractionFillOptions,
  cacheRoot: string,
  receipt: ExtractionAuthorityReceipt
) {
  const ledger = readExtractionAttemptLedger({
    cacheRoot,
    lineageDigest: receipt.lineage_digest,
    cacheIdentity: receiptCacheIdentity(receipt)
  });
  return await inspectExtractionAuthority({
    variant: options.variant,
    ...(options.limit === undefined ? {} : { limit: options.limit }),
    ...(options.offset === undefined ? {} : { offset: options.offset }),
    cacheRoot,
    ...(options.dataDir === undefined ? {} : { dataDir: options.dataDir }),
    ...(options.pinnedMetaRoot === undefined ? {} : { pinnedMetaRoot: options.pinnedMetaRoot }),
    revision: readCurrentExtractionAuthorityRevision(),
    action: receipt.action,
    ...(ledger === undefined ? {} : { excludeContentClosureKeys: ledger.successfulKeys })
  });
}

function assertAuthorityInspection(
  receipt: ExtractionAuthorityReceipt,
  inspection: Awaited<ReturnType<typeof inspectExtractionAuthority>>,
  allowOwnedWriterLock = false
): void {
  assertExtractionAuthorityReceipt(receipt, inspection.observation);
  assertExtractionAuthorityRuntimeReadiness(receipt, {
    writerLock: inspection.writerLock,
    disk: inspection.disk,
    credentialStatus: inspection.credentialStatus,
    modelReadiness: inspection.modelReadiness
  }, { allowOwnedWriterLock });
  if (receipt.action === "probe" &&
      (receipt.probe_key === undefined || !inspection.missingKeys.includes(receipt.probe_key))) {
    throw new Error("extraction probe authority target is no longer a missing cache key");
  }
}

function createExecutionAuthority(
  authority: ReceiptBoundExtractionAuthority,
  cacheRoot: string
): ExecutionExtractionAuthority {
  const { receipt } = authority;
  if (receipt.limits.maximum_attempts === 0) {
    return {
      receipt,
      reserveAttempt: () => {
        throw new ExtractionCacheInvariantError(
          "extraction authority has no remaining provider attempt capacity"
        );
      },
      abandonPendingShard: () => undefined,
      commitSuccessfulShard: () => {
        throw new ExtractionCacheInvariantError(
          "extraction authority has no remaining successful-shard capacity"
        );
      },
      recordTransportOutcome: () => undefined,
      snapshot: () => undefined
    };
  }
  const ledger = openExtractionAttemptLedger({
    cacheRoot,
    lineageDigest: receipt.lineage_digest,
    cacheIdentity: receiptCacheIdentity(receipt),
    startingMissing: receipt.limits.starting_missing,
    maximumAttempts: receipt.limits.maximum_attempts,
    successfulShardCeiling: receipt.limits.successful_shard_ceiling
  });
  return {
    receipt,
    reserveAttempt: (cacheKey) => {
      const disk = inspectExtractionAuthorityDisk(cacheRoot);
      if (disk.status !== "available" || disk.freeBytes < receipt.limits.disk_floor_bytes) {
        throw new ExtractionCacheInvariantError(
          "extraction authority disk floor is unavailable or exhausted"
        );
      }
      ledger.reserveAttempt(cacheKey);
    },
    abandonPendingShard: ledger.abandonPendingShard,
    commitSuccessfulShard: ledger.commitSuccessfulShard,
    recordTransportOutcome: ledger.recordTransportOutcome,
    snapshot: ledger.snapshot
  };
}

function receiptCacheIdentity(receipt: ExtractionAuthorityReceipt): {
  readonly model: string;
  readonly requestProfile: ExtractionAuthorityReceipt["observation"]["extraction"]["requestProfile"];
} {
  return {
    model: receipt.observation.extraction.model,
    requestProfile: receipt.observation.extraction.requestProfile
  };
}
