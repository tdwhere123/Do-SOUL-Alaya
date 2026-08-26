import { classifyQuestionMeasurementStatus } from
  "../../measurement/question-validity.js";
import { streamRecallEvalQuestionDiagnostics } from
  "../stage-attribution/load-recall-eval-diagnostics.js";
import { buildLongMemEvalFullGoldCoverage } from
  "../diagnostics-full-gold-coverage.js";
import { readGoldObjectIds } from "../gold-object-identities.js";
import {
  isFieldOrderingMiss,
  isGoldInField,
  readQuestionFieldContext,
  type GoldFieldContext
} from "../gold-field-membership.js";
import { buildLongMemEvalQualityMetrics } from
  "../quality/diagnostics-quality.js";
import type {
  LongMemEvalGoldDiagnostic,
  LongMemEvalQuestionDiagnostic
} from "../schema/diagnostics-types.js";
import { classifyMiss } from "./classify-miss.js";
import { classifyQuestionMissTaxonomy } from "./diagnostics-miss-taxonomy.js";

export interface ReclassifyQuestionDiagnosticsResult {
  readonly questions: readonly LongMemEvalQuestionDiagnostic[];
  readonly quality_metrics: ReturnType<typeof buildLongMemEvalQualityMetrics>;
  readonly full_gold_coverage: ReturnType<typeof buildLongMemEvalFullGoldCoverage>;
}

export interface ReclassifyArtifactSummary {
  readonly questions: number;
  readonly scorable_misses: number;
  readonly miss_classification: Readonly<Record<string, number>>;
  readonly miss_taxonomy: Readonly<Record<string, number>>;
  readonly in_field_misses: number;
  readonly in_field_classified_candidate_absent: number;
  readonly taxonomy_disagreement: number;
}

export function reclassifyQuestionDiagnostic(
  question: LongMemEvalQuestionDiagnostic
): LongMemEvalQuestionDiagnostic {
  const field = readQuestionFieldContext(question);
  const gold = question.gold.map((row) => ({
    ...row,
    miss_taxonomy: reclassifyGoldMissTaxonomy(row, field)
  }));
  return {
    ...question,
    gold,
    miss_classification: classifyMiss({
      hitAt5: question.hit_at_5,
      gold,
      diagnosticsAvailable: question.recall_diagnostics_present,
      isAbstention: question.is_abstention === true,
      seedDropReasons: question.seed_drop_reasons,
      field
    }),
    miss_taxonomy: classifyQuestionMissTaxonomy({
      hitAt5: question.hit_at_5,
      goldMemoryIds: question.gold_memory_ids,
      goldObjectIds: readGoldObjectIds(question),
      gold,
      diagnosticsAvailable: question.recall_diagnostics_present,
      isAbstention: question.is_abstention === true,
      seedDropReasons: question.seed_drop_reasons
    })
  };
}

export function reclassifyQuestionDiagnostics(
  questions: readonly LongMemEvalQuestionDiagnostic[]
): ReclassifyQuestionDiagnosticsResult {
  const repaired = questions.map(reclassifyQuestionDiagnostic);
  return {
    questions: repaired,
    quality_metrics: buildLongMemEvalQualityMetrics(repaired),
    full_gold_coverage: buildLongMemEvalFullGoldCoverage(repaired)
  };
}

export async function reclassifyDiagnosticsGzipArtifact(
  artifactPath: string
): Promise<ReclassifyArtifactSummary> {
  const missClassification: Record<string, number> = {};
  const missTaxonomy: Record<string, number> = {};
  let questions = 0;
  let scorableMisses = 0;
  let inFieldMisses = 0;
  let inFieldClassifiedCandidateAbsent = 0;
  let taxonomyDisagreement = 0;
  for await (const question of streamRecallEvalQuestionDiagnostics(artifactPath)) {
    questions += 1;
    const repaired = reclassifyQuestionDiagnostic(question);
    bump(missClassification, repaired.miss_classification);
    if (repaired.miss_taxonomy !== null) bump(missTaxonomy, repaired.miss_taxonomy);
    if (repaired.hit_at_5 || classifyQuestionMeasurementStatus(repaired) !== "scorable") {
      continue;
    }
    scorableMisses += 1;
    const field = readQuestionFieldContext(repaired);
    if (!repaired.gold.some((gold) => isGoldInField(gold, field))) continue;
    inFieldMisses += 1;
    if (repaired.miss_classification === "candidate_absent") {
      inFieldClassifiedCandidateAbsent += 1;
    }
    if (orderingAxesDisagree(repaired)) taxonomyDisagreement += 1;
  }
  return {
    questions,
    scorable_misses: scorableMisses,
    miss_classification: missClassification,
    miss_taxonomy: missTaxonomy,
    in_field_misses: inFieldMisses,
    in_field_classified_candidate_absent: inFieldClassifiedCandidateAbsent,
    taxonomy_disagreement: taxonomyDisagreement
  };
}

function reclassifyGoldMissTaxonomy(
  gold: LongMemEvalGoldDiagnostic,
  field: GoldFieldContext
): LongMemEvalGoldDiagnostic["miss_taxonomy"] {
  if (gold.final_rank !== null && gold.final_rank <= 5) return gold.miss_taxonomy;
  if (
    isFieldOrderingMiss(gold, field) &&
    (gold.miss_taxonomy === "candidate_absent" || gold.miss_taxonomy === null)
  ) {
    return "delivery_order_drop";
  }
  return gold.miss_taxonomy;
}

function orderingAxesDisagree(question: LongMemEvalQuestionDiagnostic): boolean {
  if (question.miss_classification === "under_ranked") {
    return question.miss_taxonomy !== "delivery_order_drop";
  }
  if (question.miss_classification === "candidate_absent") {
    return question.miss_taxonomy !== "candidate_absent";
  }
  return false;
}

function bump(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}
