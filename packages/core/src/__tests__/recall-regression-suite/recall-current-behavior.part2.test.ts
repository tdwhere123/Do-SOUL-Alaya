import { describe, expect, it, vi } from "vitest";
import { MemoryDimension, StorageTier, type RecallPolicy } from "@do-soul/alaya-protocol";
import { RecallService } from "../../recall/recall-service.js";
import { compareRecallCandidates } from "../../recall/runtime/recall-service-helpers.js";
import { compileRecallQueryProbes } from "../../recall/query/recall-query-probes.js";
import { WS, activeConstraint, candidate, deps, memory, pathRelation, task, withBudgets, withEmbedding } from "./recall-current-behavior-test-fixtures.js";

describe("recall regression suite", () => {
it.each([
    ["mixed dimensions", ["gold", "peer-1", "peer-2", "peer-3", "peer-4"]],
    ["warm workspace peers", ["gold", "warm-1", "warm-2", "warm-3", "warm-4"]],
    ["constraint peers", ["gold", "constraint-1", "constraint-2", "constraint-3", "constraint-4"]]
  ])("keeps high-lexical gold inside top five under %s", (_name, ids) => {
    const candidates = ids.map((id, index) =>
      candidate(id, id === "gold" ? 0.98 : 0.7 - index * 0.05, id === "gold" ? 0.2 : 0.9)
    );
    const topFive = [...candidates].sort(compareRecallCandidates).slice(0, 5);
    expect(topFive.map((item) => item.object_id)).toContain("gold");
  });

it.each([
    ["simple descending", [0.9, 0.8, 0.7, 0.6]],
    ["tie broken by activation", [0.8, 0.8, 0.7, 0.7]],
    ["long tail", [0.95, 0.9, 0.6, 0.4, 0.2]]
  ])("keeps delivered ordering monotonic for %s", (_name, scores) => {
    const sorted = scores
      .map((score, index) => candidate(`mem-${index}`, score, index % 2 === 0 ? 0.5 : 0.4))
      .sort(compareRecallCandidates);
    expect(sorted.map((item) => item.relevance_score)).toEqual(
      [...scores].sort((left, right) => right - left)
    );
  });

it("keeps lexical evidence in fusion without overriding fused order", async () => {
    const sourceSeed = memory({
      object_id: "source-seed",
      content: "local adjacency seed",
      evidence_refs: ["source-lexical-s1-t10"],
      activation_score: 0.7
    });
    const sourceNeighbors = Array.from({ length: 6 }, (_, index) =>
      memory({
        object_id: `source-neighbor-${index}`,
        content: `source proximity local-only decoy ${index}`,
        evidence_refs: [`source-lexical-s1-t${11 + index}`],
        activation_score: 0.9 - index * 0.01
      })
    );
    const lexicalGold = memory({
      object_id: "strong-lexical-gold",
      content: "rare lexical protected answer",
      activation_score: 0.05
    });
    const { dependencies } = deps([sourceSeed, ...sourceNeighbors, lexicalGold], {
      searchByKeyword: async () => [
        { object_id: "source-seed", normalized_rank: 0.7 },
        { object_id: "strong-lexical-gold", normalized_rank: 0.98 }
      ]
    });
    const service = new RecallService(dependencies);
    const policy = withBudgets({
      ...service.buildDefaultPolicy("analyze", task().runtime_id),
      scoring_weight_overrides: {
        fusion_weights: {
          source_proximity: 20
        }
      }
    }, {
      max_entries: 10,
      max_total_tokens: 1000
    });

    const result = await service.recall({
      taskSurface: task("rare lexical protected answer"),
      workspaceId: WS,
      strategy: "analyze",
      policyOverride: policy
    });

    const diagnostic = result.diagnostics?.candidates.find(
      (item) => item.object_id === "strong-lexical-gold"
    );
    expect(diagnostic?.per_stream_rank.lexical_fts).not.toBeNull();
    expect(diagnostic?.fused_rank_contribution_per_stream.lexical_fts).toBeGreaterThan(0);
    // Legacy lexical-priority stage stays retired (still tracks fused rank).
    expect(diagnostic?.rank_after_lexical_priority).toBe(diagnostic?.fused_rank);
    // Delivery order may diverge from fused_rank (deep-head reorder and coverage
    // packing); lexical must still land in the delivered set, not a separate stage.
    expect(diagnostic?.final_rank).not.toBeNull();
    expect(result.candidates.map((item) => item.object_id)).toContain("strong-lexical-gold");
  });

it("preserves fused order across legacy delivery stages", async () => {
    const sourceSeed = memory({
      object_id: "ordering-source-seed",
      content: "ordering source seed",
      evidence_refs: ["source-order-s1-t10"],
      activation_score: 0.2
    });
    const sourceNeighbor = memory({
      object_id: "ordering-source-neighbor",
      content: "ordering source proximity decoy",
      evidence_refs: ["source-order-s1-t11"],
      activation_score: 0.05
    });
    const lexicalGold = memory({
      object_id: "ordering-strong-lexical",
      content: "ordering strong lexical answer",
      activation_score: 0.3
    });
    const lexicalPeer = memory({
      object_id: "ordering-lexical-peer",
      content: "ordering weaker lexical peer",
      activation_score: 0.01
    });
    const { dependencies } = deps([sourceSeed, sourceNeighbor, lexicalGold, lexicalPeer], {
      searchByKeyword: async () => [
        { object_id: "ordering-strong-lexical", normalized_rank: 1 },
        { object_id: "ordering-source-seed", normalized_rank: 0.2 },
        { object_id: "ordering-lexical-peer", normalized_rank: 0.1 }
      ]
    });
    const service = new RecallService(dependencies);
    const policy = withBudgets({
      ...service.buildDefaultPolicy("analyze", task().runtime_id),
      scoring_weight_overrides: {
        fusion_weights: {
          source_proximity: 20
        }
      }
    }, {
      max_entries: 5,
      max_total_tokens: 1000
    });

    const result = await service.recall({
      taskSurface: task("ordering strong lexical answer"),
      workspaceId: WS,
      strategy: "analyze",
      policyOverride: policy
    });

    const diagnosticsById = new Map(
      (result.diagnostics?.candidates ?? []).map((item) => [item.object_id, item] as const)
    );
    const gold = diagnosticsById.get("ordering-strong-lexical");
    const peer = diagnosticsById.get("ordering-lexical-peer");
    const sourceOnly = diagnosticsById.get("ordering-source-neighbor");
    expect(sourceOnly?.per_stream_rank.source_proximity).not.toBeNull();
    expect(sourceOnly?.per_stream_rank.lexical_fts).toBeNull();
    expect(sourceOnly?.fused_rank).toBeLessThan(gold?.fused_rank ?? Number.MAX_SAFE_INTEGER);
    expect(gold?.fused_rank).toBeLessThan(peer?.fused_rank ?? Number.MAX_SAFE_INTEGER);
    expect(sourceOnly?.final_rank).toBe(sourceOnly?.fused_rank);
    expect(gold?.final_rank).toBe(gold?.fused_rank);
    expect(peer?.final_rank).toBe(peer?.fused_rank);
    expect(gold?.rank_after_feature_rerank).toBe(gold?.fused_rank);
    expect(gold?.rank_after_lexical_priority).toBe(gold?.fused_rank);
    expect(gold?.rank_after_structural_reserve).toBe(gold?.fused_rank);
    expect(gold?.final_rank).toBeLessThan(peer?.final_rank ?? Number.MAX_SAFE_INTEGER);
  });

it.each([
    ["yesterday", "What changed yesterday?"],
    ["last-week-cn", "上周做了什么决定？"]
  ])("extracts time concern query probes for %s", (_name, query) => {
    expect(compileRecallQueryProbes(query).date_terms.length).toBeGreaterThan(0);
  });

it.each([
    ["plain release query", "recall release checklist"],
    ["plain Chinese query", "召回发布检查项"]
  ])("does not emit temporal probes for %s", (_name, query) => {
    expect(compileRecallQueryProbes(query).date_terms).toEqual([]);
  });

it("returns active constraints outside the ranked result budget", async () => {
    const ranked = memory({ object_id: "ranked", dimension: MemoryDimension.PROCEDURE });
    const constraint = activeConstraint(memory({ object_id: "constraint", dimension: MemoryDimension.CONSTRAINT }));
    const { dependencies } = deps([ranked], { activeConstraints: [constraint] });
    const service = new RecallService(dependencies);
    const policy = withBudgets(service.buildDefaultPolicy("analyze", task().runtime_id), {
      max_entries: 1,
      max_total_tokens: 1000
    });
    const result = await service.recall({
      taskSurface: task(),
      workspaceId: WS,
      strategy: "analyze",
      policyOverride: policy
    });
    expect(result.candidates.map((item) => item.object_id)).toEqual(["ranked"]);
    expect(result.active_constraints.map((item) => item.object_id)).toEqual(["constraint"]);
  });

it("reports active constraints count from the active constraints port", async () => {
    const constraint = activeConstraint(memory({ object_id: "constraint", dimension: MemoryDimension.HAZARD }));
    const { dependencies } = deps([], { activeConstraints: [constraint] });
    const result = await new RecallService(dependencies).recall({
      taskSurface: task(),
      workspaceId: WS,
      strategy: "analyze"
    });
    expect(result.active_constraints_count).toBe(1);
  });

it("passes active constraints cap through to the port", async () => {
    const findActiveConstraints = vi.fn(async () => ({ constraints: [], total_count: 0 }));
    const { dependencies } = deps([], {
      activeConstraintsPort: { findActiveConstraints }
    });
    await new RecallService(dependencies).recall({
      taskSurface: task(),
      workspaceId: WS,
      strategy: "analyze",
      activeConstraintsCap: 3
    });
    expect(findActiveConstraints).toHaveBeenCalledWith({ workspaceId: WS, cap: 3 });
  });

it("cuts max_entries by fused rank before additive relevance score", async () => {
    const highActivation = memory({
      object_id: "high-activation",
      content: "ordinary activation-heavy memory",
      activation_score: 1
    });
    const lexicalGold = memory({
      object_id: "lexical-gold",
      content: "rare fused-rank needle",
      activation_score: 0.1
    });
    const { dependencies } = deps([highActivation, lexicalGold], {
      searchByKeyword: async () => [{ object_id: "lexical-gold", normalized_rank: 1 }]
    });
    const service = new RecallService(dependencies);
    const policy = withBudgets(service.buildDefaultPolicy("analyze", task().runtime_id), {
      max_entries: 1,
      max_total_tokens: 1000
    });
    const result = await service.recall({
      taskSurface: task("rare fused-rank needle"),
      workspaceId: WS,
      strategy: "analyze",
      policyOverride: policy
    });

    expect(result.candidates.map((item) => item.object_id)).toEqual(["lexical-gold"]);
    const goldDiagnostic = result.diagnostics?.candidates.find((item) => item.object_id === "lexical-gold");
    const droppedDiagnostic = result.diagnostics?.candidates.find((item) => item.object_id === "high-activation");
    expect(goldDiagnostic?.fused_rank).toBe(1);
    expect(goldDiagnostic?.per_stream_rank.lexical_fts).toBe(1);
    expect(droppedDiagnostic?.dropped_reason).toBe("max_entries");
    expect(droppedDiagnostic?.fused_rank).toBeGreaterThan(1);
    expect(droppedDiagnostic?.per_stream_rank.existing_score).toBe(1);
    expect(droppedDiagnostic?.fused_rank_contribution_per_stream.existing_score).toBeGreaterThan(0);
    expect(goldDiagnostic?.per_stream_rank.lexical_fts).toBe(1);

    const legacyWeightedPolicy = {
      ...policy,
      scoring_weight_overrides: {
        fusion_weights: {
          existing_score: 5
        }
      }
    } satisfies RecallPolicy;
    const legacyWeightedResult = await service.recall({
      taskSurface: task("rare fused-rank needle"),
      workspaceId: WS,
      strategy: "analyze",
      policyOverride: legacyWeightedPolicy
    });
    const legacyWeightedDiagnostic = legacyWeightedResult.diagnostics?.candidates.find(
      (item) => item.object_id === "high-activation"
    );
    expect(legacyWeightedDiagnostic?.per_stream_rank.existing_score).toBe(1);
    expect(legacyWeightedDiagnostic?.fused_rank_contribution_per_stream.existing_score).toBeGreaterThan(0);
  });

it("promotes memories when evidence FTS and structural evidence agree", async () => {
    const decoys = Array.from({ length: 6 }, (_, index) =>
      memory({
        object_id: `decoy-${index}`,
        content: `Computer Science degree planning decoy ${index}`,
        activation_score: 1 - index * 0.01
      })
    );
    const gold = memory({
      object_id: "ucla-gold",
      content: "I completed my Bachelor's degree in Computer Science at UCLA.",
      evidence_refs: ["evidence-ucla"],
      activation_score: 0.1
    });
    const { dependencies } = deps([...decoys, gold], {
      searchByKeyword: async () =>
        decoys.map((entry, index) => ({
          object_id: entry.object_id,
          normalized_rank: 1 - index * 0.01
        })),
      evidenceSearchPort: {
        searchByKeyword: vi.fn(async () => [{ object_id: "evidence-ucla", normalized_rank: 1 }])
      }
    });
    const service = new RecallService(dependencies);
    const policy = withBudgets(service.buildDefaultPolicy("analyze", task().runtime_id), {
      max_entries: 1,
      max_total_tokens: 1000
    });

    const result = await service.recall({
      taskSurface: task("Where did I complete my Bachelor's degree in Computer Science?"),
      workspaceId: WS,
      strategy: "analyze",
      policyOverride: policy
    });

    expect(result.candidates.map((item) => item.object_id)).toEqual(["ucla-gold"]);
    const goldDiagnostic = result.diagnostics?.candidates.find((item) => item.object_id === "ucla-gold");
    expect(goldDiagnostic?.per_stream_rank.evidence_fts).toBe(1);
    expect(goldDiagnostic?.per_stream_rank.evidence_structural_agreement).toBe(1);
    expect(goldDiagnostic?.fused_rank).toBe(1);
  });

it("lets embedding-on supplements participate in the fused-rank budget cut", async () => {
    const lexicalPeer = memory({
      object_id: "lexical-peer",
      content: "ordinary activation peer memory",
      activation_score: 0.2
    });
    const semanticGold = memory({
      object_id: "semantic-gold",
      content: "semantically related memory",
      activation_score: 0.19
    });
    const querySupplementIfReady = vi.fn(async () => ({
      supplementaryEntries: [semanticGold],
      similarityHintsByObjectId: {
        "semantic-gold": {
          object_id: "semantic-gold",
          normalized_similarity: 1
        }
      }
    }));
    const { dependencies } = deps([lexicalPeer, semanticGold], {
      embeddingRecallService: {
        hasStoredVectors: vi.fn(async () => true),
        prepareQueryEmbedding: vi.fn(() => ({
          queryId: "q-embedding",
          cacheHit: false,
          getSnapshot: () => ({
            status: "ready" as const,
            embedding: new Float32Array([1])
          })
        })),
        querySupplementIfReady,
        querySupplement: vi.fn(async () => ({
          supplementaryEntries: [],
          similarityHintsByObjectId: {}
        }))
      }
    });
    const service = new RecallService(dependencies);
    const policy = withBudgets(withEmbedding(service.buildDefaultPolicy("analyze", task().runtime_id)), {
      max_entries: 1,
      max_total_tokens: 1000
    });

    const result = await service.recall({
      taskSurface: task("semantic query"),
      workspaceId: WS,
      strategy: "analyze",
      policyOverride: policy
    });

    expect(querySupplementIfReady).toHaveBeenCalled();
    expect(result.candidates.map((item) => item.object_id)).toEqual(["semantic-gold"]);
    expect(result.candidates[0]?.source_channels).toContain("semantic_supplement");
    const goldDiagnostic = result.diagnostics?.candidates.find((item) => item.object_id === "semantic-gold");
    const droppedDiagnostic = result.diagnostics?.candidates.find((item) => item.object_id === "lexical-peer");
    expect(goldDiagnostic?.per_stream_rank.embedding_similarity).toBe(1);
    expect(goldDiagnostic?.fused_rank).toBe(1);
    expect(goldDiagnostic?.source_channels).toContain("semantic_supplement");
    expect(droppedDiagnostic?.dropped_reason).toBe("max_entries");
  });

it("uses path expansion in a cold workspace without usage proof lookup", async () => {
    const seed = memory({ object_id: "seed", content: "cold seed", storage_tier: StorageTier.COLD });
    const linked = memory({ object_id: "linked", content: "cold linked", storage_tier: StorageTier.COLD });
    const queryByEntity = vi.fn(async () => []);
    const { dependencies } = deps([seed, linked], {
      searchByKeyword: async () => [{ object_id: "seed", normalized_rank: 1 }],
      queryByEntity,
      pathExpansionPort: {
        findByAnchors: vi.fn(async () => [pathRelation("seed", "linked")])
      }
    });
    const result = await new RecallService(dependencies).recall({
      taskSurface: task("cold seed"),
      workspaceId: WS,
      strategy: "analyze"
    });
    expect(result.candidates.some((item) => item.object_id === "linked")).toBe(true);
    expect(queryByEntity).not.toHaveBeenCalled();
  });

it("marks path expansion source channels on cold linked candidates", async () => {
    const seed = memory({ object_id: "seed", content: "cold seed", storage_tier: StorageTier.COLD });
    const linked = memory({ object_id: "linked", content: "cold linked", storage_tier: StorageTier.COLD });
    const { dependencies } = deps([seed, linked], {
      searchByKeyword: async () => [{ object_id: "seed", normalized_rank: 1 }],
      pathExpansionPort: {
        findByAnchors: vi.fn(async () => [pathRelation("seed", "linked")])
      }
    });
    const result = await new RecallService(dependencies).recall({
      taskSurface: task("cold seed"),
      workspaceId: WS,
      strategy: "analyze"
    });
    const linkedCandidate = result.candidates.find((item) => item.object_id === "linked");
    expect(linkedCandidate?.source_channels).toContain("path_expansion");
  });

it("falls back to lexical results when embedding precheck fails", async () => {
    const mem = memory({ object_id: "lexical", content: "embedding fallback lexical" });
    const { dependencies } = deps([mem], {
      searchByKeyword: async () => [{ object_id: "lexical", normalized_rank: 1 }],
      embeddingRecallService: {
        prepareQueryEmbedding: vi.fn(() => ({
          queryId: "q-1",
          cacheHit: false,
          getSnapshot: () => ({ status: "pending" as const })
        })),
        hasStoredVectors: vi.fn(async () => {
          throw { reason: "query_embedding_failed" };
        }),
        recordPrecheckDegraded: vi.fn(async () => undefined),
        querySupplementIfReady: vi.fn(async () => ({
          supplementaryEntries: [],
          similarityHintsByObjectId: {}
        })),
        querySupplement: vi.fn(async () => ({
          supplementaryEntries: [],
          similarityHintsByObjectId: {}
        }))
      }
    });
    const service = new RecallService(dependencies);
    const result = await service.recall({
      taskSurface: task("embedding fallback lexical"),
      workspaceId: WS,
      strategy: "analyze",
      policyOverride: withEmbedding(service.buildDefaultPolicy("analyze", task().runtime_id))
    });
    expect(result.candidates.map((item) => item.object_id)).toContain("lexical");
    expect(result.diagnostics?.embedding_provider_status).toBe("provider_failed");
    expect(result.diagnostics?.provider_degradation_reason).toBe("query_embedding_failed");
  });

it("falls back to lexical results while embedding query is pending", async () => {
    const mem = memory({ object_id: "lexical", content: "embedding pending lexical" });
    const { dependencies } = deps([mem], {
      searchByKeyword: async () => [{ object_id: "lexical", normalized_rank: 1 }],
      embeddingRecallService: {
        hasStoredVectors: vi.fn(async () => true),
        prepareQueryEmbedding: vi.fn(() => ({
          queryId: "q-1",
          cacheHit: false,
          getSnapshot: () => ({ status: "pending" as const })
        })),
        querySupplementIfReady: vi.fn(async () => ({
          supplementaryEntries: [],
          similarityHintsByObjectId: {}
        })),
        querySupplement: vi.fn(async () => ({
          supplementaryEntries: [],
          similarityHintsByObjectId: {}
        }))
      }
    });
    const service = new RecallService(dependencies);
    const result = await service.recall({
      taskSurface: task("embedding pending lexical"),
      workspaceId: WS,
      strategy: "analyze",
      policyOverride: withEmbedding(service.buildDefaultPolicy("analyze", task().runtime_id))
    });
    expect(result.candidates.map((item) => item.object_id)).toContain("lexical");
    expect(result.diagnostics?.embedding_provider_status).toBe("provider_pending");
    expect(result.diagnostics?.provider_degradation_reason).toBe("query_embedding_pending");
  });
});
