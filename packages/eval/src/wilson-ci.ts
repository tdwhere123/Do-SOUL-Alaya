// Wilson score interval for a binomial proportion. Returns the half-width
// in percentage points at 95% confidence. The Wilson interval is preferred
// over the normal (Wald) approximation for small samples and proportions
// near 0 or 1 because it does not over-extend below 0 or above 1.
// see also: packages/eval/src/diff.ts. Ratio diff uses this to gate
// regression verdicts on small-N runs.

export const WILSON_Z_95 = 1.96;

export function wilsonInterval(
  successes: number,
  total: number,
  z: number = WILSON_Z_95
): { readonly lo: number; readonly hi: number; readonly center: number } {
  if (total <= 0) {
    return { lo: 0, hi: 0, center: 0 };
  }
  const phat = successes / total;
  const z2 = z * z;
  const denominator = 1 + z2 / total;
  const center = (phat + z2 / (2 * total)) / denominator;
  const margin =
    (z * Math.sqrt((phat * (1 - phat) + z2 / (4 * total)) / total)) /
    denominator;
  return {
    lo: Math.max(0, center - margin),
    hi: Math.min(1, center + margin),
    center
  };
}

export function wilsonHalfWidthPp(
  successes: number,
  total: number,
  z: number = WILSON_Z_95
): number {
  if (total <= 0) {
    return 0;
  }
  const interval = wilsonInterval(successes, total, z);
  return ((interval.hi - interval.lo) / 2) * 100;
}

// Derive a CI-aware regression threshold in percentage points. For
// evaluated_count >= 100 the raw bands (e.g. 2pp warn / 5pp fail) are
// returned. For small samples the band widens to max(raw, ci_half_width)
// so a noise-level delta does not trip a regression alarm.
//
// Asymmetry note: the caller (packages/eval/src/diff.ts) drives the
// band from the *current* run's evaluated_count and observed
// proportion only. When the previous baseline is also undersampled,
// the previous run's wider CI is not blended into the current band;
// the regression verdict reflects today's confidence in today's
// number, not a joint confidence with stale baseline noise. This is
// intentional and matches the report.md narrative ("the current run
// at sample size N delivers proportion p; verdict against the
// previous archive holds within ±CI/2").
export function ciAwareBand(
  rawBand: { readonly warn: number; readonly fail: number },
  successes: number,
  total: number,
  z: number = WILSON_Z_95
): { readonly warn: number; readonly fail: number } {
  if (total >= 100) {
    return rawBand;
  }
  const halfWidthPp = wilsonHalfWidthPp(successes, total, z);
  return {
    warn: Math.max(rawBand.warn, halfWidthPp),
    fail: Math.max(rawBand.fail, halfWidthPp)
  };
}

// Sample-size label used in report.md and release notes to communicate
// statistical confidence at a glance.
//
// invariant: the cascade is size-driven; `worst_shard_bound` latency
// always pins the label to `shard_merged` regardless of evaluatedCount
// because the latency channel is the upper-bound of N shards, not the
// real run-wide percentile.
//
// Thresholds:
//   smoke: evaluatedCount <= 50 (tripwire; not a quality claim)
//   staged: 51 <= evaluatedCount <= 200 (staged confidence; mid-run sanity)
//   shard_merged: 201 <= evaluatedCount <= 499 OR latency_source = worst_shard_bound
//                  (cross-shard merge; latency is upper bound)
//   full: evaluatedCount >= 500 (full dataset; release-grade)
export type SampleSizeLabel = "smoke" | "staged" | "shard_merged" | "full";

export const SAMPLE_SIZE_LABEL_THRESHOLDS = Object.freeze({
  smoke_max: 50,
  staged_max: 200,
  shard_merged_max: 499,
  full_min: 500
});

export function deriveSampleSizeLabel(
  evaluatedCount: number,
  latencySource: "exact" | "worst_shard_bound"
): SampleSizeLabel {
  if (latencySource === "worst_shard_bound") {
    return "shard_merged";
  }
  if (evaluatedCount <= SAMPLE_SIZE_LABEL_THRESHOLDS.smoke_max) {
    return "smoke";
  }
  if (evaluatedCount <= SAMPLE_SIZE_LABEL_THRESHOLDS.staged_max) {
    return "staged";
  }
  if (evaluatedCount <= SAMPLE_SIZE_LABEL_THRESHOLDS.shard_merged_max) {
    return "shard_merged";
  }
  return "full";
}
