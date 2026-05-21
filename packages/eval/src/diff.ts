import type { KpiPayload, PerScenarioRow, Verdict } from "./kpi-schema.js";
import {
  DEFAULT_THRESHOLDS,
  classifyHotShareDrop,
  classifyLatencyGrowth,
  classifyRatioDrop,
  rollupWorstVerdict,
  type KpiDelta,
  type KpiDiffResult,
  type RatioBand,
  type ThresholdConfig
} from "./thresholds.js";
import { ciAwareBand } from "./wilson-ci.js";

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

  // @anchor sample-too-small: see thresholds.min_sample_for_ratio_diff.
  // Whenever either side of the diff has evaluated_count below the
  // guard, ratio-based + latency + tier-share aggregates are variance
  // noise (e.g. smoke 1-shard vs full 2-shard latency, or current=smoke
  // vs previous=full giving spurious deltas). Downgrade FAIL to WARN
  // universally. Fixture flips remain FAIL; pass/fail per row is not
  // sample-size sensitive.
  const undersampled =
    Math.min(previous.evaluated_count, current.evaluated_count) <
    thresholds.min_sample_for_ratio_diff;
  const downgradeFail = (v: Verdict): Verdict =>
    undersampled && v === "fail" ? "warn" : v;

  const deltas: KpiDelta[] = [];

  // invariant: ratio-KPI regression thresholds widen to the 95% Wilson CI
  // half-width when evaluated_count < 100. A noise-level delta no longer
  // trips a fail/warn alarm on small-N runs, while N >= 100 keeps the raw
  // 2pp warn / 5pp fail floor.
  pushRatioDelta(
    deltas,
    "r_at_5",
    current.kpi.r_at_5,
    previous.kpi.r_at_5,
    ciAwareBand(
      thresholds.r_at_5_drop_pp,
      Math.round(current.kpi.r_at_5 * current.evaluated_count),
      current.evaluated_count
    ),
    downgradeFail
  );
  pushRatioDelta(
    deltas,
    "r_at_10",
    current.kpi.r_at_10,
    previous.kpi.r_at_10,
    ciAwareBand(
      thresholds.r_at_10_drop_pp,
      Math.round(current.kpi.r_at_10 * current.evaluated_count),
      current.evaluated_count
    ),
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

  // @anchor token-economy-diff: secondary token-economy signal. The ratio
  // above is the headline; this surfaces a swelling per-recall payload even
  // when the ratio happens to stay flat (e.g. raw history grew in step).
  // Gated on BOTH sides carrying the event-sourced token_economy block so a
  // pre-S6 baseline never produces a spurious delta. Reuses the latency
  // growth classifier — a bigger recalled-context mean is "growth_bad".
  const currentEconomy = current.kpi.token_economy;
  const previousEconomy = previous.kpi.token_economy;
  if (currentEconomy !== undefined && previousEconomy !== undefined) {
    const meanVerdict = classifyLatencyGrowth(
      currentEconomy.recalled_context_tokens_mean,
      previousEconomy.recalled_context_tokens_mean,
      thresholds.latency_p95_growth_ratio
    );
    deltas.push({
      key: "token_economy.recalled_context_tokens_mean",
      current: currentEconomy.recalled_context_tokens_mean,
      previous: previousEconomy.recalled_context_tokens_mean,
      delta:
        currentEconomy.recalled_context_tokens_mean -
        previousEconomy.recalled_context_tokens_mean,
      verdict: downgradeFail(meanVerdict.verdict),
      direction: "growth_bad"
    });
  }

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

  if (shouldDiffHotShare(current)) {
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
  }

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
  band: RatioBand,
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

function shouldDiffHotShare(current: KpiPayload): boolean {
  return !(current.bench_name === "public" && current.split.startsWith("longmemeval-"));
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
