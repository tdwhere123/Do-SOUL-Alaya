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
import { EmbeddingRecallService, type EmbeddingVectorRecord } from "../embedding-recall-service.js";
import type { TestMock } from "./mock-types.js";

describe("EmbeddingRecallService", () => {
  it("queries the local vector table, emits telemetry, and returns additive candidates plus similarity hints", async () => {
    const appendSpy = vi.fn(async (entry: Omit<EventLogEntry, "event_id" | "created_at">) => ({
      event_id: `event-${entry.event_type}`,
      created_at: "2026-04-23T00:00:00.000Z",
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
    const appendSpy = vi.fn(async (entry: Omit<EventLogEntry, "event_id" | "created_at">) => ({
      event_id: `event-${entry.event_type}`,
      created_at: "2026-04-23T00:00:00.000Z",
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

  it("records degraded fallback when the prepared query embedding is not ready by merge time", async () => {
    const appendSpy = vi.fn(async (entry: Omit<EventLogEntry, "event_id" | "created_at">) => ({
      event_id: `event-${entry.event_type}`,
      created_at: "2026-04-23T00:00:00.000Z",
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
      now: () => "2026-04-23T00:00:00.000Z"
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
    const appendSpy = vi.fn(async (entry: Omit<EventLogEntry, "event_id" | "created_at">) => ({
      event_id: `event-${entry.event_type}`,
      created_at: "2026-04-23T00:00:00.000Z",
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
    const appendSpy = vi.fn(async (entry: Omit<EventLogEntry, "event_id" | "created_at">) => ({
      event_id: `event-${entry.event_type}`,
      created_at: "2026-04-23T00:00:00.000Z",
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
        event_type: ComputeRecallGardenEventType.RECALL_EMBEDDING_SUPPLEMENT_MERGED,
        entity_type: "recall_embedding_supplement",
        entity_id: "query-telemetry-fail",
        workspace_id: "workspace-1",
        run_id: "run-1",
        caused_by: "system",
        revision: 0,
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

type EmbeddingRecallAppendSpy = (
  entry: Omit<EventLogEntry, "event_id" | "created_at">
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
