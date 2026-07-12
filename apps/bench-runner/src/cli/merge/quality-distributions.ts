import type { QualityMetrics } from "@do-soul/alaya-eval";
import type { MergeQualityMetricsState } from "../merge-quality-state.js";

type MissTaxonomyKey = keyof QualityMetrics["miss_taxonomy_distribution"];

export function accumulateDistributions(
  state: MergeQualityMetricsState,
  metric: QualityMetrics
): void {
  for (const [key, entry] of Object.entries(metric.budget_drop_distribution)) {
    const existing = state.budgetCounts.get(key) ?? {
      count: 0,
      denominator: 0,
      share: 0
    };
    state.budgetCounts.set(key, {
      count: existing.count + entry.count,
      share: 0,
      denominator: existing.denominator + entry.denominator
    });
  }
  for (const [key, count] of Object.entries(metric.miss_distribution)) {
    state.missDistribution[key] = (state.missDistribution[key] ?? 0) + count;
  }
  for (const key of Object.keys(state.missTaxonomyDistribution) as MissTaxonomyKey[]) {
    state.missTaxonomyDistribution[key] += metric.miss_taxonomy_distribution[key];
  }
}
