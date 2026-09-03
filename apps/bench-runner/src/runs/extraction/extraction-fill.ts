import process from "node:process";
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
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
import { hasCompleteExtractionFillAuthority } from "./fill/fill-authority.js";
import { digestSemanticOverlay } from "./cache/semantic-artifact/store.js";
import { inspectHistoricalKeyRawClosure } from
  "./fill/manifest/substrate-key-raw-closure.js";
import { assertSafeBudget } from "./fill/semantic-fill-envelope.js";
import {
  prepareExpansionFillAuthority,
  type PreparedExpansionFillAuthority
} from "./expansion-fill-authority.js";
import type { LongMemEvalVariant } from "../../datasets/longmemeval/ingestion/dataset.js";
import type { LongMemEvalExpansionCapability } from
  "../../datasets/longmemeval/promotion/expansion/expansion-capability.js";
import type { R3SpendApproval } from "../../datasets/longmemeval/promotion/r3-spend-approval.js";
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
  newFillStats, readFillRetryTelemetry, type FillRetryTelemetry
} from "./fill/fill-stats.js";
import { createExtractionExecutionAuthority } from "./fill/execution-authority.js";
import {
  hasSettledCatalogRefillLedger,
  reconcileSettledCatalogRefillCompletion,
  recordCatalogRefillResumeManifest
} from "./fill/catalog-refill/runtime.js";
import { finishPreparedExtractionFill } from "./fill/execution/finalization.js";
import { triggerCatalogRefillResumeTestSigkillAfter } from
  "./fill/catalog-refill/resume-failpoint.js";
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
  /** Any caller-supplied list is rejected; catalog refill keys live in the receipt. */
  readonly cacheKeyAllowlist?: readonly string[];
  readonly tolerateProviderTaskFailures?: boolean;
  readonly expansionCapability?: LongMemEvalExpansionCapability;
  readonly r3SpendApproval?: R3SpendApproval;
  readonly ingestionMode?: "precomputed_full" | "lazy_field";
  readonly semanticArtifactRoot?: string;
  readonly semanticTransport?: import("./fill/semantic-fill-executor.js").SemanticFillTransport;
  readonly semanticTransportPolicy?: import("./fill/semantic-fill-envelope.js").SemanticTransportPolicy;
  readonly semanticMaxCalls?: number;
  readonly semanticMaxFailures?: number;
}
export interface ExtractionFillResult extends FillRetryTelemetry {
  readonly requestedTurns: number;
  readonly cacheHits: number;
  readonly newlyExtracted: number;
  readonly coverage: number;
  readonly manifest: ExtractionCacheManifest;
  readonly authorityTelemetry?: import("./authority/attempt-ledger.js").ExtractionAttemptLedgerSnapshot;
  readonly semanticOverlayIdentity?: string;
  readonly semanticNewlyExtracted?: number;
  readonly semanticCacheHits?: number;
  readonly semanticUnavailable?: number;
  readonly lazySemanticRunReceipt?: import("./fill/semantic-fill-receipt.js").LazySemanticRunReceipt;
  readonly lazySemanticRunReceiptHandle?: import("./fill/semantic-fill-receipt.js").VerifiedLazySemanticRunReceipt;
}
export async function runExtractionFill(
  options: ExtractionFillOptions
): Promise<ExtractionFillResult> {
  const fill = freezeExtractionFillOptions(options);
  const cacheRoot = resolveEffectiveExtractionCacheRoot(fill.cacheRoot);
  assertLazyFieldIsolation(fill, cacheRoot);
  const authority = fill.authorityReceiptPath === undefined
    ? undefined
    : await loadExtractionAuthority(fill, cacheRoot);
  const concurrency = resolveExtractionFillConcurrency(fill.concurrency);
  assertFillAuthorityOptions(fill, authority, concurrency);
  const initialConcurrency = resolveExtractionFillInitialConcurrency(
    fill.initialConcurrency,
    authority?.receipt.action === "probe" ? 1 : concurrency
  );
  const initialIdentity = readExtractionCacheManifestIdentity(cacheRoot);
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
  const leaseRoot = fill.ingestionMode === "lazy_field"
    ? fill.semanticArtifactRoot
    : cacheRoot;
  if (leaseRoot === undefined) {
    throw new ExtractionCacheInvariantError("lazy_field requires a semantic artifact root");
  }
  const lease = acquireExtractionCacheWriteLease(leaseRoot);
  return withExtractionCacheWriteLease(
    lease,
    () => runLockedExtractionFill(
      fill, cacheRoot, lease, expansion, concurrency, initialConcurrency, authority
    )
  );
}

export function freezeExtractionFillOptions(options: ExtractionFillOptions): ExtractionFillOptions {
  const {
    extractorFactory, log, signal, semanticTransport, semanticTransportPolicy,
    cacheKeyAllowlist, ...cloneable
  } = options;
  return Object.freeze({
    ...structuredClone(cloneable),
    ...(extractorFactory === undefined ? {} : { extractorFactory }),
    ...(log === undefined ? {} : { log }),
    ...(signal === undefined ? {} : { signal }),
    ...(semanticTransport === undefined ? {} : { semanticTransport }),
    ...(semanticTransportPolicy === undefined ? {} : {
      semanticTransportPolicy: Object.freeze({ ...semanticTransportPolicy })
    }),
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
      (options.expansionCapability !== undefined || options.r3SpendApproval !== undefined)) {
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
  authority: ReceiptBoundExtractionAuthority | undefined
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
      tolerateProviderTaskFailures
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
    executionAuthority, tolerateProviderTaskFailures, watchdog
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
    currentManifest?.schema_version === 3 ? currentManifest : undefined
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
}): Promise<ExtractionFillResult> {
  try {
    const semanticReport = await executePreparedExtractionFill({ ...input,
      signal: input.watchdog?.signal ?? input.options.signal,
      markProgress: input.watchdog?.markProgress });
    if (input.options.ingestionMode === "lazy_field") {
      return overlayFillResult(
        input.prepared,
        input.stats,
        input.cacheRoot,
        input.options.semanticArtifactRoot,
        semanticReport
      );
    }
    return finishPreparedExtractionFill(
      input.prepared, input.cacheRoot, input.stats, input.log, input.writeLease,
      input.executionAuthority, input.tolerateProviderTaskFailures
    );
  } catch (cause) {
    if (input.options.ingestionMode !== "lazy_field") {
      refreshFailedExtractionFill(input, cause);
    }
    throw cause;
  } finally {
    input.watchdog?.dispose();
  }
}

function refreshFailedExtractionFill(
  input: Pick<Parameters<typeof executeLockedExtractionFill>[0],
    "prepared" | "cacheRoot" | "writeLease" | "executionAuthority">,
  cause: unknown
): void {
  try {
    const manifestSha256 = refreshIncompleteFill(
      input.prepared, input.cacheRoot, input.writeLease
    );
    triggerCatalogRefillResumeTestSigkillAfter("failure-manifest-published");
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
}): Promise<import("./fill/semantic-fill-executor.js").SemanticFillReport | undefined> {
  const semanticReport = await executeExtractionFill(
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
  return semanticReport;
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

function assertLazyFieldIsolation(options: ExtractionFillOptions, cacheRoot: string): void {
  if (options.semanticArtifactRoot !== undefined && options.ingestionMode !== "lazy_field") {
    throw new ExtractionCacheInvariantError("semantic overlay requires lazy_field");
  }
  if (options.ingestionMode !== "lazy_field") return;
  if (options.semanticArtifactRoot === undefined) {
    throw new ExtractionCacheInvariantError(
      "lazy_field requires a semantic artifact root"
    );
  }
  assertSafeBudget(options.semanticMaxCalls ?? Number.MAX_SAFE_INTEGER, "semanticMaxCalls");
  assertSafeBudget(options.semanticMaxFailures ?? Number.MAX_SAFE_INTEGER, "semanticMaxFailures");
  assertSeparatedRoots(cacheRoot, options.semanticArtifactRoot);
  if (options.authorityReceiptPath !== undefined ||
      options.expansionCapability !== undefined ||
      options.cacheKeyAllowlist !== undefined ||
      options.questionBatchLimit !== undefined) {
    throw new ExtractionCacheInvariantError(
      "lazy_field cannot mix v3 fill authority"
    );
  }
}

function assertSeparatedRoots(cacheRoot: string, semanticRoot: string): void {
  const left = canonicalRootCandidate(cacheRoot);
  const right = canonicalRootCandidate(semanticRoot);
  const leftToRight = relative(left, right);
  const rightToLeft = relative(right, left);
  if (left === right ||
      (!leftToRight.startsWith("..") && !isAbsolute(leftToRight)) ||
      (!rightToLeft.startsWith("..") && !isAbsolute(rightToLeft))) {
    throw new ExtractionCacheInvariantError(
      "semantic artifact root must be disjoint from the historical extraction cache root"
    );
  }
}

function canonicalRootCandidate(path: string): string {
  const absolute = resolve(path);
  if (existsSync(absolute)) return realpathSync(absolute);
  const parent = dirname(absolute);
  if (parent === absolute) return absolute;
  return resolve(canonicalRootCandidate(parent), basename(absolute));
}

function overlayFillResult(
  prepared: Awaited<ReturnType<typeof prepareExtractionFill>>,
  stats: ReturnType<typeof newFillStats>,
  cacheRoot: string,
  semanticArtifactRoot: string | undefined,
  semanticReport: import("./fill/semantic-fill-executor.js").SemanticFillReport | undefined
): ExtractionFillResult {
  if (semanticArtifactRoot === undefined || semanticReport === undefined) {
    throw new ExtractionCacheInvariantError(
      "lazy_field requires existing complete extraction authority"
    );
  }
  const identity = readExtractionCacheManifestIdentity(cacheRoot);
  const historical = inspectHistoricalKeyRawClosure(cacheRoot);
  if (identity === undefined ||
      identity.manifestSha256 !== prepared.pinnedManifestSha256 ||
      !hasCompleteExtractionFillAuthority(identity.manifest) ||
      !historical.complete || historical.coverage !== 1) {
    throw new ExtractionCacheInvariantError(
      "lazy_field lost complete extraction authority"
    );
  }
  return {
    requestedTurns: prepared.requestedTurns,
    cacheHits: stats.cacheHits,
    newlyExtracted: 0,
    coverage: historical.coverage,
    ...readFillRetryTelemetry(stats),
    manifest: identity.manifest,
    semanticOverlayIdentity: digestSemanticOverlay(semanticArtifactRoot),
    semanticNewlyExtracted: semanticReport.admitted,
    semanticCacheHits: semanticReport.lazyRunReceipt.warm,
    semanticUnavailable: semanticReport.lazyRunReceipt.unavailable,
    lazySemanticRunReceipt: semanticReport.lazyRunReceipt,
    lazySemanticRunReceiptHandle: semanticReport.lazyRunReceiptHandle
  };
}
