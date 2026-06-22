import { describe, expect, it } from "vitest";

import { buildLongMemEvalQualityMetrics } from "../../longmemeval/diagnostics.js";
import {
  buildGoldDiagnostic,
  buildQuestionDiagnosticFixture
} from "./gold-diagnostic-fixture.js";

describe("LongMemEval recall diagnostics", () => {

  describe("N-1 — path_vs_graph_fanin does not over-report hop-1 path golds as graph-bearing", () => {
    const buildGold = buildGoldDiagnostic;
    const buildQuestion = (
      gold: ReadonlyArray<ReturnType<typeof buildGold>>
    ) => buildQuestionDiagnosticFixture({ questionId: "q-path-vs-graph", gold });

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
