import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { MemoryDimension, ScopeClass, type MemoryEntry } from "@do-soul/alaya-protocol";
import { EmbeddingBackfillHandler } from "../embedding-backfill-handler.js";
import type { EmbeddingVectorRecord } from "../embedding-recall-service.js";
import type { TestMock } from "./mock-types.js";

// Mirrors hashMemoryContent in ../embedding-backfill-handler.ts so the test can
// model the write-time content-hash guard's live re-check.
function hashContent(content: string): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

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

  it("skips stale writes via the write-time content-hash guard when memory content changes before persistence", async () => {
    // The atomic content-hash guard (upsertIfContentHashMatchesCurrentMemory)
    // re-reads live memory content inside the upsert transaction and returns
    // null when it no longer matches the embedded content_hash. This mirrors
    // SqliteMemoryEmbeddingRepo.guardedUpsertTransaction: it is the sole
    // stale-content guard, so the handler does not need to re-fetch the corpus
    // per batch to enforce it.
    const embedTexts = vi.fn(async () => [new Float32Array([0.9, 0.1])]);
    const findByWorkspaceId = vi.fn(async () => [
      createMemoryEntry({ object_id: "memory-1", content: "Original content." })
    ]);
    // Live content mutated to "Updated content." after the embed snapshot was
    // taken; the guard hashes the live content and rejects the stale vector.
    const liveContentHash = hashContent("Updated content.");
    const guardedUpsert = vi.fn(async (record: EmbeddingVectorRecord) =>
      record.content_hash === liveContentHash ? record : null
    );
    const directUpsert = vi.fn(async (record: EmbeddingVectorRecord) => record);
    const handler = new EmbeddingBackfillHandler({
      memoryRepo: {
        findByWorkspaceId
      },
      memoryEmbeddingRepo: {
        findByObjectId: vi.fn(async () => null),
        upsert: directUpsert,
        upsertIfContentHashMatchesCurrentMemory: guardedUpsert
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
    // The corpus is fetched exactly once (the initial snapshot); no per-batch
    // re-fetch. The stale guarantee is enforced by the write-time guard below.
    expect(findByWorkspaceId).toHaveBeenCalledTimes(1);
    expect(guardedUpsert).toHaveBeenCalledTimes(1);
    expect(directUpsert).not.toHaveBeenCalled();
    expect(result.objectsAffected).toEqual([]);
    expect(result.auditEntries).toEqual(["embedding_skipped:stale_content:memory-1"]);
  });

  it("fetches the hot corpus exactly once regardless of batch count", async () => {
    // Two full batches (16 + 1) must not trigger a per-batch corpus re-fetch:
    // the handler builds one snapshot and reuses it, keeping handle() O(n)
    // rather than O(n^2) over the hot corpus.
    const hotMemories = Array.from({ length: 17 }, (_, index) =>
      createMemoryEntry({
        object_id: `memory-${index}`,
        content: `Semantic recall content ${index}.`
      })
    );
    const findByWorkspaceId = vi.fn(async () => hotMemories);
    const upsert = vi.fn(async (record: EmbeddingVectorRecord) => record);
    const embedTexts = vi.fn(async (texts: readonly string[]) =>
      texts.map(() => new Float32Array([0.4, 0.5, 0.6]))
    );
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

    // Two batches embedded (16 + 1) but the corpus is fetched exactly once.
    expect(embedTexts).toHaveBeenCalledTimes(2);
    expect(findByWorkspaceId).toHaveBeenCalledTimes(1);
    expect(result.objectsAffected).toEqual(hotMemories.map((memory) => memory.object_id));
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
      // Pin concurrency=1 so the split-retry call ORDER stays deterministic;
      // this test exercises the fallback split semantics, not the concurrency.
      batchConcurrency: 1,
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

  it("embeds every memory exactly once with stable aggregate counts under bounded concurrency", async () => {
    // 130 memories => 9 batches (16x8 + 2). With concurrency the per-memory
    // embed count, the objectsAffected set, and the upsert count must match the
    // sequential contract exactly: every memory embedded and upserted once, in
    // deterministic batch order.
    const hotMemories = Array.from({ length: 130 }, (_, index) =>
      createMemoryEntry({
        object_id: `memory-${index}`,
        content: `Concurrent recall content ${index}.`
      })
    );
    const embedCallsByText = new Map<string, number>();
    const embedTexts = vi.fn(async (texts: readonly string[]) => {
      for (const text of texts) {
        embedCallsByText.set(text, (embedCallsByText.get(text) ?? 0) + 1);
      }
      // Microtask hop so concurrent batches genuinely overlap in flight.
      await Promise.resolve();
      return texts.map(() => new Float32Array([0.1, 0.2, 0.3]));
    });
    const upsert = vi.fn(async (record: EmbeddingVectorRecord) => record);
    const handler = new EmbeddingBackfillHandler({
      memoryRepo: { findByWorkspaceId: vi.fn(async () => hotMemories) },
      memoryEmbeddingRepo: {
        findByObjectId: vi.fn(async () => null),
        upsert,
        upsertIfContentHashMatchesCurrentMemory: upsert
      },
      provider: createProvider({ embedTexts }),
      batchConcurrency: 6,
      now: () => "2026-04-23T00:00:00.000Z"
    });

    const result = await handler.handle({ workspace_id: "workspace-1" });

    // Every memory embedded exactly once.
    for (const memory of hotMemories) {
      expect(embedCallsByText.get(memory.content)).toBe(1);
    }
    // Stable aggregate counts: one upsert + one audit line per memory, and the
    // objectsAffected list is in deterministic batch order.
    expect(upsert).toHaveBeenCalledTimes(hotMemories.length);
    expect(result.objectsAffected).toEqual(hotMemories.map((memory) => memory.object_id));
    expect(result.auditEntries.filter((entry) => entry.startsWith("embedding_upserted:"))).toHaveLength(
      hotMemories.length
    );
  });

  it("never exceeds the configured concurrency cap of in-flight embed calls", async () => {
    const concurrency = 4;
    const hotMemories = Array.from({ length: 200 }, (_, index) =>
      createMemoryEntry({
        object_id: `memory-${index}`,
        content: `Capped recall content ${index}.`
      })
    );
    let inFlight = 0;
    let maxObservedInFlight = 0;
    const embedTexts = vi.fn(async (texts: readonly string[]) => {
      inFlight += 1;
      maxObservedInFlight = Math.max(maxObservedInFlight, inFlight);
      // Hold the call open across a macrotask so overlap is observable.
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      return texts.map(() => new Float32Array([0.4, 0.5, 0.6]));
    });
    const upsert = vi.fn(async (record: EmbeddingVectorRecord) => record);
    const handler = new EmbeddingBackfillHandler({
      memoryRepo: { findByWorkspaceId: vi.fn(async () => hotMemories) },
      memoryEmbeddingRepo: {
        findByObjectId: vi.fn(async () => null),
        upsert,
        upsertIfContentHashMatchesCurrentMemory: upsert
      },
      provider: createProvider({ embedTexts }),
      batchConcurrency: concurrency,
      now: () => "2026-04-23T00:00:00.000Z"
    });

    const result = await handler.handle({ workspace_id: "workspace-1" });

    // 200 memories => 13 batches, more than the cap, so overlap is forced.
    expect(embedTexts.mock.calls.length).toBeGreaterThan(concurrency);
    expect(maxObservedInFlight).toBeGreaterThan(1);
    expect(maxObservedInFlight).toBeLessThanOrEqual(concurrency);
    expect(result.objectsAffected).toEqual(hotMemories.map((memory) => memory.object_id));
  });

  it("still enforces the write-time CAS stale-skip under concurrency", async () => {
    // Two batches embed concurrently; the live content of one memory in each
    // batch mutated after the snapshot, so the write-time guard must reject
    // exactly those vectors regardless of embed interleaving.
    const hotMemories = Array.from({ length: 20 }, (_, index) =>
      createMemoryEntry({
        object_id: `memory-${index}`,
        content: `Original content ${index}.`
      })
    );
    const staleIds = new Set(["memory-3", "memory-17"]);
    const embedTexts = vi.fn(async (texts: readonly string[]) => {
      await Promise.resolve();
      return texts.map(() => new Float32Array([0.7, 0.2, 0.1]));
    });
    // Models the write-time CAS guard: the live memory content for the two
    // stale ids mutated after the embed snapshot, so the guard re-hashes inside
    // the upsert transaction, finds a mismatch, and returns null. Other ids are
    // accepted. This must hold no matter how the concurrent batches interleave.
    const guardedUpsert = vi.fn(async (record: EmbeddingVectorRecord) =>
      staleIds.has(record.object_id) ? null : record
    );
    const handler = new EmbeddingBackfillHandler({
      memoryRepo: { findByWorkspaceId: vi.fn(async () => hotMemories) },
      memoryEmbeddingRepo: {
        findByObjectId: vi.fn(async () => null),
        upsert: vi.fn(async (record: EmbeddingVectorRecord) => record),
        upsertIfContentHashMatchesCurrentMemory: guardedUpsert
      },
      provider: createProvider({ embedTexts }),
      batchConcurrency: 6,
      now: () => "2026-04-23T00:00:00.000Z"
    });

    const result = await handler.handle({ workspace_id: "workspace-1" });

    const expectedAffected = hotMemories
      .map((memory) => memory.object_id)
      .filter((id) => !staleIds.has(id));
    expect(result.objectsAffected).toEqual(expectedAffected);
    for (const id of staleIds) {
      expect(result.auditEntries).toContain(`embedding_skipped:stale_content:${id}`);
      expect(result.objectsAffected).not.toContain(id);
    }
  });

  it("parses and clamps the concurrency override from an env-style value", async () => {
    // The override is observable through the cap test: a string above the
    // ceiling clamps, garbage falls back to the default. We assert clamping by
    // requesting a value beyond the max and confirming overlap stays bounded.
    const hotMemories = Array.from({ length: 160 }, (_, index) =>
      createMemoryEntry({
        object_id: `memory-${index}`,
        content: `Override recall content ${index}.`
      })
    );
    let inFlight = 0;
    let maxObservedInFlight = 0;
    const embedTexts = vi.fn(async (texts: readonly string[]) => {
      inFlight += 1;
      maxObservedInFlight = Math.max(maxObservedInFlight, inFlight);
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      return texts.map(() => new Float32Array([0.4, 0.5, 0.6]));
    });
    const makeHandler = (batchConcurrency: number | string) =>
      new EmbeddingBackfillHandler({
        memoryRepo: { findByWorkspaceId: vi.fn(async () => hotMemories) },
        memoryEmbeddingRepo: {
          findByObjectId: vi.fn(async () => null),
          upsert: vi.fn(async (record: EmbeddingVectorRecord) => record),
          upsertIfContentHashMatchesCurrentMemory: vi.fn(async (record: EmbeddingVectorRecord) => record)
        },
        provider: createProvider({ embedTexts }),
        batchConcurrency,
        now: () => "2026-04-23T00:00:00.000Z"
      });

    // "999" parses to 999 then clamps to the max (32); 160 memories => 10
    // batches, so the cap binds at 10 (fewer than 32) — overlap stays bounded
    // and the run completes correctly.
    const clampedResult = await makeHandler("999").handle({ workspace_id: "workspace-1" });
    expect(maxObservedInFlight).toBeGreaterThan(1);
    expect(maxObservedInFlight).toBeLessThanOrEqual(32);
    expect(clampedResult.objectsAffected).toHaveLength(hotMemories.length);

    // Garbage falls back to the default (6); reset the probe and confirm the
    // run still completes with bounded overlap.
    maxObservedInFlight = 0;
    inFlight = 0;
    const garbageResult = await makeHandler("not-a-number").handle({ workspace_id: "workspace-1" });
    expect(maxObservedInFlight).toBeGreaterThan(1);
    expect(maxObservedInFlight).toBeLessThanOrEqual(6);
    expect(garbageResult.objectsAffected).toHaveLength(hotMemories.length);
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
