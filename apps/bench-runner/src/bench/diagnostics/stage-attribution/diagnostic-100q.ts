import type { QuestionStageRow } from "./types.js";
import {
  CACHED_F3_EXPOSURE_POLICY,
  assertTreatmentExposureReceipt,
  type TreatmentExposureReceipt
} from "./exposure/contract.js";

export const DIAGNOSTIC_100Q_STAGES = [
  "S0",
  "S1",
  "S2",
  "S3",
  "S4",
  "S5"
] as const;

export type Diagnostic100QStage = (typeof DIAGNOSTIC_100Q_STAGES)[number];

export const DIAGNOSTIC_500Q_CLOSED = true;

export interface Diagnostic100QQuestion {
  readonly question_id: string;
  readonly stage: Diagnostic100QStage;
  readonly hit_at_5: boolean;
  readonly proof: string;
}

export interface Diagnostic100QComparison {
  readonly schema_version: 5;
  readonly kind: "diagnostic_100q_f0f2_vs_cached_f3";
  readonly physical_calls: 0;
  readonly five_hundred_q_closed: true;
  readonly control_misses: Readonly<Record<Diagnostic100QStage, number>>;
  readonly treatment_misses: Readonly<Record<Diagnostic100QStage, number>>;
  readonly membership_improved: readonly string[];
  readonly still_missing: readonly string[];
  readonly not_exercised: readonly string[];
  readonly inconclusive: readonly string[];
  readonly treatment_exposure_receipts: readonly TreatmentExposureReceipt[];
  readonly causal_comparison_status: "eligible" | "inconclusive";
  readonly exposed_denominator_gate: {
    readonly schema_version: 1;
    readonly kind: "cached_f3_exposed_denominator_gate";
    readonly declared_minimum_rate: number;
    readonly evaluated_count: number;
    readonly exposed_count: number;
    readonly actual_rate: number;
    readonly passed: boolean;
  };
}

export function mapQuestionToDiagnosticStage(
  row: Pick<QuestionStageRow, "stage" | "hit_at_5" | "proof" | "miss_taxonomy">
): Diagnostic100QStage {
  if (row.hit_at_5 || row.stage === 7) return "S5";
  if (row.stage === 1) {
    if (row.miss_taxonomy === "evaluation_or_gold_issue" ||
        row.proof.includes("empty_gold") ||
        row.proof.includes("write_loss")) {
      return "S0";
    }
    return "S1";
  }
  if (row.proof === "semantic_factor_formation_rejected") return "S2";
  if (row.stage === 2 || row.stage === 3) return "S3";
  return "S4";
}

export function compareF0F2VsCachedF3(input: {
  readonly control: readonly QuestionStageRow[];
  readonly treatment: readonly QuestionStageRow[];
  readonly treatmentExposure: readonly TreatmentExposureReceipt[];
}): Diagnostic100QComparison {
  const controlById = new Map(input.control.map((row) => [row.question_id, row]));
  const treatmentById = new Map(input.treatment.map((row) => [row.question_id, row]));
  const exposureById = indexExposureReceipts(input.treatmentExposure);
  assertSameQuestionSet(controlById, treatmentById, "treatment stage rows");
  assertSameQuestionSet(controlById, exposureById, "treatment exposure receipts");
  const classification = classifyComparison(controlById, treatmentById, exposureById);
  const exposedCount = input.treatmentExposure.filter(
    (receipt) => receipt.exposure_status === "exposed"
  ).length;
  const evaluatedCount = controlById.size;
  const exposedDenominatorGate = buildExposedDenominatorGate(evaluatedCount, exposedCount);
  return {
    schema_version: 5,
    kind: "diagnostic_100q_f0f2_vs_cached_f3",
    physical_calls: 0,
    five_hundred_q_closed: DIAGNOSTIC_500Q_CLOSED,
    ...classification,
    treatment_exposure_receipts: [...input.treatmentExposure]
      .sort((left, right) => left.question_id.localeCompare(right.question_id)),
    causal_comparison_status: exposedDenominatorGate.passed ? "eligible" : "inconclusive",
    exposed_denominator_gate: exposedDenominatorGate
  };
}

function buildExposedDenominatorGate(evaluatedCount: number, exposedCount: number) {
  const actualRate = evaluatedCount === 0 ? 0 : exposedCount / evaluatedCount;
  return {
    schema_version: 1 as const,
    kind: "cached_f3_exposed_denominator_gate" as const,
    declared_minimum_rate: CACHED_F3_EXPOSURE_POLICY.declared_minimum_rate,
    evaluated_count: evaluatedCount,
    exposed_count: exposedCount,
    actual_rate: actualRate,
    passed: evaluatedCount > 0 &&
      actualRate >= CACHED_F3_EXPOSURE_POLICY.declared_minimum_rate
  };
}

function indexExposureReceipts(
  receipts: readonly TreatmentExposureReceipt[]
): ReadonlyMap<string, TreatmentExposureReceipt> {
  const indexed = new Map<string, TreatmentExposureReceipt>();
  for (const receipt of receipts) {
    assertTreatmentExposureReceipt(receipt);
    if (indexed.has(receipt.question_id)) {
      throw new Error(`duplicate cached F3 treatment exposure receipt: ${receipt.question_id}`);
    }
    indexed.set(receipt.question_id, receipt);
  }
  return indexed;
}

function classifyComparison(
  control: ReadonlyMap<string, QuestionStageRow>,
  treatment: ReadonlyMap<string, QuestionStageRow>,
  exposure: ReadonlyMap<string, TreatmentExposureReceipt>
) {
  const result = emptyClassification();
  for (const [questionId, controlRow] of control) {
    const treatmentRow = treatment.get(questionId)!;
    const exposureRow = exposure.get(questionId)!;
    if (!controlRow.hit_at_5) {
      result.control_misses[mapQuestionToDiagnosticStage(controlRow)] += 1;
    }
    if (!treatmentRow.hit_at_5) {
      result.treatment_misses[mapQuestionToDiagnosticStage(treatmentRow)] += 1;
    }
    classifyQuestion(result, questionId, controlRow, treatmentRow, exposureRow);
  }
  result.membership_improved.sort();
  result.still_missing.sort();
  result.not_exercised.sort();
  result.inconclusive.sort();
  return result;
}

function classifyQuestion(
  result: ReturnType<typeof emptyClassification>,
  questionId: string,
  control: QuestionStageRow,
  treatment: QuestionStageRow,
  exposure: TreatmentExposureReceipt
): void {
  if (exposure.outcome.control.stage !== mapQuestionToDiagnosticStage(control) ||
      exposure.outcome.control.hit_at_5 !== control.hit_at_5 ||
      exposure.outcome.treatment.stage !== mapQuestionToDiagnosticStage(treatment) ||
      exposure.outcome.treatment.hit_at_5 !== treatment.hit_at_5) {
    throw new Error(`cached F3 treatment exposure outcome mismatch: ${questionId}`);
  }
  if (exposure.exposure_status === "not_exercised") result.not_exercised.push(questionId);
  else if (exposure.exposure_status === "inconclusive") result.inconclusive.push(questionId);
  else if (!control.hit_at_5 && treatment.hit_at_5) result.membership_improved.push(questionId);
  else if (!control.hit_at_5 && !treatment.hit_at_5) result.still_missing.push(questionId);
}

function emptyClassification() {
  return {
    control_misses: emptyCounts(),
    treatment_misses: emptyCounts(),
    membership_improved: [] as string[],
    still_missing: [] as string[],
    not_exercised: [] as string[],
    inconclusive: [] as string[]
  };
}

function assertSameQuestionSet(
  expected: ReadonlyMap<string, unknown>,
  actual: ReadonlyMap<string, unknown>,
  label: string
): void {
  if (expected.size !== actual.size || [...expected.keys()].some((id) => !actual.has(id))) {
    throw new Error(`cached F3 comparison ${label} do not match the control question set`);
  }
}

function emptyCounts(): Record<Diagnostic100QStage, number> {
  return { S0: 0, S1: 0, S2: 0, S3: 0, S4: 0, S5: 0 };
}
