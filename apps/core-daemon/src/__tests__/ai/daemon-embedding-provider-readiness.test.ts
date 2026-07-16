import { describe, expect, it, vi } from "vitest";
import {
  EmbeddingBackfillHandler,
  type EmbeddingProviderPort,
  type EmbeddingVectorRecord
} from "@do-soul/alaya-core";
import {
  MemoryDimension,
  ScopeClass,
  StorageTier,
  type MemoryEntry
} from "@do-soul/alaya-protocol";
import {
  createEmbeddingProviderReadiness,
  observeEmbeddingProviderReadiness
} from "../../ai/daemon-embedding-provider-readiness.js";

describe("embedding provider dimensional readiness", () => {
  it("rejects a later response from a different vector space", async () => {
    let call = 0;
    const provider = createProvider(async (texts) => {
      if (texts.length === 0) return [];
      call += 1;
      const dimensions = call === 1 ? 2 : 3;
      return texts.map(() => unitVector(dimensions));
    });
    const readiness = createEmbeddingProviderReadiness(provider);
    const observed = observeEmbeddingProviderReadiness(provider, readiness)!;

    expect(readiness.dimensions).toBeNull();
    await expect(observed.embedTexts([], { timeoutMs: 1_000 })).resolves.toEqual([]);
    expect(readiness.status).toBe("pending");
    await expect(observed.embedTexts(["first"], { timeoutMs: 1_000 }))
      .resolves.toHaveLength(1);
    expect(readiness.dimensions).toBe(2);
    await expect(observed.embedTexts(["second"], { timeoutMs: 1_000 }))
      .rejects.toThrow(/dimensions/u);
    expect(readiness.status).toBe("ready");
    expect(readiness.dimensions).toBe(2);
  });

  it("prevents a concurrent backfill batch from persisting a second dimension", async () => {
    const memories = Array.from({ length: 17 }, (_, index) => createMemory(index));
    const provider = createProvider(async (texts) =>
      texts.map(() => unitVector(texts.length === 1 ? 3 : 2))
    );
    const readiness = createEmbeddingProviderReadiness(provider);
    const observed = observeEmbeddingProviderReadiness(provider, readiness)!;
    const upsert = vi.fn(async (record: EmbeddingVectorRecord) => record);
    const handler = new EmbeddingBackfillHandler({
      memoryRepo: {
        findByWorkspaceId: vi.fn(async (_workspaceId, tier) =>
          tier === StorageTier.HOT ? memories : []
        )
      },
      memoryEmbeddingRepo: {
        findMetadataByObjectIds: vi.fn(async () => []),
        upsert,
        upsertIfContentHashMatchesCurrentMemory: upsert
      },
      provider: observed,
      batchConcurrency: 2,
      retryDelayMs: 0
    });

    const result = await handler.handle({ workspace_id: "workspace-1" });

    expect(upsert).toHaveBeenCalledTimes(16);
    expect(upsert.mock.calls.every(([record]) => record.dimensions === 2)).toBe(true);
    expect(result.objectsAffected).toEqual(memories.slice(0, 16).map(({ object_id }) => object_id));
    expect(result.auditEntries.some((entry) =>
      entry.startsWith("embedding_failed:provider:memory-16:")
    )).toBe(true);
  });
});

function createProvider(
  embedTexts: EmbeddingProviderPort["embedTexts"]
): EmbeddingProviderPort {
  return {
    providerKind: "openai",
    modelId: "fixture-model",
    schemaVersion: 1,
    isAvailable: true,
    embedTexts
  };
}

function unitVector(dimensions: number): Float32Array {
  const vector = new Float32Array(dimensions);
  vector[0] = 1;
  return vector;
}

function createMemory(index: number): MemoryEntry {
  const now = "2026-07-16T00:00:00.000Z";
  return {
    object_id: `memory-${index}`,
    object_kind: "memory_entry",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: now,
    updated_at: now,
    created_by: "provider-readiness-test",
    dimension: MemoryDimension.FACT,
    source_kind: "user",
    formation_kind: "explicit",
    scope_class: ScopeClass.PROJECT,
    content: `Provider readiness content ${index}.`,
    domain_tags: [],
    evidence_refs: [],
    workspace_id: "workspace-1",
    run_id: "run-1",
    surface_id: null,
    storage_tier: "hot",
    activation_score: 0.5,
    retention_score: null,
    manifestation_state: null,
    retention_state: null,
    decay_profile: null,
    confidence: null,
    last_used_at: null,
    last_hit_at: null,
    reinforcement_count: null,
    contradiction_count: null,
    superseded_by: null
  };
}
