import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveSecretRef } from "@do-soul/alaya";
import {
  type ExtractionCacheManifest
} from "./extraction-cache-manifest.js";
import type {
  CompileSeedExtractionConfig,
  CompileSeedExtractionStats,
  SeedExtractionPathKpi
} from "./compile-seed-types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// The cache fixture lives beside the pinned dataset metadata under
// docs/bench-history/datasets so that, once a credentialled run has
// populated it, it can be committed and shared — the same repeatable-
// fixture discipline used by the pinned dataset meta. The directory is
// created lazily on the first credentialled run; it is empty (absent)
// until then.
// ALAYA_BENCH_EXTRACTION_CACHE_ROOT redirects the cache to a gitignored staging dir so a model
// switch (e.g. deepseek re-seed) does not pollute the git-tracked baseline fixture. Unset → canonical.
export const EXTRACTION_CACHE_ROOT = process.env.ALAYA_BENCH_EXTRACTION_CACHE_ROOT
  ? resolve(process.env.ALAYA_BENCH_EXTRACTION_CACHE_ROOT)
  : resolve(__dirname, "../../../../docs/bench-history/datasets/longmemeval-extraction-cache");

const GARDEN_SECRET_REF_ENV = "ALAYA_OFFICIAL_GARDEN_SECRET_REF";
const GARDEN_MODEL_ENV = "OFFICIAL_API_GARDEN_MODEL";
const GARDEN_PROVIDER_URL_ENV = "OFFICIAL_API_GARDEN_PROVIDER_URL";
const ALLOW_LIVE_EXTRACTION_ENV = "ALAYA_BENCH_ALLOW_LIVE_EXTRACTION";
const DEFAULT_GARDEN_PROVIDER_URL = "https://yunwu.ai/v1";

/**
 * Single source for the operator opt-in that relaxes the run-start coverage
 * gate so a run may deliberately live-extract the uncovered cache gap. Shared
 * by the three LongMemEval entrypoints so the flag is resolved one way.
 * Truthy values: "1" / "true" (case-insensitive).
 */
export function resolveBenchAllowLiveExtraction(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  const value = env[ALLOW_LIVE_EXTRACTION_ENV];
  if (value === undefined) {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true";
}

export function toSeedExtractionPathKpi(
  stats: CompileSeedExtractionStats
): SeedExtractionPathKpi {
  return {
    path: stats.path,
    cache_hits: stats.cacheHits,
    llm_calls: stats.llmCalls,
    offline_fallbacks: stats.offlineFallbacks,
    live_extraction_failures: stats.liveExtractionFailures,
    cached_extraction_failures: stats.cachedExtractionFailures,
    facts_produced: stats.factsProduced,
    signals_dropped: stats.signalsDropped,
    parse_dropped: stats.parseDropped,
    compile_overflow_dropped: stats.compileOverflowDropped,
    signals_dropped_by_reason: {
      candidate_absent: stats.signalsDroppedByReason.candidate_absent,
      materialization_drop: stats.signalsDroppedByReason.materialization_drop
    }
  };
}

/**
 * Resolve garden LLM configuration for the bench seed path. When the secret
 * ref is absent or unresolvable, `apiKey` is null and the seed path falls back
 * to the deterministic no-LLM path.
 *
 * Single-source extraction model — NO silent production-constant fallback.
 * The model is resolved from ONE of, in order:
 *   1. env `OFFICIAL_API_GARDEN_MODEL` (operator override at run time)
 *   2. the cache's own `manifest.extraction_model` (the cache self-describes
 *      what it was built with)
 * If neither is present, this THROWS. The old behaviour silently fell back to
 * the compile-time production constant `gpt-4.1-mini`; when the cache was
 * built with a different model that fallback produced a 100% cache miss that
 * looked like a slow run (466h live extraction) rather than an error. The
 * same resolved `model` value is what the cache-key hash component consumes
 * (createCachingSignalExtractor -> computeCacheKey), so the provider config
 * and the cache key can never independently re-derive a disagreeing model.
 *
 * cross-file: apps/bench-runner/src/longmemeval/extraction-cache-manifest.ts
 */
export function resolveCompileSeedExtractionConfig(
  env: NodeJS.ProcessEnv = process.env,
  manifest?: ExtractionCacheManifest | undefined
): CompileSeedExtractionConfig {
  const providerUrl = normalizeBaseUrl(
    readNonEmpty(env[GARDEN_PROVIDER_URL_ENV]) ??
      manifest?.provider_url ??
      DEFAULT_GARDEN_PROVIDER_URL
  );
  const model =
    readNonEmpty(env[GARDEN_MODEL_ENV]) ?? manifest?.extraction_model;
  if (model === undefined || model.trim().length === 0) {
    throw new Error(
      "bench extraction model is unresolved: neither env " +
        `${GARDEN_MODEL_ENV} is set nor does the extraction cache manifest ` +
        "declare extraction_model. Export the extraction model env var " +
        "in the bench environment or build the " +
        "cache manifest first. Refusing to fall back to a default model — a " +
        "wrong default silently misses every cache key and degrades to a " +
        "full live extraction."
    );
  }
  const secretRef = readNonEmpty(env[GARDEN_SECRET_REF_ENV]);
  if (secretRef === undefined) {
    return { providerUrl, model, apiKey: null };
  }
  const resolved = resolveSecretRef(secretRef);
  if ("value" in resolved) {
    return { providerUrl, model, apiKey: resolved.value };
  }
  return { providerUrl, model, apiKey: null };
}

function normalizeBaseUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/u, "");
  return trimmed.endsWith("/chat/completions")
    ? trimmed.slice(0, -"/chat/completions".length)
    : trimmed;
}

function readNonEmpty(value: string | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}
