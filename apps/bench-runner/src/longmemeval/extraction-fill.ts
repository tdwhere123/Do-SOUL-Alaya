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
  computeSystemPromptSha256,
  readExtractionCacheManifest,
  writeExtractionCacheManifest,
  EXTRACTION_CACHE_KEY_ALGO,
  EXTRACTION_CACHE_MANIFEST_VERSION,
  type ExtractionCacheManifest
} from "./extraction-cache-manifest.js";
import { loadDataset } from "./fetch.js";
import {
  pairSessionIntoRounds,
  type LongMemEvalQuestion,
  type LongMemEvalVariant
} from "./dataset.js";

/**
 * @anchor longmemeval-extraction-fill
 *
 * Layer 1 (slow, one-time). A standalone pass that, per turn, ONLY calls the
 * extractor and writes the extraction cache — NO daemon, NO DB, NO
 * materialization. The single LLM call point (OfficialApiGardenProvider.compile
 * -> the caching extractor delegate) is pure CPU + network, so this pass runs
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

export interface ExtractionFillResult {
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
 * cache key hashes only model + systemPrompt + turn_content, so identical
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
  await Promise.all(runners);
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
  const log =
    options.log ?? ((message: string) => process.stderr.write(`${message}\n`));
  const concurrency = options.concurrency ?? EXTRACTION_FILL_DEFAULT_CONCURRENCY;

  const existingManifest = readExtractionCacheManifest(cacheRoot);
  const config = resolveCompileSeedExtractionConfig(process.env, existingManifest);
  // The model comes from the single source (env -> manifest); a missing source
  // throws inside resolveCompileSeedExtractionConfig. Assert non-empty here so
  // a fill pass can never write fixtures keyed under a silent default model.
  if (config.model.trim().length === 0) {
    throw new Error(
      "extraction-fill: resolved extraction model is empty; refusing to fill " +
        "the cache with an unkeyable model."
    );
  }

  const questions = await loadDataset(options.variant, {
    dataDir: options.dataDir,
    pinnedMetaRoot: options.pinnedMetaRoot
  });
  const offset = Math.max(0, options.offset ?? 0);
  const sliceEnd =
    options.limit !== undefined ? offset + options.limit : questions.length;
  const window = questions.slice(offset, sliceEnd);

  const distinctTurns = collectDistinctTurnContents(window);
  const requestedTurns = distinctTurns.length;
  log(
    `[extraction-fill] variant=${options.variant} questions=${window.length} ` +
      `distinct_turns=${requestedTurns} model=${config.model} ` +
      `concurrency=${concurrency}`
  );

  const delegate =
    options.extractorFactory?.(config) ?? createGardenHttpExtractor(config);
  // One shared stats object across the pool. cacheHits / llmCalls increments
  // are single-statement mutations in the JS event loop, so concurrent fill
  // workers never tear a counter — only the final totals are read.
  const stats = newFillStats();
  const extractor = createCachingSignalExtractor({
    delegate,
    model: config.model,
    cacheRoot,
    stats
  });

  let failures = 0;
  let processed = 0;
  const progressEvery = Math.max(1, Math.floor(requestedTurns / 20));

  await runBoundedPool(distinctTurns, concurrency, async (turnContent) => {
    try {
      // The caching extractor returns a hit's stored rawJson with no delegate
      // call (stats.cacheHits++); on a miss it calls the delegate (live HTTP),
      // write-throughs the fixture (stats.llmCalls++).
      await extractor.extract({
        systemPrompt: OFFICIAL_API_SYSTEM_PROMPT,
        userPrompt: buildFillUserPrompt(turnContent)
      });
    } catch {
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
  const cacheHits = stats.cacheHits;
  const newlyExtracted = stats.llmCalls;

  // Recompute cached_turns from what is actually on disk (every shard, not just
  // this run's window) so coverage is honest about the whole cache. coverage is
  // this run's window denominator — the fraction of the requested window now
  // covered. requested_turns / cached_turns let the preflight reason about
  // gaps.
  const cachedTurns = countCacheShards(cacheRoot);
  const coverage = requestedTurns === 0 ? 1 : (requestedTurns - failures) / requestedTurns;
  const datasetRevision = existingManifest?.dataset_revision ?? "unpinned";
  const manifest: ExtractionCacheManifest = {
    schema_version: EXTRACTION_CACHE_MANIFEST_VERSION,
    extraction_model: config.model,
    provider_url: config.providerUrl,
    system_prompt_sha256: computeSystemPromptSha256(OFFICIAL_API_SYSTEM_PROMPT),
    cache_key_algo: EXTRACTION_CACHE_KEY_ALGO,
    dataset: datasetVariantLabel(options.variant),
    dataset_revision: datasetRevision,
    requested_turns: requestedTurns,
    cached_turns: cachedTurns,
    coverage,
    storage: existingManifest?.storage ?? "git-tracked",
    built_at: new Date().toISOString(),
    builder: "extraction-fill"
  };
  writeExtractionCacheManifest(cacheRoot, manifest);

  log(
    `[extraction-fill] done: cache_hits=${cacheHits} ` +
      `newly_extracted=${newlyExtracted} failures=${failures} ` +
      `coverage=${(coverage * 100).toFixed(1)}% cached_turns=${cachedTurns}`
  );

  return {
    requestedTurns,
    cacheHits,
    newlyExtracted,
    failures,
    coverage,
    manifest
  };
}

function datasetVariantLabel(variant: LongMemEvalVariant): string {
  return variant.replace(/_/u, "-");
}

/**
 * A fresh extraction-stats accumulator the caching extractor mutates. Only
 * cacheHits / llmCalls are read by the fill pass; the rest exist to satisfy the
 * shared stats shape so the same caching extractor the bench run uses is reused
 * unchanged.
 */
function newFillStats(): CompileSeedExtractionStats {
  return {
    path: "official_api_compile",
    cacheHits: 0,
    llmCalls: 0,
    offlineFallbacks: 0,
    liveExtractionFailures: 0,
    cachedExtractionFailures: 0,
    factsProduced: 0,
    signalsDropped: 0,
    signalsDroppedByReason: { candidate_absent: 0, materialization_error: 0 },
    parseDropped: 0,
    compileOverflowDropped: 0,
    lastTurnRawSignalCount: 0,
    lastTurnDraftCount: 0,
    lastExtractionSource: null,
    lastCacheKey: null
  };
}
