import type { KpiPayload, PerScenarioRow, Verdict } from "./kpi-schema.js";
import {
  DEFAULT_THRESHOLDS,
  classifyHotShareDrop,
  classifyLatencyGrowth,
  classifyRatioDrop,
  rollupWorstVerdict,
  type KpiDelta,
  type KpiDiffResult,
  type ThresholdConfig
} from "./thresholds.js";

export function diffKpis(
  current: KpiPayload,
  previous: KpiPayload | null,
  thresholds: ThresholdConfig = DEFAULT_THRESHOLDS
): KpiDiffResult {
  if (previous === null) {
    return {
      deltas: [],
      worst_verdict: "ok",
      fixture_regressions: [],
      rebaselined_scenarios: [],
      new_scenarios: []
    };
  }

  // @anchor previous-sample-too-small — see thresholds.min_sample_for_ratio_diff.
  // When the previous baseline was a tiny smoke (n < min_sample) we cannot
  // distinguish "regression" from "sample-size variance" or harness-mode
  // drift (e.g. smoke was 1-shard sequential, full is 2-shard parallel, so
  // latency grows from disk/CPU contention not from a recall regression).
  // Downgrade FAIL verdicts to WARN universally (ratio-based + latency +
  // tier-share) so the alarm is informative without being false-positive.
  // Fixture flips are still scored as FAIL — those compare individual
  // pass/fail signals, not aggregates.
  const previousUndersampled =
    previous.evaluated_count < thresholds.min_sample_for_ratio_diff;
  const downgradeFail = (v: Verdict): Verdict =>
    previousUndersampled && v === "fail" ? "warn" : v;

  const deltas: KpiDelta[] = [];

  pushRatioDelta(
    deltas,
    "r_at_5",
    current.kpi.r_at_5,
    previous.kpi.r_at_5,
    thresholds.r_at_5_drop_pp,
    downgradeFail
  );
  pushRatioDelta(
    deltas,
    "r_at_10",
    current.kpi.r_at_10,
    previous.kpi.r_at_10,
    thresholds.r_at_10_drop_pp,
    downgradeFail
  );
  pushRatioDelta(
    deltas,
    "token_saved_ratio_vs_full_prompt",
    current.kpi.token_saved_ratio_vs_full_prompt,
    previous.kpi.token_saved_ratio_vs_full_prompt,
    thresholds.token_saved_drop_pp,
    downgradeFail
  );

  const latencyVerdict = classifyLatencyGrowth(
    current.kpi.latency_ms_p95,
    previous.kpi.latency_ms_p95,
    thresholds.latency_p95_growth_ratio
  );
  deltas.push({
    key: "latency_ms_p95",
    current: current.kpi.latency_ms_p95,
    previous: previous.kpi.latency_ms_p95,
    delta: current.kpi.latency_ms_p95 - previous.kpi.latency_ms_p95,
    verdict: downgradeFail(latencyVerdict.verdict),
    direction: "growth_bad"
  });

  const hotShareVerdict = classifyHotShareDrop(
    current.kpi.tier_distribution,
    previous.kpi.tier_distribution,
    thresholds.hot_share_drop_pp
  );
  deltas.push({
    key: "tier_distribution.hot_share",
    current: shareOfHot(current.kpi.tier_distribution),
    previous: shareOfHot(previous.kpi.tier_distribution),
    delta: -hotShareVerdict.deltaPp / 100,
    verdict: downgradeFail(hotShareVerdict.verdict),
    direction: "drop_bad"
  });

  const fixtureDiff = diffFixtures(current, previous);
  const worst = rollupWorstVerdict([
    ...deltas.map((d) => d.verdict),
    fixtureDiff.regressions.length > 0 ? "fail" : "ok"
  ]);

  return {
    deltas,
    worst_verdict: worst,
    fixture_regressions: fixtureDiff.regressions,
    rebaselined_scenarios: fixtureDiff.rebaselined,
    new_scenarios: fixtureDiff.new_scenarios
  };
}

function pushRatioDelta(
  acc: KpiDelta[],
  key: string,
  current: number,
  previous: number,
  band: { readonly warn: number; readonly fail: number },
  postClassify: (v: Verdict) => Verdict = (v) => v
): void {
  const classified = classifyRatioDrop(current, previous, band);
  acc.push({
    key,
    current,
    previous,
    delta: current - previous,
    verdict: postClassify(classified.verdict),
    direction: "drop_bad"
  });
}

interface FixtureDiff {
  readonly regressions: readonly string[];
  readonly rebaselined: readonly string[];
  readonly new_scenarios: readonly string[];
}

function diffFixtures(current: KpiPayload, previous: KpiPayload): FixtureDiff {
  if (current.split !== "golden") {
    return { regressions: [], rebaselined: [], new_scenarios: [] };
  }
  const previousById = new Map<string, PerScenarioRow>();
  for (const row of previous.kpi.per_scenario) {
    previousById.set(row.id, row);
  }
  const regressions: string[] = [];
  const rebaselined: string[] = [];
  const newScenarios: string[] = [];
  for (const row of current.kpi.per_scenario) {
    const prev = previousById.get(row.id);
    if (prev === undefined) {
      newScenarios.push(row.id);
      continue;
    }
    if (prev.version !== row.version) {
      rebaselined.push(row.id);
      continue;
    }
    if (prev.hit_at_5 && !row.hit_at_5) {
      regressions.push(row.id);
    }
  }
  return { regressions, rebaselined, new_scenarios: newScenarios };
}

function shareOfHot(d: KpiPayload["kpi"]["tier_distribution"]): number {
  const total = d.hot + d.warm + d.cold;
  return total === 0 ? 0 : d.hot / total;
}

export function verdictBadge(verdict: Verdict): string {
  if (verdict === "fail") return "✗";
  if (verdict === "warn") return "⚠";
  return "✓";
}
