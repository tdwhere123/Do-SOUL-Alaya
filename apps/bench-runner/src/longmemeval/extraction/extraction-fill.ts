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
import type { ExtractionAttemptLedgerSnapshot } from "./authority/attempt-ledger.js";
import {
  assertLoadedSameRootContinuation,
  inspectContinuationLedgerState,
  loadSameRootExtractionContinuation,
  type LoadedSameRootContinuation
} from "./authority/continuation/runtime.js";
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
import { isBoundedExistingCacheRepair } from
  "./authority/repair/bounded-existing-cache-repair.js";
import {
  assertProviderTaskFailureIsolationScope,
  resolveProviderTaskFailureTolerance
} from "./fill/policy/provider-task-failure-isolation.js";
import {
  resolveExtractionFillConcurrency,
  resolveExtractionFillInitialConcurrency
} from "./fill/policy/fill-concurrency.js";
import {
  assertDirectExtractionMetadataScope,
  assertReceiptBoundExpansionSpend
} from "./authority/runtime/scope.js";

export { collectDistinctTurnContents } from "./turn-contents.js";
export {
  EXTRACTION_FILL_DEFAULT_CONCURRENCY,
  EXTRACTION_FILL_MAX_CONCURRENCY
} from "./fill/policy/fill-concurrency.js";
export interface ExtractionFillOptions {
  readonly variant: LongMemEvalVariant;
  readonly limit?: number;
  readonly offset?: number;
  readonly concurrency?: number;
  readonly initialConcurrency?: number;
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
  readonly predecessorAuthorityReceiptPath?: string;
  readonly cacheKeyAllowlist?: readonly string[];
  /** Continue normal target-bound fills after isolated provider task failures. */
  readonly tolerateProviderTaskFailures?: boolean;
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
  const initialConcurrency = resolveExtractionFillInitialConcurrency(
    options.initialConcurrency,
    authority?.receipt.action === "probe" ? 1 : concurrency
  );
  const initialIdentity = readExtractionCacheManifestIdentity(cacheRoot);
  const directSpend = authority?.receipt.direct_spend;
  if (directSpend !== undefined &&
      (options.expansionCapability !== undefined || options.r3SpendApproval !== undefined)) {
    throw new ExtractionCacheInvariantError(
      "direct DeepSeek 500 extraction cannot mix R3 expansion evidence"
    );
  }
  const boundedRepair = isBoundedExistingCacheRepair(options, authority?.receipt);
  const expansion = directSpend === undefined && !boundedRepair
    ? await prepareExpansionFillAuthority(options, cacheRoot)
    : undefined;
  assertProviderTaskFailureIsolationScope({
    requested: options.tolerateProviderTaskFailures === true,
    questionBatchLimit: options.questionBatchLimit,
    authority,
    expansion
  });
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
    () => runLockedExtractionFill(
      options, cacheRoot, lease, expansion, concurrency, initialConcurrency, authority
    )
  );
}

async function runLockedExtractionFill(
  options: ExtractionFillOptions,
  cacheRoot: string,
  writeLease: ExtractionCacheWriteLease,
  expansion: PreparedExpansionFillAuthority | undefined,
  concurrency: number,
  initialConcurrency: number,
  authority: ReceiptBoundExtractionAuthority | undefined
): Promise<ExtractionFillResult> {
  const log = options.log ?? ((message: string) => process.stderr.write(`${message}\n`));
  const prepared = authority === undefined
    ? await prepareExtractionFill(options, cacheRoot, concurrency, log, expansion)
    : await prepareReceiptBoundExtractionFill(
      options, cacheRoot, concurrency, log, expansion, authority, writeLease
    );
  const stats = newFillStats();
  const tolerateProviderTaskFailures = resolveProviderTaskFailureTolerance({
    requested: options.tolerateProviderTaskFailures === true,
    questionBatchLimit: prepared.questionBatchLimit, receipt: authority?.receipt
  });
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
      options, prepared, cacheRoot, concurrency, initialConcurrency, stats, log, writeLease,
      executionAuthority,
      tolerateProviderTaskFailures,
      signal: watchdog?.signal ?? options.signal,
      markProgress: watchdog?.markProgress
    });
    return finishPreparedExtractionFill(
      prepared, cacheRoot, stats, log, writeLease, executionAuthority,
      tolerateProviderTaskFailures, options.cacheKeyAllowlist?.length
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
  readonly initialConcurrency: number;
  readonly stats: ReturnType<typeof newFillStats>;
  readonly log: (message: string) => void;
  readonly writeLease: ExtractionCacheWriteLease;
  readonly executionAuthority: import("./fill/fill-execution.js").ExecutionExtractionAuthority | undefined;
  readonly tolerateProviderTaskFailures: boolean;
  readonly signal: AbortSignal | undefined;
  readonly markProgress: (() => void) | undefined;
}): Promise<void> {
  await executeExtractionFill(
    input.options,
    input.prepared,
    input.cacheRoot,
    input.executionAuthority?.receipt.action === "probe" ? 1 : input.concurrency,
    input.initialConcurrency,
    input.tolerateProviderTaskFailures,
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
  authority: import("./fill/fill-execution.js").ExecutionExtractionAuthority | undefined,
  allowProviderTaskFailures: boolean,
  cacheKeyAllowlistSize: number | undefined
): ExtractionFillResult {
  const telemetry = authority?.snapshot();
  const repairScopeTurns = authority?.receipt.repair_scope?.shard_count;
  if (authority?.receipt.action === "probe") {
    return finishExtractionProbe(prepared, cacheRoot, stats, log, writeLease, telemetry);
  }
  return prepared.questionBatchLimit === undefined
    ? finishExtractionFill(
      prepared, cacheRoot, stats, log, writeLease, telemetry, repairScopeTurns,
      allowProviderTaskFailures, cacheKeyAllowlistSize
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
    await revalidateExtractionAuthority(
      options, cacheRoot, authority, writeLease, prepared.pinnedManifestSha256
    );
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

interface ReceiptBoundExtractionAuthority {
  readonly receipt: ExtractionAuthorityReceipt;
  readonly targetSelection?: ExtractionTargetSelectionReceipt;
  readonly continuation?: LoadedSameRootContinuation;
}

async function loadExtractionAuthority(
  options: ExtractionFillOptions,
  cacheRoot: string
): Promise<ReceiptBoundExtractionAuthority> {
  const receipt = readExtractionAuthorityReceipt(options.authorityReceiptPath!);
  assertDirectExtractionMetadataScope(options, receipt);
  const targetSelection = loadTargetSelection(options, receipt);
  const continuation = loadSameRootExtractionContinuation({
    predecessorAuthorityReceiptPath: options.predecessorAuthorityReceiptPath,
    cacheRoot,
    receipt
  });
  const inspected = await inspectReceiptAuthority(options, cacheRoot, receipt, continuation);
  assertAuthorityInspection(
    receipt, inspected.inspection, cacheRoot, undefined, targetSelection,
    continuation, inspected.successorLedger
  );
  return Object.freeze({
    receipt,
    ...(targetSelection === undefined ? {} : { targetSelection }),
    ...(continuation === undefined ? {} : { continuation })
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

async function revalidateExtractionAuthority(
  options: ExtractionFillOptions,
  cacheRoot: string,
  authority: ReceiptBoundExtractionAuthority,
  writeLease: ExtractionCacheWriteLease,
  postPinManifestSha256: string | undefined = undefined
): Promise<void> {
  writeLease.assertOwned();
  const inspected = await inspectReceiptAuthority(
    options, cacheRoot, authority.receipt, authority.continuation
  );
  assertAuthorityInspection(
    authority.receipt, inspected.inspection, cacheRoot, writeLease, authority.targetSelection,
    authority.continuation, inspected.successorLedger, postPinManifestSha256
  );
}

async function inspectReceiptAuthority(
  options: ExtractionFillOptions,
  cacheRoot: string,
  receipt: ExtractionAuthorityReceipt,
  continuation: LoadedSameRootContinuation | undefined
) {
  const ledgerState = inspectContinuationLedgerState({ cacheRoot, receipt, continuation });
  const inspection = await inspectExtractionAuthority({
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
    ...(ledgerState.newSuccessfulKeys.length === 0 ? {} : {
      excludeContentClosureKeys: ledgerState.newSuccessfulKeys
    }),
    ...(receipt.continuation === undefined || ledgerState.newSuccessfulKeys.length === 0 ? {} : {
      preservedValidExclusionKeys: ledgerState.newSuccessfulKeys
    })
  });
  return { inspection, successorLedger: ledgerState.successorLedger };
}

function assertAuthorityInspection(
  receipt: ExtractionAuthorityReceipt,
  inspection: Awaited<ReturnType<typeof inspectExtractionAuthority>>,
  cacheRoot: string,
  writeLease: ExtractionCacheWriteLease | undefined = undefined,
  targetSelection: ExtractionTargetSelectionReceipt | undefined = undefined,
  continuation: LoadedSameRootContinuation | undefined = undefined,
  successorLedger: ExtractionAttemptLedgerSnapshot | undefined = undefined,
  postPinManifestSha256: string | undefined = undefined
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
  assertLoadedSameRootContinuation({
    cacheRoot, receipt, continuation, successorLedger, targetSelection, inspection,
    ...(postPinManifestSha256 === undefined ? {} : { postPinManifestSha256 })
  });
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
