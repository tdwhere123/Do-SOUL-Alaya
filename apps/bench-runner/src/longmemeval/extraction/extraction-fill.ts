import process from "node:process";
import {
  EXTRACTION_CACHE_ROOT,
  type BenchSignalExtractor,
  type CompileSeedExtractionConfig
} from "../compile-seed.js";
import { readExtractionCacheManifestIdentity, type ExtractionCacheManifest } from
  "./cache/extraction-cache-manifest.js";
import {
  acquireExtractionCacheWriteLease,
  withExtractionCacheWriteLease,
  type ExtractionCacheWriteLease
} from "./fill/manifest/fill-root-guard.js";
import { ExtractionCacheInvariantError } from "./cache/cache-invariant-error.js";
import {
  prepareExpansionFillAuthority,
  type PreparedExpansionFillAuthority
} from "./expansion-fill-authority.js";
import type { LongMemEvalVariant } from "../ingestion/dataset.js";
import type { LongMemEvalExpansionCapability } from
  "../promotion/expansion/expansion-capability.js";
import type { R3SpendApproval } from "../promotion/r3-spend-approval.js";
import {
  inspectExtractionAuthority,
  readCurrentExtractionAuthorityRevision
} from "./authority/inspection.js";
import {
  assertExtractionAuthorityReceipt,
  assertExtractionAuthorityRuntimeReadiness,
  readExtractionAuthorityReceipt,
  type ExtractionAuthorityReceipt
} from "./authority/receipt.js";
import { receiptExtractionCacheIdentity } from "./authority/receipt-cache-identity.js";
import { readExtractionAttemptLedger } from "./authority/attempt-ledger.js";
import { createExtractionNoProgressWatchdog } from
  "./authority/no-progress-watchdog.js";
import { assertDirectExtractionSpendRootBinding } from "./authority/direct-deepseek-500.js";
import {
  assertExtractionTargetSelectionReceipt,
  assertExtractionTargetSelectionWindow,
  readExtractionTargetSelectionReceipt,
  requiresExtractionTargetSelection,
  type ExtractionTargetSelectionReceipt
} from "./authority/target-selection/receipt.js";
import {
  inspectExtractionFillPreparation,
  pinInspectedExtractionFill,
  prepareExtractionFill,
  restoreInspectedExtractionFill
} from "./fill/fill-preparation.js";
import {
  executeExtractionFill,
  finishExtractionFill,
  finishExtractionQuestionBatch,
  finishExtractionProbe,
  refreshIncompleteFill,
} from "./fill/fill-execution.js";
import { newFillStats, type FillRetryTelemetry } from "./fill/fill-stats.js";
import { createExtractionExecutionAuthority } from "./fill/execution-authority.js";
import { assertRemainingRepairShards } from
  "./authority/repair/repair-scope.js";
import { assertPreservedValidClosureUnchanged } from
  "./authority/repair/preserved-valid-closure.js";

export { collectDistinctTurnContents } from "./turn-contents.js";

export const EXTRACTION_FILL_DEFAULT_CONCURRENCY = 32;
export const EXTRACTION_FILL_MAX_CONCURRENCY = 32;

export interface ExtractionFillOptions {
  readonly variant: LongMemEvalVariant;
  readonly limit?: number;
  readonly offset?: number;
  readonly concurrency?: number;
  readonly questionBatchLimit?: number;
  readonly cacheRoot?: string;
  readonly dataDir?: string;
  readonly pinnedMetaRoot?: string;
  readonly extractorFactory?: (
    config: CompileSeedExtractionConfig
  ) => BenchSignalExtractor;
  readonly log?: (message: string) => void;
  readonly signal?: AbortSignal;
  readonly authorityReceiptPath?: string;
  readonly targetSelectionReceiptPath?: string;
  readonly expansionCapability?: LongMemEvalExpansionCapability;
  readonly r3SpendApproval?: R3SpendApproval;
}

export interface ExtractionFillResult extends FillRetryTelemetry {
  readonly requestedTurns: number;
  readonly cacheHits: number;
  readonly newlyExtracted: number;
  readonly coverage: number;
  readonly manifest: ExtractionCacheManifest;
  readonly authorityTelemetry?: import("./authority/attempt-ledger.js").ExtractionAttemptLedgerSnapshot;
}

export async function runExtractionFill(
  options: ExtractionFillOptions
): Promise<ExtractionFillResult> {
  const cacheRoot = options.cacheRoot ?? EXTRACTION_CACHE_ROOT;
  const authority = options.authorityReceiptPath === undefined
    ? undefined
    : await loadExtractionAuthority(options, cacheRoot);
  if (options.questionBatchLimit !== undefined && authority?.receipt.action === "probe") {
    throw new ExtractionCacheInvariantError(
      "question batch extraction cannot be combined with a one-key probe"
    );
  }
  const concurrency = resolveExtractionFillConcurrency(options.concurrency);
  if (authority !== undefined && concurrency > authority.receipt.limits.max_concurrency) {
    throw new Error(
      `extraction-fill concurrency ${concurrency} exceeds authority maximum ` +
      `${authority.receipt.limits.max_concurrency}`
    );
  }
  const initialIdentity = readExtractionCacheManifestIdentity(cacheRoot);
  const directSpend = authority?.receipt.direct_spend;
  if (directSpend !== undefined &&
      (options.expansionCapability !== undefined || options.r3SpendApproval !== undefined)) {
    throw new ExtractionCacheInvariantError(
      "direct DeepSeek 500 extraction cannot mix R3 expansion evidence"
    );
  }
  const expansion = directSpend === undefined
    ? await prepareExpansionFillAuthority(options, cacheRoot)
    : undefined;
  if (expansion !== undefined && authority === undefined) {
    throw new ExtractionCacheInvariantError(
      "canonical 500Q extraction-fill requires a receipt-bound extraction authority"
    );
  }
  if (authority !== undefined && expansion !== undefined) {
    assertReceiptBoundExpansionSpend(authority.receipt, expansion);
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
    : createExtractionExecutionAuthority(
      authority.receipt, cacheRoot, authority.targetSelection, writeLease
    );
  const watchdog = executionAuthority === undefined
    ? undefined
    : createExtractionNoProgressWatchdog({
      timeoutMs: executionAuthority.receipt.limits.no_progress_timeout_ms,
      ...(options.signal === undefined ? {} : { externalSignal: options.signal })
    });
  try {
    await executePreparedExtractionFill({
      options, prepared, cacheRoot, concurrency, stats, log, writeLease, executionAuthority,
      signal: watchdog?.signal ?? options.signal,
      markProgress: watchdog?.markProgress
    });
    return finishPreparedExtractionFill(
      prepared, cacheRoot, stats, log, writeLease, executionAuthority
    );
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

async function executePreparedExtractionFill(input: {
  readonly options: ExtractionFillOptions;
  readonly prepared: Awaited<ReturnType<typeof prepareExtractionFill>>;
  readonly cacheRoot: string;
  readonly concurrency: number;
  readonly stats: ReturnType<typeof newFillStats>;
  readonly log: (message: string) => void;
  readonly writeLease: ExtractionCacheWriteLease;
  readonly executionAuthority: import("./fill/fill-execution.js").ExecutionExtractionAuthority | undefined;
  readonly signal: AbortSignal | undefined;
  readonly markProgress: (() => void) | undefined;
}): Promise<void> {
  await executeExtractionFill(
    input.options,
    input.prepared,
    input.cacheRoot,
    input.executionAuthority?.receipt.action === "probe" ? 1 : input.concurrency,
    input.stats,
    input.log,
    input.writeLease,
    input.executionAuthority,
    input.signal,
    input.markProgress
  );
  input.signal?.throwIfAborted();
}

function finishPreparedExtractionFill(
  prepared: Awaited<ReturnType<typeof prepareExtractionFill>>,
  cacheRoot: string,
  stats: ReturnType<typeof newFillStats>,
  log: (message: string) => void,
  writeLease: ExtractionCacheWriteLease,
  authority: import("./fill/fill-execution.js").ExecutionExtractionAuthority | undefined
): ExtractionFillResult {
  const telemetry = authority?.snapshot();
  const repairScopeTurns = authority?.receipt.repair_scope?.shard_count;
  if (authority?.receipt.action === "probe") {
    return finishExtractionProbe(prepared, cacheRoot, stats, log, writeLease, telemetry);
  }
  return prepared.questionBatchLimit === undefined
    ? finishExtractionFill(
      prepared, cacheRoot, stats, log, writeLease, telemetry, repairScopeTurns
    )
    : finishExtractionQuestionBatch(
      prepared, cacheRoot, stats, log, writeLease, telemetry, repairScopeTurns
    );
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
  if (expansion !== undefined) assertReceiptBoundExpansionSpend(authority.receipt, expansion);
  const prepared = pinInspectedExtractionFill(inspected, cacheRoot, concurrency, log);
  try {
    await revalidateExtractionAuthority(options, cacheRoot, authority, writeLease);
    if (expansion !== undefined) assertReceiptBoundExpansionSpend(authority.receipt, expansion);
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
  readonly targetSelection?: ExtractionTargetSelectionReceipt;
}

async function loadExtractionAuthority(
  options: ExtractionFillOptions,
  cacheRoot: string
): Promise<ReceiptBoundExtractionAuthority> {
  const receipt = readExtractionAuthorityReceipt(options.authorityReceiptPath!);
  assertDirectExtractionMetadataScope(options, receipt);
  const targetSelection = loadTargetSelection(options, receipt);
  const inspection = await inspectReceiptAuthority(options, cacheRoot, receipt);
  assertAuthorityInspection(receipt, inspection, cacheRoot, undefined, targetSelection);
  return Object.freeze({
    receipt,
    ...(targetSelection === undefined ? {} : { targetSelection })
  });
}

function loadTargetSelection(
  options: ExtractionFillOptions,
  receipt: ExtractionAuthorityReceipt,
): ExtractionTargetSelectionReceipt | undefined {
  const targetSelectionRequired = receipt.direct_spend === undefined &&
    receipt.repair_scope === undefined && options.extractorFactory === undefined &&
    requiresExtractionTargetSelection(receipt.observation);
  if (receipt.target_selection_digest === undefined) {
    if (options.targetSelectionReceiptPath !== undefined) {
      throw new ExtractionCacheInvariantError(
        "extraction authority receipt does not bind the supplied target selection"
      );
    }
    if (targetSelectionRequired) {
      throw new ExtractionCacheInvariantError(
        "canonical normal LongMemEval-S live extraction authority requires a target selection receipt"
      );
    }
    return undefined;
  }
  if (options.targetSelectionReceiptPath === undefined) {
    throw new ExtractionCacheInvariantError(
      "extraction authority receipt requires --extraction-target-selection"
    );
  }
  const targetSelection = readExtractionTargetSelectionReceipt(options.targetSelectionReceiptPath);
  if (targetSelection.receipt_digest !== receipt.target_selection_digest) {
    throw new ExtractionCacheInvariantError(
      "extraction authority receipt does not match the target selection receipt"
    );
  }
  return targetSelection;
}

function assertDirectExtractionMetadataScope(
  options: ExtractionFillOptions,
  receipt: ExtractionAuthorityReceipt
): void {
  if (receipt.direct_spend !== undefined && options.pinnedMetaRoot !== undefined) {
    throw new ExtractionCacheInvariantError(
      "direct extraction cannot use pinnedMetaRoot (--pinned-meta-root)"
    );
  }
}

async function revalidateExtractionAuthority(
  options: ExtractionFillOptions,
  cacheRoot: string,
  authority: ReceiptBoundExtractionAuthority,
  writeLease: ExtractionCacheWriteLease
): Promise<void> {
  writeLease.assertOwned();
  const inspection = await inspectReceiptAuthority(options, cacheRoot, authority.receipt);
  assertAuthorityInspection(
    authority.receipt, inspection, cacheRoot, writeLease, authority.targetSelection
  );
}

function assertReceiptBoundExpansionSpend(
  receipt: ExtractionAuthorityReceipt,
  expansion: PreparedExpansionFillAuthority
): void {
  const approval = expansion.r3SpendApproval.approval;
  const limits = receipt.limits;
  if (receipt.action !== "fill" ||
      receipt.observation.dataset.variant !== "longmemeval_s" ||
      receipt.observation.dataset.windowOffset !== 0 ||
      receipt.observation.dataset.windowLimit !== 500 ||
      receipt.observation.extraction.manifestSha256 !== approval.r2.final_cache_identity_sha256 ||
      receipt.observation.inventory.missingTurns !== approval.spend.starting_missing ||
      limits.starting_missing !== approval.spend.starting_missing ||
      limits.maximum_attempts !== approval.spend.maximum_attempts ||
      limits.successful_shard_ceiling !== approval.spend.successful_shard_ceiling ||
      limits.disk_floor_bytes < approval.spend.disk_floor_bytes ||
      receipt.price.estimated_upper_usd > approval.spend.estimated_cost_usd) {
    throw new ExtractionCacheInvariantError(
      "500Q extraction authority receipt does not match the approved R3 spend envelope"
    );
  }
}

async function inspectReceiptAuthority(
  options: ExtractionFillOptions,
  cacheRoot: string,
  receipt: ExtractionAuthorityReceipt
) {
  const ledger = readExtractionAttemptLedger({
    cacheRoot,
    lineageDigest: receipt.lineage_digest,
    cacheIdentity: receiptExtractionCacheIdentity(receipt)
  });
  return await inspectExtractionAuthority({
    variant: options.variant,
    ...(options.limit === undefined ? {} : { limit: options.limit }),
    ...(options.offset === undefined ? {} : { offset: options.offset }),
    ...(receipt.repair_scope === undefined || options.questionBatchLimit === undefined ? {} : {
      questionBatchLimit: options.questionBatchLimit
    }),
    cacheRoot,
    ...(options.dataDir === undefined ? {} : { dataDir: options.dataDir }),
    ...(options.pinnedMetaRoot === undefined ? {} : { pinnedMetaRoot: options.pinnedMetaRoot }),
    // The direct NewAPI receipt binds a separately authorized rebuild root.
    revision: receipt.direct_spend?.kind === "deepseek_newapi_direct_500"
      ? receipt.observation.revision
      : readCurrentExtractionAuthorityRevision(),
    action: receipt.action,
    ...(receipt.repair_scope === undefined ? {} : { repairInvalidShards: true }),
    ...(receipt.repair_scope === undefined ? {} : {
      preservedValidExclusionKeys: receipt.repair_scope.shards.map(
        (shard) => shard.cache_key
      )
    }),
    ...(ledger === undefined ? {} : { excludeContentClosureKeys: ledger.successfulKeys })
  });
}

function assertAuthorityInspection(
  receipt: ExtractionAuthorityReceipt,
  inspection: Awaited<ReturnType<typeof inspectExtractionAuthority>>,
  cacheRoot: string,
  writeLease: ExtractionCacheWriteLease | undefined = undefined,
  targetSelection: ExtractionTargetSelectionReceipt | undefined = undefined
): void {
  assertExtractionAuthorityReceipt(receipt, inspection.observation);
  if (receipt.repair_scope !== undefined) {
    assertRemainingRepairShards(receipt.repair_scope, inspection.invalidShards);
    assertPreservedValidClosureUnchanged(
      receipt.repair_scope.preserved_valid_closure,
      inspection.preservedValidClosure
    );
  }
  writeLease?.assertOwned();
  if (receipt.direct_spend !== undefined) {
    assertDirectExtractionSpendRootBinding({
      authorization: receipt.direct_spend,
      cacheRoot,
      ...(writeLease === undefined ? {} : { writeLease })
    });
  }
  if (targetSelection !== undefined) {
    assertExtractionTargetSelectionReceipt({
      receipt: targetSelection,
      cacheRoot,
      observation: inspection.observation,
      ...(writeLease === undefined ? {} : { writeLease })
    });
    assertExtractionTargetSelectionWindow(targetSelection, inspection.observation);
  }
  assertExtractionAuthorityRuntimeReadiness(receipt, {
    writerLock: inspection.writerLock,
    disk: inspection.disk,
    credentialStatus: inspection.credentialStatus,
    modelReadiness: inspection.modelReadiness
  }, { allowOwnedWriterLock: writeLease !== undefined });
  if (receipt.action === "probe" &&
      (receipt.probe_key === undefined || !inspection.missingKeys.includes(receipt.probe_key))) {
    throw new Error("extraction probe authority target is no longer a missing cache key");
  }
}
