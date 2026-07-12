import type { QualityMetrics } from "@do-soul/alaya-eval";

type MeasurementCohortCounts = NonNullable<
  QualityMetrics["measurement_cohort_counts"]
>;

export interface MeasurementAccountingState {
  readonly cohorts: MeasurementCohortCounts;
  readonly reasons: Record<string, number>;
  metricCount: number;
  accountingCount: number;
}

export function createMeasurementAccountingState(): MeasurementAccountingState {
  return {
    cohorts: {
      evaluated: 0,
      non_abstention: 0,
      abstention: 0,
      scorable_answerable: 0,
      unscorable_answerable: 0,
      hit_at_5: 0,
      miss_at_5: 0
    },
    reasons: {},
    metricCount: 0,
    accountingCount: 0
  };
}

export function accumulateMeasurementAccounting(
  state: MeasurementAccountingState,
  metric: QualityMetrics
): void {
  state.metricCount += 1;
  const cohorts = metric.measurement_cohort_counts;
  const reasons = metric.unscorable_reason_distribution;
  if ((cohorts === undefined) !== (reasons === undefined)) {
    throw new Error("merge refused: measurement accounting fields must be paired");
  }
  if (cohorts === undefined || reasons === undefined) return;
  state.accountingCount += 1;
  addCounts(state.cohorts, cohorts);
  for (const [reason, count] of Object.entries(reasons)) {
    state.reasons[reason] = (state.reasons[reason] ?? 0) + count;
  }
}

export function buildMeasurementAccounting(
  state: MeasurementAccountingState
): Partial<
  Pick<
    QualityMetrics,
    "measurement_cohort_counts" | "unscorable_reason_distribution"
  >
> {
  if (state.accountingCount === 0) return {};
  if (state.accountingCount !== state.metricCount) {
    throw new Error("merge refused: measurement accounting missing from one or more shards");
  }
  return {
    measurement_cohort_counts: state.cohorts,
    unscorable_reason_distribution: state.reasons
  };
}

function addCounts(
  target: MeasurementCohortCounts,
  source: MeasurementCohortCounts
): void {
  for (const key of Object.keys(target) as (keyof MeasurementCohortCounts)[]) {
    target[key] += source[key];
  }
}
