import { readdirSync } from "node:fs";
import { join } from "node:path";
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
import { buildFillManifest } from "./extraction/fill-manifest.js";
import {
  newFillStats,
  readFillRetryTelemetry,
  type FillRetryTelemetry
} from "./extraction/fill-stats.js";
import { loadDataset } from "./fetch.js";
import {
  pairSessionIntoRounds,
  type LongMemEvalQuestion,
  type LongMemEvalVariant
} from "./dataset.js";

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

export interface ExtractionFillOptions {
  readonly variant: LongMemEvalVariant;
  /** Stage with the first N questions (e.g. 100Q) before the full set. */
  readonly limit?: number;
  readonly offset?: number;
  /** Bounded pool size. Default 32; raise toward provider rate ceiling. */
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
}

export interface ExtractionFillResult extends FillRetryTelemetry {
  /** Distinct turn_content tasks after dedup (one cache key each). */
  readonly requestedTurns: number;
  /** Tasks served from an existing cache fixture (zero LLM). */
  readonly cacheHits: number;
  /** Tasks that triggered a live LLM extraction + cache write. */
  readonly newlyExtracted: number;
  /** Tasks whose extraction failed (counted, not silently dropped). */
  readonly failures: number;
  /** cached_turns / requested_turns written into the manifest. */
  readonly coverage: number;
  readonly manifest: ExtractionCacheManifest;
}

/** The provider userPrompt shape — only turn_content is load-bearing for the cache key. */
function buildFillUserPrompt(turnContent: string): string {
  // Mirror OfficialApiGardenProvider.requestSignals: the cache key extractor
  // (extractTurnContent) reads only `turn_content`, so the routing fields are
  // stable constants here — they do not enter the key and the fixture this
  // writes is shared with the real bench run.
  return JSON.stringify({
    workspace_id: "extraction-fill",
    run_id: "extraction-fill",
    surface_id: null,
    turn_content: turnContent,
    turn_messages: []
  });
}

/**
 * Flatten every question's sessions into rounds and dedup by turn_content. The
 * cache key hashes model + requestProfile + systemPrompt + turn_content, so identical
 * round content collapses to one task (and one cache key) regardless of which
 * question / session it came from.
 */
export function collectDistinctTurnContents(
  questions: readonly LongMemEvalQuestion[]
): readonly string[] {
  const seen = new Set<string>();
  for (const question of questions) {
    for (const session of question.haystack_sessions) {
      for (const round of pairSessionIntoRounds(session)) {
        const normalized = round.content.trim();
        if (normalized.length === 0) continue;
        seen.add(normalized);
      }
    }
  }
  return [...seen];
}

/**
 * Count shard fixtures already on disk (cached_turns numerator). Shards live
 * under two-hex-char subdirs; the manifest.json at the root is not a shard.
 */
function countCacheShards(cacheRoot: string): number {
  let total = 0;
  let shardDirs: string[];
  try {
    shardDirs = readdirSync(cacheRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^[0-9a-f]{2}$/u.test(entry.name))
      .map((entry) => entry.name);
  } catch {
    return 0;
  }
  for (const shardDir of shardDirs) {
    try {
      total += readdirSync(join(cacheRoot, shardDir)).filter((name) =>
        name.endsWith(".json")
      ).length;
    } catch {
      // Unreadable shard dir contributes 0; the next manifest write reflects
      // whatever is actually present.
    }
  }
  return total;
}

/**
 * Run a bounded-concurrency pool over `tasks`, invoking `worker` on each. Used
 * instead of a p-limit dependency to keep the bench package dependency-free.
 */
async function runBoundedPool<T>(
  tasks: readonly T[],
  concurrency: number,
  worker: (task: T) => Promise<void>
): Promise<void> {
  const limit = Math.max(1, concurrency);
  let cursor = 0;
  async function pump(): Promise<void> {
    while (cursor < tasks.length) {
      const index = cursor++;
      const task = tasks[index];
      if (task === undefined) continue;
      await worker(task);
    }
  }
  const runners = Array.from({ length: Math.min(limit, tasks.length) }, () => pump());
  const settled = await Promise.allSettled(runners);
  const rejected = settled.find(
    (result): result is PromiseRejectedResult => result.status === "rejected"
  );
  if (rejected !== undefined) throw rejected.reason;
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
  const cacheRoot = options.cacheRoot ?? EXTRACTION_CACHE_ROOT;
  const lease = acquireExtractionCacheWriteLease(cacheRoot);
  return withExtractionCacheWriteLease(
    lease,
    () => runLockedExtractionFill(options, cacheRoot, lease)
  );
}

async function runLockedExtractionFill(
  options: ExtractionFillOptions,
  cacheRoot: string,
  writeLease: ExtractionCacheWriteLease
): Promise<ExtractionFillResult> {
  const log =
    options.log ?? ((message: string) => process.stderr.write(`${message}\n`));
  const concurrency = options.concurrency ?? EXTRACTION_FILL_DEFAULT_CONCURRENCY;
  const prepared = await prepareExtractionFill(options, cacheRoot, concurrency, log);
  const stats = newFillStats();
  const failures = await executeExtractionFill(
    options,
    prepared,
    cacheRoot,
    concurrency,
    stats,
    log,
    writeLease
  );
  return finishExtractionFill(
    prepared, cacheRoot, failures, stats, log, writeLease
  );
}

interface PreparedExtractionFill {
  readonly config: CompileSeedExtractionConfig;
  readonly existingManifest: ExtractionCacheManifest | undefined;
  readonly pinnedManifestSha256: string;
  readonly distinctTurns: readonly string[];
  readonly requestedTurns: number;
  readonly variant: LongMemEvalVariant;
}

async function prepareExtractionFill(
  options: ExtractionFillOptions,
  cacheRoot: string,
  concurrency: number,
  log: (message: string) => void
): Promise<PreparedExtractionFill> {
  const startingIdentity = readExtractionCacheManifestIdentity(cacheRoot);
  const existingManifest = startingIdentity?.manifest;
  if (existingManifest === undefined) assertManifestlessCacheIsEmpty(cacheRoot);
  const config = resolveFillConfig(existingManifest);

  const window = await prepareExtractionWindow(options);
  const { distinctTurns, requestedTurns } = window;
  const currentIdentity = readExtractionCacheManifestIdentity(cacheRoot);
  assertPreparationIdentityUnchanged(startingIdentity, currentIdentity);
  if (currentIdentity === undefined) assertManifestlessCacheIsEmpty(cacheRoot);
  const currentManifest = currentIdentity?.manifest;
  preflightExtractionCache({
    cacheRoot,
    manifest: currentManifest,
    config,
    systemPrompt: OFFICIAL_API_SYSTEM_PROMPT,
    requiredTurnContents: distinctTurns,
    allowLiveExtraction: true,
    liveExtractionPossible: config.apiKey !== null,
    warn: log
  });
  const pinned = pinExtractionCacheIdentity({
    cacheRoot,
    config,
    variant: options.variant,
    existingIdentity: currentIdentity,
    requestedTurns
  });
  log(
    `[extraction-fill] variant=${options.variant} questions=${window.questionCount} ` +
      `distinct_turns=${requestedTurns} model=${config.model} ` +
      `concurrency=${concurrency}`
  );
  return {
    config,
    existingManifest: pinned.manifest,
    pinnedManifestSha256: pinned.manifestSha256,
    distinctTurns,
    requestedTurns,
    variant: options.variant
  };
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

async function prepareExtractionWindow(options: ExtractionFillOptions): Promise<{
  readonly distinctTurns: readonly string[];
  readonly requestedTurns: number;
  readonly questionCount: number;
}> {
  const questions = await loadDataset(options.variant, {
    dataDir: options.dataDir,
    pinnedMetaRoot: options.pinnedMetaRoot
  });
  const offset = Math.max(0, options.offset ?? 0);
  const sliceEnd =
    options.limit !== undefined ? offset + options.limit : questions.length;
  const window = questions.slice(offset, sliceEnd);
  const distinctTurns = collectDistinctTurnContents(window);
  return {
    distinctTurns,
    requestedTurns: distinctTurns.length,
    questionCount: window.length
  };
}

function pinExtractionCacheIdentity(input: {
  readonly cacheRoot: string;
  readonly config: CompileSeedExtractionConfig;
  readonly variant: LongMemEvalVariant;
  readonly existingIdentity: ReturnType<typeof readExtractionCacheManifestIdentity>;
  readonly requestedTurns: number;
}): { readonly manifest: ExtractionCacheManifest; readonly manifestSha256: string } {
  if (input.existingIdentity === undefined) {
    writeExtractionCacheManifest(input.cacheRoot, buildFillManifest({
      config: input.config,
      variant: input.variant,
      existingManifest: undefined,
      requestedTurns: input.requestedTurns,
      cachedTurns: 0,
      coverage: input.requestedTurns === 0 ? 1 : 0
    }));
  } else {
    return input.existingIdentity;
  }
  const identity = readExtractionCacheManifestIdentity(input.cacheRoot);
  if (identity === undefined) {
    throw new ExtractionCacheInvariantError(
      "extraction-fill failed to pin its cache manifest identity"
    );
  }
  return identity;
}

async function executeExtractionFill(
  options: ExtractionFillOptions,
  prepared: PreparedExtractionFill,
  cacheRoot: string,
  concurrency: number,
  stats: CompileSeedExtractionStats,
  log: (message: string) => void,
  writeLease: ExtractionCacheWriteLease
): Promise<number> {
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
  return runExtractionPool({
    extractor,
    distinctTurns: prepared.distinctTurns,
    concurrency,
    requestedTurns: prepared.requestedTurns,
    stats,
    log
  });
}

function finishExtractionFill(
  prepared: PreparedExtractionFill,
  cacheRoot: string,
  failures: number,
  stats: CompileSeedExtractionStats,
  log: (message: string) => void,
  writeLease: ExtractionCacheWriteLease
): ExtractionFillResult {
  assertPinnedFillIdentity(prepared, cacheRoot, writeLease);
  const { requestedTurns } = prepared;
  const cacheHits = stats.cacheHits;
  const newlyExtracted = stats.llmCalls;
  const coverage = requestedTurns === 0 ? 1 : (requestedTurns - failures) / requestedTurns;
  const cachedTurns = countCacheShards(cacheRoot);
  const retryTelemetry = readFillRetryTelemetry(stats);
  const manifest = buildFillManifest({
    config: prepared.config,
    variant: prepared.variant,
    existingManifest: prepared.existingManifest,
    requestedTurns,
    cachedTurns,
    coverage
  });
  writeExtractionCacheManifest(cacheRoot, manifest);
  log(
    `[extraction-fill] done: cache_hits=${cacheHits} ` +
      `newly_extracted=${newlyExtracted} failures=${failures} ` +
      `retry_successes=${retryTelemetry.retrySuccesses} ` +
      `rate_limit_retries=${retryTelemetry.rateLimitRetries} ` +
      `terminal_max_retries=${retryTelemetry.terminalRetryClassifications.failure_max_retries} ` +
      `terminal_nonretryable_4xx=${retryTelemetry.terminalRetryClassifications.failure_non_retryable_4xx} ` +
      `terminal_timeouts=${retryTelemetry.terminalRetryClassifications.failure_timeout} ` +
      `coverage=${(coverage * 100).toFixed(1)}% cached_turns=${cachedTurns}`
  );
  return {
    requestedTurns,
    cacheHits,
    newlyExtracted,
    failures,
    coverage,
    ...retryTelemetry,
    manifest
  };
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

async function runExtractionPool(input: {
  readonly extractor: BenchSignalExtractor;
  readonly distinctTurns: readonly string[];
  readonly concurrency: number;
  readonly requestedTurns: number;
  readonly stats: CompileSeedExtractionStats;
  readonly log: (message: string) => void;
}): Promise<number> {
  const { extractor, stats, requestedTurns, log } = input;
  let failures = 0;
  let processed = 0;
  const progressEvery = Math.max(1, Math.floor(requestedTurns / 20));

  await runBoundedPool(input.distinctTurns, input.concurrency, async (turnContent) => {
    try {
      await extractor.extract({
        systemPrompt: OFFICIAL_API_SYSTEM_PROMPT,
        userPrompt: buildFillUserPrompt(turnContent)
      });
    } catch (cause) {
      if (cause instanceof ExtractionCacheInvariantError) throw cause;
      failures++;
    } finally {
      processed++;
      if (processed % progressEvery === 0 || processed === requestedTurns) {
        log(
          `[extraction-fill] ${processed}/${requestedTurns} ` +
            `cache_hits=${stats.cacheHits} newly_extracted=${stats.llmCalls} ` +
            `failures=${failures}`
        );
      }
    }
  });
  return failures;
}
