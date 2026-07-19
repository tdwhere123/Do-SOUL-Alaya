import type { KpiPayload } from "@do-soul/alaya-eval";

export const LONGMEMEVAL_R2_ABSOLUTE_QUALITY_POLICY = Object.freeze({
  answerableCount: 94,
  minimumR5Hits: 85
} as const);

interface AbsoluteQualityPolicy {
  readonly expected_denominator: number;
  readonly minimum_hits: number;
}

export function assertLongMemEvalAbsoluteQuality(input: {
  readonly payload: KpiPayload;
  readonly policy: AbsoluteQualityPolicy;
  readonly label: string;
}): void {
  const rows = input.payload.kpi.per_scenario.filter(
    (row) => row.measurement_cohort === "answerable" && row.scorable === true
  );
  const hits = rows.filter((row) => row.hit_at_5).length;
  if (rows.length !== input.policy.expected_denominator ||
      input.payload.answerable_evaluated_count !== input.policy.expected_denominator ||
      input.payload.kpi.r_at_5 !== hits / input.policy.expected_denominator) {
    throw new Error(`${input.label} absolute R@5 evidence differs from its answerable rows`);
  }
  if (hits < input.policy.minimum_hits) {
    throw new Error(
      `${input.label} absolute R@5 requires at least ` +
      `${input.policy.minimum_hits}/${input.policy.expected_denominator} hits`
    );
  }
}
