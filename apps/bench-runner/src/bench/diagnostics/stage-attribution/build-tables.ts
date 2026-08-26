import type { LongMemEvalQuestionDiagnostic } from "../schema/diagnostics-types.js";
import { isAbstentionDiagnostic } from "../abstention.js";
import {
  classifyGoldObjectStage,
  classifyQuestionStage,
  isDeliveryOrderDrop,
  isMissTaxonomyCandidateAbsent,
  isQualityCandidateAbsent,
  isRankBucketCandidateAbsent
} from "./classify-question.js";
import {
  emptyStageCounts,
  stageCountKey,
  type CandidateAbsenceViews,
  type GoldObjectStageRow,
  type QuestionStageRow,
  type StageAttributionSummary,
  type StageAttributionTables
} from "./types.js";

const STAGE_ATTRIBUTION_NOT_CHECKED = [
  "why_raw_pool_absent_admit_fts_planes",
  "pre_waist_proof_from_f0",
  "waist_composition_causal_owner",
  "f0_waist_join"
] as const;

export function buildStageAttributionTables(input: {
  readonly cell: string;
  readonly sourceDiagnostics: string;
  readonly questions: readonly LongMemEvalQuestionDiagnostic[];
}): StageAttributionTables {
  const questionRows: QuestionStageRow[] = [];
  const goldRows: GoldObjectStageRow[] = [];
  const questionCounts = emptyStageCounts();
  const goldCounts = emptyStageCounts();

  let evaluated = 0;
  let scorable = 0;
  let goldBearing = 0;
  let miss = 0;
  let goldAll = 0;
  let kpiPre610 = 0;
  let deliveryOrder = 0;

  const taxonomyAbsentIds: string[] = [];
  const qualityAbsentIds: string[] = [];
  const rankAbsentIds: string[] = [];

  for (const question of input.questions) {
    evaluated += 1;
    if (isAbstentionDiagnostic(question)) continue;
    scorable += 1;
    const accounted = accumulateQuestionAttribution(question, {
      questionRows,
      goldRows,
      questionCounts,
      goldCounts,
      taxonomyAbsentIds,
      qualityAbsentIds,
      rankAbsentIds
    });
    if (accounted.goldBearing) goldBearing += 1;
    if (accounted.miss) miss += 1;
    if (accounted.kpiPre610) kpiPre610 += 1;
    if (accounted.deliveryOrder) deliveryOrder += 1;
    goldAll += accounted.goldAll;
  }

  const absenceViews: CandidateAbsenceViews = {
    miss_taxonomy_candidate_absent: {
      count: taxonomyAbsentIds.length,
      denominator: miss,
      denominator_name: "D_Q_miss",
      question_ids: taxonomyAbsentIds
    },
    quality_candidate_absent_count: {
      count: qualityAbsentIds.length,
      denominator: scorable,
      denominator_name: "D_Q_scorable",
      question_ids: qualityAbsentIds
    },
    rank_bucket_candidate_absent: {
      count: rankAbsentIds.length,
      denominator: goldBearing,
      denominator_name: "D_Q_gold_bearing",
      question_ids: rankAbsentIds
    }
  };

  const summary: StageAttributionSummary = {
    denominators: {
      D_Q_evaluated: evaluated,
      D_Q_scorable: scorable,
      D_Q_gold_bearing: goldBearing,
      D_Q_miss: miss,
      D_G_all: goldAll
    },
    question_stage_counts: questionCounts,
    gold_stage_counts: goldCounts,
    kpi_pre_budget_6_10: kpiPre610,
    delivery_order_drop: deliveryOrder,
    candidate_absence_views: absenceViews,
    not_checked: [...STAGE_ATTRIBUTION_NOT_CHECKED]
  };

  return {
    schema_version: 1,
    kind: "stage-attribution-tables",
    cell: input.cell,
    source_diagnostics: input.sourceDiagnostics,
    summary,
    questions: questionRows,
    gold_objects: goldRows
  };
}

function accumulateQuestionAttribution(
  question: LongMemEvalQuestionDiagnostic,
  acc: {
    readonly questionRows: QuestionStageRow[];
    readonly goldRows: GoldObjectStageRow[];
    readonly questionCounts: ReturnType<typeof emptyStageCounts>;
    readonly goldCounts: ReturnType<typeof emptyStageCounts>;
    readonly taxonomyAbsentIds: string[];
    readonly qualityAbsentIds: string[];
    readonly rankAbsentIds: string[];
  }
): Readonly<{
  readonly goldBearing: boolean;
  readonly miss: boolean;
  readonly kpiPre610: boolean;
  readonly deliveryOrder: boolean;
  readonly goldAll: number;
}> {
  const goldBearing = question.gold.length > 0;
  const questionRow = classifyQuestionStage(question);
  acc.questionRows.push(questionRow);
  acc.questionCounts[stageCountKey(questionRow.stage)] += 1;

  if (!question.hit_at_5 && isMissTaxonomyCandidateAbsent(question)) {
    acc.taxonomyAbsentIds.push(question.question_id);
  }
  if (isQualityCandidateAbsent(question)) {
    acc.qualityAbsentIds.push(question.question_id);
  }
  if (goldBearing && !question.hit_at_5 && isRankBucketCandidateAbsent(question.gold)) {
    acc.rankAbsentIds.push(question.question_id);
  }

  for (const gold of question.gold) {
    const goldRow = classifyGoldObjectStage({
      question,
      gold,
      opportunityQuestion: questionRow.opportunity_pre_budget_6_10
    });
    acc.goldRows.push(goldRow);
    acc.goldCounts[stageCountKey(goldRow.stage)] += 1;
  }

  return {
    goldBearing,
    miss: !question.hit_at_5,
    kpiPre610: questionRow.opportunity_pre_budget_6_10,
    deliveryOrder: isDeliveryOrderDrop(question),
    goldAll: question.gold.length
  };
}
