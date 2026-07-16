import { classifyGoldDeliveryMissTaxonomy } from "./diagnostics-delivery-bridge.js";
import type {
  CandidateDiagnostic,
  LongMemEvalGoldDiagnostic,
  LongMemEvalMissTaxonomy,
  LongMemEvalMissTaxonomySummary,
  LongMemEvalQuestionDiagnostic
} from "./diagnostics-types.js";
import type { LongMemEvalSeedDropReasons } from "./seed-drop-reasons.js";
import { classifyQuestionMeasurementStatus } from "./measurement/question-validity.js";

type MutableMissTaxonomySummary = Record<LongMemEvalMissTaxonomy, number>;

export function createEmptyMissTaxonomyDistribution(): MutableMissTaxonomySummary {
  return {
    candidate_absent: 0,
    materialization_drop: 0,
    fine_assessment_drop: 0,
    budget_drop: 0,
    delivery_order_drop: 0,
    answer_set_coverage_drop: 0,
    evaluation_or_gold_issue: 0
  };
}

function createMutableMissTaxonomySummary(): Record<LongMemEvalMissTaxonomy, number> {
  return createEmptyMissTaxonomyDistribution();
}

export function mergeMissTaxonomySummaries(
  summaries: readonly LongMemEvalMissTaxonomySummary[]
): LongMemEvalMissTaxonomySummary {
  const merged = createMutableMissTaxonomySummary();
  for (const summary of summaries) {
    merged.candidate_absent += summary.candidate_absent;
    merged.materialization_drop += summary.materialization_drop;
    merged.fine_assessment_drop += summary.fine_assessment_drop;
    merged.budget_drop += summary.budget_drop;
    merged.delivery_order_drop += summary.delivery_order_drop;
    merged.answer_set_coverage_drop += summary.answer_set_coverage_drop;
    merged.evaluation_or_gold_issue += summary.evaluation_or_gold_issue;
  }
  return Object.freeze({ ...merged });
}

export function readCompactMissTaxonomySummary(
  summary: unknown
): LongMemEvalMissTaxonomySummary | null {
  if (summary === undefined || summary === null) return null;
  if (typeof summary !== "object" || Array.isArray(summary)) {
    throw new Error(
      "invalid compact diagnostics miss_taxonomy_summary: expected object"
    );
  }
  const record = summary as Readonly<Record<string, unknown>>;
  return Object.freeze({
    candidate_absent: requiredCompactNonNegativeInteger(
      record.candidate_absent,
      "miss_taxonomy_summary.candidate_absent"
    ),
    materialization_drop: requiredCompactNonNegativeInteger(
      record.materialization_drop,
      "miss_taxonomy_summary.materialization_drop"
    ),
    fine_assessment_drop: optionalCompactNonNegativeInteger(
      record.fine_assessment_drop,
      "miss_taxonomy_summary.fine_assessment_drop"
    ),
    budget_drop: requiredCompactNonNegativeInteger(
      record.budget_drop,
      "miss_taxonomy_summary.budget_drop"
    ),
    delivery_order_drop: requiredCompactNonNegativeInteger(
      record.delivery_order_drop,
      "miss_taxonomy_summary.delivery_order_drop"
    ),
    answer_set_coverage_drop: optionalCompactNonNegativeInteger(
      record.answer_set_coverage_drop,
      "miss_taxonomy_summary.answer_set_coverage_drop"
    ),
    evaluation_or_gold_issue: requiredCompactNonNegativeInteger(
      record.evaluation_or_gold_issue,
      "miss_taxonomy_summary.evaluation_or_gold_issue"
    )
  });
}

export function classifyGoldMissTaxonomy(input: {
  readonly deliveredRank: number | null;
  readonly candidate: CandidateDiagnostic | undefined;
  readonly anyObjectCandidate: CandidateDiagnostic | undefined;
  readonly fineAssessmentPruned?: boolean;
  readonly anyObjectFineAssessmentPruned?: boolean;
  readonly diagnosticsAvailable: boolean;
}): LongMemEvalMissTaxonomy | null {
  return classifyGoldDeliveryMissTaxonomy(input);
}

export function classifyQuestionMissTaxonomy(input: {
  readonly hitAt5: boolean;
  readonly goldMemoryIds: readonly string[];
  readonly gold: readonly LongMemEvalGoldDiagnostic[];
  readonly diagnosticsAvailable: boolean;
  readonly isAbstention: boolean;
  readonly seedDropReasons?: LongMemEvalSeedDropReasons;
}): LongMemEvalMissTaxonomy | null {
  if (input.hitAt5) {
    return null;
  }
  if (input.isAbstention) return null;
  if (!input.diagnosticsAvailable) {
    return "evaluation_or_gold_issue";
  }
  if (input.goldMemoryIds.length === 0) {
    if ((input.seedDropReasons?.materialization_drop ?? 0) > 0) {
      return "materialization_drop";
    }
    if ((input.seedDropReasons?.candidate_absent ?? 0) > 0) {
      return "candidate_absent";
    }
    return "evaluation_or_gold_issue";
  }
  const goldTaxonomies = input.gold
    .map((row) => row.miss_taxonomy)
    .filter((taxonomy): taxonomy is LongMemEvalMissTaxonomy => taxonomy !== null);
  return (
    firstPresentTaxonomy(goldTaxonomies, "fine_assessment_drop") ??
    firstPresentTaxonomy(goldTaxonomies, "materialization_drop") ??
    firstPresentTaxonomy(goldTaxonomies, "budget_drop") ??
    firstPresentTaxonomy(goldTaxonomies, "answer_set_coverage_drop") ??
    firstPresentTaxonomy(goldTaxonomies, "delivery_order_drop") ??
    firstPresentTaxonomy(goldTaxonomies, "candidate_absent") ??
    "evaluation_or_gold_issue"
  );
}

export function readQuestionMissTaxonomy(
  question: LongMemEvalQuestionDiagnostic
): LongMemEvalMissTaxonomy | null {
  if (question.miss_taxonomy !== null && question.miss_taxonomy !== undefined) {
    return question.miss_taxonomy;
  }
  return classifyQuestionMissTaxonomy({
    hitAt5: question.hit_at_5,
    goldMemoryIds: question.gold_memory_ids,
    gold: question.gold,
    diagnosticsAvailable: question.recall_diagnostics_present,
    isAbstention: question.question_id.endsWith("_abs"),
    seedDropReasons: question.seed_drop_reasons
  });
}

export function summarizeLongMemEvalMissTaxonomy(
  diagnostics: readonly LongMemEvalQuestionDiagnostic[]
): LongMemEvalMissTaxonomySummary {
  const summary = createMutableMissTaxonomySummary();
  for (const row of diagnostics) {
    if (row.hit_at_5 || classifyQuestionMeasurementStatus(row) !== "scorable") continue;
    const taxonomy = readQuestionMissTaxonomy(row);
    if (taxonomy === null) {
      continue;
    }
    summary[taxonomy] += 1;
  }
  return Object.freeze({ ...summary });
}

function firstPresentTaxonomy(
  taxonomies: readonly LongMemEvalMissTaxonomy[],
  target: LongMemEvalMissTaxonomy
): LongMemEvalMissTaxonomy | null {
  return taxonomies.includes(target) ? target : null;
}

function requiredCompactNonNegativeInteger(
  value: unknown,
  fieldName: string
): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0
  ) {
    throw new Error(
      `invalid compact diagnostics ${fieldName}: expected non-negative integer`
    );
  }
  return value;
}

function optionalCompactNonNegativeInteger(
  value: unknown,
  fieldName: string
): number {
  if (value === undefined || value === null) {
    return 0;
  }
  return requiredCompactNonNegativeInteger(value, fieldName);
}
