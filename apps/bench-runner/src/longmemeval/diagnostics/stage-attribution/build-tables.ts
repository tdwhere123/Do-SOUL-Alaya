import type { LongMemEvalQuestionDiagnostic } from "../schema/diagnostics-types.js";
import { isAbstentionQuestionId } from "../abstention.js";
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

const GATE1_NOT_CHECKED = [
  "why_raw_pool_absent_admit_fts_planes",
  "pre_waist_proof_from_f0",
  "stage_4_causal_owner_inside_composition",
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
    if (isAbstention(question)) continue;
    scorable += 1;

    const goldBearingQuestion = question.gold.length > 0;
    if (goldBearingQuestion) goldBearing += 1;

    if (!question.hit_at_5) miss += 1;

    const questionRow = classifyQuestionStage(question);
    questionRows.push(questionRow);
    questionCounts[stageCountKey(questionRow.stage)] += 1;
    if (questionRow.opportunity_pre_budget_6_10) kpiPre610 += 1;
    if (isDeliveryOrderDrop(question)) deliveryOrder += 1;

    if (!question.hit_at_5 && isMissTaxonomyCandidateAbsent(question)) {
      taxonomyAbsentIds.push(question.question_id);
    }
    if (isQualityCandidateAbsent(question)) {
      qualityAbsentIds.push(question.question_id);
    }
    if (
      goldBearingQuestion &&
      !question.hit_at_5 &&
      isRankBucketCandidateAbsent(question.gold)
    ) {
      rankAbsentIds.push(question.question_id);
    }

    for (const gold of question.gold) {
      goldAll += 1;
      const goldRow = classifyGoldObjectStage({
        question,
        gold,
        opportunityQuestion: questionRow.opportunity_pre_budget_6_10
      });
      goldRows.push(goldRow);
      goldCounts[stageCountKey(goldRow.stage)] += 1;
    }
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
    not_checked: [...GATE1_NOT_CHECKED]
  };

  return {
    schema_version: 1,
    kind: "gate1-stage-attribution-tables",
    cell: input.cell,
    source_diagnostics: input.sourceDiagnostics,
    summary,
    questions: questionRows,
    gold_objects: goldRows
  };
}

function isAbstention(question: LongMemEvalQuestionDiagnostic): boolean {
  return (
    question.is_abstention === true ||
    isAbstentionQuestionId(question.question_id) ||
    question.cohort_ledger?.dataset_cohort === "abstention"
  );
}
