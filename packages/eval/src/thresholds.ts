import type { KpiCore, Verdict } from "./kpi-schema.js";

export interface RatioBand {
  readonly warn: number;
  readonly fail: number;
}

export interface RatioGrowthBand {
  readonly warn: number;
  readonly fail: number;
}

export interface ThresholdConfig {
  readonly r_at_5_drop_pp: RatioBand;
  readonly r_at_10_drop_pp: RatioBand;
  readonly latency_p95_growth_ratio: RatioGrowthBand;
  readonly token_saved_drop_pp: RatioBand;
  readonly hot_share_drop_pp: RatioBand;
}

export const DEFAULT_THRESHOLDS: ThresholdConfig = Object.freeze({
  r_at_5_drop_pp: { warn: 2.0, fail: 5.0 },
  r_at_10_drop_pp: { warn: 2.0, fail: 5.0 },
  latency_p95_growth_ratio: { warn: 0.2, fail: 0.5 },
  token_saved_drop_pp: { warn: 2.0, fail: 5.0 },
  hot_share_drop_pp: { warn: 5.0, fail: 10.0 }
});

export interface KpiDelta {
  readonly key: string;
  readonly current: number;
  readonly previous: number;
  readonly delta: number;
  readonly verdict: Verdict;
  readonly direction: "drop_bad" | "growth_bad";
}

export interface KpiDiffResult {
  readonly deltas: readonly KpiDelta[];
  readonly worst_verdict: Verdict;
  readonly fixture_regressions: readonly string[];
}

export function classifyRatioDrop(
  current: number,
  previous: number,
  band: RatioBand
): { verdict: Verdict; deltaPp: number } {
  const deltaPp = (previous - current) * 100;
  if (deltaPp >= band.fail) return { verdict: "fail", deltaPp };
  if (deltaPp >= band.warn) return { verdict: "warn", deltaPp };
  return { verdict: "ok", deltaPp };
}

export function classifyLatencyGrowth(
  current: number,
  previous: number,
  band: RatioGrowthBand
): { verdict: Verdict; growthRatio: number } {
  if (previous <= 0) return { verdict: "ok", growthRatio: 0 };
  const growthRatio = (current - previous) / previous;
  if (growthRatio >= band.fail) return { verdict: "fail", growthRatio };
  if (growthRatio >= band.warn) return { verdict: "warn", growthRatio };
  return { verdict: "ok", growthRatio };
}

export function classifyHotShareDrop(
  currentDist: KpiCore["tier_distribution"],
  previousDist: KpiCore["tier_distribution"],
  band: RatioBand
): { verdict: Verdict; deltaPp: number } {
  const currentShare = shareOfHot(currentDist);
  const previousShare = shareOfHot(previousDist);
  return classifyRatioDrop(currentShare, previousShare, band);
}

function shareOfHot(d: KpiCore["tier_distribution"]): number {
  const total = d.hot + d.warm + d.cold;
  return total === 0 ? 0 : d.hot / total;
}

export function rollupWorstVerdict(verdicts: ReadonlyArray<Verdict>): Verdict {
  if (verdicts.includes("fail")) return "fail";
  if (verdicts.includes("warn")) return "warn";
  return "ok";
}
