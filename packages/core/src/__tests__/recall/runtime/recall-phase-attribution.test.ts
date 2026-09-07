import { describe, expect, it, vi } from "vitest";

import type { RecallServiceEmbeddingRecallPort } from "../../../recall/runtime/recall-service-types.js";
import { RecallService } from "../../../recall/recall-service.js";
import {
  createDependencies,
  createMemoryEntry,
  createPreparedQueryHandle,
  createTaskSurface
} from "../recall-service-test-fixtures.js";

describe("recall phase attribution", () => {
  it("does not attribute snapshot materialization, assessment, or delivery on live recall", async () => {
    const memory = createMemoryEntry({ content: "Snapshot phase procedure" });
    const { dependencies } = createDependencies([memory]);
    const embeddingRecallService = createSnapshotPort(memory.object_id);
    const manifestationSidecarPort = createManifestationSidecar();
    const service = new RecallService({
      ...dependencies,
      embeddingRecallService,
      manifestationSidecarPort
    });
    const result = await liveRecall(service, "Snapshot phase procedure");

    expect(embeddingRecallService.prepareRecallEmbeddingSnapshot).not.toHaveBeenCalled();
    expect(manifestationSidecarPort.buildBiasSidecar).not.toHaveBeenCalled();
    expect(result.diagnostics?.phase_latency_ms).toBeUndefined();
    expect(result.ranking_authority).not.toBe("prefix_sk");
    expect(result.capture_execution).toBeUndefined();
    expect(result.provider_calls).toBe(0);
    expect(result.garden_enqueue).toBe(0);
    expect(result.index).toBeDefined();
  });

  it("does not run custom embedding fallback work on live recall", async () => {
    const memory = createMemoryEntry({ content: "Custom fallback procedure" });
    const { dependencies } = createDependencies([memory]);
    const embeddingRecallService = createCustomPort(memory.object_id);
    const service = new RecallService({ ...dependencies, embeddingRecallService });
    const result = await liveRecall(service, "Custom fallback procedure");

    expect(embeddingRecallService.prepareQuerySupplement).not.toHaveBeenCalled();
    expect(embeddingRecallService.scorePoolCandidates).not.toHaveBeenCalled();
    expect(result.diagnostics?.phase_latency_ms).toBeUndefined();
    expect(result.provider_calls).toBe(0);
    expect(result.ranking_authority).not.toBe("prefix_sk");
  });

  it("does not run legacy embedding preparation on live recall", async () => {
    const memory = createMemoryEntry({ content: "Legacy adapter procedure" });
    const { dependencies } = createDependencies([memory]);
    const embeddingRecallService = createLegacyPort(memory.object_id);
    const service = new RecallService({ ...dependencies, embeddingRecallService });
    const result = await liveRecall(service, "Legacy adapter procedure");

    expect(embeddingRecallService.hasStoredVectors).not.toHaveBeenCalled();
    expect(embeddingRecallService.prepareQueryEmbedding).not.toHaveBeenCalled();
    expect(result.diagnostics?.phase_latency_ms).toBeUndefined();
    expect(result.provider_calls).toBe(0);
  });

  it("does not assign synthesis search work on live recall", async () => {
    const memory = createMemoryEntry({ content: "Concurrent synthesis procedure" });
    const { dependencies } = createDependencies([memory]);
    const synthesisSearch = vi.fn(async () => []);
    const service = new RecallService({
      ...dependencies,
      synthesisSearchPort: {
        searchByKeyword: synthesisSearch,
        findByIds: vi.fn(async () => [])
      }
    });
    const result = await liveRecall(service, "Concurrent synthesis procedure");

    expect(synthesisSearch).not.toHaveBeenCalled();
    expect(result.diagnostics?.phase_latency_ms).toBeUndefined();
    expect(result.ranking_authority).not.toBe("prefix_sk");
    expect(result.provider_calls).toBe(0);
    expect(result.index.completeness.logical_index === "complete"
      || result.index.completeness.logical_index === "open"
      || result.index.completeness.logical_index === "unavailable").toBe(true);
  });
});

function createSnapshotPort(memoryId: string): RecallServiceEmbeddingRecallPort {
  return {
    prepareRecallEmbeddingSnapshot: vi.fn(async () => Object.freeze({
      workspaceId: "workspace-1",
      runId: null,
      queryId: "snapshot-phase-query",
      poolScoresByObjectId: Object.freeze({ [memoryId]: 0.8 }),
      scoringLatencyMs: 2,
      workspaceNeighbors: Object.freeze({
        hits: Object.freeze([]),
        embedding_inference_calls: 1,
        query_embedding_cache_hit: false,
        query_embedding_status: "provider_returned" as const,
        query_embedding_degradation_reason: null
      }),
      degradedReason: null
    })),
    materializeEmbeddingSupplementFromSnapshot: vi.fn(async () => embeddingSupplement(memoryId, 0.8)),
    querySupplement: vi.fn(async () => embeddingSupplement(memoryId, 0))
  };
}

function createCustomPort(memoryId: string): RecallServiceEmbeddingRecallPort {
  return {
    prepareQuerySupplement: vi.fn(async () => Object.freeze({
      preparedQuery: createPreparedQueryHandle("custom-phase-query"),
      storedVectors: Object.freeze([]),
      degradedReason: null
    })),
    querySupplementIfReady: vi.fn(async () => embeddingSupplement(memoryId, 0.7)),
    scorePoolCandidates: vi.fn(async () => new Map([[memoryId, 0.8]])),
    querySupplement: vi.fn(async () => embeddingSupplement(memoryId, 0))
  };
}

function createLegacyPort(memoryId: string): RecallServiceEmbeddingRecallPort {
  return {
    hasStoredVectors: vi.fn(async () => true),
    prepareQueryEmbedding: vi.fn(() => createPreparedQueryHandle("legacy-phase-query")),
    querySupplementIfReady: vi.fn(async () => embeddingSupplement(memoryId, 0.7)),
    scorePoolCandidates: vi.fn(async () => new Map([[memoryId, 0.8]])),
    querySupplement: vi.fn(async () => embeddingSupplement(memoryId, 0))
  };
}

function createManifestationSidecar() {
  return {
    buildBiasSidecar: vi.fn(async () => [])
  };
}

function embeddingSupplement(memoryId: string, score: number) {
  return {
    supplementaryEntries: Object.freeze([]),
    similarityHintsByObjectId: score === 0
      ? Object.freeze({})
      : Object.freeze({
          [memoryId]: Object.freeze({ object_id: memoryId, normalized_similarity: score })
        })
  };
}

function liveRecall(service: RecallService, displayName: string) {
  return service.recall({
    taskSurface: { ...createTaskSurface(), display_name: displayName },
    workspaceId: "workspace-1",
    strategy: "analyze"
  });
}
