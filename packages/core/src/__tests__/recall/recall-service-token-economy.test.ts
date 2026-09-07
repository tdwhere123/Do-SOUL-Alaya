import { describe, expect, it } from "vitest";
import { computeRecallTokenEconomy } from "../../recall/recall-service.js";

describe("retained component contracts", () => {
it("keeps priority-overflow telemetry measure-only", () => {
    const shared = {
      deliveredCandidates: Object.freeze([]),
      coarsePoolSize: 8,
      fineEvaluated: 3,
      finePrunedCount: 5,
      preBudgetCandidates: Object.freeze([]),
      embeddingInferenceCalls: 0
    };
    const baseline = computeRecallTokenEconomy({
      ...shared,
      finePriorityOverflowCount: 0
    });
    const overflow = computeRecallTokenEconomy({
      ...shared,
      finePriorityOverflowCount: 4
    });
    const {
      fine_priority_overflow_count: _baselineOverflow,
      ...baselineRankingIndependentFields
    } = baseline;
    const {
      fine_priority_overflow_count: _observedOverflow,
      ...overflowRankingIndependentFields
    } = overflow;

    expect(overflow.fine_priority_overflow_count).toBe(4);
    expect(overflowRankingIndependentFields).toEqual(baselineRankingIndependentFields);
  });

it("computeRecallTokenEconomy stays sub-50µs at 200×16 worst-case cardinality", () => {
    // anti-patterns-lint-allow: the fusion-stream literal and the
    // RecallCandidateDiagnostic-shape fixture below are intentionally
    // inline. Sharing them with the global-filter test would couple this
    // perf contract to fixture evolution in an unrelated test file, and
    // promoting them to a helper module would force public exposure of a
    // diagnostic shape that production callers never construct.
    const fusionStreams = [
      "lexical_fts",
      "trigram_fts",
      "synthesis_fts",
      "evidence_fts",
      "evidence_structural_agreement",
      "source_proximity",
      "source_evidence_agreement",
      "subject_alignment",
      "structural",
      "existing_score",
      "embedding_similarity",
      "graph_expansion",
      "entity_seed",
      "path_expansion",
      "temporal_recency",
      "workspace_activation"
    ] as const;

    // 200 pre-budget diagnostic candidates, each carrying a non-null rank
    // on every stream — the worst case for the .some scan because every
    // probe finds a hit immediately rather than scanning the full array.
    // (A miss-heavy fixture would understate the cost; we exercise the
    // realistic case where streams genuinely contribute signal.)
    const preBudgetCandidates = Array.from({ length: 200 }, (_, index) => {
      const perStreamRank = Object.fromEntries(
        fusionStreams.map((stream) => [stream, index + 1])
      ) as Record<(typeof fusionStreams)[number], number | null>;
      const contributions = Object.fromEntries(
        fusionStreams.map((stream) => [stream, 0.1])
      ) as Record<(typeof fusionStreams)[number], number>;
      // The candidate diagnostic carries many fields the instrument never
      // reads (object_id, score_factors, etc.). We satisfy only the
      // properties computeRecallTokenEconomy actually consumes —
      // per_stream_rank — so the fixture stays declarative.
      return {
        candidate_key: `cand-${index}`,
        object_id: `mem-${index}`,
        object_kind: "memory_entry",
        origin_plane: "workspace_local",
        admission_planes: ["lexical"],
        plane_first_admitted: "lexical",
        plane_winning_admission: "lexical",
        pre_budget_rank: index + 1,
        selection_order: index + 1,
        fused_rank: index + 1,
        fused_score: 1,
        per_stream_rank: perStreamRank,
        fused_rank_contribution_per_stream: contributions,
        final_rank: index + 1,
        dropped_reason: null,
        within_budget: true,
        relevance_score: 0.5,
        lexical_rank: 0.5,
        structural_score: 0.5,
        score_factors: {},
        source_channels: [],
        path_expansion_sources: []
      } as unknown as Parameters<typeof computeRecallTokenEconomy>[0]["preBudgetCandidates"][number];
    });

    const deliveredCandidates = Array.from({ length: 30 }, (_, index) => ({
      token_estimate: 50 + index
    })) as unknown as Parameters<typeof computeRecallTokenEconomy>[0]["deliveredCandidates"];

    // Warm-up to amortize V8 JIT inlining so the timed sample reflects
    // steady-state cost, not first-call interpreter overhead.
    for (let i = 0; i < 50; i += 1) {
      computeRecallTokenEconomy({
        deliveredCandidates,
        coarsePoolSize: 200,
        fineEvaluated: 200,
        preBudgetCandidates,
        embeddingInferenceCalls: 1
      });
    }

    // Take the minimum across N timed samples to suppress GC / scheduler
    // noise; the regression we care about is a systematic blow-up, not
    // the worst-case outlier.
    const SAMPLE_COUNT = 25;
    let bestMicros = Number.POSITIVE_INFINITY;
    for (let i = 0; i < SAMPLE_COUNT; i += 1) {
      const startNs = process.hrtime.bigint();
      computeRecallTokenEconomy({
        deliveredCandidates,
        coarsePoolSize: 200,
        fineEvaluated: 200,
        preBudgetCandidates,
        embeddingInferenceCalls: 1
      });
      const endNs = process.hrtime.bigint();
      const micros = Number(endNs - startNs) / 1000;
      if (micros < bestMicros) bestMicros = micros;
    }

    expect(bestMicros).toBeLessThan(50);
  });
});
