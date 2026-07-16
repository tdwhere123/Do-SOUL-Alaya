import { OFFICIAL_API_SYSTEM_PROMPT } from "@do-soul/alaya-soul";
import {
  EXTRACTION_CACHE_ROOT,
  createCachingSignalExtractor,
  createGardenHttpExtractor,
  resolveCompileSeedExtractionConfig,
  type BenchSignalExtractor,
  type CompileSeedExtractionConfig,
  type CompileSeedExtractionStats
} from "./compile-seed.js";
import {
  readExtractionCacheManifestIdentity,
  writeExtractionCacheManifest,
  type ExtractionCacheManifest
} from "./extraction-cache-manifest.js";
import { preflightExtractionCache } from "./compile-seed-preflight.js";
import {
  acquireExtractionCacheWriteLease,
  assertManifestlessCacheIsEmpty,
  withExtractionCacheWriteLease,
  type ExtractionCacheWriteLease
} from "./extraction/fill-root-guard.js";
import { ExtractionCacheInvariantError } from "./extraction/cache-invariant-error.js";
import {
  buildFillManifest,
  pinExtractionCacheIdentity
} from "./extraction/fill-manifest.js";
import {
  newFillStats,
  readFillRetryTelemetry,
  type FillRetryTelemetry
} from "./extraction/fill-stats.js";
import { runExtractionPool } from "./extraction/fill-pool.js";
import {
  assertExtractionFillComplete,
  inspectExtractionFillCompletion,
  type ExtractionFillCompletion
} from "./extraction/fill-completion.js";
import type { ExtractionFillStatus } from "./extraction/fill-manifest-contract.js";
import type { LongMemEvalVariant } from "./dataset.js";
import {
  finalizeExpansionFillAuthority,
  prepareExpansionFillAuthority,
  revalidateExpansionFillAuthority,
  type PreparedExpansionFillAuthority
} from "./extraction/expansion-fill-authority.js";
import type { LongMemEvalExpansionCapability } from
  "./promotion/expansion-capability.js";
import { prepareExtractionFillWindow } from "./extraction/fill-window.js";
export { collectDistinctTurnContents } from "./extraction/turn-contents.js";
/**
 * @anchor longmemeval-extraction-fill
 *
 * Layer 1 (slow, one-time). Calls the extractor and writes the extraction
 * cache without starting a daemon or materializing memory. The delegate is
 * pure CPU + network, so this pass runs
 * a bounded-concurrency pool with none of the daemon's process.env race or
 * 1500MB/shard memory ceiling. Its only ceiling is the provider's rate limit.
 *
 * Once the cache is filled, every later recall-tuning iteration (recall-eval)
 * re-pays neither extraction nor materialization.
 *
 * Reuses: loadDataset, pairSessionIntoRounds, resolveCompileSeedExtractionConfig,
 * createGardenHttpExtractor, createCachingSignalExtractor, OFFICIAL_API_SYSTEM_PROMPT.
 * Bypasses: startBenchDaemon, proposeMemoriesFromCompileSignals.
 *
 * cross-file: apps/bench-runner/src/longmemeval/compile-seed.ts
 *   (the cache-key formula and the single-source extraction model)
 * cross-file: apps/bench-runner/src/longmemeval/extraction-cache-manifest.ts
 */

export const EXTRACTION_FILL_DEFAULT_CONCURRENCY = 32;
export const EXTRACTION_FILL_MAX_CONCURRENCY = 32;

export interface ExtractionFillOptions {
  readonly variant: LongMemEvalVariant;
  /** Stage with the first N questions (e.g. 100Q) before the full set. */
  readonly limit?: number;
  readonly offset?: number;
  /** Bounded pool size. Product maximum and default: 32. */
  readonly concurrency?: number;
  /** Override the extraction cache root (tests). */
  readonly cacheRoot?: string;
  /** Override the dataset dir (tests / non-canonical mirrors). */
  readonly dataDir?: string;
  /** Override the pinned-meta root (tests). */
  readonly pinnedMetaRoot?: string;
  /**
   * Inject the live LLM delegate (tests). Production passes nothing and the
   * pass builds createGardenHttpExtractor from the resolved garden config.
   */
  readonly extractorFactory?: (
    config: CompileSeedExtractionConfig
  ) => BenchSignalExtractor;
  /** Progress sink (default: stderr). */
  readonly log?: (message: string) => void;
  /** Stops new work and aborts in-flight provider requests. */
  readonly signal?: AbortSignal;
  /** Opaque live authority required only for canonical 100Q -> 500Q fill. */
  readonly expansionCapability?: LongMemEvalExpansionCapability;
}

export interface ExtractionFillResult extends FillRetryTelemetry {
  /** Distinct turn_content tasks after dedup (one cache key each). */
  readonly requestedTurns: number;
  /** Tasks served from an existing cache fixture (zero LLM). */
  readonly cacheHits: number;
  /** Tasks that triggered a live LLM extraction + cache write. */
  readonly newlyExtracted: number;
  /** cached_turns / requested_turns written into the manifest. */
  readonly coverage: number;
  readonly manifest: ExtractionCacheManifest;
}

/**
 * Run the extraction-fill pass. Asserts a non-fallback extraction model from
 * the single source (resolveCompileSeedExtractionConfig: env -> cache
 * manifest.extraction_model) and refuses to run if the garden API key is
 * unavailable AND any task would miss the cache — a fill pass with no creds and
 * an incomplete cache cannot fill anything.
 */
export async function runExtractionFill(
  options: ExtractionFillOptions
): Promise<ExtractionFillResult> {
  const concurrency = resolveExtractionFillConcurrency(options.concurrency);
  const cacheRoot = options.cacheRoot ?? EXTRACTION_CACHE_ROOT;
  const initialIdentity = readExtractionCacheManifestIdentity(cacheRoot);
  const expansion = await prepareExpansionFillAuthority(options, cacheRoot);
  assertPreparationIdentityUnchanged(
    initialIdentity,
    readExtractionCacheManifestIdentity(cacheRoot)
  );
  const lease = acquireExtractionCacheWriteLease(cacheRoot);
  return withExtractionCacheWriteLease(
    lease,
    () => runLockedExtractionFill(
      options, cacheRoot, lease, expansion, concurrency
    )
  );
}

async function runLockedExtractionFill(
  options: ExtractionFillOptions,
  cacheRoot: string,
  writeLease: ExtractionCacheWriteLease,
  expansion: PreparedExpansionFillAuthority | undefined,
  concurrency: number
): Promise<ExtractionFillResult> {
  const log =
    options.log ?? ((message: string) => process.stderr.write(`${message}\n`));
  const prepared = await prepareExtractionFill(
    options, cacheRoot, concurrency, log, expansion
  );
  const stats = newFillStats();
  try {
    await executeExtractionFill(
      options, prepared, cacheRoot, concurrency, stats, log, writeLease
    );
    options.signal?.throwIfAborted();
    return finishExtractionFill(prepared, cacheRoot, stats, log, writeLease);
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
  }
}

function resolveExtractionFillConcurrency(raw: number | undefined): number {
  const value = raw ?? EXTRACTION_FILL_DEFAULT_CONCURRENCY;
  if (!Number.isSafeInteger(value) || value < 1 ||
      value > EXTRACTION_FILL_MAX_CONCURRENCY) {
    throw new Error(`extraction-fill concurrency must be an integer from 1 to ${EXTRACTION_FILL_MAX_CONCURRENCY}`);
  }
  return value;
}

interface PreparedExtractionFill {
  readonly config: CompileSeedExtractionConfig;
  readonly existingManifest: ExtractionCacheManifest | undefined;
  readonly pinnedManifestSha256: string;
  readonly distinctTurns: readonly string[];
  readonly requestedTurns: number;
  readonly datasetRevision: string;
  readonly variant: LongMemEvalVariant;
  readonly windowOffset: number;
  readonly windowLimit: number;
  readonly expansion?: PreparedExpansionFillAuthority;
}

async function prepareExtractionFill(
  options: ExtractionFillOptions, cacheRoot: string, concurrency: number,
  log: (message: string) => void,
  expansion: PreparedExpansionFillAuthority | undefined
): Promise<PreparedExtractionFill> {
  const startingIdentity = readExtractionCacheManifestIdentity(cacheRoot);
  const existingManifest = startingIdentity?.manifest;
  if (existingManifest === undefined) assertManifestlessCacheIsEmpty(cacheRoot);
  const config = resolveFillConfig(existingManifest);
  const { window, completion } = await inspectPreparedFillWindow({
    options, cacheRoot, startingIdentity, config, expansion
  });
  const { distinctTurns, requestedTurns } = window;
  const pinned = preflightAndPinExtractionIdentity({
    startingIdentity,
    cacheRoot,
    config,
    distinctTurns,
    log,
    variant: options.variant,
    datasetRevision: window.datasetRevision,
    windowOffset: window.windowOffset,
    windowLimit: window.questionCount,
    completion,
    ...(expansion === undefined ? {} : { expansionSourceAnchor: expansion.sourceAnchor })
  });
  log(`[extraction-fill] variant=${options.variant} questions=${window.questionCount} ` +
    `distinct_turns=${requestedTurns} model=${config.model} concurrency=${concurrency}`);
  return {
    config,
    existingManifest: pinned.manifest,
    pinnedManifestSha256: pinned.manifestSha256,
    distinctTurns,
    requestedTurns,
    datasetRevision: window.datasetRevision,
    variant: options.variant,
    windowOffset: window.windowOffset,
    windowLimit: window.questionCount,
    ...(expansion === undefined ? {} : { expansion })
  };
}

async function inspectPreparedFillWindow(input: {
  readonly options: ExtractionFillOptions;
  readonly cacheRoot: string;
  readonly startingIdentity: ReturnType<typeof readExtractionCacheManifestIdentity>;
  readonly config: CompileSeedExtractionConfig;
  readonly expansion: PreparedExpansionFillAuthority | undefined;
}) {
  const window = await prepareExtractionFillWindow(input.options, input.expansion);
  assertPreparationIdentityUnchanged(
    input.startingIdentity,
    readExtractionCacheManifestIdentity(input.cacheRoot)
  );
  const completion = inspectFillWindow(input.cacheRoot, input.config, window.distinctTurns);
  if (input.expansion !== undefined) revalidateExpansionFillAuthority(input.expansion);
  assertNoOrphanFillSubstrate(completion);
  return { window, completion };
}

function preflightAndPinExtractionIdentity(input: {
  readonly startingIdentity: ReturnType<typeof readExtractionCacheManifestIdentity>;
  readonly cacheRoot: string;
  readonly config: CompileSeedExtractionConfig;
  readonly distinctTurns: readonly string[];
  readonly log: (message: string) => void;
  readonly variant: LongMemEvalVariant;
  readonly datasetRevision: string;
  readonly windowOffset: number;
  readonly windowLimit: number;
  readonly completion: ExtractionFillCompletion;
  readonly expansionSourceAnchor?: PreparedExpansionFillAuthority["sourceAnchor"];
}) {
  const currentIdentity = readExtractionCacheManifestIdentity(input.cacheRoot);
  assertPreparationIdentityUnchanged(input.startingIdentity, currentIdentity);
  if (currentIdentity === undefined) assertManifestlessCacheIsEmpty(input.cacheRoot);
  preflightExtractionCache({
    cacheRoot: input.cacheRoot,
    manifest: currentIdentity?.manifest,
    config: input.config,
    systemPrompt: OFFICIAL_API_SYSTEM_PROMPT,
    requiredTurnContents: input.distinctTurns,
    requiredQuestionWindow: {
      offset: input.windowOffset,
      limit: input.windowLimit
    },
    allowLiveExtraction: true,
    liveExtractionPossible: input.config.apiKey !== null,
    warn: input.log
  });
  return pinExtractionCacheIdentity({
    cacheRoot: input.cacheRoot,
    config: input.config,
    variant: input.variant,
    existingIdentity: currentIdentity,
    datasetRevision: input.datasetRevision,
    windowOffset: input.windowOffset,
    windowLimit: input.windowLimit,
    completion: input.completion,
    ...(input.expansionSourceAnchor === undefined ? {} : {
      expansionSourceAnchor: input.expansionSourceAnchor
    })
  });
}

function resolveFillConfig(
  manifest: ExtractionCacheManifest | undefined
): CompileSeedExtractionConfig {
  const config = resolveCompileSeedExtractionConfig(process.env, manifest);
  if (config.model.trim().length > 0) return config;
  throw new Error(
    "extraction-fill: resolved extraction model is empty; refusing to fill " +
      "the cache with an unkeyable model."
  );
}

function assertPreparationIdentityUnchanged(
  starting: ReturnType<typeof readExtractionCacheManifestIdentity>,
  current: ReturnType<typeof readExtractionCacheManifestIdentity>
): void {
  if (starting?.manifestSha256 === current?.manifestSha256) return;
  throw new ExtractionCacheInvariantError(
    "extraction cache manifest changed during dataset preparation"
  );
}

async function executeExtractionFill(
  options: ExtractionFillOptions,
  prepared: PreparedExtractionFill,
  cacheRoot: string,
  concurrency: number,
  stats: CompileSeedExtractionStats,
  log: (message: string) => void,
  writeLease: ExtractionCacheWriteLease
): Promise<void> {
  const delegate =
    options.extractorFactory?.(prepared.config) ??
    createGardenHttpExtractor(prepared.config);
  const extractor = createCachingSignalExtractor({
    delegate,
    config: prepared.config,
    cacheRoot,
    stats,
    writeLease
  });
  await runExtractionPool({
    extractor,
    distinctTurns: prepared.distinctTurns,
    concurrency,
    requestedTurns: prepared.requestedTurns,
    stats,
    log,
    signal: options.signal
  });
}

function finishExtractionFill(
  prepared: PreparedExtractionFill,
  cacheRoot: string,
  stats: CompileSeedExtractionStats,
  log: (message: string) => void,
  writeLease: ExtractionCacheWriteLease
): ExtractionFillResult {
  assertPinnedFillIdentity(prepared, cacheRoot, writeLease);
  const completion = inspectFillWindow(
    cacheRoot, prepared.config, prepared.distinctTurns
  );
  assertExtractionFillComplete(completion);
  assertTaskConservation(prepared, stats, completion);
  assertPinnedFillIdentity(prepared, cacheRoot, writeLease);
  const manifest = persistFillManifest(prepared, cacheRoot, "complete", completion);
  const cacheHits = stats.cacheHits;
  const newlyExtracted = stats.llmCalls;
  const retryTelemetry = readFillRetryTelemetry(stats);
  log(
    `[extraction-fill] done: cache_hits=${cacheHits} ` +
      `newly_extracted=${newlyExtracted} failures=0 ` +
      `retry_successes=${retryTelemetry.retrySuccesses} ` +
      `rate_limit_retries=${retryTelemetry.rateLimitRetries} ` +
      `terminal_max_retries=${retryTelemetry.terminalRetryClassifications.failure_max_retries} ` +
      `terminal_nonretryable_4xx=${retryTelemetry.terminalRetryClassifications.failure_non_retryable_4xx} ` +
      `terminal_timeouts=${retryTelemetry.terminalRetryClassifications.failure_timeout} ` +
      `coverage=${(completion.coverage * 100).toFixed(1)}% ` +
      `cached_turns=${completion.validTurns}`
  );
  return {
    requestedTurns: prepared.requestedTurns,
    cacheHits,
    newlyExtracted,
    coverage: completion.coverage,
    ...retryTelemetry,
    manifest
  };
}

function refreshIncompleteFill(
  prepared: PreparedExtractionFill,
  cacheRoot: string,
  writeLease: ExtractionCacheWriteLease
): void {
  if (!canRefreshIncompleteFill(prepared, cacheRoot, writeLease)) return;
  const completion = inspectFillWindow(
    cacheRoot, prepared.config, prepared.distinctTurns
  );
  assertPinnedFillIdentity(prepared, cacheRoot, writeLease);
  persistFillManifest(prepared, cacheRoot, "in_progress", completion);
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
    // Recovery bookkeeping must never overwrite changed or unreadable authority.
    return false;
  }
}

function inspectFillWindow(
  cacheRoot: string,
  config: CompileSeedExtractionConfig,
  distinctTurns: readonly string[]
): ExtractionFillCompletion {
  return inspectExtractionFillCompletion({
    cacheRoot,
    model: config.model,
    requestProfile: config.requestProfile,
    systemPrompt: OFFICIAL_API_SYSTEM_PROMPT,
    turnContents: distinctTurns
  });
}

function assertNoOrphanFillSubstrate(completion: ExtractionFillCompletion): void {
  if (completion.orphanTurns === 0) return;
  throw new ExtractionCacheInvariantError(
    `extraction-fill cache contains ${completion.orphanTurns} shard(s) outside ` +
      "the requested window; use a dedicated cache root for this exact window"
  );
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

function assertTaskConservation(
  prepared: PreparedExtractionFill,
  stats: CompileSeedExtractionStats,
  completion: ExtractionFillCompletion
): void {
  const completedTasks = stats.cacheHits + stats.llmCalls;
  if (completedTasks === prepared.requestedTurns &&
    completion.expectedTurns === prepared.requestedTurns) return;
  throw new ExtractionCacheInvariantError(
    "extraction-fill task conservation failed: " +
      `cache_hits=${stats.cacheHits} newly_extracted=${stats.llmCalls} ` +
      `requested=${prepared.requestedTurns} expected=${completion.expectedTurns}`
  );
}

function assertPinnedFillIdentity(
  prepared: PreparedExtractionFill,
  cacheRoot: string,
  writeLease: ExtractionCacheWriteLease
): void {
  writeLease.assertOwned();
  const identity = readExtractionCacheManifestIdentity(cacheRoot);
  if (identity?.manifestSha256 !== prepared.pinnedManifestSha256) {
    throw new ExtractionCacheInvariantError(
      "extraction-fill cache manifest identity changed before finalization"
    );
  }
}
