import process from "node:process";
import { OFFICIAL_API_SYSTEM_PROMPT } from "@do-soul/alaya-soul";
import {
  createCachingSignalExtractor,
  createGardenHttpExtractor,
  type CompileSeedExtractionStats
} from "../../compile-seed.js";
import {
  computeExtractionTurnCacheKey,
  inspectCachedExtraction
} from "../../compile-seed/compile-seed-cache.js";
import type { ExtractionFillOptions, ExtractionFillResult } from "../extraction-fill.js";
import type { ExtractionLiveTransportOutcome } from "../cache/cache-live-delegate.js";
import { ExtractionCacheInvariantError } from "../cache/cache-invariant-error.js";
import type { ExtractionFillCompletion } from "./fill-completion.js";
import {
  finalizeExpansionFillAuthority
} from "../expansion-fill-authority.js";
import type { ExtractionFillStatus } from "./manifest/fill-manifest-contract.js";
import { buildFillManifest } from "./manifest/fill-manifest.js";
import { runExtractionPool } from "./fill-pool.js";
import type { ExtractionCacheWriteLease } from "./manifest/fill-root-guard.js";
import {
  countTerminalProviderFailures,
  readFillRetryTelemetry
} from "./fill-stats.js";
import {
  assertPinnedFillIdentity,
  inspectFillWindow,
  type PreparedExtractionFill
} from "./fill-preparation.js";
import {
  readExtractionCacheManifestIdentity,
  writeExtractionCacheManifest,
  type ExtractionCacheManifest
} from "../cache/extraction-cache-manifest.js";
import type { ExtractionAuthorityReceipt } from "../authority/receipt.js";
import type { ExtractionAttemptLedgerSnapshot } from "../authority/attempt-ledger.js";
import { repairScopeKeys } from "../authority/repair/repair-scope.js";
import { resolveFullFillStatus } from "./policy/full-fill-completion.js";
import {
  countIntentionalSkippedTurns,
  resolveCacheKeyAllowlistedTurns,
  type CacheKeyAllowlistResolution
} from "./policy/cache-key-allowlist.js";

export interface ExecutionExtractionAuthority {
  readonly receipt: ExtractionAuthorityReceipt;
  readonly reserveAttempt: (cacheKey: string, signal?: AbortSignal) => Promise<void>;
  readonly abandonPendingShard: (cacheKey: string) => void;
  readonly commitSuccessfulShard: (cacheKey: string) => void;
  readonly recordTransportOutcome: (
    cacheKey: string,
    outcome: ExtractionLiveTransportOutcome
  ) => void;
  readonly snapshot: () => ExtractionAttemptLedgerSnapshot | undefined;
}

export async function executeExtractionFill(
  options: ExtractionFillOptions,
  prepared: PreparedExtractionFill,
  cacheRoot: string,
  concurrency: number,
  initialConcurrency: number,
  tolerateProviderTaskFailures: boolean,
  stats: CompileSeedExtractionStats,
  log: (message: string) => void,
  writeLease: ExtractionCacheWriteLease,
  authority: ExecutionExtractionAuthority | undefined,
  signal: AbortSignal | undefined,
  markProgress: (() => void) | undefined
): Promise<void> {
  const resolved = resolveFillTurns(
    options.cacheKeyAllowlist, prepared, cacheRoot, authority, writeLease
  );
  stats.cacheHits += resolved.skippedCacheHits;
  const extractor = createFillCachingExtractor(
    options, prepared, cacheRoot, stats, writeLease, authority, markProgress
  );
  await runExtractionPool({
    extractor,
    turns: resolved.turns,
    concurrency,
    initialConcurrency,
    requestedTurns: resolved.turns.length,
    stats,
    log,
    signal,
    ...(authority === undefined ? {} : { transport: {
      retryMode: authority.receipt.action === "probe" ? "disabled" : "default",
      maxOutputTokens: authority.receipt.limits.max_output_tokens,
      outputTokenField: authority.receipt.limits.output_token_field
    } }),
    ...(tolerateProviderTaskFailures ? { tolerateProviderTaskFailures: true } : {})
  });
}

function createFillCachingExtractor(
  options: ExtractionFillOptions,
  prepared: PreparedExtractionFill,
  cacheRoot: string,
  stats: CompileSeedExtractionStats,
  writeLease: ExtractionCacheWriteLease,
  authority: ExecutionExtractionAuthority | undefined,
  markProgress: (() => void) | undefined
) {
  const delegate =
    options.extractorFactory?.(prepared.config) ??
    createGardenHttpExtractor(prepared.config);
  return createCachingSignalExtractor({
    delegate,
    config: prepared.config,
    cacheRoot,
    stats,
    writeLease,
    // The injected extractor is a test seam; the built-in provider never reaches
    // a live request unless a verified authority receipt is present.
    allowLiveExtraction: authority !== undefined || options.extractorFactory !== undefined,
    ...(authority === undefined ? {} : {
      onTransportAttempt: authority.reserveAttempt,
      onLiveExtractionSucceeded: authority.commitSuccessfulShard,
      onLiveExtractionFailed: authority.abandonPendingShard,
      onLiveExtractionOutcome: authority.recordTransportOutcome
    }),
    ...(markProgress === undefined ? {} : { onExtractionProgress: markProgress })
  });
}

function resolveFillTurns(
  cacheKeyAllowlist: readonly string[] | undefined,
  prepared: PreparedExtractionFill,
  cacheRoot: string,
  authority: ExecutionExtractionAuthority | undefined,
  writeLease: ExtractionCacheWriteLease
): CacheKeyAllowlistResolution {
  const allowlisted = resolveCacheKeyAllowlistedTurns({
    allowlist: cacheKeyAllowlist,
    cacheRoot,
    prepared: {
      config: prepared.config,
      pinnedCachedTurns: prepared.existingManifest?.cached_turns,
      distinctExtractionTurns: prepared.distinctExtractionTurns,
      executionExtractionTurns: prepared.executionExtractionTurns,
      questionBatchLimit: prepared.questionBatchLimit,
      expansion: prepared.expansion
    },
    authority: authority?.receipt,
    writeLease
  });
  if (allowlisted !== undefined) return allowlisted;
  const turns = authority?.receipt.action === "probe"
    ? selectProbeTurn(prepared, authority.receipt.probe_key!)
    : selectRepairTurns(prepared, authority);
  if (authority?.receipt.action === "probe") {
    assertProbeTargetIsMissing(prepared, cacheRoot, authority.receipt.probe_key!);
  }
  return { turns, skippedCacheHits: 0 };
}

function selectRepairTurns(
  prepared: PreparedExtractionFill,
  authority: ExecutionExtractionAuthority | undefined
): PreparedExtractionFill["executionExtractionTurns"] {
  const scope = authority?.receipt.repair_scope;
  if (scope === undefined) return prepared.executionExtractionTurns;
  const keys = repairScopeKeys(scope);
  return prepared.executionExtractionTurns.filter((turn) => keys.has(computeExtractionTurnCacheKey(
    prepared.config.model,
    prepared.config.requestProfile,
    OFFICIAL_API_SYSTEM_PROMPT,
    turn
  )));
}

export function finishExtractionFill(
  prepared: PreparedExtractionFill,
  cacheRoot: string,
  stats: CompileSeedExtractionStats,
  log: (message: string) => void,
  writeLease: ExtractionCacheWriteLease,
  authorityTelemetry: ExtractionAttemptLedgerSnapshot | undefined,
  repairScopeTurns: number | undefined,
  allowProviderTaskFailures: boolean,
  cacheKeyAllowlistSize: number | undefined
): ExtractionFillResult {
  assertPinnedFillIdentity(prepared, cacheRoot, writeLease);
  const completion = inspectFillWindow(
    cacheRoot, prepared.config, prepared.distinctExtractionTurns
  );
  const retryTelemetry = readFillRetryTelemetry(stats);
  const intentionalSkippedTurns = countIntentionalSkippedTurns(
    prepared.distinctExtractionTurns.length,
    prepared.existingManifest?.cached_turns,
    cacheKeyAllowlistSize
  );
  const status = resolveFullFillStatus({
    prepared, stats, completion, telemetry: retryTelemetry,
    repairScopeTurns, allowProviderTaskFailures, intentionalSkippedTurns
  });
  assertPinnedFillIdentity(prepared, cacheRoot, writeLease);
  const manifest = persistFillManifest(prepared, cacheRoot, status, completion);
  const cacheHits = stats.cacheHits;
  const newlyExtracted = stats.llmCalls;
  const failureCount = countTerminalProviderFailures(retryTelemetry);
  log(
    `[extraction-fill] done: status=${status} cache_hits=${cacheHits} ` +
      `newly_extracted=${newlyExtracted} failures=${failureCount} ` +
      `intentional_skips=${intentionalSkippedTurns} ` +
      `retry_successes=${retryTelemetry.retrySuccesses} ` +
      `rate_limit_retries=${retryTelemetry.rateLimitRetries} ` +
      `adaptive_backoffs=${retryTelemetry.adaptiveConcurrencyBackoffs} ` +
      `adaptive_backoff_ms=${retryTelemetry.adaptiveConcurrencyBackoffMs} ` +
      `terminal_max_retries=${retryTelemetry.terminalRetryClassifications.failure_max_retries} ` +
      `terminal_nonretryable_4xx=${retryTelemetry.terminalRetryClassifications.failure_non_retryable_4xx} ` +
      `terminal_timeouts=${retryTelemetry.terminalRetryClassifications.failure_timeout} ` +
      `${renderAuthorityTelemetry(authorityTelemetry)} ` +
      `coverage=${(completion.coverage * 100).toFixed(1)}% ` +
      `cached_turns=${completion.validTurns}`
  );
  return {
    requestedTurns: prepared.requestedTurns,
    cacheHits,
    newlyExtracted,
    coverage: completion.coverage,
    ...retryTelemetry,
    ...(authorityTelemetry === undefined ? {} : { authorityTelemetry }),
    manifest
  };
}

export function finishExtractionQuestionBatch(
  prepared: PreparedExtractionFill,
  cacheRoot: string,
  stats: CompileSeedExtractionStats,
  log: (message: string) => void,
  writeLease: ExtractionCacheWriteLease,
  authorityTelemetry: ExtractionAttemptLedgerSnapshot | undefined,
  repairScopeTurns: number | undefined
): ExtractionFillResult {
  assertPinnedFillIdentity(prepared, cacheRoot, writeLease);
  const fullCompletion = inspectFillWindow(
    cacheRoot, prepared.config, prepared.distinctExtractionTurns
  );
  const batchCompletion = inspectFillWindow(
    cacheRoot, prepared.config, prepared.executionExtractionTurns
  );
  assertPinnedFillIdentity(prepared, cacheRoot, writeLease);
  const manifest = persistFillManifest(
    prepared, cacheRoot, "in_progress", fullCompletion
  );
  const retryTelemetry = readFillRetryTelemetry(stats);
  assertQuestionBatchTaskConservation(
    prepared, stats, retryTelemetry, repairScopeTurns
  );
  const failureCount = countTerminalProviderFailures(retryTelemetry);
  log(
    `[extraction-fill] question batch complete: questions=${prepared.questionBatchLimit} ` +
      `cache_hits=${stats.cacheHits} newly_extracted=${stats.llmCalls} ` +
      `failures=${failureCount} ` +
      `batch_status=${batchCompletion.missingTurns === 0 ? "complete" : "incomplete"} ` +
      `batch_coverage=${(batchCompletion.coverage * 100).toFixed(1)}% ` +
      `full_coverage=${(fullCompletion.coverage * 100).toFixed(1)}%`
  );
  return {
    requestedTurns: prepared.executionTurns.length,
    cacheHits: stats.cacheHits,
    newlyExtracted: stats.llmCalls,
    coverage: batchCompletion.coverage,
    ...retryTelemetry,
    ...(authorityTelemetry === undefined ? {} : { authorityTelemetry }),
    manifest
  };
}

function assertQuestionBatchTaskConservation(
  prepared: PreparedExtractionFill,
  stats: CompileSeedExtractionStats,
  telemetry: ReturnType<typeof readFillRetryTelemetry>,
  repairScopeTurns: number | undefined
): void {
  const completed = stats.cacheHits + stats.llmCalls + countTerminalProviderFailures(telemetry);
  const requested = repairScopeTurns ?? prepared.executionExtractionTurns.length;
  if (completed === requested) return;
  throw new ExtractionCacheInvariantError(
    "question batch task conservation failed: " +
      `completed=${completed} requested=${requested}`
  );
}

export function finishExtractionProbe(
  prepared: PreparedExtractionFill,
  cacheRoot: string,
  stats: CompileSeedExtractionStats,
  log: (message: string) => void,
  writeLease: ExtractionCacheWriteLease,
  authorityTelemetry: ExtractionAttemptLedgerSnapshot | undefined
): ExtractionFillResult {
  assertPinnedFillIdentity(prepared, cacheRoot, writeLease);
  const completion = inspectFillWindow(
    cacheRoot, prepared.config, prepared.distinctExtractionTurns
  );
  const manifest = persistFillManifest(prepared, cacheRoot, "in_progress", completion);
  const retryTelemetry = readFillRetryTelemetry(stats);
  if (stats.llmCalls !== 1 || stats.cacheHits !== 0) {
    throw new ExtractionCacheInvariantError(
      "extraction probe did not perform exactly one live target extraction"
    );
  }
  log(
    `[extraction-fill] probe complete: target_calls=${stats.llmCalls} ` +
    `retry_successes=${retryTelemetry.retrySuccesses} ` +
    `rate_limit_retries=${retryTelemetry.rateLimitRetries} ` +
    `adaptive_backoffs=${retryTelemetry.adaptiveConcurrencyBackoffs} ` +
    `adaptive_backoff_ms=${retryTelemetry.adaptiveConcurrencyBackoffMs} ` +
    renderAuthorityTelemetry(authorityTelemetry)
  );
  return {
    requestedTurns: 1,
    cacheHits: 0,
    newlyExtracted: 1,
    coverage: completion.coverage,
    ...retryTelemetry,
    ...(authorityTelemetry === undefined ? {} : { authorityTelemetry }),
    manifest
  };
}

export function refreshIncompleteFill(
  prepared: PreparedExtractionFill,
  cacheRoot: string,
  writeLease: ExtractionCacheWriteLease
): void {
  if (!canRefreshIncompleteFill(prepared, cacheRoot, writeLease)) return;
  const completion = inspectFillWindow(
    cacheRoot, prepared.config, prepared.distinctExtractionTurns
  );
  assertPinnedFillIdentity(prepared, cacheRoot, writeLease);
  persistFillManifest(prepared, cacheRoot, "in_progress", completion);
}

function selectProbeTurn(
  prepared: PreparedExtractionFill,
  targetKey: string
): PreparedExtractionFill["distinctExtractionTurns"] {
  const target = prepared.distinctExtractionTurns.find((turn) => computeExtractionTurnCacheKey(
    prepared.config.model,
    prepared.config.requestProfile,
    OFFICIAL_API_SYSTEM_PROMPT,
    turn
  ) === targetKey);
  if (target === undefined) {
    throw new ExtractionCacheInvariantError("extraction probe target is outside the authority window");
  }
  return [target];
}

function assertProbeTargetIsMissing(
  prepared: PreparedExtractionFill,
  cacheRoot: string,
  targetKey: string
): void {
  const target = selectProbeTurn(prepared, targetKey)[0]!;
  const cacheKey = computeExtractionTurnCacheKey(
    prepared.config.model,
    prepared.config.requestProfile,
    OFFICIAL_API_SYSTEM_PROMPT,
    target
  );
  if (inspectCachedExtraction(
    cacheRoot, cacheKey, prepared.config.model, prepared.config.requestProfile
  ).status !== "missing") {
    throw new ExtractionCacheInvariantError(
      "extraction probe target changed before its single provider attempt"
    );
  }
}

function canRefreshIncompleteFill(
  prepared: PreparedExtractionFill,
  cacheRoot: string,
  writeLease: ExtractionCacheWriteLease
): boolean {
  try {
    writeLease.assertOwned();
    return readExtractionCacheManifestIdentity(cacheRoot)?.manifestSha256 ===
      prepared.pinnedManifestSha256;
  } catch {
    return false;
  }
}

function persistFillManifest(
  prepared: PreparedExtractionFill,
  cacheRoot: string,
  status: ExtractionFillStatus,
  completion: ExtractionFillCompletion
): ExtractionCacheManifest {
  const manifest = buildFillManifest({
    config: prepared.config,
    variant: prepared.variant,
    existingManifest: prepared.existingManifest,
    datasetRevision: prepared.datasetRevision,
    status,
    windowOffset: prepared.windowOffset,
    windowLimit: prepared.windowLimit,
    completion,
    ...(prepared.expansion === undefined ? {} : {
      expansionSourceAnchor: prepared.expansion.sourceAnchor
    })
  });
  const finalized = prepared.expansion === undefined || status !== "complete"
    ? manifest
    : {
        ...manifest,
        expansion_lineage: finalizeExpansionFillAuthority(
          prepared.expansion, manifest, completion
        )
      };
  writeExtractionCacheManifest(cacheRoot, finalized);
  return finalized;
}

function renderAuthorityTelemetry(telemetry: ExtractionAttemptLedgerSnapshot | undefined): string {
  if (telemetry === undefined) return "authority=none";
  return `attempts=${telemetry.attempts}/${telemetry.maximumAttempts} ` +
    `successful_shards=${telemetry.successfulShards}/${telemetry.successfulShardCeiling} ` +
    `usage_input_tokens=${telemetry.telemetry.inputTokens} ` +
    `usage_output_tokens=${telemetry.telemetry.outputTokens} ` +
    `usage_total_tokens=${telemetry.telemetry.totalTokens} ` +
    `usage_unavailable=${telemetry.telemetry.usageUnavailableRequests} ` +
    `usage_unresolved=${telemetry.telemetry.unresolvedTransportAttempts} ` +
    `usage_unknown=${telemetry.telemetry.usageUnknownAttempts}`;
}
