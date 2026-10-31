import { assertCurrentConversationGeneration, assertNoRetiredExtractionOverlay,
  type RetiredExtractionOverlayOptions } from "./request-artifact.js";
import { AlayaError, type ExtractionSourcePacking } from "@do-soul/alaya-protocol";
import process from "node:process";
import { executeExtractionBatchFill } from "./fill/batch-fill.js";
import {
  resolveEffectiveExtractionCacheRoot,
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
import type { ExtractionFillVariant } from "./fill/fill-window.js";
import type { LongMemEvalExpansionCapability } from
  "../../datasets/longmemeval/promotion/expansion/expansion-capability.js";
import type { ExpansionSpendApproval } from "../../datasets/longmemeval/promotion/expansion-spend-approval.js";
import { createExtractionNoProgressWatchdog } from
  "./authority/no-progress-watchdog.js";
import {
  inspectExtractionFillPreparation,
  pinInspectedExtractionFill,
  prepareExtractionFill,
  restoreInspectedExtractionFill
} from "./fill/fill-preparation.js";
import {
  executeExtractionFill,
  refreshIncompleteFill,
} from "./fill/fill-execution.js";
import {
  newFillStats, type FillRetryTelemetry
} from "./fill/fill-stats.js";
import { createExtractionExecutionAuthority } from "./fill/execution-authority.js";
import {
  hasSettledCatalogRefillLedger,
  reconcileSettledCatalogRefillCompletion,
  recordCatalogRefillResumeManifest,
  type CatalogRefillResumeFailpoint
} from "./fill/catalog-refill/runtime.js";
import { finishPreparedExtractionFill } from "./fill/execution/finalization.js";
import { assertCatalogRefillTransportReadiness } from
  "./fill/catalog-refill/supplemental.js";
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
  assertReceiptBoundExpansionSpend
} from "./authority/runtime/scope.js";
import {
  loadExtractionAuthority, recoverMissingCatalogRefillResumeManifest,
  revalidateExtractionAuthority, type ReceiptBoundExtractionAuthority
} from "./fill/execution/receipt-bound-authority.js";
export { collectDistinctTurnContents } from "./turn-contents.js";
export {
  EXTRACTION_FILL_DEFAULT_CONCURRENCY,
  EXTRACTION_FILL_MAX_CONCURRENCY
} from "./fill/policy/fill-concurrency.js";
export interface ExtractionFillOptions extends RetiredExtractionOverlayOptions {
  readonly sourceInterpretationProfile?: import("@do-soul/alaya-protocol").SourceInterpretationProfile;
  readonly openSemantics?: import("./request-artifact.js").ExtractionOpenSemanticsGeneration;
  readonly sourcePacking?: ExtractionSourcePacking;
  readonly batch?: {
    readonly window?: string;
    readonly requestLimit?: number;
    /** Campaign scheduling may not turn a prior failure into an implicit retry. */
    readonly requireSuccessfulPredecessors?: boolean;
    readonly operation: import("./fill/batch/contract.js").GeminiBatchOperation;
    readonly limits: import("./fill/batch/contract.js").GeminiBatchLimits;
    readonly reconcile?: { readonly localJob: string; readonly remoteJob: string };
  };
  readonly batchHttp?: import("./fill/batch/contract.js").GeminiBatchHttp;
  readonly variant: ExtractionFillVariant;
  readonly nativeSourcePopulation?: Readonly<{ name: string; snapshotPath: string }>;
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
  /** Any caller-supplied list is rejected; catalog refill keys live in the receipt. */
  readonly cacheKeyAllowlist?: readonly string[];
  readonly tolerateProviderTaskFailures?: boolean;
  readonly expansionCapability?: LongMemEvalExpansionCapability;
  readonly expansionSpendApproval?: ExpansionSpendApproval;
}
export interface ExtractionFillResult extends FillRetryTelemetry {
  readonly batchState?: import("./fill/batch/contract.js").GeminiBatchState;
  readonly requestedTurns: number;
  readonly cacheHits: number;
  readonly newlyExtracted: number;
  readonly coverage: number;
  readonly manifest: ExtractionCacheManifest;
  readonly authorityTelemetry?: import("./authority/attempt-ledger.js").ExtractionAttemptLedgerSnapshot;
}

export const CATALOG_REFILL_TEST_FAILPOINT_ENV =
  "ALAYA_TEST_CATALOG_REFILL_SIGKILL_AFTER";

export function assertCatalogRefillTestFailpointUnreachable(
  env: NodeJS.ProcessEnv = process.env
): void {
  if (env[CATALOG_REFILL_TEST_FAILPOINT_ENV] === undefined) {
    return;
  }
  throw new AlayaError(
    "INTERNAL",
    "catalog refill test failpoint is unreachable from the production entry"
  );
}

export async function runExtractionFill(
  options: ExtractionFillOptions
): Promise<ExtractionFillResult> {
  assertCatalogRefillTestFailpointUnreachable();
  return runExtractionFillBody(options, undefined);
}

export async function runExtractionFillWithDurableFailpoint(
  options: ExtractionFillOptions,
  durableFailpoint: CatalogRefillResumeFailpoint | undefined
): Promise<ExtractionFillResult> {
  return runExtractionFillBody(options, durableFailpoint);
}

async function runExtractionFillBody(
  options: ExtractionFillOptions,
  durableFailpoint: CatalogRefillResumeFailpoint | undefined
): Promise<ExtractionFillResult> {
  const fill = freezeExtractionFillOptions(options);
  assertCurrentConversationGeneration(fill, fill.batch?.operation);
  if (fill.sourceInterpretationProfile !== undefined && (fill.batch === undefined ||
      fill.expansionCapability !== undefined || fill.extractorFactory !== undefined)) {
    throw new AlayaError("VALIDATION", "source packet fill requires explicit isolated Batch execution");
  }
  if (fill.openSemantics !== undefined && (
      fill.expansionCapability !== undefined || fill.extractorFactory !== undefined)) {
    throw new AlayaError("VALIDATION", "open semantics fill cannot mix expansion or an injected extractor");
  }
  const cacheRoot = resolveEffectiveExtractionCacheRoot(fill.cacheRoot);
  const entryManifest = readExtractionCacheManifestIdentity(cacheRoot);
  const retainedManifest = entryManifest?.manifest;
  if (retainedManifest !== undefined) assertCurrentConversationGeneration({
    sourcePacking: retainedManifest.schema_version === 4 ? retainedManifest.source_packing : "reference-eight",
    sourceInterpretationProfile: retainedManifest.source_interpretation_profile,
    openSemantics: retainedManifest.source_semantic_generation }, fill.batch?.operation);
  const authority = fill.authorityReceiptPath === undefined
    ? undefined
    : await loadExtractionAuthority(fill, cacheRoot);
  const concurrency = resolveExtractionFillConcurrency(fill.concurrency);
  assertFillAuthorityOptions(fill, authority, concurrency);
  const initialConcurrency = resolveExtractionFillInitialConcurrency(
    fill.initialConcurrency,
    authority?.receipt.action === "probe" ? 1 : concurrency
  );
  const initialIdentity = entryManifest;
  const directSpend = authority?.receipt.direct_spend;
  const boundedRepair = isBoundedExistingCacheRepair(fill, authority?.receipt);
  const expansion = directSpend === undefined && !boundedRepair
    ? await prepareExpansionFillAuthority(fill, cacheRoot)
    : undefined;
  assertProviderTaskFailureIsolationScope({
    requested: fill.tolerateProviderTaskFailures === true,
    questionBatchLimit: fill.questionBatchLimit,
    authority
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
      fill, cacheRoot, lease, expansion, concurrency, initialConcurrency, authority,
      durableFailpoint
    )
  );
}

export function freezeExtractionFillOptions(options: ExtractionFillOptions): ExtractionFillOptions {
  const captured = { ...options };
  assertNoRetiredExtractionOverlay(captured);
  const { extractorFactory, log, signal, batchHttp, cacheKeyAllowlist, ...cloneable } = captured;
  return Object.freeze({
    ...structuredClone(cloneable),
    ...(extractorFactory === undefined ? {} : { extractorFactory }),
    ...(batchHttp === undefined ? {} : { batchHttp }),
    ...(log === undefined ? {} : { log }),
    ...(signal === undefined ? {} : { signal }),
    ...(cacheKeyAllowlist === undefined
      ? {}
      : { cacheKeyAllowlist: Object.freeze([...cacheKeyAllowlist]) })
  });
}

function assertFillAuthorityOptions(
  options: ExtractionFillOptions,
  authority: ReceiptBoundExtractionAuthority | undefined,
  concurrency: number
): void {
  if (options.questionBatchLimit !== undefined && authority?.receipt.action === "probe") {
    throw new ExtractionCacheInvariantError(
      "question batch extraction cannot be combined with a one-key probe"
    );
  }
  if (authority !== undefined && concurrency > authority.receipt.limits.max_concurrency) {
    throw new Error(
      `extraction-fill concurrency ${concurrency} exceeds authority maximum ` +
      `${authority.receipt.limits.max_concurrency}`
    );
  }
  if (authority?.receipt.direct_spend !== undefined &&
      (options.expansionCapability !== undefined || options.expansionSpendApproval !== undefined)) {
    throw new ExtractionCacheInvariantError(
      "direct spend extraction cannot mix expansion evidence"
    );
  }
}

async function runLockedExtractionFill(
  options: ExtractionFillOptions,
  cacheRoot: string,
  writeLease: ExtractionCacheWriteLease,
  expansion: PreparedExpansionFillAuthority | undefined,
  concurrency: number,
  initialConcurrency: number,
  authority: ReceiptBoundExtractionAuthority | undefined,
  durableFailpoint: CatalogRefillResumeFailpoint | undefined
): Promise<ExtractionFillResult> {
  const log = options.log ?? ((message: string) => process.stderr.write(`${message}\n`));
  const executionAuthority = authority === undefined
    ? undefined
    : createExtractionExecutionAuthority(
      authority.receipt, cacheRoot, authority.targetSelection, writeLease
    );
  await recoverMissingCatalogRefillResumeManifest({
    options, cacheRoot, writeLease, authority, executionAuthority
  });
  const recovered = reconcileSettledCatalogRefillCompletion(executionAuthority, cacheRoot);
  if (recovered !== undefined) return recovered;
  const prepared = await prepareLockedExtractionFill({
    options, cacheRoot, concurrency, log, expansion, authority, writeLease, executionAuthority
  });
  if (options.batch !== undefined) {
    return executeExtractionBatchFill({ options, prepared, cacheRoot, writeLease,
      authority: executionAuthority });
  }
  const stats = newFillStats();
  const tolerateProviderTaskFailures = resolveProviderTaskFailureTolerance({
    requested: options.tolerateProviderTaskFailures === true,
    questionBatchLimit: prepared.questionBatchLimit,
    receipt: authority?.receipt,
    expansion: expansion !== undefined
  });
  if (hasSettledCatalogRefillLedger(executionAuthority)) {
    stats.cacheHits = prepared.requestedTurns;
    return finishPreparedExtractionFill(
      prepared, cacheRoot, stats, log, writeLease, executionAuthority,
      tolerateProviderTaskFailures, durableFailpoint
    );
  }
  const watchdog = executionAuthority === undefined
    ? undefined
    : createExtractionNoProgressWatchdog({
      timeoutMs: executionAuthority.receipt.limits.no_progress_timeout_ms,
      ...(options.signal === undefined ? {} : { externalSignal: options.signal })
    });
  return executeLockedExtractionFill({
    options, prepared, cacheRoot, concurrency, initialConcurrency, stats, log, writeLease,
    executionAuthority, tolerateProviderTaskFailures, watchdog, durableFailpoint
  });
}

async function prepareLockedExtractionFill(input: {
  readonly options: ExtractionFillOptions;
  readonly cacheRoot: string;
  readonly concurrency: number;
  readonly log: (message: string) => void;
  readonly expansion: PreparedExpansionFillAuthority | undefined;
  readonly authority: ReceiptBoundExtractionAuthority | undefined;
  readonly writeLease: ExtractionCacheWriteLease;
  readonly executionAuthority: import("./fill/fill-execution.js").ExecutionExtractionAuthority | undefined;
}) {
  const currentManifest = readExtractionCacheManifestIdentity(input.cacheRoot)?.manifest;
  assertCatalogRefillTransportReadiness(
    input.executionAuthority, input.cacheRoot,
    (currentManifest?.schema_version === 3 || currentManifest?.schema_version === 4) ? currentManifest : undefined
  );
  return input.authority === undefined
    ? prepareExtractionFill(input.options, input.cacheRoot, input.concurrency, input.log, input.expansion)
    : prepareReceiptBoundExtractionFill(
      input.options, input.cacheRoot, input.concurrency, input.log, input.expansion,
      input.authority, input.writeLease
    );
}

async function executeLockedExtractionFill(input: {
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
  readonly watchdog: ReturnType<typeof createExtractionNoProgressWatchdog> | undefined;
  readonly durableFailpoint: CatalogRefillResumeFailpoint | undefined;
}): Promise<ExtractionFillResult> {
  try {
    await executePreparedExtractionFill({ ...input,
      signal: input.watchdog?.signal ?? input.options.signal,
      markProgress: input.watchdog?.markProgress });
    return finishPreparedExtractionFill(
      input.prepared, input.cacheRoot, input.stats, input.log, input.writeLease,
      input.executionAuthority, input.tolerateProviderTaskFailures, input.durableFailpoint
    );
  } catch (cause) {
    refreshFailedExtractionFill(input, cause);
    throw cause;
  } finally {
    input.watchdog?.dispose();
  }
}

function refreshFailedExtractionFill(
  input: Pick<Parameters<typeof executeLockedExtractionFill>[0],
    "prepared" | "cacheRoot" | "writeLease" | "executionAuthority" | "durableFailpoint">,
  cause: unknown
): void {
  try {
    const manifestSha256 = refreshIncompleteFill(
      input.prepared, input.cacheRoot, input.writeLease
    );
    input.durableFailpoint?.("failure-manifest-published");
    recordCatalogRefillResumeManifest(
      input.executionAuthority, input.cacheRoot, manifestSha256
    );
  } catch (refreshFailure) {
    throw new AggregateError(
      [cause, refreshFailure],
      "extraction-fill failed and its partial manifest could not be refreshed"
    );
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
