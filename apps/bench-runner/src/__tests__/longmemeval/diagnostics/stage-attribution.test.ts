import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  buildStageAttributionTables,
  classifyGoldObjectStage,
  classifyQuestionStage,
  writeStageAttributionTables
} from "../../../bench/diagnostics/stage-attribution/index.js";
import { baseQuestion } from "./stage-attribution-fixture.js";

const WORKTREE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../../../" // diagnostics → worktree root
);

const P81_ROOT = path.join(
  WORKTREE_ROOT,
  ".do-it/bench-runs/recall-any5-evidence-first/p81-500q-f0-baseline-9e58d32/staging"
);
const P81_A = path.join(
  P81_ROOT,
  "A/public/2026-07-29T024722Z-9e58d32-policy-stress-recall-eval-snapshot/recall-eval-diagnostics.json.gz"
);
const P81_B = path.join(
  P81_ROOT,
  "B/public/2026-07-29T025954Z-9e58d32-policy-stress-recall-eval-snapshot/recall-eval-diagnostics.json.gz"
);
const OUT_DIR = path.join(
  WORKTREE_ROOT,
  ".do-it/bench-runs/recall-any5-evidence-first/gate1-stage-attribution"
);

function gold(overrides: Record<string, unknown> & { object_id: string }) {
  return {
    object_id: overrides.object_id,
    object_kind: "memory_entry",
    candidate_status: "candidate_not_delivered",
    dimension: null,
    final_rank: null,
    active_constraint_rank: null,
    pre_budget_rank: null,
    selection_order: null,
    fused_rank: null,
    fused_score: null,
    answer_relevance_score: null,
    answer_relevance_rank: null,
    per_stream_rank: null,
    fused_rank_contribution_per_stream: null,
    per_axis_rank: null,
    per_axis_contribution: null,
    flood_potential: null,
    flood_fuel_coverage: null,
    plane_first_admitted: null,
    plane_winning_admission: null,
    source_planes: [],
    miss_taxonomy: null,
    lexical_rank: null,
    structural_score: null,
    score_factors: null,
    source_channels: [],
    budget_drop_reason: null,
    rank_after_fusion: null,
    rank_after_feature_rerank: null,
    rank_after_lexical_priority: null,
    rank_after_synthesis_reserve: null,
    rank_after_structural_reserve: null,
    rank_after_coverage_selector: null,
    rank_after_session_coverage: null,
    coverage_selector_action: null,
    session_coverage_action: null,
    session_key: null,
    source_cohort_key: null,
    reserved_by: null,
    ...overrides
  };
}

describe("gate1 stage attribution (fixtures)", () => {
  it("classifies gold-object stages for write / pool / prune / coverage / near-top / delivered", () => {
    const writeQ = baseQuestion({
      question_id: "q-write",
      miss_classification: "candidate_absent",
      miss_taxonomy: "candidate_absent",
      gold_memory_ids: [],
      gold_object_ids: [],
      cohort_ledger: {
        dataset_cohort: "answerable",
        extraction_materialization: {
          status: "drop",
          emitted_memory_count: 0,
          reason: "candidate_absent"
        },
        evaluator_gold_identity: { status: "absent", object_ids: [] },
        retrieval_status: "miss_at_5",
        evidence_status: "missing",
        evaluation_issue_reason: "extraction_materialization_drop",
        candidate_pool_complete: true,
        stage_ranks: [],
        final_verdict: "miss_at_5"
      }
    });
    expect(classifyQuestionStage(writeQ).stage).toBe(1);

    const f3Q = baseQuestion({
      question_id: "q-f3",
      gold_memory_ids: ["g-f3"],
      miss_taxonomy: "candidate_absent",
      query_open_semantic_factor_formation: {
        schema_version: 1,
        operator_id: "open_semantic_factor_formation_v1",
        status: "rejected",
        producer_operator_id: null,
        source_sha256: null,
        graph: null,
        capture_digest: `sha256:${"a".repeat(64)}`
      },
      cohort_ledger: {
        dataset_cohort: "answerable",
        extraction_materialization: {
          status: "memory_emitted",
          emitted_memory_count: 1,
          reason: null
        },
        evaluator_gold_identity: { status: "present", object_ids: ["g-f3"] },
        retrieval_status: "miss_at_5",
        evidence_status: "complete",
        evaluation_issue_reason: null,
        candidate_pool_complete: true,
        stage_ranks: [],
        final_verdict: "miss_at_5"
      }
    });
    expect(classifyQuestionStage(f3Q).proof).toBe("semantic_factor_formation_rejected");

    const unavailableQ = {
      ...f3Q,
      question_id: "q-f3-unavailable",
      query_open_semantic_factor_formation: {
        ...f3Q.query_open_semantic_factor_formation!,
        status: "unavailable" as const
      }
    };
    expect(classifyQuestionStage(unavailableQ).proof).toBe(
      "miss_taxonomy.candidate_absent_with_emitted_gold"
    );

    const poolQ = baseQuestion({
      question_id: "q-pool",
      gold_memory_ids: ["g-pool"],
      miss_taxonomy: "candidate_absent",
      cohort_ledger: {
        dataset_cohort: "answerable",
        extraction_materialization: {
          status: "memory_emitted",
          emitted_memory_count: 1,
          reason: null
        },
        evaluator_gold_identity: { status: "present", object_ids: ["g-pool"] },
        retrieval_status: "miss_at_5",
        evidence_status: "complete",
        evaluation_issue_reason: null,
        candidate_pool_complete: true,
        stage_ranks: [],
        final_verdict: "miss_at_5"
      },
      gold: [
        gold({
          object_id: "g-pool",
          candidate_status: "candidate_absent",
          miss_taxonomy: "candidate_absent"
        })
      ]
    });
    const poolGold = classifyGoldObjectStage({
      question: poolQ,
      gold: poolQ.gold[0]!,
      opportunityQuestion: false
    });
    expect(poolGold.stage).toBe(2);

    const pruneQ = baseQuestion({
      question_id: "q-prune",
      gold_memory_ids: ["g-prune"],
      miss_taxonomy: "fine_assessment_drop",
      fine_assessment_pruned_candidates: [
        {
          candidate_key: "k",
          origin_plane: "workspace_local",
          object_kind: "memory_entry",
          object_id: "g-prune",
          coarse_index: 40,
          drop_reason: "fine_assessment_cap"
        }
      ],
      gold: [
        gold({
          object_id: "g-prune",
          candidate_status: "candidate_absent",
          miss_taxonomy: "fine_assessment_drop"
        })
      ]
    });
    expect(
      classifyGoldObjectStage({
        question: pruneQ,
        gold: pruneQ.gold[0]!,
        opportunityQuestion: false
      }).stage
    ).toBe(3);

    const coverageGold = gold({
      object_id: "g-cov",
      pre_budget_rank: 4,
      fused_rank: 4,
      rank_after_feature_rerank: 4,
      rank_after_coverage_selector: 8,
      miss_taxonomy: "answer_set_coverage_drop",
      candidate_status: "candidate_not_delivered"
    });
    const coverageQ = baseQuestion({
      question_id: "q-cov",
      gold_memory_ids: ["g-cov"],
      miss_taxonomy: "answer_set_coverage_drop",
      gold: [coverageGold]
    });
    const coverageRow = classifyGoldObjectStage({
      question: coverageQ,
      gold: coverageGold,
      opportunityQuestion: true
    });
    expect(coverageRow.stage).toBe(5);
    expect(coverageRow.mechanism).toBe("coverage_admission");
    expect(coverageRow.opportunity_pre_budget_6_10).toBe(true);

    const nearTop = gold({
      object_id: "g-near",
      pre_budget_rank: 7,
      fused_rank: 7,
      miss_taxonomy: "delivery_order_drop",
      candidate_status: "candidate_not_delivered"
    });
    const nearQ = baseQuestion({
      question_id: "q-near",
      gold_memory_ids: ["g-near"],
      miss_taxonomy: "delivery_order_drop",
      gold: [nearTop]
    });
    const nearRow = classifyQuestionStage(nearQ);
    expect(nearRow.stage).toBe(6);
    expect(nearRow.opportunity_pre_budget_6_10).toBe(true);
    expect(nearRow.mechanism).toBe("composition");

    const residual = gold({
      object_id: "g-res",
      pre_budget_rank: 3,
      fused_rank: 3,
      miss_taxonomy: "delivery_order_drop",
      candidate_status: "candidate_not_delivered"
    });
    const residualQ = baseQuestion({
      question_id: "q-res",
      gold_memory_ids: ["g-res"],
      miss_taxonomy: "delivery_order_drop",
      gold: [residual]
    });
    expect(classifyQuestionStage(residualQ).mechanism).toBe("residual_order");

    const hitQ = baseQuestion({
      question_id: "q-hit",
      hit_at_5: true,
      hit_at_1: true,
      hit_at_10: true,
      miss_classification: "hit_at_5",
      miss_taxonomy: null,
      gold_memory_ids: ["g-hit"],
      gold: [
        gold({
          object_id: "g-hit",
          final_rank: 1,
          pre_budget_rank: 1,
          fused_rank: 1,
          candidate_status: "delivered",
          miss_taxonomy: null
        })
      ]
    });
    expect(classifyQuestionStage(hitQ).stage).toBe(7);
  });

  it("keeps the three candidate-absence views separate with explicit denominators", () => {
    const questions = [
      baseQuestion({
        question_id: "q-empty",
        miss_classification: "candidate_absent",
        miss_taxonomy: "candidate_absent",
        gold_memory_ids: [],
        gold_object_ids: [],
        cohort_ledger: {
          dataset_cohort: "answerable",
          extraction_materialization: {
            status: "drop",
            emitted_memory_count: 0,
            reason: "candidate_absent"
          },
          evaluator_gold_identity: { status: "absent", object_ids: [] },
          retrieval_status: "miss_at_5",
          evidence_status: "missing",
          evaluation_issue_reason: "extraction_materialization_drop",
          candidate_pool_complete: true,
          stage_ranks: [],
          final_verdict: "miss_at_5"
        }
      }),
      baseQuestion({
        question_id: "q-pool-absent",
        miss_taxonomy: "candidate_absent",
        gold_memory_ids: ["g1"],
        cohort_ledger: {
          dataset_cohort: "answerable",
          extraction_materialization: {
            status: "memory_emitted",
            emitted_memory_count: 1,
            reason: null
          },
          evaluator_gold_identity: { status: "present", object_ids: ["g1"] },
          retrieval_status: "miss_at_5",
          evidence_status: "complete",
          evaluation_issue_reason: null,
          candidate_pool_complete: true,
          stage_ranks: [],
          final_verdict: "miss_at_5"
        },
        gold: [
          gold({
            object_id: "g1",
            candidate_status: "candidate_absent",
            miss_taxonomy: "candidate_absent"
          })
        ]
      }),
      baseQuestion({
        question_id: "q-fine-unranked",
        miss_taxonomy: "fine_assessment_drop",
        gold_memory_ids: ["g2"],
        fine_assessment_pruned_candidates: [
          {
            candidate_key: "k2",
            origin_plane: "workspace_local",
            object_kind: "memory_entry",
            object_id: "g2",
            coarse_index: 10,
            drop_reason: "fine_assessment_cap"
          }
        ],
        gold: [
          gold({
            object_id: "g2",
            candidate_status: "candidate_absent",
            miss_taxonomy: "fine_assessment_drop"
          })
        ]
      }),
      baseQuestion({
        question_id: "q-hit",
        hit_at_5: true,
        miss_classification: "hit_at_5",
        gold_memory_ids: ["g3"],
        gold: [
          gold({
            object_id: "g3",
            final_rank: 2,
            pre_budget_rank: 2,
            fused_rank: 2,
            candidate_status: "delivered"
          })
        ]
      }),
      baseQuestion({
        question_id: "q-abs_abs",
        is_abstention: true,
        miss_classification: "abstention",
        cohort_ledger: {
          dataset_cohort: "abstention",
          extraction_materialization: {
            status: "unknown",
            emitted_memory_count: 0,
            reason: null
          },
          evaluator_gold_identity: { status: "absent", object_ids: [] },
          retrieval_status: "not_applicable",
          evidence_status: "missing",
          evaluation_issue_reason: null,
          candidate_pool_complete: false,
          stage_ranks: [],
          final_verdict: "abstention_uncalibrated"
        }
      })
    ];

    const tables = buildStageAttributionTables({
      cell: "fixture",
      sourceDiagnostics: "fixture",
      questions
    });

    expect(tables.summary.denominators).toEqual({
      D_Q_evaluated: 5,
      D_Q_scorable: 4,
      D_Q_gold_bearing: 3,
      D_Q_miss: 3,
      D_G_all: 3
    });

    const views = tables.summary.candidate_absence_views;
    expect(views.miss_taxonomy_candidate_absent.count).toBe(2);
    expect(views.miss_taxonomy_candidate_absent.denominator).toBe(3);
    expect(views.quality_candidate_absent_count.count).toBe(1);
    expect(views.quality_candidate_absent_count.denominator).toBe(4);
    expect(views.rank_bucket_candidate_absent.count).toBe(2);
    expect(views.rank_bucket_candidate_absent.denominator).toBe(3);
    expect(
      views.miss_taxonomy_candidate_absent.count +
        views.quality_candidate_absent_count.count +
        views.rank_bucket_candidate_absent.count
    ).not.toBe(views.miss_taxonomy_candidate_absent.count);
  });
});

describe("gate1 stage attribution (p81 diagnostics)", () => {
  it.skipIf(!existsSync(P81_A) || !existsSync(P81_B))(
    "builds A/B stage tables with KPI pre610 23/6 and delivery_order 83/44",
    async () => {
      const tables = await writeStageAttributionTables({
        outDir: OUT_DIR,
        cells: [
          { cell: "A", diagnosticsPath: P81_A },
          { cell: "B", diagnosticsPath: P81_B }
        ]
      });

      expect(tables.A.summary.denominators.D_Q_scorable).toBe(470);
      expect(tables.B.summary.denominators.D_Q_scorable).toBe(470);
      expect(tables.A.summary.denominators.D_Q_gold_bearing).toBe(467);
      expect(tables.B.summary.denominators.D_Q_gold_bearing).toBe(467);
      expect(tables.A.summary.denominators.D_Q_miss).toBe(97);
      expect(tables.B.summary.denominators.D_Q_miss).toBe(49);

      expect(tables.A.summary.kpi_pre_budget_6_10).toBe(23);
      expect(tables.B.summary.kpi_pre_budget_6_10).toBe(6);
      expect(tables.A.summary.delivery_order_drop).toBe(83);
      expect(tables.B.summary.delivery_order_drop).toBe(44);

      expect(
        tables.A.summary.candidate_absence_views.miss_taxonomy_candidate_absent.count
      ).toBe(5);
      expect(
        tables.B.summary.candidate_absence_views.miss_taxonomy_candidate_absent.count
      ).toBe(4);
      expect(
        tables.A.summary.candidate_absence_views.quality_candidate_absent_count.count
      ).toBe(3);
      expect(
        tables.B.summary.candidate_absence_views.quality_candidate_absent_count.count
      ).toBe(3);
      expect(
        tables.A.summary.candidate_absence_views.rank_bucket_candidate_absent.count
      ).toBe(3);
      expect(
        tables.B.summary.candidate_absence_views.rank_bucket_candidate_absent.count
      ).toBe(2);

      const stageSumA = Object.values(tables.A.summary.question_stage_counts).reduce(
        (a, b) => a + b,
        0
      );
      expect(stageSumA).toBe(470);
      expect(existsSync(path.join(OUT_DIR, "stage-tables-a.json"))).toBe(true);
      expect(existsSync(path.join(OUT_DIR, "stage-tables-b.json"))).toBe(true);
    },
    180_000
  );
});
