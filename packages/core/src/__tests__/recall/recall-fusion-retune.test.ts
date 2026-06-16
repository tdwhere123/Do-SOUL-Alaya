import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RecallService } from "../../recall/recall-service.js";
import {
  WS,
  deps,
  memory,
  task,
  withBudgets,
  withEmbedding
} from "../recall-regression-suite/recall-current-behavior-test-fixtures.js";

const RETUNE_ENV = "ALAYA_RECALL_FUSION_RETUNE_V1";

// Exercises the opt-in fusion retune bundle. The production default is off and
// covered by the regression suite; here the flag is forced on.
describe("recall fusion retune (flag on)", () => {
  let previous: string | undefined;

  beforeEach(() => {
    previous = process.env[RETUNE_ENV];
    process.env[RETUNE_ENV] = "1";
  });

  afterEach(() => {
    if (previous === undefined) {
      delete process.env[RETUNE_ENV];
    } else {
      process.env[RETUNE_ENV] = previous;
    }
  });

  it("folds lexical lanes into a single composite contribution on lexical_fts", async () => {
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
      max_entries: 5,
      max_total_tokens: 1000
    });
    const result = await service.recall({
      taskSurface: task("rare fused-rank needle"),
      workspaceId: WS,
      strategy: "analyze",
      policyOverride: policy
    });
    const gold = result.diagnostics?.candidates.find((c) => c.object_id === "lexical-gold");
    const high = result.diagnostics?.candidates.find((c) => c.object_id === "high-activation");
    // Folded members keep their per-stream rank but contribute nothing on their own.
    expect(gold?.per_stream_rank.lexical_fts).not.toBeNull();
    expect(gold?.fused_rank_contribution_per_stream.existing_score).toBe(0);
    expect(gold?.fused_rank_contribution_per_stream.trigram_fts).toBe(0);
    expect(high?.fused_rank_contribution_per_stream.existing_score).toBe(0);
    // The one composite contribution rides the lexical_fts carrier slot.
    expect(gold?.fused_rank_contribution_per_stream.lexical_fts).toBeGreaterThan(0);
    expect(high?.fused_rank_contribution_per_stream.lexical_fts).toBeGreaterThan(0);
  });

  it("raises embedding_similarity weight under retune", async () => {
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
    const { dependencies } = deps([lexicalPeer, semanticGold], {
      embeddingRecallService: {
        hasStoredVectors: async () => true,
        prepareQueryEmbedding: () => ({
          queryId: "q-embedding",
          cacheHit: false,
          getSnapshot: () => ({ status: "ready" as const, embedding: new Float32Array([1]) })
        }),
        querySupplementIfReady: async () => ({
          supplementaryEntries: [semanticGold],
          similarityHintsByObjectId: {
            "semantic-gold": { object_id: "semantic-gold", normalized_similarity: 1 }
          }
        }),
        querySupplement: async () => ({ supplementaryEntries: [], similarityHintsByObjectId: {} })
      }
    });
    const service = new RecallService(dependencies);
    const policy = withBudgets(withEmbedding(service.buildDefaultPolicy("analyze", task().runtime_id)), {
      max_entries: 5,
      max_total_tokens: 1000
    });
    const result = await service.recall({
      taskSurface: task("semantic query"),
      workspaceId: WS,
      strategy: "analyze",
      policyOverride: policy
    });
    const gold = result.diagnostics?.candidates.find((c) => c.object_id === "semantic-gold");
    expect(gold?.per_stream_rank.embedding_similarity).toBe(1);
    // weight 3 over the default RRF k (60), rank 1.
    expect(gold?.fused_rank_contribution_per_stream.embedding_similarity).toBeCloseTo(3 / 61, 5);
  });

  it("fires temporal_recency only for date-term queries under retune", async () => {
    const recent = memory({ object_id: "recent", content: "release status note", created_at: "2026-05-18T00:00:00.000Z" });
    const { dependencies } = deps([recent], {
      searchByKeyword: async () => [{ object_id: "recent", normalized_rank: 1 }]
    });
    const service = new RecallService(dependencies);
    const policy = withBudgets(service.buildDefaultPolicy("analyze", task().runtime_id), {
      max_entries: 5,
      max_total_tokens: 1000
    });

    const dated = await service.recall({
      taskSurface: task("What changed yesterday?"),
      workspaceId: WS,
      strategy: "analyze",
      policyOverride: policy
    });
    const datedDiag = dated.diagnostics?.candidates.find((c) => c.object_id === "recent");
    expect(datedDiag?.fused_rank_contribution_per_stream.temporal_recency).toBeGreaterThan(0);

    const plain = await service.recall({
      taskSurface: task("release status note"),
      workspaceId: WS,
      strategy: "analyze",
      policyOverride: policy
    });
    const plainDiag = plain.diagnostics?.candidates.find((c) => c.object_id === "recent");
    expect(plainDiag?.fused_rank_contribution_per_stream.temporal_recency).toBe(0);
  });
});
