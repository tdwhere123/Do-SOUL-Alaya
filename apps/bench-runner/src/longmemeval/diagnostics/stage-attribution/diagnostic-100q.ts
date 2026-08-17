import type { QuestionStageRow } from "./types.js";

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
  readonly schema_version: 1;
  readonly kind: "diagnostic_100q_f0f2_vs_cached_f3";
  readonly physical_calls: 0;
  readonly five_hundred_q_closed: true;
  readonly control_misses: Readonly<Record<Diagnostic100QStage, number>>;
  readonly treatment_misses: Readonly<Record<Diagnostic100QStage, number>>;
  readonly membership_improved: readonly string[];
  readonly still_missing: readonly string[];
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
}): Diagnostic100QComparison {
  const controlById = new Map(input.control.map((row) => [row.question_id, row]));
  const treatmentById = new Map(input.treatment.map((row) => [row.question_id, row]));
  const controlMisses = emptyCounts();
  const treatmentMisses = emptyCounts();
  const membershipImproved: string[] = [];
  const stillMissing: string[] = [];
  for (const [questionId, control] of controlById) {
    const treatment = treatmentById.get(questionId);
    const controlStage = mapQuestionToDiagnosticStage(control);
    const treatmentStage = treatment === undefined
      ? controlStage
      : mapQuestionToDiagnosticStage(treatment);
    if (!control.hit_at_5) controlMisses[controlStage] += 1;
    if (treatment !== undefined && !treatment.hit_at_5) {
      treatmentMisses[treatmentStage] += 1;
    }
    if (!control.hit_at_5 && treatment?.hit_at_5 === true) {
      membershipImproved.push(questionId);
    } else if (!control.hit_at_5 && treatment !== undefined && !treatment.hit_at_5) {
      stillMissing.push(questionId);
    }
  }
  return {
    schema_version: 1,
    kind: "diagnostic_100q_f0f2_vs_cached_f3",
    physical_calls: 0,
    five_hundred_q_closed: DIAGNOSTIC_500Q_CLOSED,
    control_misses: controlMisses,
    treatment_misses: treatmentMisses,
    membership_improved: membershipImproved.sort(),
    still_missing: stillMissing.sort()
  };
}

function emptyCounts(): Record<Diagnostic100QStage, number> {
  return { S0: 0, S1: 0, S2: 0, S3: 0, S4: 0, S5: 0 };
}
