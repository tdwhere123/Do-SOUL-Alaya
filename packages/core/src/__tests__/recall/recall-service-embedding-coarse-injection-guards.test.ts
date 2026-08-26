import { describe, expect, it, vi } from "vitest";
import type { RecallPolicy } from "@do-soul/alaya-protocol";
import { RecallService } from "../../recall/recall-service.js";
import { hashMemoryContent } from "../../embedding-recall/helpers.js";
import type { RecallServiceEmbeddingRecallPort, RecallServiceMemoryRepoPort } from
  "../../recall/runtime/recall-service-types.js";
import { createDependencies, createMemoryEntry, createPreparedQueryHandle,
  createTaskSurface, overridePolicy } from "./recall-service-test-fixtures.js";

describe("RecallService embedding coarse-injection guards", () => {
  const memory = createMemoryEntry({ object_id: "44444444-4444-4444-8444-444444444444",
    content: "Pure-semantic Helsinki revenue note.", activation_score: 0.05 });

  function buildService(collect: NonNullable<RecallServiceEmbeddingRecallPort[
    "collectWorkspaceNeighborsWithMetadata"]>, findByIds: NonNullable<
      RecallServiceMemoryRepoPort["findByIds"]>) {
    const { dependencies, warnSpy } = createDependencies([memory]);
    const embeddingRecallService = {
      hasStoredVectors: vi.fn(async () => true),
      prepareQueryEmbedding: vi.fn(() => createPreparedQueryHandle("prepared-fetch-budget")),
      querySupplementIfReady: vi.fn(async () => ({ supplementaryEntries: [],
        similarityHintsByObjectId: {} })),
      querySupplement: vi.fn(async () => ({ supplementaryEntries: [],
        similarityHintsByObjectId: {} })),
      collectWorkspaceNeighborsWithMetadata: collect
    } satisfies RecallServiceEmbeddingRecallPort;
    return { service: new RecallService({ testOnlyAllowInMemoryFieldQuerySession: true,
      ...dependencies, memoryRepo: { ...dependencies.memoryRepo, findByIds },
      embeddingRecallService }), warnSpy };
  }

  function policy(service: RecallService, cap: number): RecallPolicy {
    const base = service.buildDefaultPolicy("analyze", createTaskSurface().runtime_id);
    return overridePolicy(base, { coarse_filter: { ...base.coarse_filter,
      precomputed_rank: { ...base.coarse_filter.precomputed_rank, min_activation_score: 0.5 },
      semantic_supplement: { enabled: true, max_supplement: 5,
        embedding_enabled: true, injection_cap: cap } } });
  }

  function neighbors(content_hash?: string) {
    return { hits: [{ object_id: memory.object_id, normalized_similarity: 0.95,
      ...(content_hash === undefined ? {} : { content_hash }) }],
      embedding_inference_calls: 1, query_embedding_cache_hit: false };
  }

  it("fetches up to injection_cap neighbors", async () => {
    const collect = vi.fn(async () => neighbors());
    const { service } = buildService(collect, vi.fn(async () => [memory]));
    await service.recall({ taskSurface: createTaskSurface(), workspaceId: "workspace-1",
      strategy: "analyze", policyOverride: policy(service, 10) });
    expect(collect.mock.calls[0]?.[0]?.maxNeighbors).toBe(10);
  });

  it("injects nothing when injection_cap is zero", async () => {
    const collect = vi.fn(async () => neighbors());
    const find = vi.fn(async () => [memory]);
    const { service } = buildService(collect, find);
    const result = await service.recall({ taskSurface: createTaskSurface(),
      workspaceId: "workspace-1", strategy: "analyze", policyOverride: policy(service, 0) });
    expect(result.candidates.some(({ object_id }) => object_id === memory.object_id)).toBe(false);
    expect(collect).not.toHaveBeenCalled();
    expect(find).not.toHaveBeenCalled();
  });

  it("drops a stale content hash", async () => {
    const collect = vi.fn(async () => neighbors(hashMemoryContent("stale content")));
    const { service, warnSpy } = buildService(collect, vi.fn(async () => [memory]));
    const result = await service.recall({ taskSurface: createTaskSurface(),
      workspaceId: "workspace-1", strategy: "analyze", policyOverride: policy(service, 10) });
    expect(result.candidates.some(({ object_id }) => object_id === memory.object_id)).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith("embedding coarse injection dropped stale vectors",
      expect.objectContaining({ stale_vector_drops: 1 }));
  });

  it("retains hashless compatibility neighbors", async () => {
    const collect = vi.fn(async () => neighbors());
    const { service, warnSpy } = buildService(collect, vi.fn(async () => [memory]));
    const result = await service.recall({ taskSurface: createTaskSurface(),
      workspaceId: "workspace-1", strategy: "analyze", policyOverride: policy(service, 10) });
    expect(result.candidates.some(({ object_id }) => object_id === memory.object_id)).toBe(true);
    expect(warnSpy).not.toHaveBeenCalledWith("embedding coarse injection dropped stale vectors",
      expect.anything());
  });
});
