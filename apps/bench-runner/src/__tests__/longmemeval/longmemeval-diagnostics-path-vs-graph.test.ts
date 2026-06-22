import { describe, expect, it } from "vitest";

import { BenchRecallDiagnosticsSchema } from "../../harness/recall-diagnostics-schema.js";

import {
  LongMemEvalGoldDiagnosticSchema,
  LongMemEvalQuestionDiagnosticSchema
} from "../../longmemeval/diagnostics-schema.js";

import {
  buildLongMemEvalQualityMetrics,
  buildQuestionDiagnostic,
  summarizeLongMemEvalRecallEvidence,
  type LongMemEvalQuestionDiagnostic
} from "../../longmemeval/diagnostics.js";

const emptyQueryProbes = {
  object_ids: [],
  subject_hints: [],
  evidence_refs: [],
  run_ids: [],
  surface_ids: [],
  file_paths: [],
  command_names: [],
  package_names: [],
  task_refs: [],
  dimensions: [],
  scope_classes: [],
  domain_tags: [],
  lexical_terms: [],
  expanded_terms: [],
  phrases: [],
  char_ngrams: [],
  date_terms: []
};

describe("LongMemEval recall diagnostics", () => {

  describe("N-1 — path_vs_graph_fanin does not over-report hop-1 path golds as graph-bearing", () => {
    const buildGold = (
      overrides: Partial<Record<string, unknown>> & { object_id: string }
    ) => ({
      candidate_status: "delivered" as const,
      final_rank: 1,
      active_constraint_rank: null,
      pre_budget_rank: 1,
      selection_order: 1,
      fused_rank: 1,
      fused_score: 0.5,
      per_stream_rank: null,
      fused_rank_contribution_per_stream: null,
      plane_first_admitted: null,
      plane_winning_admission: null,
      source_planes: [] as readonly string[],
      lexical_rank: null,
      structural_score: null,
      score_factors: null,
      source_channels: [] as readonly string[],
      budget_drop_reason: null,
      ...overrides
    });

    const buildQuestion = (gold: ReadonlyArray<ReturnType<typeof buildGold>>) =>
      ({
        question_id: "q-path-vs-graph",
        round_index: null,
        gold_memory_ids: gold.map((g) => g.object_id),
        answer_session_ids: ["session-a"],
        delivered_results: [],
        active_constraint_results: [],
        hit_at_1: true,
        hit_at_5: true,
        hit_at_10: true,
        miss_classification: "hit_at_5" as const,
        degradation_reason: null,
        recall_diagnostics_present: true,
        recall_diagnostics_keys: [],
        provider_state: "disabled" as const,
        provider_degradation_reason: null,
        graph_expansion_plane_count_per_hop: [0, 0] as const,
        graph_expansion_plane_count_per_edge_type: {
          derives_from: 0,
          recalls: 0,
          supports: 0
        },
        candidate_key_collisions: [],
        gold
      }) as unknown as LongMemEvalQuestionDiagnostic;

    it("counts a hop-1 path gold (path plane + graphSupport-polluted per_stream_rank) as path-primary, NOT graph", () => {
      // The hop-1 path gold fired a nonzero graph_expansion per_stream_rank purely
      // from the graphSupport inbound aggregate, but it was admitted on the
      // path_expansion plane. It must be counted path-primary and NOT in
      // graph_gold_*.
      const hop1PathGold = buildGold({
        object_id: "gold-hop1-path",
        final_rank: 3,
        source_planes: ["path_expansion"],
        plane_first_admitted: "path_expansion",
        plane_winning_admission: "path_expansion",
        per_stream_rank: { path_expansion: 0.3, graph_expansion: 0.04 }
      });
      const metrics = buildLongMemEvalQualityMetrics([buildQuestion([hop1PathGold])]);
      const fanin = metrics.path_vs_graph_fanin;
      expect(fanin).toBeDefined();
      if (!fanin) throw new Error("path_vs_graph_fanin missing");

      expect(fanin.path_gold_source_count).toBe(1);
      expect(fanin.path_gold_hit_at_5_count).toBe(1);
      expect(fanin.path_primary_hit_at_5_count).toBe(1);
      // The polluted per_stream_rank must NOT mark it graph-bearing.
      expect(fanin.graph_gold_source_count).toBe(0);
      expect(fanin.graph_gold_hit_at_5_count).toBe(0);
      expect(fanin.graph_only_hit_at_5_count).toBe(0);
    });

    it("counts a genuine multi-hop graph gold (graph admission plane) as graph_only", () => {
      // Admitted on the graph_expansion plane (multi-hop reach, double-count guard
      // excludes any path_expansion-admitted target), so it is the genuine
      // multi-hop signal: graph_gold_* and graph_only_*.
      const multiHopGraphGold = buildGold({
        object_id: "gold-multihop-graph",
        final_rank: 4,
        source_planes: ["graph_expansion"],
        plane_first_admitted: "graph_expansion",
        plane_winning_admission: "graph_expansion",
        per_stream_rank: { graph_expansion: 0.2 }
      });
      const metrics = buildLongMemEvalQualityMetrics([buildQuestion([multiHopGraphGold])]);
      const fanin = metrics.path_vs_graph_fanin;
      expect(fanin).toBeDefined();
      if (!fanin) throw new Error("path_vs_graph_fanin missing");

      expect(fanin.graph_gold_source_count).toBe(1);
      expect(fanin.graph_gold_hit_at_5_count).toBe(1);
      expect(fanin.graph_only_hit_at_5_count).toBe(1);
      // It bears no direct hop-1 path term, so it is not path-primary.
      expect(fanin.path_gold_source_count).toBe(0);
      expect(fanin.path_primary_hit_at_5_count).toBe(0);
    });
  });
});
