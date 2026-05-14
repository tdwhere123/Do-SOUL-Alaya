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
      fixture_regressions: []
    };
  }

  const deltas: KpiDelta[] = [];

  pushRatioDelta(
    deltas,
    "r_at_5",
    current.kpi.r_at_5,
    previous.kpi.r_at_5,
    thresholds.r_at_5_drop_pp
  );
  pushRatioDelta(
    deltas,
    "r_at_10",
    current.kpi.r_at_10,
    previous.kpi.r_at_10,
    thresholds.r_at_10_drop_pp
  );
  pushRatioDelta(
    deltas,
    "token_saved_ratio_vs_full_prompt",
    current.kpi.token_saved_ratio_vs_full_prompt,
    previous.kpi.token_saved_ratio_vs_full_prompt,
    thresholds.token_saved_drop_pp
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
    verdict: latencyVerdict.verdict,
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
    verdict: hotShareVerdict.verdict,
    direction: "drop_bad"
  });

  const fixtureRegressions = diffFixtures(current, previous);
  const worst = rollupWorstVerdict([
    ...deltas.map((d) => d.verdict),
    fixtureRegressions.length > 0 ? "fail" : "ok"
  ]);

  return {
    deltas,
    worst_verdict: worst,
    fixture_regressions: fixtureRegressions
  };
}

function pushRatioDelta(
  acc: KpiDelta[],
  key: string,
  current: number,
  previous: number,
  band: { readonly warn: number; readonly fail: number }
): void {
  const classified = classifyRatioDrop(current, previous, band);
  acc.push({
    key,
    current,
    previous,
    delta: current - previous,
    verdict: classified.verdict,
    direction: "drop_bad"
  });
}

function diffFixtures(current: KpiPayload, previous: KpiPayload): string[] {
  if (current.split !== "golden") return [];
  const previousById = new Map<string, PerScenarioRow>();
  for (const row of previous.kpi.per_scenario) {
    previousById.set(row.id, row);
  }
  const regressions: string[] = [];
  for (const row of current.kpi.per_scenario) {
    const prev = previousById.get(row.id);
    if (prev === undefined) continue;
    if (prev.version !== row.version) continue;
    if (prev.hit_at_5 && !row.hit_at_5) {
      regressions.push(row.id);
    }
  }
  return regressions;
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
