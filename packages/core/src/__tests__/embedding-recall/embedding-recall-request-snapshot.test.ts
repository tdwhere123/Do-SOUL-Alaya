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

interface CosineParityCase {
  readonly name: string;
  readonly query: readonly number[];
  readonly stored: readonly number[];
  readonly recordEligible?: boolean;
  readonly dimensions?: number;
  readonly modelId?: string;
  readonly stale?: boolean;
}

const COSINE_PARITY_CASES: readonly CosineParityCase[] = Object.freeze([
  { name: "finite vectors", query: [3, 4], stored: [4, 3] },
  { name: "finite mixed signs", query: [1, -2, 3], stored: [2, 1, 1] },
  { name: "finite fractions", query: [0.25, -0.5, 1.5], stored: [2, -1, 0.25] },
  { name: "a zero query", query: [0, 0], stored: [4, 3] },
  { name: "a negative cosine", query: [1, 0], stored: [-1, 0] },
  { name: "a non-finite query", query: [Number.NaN, 1], stored: [4, 3] },
  { name: "a zero document", query: [3, 4], stored: [0, 0] },
  { name: "a non-finite document", query: [3, 4], stored: [Number.POSITIVE_INFINITY, 1] },
  { name: "a dimension mismatch", query: [3, 4], stored: [4, 3], recordEligible: false, dimensions: 3 },
  { name: "a provider mismatch", query: [3, 4], stored: [4, 3], recordEligible: false, modelId: "other-model" },
  { name: "a stale content hash", query: [3, 4], stored: [4, 3], recordEligible: false, stale: true }
]);

describe("EmbeddingRecallService request score snapshot", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    resetCoreConfigForTests();
  });

  it("hydrates each request vector once and preserves pool and neighbor output", async () => {
    const fixture = createHydrationFixture();
    const snapshot = await prepareHydrationSnapshot(fixture);

    expect(fixture.listByWorkspace).toHaveBeenCalledOnce();
    expect(fixture.listByWorkspace).toHaveBeenCalledWith("workspace-1", expect.objectContaining({
      tierFilter: ["hot", "warm"],
      limit: 4
    }));
    expect(fixture.listByObjectIds).toHaveBeenCalledWith("workspace-1", ["pool-stale"]);
    expect(fixture.embedTexts).toHaveBeenCalledOnce();
    expect(snapshot).not.toHaveProperty("preparedQuery");
    expect(snapshot.scoringLatencyMs).toBe(7);
    expect(snapshot.workspaceNeighbors.hits.map((hit) => hit.object_id)).toEqual([
      "neighbor-a",
      "neighbor-b"
    ]);
    expect(Object.keys(snapshot.poolScoresByObjectId).sort()).toEqual(["pool-cold", "pool-hot"]);
    expect(snapshot.poolScoresByObjectId[fixture.stale.object_id]).toBeUndefined();
  });

  it("normalizes one query once while scoring multiple records", async () => {
    const fixture = createHydrationFixture();
    const sqrt = vi.spyOn(Math, "sqrt");

    await prepareHydrationSnapshot(fixture);

    expect(sqrt.mock.calls.filter(([squaredMagnitude]) => squaredMagnitude === 4)).toHaveLength(1);
  });

  it("materializes supplement telemetry from the request snapshot", async () => {
    const fixture = createHydrationFixture();
    const snapshot = await prepareHydrationSnapshot(fixture);
    const supplement = await fixture.service.materializeEmbeddingSupplementFromSnapshot({
      snapshot,
      eligibleMemories: [fixture.hot, fixture.cold, fixture.stale],
      baseCandidateIds: [fixture.hot.object_id],
      maxSupplement: 2
    });

    expect(supplement.supplementaryEntries.map((entry) => entry.object_id)).toEqual(["pool-cold"]);
    expect(Object.keys(supplement.similarityHintsByObjectId).sort()).toEqual(["pool-cold", "pool-hot"]);
    expect(fixture.append.mock.calls.map(([entry]) => entry.event_type)).toEqual([
      ComputeRecallGardenEventType.RECALL_EMBEDDING_SUPPLEMENT_QUERIED,
      ComputeRecallGardenEventType.RECALL_EMBEDDING_SUPPLEMENT_MERGED
    ]);
    expect(fixture.append.mock.calls[0]?.[0].payload_json).toEqual(expect.objectContaining({
      latency_ms: 12
    }));
  });

  it.each(COSINE_PARITY_CASES)(
    "preserves independent cosine semantics for $name",
    async (testCase) => {
      const result = await prepareCosineParityCase(testCase);
      const expected = testCase.recordEligible === false
        ? 0
        : referenceRecallCosineScore(result.query, result.stored);

      expectSnapshotScore(result.snapshot.poolScoresByObjectId[result.memory.object_id], expected);
    }
  );

  it.each(["missing", "failed"] as const)(
    "preserves pool scoring when the workspace scan is %s",
    async (scanState) => {
      const result = await preparePoolScanFallback(scanState);

      expect(result.listByObjectIds).toHaveBeenCalledWith("workspace-1", [result.memory.object_id]);
      expect(result.embedTexts).toHaveBeenCalledOnce();
      expect(result.snapshot.poolScoresByObjectId[result.memory.object_id]).toBeCloseTo(1, 5);
      expect(result.snapshot.degradedReason).toBe(
        scanState === "failed" ? "local_vector_lookup_failed" : null
      );
      expect(result.append.mock.calls.map(([entry]) => entry.event_type)).toEqual([
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
    const append = createEventAppendSpy();
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

function createHydrationMemories() {
  return {
    hot: createMemoryEntry({ object_id: "pool-hot", content: "Hot pool memory." }),
    cold: createMemoryEntry({
      object_id: "pool-cold",
      content: "Cold pool memory.",
      storage_tier: "cold"
    }),
    stale: createMemoryEntry({ object_id: "pool-stale", content: "Current memory." }),
    neighborA: createMemoryEntry({ object_id: "neighbor-a", content: "Semantic neighbor A." }),
    neighborB: createMemoryEntry({ object_id: "neighbor-b", content: "Semantic neighbor B." })
  };
}

function buildHydrationWorkspaceRecords(memories: ReturnType<typeof createHydrationMemories>) {
  return [
    createEmbeddingRecord({
      object_id: memories.hot.object_id,
      content_hash: hashMemoryContent(memories.hot.content),
      embedding: new Float32Array([1, 0])
    }),
    ...[memories.neighborB, memories.neighborA].map((memory) => createEmbeddingRecord({
      object_id: memory.object_id,
      content_hash: hashMemoryContent(memory.content),
      embedding: new Float32Array([0.9, 0.1])
    })),
    createEmbeddingRecord({
      object_id: memories.cold.object_id,
      content_hash: hashMemoryContent(memories.cold.content),
      embedding: new Float32Array([0.8, 0.2])
    })
  ];
}

function buildHydrationExactRecords(memories: ReturnType<typeof createHydrationMemories>) {
  return [
    createEmbeddingRecord({
      object_id: memories.cold.object_id,
      content_hash: hashMemoryContent(memories.cold.content),
      embedding: new Float32Array([0.8, 0.2])
    }),
    createEmbeddingRecord({
      object_id: memories.stale.object_id,
      content_hash: hashMemoryContent("Outdated memory."),
      embedding: new Float32Array([1, 0])
    })
  ];
}

function createHydrationFixture() {
  installCoreConfigFromProcessEnv({ ALAYA_EMBEDDING_WORKSPACE_SCAN_CAP: "3" });
  const memories = createHydrationMemories();
  const listByWorkspace = vi.fn(async () => buildHydrationWorkspaceRecords(memories));
  const listByObjectIds = vi.fn(async () => buildHydrationExactRecords(memories));
  const embedTexts = vi.fn(async () => [new Float32Array([2, 0])]);
  const nowEpochMs = vi.fn()
    .mockReturnValueOnce(100)
    .mockReturnValueOnce(107)
    .mockReturnValueOnce(200)
    .mockReturnValueOnce(205);
  const append = createEventAppendSpy();
  const service = new EmbeddingRecallService({
    embeddingRepo: { listByWorkspace, listByObjectIds },
    provider: createProvider({ embedTexts }),
    eventLogRepo: { append, queryByEntity: vi.fn(async () => []) },
    generateQueryId: () => "request-score-snapshot",
    now: () => "2026-07-14T00:00:00.000Z",
    nowEpochMs
  });
  return { ...memories, listByWorkspace, listByObjectIds, embedTexts, append, service };
}

function prepareHydrationSnapshot(fixture: ReturnType<typeof createHydrationFixture>) {
  return fixture.service.prepareRecallEmbeddingSnapshot({
    workspaceId: "workspace-1",
    runId: "run-1",
    queryText: "semantic request",
    poolMemories: [fixture.hot, fixture.cold, fixture.stale],
    maxNeighbors: 5
  });
}

async function prepareCosineParityCase(testCase: CosineParityCase) {
  const memory = createMemoryEntry({ object_id: "cosine-candidate", content: "Current content." });
  const query = new Float32Array(testCase.query);
  const stored = new Float32Array(testCase.stored);
  const service = new EmbeddingRecallService({
    embeddingRepo: {
      listByObjectIds: vi.fn(async () => [createEmbeddingRecord({
        object_id: memory.object_id,
        content_hash: hashMemoryContent(testCase.stale ? "Stale content." : memory.content),
        model_id: testCase.modelId,
        dimensions: testCase.dimensions,
        embedding: stored
      })])
    },
    provider: createProvider({ embedTexts: vi.fn(async () => [query]) }),
    eventLogRepo: { append: createEventAppendSpy(), queryByEntity: vi.fn(async () => []) }
  });
  const snapshot = await service.prepareRecallEmbeddingSnapshot({
    workspaceId: "workspace-1",
    runId: null,
    queryText: "cosine query",
    poolMemories: [memory],
    maxNeighbors: 0
  });
  return { memory, query, stored, snapshot };
}

function referenceRecallCosineScore(left: Float32Array, right: Float32Array): number {
  if (left.length === 0 || left.length !== right.length) return 0;
  const dot = Array.from(left).reduce(
    (total, value, index) => total + value * (right[index] ?? 0),
    0
  );
  const similarity = dot / (Math.hypot(...left) * Math.hypot(...right));
  return Number.isFinite(similarity)
    ? Math.min(1, Math.max(0, similarity))
    : 0;
}

function expectSnapshotScore(actual: number | undefined, expected: number): void {
  if (expected > 0) {
    expect(actual).toBeCloseTo(expected, 7);
    return;
  }
  expect(actual).toBeUndefined();
}

async function preparePoolScanFallback(scanState: "missing" | "failed") {
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
  await service.materializeEmbeddingSupplementFromSnapshot({
    snapshot,
    eligibleMemories: [memory],
    baseCandidateIds: [memory.object_id],
    maxSupplement: 1
  });
  return { memory, listByObjectIds, embedTexts, append, snapshot };
}

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
