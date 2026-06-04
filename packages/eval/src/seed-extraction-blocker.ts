// @anchor seed-extraction-release-blocker
// Shared judgment for whether a KPI payload's seed-extraction provenance is
// degraded enough to disqualify the archive from release-grade surfaces
// (latest_passing and bench-runner CLI exit). The release-gate path and the
// bench-runner CLI both call this so a degraded archive cannot reach
// latest_passing by skipping the bench-runner exit (e.g. programmatic
// consumer, future automation, Inspector).
// cross-file: apps/bench-runner/src/longmemeval/seed-extraction-release-blocker.ts
//   wraps this judgment with bench-runner-specific report/finding rendering.
import type { KpiPayload, SeedExtractionPath } from "./kpi-schema.js";

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
  if (path === undefined) {
    if (isLongMemEvalBenchName(payload.bench_name)) {
      return {
        id: "seed_extraction_path missing_on_longmemeval",
        detail:
          "LongMemEval archive carries no seed_extraction_path provenance, " +
          "so seeding integrity cannot be verified. Treated as degraded; " +
          "this archive is blocked from release-grade surfaces."
      };
    }
    return null;
  }
  if (path.path === "no_credentials_fallback") {
    return {
      id: "seed_extraction_path no_credentials_fallback",
      detail:
        "LongMemEval evidence used degraded no-credential full-turn seeding " +
        `(${formatSeedExtractionCounters(path)}), so this archive is blocked ` +
        "even if numeric KPI gates pass."
    };
  }
  // invariant: live_extraction_failures is checked BEFORE offline_fallbacks
  // because every live-extraction failure also bumps offline_fallbacks (via
  // recordExtractionFailureSource in compile-seed.ts). Reporting the more
  // specific blocker id makes the dump consumer see the live-call layer
  // directly without re-deriving it from the dual counter. A future
  // transport that recovers a live failure without falling back to offline
  // (e.g. a more aggressive retry budget) would still set
  // live_extraction_failures = 0, so this check stays correct.
  // cross-file: apps/bench-runner/src/longmemeval/compile-seed.ts
  //   recordExtractionFailureSource owns the increment site.
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

export function hasSeedExtractionReleaseBlocker(payload: KpiPayload): boolean {
  return evaluateSeedExtractionReleaseBlocker(payload) !== null;
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
    `path=${path.path} cache_hits=${path.cache_hits} ` +
    `llm_calls=${path.llm_calls} offline_fallbacks=${path.offline_fallbacks} ` +
    `live_failures=${path.live_extraction_failures} ` +
    `cached_failures=${path.cached_extraction_failures} ` +
    `facts=${path.facts_produced} signals_dropped=${path.signals_dropped}`
  );
}
