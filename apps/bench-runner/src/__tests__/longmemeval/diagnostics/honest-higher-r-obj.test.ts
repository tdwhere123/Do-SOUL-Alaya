import { describe, expect, it } from "vitest";
import type { RecallFusionFamilyId } from "@do-soul/alaya-core";
import { classifyHonestHigherRObj } from
  "../../../diagnostics/stage-attribution/honest-higher-r-obj.js";
import { classifyGoldObjectStage } from
  "../../../diagnostics/stage-attribution/classify-gold.js";
import { classifyQuestionStage } from
  "../../../diagnostics/stage-attribution/classify-question.js";
import type {
  DiagnosticStreamContributions,
  LongMemEvalQuestionDiagnostic
} from "../../../diagnostics/schema/diagnostics-types.js";
import { baseQuestion } from "./stage-attribution-fixture.js";

type ReplayCandidate = LongMemEvalQuestionDiagnostic["candidates"][number];
type GoldDiagnostic = LongMemEvalQuestionDiagnostic["gold"][number];

function candidate(overrides: {
  readonly object_id: string;
  readonly final_rank: number | null;
  readonly fused_rank: number | null;
  readonly selection_order?: number | null;
  readonly fused_rank_contribution_per_stream:
    DiagnosticStreamContributions | null;
  readonly deep_head_trace?: ReplayCandidate["deep_head_trace"];
}): ReplayCandidate {
  return {
    object_id: overrides.object_id,
    object_kind: "memory_entry",
    candidate_key: `memory_entry:${overrides.object_id}`,
    origin_plane: "workspace_local",
    dimension: null,
    final_rank: overrides.final_rank,
    pre_budget_rank: overrides.fused_rank,
    selection_order: overrides.selection_order ?? overrides.final_rank,
    admission_attempts: [],
    evidence_projection_matches: [],
    fused_rank: overrides.fused_rank,
    fused_score: null,
    answer_relevance_score: null,
    answer_relevance_rank: null,
    per_stream_rank: null,
    fused_rank_contribution_per_stream:
      overrides.fused_rank_contribution_per_stream,
    per_axis_rank: null,
    per_axis_contribution: null,
    flood_potential: null,
    flood_fuel_coverage: null,
    plane_first_admitted: null,
    plane_winning_admission: null,
    source_planes: [],
    source_channels: [],
    lexical_rank: null,
    structural_score: null,
    budget_drop_reason: null,
    rank_after_fusion: overrides.fused_rank,
    rank_after_feature_rerank: overrides.fused_rank,
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
    answer_features: null,
    deep_head_trace: overrides.deep_head_trace ?? null,
    coverage_marginal_gain: null,
    selector_observation: null,
    path_suppression_score: null,
    score_factors: {}
  };
}

function goldRow(overrides: {
  readonly object_id: string;
  readonly fused_rank: number;
  readonly selection_order?: number | null;
  readonly fused_rank_contribution_per_stream:
    DiagnosticStreamContributions | null;
  readonly rank_after_feature_rerank?: number | null;
  readonly rank_after_coverage_selector?: number | null;
}): GoldDiagnostic {
  return {
    object_id: overrides.object_id,
    object_kind: "memory_entry",
    candidate_status: "candidate_not_delivered",
    dimension: null,
    final_rank: null,
    active_constraint_rank: null,
    pre_budget_rank: overrides.fused_rank,
    selection_order: overrides.selection_order ?? null,
    fused_rank: overrides.fused_rank,
    fused_score: null,
    answer_relevance_score: null,
    answer_relevance_rank: null,
    per_stream_rank: null,
    fused_rank_contribution_per_stream:
      overrides.fused_rank_contribution_per_stream,
    per_axis_rank: null,
    per_axis_contribution: null,
    flood_potential: null,
    flood_fuel_coverage: null,
    plane_first_admitted: null,
    plane_winning_admission: null,
    source_planes: [],
    miss_taxonomy: "delivery_order_drop",
    lexical_rank: null,
    structural_score: null,
    score_factors: null,
    source_channels: [],
    budget_drop_reason: null,
    rank_after_fusion: overrides.fused_rank,
    rank_after_feature_rerank:
      overrides.rank_after_feature_rerank ?? overrides.fused_rank,
    rank_after_lexical_priority: null,
    rank_after_synthesis_reserve: null,
    rank_after_structural_reserve: null,
    rank_after_coverage_selector:
      overrides.rank_after_coverage_selector ?? null,
    rank_after_session_coverage: null,
    coverage_selector_action: null,
    session_coverage_action: null,
    session_key: null,
    source_cohort_key: null,
    reserved_by: null
  };
}

/** Aggregate 0.0425–0.0445 per occupier, all above every findings gold. */
function occupierStreams(rank: number): DiagnosticStreamContributions {
  return {
    lexical_fts: 0.016,
    evidence_structural_agreement: 0.015 - rank * 0.0005,
    temporal_recency: 0.014
  };
}

function occupiers(): readonly ReplayCandidate[] {
  return [1, 2, 3, 4, 5].map((rank) =>
    candidate({
      object_id: `occ-${rank}`,
      final_rank: rank,
      fused_rank: rank,
      fused_rank_contribution_per_stream: occupierStreams(rank)
    })
  );
}

// Family-max aggregate 0.024: structural ballot collapses correlated
// evidence_structural_agreement / source_proximity to one max vote.
const STRUCTURAL_GOLD_STREAMS: DiagnosticStreamContributions = {
  evidence_structural_agreement: 0.012,
  source_proximity: 0.01,
  lexical_fts: 0.008,
  temporal_recency: 0.004,
  embedding_similarity: 0
};

// Family-max aggregate 0.020: temporal_facet wins via workspace_activation.
const TEMPORAL_GOLD_STREAMS: DiagnosticStreamContributions = {
  workspace_activation: 0.013,
  temporal_recency: 0.009,
  lexical_fts: 0.007,
  embedding_similarity: 0
};

interface FindingsCase {
  readonly id: string;
  readonly fusedRank: number;
  readonly family: RecallFusionFamilyId;
  readonly gammaAliasSelectionOrder?: number;
}

/** Mirrors the S11 close-out table: ten E0 near-top misses, fused_rank 6–8. */
const S11_FINDINGS: readonly FindingsCase[] = [
  { id: "g-s11-01", fusedRank: 6, family: "structural" },
  { id: "g-s11-02", fusedRank: 6, family: "structural" },
  { id: "g-s11-03", fusedRank: 6, family: "temporal_facet" },
  { id: "g-s11-04", fusedRank: 7, family: "structural", gammaAliasSelectionOrder: 9 },
  { id: "g-s11-05", fusedRank: 7, family: "temporal_facet" },
  { id: "g-s11-06", fusedRank: 7, family: "structural" },
  { id: "g-s11-07", fusedRank: 7, family: "temporal_facet", gammaAliasSelectionOrder: 10 },
  { id: "g-s11-08", fusedRank: 8, family: "structural" },
  { id: "g-s11-09", fusedRank: 8, family: "temporal_facet" },
  { id: "g-s11-10", fusedRank: 8, family: "structural", gammaAliasSelectionOrder: 6 }
];

function findingsQuestion(entry: FindingsCase): LongMemEvalQuestionDiagnostic {
  const streams =
    entry.family === "structural"
      ? STRUCTURAL_GOLD_STREAMS
      : TEMPORAL_GOLD_STREAMS;
  const gold = goldRow({
    object_id: entry.id,
    fused_rank: entry.fusedRank,
    selection_order: entry.gammaAliasSelectionOrder ?? null,
    fused_rank_contribution_per_stream: streams
  });
  return baseQuestion({
    question_id: `q-${entry.id}`,
    miss_taxonomy: "delivery_order_drop",
    gold_memory_ids: [entry.id],
    candidates: [
      ...occupiers(),
      candidate({
        object_id: entry.id,
        final_rank: null,
        fused_rank: entry.fusedRank,
        selection_order: entry.gammaAliasSelectionOrder ?? null,
        fused_rank_contribution_per_stream: streams,
        deep_head_trace: null
      })
    ],
    gold: [gold]
  });
}

describe("classifyHonestHigherRObj (S11 findings table)", () => {
  it.each(S11_FINDINGS)(
    "classifies $id (fused_rank $fusedRank, $family) as honest_higher_r_obj",
    (entry) => {
      const question = findingsQuestion(entry);
      const gold = question.gold[0]!;

      const verdict = classifyHonestHigherRObj({ question, gold });
      expect(verdict.classification).toBe("honest_higher_r_obj");
      expect(verdict.gold_winning_family).toBe(entry.family);
      expect(verdict.gold_family_max).not.toBeNull();
      expect(verdict.rank5_family_max).not.toBeNull();
      expect(verdict.gold_family_max!).toBeLessThan(verdict.rank5_family_max!);
      expect(verdict.e0_control).toBe(true);

      const row = classifyGoldObjectStage({
        question,
        gold,
        opportunityQuestion: true
      });
      expect(row.stage).toBe("near_top_final_order");
      expect(row.mechanism).toBe("honest_higher_r_obj");
      expect(row.near_top_class).toBe("honest_higher_r_obj");
      expect(row.gold_family_max).toBe(verdict.gold_family_max);
      expect(row.rank5_family_max).toBe(verdict.rank5_family_max);

      const questionRow = classifyQuestionStage(question);
      expect(questionRow.stage).toBe("near_top_final_order");
      expect(questionRow.mechanism).toBe("honest_higher_r_obj");
    }
  );

  it("keeps Gamma-alias selection_order out of the verdict", () => {
    const aliased = S11_FINDINGS.filter(
      (entry) => entry.gammaAliasSelectionOrder !== undefined
    );
    expect(aliased.length).toBeGreaterThan(0);
    for (const entry of aliased) {
      const question = findingsQuestion(entry);
      const verdict = classifyHonestHigherRObj({
        question,
        gold: question.gold[0]!
      });
      expect(verdict.classification).toBe("honest_higher_r_obj");
    }
  });
});

describe("classifyHonestHigherRObj boundaries", () => {
  it("stays composition when the gold family-max ties a rank-5 occupier", () => {
    const question = baseQuestion({
      question_id: "q-tie",
      miss_taxonomy: "delivery_order_drop",
      gold_memory_ids: ["g-tie"],
      candidates: occupiers(),
      gold: [
        goldRow({
          object_id: "g-tie",
          fused_rank: 6,
          // Same ledger as the weakest occupier — not strictly below all.
          fused_rank_contribution_per_stream: occupierStreams(5)
        })
      ]
    });
    const gold = question.gold[0]!;
    expect(classifyHonestHigherRObj({ question, gold }).classification)
      .toBeNull();
    const row = classifyGoldObjectStage({
      question,
      gold,
      opportunityQuestion: true
    });
    expect(row.stage).toBe("near_top_final_order");
    expect(row.mechanism).toBe("composition");
    expect(row.near_top_class).toBeNull();
  });

  it("keeps residual_order for fused top-5 golds lost after fusion", () => {
    const question = baseQuestion({
      question_id: "q-residual",
      miss_taxonomy: "delivery_order_drop",
      gold_memory_ids: ["g-residual"],
      candidates: occupiers(),
      gold: [
        goldRow({
          object_id: "g-residual",
          fused_rank: 3,
          fused_rank_contribution_per_stream: STRUCTURAL_GOLD_STREAMS,
          rank_after_feature_rerank: 8
        })
      ]
    });
    const gold = question.gold[0]!;
    expect(classifyHonestHigherRObj({ question, gold }).classification)
      .toBeNull();
    expect(
      classifyGoldObjectStage({
        question,
        gold,
        opportunityQuestion: true
      }).mechanism
    ).toBe("residual_order");
  });

  it("refuses the verdict when a coverage displacement signal exists", () => {
    const question = baseQuestion({
      question_id: "q-coverage",
      miss_taxonomy: "delivery_order_drop",
      gold_memory_ids: ["g-coverage"],
      candidates: occupiers(),
      gold: [
        goldRow({
          object_id: "g-coverage",
          fused_rank: 6,
          fused_rank_contribution_per_stream: STRUCTURAL_GOLD_STREAMS,
          rank_after_feature_rerank: 4,
          rank_after_coverage_selector: 8
        })
      ]
    });
    const verdict = classifyHonestHigherRObj({
      question,
      gold: question.gold[0]!
    });
    expect(verdict.classification).toBeNull();
  });

  it("falls back to composition when an occupier ledger is missing", () => {
    const withHole = [
      ...occupiers().slice(0, 4),
      candidate({
        object_id: "occ-5",
        final_rank: 5,
        fused_rank: 5,
        fused_rank_contribution_per_stream: null
      })
    ];
    const question = baseQuestion({
      question_id: "q-hole",
      miss_taxonomy: "delivery_order_drop",
      gold_memory_ids: ["g-hole"],
      candidates: withHole,
      gold: [
        goldRow({
          object_id: "g-hole",
          fused_rank: 6,
          fused_rank_contribution_per_stream: STRUCTURAL_GOLD_STREAMS
        })
      ]
    });
    const gold = question.gold[0]!;
    expect(classifyHonestHigherRObj({ question, gold }).classification)
      .toBeNull();
    expect(
      classifyGoldObjectStage({
        question,
        gold,
        opportunityQuestion: true
      }).mechanism
    ).toBe("composition");
  });

  it("reads occupiers from delivered_results when candidates are absent", () => {
    const question = baseQuestion({
      question_id: "q-delivered",
      miss_taxonomy: "delivery_order_drop",
      gold_memory_ids: ["g-delivered"],
      delivered_results: [1, 2, 3, 4, 5].map((rank) => ({
        object_id: `occ-${rank}`,
        dimension: null,
        rank,
        relevance_score: 1 - rank * 0.1,
        fused_rank: rank,
        fused_score: null,
        per_stream_rank: null,
        fused_rank_contribution_per_stream: occupierStreams(rank),
        per_axis_rank: null,
        per_axis_contribution: null,
        flood_potential: null,
        flood_fuel_coverage: null,
        plane_first_admitted: null,
        plane_winning_admission: null,
        score_factors: null
      })),
      gold: [
        goldRow({
          object_id: "g-delivered",
          fused_rank: 7,
          fused_rank_contribution_per_stream: TEMPORAL_GOLD_STREAMS
        })
      ]
    });
    const verdict = classifyHonestHigherRObj({
      question,
      gold: question.gold[0]!
    });
    expect(verdict.classification).toBe("honest_higher_r_obj");
    expect(verdict.gold_winning_family).toBe("temporal_facet");
  });

  it("reports e0_control=false for a live embedding vote without changing the verdict", () => {
    const question = baseQuestion({
      question_id: "q-e-live",
      miss_taxonomy: "delivery_order_drop",
      gold_memory_ids: ["g-e-live"],
      candidates: occupiers(),
      gold: [
        goldRow({
          object_id: "g-e-live",
          fused_rank: 6,
          fused_rank_contribution_per_stream: {
            ...STRUCTURAL_GOLD_STREAMS,
            embedding_similarity: 0.003
          }
        })
      ]
    });
    const verdict = classifyHonestHigherRObj({
      question,
      gold: question.gold[0]!
    });
    expect(verdict.e0_control).toBe(false);
    expect(verdict.classification).toBe("honest_higher_r_obj");
  });

  it("returns no verdict when the gold ledger itself is missing", () => {
    const question = baseQuestion({
      question_id: "q-no-ledger",
      miss_taxonomy: "delivery_order_drop",
      gold_memory_ids: ["g-no-ledger"],
      candidates: occupiers(),
      gold: [
        goldRow({
          object_id: "g-no-ledger",
          fused_rank: 6,
          fused_rank_contribution_per_stream: null
        })
      ]
    });
    const verdict = classifyHonestHigherRObj({
      question,
      gold: question.gold[0]!
    });
    expect(verdict.classification).toBeNull();
    expect(verdict.gold_family_max).toBeNull();
  });
});
