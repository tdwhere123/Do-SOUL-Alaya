// @anchor seed-extraction-release-blocker
// Shared judgment for whether a KPI payload's seed-extraction provenance is
// degraded enough to disqualify the archive from release-grade surfaces
// (latest_passing and bench-runner CLI exit). The release-gate path and the
// bench-runner CLI both call this so a degraded archive cannot reach
// latest_passing by skipping the bench-runner exit (e.g. programmatic
// consumer, future automation, Inspector).
// cross-file: apps/bench-runner/src/longmemeval/seed-extraction-release-blocker.ts
//   wraps this judgment with bench-runner-specific report/finding rendering.
import type { KpiPayload, SeedExtractionPath } from "../schema/kpi-schema.js";

export interface SeedExtractionReleaseBlocker {
  readonly id: string;
  readonly detail: string;
}

/**
 * Returns a blocker record when the payload's seed-extraction provenance is
 * degraded; returns null when the archive is releasable on this dimension.
 *
 * Evaluation conditions:
 *   - If `seed_extraction_path` is present, evaluate the path regardless of
 *     bench name. This invariantly catches future benches (LoCoMo etc.) that
 *     gain compile-seed provenance.
 *   - If `seed_extraction_path` is missing AND the bench is in the LongMemEval
 *     family, treat as degraded (defensive default — better to block than
 *     silently pass an archive whose seeding provenance is unknown).
 *   - If `seed_extraction_path` is missing on a non-LongMemEval bench, keep
 *     backward compatibility (no block — older payloads predate the field).
 */
export function evaluateSeedExtractionReleaseBlocker(
  payload: KpiPayload
): SeedExtractionReleaseBlocker | null {
  const path = payload.kpi.seed_extraction_path;
  if (path === undefined) return missingPathBlocker(payload.bench_name);
  return seedExtractionPathBlocker(path);
}

function missingPathBlocker(
  benchName: KpiPayload["bench_name"]
): SeedExtractionReleaseBlocker | null {
  if (!isLongMemEvalBenchName(benchName)) return null;
  return {
    id: "seed_extraction_path missing_on_longmemeval",
    detail:
      "LongMemEval archive carries no seed_extraction_path provenance, " +
      "so seeding integrity cannot be verified. Treated as degraded; " +
      "this archive is blocked from release-grade surfaces."
  };
}

function seedExtractionPathBlocker(
  path: SeedExtractionPath
): SeedExtractionReleaseBlocker | null {
  if (path.path === "no_credentials_fallback") {
    return {
      id: "seed_extraction_path no_credentials_fallback",
      detail:
        "LongMemEval evidence used degraded no-credential full-turn seeding " +
        `(${formatSeedExtractionCounters(path)}), so this archive is blocked ` +
        "even if numeric KPI gates pass."
    };
  }
  return cacheOnlyCounterBlocker(path);
}

function cacheOnlyCounterBlocker(
  path: SeedExtractionPath
): SeedExtractionReleaseBlocker | null {
  return cacheExecutionBlocker(path) ?? cacheContentBlocker(path);
}

function cacheExecutionBlocker(
  path: SeedExtractionPath
): SeedExtractionReleaseBlocker | null {
  if (path.llm_calls > 0) {
    return {
      id: "seed_extraction_path live_extraction_calls",
      detail:
        "LongMemEval release evidence must be cache-only, but official seed " +
        `extraction made live LLM calls (${formatSeedExtractionCounters(path)}).`
    };
  }
  if (path.live_extraction_failures > 0) {
    return {
      id: "seed_extraction_path live_extraction_failures",
      detail:
        "LongMemEval official seed extraction had live-call failures that " +
        "exhausted the retry budget and demoted the turn to the full-turn " +
        `fallback path (${formatSeedExtractionCounters(path)}); this archive ` +
        "is blocked because the run is no longer a faithful official_api_compile " +
        "evidence set."
    };
  }
  if (path.cached_extraction_failures > 0) {
    return {
      id: "seed_extraction_path cached_extraction_failures",
      detail:
        "LongMemEval cached seed extraction contained invalid responses " +
        `(${formatSeedExtractionCounters(path)}), so cache-only provenance ` +
        "is incomplete and the archive is blocked."
    };
  }
  if (path.offline_fallbacks > 0) {
    return {
      id: "seed_extraction_path offline_fallbacks",
      detail:
        "LongMemEval official seed extraction fell back to offline extraction " +
        `(${formatSeedExtractionCounters(path)}), so this archive is blocked ` +
      "until official extraction is fully provider-backed."
    };
  }
  return null;
}

function cacheContentBlocker(
  path: SeedExtractionPath
): SeedExtractionReleaseBlocker | null {
  if (path.extraction_attempts === undefined || path.extraction_attempts === 0) {
    return {
      id: "seed_extraction_path missing_extraction_attempts",
      detail:
        "LongMemEval release evidence has no non-empty seed extraction attempts, " +
        `so cache-only execution cannot be proven (${formatSeedExtractionCounters(path)}).`
    };
  }
  if (path.cache_hits !== path.extraction_attempts) {
    return {
      id: "seed_extraction_path cache_hit_conservation",
      detail:
        "LongMemEval cache-only evidence must serve every extraction attempt " +
        `from cache (${formatSeedExtractionCounters(path)}).`
    };
  }
  if (path.facts_produced === 0) {
    return {
      id: "seed_extraction_path no_facts_produced",
      detail:
        "LongMemEval release evidence produced no seed facts from its cached " +
        `extractions (${formatSeedExtractionCounters(path)}).`
    };
  }
  const accountedDrops = path.parse_dropped + path.compile_overflow_dropped +
    path.signals_dropped_by_reason.candidate_absent +
    path.signals_dropped_by_reason.materialization_drop;
  if (accountedDrops !== path.signals_dropped) {
    return {
      id: "seed_extraction_path drop_accounting_mismatch",
      detail:
        "LongMemEval seed drop stages do not conserve the reported total " +
        `(${formatSeedExtractionCounters(path)}).`
    };
  }
  return null;
}

export function hasSeedExtractionReleaseBlocker(payload: KpiPayload): boolean {
  return evaluateSeedExtractionReleaseBlocker(payload) !== null;
}

export function isCacheOnlySeedExtractionPath(
  path: SeedExtractionPath | undefined
): boolean {
  return path !== undefined && seedExtractionPathBlocker(path) === null;
}

export function isLongMemEvalBenchName(
  benchName: KpiPayload["bench_name"]
): boolean {
  return (
    benchName === "public" ||
    benchName === "public-multiturn" ||
    benchName === "public-crossquestion"
  );
}

export function formatSeedExtractionCounters(
  path: SeedExtractionPath
): string {
  return (
    `path=${path.path} extraction_attempts=${path.extraction_attempts ?? "missing"} ` +
    `cache_hits=${path.cache_hits} ` +
    `llm_calls=${path.llm_calls} offline_fallbacks=${path.offline_fallbacks} ` +
    `live_failures=${path.live_extraction_failures} ` +
    `cached_failures=${path.cached_extraction_failures} ` +
    `facts=${path.facts_produced} signals_dropped=${path.signals_dropped}`
  );
}
