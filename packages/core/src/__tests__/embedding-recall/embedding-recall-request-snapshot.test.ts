import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ComputeRecallGardenEventType,
  type EventLogEntry
} from "@do-soul/alaya-protocol";

import {
  installCoreConfigFromProcessEnv,
  resetCoreConfigForTests
} from "../../config/index.js";
import { EmbeddingRecallService } from "../../embedding-recall/embedding-recall-service.js";
import {
  createEmbeddingRecord,
  createMemoryEntry,
  createProvider,
  hashMemoryContent
} from "./embedding-recall-test-helpers.js";

describe("EmbeddingRecallService request score snapshot", () => {
  afterEach(() => {
    resetCoreConfigForTests();
  });

  it("hydrates and scores each request vector once, then materializes the supplement from the snapshot", async () => {
    installCoreConfigFromProcessEnv({
      ALAYA_EMBEDDING_WORKSPACE_SCAN_CAP: "2"
    });
    const hot = createMemoryEntry({ object_id: "pool-hot", content: "Hot pool memory." });
    const cold = createMemoryEntry({
      object_id: "pool-cold",
      content: "Cold pool memory.",
      storage_tier: "cold"
    });
    const stale = createMemoryEntry({ object_id: "pool-stale", content: "Current memory." });
    const neighbor = createMemoryEntry({ object_id: "neighbor", content: "Semantic neighbor." });
    const listByWorkspace = vi.fn(async () => [
      createEmbeddingRecord({
        object_id: hot.object_id,
        content_hash: hashMemoryContent(hot.content),
        embedding: new Float32Array([1, 0])
      }),
      createEmbeddingRecord({
        object_id: neighbor.object_id,
        content_hash: hashMemoryContent(neighbor.content),
        embedding: new Float32Array([0.9, 0.1])
      }),
      createEmbeddingRecord({
        object_id: cold.object_id,
        content_hash: hashMemoryContent(cold.content),
        embedding: new Float32Array([0.8, 0.2])
      })
    ]);
    const listByObjectIds = vi.fn(async () => [
      createEmbeddingRecord({
        object_id: cold.object_id,
        content_hash: hashMemoryContent(cold.content),
        embedding: new Float32Array([0.8, 0.2])
      }),
      createEmbeddingRecord({
        object_id: stale.object_id,
        content_hash: hashMemoryContent("Outdated memory."),
        embedding: new Float32Array([1, 0])
      })
    ]);
    const embedTexts = vi.fn(async () => [new Float32Array([1, 0])]);
    const nowEpochMs = vi.fn()
      .mockReturnValueOnce(100)
      .mockReturnValueOnce(107)
      .mockReturnValueOnce(200)
      .mockReturnValueOnce(205);
    const append = vi.fn(async (
      entry: Omit<EventLogEntry, "event_id" | "created_at" | "revision">
    ) => ({
      event_id: `event-${entry.event_type}`,
      created_at: "2026-07-14T00:00:00.000Z",
      revision: 0,
      ...entry
    }));
    const service = new EmbeddingRecallService({
      embeddingRepo: { listByWorkspace, listByObjectIds },
      provider: createProvider({ embedTexts }),
      eventLogRepo: { append, queryByEntity: vi.fn(async () => []) },
      generateQueryId: () => "request-score-snapshot",
      now: () => "2026-07-14T00:00:00.000Z",
      nowEpochMs
    });

    const snapshot = await service.prepareRecallEmbeddingSnapshot({
      workspaceId: "workspace-1",
      runId: "run-1",
      queryText: "semantic request",
      poolMemories: [hot, cold, stale],
      maxNeighbors: 5
    });
    const supplement = await service.materializeEmbeddingSupplementFromSnapshot({
      snapshot,
      eligibleMemories: [hot, cold, stale],
      baseCandidateIds: [hot.object_id],
      maxSupplement: 2
    });

    expect(listByWorkspace).toHaveBeenCalledOnce();
    expect(listByWorkspace).toHaveBeenCalledWith("workspace-1", expect.objectContaining({
      tierFilter: ["hot", "warm"],
      limit: 3
    }));
    expect(listByObjectIds).toHaveBeenCalledOnce();
    expect(listByObjectIds).toHaveBeenCalledWith("workspace-1", ["pool-stale"]);
    expect(embedTexts).toHaveBeenCalledOnce();
    expect(snapshot).not.toHaveProperty("preparedQuery");
    expect(snapshot.scoringLatencyMs).toBe(7);
    expect(snapshot.workspaceNeighbors.hits.map((hit) => hit.object_id)).toEqual(["neighbor"]);
    expect(Object.keys(snapshot.poolScoresByObjectId).sort()).toEqual(["pool-cold", "pool-hot"]);
    expect(snapshot.poolScoresByObjectId[stale.object_id]).toBeUndefined();
    expect(supplement.supplementaryEntries.map((entry) => entry.object_id)).toEqual(["pool-cold"]);
    expect(Object.keys(supplement.similarityHintsByObjectId).sort()).toEqual(["pool-cold", "pool-hot"]);
    expect(append.mock.calls.map(([entry]) => entry.event_type)).toEqual([
      ComputeRecallGardenEventType.RECALL_EMBEDDING_SUPPLEMENT_QUERIED,
      ComputeRecallGardenEventType.RECALL_EMBEDDING_SUPPLEMENT_MERGED
    ]);
    expect(append.mock.calls[0]?.[0].payload_json).toEqual(expect.objectContaining({
      latency_ms: 12
    }));
  });

  it.each(["missing", "failed"] as const)(
    "preserves pool scoring when the workspace scan is %s",
    async (scanState) => {
      const memory = createMemoryEntry({ object_id: "pooled", content: "Pooled memory." });
      const listByObjectIds = vi.fn(async () => [
        createEmbeddingRecord({
          object_id: memory.object_id,
          content_hash: hashMemoryContent(memory.content),
          embedding: new Float32Array([1, 0])
        })
      ]);
      const listByWorkspace = vi.fn(async () => {
        throw new Error("workspace scan unavailable");
      });
      const embedTexts = vi.fn(async () => [new Float32Array([1, 0])]);
      const append = createEventAppendSpy();
      const service = new EmbeddingRecallService({
        embeddingRepo: {
          listByObjectIds,
          ...(scanState === "failed" ? { listByWorkspace } : {})
        },
        provider: createProvider({ embedTexts }),
        eventLogRepo: { append, queryByEntity: vi.fn(async () => []) }
      });

      const snapshot = await service.prepareRecallEmbeddingSnapshot({
        workspaceId: "workspace-1",
        runId: null,
        queryText: "pooled query",
        poolMemories: [memory],
        maxNeighbors: 5
      });

      expect(listByObjectIds).toHaveBeenCalledWith("workspace-1", [memory.object_id]);
      expect(embedTexts).toHaveBeenCalledOnce();
      expect(snapshot.poolScoresByObjectId[memory.object_id]).toBeCloseTo(1, 5);
      expect(snapshot.degradedReason).toBe(
        scanState === "failed" ? "local_vector_lookup_failed" : null
      );
      await service.materializeEmbeddingSupplementFromSnapshot({
        snapshot,
        eligibleMemories: [memory],
        baseCandidateIds: [memory.object_id],
        maxSupplement: 1
      });
      expect(append.mock.calls.map(([entry]) => entry.event_type)).toEqual([
        ...(scanState === "failed"
          ? [ComputeRecallGardenEventType.RECALL_EMBEDDING_SUPPLEMENT_DEGRADED]
          : []),
        ComputeRecallGardenEventType.RECALL_EMBEDDING_SUPPLEMENT_QUERIED,
        ComputeRecallGardenEventType.RECALL_EMBEDDING_SUPPLEMENT_MERGED
      ]);
    }
  );

  it("records lookup degradation when no vector source succeeds", async () => {
    const memory = createMemoryEntry({ object_id: "pool-lookup-failed", content: "Missing vector." });
    const append = createEventAppendSpy();
    const embedTexts = vi.fn(async () => [new Float32Array([1, 0])]);
    const service = new EmbeddingRecallService({
      embeddingRepo: {
        listByObjectIds: vi.fn(async () => {
          throw new Error("exact lookup unavailable");
        })
      },
      provider: createProvider({ embedTexts }),
      eventLogRepo: { append, queryByEntity: vi.fn(async () => []) }
    });

    const snapshot = await service.prepareRecallEmbeddingSnapshot({
      workspaceId: "workspace-1",
      runId: null,
      queryText: "failed lookup query",
      poolMemories: [memory],
      maxNeighbors: 5
    });
    await service.materializeEmbeddingSupplementFromSnapshot({
      snapshot,
      eligibleMemories: [memory],
      baseCandidateIds: [memory.object_id],
      maxSupplement: 1
    });

    expect(embedTexts).not.toHaveBeenCalled();
    expect(snapshot.workspaceNeighbors.query_embedding_status).toBe("provider_not_requested");
    expect(snapshot.degradedReason).toBe("local_vector_lookup_failed");
    expect(append.mock.calls.map(([entry]) => entry.event_type)).toEqual([
      ComputeRecallGardenEventType.RECALL_EMBEDDING_SUPPLEMENT_DEGRADED
    ]);
  });

  it("reports exact lookup degradation without discarding scores from the workspace scan", async () => {
    const scored = createMemoryEntry({ object_id: "pool-scored", content: "Scored memory." });
    const missing = createMemoryEntry({ object_id: "pool-missing", content: "Missing memory." });
    const append = createEventAppendSpy();
    const service = new EmbeddingRecallService({
      embeddingRepo: {
        listByWorkspace: vi.fn(async () => [createEmbeddingRecord({
          object_id: scored.object_id,
          content_hash: hashMemoryContent(scored.content),
          embedding: new Float32Array([1, 0])
        })]),
        listByObjectIds: vi.fn(async () => {
          throw new Error("exact lookup unavailable");
        })
      },
      provider: createProvider({ embedTexts: vi.fn(async () => [new Float32Array([1, 0])]) }),
      eventLogRepo: { append, queryByEntity: vi.fn(async () => []) }
    });

    const snapshot = await service.prepareRecallEmbeddingSnapshot({
      workspaceId: "workspace-1",
      runId: null,
      queryText: "scored query",
      poolMemories: [scored, missing],
      maxNeighbors: 5
    });
    await service.materializeEmbeddingSupplementFromSnapshot({
      snapshot,
      eligibleMemories: [scored, missing],
      baseCandidateIds: [missing.object_id],
      maxSupplement: 1
    });

    expect(snapshot.poolScoresByObjectId[scored.object_id]).toBeCloseTo(1, 5);
    expect(snapshot.degradedReason).toBe("local_vector_lookup_failed");
    expect(append.mock.calls.map(([entry]) => entry.event_type)).toEqual([
      ComputeRecallGardenEventType.RECALL_EMBEDDING_SUPPLEMENT_DEGRADED,
      ComputeRecallGardenEventType.RECALL_EMBEDDING_SUPPLEMENT_QUERIED,
      ComputeRecallGardenEventType.RECALL_EMBEDDING_SUPPLEMENT_MERGED
    ]);
  });

  it("records query failure before returning an empty supplement", async () => {
    const memory = createMemoryEntry({ object_id: "pool-query-failed", content: "Failed query." });
    const append = createEventAppendSpy();
    const service = new EmbeddingRecallService({
      embeddingRepo: {
        listByObjectIds: vi.fn(async () => [createEmbeddingRecord({
          object_id: memory.object_id,
          content_hash: hashMemoryContent(memory.content)
        })])
      },
      provider: createProvider({ embedTexts: vi.fn(async () => { throw new Error("offline"); }) }),
      eventLogRepo: { append, queryByEntity: vi.fn(async () => []) }
    });

    const snapshot = await service.prepareRecallEmbeddingSnapshot({
      workspaceId: "workspace-1",
      runId: null,
      queryText: "failed query",
      poolMemories: [memory],
      maxNeighbors: 0
    });
    await service.materializeEmbeddingSupplementFromSnapshot({
      snapshot,
      eligibleMemories: [memory],
      baseCandidateIds: [memory.object_id],
      maxSupplement: 1
    });

    expect(snapshot.degradedReason).toBe("query_embedding_failed");
    expect(append.mock.calls.map(([entry]) => entry.event_type)).toEqual([
      ComputeRecallGardenEventType.RECALL_EMBEDDING_SUPPLEMENT_DEGRADED
    ]);
  });

  it("treats a request with no stored vectors as a benign empty result", async () => {
    const memory = createMemoryEntry({ object_id: "pool-without-vector", content: "No vector." });
    const append = createEventAppendSpy();
    const service = new EmbeddingRecallService({
      embeddingRepo: { listByObjectIds: vi.fn(async () => []) },
      provider: createProvider(),
      eventLogRepo: { append, queryByEntity: vi.fn(async () => []) }
    });

    const snapshot = await service.prepareRecallEmbeddingSnapshot({
      workspaceId: "workspace-1",
      runId: null,
      queryText: "no vector query",
      poolMemories: [memory],
      maxNeighbors: 0
    });
    await service.materializeEmbeddingSupplementFromSnapshot({
      snapshot,
      eligibleMemories: [memory],
      baseCandidateIds: [],
      maxSupplement: 1
    });

    expect(snapshot.degradedReason).toBeNull();
    expect(snapshot.workspaceNeighbors.query_embedding_status).toBe("provider_not_requested");
    expect(append).not.toHaveBeenCalled();
  });

  it("does not invoke an unavailable provider and records supplement degradation", async () => {
    const memory = createMemoryEntry({ object_id: "pooled", content: "Pooled memory." });
    const listByWorkspace = vi.fn(async () => []);
    const listByObjectIds = vi.fn(async () => [
      createEmbeddingRecord({
        object_id: memory.object_id,
        content_hash: hashMemoryContent(memory.content)
      })
    ]);
    const embedTexts = vi.fn(async () => [new Float32Array([1, 0])]);
    const append = vi.fn(async (
      entry: Omit<EventLogEntry, "event_id" | "created_at" | "revision">
    ) => ({
      event_id: `event-${entry.event_type}`,
      created_at: "2026-07-14T00:00:00.000Z",
      revision: 0,
      ...entry
    }));
    const service = new EmbeddingRecallService({
      embeddingRepo: { listByWorkspace, listByObjectIds },
      provider: createProvider({ isAvailable: false, embedTexts }),
      eventLogRepo: { append, queryByEntity: vi.fn(async () => []) }
    });

    const snapshot = await service.prepareRecallEmbeddingSnapshot({
      workspaceId: "workspace-1",
      runId: null,
      queryText: "pooled query",
      poolMemories: [memory],
      maxNeighbors: 5
    });
    const supplement = await service.materializeEmbeddingSupplementFromSnapshot({
      snapshot,
      eligibleMemories: [memory],
      baseCandidateIds: [memory.object_id],
      maxSupplement: 5
    });

    expect(listByWorkspace).not.toHaveBeenCalled();
    expect(listByObjectIds).toHaveBeenCalledOnce();
    expect(embedTexts).not.toHaveBeenCalled();
    expect(snapshot.poolScoresByObjectId).toEqual({});
    expect(snapshot.degradedReason).toBe("provider_unavailable");
    expect(supplement.supplementaryEntries).toEqual([]);
    expect(append.mock.calls.map(([entry]) => entry.event_type)).toEqual([
      ComputeRecallGardenEventType.RECALL_EMBEDDING_SUPPLEMENT_DEGRADED
    ]);
  });
});

function createEventAppendSpy() {
  return vi.fn(async (
    entry: Omit<EventLogEntry, "event_id" | "created_at" | "revision">
  ) => ({
    event_id: `event-${entry.event_type}`,
    created_at: "2026-07-14T00:00:00.000Z",
    revision: 0,
    ...entry
  }));
}
