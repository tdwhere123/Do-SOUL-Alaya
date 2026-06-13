import { describe, expect, it, vi } from "vitest";
import {
  HealthEventKind,
  ComputeRecallGardenEventType,
  type EventLogEntry,
  type HealthJournalRecordInput
} from "@do-soul/alaya-protocol";
import { EmbeddingRecallService } from "../../embedding-recall/embedding-recall-service.js";
import {
  type EmbeddingRecallAppendSpy,
  createEmbeddingRecord,
  createMemoryEntry,
  createProvider,
  hashMemoryContent
} from "./embedding-recall-test-helpers.js";

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

  it("preserves provider error context on failed prepared query embeddings", async () => {
    const service = new EmbeddingRecallService({
      embeddingRepo: {
        listByObjectIds: vi.fn(async () => [])
      },
      provider: createProvider({
        embedTexts: vi.fn(async () => {
          throw new TypeError("network timeout");
        })
      }),
      eventLogRepo: {
        append: vi.fn(async (entry: Omit<EventLogEntry, "event_id" | "created_at" | "revision">) => ({
          event_id: `event-${entry.event_type}`,
          created_at: "2026-04-23T00:00:00.000Z",
          revision: 0,
          ...entry
        })),
        queryByEntity: vi.fn(async () => [])
      },
      generateQueryId: () => "prepared-query-error",
      now: () => "2026-04-23T00:00:00.000Z"
    });

    const preparedQuery = service.prepareQueryEmbedding({
      workspaceId: "workspace-1",
      runId: "run-1",
      queryText: "Semantic recall ranking"
    });
    const snapshot =
      typeof preparedQuery.waitForSnapshot === "function"
        ? await preparedQuery.waitForSnapshot(50)
        : preparedQuery.getSnapshot();

    expect(snapshot).toEqual({
      status: "failed",
      reason: "query_embedding_failed",
      error_name: "TypeError",
      error_message: "network timeout"
    });
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
