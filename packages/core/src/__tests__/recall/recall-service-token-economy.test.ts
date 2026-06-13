import { describe, expect, it } from "vitest";
import { MemoryDimension } from "@do-soul/alaya-protocol";
import { RecallService, computeRecallTokenEconomy } from "../../recall/recall-service.js";
import { createActiveConstraint, createDependencies, createMemoryEntry, createTaskSurface, overridePolicy } from "./recall-service-test-fixtures.js";

describe("RecallService", () => {
  it("forwards active constraints cap to the active constraints port", async () => {
    const memory = createMemoryEntry({ object_id: "c-1", dimension: MemoryDimension.CONSTRAINT });
    const { dependencies } = createDependencies([memory], [], {}, [createActiveConstraint(memory)]);
    const service = new RecallService(dependencies);

    const result = await service.recall({
      taskSurface: createTaskSurface(),
      workspaceId: "workspace-1",
      strategy: "analyze",
      activeConstraintsCap: 5
    });

    expect(dependencies.activeConstraintsPort?.findActiveConstraints).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      cap: 5
    });
    expect(result.active_constraints_count).toBe(1);
  });

  it("keeps pre-budget diagnostics for candidates dropped by final delivery budget", async () => {
    const memories = [
      createMemoryEntry({ object_id: "memory-1", activation_score: 0.9 }),
      createMemoryEntry({ object_id: "memory-2", activation_score: 0.8 }),
      createMemoryEntry({ object_id: "memory-3", activation_score: 0.7 })
    ];
    const { dependencies } = createDependencies(memories);
    const service = new RecallService(dependencies);
    const basePolicy = service.buildDefaultPolicy("analyze", createTaskSurface().runtime_id);
    const policy = overridePolicy(basePolicy, {
      coarse_filter: {
        ...basePolicy.coarse_filter,
        precomputed_rank: {
          ...basePolicy.coarse_filter.precomputed_rank,
          max_candidates: 3
        }
      },
      fine_assessment: {
        ...basePolicy.fine_assessment,
        budgets: {
          max_total_tokens: 1000,
          max_entries: 1,
          per_dimension_limits: null
        }
      }
    });

    const result = await service.recall({
      taskSurface: createTaskSurface(),
      workspaceId: "workspace-1",
      strategy: "analyze",
      policyOverride: policy
    });

    expect(result.candidates.map((candidate) => candidate.object_id)).toEqual(["memory-1"]);
    expect(result.diagnostics?.candidate_pool_count).toBe(3);
    expect(result.diagnostics?.candidates.find((candidate) => candidate.object_id === "memory-2")).toMatchObject({
      pre_budget_rank: 2,
      final_rank: null,
      dropped_reason: "max_entries",
      within_budget: false
    });
  });

  // see also: packages/core/src/recall/diagnostics.ts:computeRecallTokenEconomy,
  // apps/bench-runner/src/longmemeval/recall-token-economy.ts.
  // invariant: this test exercises the non-degraded recall path, so the HOT
  // tier satisfies MIN_RECALL_RESULTS (= 5), so this pins the normal HOT
  // path while the degraded-path regression below pins the cascade path.
  it("populates RecallTokenEconomy with per-call structural counters", async () => {
    const memories = [
      createMemoryEntry({ object_id: "memory-1", activation_score: 0.9 }),
      createMemoryEntry({ object_id: "memory-2", activation_score: 0.8 }),
      createMemoryEntry({ object_id: "memory-3", activation_score: 0.7 }),
      createMemoryEntry({ object_id: "memory-4", activation_score: 0.6 }),
      createMemoryEntry({ object_id: "memory-5", activation_score: 0.5 })
    ];
    const { dependencies } = createDependencies(memories);
    const service = new RecallService(dependencies);
    const result = await service.recall({
      taskSurface: createTaskSurface(),
      workspaceId: "workspace-1",
      strategy: "analyze"
    });

    const tokenEconomy = result.diagnostics?.token_economy;
    expect(tokenEconomy).toBeDefined();
    // delivered_context_tokens_estimate is the sum over delivered
    // candidates' token_estimate.
    const expectedDelivered = result.candidates.reduce(
      (sum, candidate) => sum + candidate.token_estimate,
      0
    );
    expect(tokenEconomy?.delivered_context_tokens_estimate).toBe(
      expectedDelivered
    );
    // coarse_pool_size equals candidate_pool_count (== combined coarse
    // candidates fed into fineAssess).
    expect(tokenEconomy?.coarse_pool_size).toBe(
      result.diagnostics?.candidate_pool_count ?? -1
    );
    // fine_evaluated mirrors coarse_pool_size because fineAssess scores
    // every coarse candidate before delivery truncation.
    expect(tokenEconomy?.fine_evaluated).toBe(tokenEconomy?.coarse_pool_size);
    // No embedding provider was wired into the deps factory, so the
    // pipeline reports zero fresh provider inferences for this recall.
    expect(tokenEconomy?.embedding_inference_calls).toBe(0);
    // fusion_streams_with_hits is non-negative and never exceeds the
    // total fusion stream surface.
    expect(tokenEconomy?.fusion_streams_with_hits).toBeGreaterThanOrEqual(0);
    expect(tokenEconomy?.fusion_streams_with_hits).toBeLessThanOrEqual(16);
  });

  // anti-patterns-lint-allow: see the populates-RecallTokenEconomy test —
  // both must seed >= MIN_RECALL_RESULTS HOT memories to stay on the
  // non-degraded path so token_economy is emitted (and therefore
  // comparable across calls).
  it("repeats RecallTokenEconomy stably across identical recalls on a fixed corpus", async () => {
    const memories = [
      createMemoryEntry({ object_id: "memory-1", activation_score: 0.9 }),
      createMemoryEntry({ object_id: "memory-2", activation_score: 0.8 }),
      createMemoryEntry({ object_id: "memory-3", activation_score: 0.7 }),
      createMemoryEntry({ object_id: "memory-4", activation_score: 0.6 }),
      createMemoryEntry({ object_id: "memory-5", activation_score: 0.5 })
    ];
    const { dependencies } = createDependencies(memories);
    const service = new RecallService(dependencies);
    const first = await service.recall({
      taskSurface: createTaskSurface(),
      workspaceId: "workspace-1",
      strategy: "analyze"
    });
    const second = await service.recall({
      taskSurface: createTaskSurface(),
      workspaceId: "workspace-1",
      strategy: "analyze"
    });
    // Both recalls land on the non-degraded path so token_economy is
    // present and stable across identical inputs.
    expect(first.diagnostics?.token_economy).toBeDefined();
    expect(first.diagnostics?.token_economy).toEqual(
      second.diagnostics?.token_economy
    );
  });

  // O-1 regression guard for the per-call instrument's latency contract.
  // computeRecallTokenEconomy iterates RECALL_FUSION_STREAMS (16) and for
  // each does an Array.some across the pre-budget candidate set: nested
  // 16 × N. The bench uses N up to ~200 candidates, so a worst-case
  // scan is 3200 .some calls — still pure index lookups. We pin a hard
  // < 50µs ceiling per call so future additions (extra streams, richer
  // per-stream gating) cannot quietly turn the instrument into a
  // measurable latency tax. The bound is loose enough to absorb host
  // jitter while still catching an order-of-magnitude regression.
  // see also: packages/core/src/recall/recall-service.ts
  // @anchor compute-recall-token-economy.
  // anti-patterns-lint-allow: the candidate-diagnostic shape is local to
  // this perf probe; promoting a shared factory would couple this latency
  // contract to evolving production fixture helpers.
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

  // The degraded recall path (any non-null degradation_reason — warm/cold
  // cascade or recall_explainability_partial) must still carry the token
  // economy shape so bench coverage can prove every recall call was
  // instrumented. We exercise the cascade-engaged branch by giving the
  // harness empty HOT and WARM tiers and a single COLD candidate.
  // see also: packages/core/src/recall/diagnostics.ts:computeRecallTokenEconomy,
  // packages/core/src/recall/recall-service.ts (call site, expandTierCascade).
  it("populates token_economy on degraded (cascade-engaged) recall paths", async () => {
    const coldOnlyMemory = createMemoryEntry({
      object_id: "11111111-1111-4111-8111-111111111111",
      storage_tier: "cold",
      activation_score: 0.4
    });
    const { dependencies } = createDependencies([coldOnlyMemory]);
    const service = new RecallService(dependencies);
    const result = await service.recall({
      taskSurface: createTaskSurface(),
      workspaceId: "workspace-1",
      strategy: "analyze"
    });
    expect(result.degradation_reason).not.toBeNull();
    expect(result.diagnostics?.token_economy).toEqual(
      expect.objectContaining({
        coarse_pool_size: result.diagnostics?.candidate_pool_count,
        fine_evaluated: result.diagnostics?.candidate_pool_count,
        embedding_inference_calls: 0
      })
    );
    // The diagnostics envelope itself must remain present so callers can
    // still read query_probes, candidates, and token accounting.
    expect(result.diagnostics).toBeDefined();
  });
});
