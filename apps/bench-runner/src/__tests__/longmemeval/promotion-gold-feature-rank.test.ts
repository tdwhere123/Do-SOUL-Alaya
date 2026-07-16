import { describe, expect, it } from "vitest";
import { LongMemEvalQuestionDiagnosticSchema } from
  "../../longmemeval/diagnostics-schema.js";
import type { LongMemEvalQuestionDiagnostic } from
  "../../longmemeval/diagnostics-types.js";
import { verifyPromotionGoldEvidence } from
  "../../longmemeval/promotion/gold-verifier.js";
import { promotionMeasurementDiagnostic } from
  "./specialized-answerable-recall-fixture.js";

describe("promotion gold feature-rank attribution", () => {
  it.each([
    {
      label: "head moves fused top-5 out before coverage",
      fusion: 3,
      feature: 8,
      coverage: 9,
      taxonomy: "delivery_order_drop" as const
    },
    {
      label: "head moves gold into top-5 before coverage removes it",
      fusion: 8,
      feature: 3,
      coverage: 8,
      taxonomy: "answer_set_coverage_drop" as const
    }
  ])("verifies $label", ({ fusion, feature, coverage, taxonomy }) => {
    const question = buildPromotionMiss({ fusion, feature, coverage, taxonomy });

    expect(verifyPromotionGoldEvidence({
      question,
      expectedGold: question.gold_memory_ids,
      scorable: true
    })).toEqual({ hitAt1: false, hitAt5: false, hitAt10: false });
  });
});

type PromotionTaxonomy = "delivery_order_drop" | "answer_set_coverage_drop";

interface MutablePromotionQuestion {
  hit_at_1: boolean;
  hit_at_5: boolean;
  hit_at_10: boolean;
  miss_classification: string;
  miss_taxonomy: PromotionTaxonomy | null;
  delivered_results: unknown[];
  candidates: Array<{
    final_rank: number | null;
    fused_rank: number | null;
    rank_after_fusion: number | null;
    rank_after_feature_rerank: number | null;
    rank_after_coverage_selector: number | null;
    coverage_selector_action: "displaced" | null;
  }>;
  gold: Array<{
    candidate_status: string;
    final_rank: number | null;
    fused_rank: number | null;
    rank_after_fusion: number | null;
    rank_after_feature_rerank: number | null;
    rank_after_coverage_selector: number | null;
    coverage_selector_action: "displaced" | null;
    miss_taxonomy: PromotionTaxonomy | null;
  }>;
  cohort_ledger: {
    retrieval_status: string;
    final_verdict: string;
    stage_ranks: Array<{
      fused_rank: number | null;
      rank_after_feature_rerank: number | null;
      rank_after_coverage_selector: number | null;
      final_rank: number | null;
    }>;
  };
}

function buildPromotionMiss(params: Readonly<{
  fusion: number;
  feature: number;
  coverage: number;
  taxonomy: PromotionTaxonomy;
}>): LongMemEvalQuestionDiagnostic {
  const mutable = structuredClone(
    promotionMeasurementDiagnostic("q-feature-rank", "scorable", true)
  ) as unknown as MutablePromotionQuestion;
  const candidate = mutable.candidates[0]!;
  Object.assign(candidate, {
    final_rank: null,
    fused_rank: params.fusion,
    rank_after_fusion: params.fusion,
    rank_after_feature_rerank: params.feature,
    rank_after_coverage_selector: params.coverage,
    coverage_selector_action: "displaced"
  });
  Object.assign(mutable.gold[0]!, {
    candidate_status: "candidate_not_delivered",
    final_rank: null,
    fused_rank: params.fusion,
    rank_after_fusion: params.fusion,
    rank_after_feature_rerank: params.feature,
    rank_after_coverage_selector: params.coverage,
    coverage_selector_action: "displaced",
    miss_taxonomy: params.taxonomy
  });
  Object.assign(mutable.cohort_ledger.stage_ranks[0]!, {
    fused_rank: params.fusion,
    rank_after_feature_rerank: params.feature,
    rank_after_coverage_selector: params.coverage,
    final_rank: null
  });
  Object.assign(mutable, {
    hit_at_1: false,
    hit_at_5: false,
    hit_at_10: false,
    miss_classification: "under_ranked",
    miss_taxonomy: params.taxonomy,
    delivered_results: []
  });
  mutable.cohort_ledger.retrieval_status = "miss_at_5";
  mutable.cohort_ledger.final_verdict = "miss_at_5";
  return LongMemEvalQuestionDiagnosticSchema.parse(mutable);
}
