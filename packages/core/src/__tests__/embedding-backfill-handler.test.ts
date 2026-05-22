import { describe, expect, it, vi } from "vitest";
import { MemoryDimension, ScopeClass, type MemoryEntry } from "@do-soul/alaya-protocol";
import { EmbeddingBackfillHandler } from "../embedding-backfill-handler.js";
import type { EmbeddingVectorRecord } from "../embedding-recall-service.js";
import type { TestMock } from "./mock-types.js";

describe("EmbeddingBackfillHandler", () => {
  it("upserts only missing or changed hot-memory embeddings and skips unchanged content hashes", async () => {
    const hotMemories = [
      createMemoryEntry({
        object_id: "memory-unchanged",
        content: "Pinned repository workflow."
      }),
      createMemoryEntry({
        object_id: "memory-new",
        content: "Freshly added semantic recall note."
      })
    ];
    const findByObjectId = vi.fn(async (objectId: string) =>
      objectId === "memory-unchanged"
        ? createEmbeddingRecord({
            object_id: "memory-unchanged",
            content_hash: "sha256:dccd80818c25010161695fb93c87cc707543c2b90f307b4938f604fff0057bcf"
          })
        : null
    );
    const upsert = vi.fn(async (record: EmbeddingVectorRecord) => record);
    const embedTexts = vi.fn(async () => [new Float32Array([0.1, 0.2, 0.3])]);
    const handler = new EmbeddingBackfillHandler({
      memoryRepo: {
        findByWorkspaceId: vi.fn(async () => hotMemories)
      },
      memoryEmbeddingRepo: {
        findByObjectId,
        upsert,
        upsertIfContentHashMatchesCurrentMemory: upsert
      },
      provider: createProvider({ embedTexts }),
      retryDelayMs: 0,
      now: () => "2026-04-23T00:00:00.000Z"
    });

    const result = await handler.handle({
      workspace_id: "workspace-1"
    });

    expect(embedTexts).toHaveBeenCalledWith(["Freshly added semantic recall note."], {
      timeoutMs: 10_000
    });
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        object_id: "memory-new",
        workspace_id: "workspace-1",
        provider_kind: "openai",
        model_id: "text-embedding-3-small",
        schema_version: 1,
        dimensions: 3
      })
    );
    expect(result.objectsAffected).toEqual(["memory-new"]);
    expect(result.auditEntries).toEqual([
      "embedding_skipped:unchanged:memory-unchanged",
      "embedding_upserted:memory-new"
    ]);
  });

  it("skips stale writes when memory content changes before the embedding is persisted", async () => {
    const embedTexts = vi.fn(async () => [new Float32Array([0.9, 0.1])]);
    const findByWorkspaceId = vi
      .fn(async () => [createMemoryEntry({ object_id: "memory-1", content: "Original content." })])
      .mockResolvedValueOnce([
        createMemoryEntry({ object_id: "memory-1", content: "Original content." })
      ])
      .mockResolvedValueOnce([
        createMemoryEntry({ object_id: "memory-1", content: "Updated content." })
      ]);
    const upsert = vi.fn(async (record: EmbeddingVectorRecord) => record);
    const handler = new EmbeddingBackfillHandler({
      memoryRepo: {
        findByWorkspaceId
      },
      memoryEmbeddingRepo: {
        findByObjectId: vi.fn(async () => null),
        upsert,
        upsertIfContentHashMatchesCurrentMemory: upsert
      },
      provider: createProvider({ embedTexts }),
      now: () => "2026-04-23T00:00:00.000Z"
    });

    const result = await handler.handle({
      workspace_id: "workspace-1"
    });

    expect(embedTexts).toHaveBeenCalledWith(["Original content."], {
      timeoutMs: 10_000
    });
    expect(upsert).not.toHaveBeenCalled();
    expect(result.objectsAffected).toEqual([]);
    expect(result.auditEntries).toEqual(["embedding_skipped:stale_content:memory-1"]);
  });

  it("returns a deterministic skip when the embedding provider is unavailable", async () => {
    const handler = new EmbeddingBackfillHandler({
      memoryRepo: {
        findByWorkspaceId: vi.fn(async () => [
          createMemoryEntry({ object_id: "memory-1", content: "No provider available." })
        ])
      },
      memoryEmbeddingRepo: {
        findByObjectId: vi.fn(async () => null),
        upsert: vi.fn(async (record: EmbeddingVectorRecord) => record),
        upsertIfContentHashMatchesCurrentMemory: vi.fn(async (record: EmbeddingVectorRecord) => record)
      },
      provider: createProvider({ isAvailable: false }),
      now: () => "2026-04-23T00:00:00.000Z"
    });

    const result = await handler.handle({
      workspace_id: "workspace-1"
    });

    expect(result.objectsAffected).toEqual([]);
    expect(result.auditEntries).toEqual(["embedding_backfill_skipped:provider_unavailable"]);
  });

  it("treats a repo-level guarded write rejection as stale content instead of overwriting", async () => {
    const guardedUpsert = vi.fn(async () => null);
    const handler = new EmbeddingBackfillHandler({
      memoryRepo: {
        findByWorkspaceId: vi.fn(async () => [
          createMemoryEntry({ object_id: "memory-1", content: "Original content." })
        ])
      },
      memoryEmbeddingRepo: {
        findByObjectId: vi.fn(async () => null),
        upsert: vi.fn(async (record: EmbeddingVectorRecord) => record),
        upsertIfContentHashMatchesCurrentMemory: guardedUpsert
      },
      provider: createProvider({
        embedTexts: vi.fn(async () => [new Float32Array([0.7, 0.2, 0.1])])
      }),
      now: () => "2026-04-23T00:00:00.000Z"
    });

    const result = await handler.handle({
      workspace_id: "workspace-1"
    });

    expect(guardedUpsert).toHaveBeenCalledTimes(1);
    expect(result.objectsAffected).toEqual([]);
    expect(result.auditEntries).toEqual(["embedding_skipped:stale_content:memory-1"]);
  });

  it("retries failed provider batches as smaller batches before moving on", async () => {
    const hotMemories = Array.from({ length: 17 }, (_, index) =>
      createMemoryEntry({
        object_id: `memory-${index}`,
        content: `Semantic recall content ${index}.`
      })
    );
    const embedTexts = vi
      .fn(async (texts: readonly string[]) =>
        texts.map(() => new Float32Array([0.4, 0.5, 0.6]))
      )
      .mockRejectedValueOnce(new Error("provider timeout"));
    const upsert = vi.fn(async (record: EmbeddingVectorRecord) => record);
    const handler = new EmbeddingBackfillHandler({
      memoryRepo: {
        findByWorkspaceId: vi.fn(async () => hotMemories)
      },
      memoryEmbeddingRepo: {
        findByObjectId: vi.fn(async () => null),
        upsert,
        upsertIfContentHashMatchesCurrentMemory: upsert
      },
      provider: createProvider({ embedTexts }),
      now: () => "2026-04-23T00:00:00.000Z"
    });

    const result = await handler.handle({
      workspace_id: "workspace-1"
    });

    expect(embedTexts).toHaveBeenCalledTimes(4);
    expect(embedTexts.mock.calls[0]?.[0]).toHaveLength(16);
    expect(embedTexts.mock.calls[1]?.[0]).toHaveLength(8);
    expect(embedTexts.mock.calls[2]?.[0]).toHaveLength(8);
    expect(embedTexts.mock.calls[3]?.[0]).toEqual(["Semantic recall content 16."]);
    expect(result.objectsAffected).toEqual(hotMemories.map((memory) => memory.object_id));
    expect(result.auditEntries).not.toContain("embedding_failed:provider:memory-0");
    expect(result.auditEntries).toContain("embedding_upserted:memory-16");
  });

  it("isolates a persistently failing embedding input after split retries", async () => {
    const hotMemories = [
      createMemoryEntry({ object_id: "memory-ok-1", content: "Stable recall content one." }),
      createMemoryEntry({ object_id: "memory-bad", content: "Provider rejects this bad input." }),
      createMemoryEntry({ object_id: "memory-ok-2", content: "Stable recall content two." }),
      createMemoryEntry({ object_id: "memory-ok-3", content: "Stable recall content three." })
    ];
    const embedTexts = vi.fn(async (texts: readonly string[]) => {
      if (texts.some((text) => text.includes("bad input"))) {
        throw new Error("provider rejected input");
      }
      return texts.map(() => new Float32Array([0.4, 0.5, 0.6]));
    });
    const handler = new EmbeddingBackfillHandler({
      memoryRepo: {
        findByWorkspaceId: vi.fn(async () => hotMemories)
      },
      memoryEmbeddingRepo: {
        findByObjectId: vi.fn(async () => null),
        upsert: vi.fn(async (record: EmbeddingVectorRecord) => record),
        upsertIfContentHashMatchesCurrentMemory: vi.fn(async (record: EmbeddingVectorRecord) => record)
      },
      provider: createProvider({ embedTexts }),
      retryDelayMs: 0,
      now: () => "2026-04-23T00:00:00.000Z"
    });

    const result = await handler.handle({
      workspace_id: "workspace-1"
    });

    expect(result.objectsAffected).toEqual(["memory-ok-1", "memory-ok-2", "memory-ok-3"]);
    expect(result.auditEntries).toContain("embedding_failed:provider:memory-bad");
    expect(result.auditEntries).toContain("embedding_upserted:memory-ok-1");
    expect(result.auditEntries).toContain("embedding_upserted:memory-ok-2");
    expect(result.auditEntries).toContain("embedding_upserted:memory-ok-3");
  });

  it("recovers a single embedding input after an item-level transport retry", async () => {
    const hotMemories = [
      createMemoryEntry({ object_id: "memory-ok", content: "Stable recall content." }),
      createMemoryEntry({ object_id: "memory-flaky", content: "Flaky provider transport input." })
    ];
    let flakySingleAttempts = 0;
    const embedTexts = vi.fn(async (texts: readonly string[]) => {
      if (texts.some((text) => text.includes("Flaky"))) {
        if (texts.length === 1) {
          flakySingleAttempts++;
          if (flakySingleAttempts >= 2) {
            return [new Float32Array([0.4, 0.5, 0.6])];
          }
        }
        throw new Error("provider transport failed");
      }
      return texts.map(() => new Float32Array([0.1, 0.2, 0.3]));
    });
    const handler = new EmbeddingBackfillHandler({
      memoryRepo: {
        findByWorkspaceId: vi.fn(async () => hotMemories)
      },
      memoryEmbeddingRepo: {
        findByObjectId: vi.fn(async () => null),
        upsert: vi.fn(async (record: EmbeddingVectorRecord) => record),
        upsertIfContentHashMatchesCurrentMemory: vi.fn(async (record: EmbeddingVectorRecord) => record)
      },
      provider: createProvider({ embedTexts }),
      retryDelayMs: 0,
      now: () => "2026-04-23T00:00:00.000Z"
    });

    const result = await handler.handle({
      workspace_id: "workspace-1"
    });

    expect(result.objectsAffected).toEqual(["memory-ok", "memory-flaky"]);
    expect(result.auditEntries).not.toContain("embedding_failed:provider:memory-flaky");
    expect(result.auditEntries).toContain("embedding_upserted:memory-flaky");
  });

  it("splits large embedding requests by input character budget", async () => {
    const hotMemories = [
      createMemoryEntry({
        object_id: "memory-large-1",
        content: "A".repeat(20_000)
      }),
      createMemoryEntry({
        object_id: "memory-large-2",
        content: "B".repeat(20_000)
      })
    ];
    const embedTexts = vi.fn(async (texts: readonly string[]) =>
      texts.map(() => new Float32Array([0.1, 0.2, 0.3]))
    );
    const handler = new EmbeddingBackfillHandler({
      memoryRepo: {
        findByWorkspaceId: vi.fn(async () => hotMemories)
      },
      memoryEmbeddingRepo: {
        findByObjectId: vi.fn(async () => null),
        upsert: vi.fn(async (record: EmbeddingVectorRecord) => record),
        upsertIfContentHashMatchesCurrentMemory: vi.fn(async (record: EmbeddingVectorRecord) => record)
      },
      provider: createProvider({ embedTexts }),
      now: () => "2026-04-23T00:00:00.000Z"
    });

    const result = await handler.handle({
      workspace_id: "workspace-1"
    });

    expect(embedTexts).toHaveBeenCalledTimes(2);
    expect(embedTexts.mock.calls[0]?.[0]).toEqual(["A".repeat(20_000)]);
    expect(embedTexts.mock.calls[1]?.[0]).toEqual(["B".repeat(20_000)]);
    expect(result.objectsAffected).toEqual(["memory-large-1", "memory-large-2"]);
  });
});

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
      vi.fn(async (texts: readonly string[]) => texts.map(() => new Float32Array([1, 0, 0])))
  };
}

function createEmbeddingRecord(overrides: Partial<EmbeddingVectorRecord>): EmbeddingVectorRecord {
  return {
    object_id: overrides.object_id ?? "memory-1",
    workspace_id: overrides.workspace_id ?? "workspace-1",
    content_hash: overrides.content_hash ?? "sha256:memory-1",
    provider_kind: overrides.provider_kind ?? "openai",
    model_id: overrides.model_id ?? "text-embedding-3-small",
    schema_version: overrides.schema_version ?? 1,
    dimensions: overrides.dimensions ?? overrides.embedding?.length ?? 3,
    embedding: overrides.embedding ?? new Float32Array([1, 0, 0]),
    created_at: overrides.created_at ?? "2026-04-23T00:00:00.000Z",
    updated_at: overrides.updated_at ?? "2026-04-23T00:00:00.000Z"
  };
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
    content: overrides.content ?? "Embedding handler memory content.",
    domain_tags: [],
    evidence_refs: [],
    workspace_id: "workspace-1",
    run_id: "run-1",
    surface_id: null,
    storage_tier: "hot",
    activation_score: overrides.activation_score ?? 0.6,
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
