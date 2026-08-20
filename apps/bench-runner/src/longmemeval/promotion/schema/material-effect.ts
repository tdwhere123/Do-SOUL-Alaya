import type { KpiPayload, PerScenarioRow } from "@do-soul/alaya-eval";

export const LONGMEMEVAL_R2_MATERIAL_EFFECT_POLICY = Object.freeze({
  answerableCount: 94,
  declaredAbstentionCount: 6,
  mcnemarMethod: "exact_two_sided"
} as const);

const POLICY = LONGMEMEVAL_R2_MATERIAL_EFFECT_POLICY;

export interface LongMemEvalMetricDelta {
  readonly control: number;
  readonly product: number;
  readonly delta: number;
}

export interface LongMemEvalMaterialEffect {
  readonly status: "passed";
  readonly directional: Readonly<{
    r_at_1: LongMemEvalMetricDelta;
    r_at_5: LongMemEvalMetricDelta;
    r_at_10: LongMemEvalMetricDelta;
    full_gold_at_5: LongMemEvalMetricDelta;
  }>;
  readonly safeguards: Readonly<{
    token_saved_ratio_vs_full_prompt: LongMemEvalMetricDelta;
    recall_eval_attribution: "eligible_in_both";
    measurement_attribution: "honest_in_both";
  }>;
  readonly paired_r_at_5: Readonly<{
    answerable_count: 94;
    control_hits: number;
    product_hits: number;
    gained: number;
    lost: number;
    net: number;
    mcnemar: Readonly<{
      method: "exact_two_sided";
      p_value: number;
    }>;
  }>;
}

interface MeasuredRows {
  readonly answerable: ReadonlyMap<string, boolean>;
  readonly cohortById: ReadonlyMap<string, string>;
}

export function verifyLongMemEvalMaterialEffect(input: {
  readonly control: KpiPayload;
  readonly product: KpiPayload;
}): LongMemEvalMaterialEffect {
  const controlRows = measuredRows(input.control, "control");
  const productRows = measuredRows(input.product, "product");
  assertPairedRows(controlRows, productRows);
  assertAttribution(input.control, input.product);
  const directional = directionalEffect(input.control, input.product);
  const tokenEconomy = metricDelta(
    input.control.kpi.token_saved_ratio_vs_full_prompt,
    input.product.kpi.token_saved_ratio_vs_full_prompt
  );
  return {
    status: "passed",
    directional,
    safeguards: {
      token_saved_ratio_vs_full_prompt: tokenEconomy,
      recall_eval_attribution: "eligible_in_both",
      measurement_attribution: "honest_in_both"
    },
    paired_r_at_5: pairedR5Effect(controlRows.answerable, productRows.answerable)
  };
}

export function exactTwoSidedMcNemarPValue(gained: number, lost: number): number {
  if (!Number.isSafeInteger(gained) || gained < 0 ||
      !Number.isSafeInteger(lost) || lost < 0) {
    throw new Error("McNemar discordant counts must be nonnegative integers");
  }
  const discordant = gained + lost;
  if (discordant === 0) return 1;
  const tail = Math.min(gained, lost);
  let term = 2 ** -discordant;
  let cumulative = term;
  for (let k = 1; k <= tail; k += 1) {
    term *= (discordant - k + 1) / k;
    cumulative += term;
  }
  return Math.min(1, 2 * cumulative);
}

function measuredRows(payload: KpiPayload, label: string): MeasuredRows {
  if (payload.evaluated_count !== POLICY.answerableCount + POLICY.declaredAbstentionCount ||
      payload.answerable_evaluated_count !== POLICY.answerableCount) {
    throw cohortError(label);
  }
  const rows = payload.kpi.per_scenario;
  if (rows.length !== POLICY.answerableCount + POLICY.declaredAbstentionCount) {
    throw cohortError(label);
  }
  const ids = new Set(rows.map((row) => row.id));
  if (ids.size !== rows.length) throw new Error(`${label} requires unique question IDs`);
  const answerableRows = rows.filter(isAnswerableRow);
  const abstentionRows = rows.filter(isAbstentionRow);
  if (answerableRows.length !== POLICY.answerableCount ||
      abstentionRows.length !== POLICY.declaredAbstentionCount) throw cohortError(label);
  assertR5Aggregate(payload, answerableRows, label);
  return {
    answerable: new Map(answerableRows.map((row) => [row.id, row.hit_at_5])),
    cohortById: new Map(rows.map((row) => [row.id, row.measurement_cohort!]))
  };
}

function isAnswerableRow(row: PerScenarioRow): boolean {
  return row.measurement_cohort === "answerable" && row.scorable === true;
}

function isAbstentionRow(row: PerScenarioRow): boolean {
  return row.measurement_cohort === "dataset_declared_abstention" &&
    row.scorable === false && row.hit_at_5 === false;
}

function cohortError(label: string): Error {
  return new Error(
    `${label} paired measurement rows require exactly 94 answerable and 6 declared abstention questions`
  );
}

function assertR5Aggregate(
  payload: KpiPayload,
  rows: readonly PerScenarioRow[],
  label: string
): void {
  const hits = rows.filter((row) => row.hit_at_5).length;
  if (payload.kpi.r_at_5 !== hits / POLICY.answerableCount) {
    throw new Error(`${label} R@5 aggregate differs from paired measurement rows`);
  }
}

function assertPairedRows(control: MeasuredRows, product: MeasuredRows): void {
  if (control.cohortById.size !== product.cohortById.size) {
    throw new Error("A/B paired measurement rows differ");
  }
  for (const [id, cohort] of control.cohortById) {
    if (product.cohortById.get(id) !== cohort ||
        control.answerable.has(id) !== product.answerable.has(id)) {
      throw new Error("A/B paired measurement rows differ");
    }
  }
}

function assertAttribution(control: KpiPayload, product: KpiPayload): void {
  if (control.recall_eval_attribution?.status !== "attributed" ||
      control.recall_eval_attribution.gate_eligible !== true ||
      product.recall_eval_attribution?.status !== "attributed" ||
      product.recall_eval_attribution.gate_eligible !== true) {
    throw new Error("recall-eval attribution is missing or ineligible");
  }
  if (control.measurement_attribution === undefined ||
      product.measurement_attribution === undefined) {
    throw new Error("measurement attribution must remain explicit in both cells");
  }
}

function directionalEffect(
  control: KpiPayload,
  product: KpiPayload
): LongMemEvalMaterialEffect["directional"] {
  const controlFullGold = control.kpi.full_gold_coverage;
  const productFullGold = product.kpi.full_gold_coverage;
  if (controlFullGold === undefined || productFullGold === undefined ||
      controlFullGold.gold_bearing_questions !== productFullGold.gold_bearing_questions) {
    throw new Error("A/B full-gold evidence is missing or uses different denominators");
  }
  const result = {
    r_at_1: metricDelta(control.kpi.r_at_1, product.kpi.r_at_1),
    r_at_5: metricDelta(control.kpi.r_at_5, product.kpi.r_at_5),
    r_at_10: metricDelta(control.kpi.r_at_10, product.kpi.r_at_10),
    full_gold_at_5: metricDelta(controlFullGold.full_gold_at_5, productFullGold.full_gold_at_5)
  };
  const deltas = Object.values(result).map((metric) => metric.delta);
  if (deltas.some((delta) => delta < 0)) throw new Error("directional metric regressed from A to B");
  if (!deltas.some((delta) => delta > 0)) throw new Error("directional effect requires a positive A-to-B delta");
  return result;
}

function metricDelta(control: number, product: number): LongMemEvalMetricDelta {
  return { control, product, delta: product - control };
}

function pairedR5Effect(
  control: ReadonlyMap<string, boolean>,
  product: ReadonlyMap<string, boolean>
): LongMemEvalMaterialEffect["paired_r_at_5"] {
  let controlHits = 0;
  let productHits = 0;
  let gained = 0;
  let lost = 0;
  for (const [id, controlHit] of control) {
    const productHit = product.get(id)!;
    if (controlHit) controlHits += 1;
    if (productHit) productHits += 1;
    if (!controlHit && productHit) gained += 1;
    if (controlHit && !productHit) lost += 1;
  }
  const net = gained - lost;
  const pValue = exactTwoSidedMcNemarPValue(gained, lost);
  return {
    answerable_count: POLICY.answerableCount,
    control_hits: controlHits,
    product_hits: productHits,
    gained,
    lost,
    net,
    mcnemar: { method: POLICY.mcnemarMethod, p_value: pValue }
  };
}
