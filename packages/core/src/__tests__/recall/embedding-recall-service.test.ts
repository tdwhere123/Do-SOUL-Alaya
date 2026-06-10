import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  HealthEventKind,
  MemoryDimension,
  ComputeRecallGardenEventType,
  ScopeClass,
  type EventLogEntry,
  type HealthJournalRecordInput,
  type MemoryEntry
} from "@do-soul/alaya-protocol";
import {
  EMBEDDING_WORKSPACE_SCAN_CAP,
  EmbeddingRecallService,
  OpenAIEmbeddingClient,
  type EmbeddingVectorRecord
} from "../../embedding-recall-service.js";
import type { TestMock } from "../mock-types.js";

describe("EmbeddingRecallService", () => {
  it("queries the local vector table, emits telemetry, and returns additive candidates plus similarity hints", async () => {
    const appendSpy = vi.fn(async (entry: Omit<EventLogEntry, "event_id" | "created_at" | "revision">) => ({
      event_id: `event-${entry.event_type}`,
      created_at: "2026-04-23T00:00:00.000Z",
      revision: 0,
      ...entry
    }));
    const healthJournal = {
      record: vi.fn(async (_entry: HealthJournalRecordInput) => undefined)
    };
    const service = new EmbeddingRecallService({
      embeddingRepo: {
        listByObjectIds: vi.fn(async () => [
          createEmbeddingRecord({
            object_id: "memory-1",
            content_hash: hashMemoryContent("Lexical baseline."),
            embedding: new Float32Array([0.8, 0.2])
          }),
          createEmbeddingRecord({
            object_id: "memory-2",
            content_hash: hashMemoryContent("Semantic supplement."),
            embedding: new Float32Array([0.1, 0.99])
          })
        ])
      },
      provider: createProvider({
        embedTexts: vi.fn(async () => [new Float32Array([0, 1])])
      }),
      eventLogRepo: {
        append: appendSpy,
        queryByEntity: vi.fn(async () => [])
      },
      healthJournalRecorder: healthJournal,
      generateQueryId: () => "query-1",
      now: () => "2026-04-23T00:00:00.000Z"
    });

    const result = await service.querySupplement({
      workspaceId: "workspace-1",
      runId: "run-1",
      queryText: "Semantic recall ranking",
      eligibleMemories: [
        createMemoryEntry({ object_id: "memory-1", content: "Lexical baseline." }),
        createMemoryEntry({ object_id: "memory-2", content: "Semantic supplement." })
      ],
      baseCandidateIds: ["memory-1"],
      maxSupplement: 1
    });

    expect(result.supplementaryEntries.map((entry) => entry.object_id)).toEqual(["memory-2"]);
    expect(result.similarityHintsByObjectId["memory-1"]).toMatchObject({
      object_id: "memory-1"
    });
    expect(result.similarityHintsByObjectId["memory-2"]).toMatchObject({
      object_id: "memory-2"
    });
    expect(
      result.similarityHintsByObjectId["memory-2"]!.normalized_similarity
    ).toBeGreaterThan(result.similarityHintsByObjectId["memory-1"]!.normalized_similarity);
    expect(appendSpy.mock.calls.map(([entry]) => entry.event_type)).toEqual([
      ComputeRecallGardenEventType.RECALL_EMBEDDING_SUPPLEMENT_QUERIED,
      ComputeRecallGardenEventType.RECALL_EMBEDDING_SUPPLEMENT_MERGED
    ]);
    expect(appendSpy.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        payload_json: expect.objectContaining({
          query_id: "query-1",
          requested_limit: 1,
          returned_candidate_count: 2
        })
      })
    );
    expect(appendSpy.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({
        payload_json: expect.objectContaining({
          query_id: "query-1",
          base_candidate_count: 1,
          supplement_candidate_count: 1,
          merged_candidate_count: 2
        })
      })
    );
    expect(healthJournal.record).not.toHaveBeenCalled();
  });

  it("uses a prepared query embedding when it is ready by merge time", async () => {
    const appendSpy = vi.fn(async (entry: Omit<EventLogEntry, "event_id" | "created_at" | "revision">) => ({
      event_id: `event-${entry.event_type}`,
      created_at: "2026-04-23T00:00:00.000Z",
      revision: 0,
      ...entry
    }));
    const service = new EmbeddingRecallService({
      embeddingRepo: {
        listByObjectIds: vi.fn(async () => [
          createEmbeddingRecord({
            object_id: "memory-1",
            content_hash: hashMemoryContent("Lexical baseline."),
            embedding: new Float32Array([0.8, 0.2])
          }),
          createEmbeddingRecord({
            object_id: "memory-2",
            content_hash: hashMemoryContent("Semantic supplement."),
            embedding: new Float32Array([0.1, 0.99])
          })
        ])
      },
      provider: createProvider({
        embedTexts: vi.fn(async () => [new Float32Array([0, 1])])
      }),
      eventLogRepo: {
        append: appendSpy,
        queryByEntity: vi.fn(async () => [])
      },
      generateQueryId: () => "prepared-query-1",
      now: () => "2026-04-23T00:00:00.000Z"
    });

    const preparedQuery = service.prepareQueryEmbedding({
      workspaceId: "workspace-1",
      runId: "run-1",
      queryText: "Semantic recall ranking"
    });
    await Promise.resolve();

    const result = await service.querySupplementIfReady({
      workspaceId: "workspace-1",
      runId: "run-1",
      eligibleMemories: [
        createMemoryEntry({ object_id: "memory-1", content: "Lexical baseline." }),
        createMemoryEntry({ object_id: "memory-2", content: "Semantic supplement." })
      ],
      baseCandidateIds: ["memory-1"],
      maxSupplement: 1,
      preparedQuery
    });

    expect(result.supplementaryEntries.map((entry) => entry.object_id)).toEqual(["memory-2"]);
    expect(result.similarityHintsByObjectId["memory-2"]).toMatchObject({
      object_id: "memory-2"
    });
    expect(appendSpy.mock.calls.map(([entry]) => entry.event_type)).toEqual([
      ComputeRecallGardenEventType.RECALL_EMBEDDING_SUPPLEMENT_QUERIED,
      ComputeRecallGardenEventType.RECALL_EMBEDDING_SUPPLEMENT_MERGED
    ]);
  });

  it("reuses prepared stored vectors instead of reading the vector table twice", async () => {
    const appendSpy = vi.fn(async (entry: Omit<EventLogEntry, "event_id" | "created_at" | "revision">) => ({
      event_id: `event-${entry.event_type}`,
      created_at: "2026-04-23T00:00:00.000Z",
      revision: 0,
      ...entry
    }));
    const listByObjectIds = vi.fn(async () => [
      createEmbeddingRecord({
        object_id: "memory-1",
        content_hash: hashMemoryContent("Lexical baseline."),
        embedding: new Float32Array([0.8, 0.2])
      }),
      createEmbeddingRecord({
        object_id: "memory-2",
        content_hash: hashMemoryContent("Semantic supplement."),
        embedding: new Float32Array([0.1, 0.99])
      })
    ]);
    const service = new EmbeddingRecallService({
      embeddingRepo: { listByObjectIds },
      provider: createProvider({
        embedTexts: vi.fn(async () => [new Float32Array([0, 1])])
      }),
      eventLogRepo: {
        append: appendSpy,
        queryByEntity: vi.fn(async () => [])
      },
      generateQueryId: () => "prepared-supplement-query",
      now: () => "2026-04-23T00:00:00.000Z"
    });
    const eligibleMemories = [
      createMemoryEntry({ object_id: "memory-1", content: "Lexical baseline." }),
      createMemoryEntry({ object_id: "memory-2", content: "Semantic supplement." })
    ];

    const prepared = await service.prepareQuerySupplement({
      workspaceId: "workspace-1",
      runId: "run-1",
      queryText: "Semantic recall ranking",
      eligibleMemories,
      baseCandidateCount: 1
    });
    expect(prepared.preparedQuery).not.toBeNull();
    await Promise.resolve();
    const result = await service.querySupplementIfReady({
      workspaceId: "workspace-1",
      runId: "run-1",
      eligibleMemories,
      baseCandidateIds: ["memory-1"],
      maxSupplement: 1,
      preparedQuery: prepared.preparedQuery!,
      storedVectors: prepared.storedVectors
    });

    expect(listByObjectIds).toHaveBeenCalledTimes(1);
    expect(result.supplementaryEntries.map((entry) => entry.object_id)).toEqual(["memory-2"]);
  });

  it("uses warmed query embeddings without calling the provider during recall preparation", async () => {
    const appendSpy = vi.fn(async (entry: Omit<EventLogEntry, "event_id" | "created_at" | "revision">) => ({
      event_id: `event-${entry.event_type}`,
      created_at: "2026-04-23T00:00:00.000Z",
      revision: 0,
      ...entry
    }));
    const embedTexts = vi.fn(async (texts: readonly string[]) =>
      texts.map(() => new Float32Array([0, 1]))
    );
    const service = new EmbeddingRecallService({
      embeddingRepo: {
        listByObjectIds: vi.fn(async () => [
          createEmbeddingRecord({
            object_id: "memory-1",
            content_hash: hashMemoryContent("Lexical baseline."),
            embedding: new Float32Array([0.8, 0.2])
          }),
          createEmbeddingRecord({
            object_id: "memory-2",
            content_hash: hashMemoryContent("Semantic supplement."),
            embedding: new Float32Array([0.1, 0.99])
          })
        ])
      },
      provider: createProvider({ embedTexts }),
      eventLogRepo: {
        append: appendSpy,
        queryByEntity: vi.fn(async () => [])
      },
      generateQueryId: () => "warmed-query",
      now: () => "2026-04-23T00:00:00.000Z"
    });
    const eligibleMemories = [
      createMemoryEntry({ object_id: "memory-1", content: "Lexical baseline." }),
      createMemoryEntry({ object_id: "memory-2", content: "Semantic supplement." })
    ];

    const warmup = await service.warmQueryEmbeddings({
      workspaceId: "workspace-1",
      runId: "run-1",
      queryTexts: ["Semantic recall ranking"]
    });
    const prepared = await service.prepareQuerySupplement({
      workspaceId: "workspace-1",
      runId: "run-1",
      queryText: "Semantic recall ranking",
      eligibleMemories,
      baseCandidateCount: 1
    });
    const result = await service.querySupplementIfReady({
      workspaceId: "workspace-1",
      runId: "run-1",
      eligibleMemories,
      baseCandidateIds: ["memory-1"],
      maxSupplement: 1,
      preparedQuery: prepared.preparedQuery!,
      storedVectors: prepared.storedVectors
    });

    expect(warmup).toMatchObject({
      status: "ready",
      requested_count: 1,
      ready_count: 1,
      provider_requested_count: 1
    });
    expect(prepared.preparedQuery?.getSnapshot().status).toBe("ready");
    expect(embedTexts).toHaveBeenCalledTimes(1);
    expect(result.supplementaryEntries.map((entry) => entry.object_id)).toEqual(["memory-2"]);
  });

  it("keeps partial query warmup evidence when one provider batch fails", async () => {
    const queries = Array.from({ length: 33 }, (_, index) => `query-${index}`);
    const embedTexts = vi.fn(async (texts: readonly string[]) => {
      if (texts.includes("query-16")) {
        throw new Error("provider temporarily unreachable");
      }
      return texts.map(() => new Float32Array([0, 1]));
    });
    const service = new EmbeddingRecallService({
      embeddingRepo: { listByObjectIds: vi.fn(async () => []) },
      provider: createProvider({ embedTexts }),
      eventLogRepo: {
        append: vi.fn(),
        queryByEntity: vi.fn(async () => [])
      },
      generateQueryId: () => "partial-query-warmup",
      now: () => "2026-04-23T00:00:00.000Z"
    });

    const warmup = await service.warmQueryEmbeddings({
      workspaceId: "workspace-1",
      runId: "run-1",
      queryTexts: queries
    });

    expect(embedTexts).toHaveBeenCalledTimes(3);
    expect(warmup).toMatchObject({
      status: "ready",
      requested_count: 33,
      ready_count: 17,
      provider_requested_count: 33,
      missing_count: 16,
      last_error: "provider temporarily unreachable"
    });
  });

  it("waits briefly for a prepared query embedding before degrading", async () => {
    const appendSpy = vi.fn(async (entry: Omit<EventLogEntry, "event_id" | "created_at" | "revision">) => ({
      event_id: `event-${entry.event_type}`,
      created_at: "2026-04-23T00:00:00.000Z",
      revision: 0,
      ...entry
    }));
    const service = new EmbeddingRecallService({
      embeddingRepo: {
        listByObjectIds: vi.fn(async () => [
          createEmbeddingRecord({
            object_id: "memory-1",
            content_hash: hashMemoryContent("Lexical baseline."),
            embedding: new Float32Array([0.8, 0.2])
          }),
          createEmbeddingRecord({
            object_id: "memory-2",
            content_hash: hashMemoryContent("Semantic supplement."),
            embedding: new Float32Array([0.1, 0.99])
          })
        ])
      },
      provider: createProvider({
        embedTexts: vi.fn(async () =>
          await new Promise<readonly Float32Array[]>((resolve) => {
            setTimeout(() => resolve([new Float32Array([0, 1])]), 10);
          })
        )
      }),
      eventLogRepo: {
        append: appendSpy,
        queryByEntity: vi.fn(async () => [])
      },
      generateQueryId: () => "prepared-query-wait",
      now: () => "2026-04-23T00:00:00.000Z",
      queryTimeoutMs: 100
    });

    const preparedQuery = service.prepareQueryEmbedding({
      workspaceId: "workspace-1",
      runId: "run-1",
      queryText: "Semantic recall ranking"
    });

    const result = await service.querySupplementIfReady({
      workspaceId: "workspace-1",
      runId: "run-1",
      eligibleMemories: [
        createMemoryEntry({ object_id: "memory-1", content: "Lexical baseline." }),
        createMemoryEntry({ object_id: "memory-2", content: "Semantic supplement." })
      ],
      baseCandidateIds: ["memory-1"],
      maxSupplement: 1,
      preparedQuery
    });

    expect(result.supplementaryEntries.map((entry) => entry.object_id)).toEqual(["memory-2"]);
    expect(appendSpy.mock.calls.map(([entry]) => entry.event_type)).toEqual([
      ComputeRecallGardenEventType.RECALL_EMBEDDING_SUPPLEMENT_QUERIED,
      ComputeRecallGardenEventType.RECALL_EMBEDDING_SUPPLEMENT_MERGED
    ]);
  });

  it("records degraded fallback when the prepared query embedding is not ready by merge time", async () => {
    const appendSpy = vi.fn(async (entry: Omit<EventLogEntry, "event_id" | "created_at" | "revision">) => ({
      event_id: `event-${entry.event_type}`,
      created_at: "2026-04-23T00:00:00.000Z",
      revision: 0,
      ...entry
    }));
    const healthJournal = {
      record: vi.fn(async (_entry: HealthJournalRecordInput) => undefined)
    };
    const service = new EmbeddingRecallService({
      embeddingRepo: {
        listByObjectIds: vi.fn(async () => [
          createEmbeddingRecord({
            object_id: "memory-1",
            content_hash: hashMemoryContent("Lexical baseline."),
            embedding: new Float32Array([0.8, 0.2])
          })
        ])
      },
      provider: createProvider({
        embedTexts: vi.fn(async () => await new Promise<readonly Float32Array[]>(() => undefined))
      }),
      eventLogRepo: {
        append: appendSpy,
        queryByEntity: vi.fn(async () => [])
      },
      healthJournalRecorder: healthJournal,
      generateQueryId: () => "prepared-query-pending",
      now: () => "2026-04-23T00:00:00.000Z",
      queryTimeoutMs: 50
    });

    const preparedQuery = service.prepareQueryEmbedding({
      workspaceId: "workspace-1",
      runId: "run-1",
      queryText: "Semantic recall ranking"
    });

    const result = await service.querySupplementIfReady({
      workspaceId: "workspace-1",
      runId: "run-1",
      eligibleMemories: [createMemoryEntry({ object_id: "memory-1", content: "Lexical baseline." })],
      baseCandidateIds: ["memory-1"],
      maxSupplement: 1,
      preparedQuery
    });

    expect(result).toEqual({
      supplementaryEntries: [],
      similarityHintsByObjectId: {}
    });
    expect(appendSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: ComputeRecallGardenEventType.RECALL_EMBEDDING_SUPPLEMENT_DEGRADED,
        payload_json: expect.objectContaining({
          query_id: "prepared-query-pending",
          degradation_reason: "query_embedding_pending",
          base_candidate_count: 1,
          fallback_candidate_count: 1
        })
      })
    );
    expect(healthJournal.record).toHaveBeenCalledWith(
      expect.objectContaining({
        event_kind: HealthEventKind.EMBEDDING_SUPPLEMENT,
        detail_json: expect.objectContaining({
          query_id: "prepared-query-pending",
          reason: "query_embedding_pending"
        })
      })
    );
  });

  it("degrades to keyword-only recall when the embedding provider is unavailable", async () => {
    const appendSpy = vi.fn(async (entry: Omit<EventLogEntry, "event_id" | "created_at" | "revision">) => ({
      event_id: `event-${entry.event_type}`,
      created_at: "2026-04-23T00:00:00.000Z",
      revision: 0,
      ...entry
    }));
    const healthJournal = {
      record: vi.fn(async (_entry: HealthJournalRecordInput) => undefined)
    };
    const service = new EmbeddingRecallService({
      embeddingRepo: {
        listByObjectIds: vi.fn(async () => [])
      },
      provider: createProvider({ isAvailable: false }),
      eventLogRepo: {
        append: appendSpy,
        queryByEntity: vi.fn(async () => [])
      },
      healthJournalRecorder: healthJournal,
      generateQueryId: () => "query-unavailable",
      now: () => "2026-04-23T00:00:00.000Z"
    });

    const result = await service.querySupplement({
      workspaceId: "workspace-1",
      runId: "run-1",
      queryText: "Semantic recall ranking",
      eligibleMemories: [createMemoryEntry({ object_id: "memory-1" })],
      baseCandidateIds: ["memory-1"],
      maxSupplement: 2
    });

    expect(result.supplementaryEntries).toEqual([]);
    expect(result.similarityHintsByObjectId).toEqual({});
    expect(appendSpy).toHaveBeenCalledTimes(1);
    expect(appendSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: ComputeRecallGardenEventType.RECALL_EMBEDDING_SUPPLEMENT_DEGRADED,
        payload_json: expect.objectContaining({
          query_id: "query-unavailable",
          degradation_reason: "provider_unavailable",
          base_candidate_count: 1,
          fallback_candidate_count: 1
        })
      })
    );
    expect(healthJournal.record).toHaveBeenCalledWith(
      expect.objectContaining({
        event_kind: HealthEventKind.EMBEDDING_SUPPLEMENT,
        summary: "Embedding supplement degraded to keyword-only recall.",
        detail_json: expect.objectContaining({
          query_id: "query-unavailable",
          reason: "provider_unavailable"
        })
      })
    );
  });

  it("degrades to keyword-only recall when query embedding generation fails", async () => {
    const appendSpy = vi.fn(async (entry: Omit<EventLogEntry, "event_id" | "created_at" | "revision">) => ({
      event_id: `event-${entry.event_type}`,
      created_at: "2026-04-23T00:00:00.000Z",
      revision: 0,
      ...entry
    }));
    const healthJournal = {
      record: vi.fn(async (_entry: HealthJournalRecordInput) => undefined)
    };
    const warn = vi.fn();
    const service = new EmbeddingRecallService({
      embeddingRepo: {
        listByObjectIds: vi.fn(async () => [
          createEmbeddingRecord({
            object_id: "memory-1",
            embedding: new Float32Array([1, 0])
          })
        ])
      },
      provider: createProvider({
        embedTexts: vi.fn(async () => {
          throw new Error("network timeout");
        })
      }),
      eventLogRepo: {
        append: appendSpy,
        queryByEntity: vi.fn(async () => [])
      },
      healthJournalRecorder: healthJournal,
      generateQueryId: () => "query-error",
      now: () => "2026-04-23T00:00:00.000Z",
      warn
    });

    const result = await service.querySupplement({
      workspaceId: "workspace-1",
      runId: "run-1",
      queryText: "Semantic recall ranking",
      eligibleMemories: [createMemoryEntry({ object_id: "memory-1" })],
      baseCandidateIds: ["memory-1"],
      maxSupplement: 2
    });

    expect(result.supplementaryEntries).toEqual([]);
    expect(result.similarityHintsByObjectId).toEqual({});
    expect(appendSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: ComputeRecallGardenEventType.RECALL_EMBEDDING_SUPPLEMENT_DEGRADED,
        payload_json: expect.objectContaining({
          query_id: "query-error",
          degradation_reason: "query_embedding_failed",
          fallback_candidate_count: 1
        })
      })
    );
    expect(healthJournal.record).toHaveBeenCalledWith(
      expect.objectContaining({
        event_kind: HealthEventKind.EMBEDDING_SUPPLEMENT,
        detail_json: expect.objectContaining({
          reason: "query_embedding_failed"
        })
      })
    );
    expect(warn).toHaveBeenCalledWith("embedding supplement degraded", {
      workspace_id: "workspace-1",
      run_id: "run-1",
      reason: "query_embedding_failed",
      error: "network timeout"
    });
  });

  it("keeps successful supplement recall on the lexical path when queried/merged telemetry append fails", async () => {
    const appendSpy = vi
      .fn<EmbeddingRecallAppendSpy>()
      .mockRejectedValueOnce(new Error("eventlog offline"))
      .mockResolvedValue({
        event_id: "event-merged",
        created_at: "2026-04-23T00:00:00.000Z",
        revision: 0,
        event_type: ComputeRecallGardenEventType.RECALL_EMBEDDING_SUPPLEMENT_MERGED,
        entity_type: "recall_embedding_supplement",
        entity_id: "query-telemetry-fail",
        workspace_id: "workspace-1",
        run_id: "run-1",
        caused_by: "system",
        payload_json: {}
      });
    const warn = vi.fn();
    const service = new EmbeddingRecallService({
      embeddingRepo: {
        listByObjectIds: vi.fn(async () => [
          createEmbeddingRecord({
            object_id: "memory-1",
            content_hash: hashMemoryContent("Lexical baseline."),
            embedding: new Float32Array([0.2, 0.8])
          }),
          createEmbeddingRecord({
            object_id: "memory-2",
            content_hash: hashMemoryContent("Semantic supplement."),
            embedding: new Float32Array([0.1, 0.95])
          })
        ])
      },
      provider: createProvider({
        embedTexts: vi.fn(async () => [new Float32Array([0, 1])])
      }),
      eventLogRepo: {
        append: appendSpy,
        queryByEntity: vi.fn(async () => [])
      },
      generateQueryId: () => "query-telemetry-fail",
      now: () => "2026-04-23T00:00:00.000Z",
      warn
    });

    const result = await service.querySupplement({
      workspaceId: "workspace-1",
      runId: "run-1",
      queryText: "Semantic recall ranking",
      eligibleMemories: [
        createMemoryEntry({ object_id: "memory-1", content: "Lexical baseline." }),
        createMemoryEntry({ object_id: "memory-2", content: "Semantic supplement." })
      ],
      baseCandidateIds: ["memory-1"],
      maxSupplement: 1
    });

    expect(result.supplementaryEntries.map((entry) => entry.object_id)).toEqual(["memory-2"]);
    expect(result.similarityHintsByObjectId["memory-2"]).toMatchObject({
      object_id: "memory-2"
    });
    expect(warn).toHaveBeenCalledWith("embedding supplement telemetry failed", {
      workspace_id: "workspace-1",
      run_id: "run-1",
      query_id: "query-telemetry-fail",
      stage: "queried",
      error: "eventlog offline"
    });
  });

  it("keeps degraded keyword-only recall when degrade telemetry and health journal writes fail", async () => {
    const appendSpy = vi.fn<EmbeddingRecallAppendSpy>(async () => {
      throw new Error("eventlog offline");
    });
    const healthJournal = {
      record: vi.fn(async () => {
        throw new Error("health journal offline");
      })
    };
    const warn = vi.fn();
    const service = new EmbeddingRecallService({
      embeddingRepo: {
        listByObjectIds: vi.fn(async () => [])
      },
      provider: createProvider({ isAvailable: false }),
      eventLogRepo: {
        append: appendSpy,
        queryByEntity: vi.fn(async () => [])
      },
      healthJournalRecorder: healthJournal,
      generateQueryId: () => "query-degraded-telemetry-fail",
      now: () => "2026-04-23T00:00:00.000Z",
      warn
    });

    const result = await service.querySupplement({
      workspaceId: "workspace-1",
      runId: "run-1",
      queryText: "Semantic recall ranking",
      eligibleMemories: [createMemoryEntry({ object_id: "memory-1" })],
      baseCandidateIds: ["memory-1"],
      maxSupplement: 1
    });

    expect(result).toEqual({
      supplementaryEntries: [],
      similarityHintsByObjectId: {}
    });
    expect(warn).toHaveBeenCalledWith("embedding supplement degraded telemetry failed", {
      workspace_id: "workspace-1",
      run_id: "run-1",
      query_id: "query-degraded-telemetry-fail",
      stage: "event_log",
      error: "eventlog offline"
    });
    expect(warn).toHaveBeenCalledWith("embedding supplement degraded telemetry failed", {
      workspace_id: "workspace-1",
      run_id: "run-1",
      query_id: "query-degraded-telemetry-fail",
      stage: "health_journal",
      error: "health journal offline"
    });
  });
});

describe("EmbeddingRecallService queryTimeoutMs configuration", () => {
  function buildServiceWithTimeout(options: { timeoutMs?: number; embedTexts: TestMock }) {
    return new EmbeddingRecallService({
      embeddingRepo: {
        listByObjectIds: vi.fn(async () => [])
      },
      provider: createProvider({ embedTexts: options.embedTexts }),
      eventLogRepo: {
        append: vi.fn(async (entry: Omit<EventLogEntry, "event_id" | "created_at" | "revision">) => ({
          event_id: "event-x",
          created_at: "2026-04-23T00:00:00.000Z",
          revision: 0,
          ...entry
        })),
        queryByEntity: vi.fn(async () => [])
      },
      generateQueryId: () => "query-timeout",
      now: () => "2026-04-23T00:00:00.000Z",
      ...(options.timeoutMs === undefined ? {} : { queryTimeoutMs: options.timeoutMs })
    });
  }

  it("uses the 2500ms default when queryTimeoutMs is not configured", () => {
    const embedTexts = vi.fn(async () => [new Float32Array([0, 1])]);
    const service = buildServiceWithTimeout({ embedTexts });
    service.prepareQueryEmbedding({ workspaceId: "ws-1", runId: null, queryText: "hello" });
    expect(embedTexts).toHaveBeenCalledWith(
      ["hello"],
      expect.objectContaining({ timeoutMs: 2500 })
    );
  });

  it("respects an explicit queryTimeoutMs override", () => {
    const embedTexts = vi.fn(async () => [new Float32Array([0, 1])]);
    const service = buildServiceWithTimeout({ timeoutMs: 800, embedTexts });
    service.prepareQueryEmbedding({ workspaceId: "ws-1", runId: null, queryText: "hello" });
    expect(embedTexts).toHaveBeenCalledWith(
      ["hello"],
      expect.objectContaining({ timeoutMs: 800 })
    );
  });

  it("clamps very large queryTimeoutMs to the 5000ms ceiling", () => {
    const embedTexts = vi.fn(async () => [new Float32Array([0, 1])]);
    const service = buildServiceWithTimeout({ timeoutMs: 60_000, embedTexts });
    service.prepareQueryEmbedding({ workspaceId: "ws-1", runId: null, queryText: "hello" });
    expect(embedTexts).toHaveBeenCalledWith(
      ["hello"],
      expect.objectContaining({ timeoutMs: 5000 })
    );
  });

  it("clamps very small queryTimeoutMs to the 50ms floor", () => {
    const embedTexts = vi.fn(async () => [new Float32Array([0, 1])]);
    const service = buildServiceWithTimeout({ timeoutMs: 1, embedTexts });
    service.prepareQueryEmbedding({ workspaceId: "ws-1", runId: null, queryText: "hello" });
    expect(embedTexts).toHaveBeenCalledWith(
      ["hello"],
      expect.objectContaining({ timeoutMs: 50 })
    );
  });

  it("falls back to default when queryTimeoutMs is non-finite or non-positive", () => {
    const embedTexts = vi.fn(async () => [new Float32Array([0, 1])]);
    const service = buildServiceWithTimeout({ timeoutMs: 0, embedTexts });
    service.prepareQueryEmbedding({ workspaceId: "ws-1", runId: null, queryText: "hello" });
    expect(embedTexts).toHaveBeenCalledWith(
      ["hello"],
      expect.objectContaining({ timeoutMs: 2500 })
    );
  });
});

describe("OpenAIEmbeddingClient", () => {
  it("reports provider host and transport cause without including the secret", async () => {
    const transportError = new TypeError("fetch failed") as TypeError & {
      cause: { code: string };
    };
    transportError.cause = { code: "EHOSTUNREACH" };
    const fetchImpl = vi.fn(async () => {
      throw transportError;
    }) as unknown as typeof fetch;
    const client = new OpenAIEmbeddingClient({
      apiKey: "sk-test-secret",
      baseUrl: "https://embedding.example.test/v1",
      fetchImpl,
      maxAttempts: 1
    });

    await expect(
      client.embedTexts(["smoke"], {
        timeoutMs: 1000
      })
    ).rejects.toThrow(
      "Embedding request transport failed for host embedding.example.test. cause=EHOSTUNREACH"
    );
    await expect(
      client.embedTexts(["smoke"], {
        timeoutMs: 1000
      })
    ).rejects.not.toThrow("sk-test-secret");
  });

  it("retries transient transport failures before returning embeddings", async () => {
    const transportError = new TypeError("fetch failed") as TypeError & {
      cause: { code: string };
    };
    transportError.cause = { code: "EHOSTUNREACH" };
    const fetchImpl = vi.fn()
      .mockRejectedValueOnce(transportError)
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [{ index: 0, embedding: [0.2, 0.8] }]
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      ) as unknown as typeof fetch;
    const client = new OpenAIEmbeddingClient({
      apiKey: "sk-test-secret",
      baseUrl: "https://embedding.example.test/v1",
      fetchImpl,
      maxAttempts: 2,
      retryDelayMs: 0
    });

    const embeddings = await client.embedTexts(["smoke"], {
      timeoutMs: 1000
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect([...embeddings[0]!]).toEqual([
      expect.closeTo(0.2),
      expect.closeTo(0.8)
    ]);
  });

  it("retries transient 5xx responses before returning embeddings", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response("temporary", { status: 503 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [{ index: 0, embedding: [0.4, 0.6] }]
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      ) as unknown as typeof fetch;
    const client = new OpenAIEmbeddingClient({
      apiKey: "sk-test-secret",
      baseUrl: "https://embedding.example.test/v1",
      fetchImpl,
      maxAttempts: 2,
      retryDelayMs: 0
    });

    const embeddings = await client.embedTexts(["smoke"], {
      timeoutMs: 1000
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect([...embeddings[0]!]).toEqual([
      expect.closeTo(0.4),
      expect.closeTo(0.6)
    ]);
  });

  // invariant: embedTexts MUST settle (reject) when the transport never
  // resolves AND the abort signal is ignored (the undici half-open stall). Only
  // the wall-clock backstop guarantees this; without it the guard race below
  // observes "HANG".
  // see also: packages/core/src/embedding-recall-service.ts
  //   raceFetchAgainstBackstop / EMBEDDING_TRANSPORT_BACKSTOP_MARGIN_MS
  it("rejects via the wall-clock backstop when the transport never settles and the abort is ignored", async () => {
    // seam: never-resolving fetch that ignores the abort signal == half-open
    // undici socket the AbortController cannot terminate.
    let fetchCalls = 0;
    const fetchImpl = vi.fn(async () => {
      fetchCalls += 1;
      return await new Promise<Response>(() => undefined);
    }) as unknown as typeof fetch;
    const client = new OpenAIEmbeddingClient({
      apiKey: "sk-test-secret",
      baseUrl: "https://embedding.example.test/v1",
      fetchImpl,
      maxAttempts: 1,
      // invariant: 50ms abort + 20ms margin -> settles ~70ms, never the 10s budget.
      transportBackstopMarginMs: 20
    });

    const embed = client.embedTexts(["smoke"], { timeoutMs: 50 });

    const guard = new Promise<"HANG">((resolve) => {
      const handle = setTimeout(() => resolve("HANG"), 1_000);
      handle.unref?.();
    });
    const outcome = await Promise.race([
      embed.then(
        () => "RESOLVED" as const,
        (error: unknown) => ({ rejected: error instanceof Error ? error.message : String(error) })
      ),
      guard
    ]);

    expect(outcome).not.toBe("HANG");
    expect(outcome).not.toBe("RESOLVED");
    expect(outcome).toMatchObject({
      rejected: expect.stringContaining(
        "Embedding request transport failed for host embedding.example.test."
      )
    });
    expect(fetchCalls).toBe(1);
  });

  // invariant: a transient provider blip (N-1 transport failures then success)
  // is ridden through, with an EXPONENTIAL + JITTERED backoff gap actually
  // awaited between attempts. fake timers prove the gap is consumed without
  // sleeping real seconds; onRetry proves the gaps are exponential. proof under
  // revert: a zero-backoff loop reports delayMs 0; a no-retry loop rejects on
  // the first transport error.
  // see also: packages/core/src/embedding-recall-service.ts
  //   computeEmbeddingBackoffMs / fetchEmbeddingWithRetry
  it("rides through transient transport blips with exponential jittered backoff", async () => {
    vi.useFakeTimers();
    try {
      const transportError = new TypeError("fetch failed");
      const fetchImpl = vi.fn()
        .mockRejectedValueOnce(transportError)
        .mockRejectedValueOnce(transportError)
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({ data: [{ index: 0, embedding: [0.3, 0.7] }] }),
            { status: 200, headers: { "content-type": "application/json" } }
          )
        ) as unknown as typeof fetch;
      const retryEvents: Array<{ attempt: number; delayMs: number; reason: string }> = [];
      const client = new OpenAIEmbeddingClient({
        apiKey: "sk-test-secret",
        baseUrl: "https://embedding.example.test/v1",
        fetchImpl,
        maxAttempts: 5,
        retryDelayMs: 100,
        // invariant: random==0.5 -> jitter = floor(0.5 * base) = 50ms; gaps are
        // 100+50=150 then 200+50=250 (exponential base*2^attemptIndex + jitter).
        random: () => 0.5,
        onRetry: (event) => {
          retryEvents.push({
            attempt: event.attempt,
            delayMs: event.delayMs,
            reason: event.reason
          });
        }
      });

      const embedPromise = client.embedTexts(["smoke"], { timeoutMs: 1000 });
      // Drain the two transport rejections + their awaited backoff gaps.
      await vi.runAllTimersAsync();
      const embeddings = await embedPromise;

      expect(fetchImpl).toHaveBeenCalledTimes(3);
      expect([...embeddings[0]!]).toEqual([
        expect.closeTo(0.3),
        expect.closeTo(0.7)
      ]);
      expect(retryEvents).toEqual([
        { attempt: 1, delayMs: 150, reason: "transport_error" },
        { attempt: 2, delayMs: 250, reason: "transport_error" }
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  // invariant: a persistently-down provider is NOT masked; after maxAttempts the
  // clean transport surface throws (bounded, no infinite loop). proof under
  // revert: an unbounded loop never settles; a swallowed error breaks the
  // asserted transport message.
  it("throws the clean transport error after exhausting maxAttempts", async () => {
    vi.useFakeTimers();
    try {
      const transportError = new TypeError("fetch failed") as TypeError & {
        cause: { code: string };
      };
      transportError.cause = { code: "ECONNRESET" };
      const fetchImpl = vi.fn(async () => {
        throw transportError;
      }) as unknown as typeof fetch;
      const client = new OpenAIEmbeddingClient({
        apiKey: "sk-test-secret",
        baseUrl: "https://embedding.example.test/v1",
        fetchImpl,
        maxAttempts: 4,
        retryDelayMs: 100,
        random: () => 0
      });

      const embedPromise = client.embedTexts(["smoke"], { timeoutMs: 1000 });
      const settled = embedPromise.then(
        () => "RESOLVED" as const,
        (error: unknown) => (error instanceof Error ? error.message : String(error))
      );
      await vi.runAllTimersAsync();
      const outcome = await settled;

      expect(outcome).toBe(
        "Embedding request transport failed for host embedding.example.test. cause=ECONNRESET"
      );
      expect(fetchImpl).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });

  // invariant: non-retryable 4xx (e.g. 401) FAILS FAST -- no retry, single fetch.
  // proof under revert: if isRetryableEmbeddingStatus admits 4xx, fetch count
  // and onRetry both rise above the asserted single call.
  it("does not retry non-retryable 4xx responses", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response("unauthorized", { status: 401 })
    ) as unknown as typeof fetch;
    const onRetry = vi.fn();
    const client = new OpenAIEmbeddingClient({
      apiKey: "sk-test-secret",
      baseUrl: "https://embedding.example.test/v1",
      fetchImpl,
      maxAttempts: 5,
      retryDelayMs: 100,
      onRetry
    });

    await expect(
      client.embedTexts(["smoke"], { timeoutMs: 1000 })
    ).rejects.toThrow(
      "Embedding request failed with status 401 for host embedding.example.test."
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
  });

  // invariant: the total wall-clock ceiling stops a NEW attempt from starting
  // once the budget is spent, so a stalling provider cannot compound per-attempt
  // timeouts into minutes. injected clock makes the deadline deterministic.
  // proof under revert: without the deadline guard, fetch is called the full
  // maxAttempts times instead of stopping at 2.
  it("stops starting new attempts past the total wall-clock budget", async () => {
    vi.useFakeTimers();
    try {
      const transportError = new TypeError("fetch failed");
      const fetchImpl = vi.fn(async () => {
        throw transportError;
      }) as unknown as typeof fetch;
      let clock = 0;
      const client = new OpenAIEmbeddingClient({
        apiKey: "sk-test-secret",
        baseUrl: "https://embedding.example.test/v1",
        fetchImpl,
        maxAttempts: 5,
        retryDelayMs: 100,
        random: () => 0,
        totalWallclockBudgetMs: 500,
        // invariant: each clock read advances 300ms; attempt 1 reads start (0),
        // catch reads 300 (< 500, retry), attempt 2 catch reads 900 (>= 500,
        // throw) -> only 2 fetches despite maxAttempts 5.
        now: () => {
          const value = clock;
          clock += 300;
          return value;
        }
      });

      const embedPromise = client.embedTexts(["smoke"], { timeoutMs: 1000 });
      const settled = embedPromise.then(
        () => "RESOLVED" as const,
        (error: unknown) => (error instanceof Error ? error.message : String(error))
      );
      await vi.runAllTimersAsync();
      const outcome = await settled;

      expect(outcome).toBe(
        "Embedding request transport failed for host embedding.example.test."
      );
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("EmbeddingRecallService.collectWorkspaceNeighbors", () => {
  function buildService(input: {
    readonly workspaceVectors: readonly EmbeddingVectorRecord[];
    readonly queryEmbedding: Float32Array;
    readonly listByWorkspace?: (
      workspaceId: string,
      options?: { readonly tierFilter?: readonly ("hot" | "warm" | "cold")[]; readonly limit?: number }
    ) => Promise<readonly EmbeddingVectorRecord[]>;
  }): EmbeddingRecallService {
    return new EmbeddingRecallService({
      embeddingRepo: {
        listByObjectIds: vi.fn(async () => []),
        listByWorkspace:
          input.listByWorkspace ?? vi.fn(async () => input.workspaceVectors)
      },
      provider: createProvider({
        embedTexts: vi.fn(async () => [input.queryEmbedding])
      }),
      eventLogRepo: {
        append: vi.fn(async (entry: Omit<EventLogEntry, "event_id" | "created_at" | "revision">) => ({
          event_id: "event-1",
          created_at: "2026-04-23T00:00:00.000Z",
          revision: 0,
          ...entry
        })),
        queryByEntity: vi.fn(async () => [])
      },
      generateQueryId: () => "query-neighbors-1",
      now: () => "2026-04-23T00:00:00.000Z"
    });
  }

  it("returns top-K workspace cosine neighbors ranked by similarity", async () => {
    const service = buildService({
      queryEmbedding: new Float32Array([0, 1]),
      workspaceVectors: [
        createEmbeddingRecord({ object_id: "near", embedding: new Float32Array([0.05, 0.99]) }),
        createEmbeddingRecord({ object_id: "far", embedding: new Float32Array([0.99, 0.05]) }),
        createEmbeddingRecord({ object_id: "mid", embedding: new Float32Array([0.7, 0.7]) })
      ]
    });
    const neighbors = await service.collectWorkspaceNeighbors({
      workspaceId: "workspace-1",
      runId: "run-1",
      queryText: "what color is the sky",
      excludeObjectIds: [],
      maxNeighbors: 2
    });
    expect(neighbors.map((hit) => hit.object_id)).toEqual(["near", "mid"]);
    expect(neighbors[0]!.normalized_similarity).toBeGreaterThan(neighbors[1]!.normalized_similarity);
  });

  it("surfaces workspace-neighbor query embedding inference accounting and reuses the cache", async () => {
    const embedTexts = vi.fn(async () => [new Float32Array([0, 1])]);
    const service = new EmbeddingRecallService({
      embeddingRepo: {
        listByObjectIds: vi.fn(async () => []),
        listByWorkspace: vi.fn(async () => [
          createEmbeddingRecord({ object_id: "near", embedding: new Float32Array([0.05, 0.99]) })
        ])
      },
      provider: createProvider({ embedTexts }),
      eventLogRepo: {
        append: vi.fn(async (entry: Omit<EventLogEntry, "event_id" | "created_at" | "revision">) => ({
          event_id: "event-1",
          created_at: "2026-04-23T00:00:00.000Z",
          revision: 0,
          ...entry
        })),
        queryByEntity: vi.fn(async () => [])
      },
      generateQueryId: () => "query-neighbors-1",
      now: () => "2026-04-23T00:00:00.000Z"
    });

    const first = await service.collectWorkspaceNeighborsWithMetadata({
      workspaceId: "workspace-1",
      runId: "run-1",
      queryText: "what color is the sky",
      excludeObjectIds: [],
      maxNeighbors: 2
    });
    const second = await service.collectWorkspaceNeighborsWithMetadata({
      workspaceId: "workspace-1",
      runId: "run-1",
      queryText: "what color is the sky",
      excludeObjectIds: [],
      maxNeighbors: 2
    });

    expect(first.hits.map((hit) => hit.object_id)).toEqual(["near"]);
    expect(first.embedding_inference_calls).toBe(1);
    expect(first.query_embedding_cache_hit).toBe(false);
    expect(second.hits.map((hit) => hit.object_id)).toEqual(["near"]);
    expect(second.embedding_inference_calls).toBe(0);
    expect(second.query_embedding_cache_hit).toBe(true);
    expect(embedTexts).toHaveBeenCalledTimes(1);
  });

  it("excludes object ids that already entered the candidate pool", async () => {
    const service = buildService({
      queryEmbedding: new Float32Array([0, 1]),
      workspaceVectors: [
        createEmbeddingRecord({ object_id: "near", embedding: new Float32Array([0.05, 0.99]) }),
        createEmbeddingRecord({ object_id: "mid", embedding: new Float32Array([0.7, 0.7]) })
      ]
    });
    const neighbors = await service.collectWorkspaceNeighbors({
      workspaceId: "workspace-1",
      runId: "run-1",
      queryText: "query",
      excludeObjectIds: ["near"],
      maxNeighbors: 5
    });
    expect(neighbors.map((hit) => hit.object_id)).toEqual(["mid"]);
  });

  it("isolates vectors by provider and model so cross-provider rows never compete", async () => {
    const service = buildService({
      queryEmbedding: new Float32Array([0, 1]),
      workspaceVectors: [
        createEmbeddingRecord({
          object_id: "other-provider",
          provider_kind: "local_onnx",
          embedding: new Float32Array([0, 1])
        }),
        createEmbeddingRecord({
          object_id: "other-model",
          model_id: "text-embedding-3-large",
          embedding: new Float32Array([0, 1])
        }),
        createEmbeddingRecord({ object_id: "same-space", embedding: new Float32Array([0.1, 0.99]) })
      ]
    });
    const neighbors = await service.collectWorkspaceNeighbors({
      workspaceId: "workspace-1",
      runId: "run-1",
      queryText: "query",
      excludeObjectIds: [],
      maxNeighbors: 5
    });
    expect(neighbors.map((hit) => hit.object_id)).toEqual(["same-space"]);
  });

  it("degrades to an empty result when the workspace scan throws", async () => {
    const service = buildService({
      queryEmbedding: new Float32Array([0, 1]),
      workspaceVectors: [],
      listByWorkspace: vi.fn(async () => {
        throw new Error("vector table unavailable");
      })
    });
    const neighbors = await service.collectWorkspaceNeighbors({
      workspaceId: "workspace-1",
      runId: "run-1",
      queryText: "query",
      excludeObjectIds: [],
      maxNeighbors: 5
    });
    expect(neighbors).toHaveLength(0);
  });

  it("returns an empty result when the repo cannot scan the whole workspace", async () => {
    const service = new EmbeddingRecallService({
      embeddingRepo: {
        listByObjectIds: vi.fn(async () => [])
      },
      provider: createProvider({}),
      eventLogRepo: {
        append: vi.fn(async (entry: Omit<EventLogEntry, "event_id" | "created_at" | "revision">) => ({
          event_id: "event-1",
          created_at: "2026-04-23T00:00:00.000Z",
          revision: 0,
          ...entry
        })),
        queryByEntity: vi.fn(async () => [])
      }
    });
    const neighbors = await service.collectWorkspaceNeighbors({
      workspaceId: "workspace-1",
      runId: "run-1",
      queryText: "query",
      excludeObjectIds: [],
      maxNeighbors: 5
    });
    expect(neighbors).toHaveLength(0);
  });

  it("requests HOT-tier vectors only and bounds the scan with the workspace cap", async () => {
    const listByWorkspace = vi.fn(async () => [
      createEmbeddingRecord({ object_id: "near", embedding: new Float32Array([0.05, 0.99]) })
    ]);
    const service = buildService({
      queryEmbedding: new Float32Array([0, 1]),
      workspaceVectors: [],
      listByWorkspace
    });
    await service.collectWorkspaceNeighbors({
      workspaceId: "workspace-1",
      runId: "run-1",
      queryText: "query",
      excludeObjectIds: [],
      maxNeighbors: 5
    });
    expect(listByWorkspace).toHaveBeenCalledTimes(1);
    expect(listByWorkspace).toHaveBeenCalledWith(
      "workspace-1",
      expect.objectContaining({
        tierFilter: ["hot"],
        limit: EMBEDDING_WORKSPACE_SCAN_CAP
      })
    );
  });

  it("skips the workspace scan entirely when the provider is unavailable", async () => {
    const listByWorkspace = vi.fn(async () => []);
    const service = new EmbeddingRecallService({
      embeddingRepo: {
        listByObjectIds: vi.fn(async () => []),
        listByWorkspace
      },
      provider: createProvider({ isAvailable: false }),
      eventLogRepo: {
        append: vi.fn(async (entry: Omit<EventLogEntry, "event_id" | "created_at" | "revision">) => ({
          event_id: "event-1",
          created_at: "2026-04-23T00:00:00.000Z",
          revision: 0,
          ...entry
        })),
        queryByEntity: vi.fn(async () => [])
      }
    });
    const neighbors = await service.collectWorkspaceNeighbors({
      workspaceId: "workspace-1",
      runId: "run-1",
      queryText: "query",
      excludeObjectIds: [],
      maxNeighbors: 5
    });
    expect(neighbors).toHaveLength(0);
    expect(listByWorkspace).not.toHaveBeenCalled();
  });
});

type EmbeddingRecallAppendSpy = (
  entry: Omit<EventLogEntry, "event_id" | "created_at" | "revision">
) => Promise<EventLogEntry>;

function createProvider(overrides: {
  readonly isAvailable?: boolean;
  readonly embedTexts?: TestMock;
} = {}) {
  return {
    providerKind: "openai",
    modelId: "text-embedding-3-small",
    schemaVersion: 1,
    isAvailable: overrides.isAvailable ?? true,
    embedTexts:
      overrides.embedTexts ??
      vi.fn(async (texts: readonly string[]) => texts.map(() => new Float32Array([1, 0])))
  };
}

function createEmbeddingRecord(overrides: Partial<EmbeddingVectorRecord>): EmbeddingVectorRecord {
  return {
    object_id: overrides.object_id ?? "memory-1",
    workspace_id: overrides.workspace_id ?? "workspace-1",
    content_hash: overrides.content_hash ?? `sha256:${overrides.object_id ?? "memory-1"}`,
    provider_kind: overrides.provider_kind ?? "openai",
    model_id: overrides.model_id ?? "text-embedding-3-small",
    schema_version: overrides.schema_version ?? 1,
    dimensions: overrides.dimensions ?? overrides.embedding?.length ?? 2,
    embedding: overrides.embedding ?? new Float32Array([1, 0]),
    created_at: overrides.created_at ?? "2026-04-23T00:00:00.000Z",
    updated_at: overrides.updated_at ?? "2026-04-23T00:00:00.000Z"
  };
}

function hashMemoryContent(content: string): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function createMemoryEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    object_id: overrides.object_id ?? "memory-1",
    object_kind: "memory_entry",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: "2026-04-23T00:00:00.000Z",
    updated_at: "2026-04-23T00:00:00.000Z",
    created_by: "system",
    dimension: overrides.dimension ?? MemoryDimension.PROCEDURE,
    source_kind: "user",
    formation_kind: "explicit",
    scope_class: overrides.scope_class ?? ScopeClass.PROJECT,
    content: overrides.content ?? `Semantic memory content for ${overrides.object_id ?? "memory-1"}.`,
    domain_tags: [],
    evidence_refs: [],
    workspace_id: "workspace-1",
    run_id: "run-1",
    surface_id: null,
    storage_tier: "hot",
    activation_score: overrides.activation_score ?? 0.5,
    retention_score: null,
    manifestation_state: null,
    retention_state: null,
    decay_profile: null,
    confidence: null,
    last_used_at: null,
    last_hit_at: null,
    reinforcement_count: null,
    contradiction_count: null,
    superseded_by: null,
    ...overrides
  };
}
