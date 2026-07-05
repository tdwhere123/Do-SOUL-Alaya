import {
  existsSync
} from "node:fs";
import {
  computeSystemPromptSha256,
  readExtractionCacheManifest,
  type ExtractionCacheManifest
} from "./extraction-cache-manifest.js";
import {
  cacheFilePath,
  computeCacheKey
} from "./compile-seed-cache.js";
import type {
  CompileSeedExtractionConfig
} from "./compile-seed-types.js";

const GARDEN_MODEL_ENV = "OFFICIAL_API_GARDEN_MODEL";

// Run-start coverage threshold. A populated cache below this coverage means a
// run would live-extract a large gap; the operator must pass an explicit
// allow-live / fill flag rather than have a slow live run start silently.
const EXTRACTION_CACHE_COVERAGE_THRESHOLD = 0.95;

/**
 * Run-start fail-loud guard. Runs in ~1s (file read + sha256, zero LLM) and
 * turns the otherwise-silent "wrong model / changed prompt / uncovered cache"
 * failures — which today only surface as a 466h slow run — into an immediate,
 * actionable throw.
 *
 * Behaviour by case:
 *   - NO manifest with requireManifest=false (first-ever build, before any
 *     fill pass): allow live, log loudly to stderr. Runner contexts default
 *     requireManifest=true; operators must set
 *     ALAYA_BENCH_REQUIRE_EXTRACTION_CACHE_MANIFEST=0/false for this path.
 *   - manifest present, `config.model !== manifest.extraction_model`: throw,
 *     naming both values — the cache would 0-hit and the run would be a full
 *     live extraction.
 *   - manifest present, `sha256(systemPrompt) !== manifest.system_prompt_sha256`:
 *     throw — the prompt drifted, so every key changed and the whole cache is
 *     dead.
 *   - manifest present, NO `coverage` field AND not an allow-live/fill run:
 *     throw — a pre-fill manifest cannot prove the cache covers the dataset,
 *     so it is a gap requiring `--allow-live-extraction`. extraction-fill
 *     always writes coverage, so a coverage-less manifest means an unfilled
 *     cache.
 *   - manifest present, `coverage < threshold` AND not an allow-live/fill run:
 *     throw, telling the operator to run extraction-fill or pass
 *     `--allow-live-extraction`.
 *
 * cross-file: apps/bench-runner/src/longmemeval/extraction-cache-manifest.ts
 */
export interface ExtractionCachePreflightInput {
  readonly cacheRoot: string;
  readonly config: CompileSeedExtractionConfig;
  readonly systemPrompt: string;
  readonly allowLiveExtraction?: boolean;
  // Whether THIS run can live-extract at all. The "uncovered window / coverage
  // gap" guards below exist to stop a credentialled run from silently spending
  // ~466h live-extracting an unfilled cache window. The no-credentials offline
  // fallback (createCompileSeedRunner provider === null -> seedOfflineFallback)
  // never makes an LLM call: a missing fixture is served by the deterministic
  // full-turn fallback, not by live extraction. So when live extraction is
  // impossible the coverage gap is a category error, not a silent-cost hole,
  // and the guard must NOT fire. Defaults to `config.apiKey !== null` — the
  // single source createCompileSeedRunner reads for its `credentialled` flag —
  // so a direct caller that passes a credentialled config keeps the guard.
  // invariant: this only relaxes the live-extraction-gap guards; the
  // model/prompt-drift guards above always fire (cheap config-drift detection).
  readonly liveExtractionPossible?: boolean;
  readonly manifest?: ExtractionCacheManifest | undefined;
  // The distinct turn contents THIS run will extract (its --limit/--offset
  // question window flattened to rounds + dedup). When present, the gate is
  // window-containment: every one of these turns must already have a fixture on
  // disk, regardless of the manifest's coverage scalar (which is only
  // denominated against whatever window the LAST extraction-fill recorded). A
  // staged `extraction-fill --limit 100` writing coverage=1.0 therefore can no
  // longer let a `longmemeval --limit 500` run silently live-extract the
  // unfilled 400. When absent (callers that do not flatten a turn window),
  // the gate falls back to the manifest coverage scalar below.
  // cross-file: apps/bench-runner/src/longmemeval/extraction-fill.ts
  //   collectDistinctTurnContents (the producer side of the same dedup)
  readonly requiredTurnContents?: readonly string[];
  readonly warn?: (message: string) => void;
  /** When set, coverage scalar gate uses this floor instead of the 0.95 default. */
  readonly minimumCoverage?: number;
  /** Fail loud when manifest.json is absent (cache-only / warm-substrate runs). */
  readonly requireManifest?: boolean;
}

export function preflightExtractionCache(input: ExtractionCachePreflightInput): void {
  const manifest = input.manifest ?? readExtractionCacheManifest(input.cacheRoot);
  const warn = input.warn ?? ((message: string) => process.stderr.write(`${message}\n`));
  const liveExtractionPossible = input.liveExtractionPossible ?? input.config.apiKey !== null;
  const minimumCoverage = input.minimumCoverage ?? EXTRACTION_CACHE_COVERAGE_THRESHOLD;
  if (manifest === undefined) {
    handleMissingManifest(input.cacheRoot, input.requireManifest === true, warn);
    return;
  }
  assertExtractionConfigDrift(input.config.model, input.systemPrompt, manifest);
  if (input.requiredTurnContents !== undefined) {
    assertWindowContainment({
      cacheRoot: input.cacheRoot,
      model: input.config.model,
      systemPrompt: input.systemPrompt,
      requiredTurnContents: input.requiredTurnContents,
      allowLiveExtraction: input.allowLiveExtraction,
      liveExtractionPossible
    });
    return;
  }
  assertCoverageScalar(
    manifest.coverage,
    input.allowLiveExtraction === true,
    liveExtractionPossible,
    minimumCoverage
  );
}

function handleMissingManifest(
  cacheRoot: string,
  requireManifest: boolean,
  warn: (message: string) => void
): void {
  if (requireManifest) {
    throw new Error(
      "[longmemeval preflight] extraction-cache manifest is missing at " +
        `${cacheRoot}. Restore or populate the cache before a cache-only ` +
        "bench run, or set ALAYA_BENCH_REQUIRE_EXTRACTION_CACHE_MANIFEST=0 " +
        "for an explicit first-fill/live extraction run."
    );
  }
  warn(
    "[longmemeval preflight] no extraction-cache manifest at " +
      `${cacheRoot}; treating as first-ever build. The cache cannot be validated ` +
      "and a credentialled run will live-extract every turn. After this run, " +
      "build/commit the cache manifest so later runs fail loud on drift."
  );
}

function assertExtractionConfigDrift(
  model: string,
  systemPrompt: string,
  manifest: ExtractionCacheManifest
): void {
  if (model !== manifest.extraction_model) {
    throw new Error(
      "[longmemeval preflight] extraction model mismatch: resolved model " +
        `"${model}" != cache manifest extraction_model ` +
        `"${manifest.extraction_model}". The cache would miss every key and ` +
        "this run would be a full live extraction (~466h). Set " +
        `${GARDEN_MODEL_ENV}=${manifest.extraction_model} in the bench ` +
        "environment or rebuild the " +
        "cache for the new model."
    );
  }
  const systemPromptSha256 = computeSystemPromptSha256(systemPrompt);
  if (systemPromptSha256 !== manifest.system_prompt_sha256) {
    throw new Error(
      "[longmemeval preflight] system prompt drift: sha256(systemPrompt) " +
        `"${systemPromptSha256}" != cache manifest system_prompt_sha256 ` +
        `"${manifest.system_prompt_sha256}". A prompt change invalidates ` +
        "every cache key, so this run would re-extract the entire dataset " +
        "live (~466h). Rebuild the cache for the new prompt or revert the " +
        "prompt change."
    );
  }
}

// Window-containment gate. When the caller hands the actual run window's
// distinct turns, validate THIS run's window directly against on-disk
// fixtures instead of trusting the manifest's coverage scalar. The scalar is
// denominated against whatever window the last extraction-fill recorded
// (extraction-fill.ts coverage = (requested - failures)/requested over that
// fill's --limit/--offset window), so a staged 100Q fill writing coverage=1.0
// would otherwise let a 500Q run pass preflight and silently live-extract the
// unfilled 400. Containment closes that sub-channel by asserting every turn
// this run needs has a fixture, regardless of the scalar.
function assertWindowContainment(input: {
  readonly cacheRoot: string;
  readonly model: string;
  readonly systemPrompt: string;
  readonly requiredTurnContents: readonly string[];
  readonly allowLiveExtraction?: boolean;
  readonly liveExtractionPossible: boolean;
}): void {
  const missing = countMissingTurnFixtures(
    input.cacheRoot,
    input.model,
    input.systemPrompt,
    input.requiredTurnContents
  );
  if (
    missing > 0 &&
    input.allowLiveExtraction !== true &&
    input.liveExtractionPossible
  ) {
    const total = input.requiredTurnContents.length;
    throw new Error(
      "[longmemeval preflight] extraction cache covers only part of this " +
        `run's question window: ${missing} of ${total} distinct turns have ` +
        "no fixture, so this run would live-extract the gap. The cache " +
        "manifest's coverage scalar is relative to the window the last " +
        "extraction-fill recorded, not this run's window. Run extraction-fill " +
        "for the FULL --limit/--offset window of this run, or pass " +
        "--allow-live-extraction to live-extract the gap on purpose."
    );
  }
}

function assertCoverageScalar(
  coverage: number | undefined,
  allowLiveExtraction: boolean,
  liveExtractionPossible: boolean,
  minimumCoverage: number
): void {
  // A manifest WITHOUT a coverage field is itself a gap: a provenance-only
  // manifest (built before any fill recorded a denominator) cannot prove the
  // cache covers the dataset, so treating "coverage absent" as "coverage ok"
  // would silently re-open the 466h live-run hole the guard exists to close.
  // extraction-fill now always writes coverage, so a coverage-less manifest
  // means the cache was never filled against a known denominator. Require the
  // same explicit opt-in a low-coverage manifest requires.
  if (coverage === undefined) {
    if (!allowLiveExtraction && liveExtractionPossible) {
      throw new Error(
        "[longmemeval preflight] extraction cache manifest has no coverage " +
          "field; the cache was never filled against a known dataset " +
          "denominator, so this run could live-extract an unknown gap. Run " +
          "extraction-fill (which writes coverage) to populate the cache, or " +
          "pass --allow-live-extraction to live-extract on purpose."
      );
    }
    return;
  }
  if (
    coverage < minimumCoverage &&
    !allowLiveExtraction &&
    liveExtractionPossible
  ) {
    const coveragePct = (coverage * 100).toFixed(1);
    throw new Error(
      "[longmemeval preflight] extraction cache coverage " +
        `${coveragePct}% is below the ${(minimumCoverage * 100).toFixed(0)}% threshold; this run would live-extract the uncovered ` +
        "gap. Run extraction-fill to populate the cache, or pass " +
        "--allow-live-extraction to live-extract the gap on purpose."
    );
  }
}

/**
 * Count, of `turnContents`, how many have NO fixture on disk under `cacheRoot`.
 * Each turn's cache key is the same sha256(model\0systemPrompt\0turnContent)
 * the caching extractor writes, so a present fixture proves a cache hit and a
 * missing one proves a live extraction would be needed. Pure file stats, no
 * LLM. cross-file: createCachingSignalExtractor (the writer of these fixtures).
 */
function countMissingTurnFixtures(
  cacheRoot: string,
  model: string,
  systemPrompt: string,
  turnContents: readonly string[]
): number {
  let missing = 0;
  for (const turnContent of turnContents) {
    const cacheKey = computeCacheKey(model, systemPrompt, turnContent);
    if (!existsSync(cacheFilePath(cacheRoot, cacheKey))) {
      missing += 1;
    }
  }
  return missing;
}
