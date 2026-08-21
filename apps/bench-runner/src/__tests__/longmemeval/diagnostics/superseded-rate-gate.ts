export interface SupersededAllQuestionRateGate {
  readonly schema_version: 2;
  readonly kind: "cached_f3_exposed_denominator_gate";
  readonly declared_minimum_rate: 1;
  readonly evaluated_count: number;
  readonly exposed_count: number;
  readonly actual_rate: number;
  readonly passed: boolean;
}

export function evaluateSupersededAllQuestionRateGate(
  receipts: readonly { readonly exposure_status: string }[]
): SupersededAllQuestionRateGate {
  const evaluated_count = receipts.length;
  const exposed_count = receipts.filter((row) => row.exposure_status === "exposed").length;
  const actual_rate = evaluated_count === 0 ? 0 : exposed_count / evaluated_count;
  return {
    schema_version: 2,
    kind: "cached_f3_exposed_denominator_gate",
    declared_minimum_rate: 1,
    evaluated_count,
    exposed_count,
    actual_rate,
    passed: evaluated_count > 0 && actual_rate >= 1
  };
}
