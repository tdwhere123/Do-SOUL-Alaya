import type { QuestionStageRow } from "./types.js";
import {
  assertTreatmentExposureReceipt,
  type TreatmentExposureReceipt
} from "./exposure/contract.js";
import {
  buildDiagnostic100QUnlock,
  type Diagnostic100QUnlock
} from "./exposure/diagnostic-unlock.js";
import {
  buildCachedF3ExposureSli,
  type CachedF3ExposureSli
} from "./exposure/exposure-sli.js";
import {
  evaluateCanaryPolarityMatrix,
  type CanaryPolarityMatrixVerdict
} from "./exposure/canary-polarity-matrix.js";

export const DIAGNOSTIC_100Q_STAGES = [
  "eval_or_write_loss",
  "early_absent",
  "formation_rejected",
  "pre_waist",
  "waist_or_later",
  "delivered_top5"
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
  readonly schema_version: 7;
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
  readonly exposure_sli: CachedF3ExposureSli;
  readonly canary_polarity_matrix: CanaryPolarityMatrixVerdict;
  readonly diagnostic_100q_unlock: Diagnostic100QUnlock;
}

export function mapQuestionToDiagnosticStage(
  row: Pick<QuestionStageRow, "stage" | "hit_at_5" | "proof" | "miss_taxonomy">
): Diagnostic100QStage {
  if (row.hit_at_5 || row.stage === "delivered_top5") return "delivered_top5";
  if (row.stage === "write_or_unevaluable") {
    if (row.miss_taxonomy === "evaluation_or_gold_issue" ||
        row.proof.includes("empty_gold") ||
        row.proof.includes("write_loss")) {
      return "eval_or_write_loss";
    }
    return "early_absent";
  }
  if (row.proof === "semantic_factor_formation_rejected") return "formation_rejected";
  if (row.stage === "raw_pool_absent" || row.stage === "pre_waist_prune") return "pre_waist";
  return "waist_or_later";
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
  const receipts = [...input.treatmentExposure]
    .sort((left, right) => left.question_id.localeCompare(right.question_id));
  const exposureSli = buildCachedF3ExposureSli(receipts);
  const polarityMatrix = evaluateCanaryPolarityMatrix(receipts);
  const unlock = buildDiagnostic100QUnlock(polarityMatrix);
  return {
    schema_version: 7,
    kind: "diagnostic_100q_f0f2_vs_cached_f3",
    physical_calls: 0,
    five_hundred_q_closed: DIAGNOSTIC_500Q_CLOSED,
    ...classification,
    treatment_exposure_receipts: receipts,
    causal_comparison_status: deriveCausalStatus(polarityMatrix, exposureSli),
    exposure_sli: exposureSli,
    canary_polarity_matrix: polarityMatrix,
    diagnostic_100q_unlock: unlock
  };
}

export function deriveCausalStatus(
  matrix: CanaryPolarityMatrixVerdict,
  sli: CachedF3ExposureSli
): "eligible" | "inconclusive" {
  if (matrix.applicable) return matrix.passed ? "eligible" : "inconclusive";
  return sli.denominator_count > 0 ? "eligible" : "inconclusive";
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
  return { eval_or_write_loss: 0, early_absent: 0, formation_rejected: 0, pre_waist: 0, waist_or_later: 0, delivered_top5: 0 };
}
