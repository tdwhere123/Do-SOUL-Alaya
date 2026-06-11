import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { MemoryDimension, ScopeClass, type MemoryEntry } from "@do-soul/alaya-protocol";
import {
  EmbeddingBackfillHandler,
  isEmbeddingBackfillPartialFailureError,
  resolveBackfillBatchConcurrency,
  type EmbeddingBackfillMetadata
} from "../../embedding-recall/embedding-backfill-handler.js";
import type { EmbeddingVectorRecord } from "../../embedding-recall/embedding-recall-service.js";
import type { TestMock } from "../mock-types.js";

// Mirrors hashMemoryContent in ../../embedding-recall/embedding-backfill-handler.ts so the test can
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
    const findMetadataByObjectIds = vi.fn(async () => [
      createEmbeddingMetadata({
        object_id: "memory-unchanged",
        content_hash: "sha256:dccd80818c25010161695fb93c87cc707543c2b90f307b4938f604fff0057bcf"
      })
    ]);
    const upsert = vi.fn(async (record: EmbeddingVectorRecord) => record);
    const embedTexts = vi.fn(async () => [new Float32Array([0.1, 0.2, 0.3])]);
    const handler = new EmbeddingBackfillHandler({
      memoryRepo: {
        findByWorkspaceId: vi.fn(async () => hotMemories)
      },
      memoryEmbeddingRepo: {
        findMetadataByObjectIds,
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
        findMetadataByObjectIds: vi.fn(async () => []),
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
        findMetadataByObjectIds: vi.fn(async () => []),
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
        findMetadataByObjectIds: vi.fn(async () => []),
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
        findMetadataByObjectIds: vi.fn(async () => []),
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
        findMetadataByObjectIds: vi.fn(async () => []),
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
        findMetadataByObjectIds: vi.fn(async () => []),
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
    expect(result.auditEntries).toContain("embedding_failed:provider:memory-bad:provider rejected input");
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
        findMetadataByObjectIds: vi.fn(async () => []),
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
        findMetadataByObjectIds: vi.fn(async () => []),
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
        findMetadataByObjectIds: vi.fn(async () => []),
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
        findMetadataByObjectIds: vi.fn(async () => []),
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
        findMetadataByObjectIds: vi.fn(async () => []),
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
          findMetadataByObjectIds: vi.fn(async () => []),
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

  it("settles all already-started in-flight batches before the persistence error propagates", async () => {
    // invariant: when head-batch persistence throws, any younger provider calls
    // already in flight must settle before handle() rejects.
    const concurrency = 4;
    const hotMemories = Array.from({ length: 80 }, (_, index) =>
      createMemoryEntry({
        object_id: `memory-${index}`,
        content: `Settle recall content ${index}.`
      })
    );
    let inFlight = 0;
    let maxObservedInFlight = 0;
    let settledCalls = 0;
    const embedTexts = vi.fn(async (texts: readonly string[]) => {
      inFlight += 1;
      maxObservedInFlight = Math.max(maxObservedInFlight, inFlight);
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      settledCalls += 1;
      return texts.map(() => new Float32Array([0.1, 0.2, 0.3]));
    });
    const upsertError = new Error("persistence layer down");
    const upsert = vi.fn(async () => {
      throw upsertError;
    });
    const handler = new EmbeddingBackfillHandler({
      memoryRepo: { findByWorkspaceId: vi.fn(async () => hotMemories) },
      memoryEmbeddingRepo: {
        findMetadataByObjectIds: vi.fn(async () => []),
        upsert,
        upsertIfContentHashMatchesCurrentMemory: upsert
      },
      provider: createProvider({ embedTexts }),
      batchConcurrency: concurrency,
      now: () => "2026-04-23T00:00:00.000Z"
    });

    let caught: unknown;
    try {
      await handler.handle({ workspace_id: "workspace-1" });
    } catch (error) {
      caught = error;
    }

    expect(isEmbeddingBackfillPartialFailureError(caught)).toBe(true);
    if (!isEmbeddingBackfillPartialFailureError(caught)) {
      throw new Error("expected partial failure error");
    }
    expect(caught.cause).toBe(upsertError);
    expect(caught.failedObjectId).toBe("memory-0");
    expect(caught.auditEntries).toContain("embedding_failed:persistence:memory-0:persistence layer down");

    // No batch call is left running after handle() rejects: every started embed
    // call has settled (inFlight drained to 0) before the rejection surfaced.
    expect(inFlight).toBe(0);
    expect(settledCalls).toBe(embedTexts.mock.calls.length);
    // The cap still bounded the started calls across the failure.
    expect(maxObservedInFlight).toBeGreaterThan(1);
    expect(maxObservedInFlight).toBeLessThanOrEqual(concurrency);
  });

  it("reports partial durable side effects when a later batch write fails", async () => {
    const hotMemories = [
      createMemoryEntry({ object_id: "memory-ok", content: "Persisted before failure." }),
      createMemoryEntry({ object_id: "memory-fails", content: "Persistence fails here." })
    ];
    const persistenceError = new Error("sqlite write failed");
    const upsert = vi.fn(async (record: EmbeddingVectorRecord) => {
      if (record.object_id === "memory-fails") {
        throw persistenceError;
      }
      return record;
    });
    const handler = new EmbeddingBackfillHandler({
      memoryRepo: { findByWorkspaceId: vi.fn(async () => hotMemories) },
      memoryEmbeddingRepo: {
        findMetadataByObjectIds: vi.fn(async () => []),
        upsert,
        upsertIfContentHashMatchesCurrentMemory: upsert
      },
      provider: createProvider({
        embedTexts: vi.fn(async (texts: readonly string[]) =>
          texts.map(() => new Float32Array([0.1, 0.2, 0.3]))
        )
      }),
      batchConcurrency: 1,
      now: () => "2026-04-23T00:00:00.000Z"
    });

    let caught: unknown;
    try {
      await handler.handle({ workspace_id: "workspace-1" });
    } catch (error) {
      caught = error;
    }

    expect(isEmbeddingBackfillPartialFailureError(caught)).toBe(true);
    if (!isEmbeddingBackfillPartialFailureError(caught)) {
      throw new Error("expected partial failure error");
    }
    expect(caught.cause).toBe(persistenceError);
    expect(caught.failedObjectId).toBe("memory-fails");
    expect(caught.objectsAffected).toEqual(["memory-ok"]);
    expect(caught.auditEntries).toContain("embedding_upserted:memory-ok");
    expect(caught.auditEntries).toContain("embedding_failed:persistence:memory-fails:sqlite write failed");
  });

  it("persists out-of-order provider resolutions in batch order without buffering the whole corpus", async () => {
    // Batch 0 resolves slowly, batch 1 quickly. Upserts must still happen in
    // batch order (0 before 1), proving the drain replays in deterministic head
    // order rather than persisting whichever provider call returns first.
    const hotMemories = Array.from({ length: 32 }, (_, index) =>
      createMemoryEntry({
        object_id: `memory-${String(index).padStart(2, "0")}`,
        content: `Ordered recall content ${index}.`
      })
    );
    const embedTexts = vi.fn(async (texts: readonly string[]) => {
      // The first batch (contains "content 0.") resolves after a longer delay
      // than the second, forcing out-of-order provider resolution.
      const isFirstBatch = texts.some((text) => text.endsWith("content 0."));
      await new Promise<void>((resolve) => setTimeout(resolve, isFirstBatch ? 10 : 1));
      return texts.map(() => new Float32Array([0.1, 0.2, 0.3]));
    });
    const upsertOrder: string[] = [];
    const upsert = vi.fn(async (record: EmbeddingVectorRecord) => {
      upsertOrder.push(record.object_id);
      return record;
    });
    const handler = new EmbeddingBackfillHandler({
      memoryRepo: { findByWorkspaceId: vi.fn(async () => hotMemories) },
      memoryEmbeddingRepo: {
        findMetadataByObjectIds: vi.fn(async () => []),
        upsert,
        upsertIfContentHashMatchesCurrentMemory: upsert
      },
      provider: createProvider({ embedTexts }),
      batchConcurrency: 6,
      now: () => "2026-04-23T00:00:00.000Z"
    });

    const result = await handler.handle({ workspace_id: "workspace-1" });

    // 32 memories => 2 batches (16 + 16). Despite batch 0 resolving last, its
    // 16 ids are upserted before batch 1's 16 ids.
    expect(upsertOrder).toEqual(hotMemories.map((memory) => memory.object_id));
    expect(result.objectsAffected).toEqual(hotMemories.map((memory) => memory.object_id));
  });

  it("returns failed audit entries for an all-failing corpus without throwing", async () => {
    // Every provider call fails permanently. The handler must not throw; it
    // records a per-item provider-failure audit entry and affects nothing.
    const hotMemories = Array.from({ length: 3 }, (_, index) =>
      createMemoryEntry({
        object_id: `memory-${index}`,
        content: `Always-fails content ${index}.`
      })
    );
    const embedTexts = vi.fn(async () => {
      throw new Error("provider permanently down");
    });
    const upsert = vi.fn(async (record: EmbeddingVectorRecord) => record);
    const handler = new EmbeddingBackfillHandler({
      memoryRepo: { findByWorkspaceId: vi.fn(async () => hotMemories) },
      memoryEmbeddingRepo: {
        findMetadataByObjectIds: vi.fn(async () => []),
        upsert,
        upsertIfContentHashMatchesCurrentMemory: upsert
      },
      provider: createProvider({ embedTexts }),
      retryDelayMs: 0,
      now: () => "2026-04-23T00:00:00.000Z"
    });

    const result = await handler.handle({ workspace_id: "workspace-1" });

    expect(result.objectsAffected).toEqual([]);
    expect(upsert).not.toHaveBeenCalled();
    for (const memory of hotMemories) {
      expect(result.auditEntries).toContain(
        `embedding_failed:provider:${memory.object_id}:provider permanently down`
      );
    }
  });
});

describe("resolveBackfillBatchConcurrency", () => {
  // invariant: default = 6, max clamp = 32 (module constants). Strict
  // invariant: integer-prefix garbage ("7abc"/"8.5"/"1e3") must map to
  // the default, and oversized valid values ("999") must clamp to 32.
  it("accepts a full positive-integer string", () => {
    expect(resolveBackfillBatchConcurrency("8")).toBe(8);
  });

  it("clamps a valid oversized string to the max ceiling", () => {
    expect(resolveBackfillBatchConcurrency("999")).toBe(32);
  });

  it("rejects an integer-prefix garbage string and falls back to the default", () => {
    expect(resolveBackfillBatchConcurrency("7abc")).toBe(6);
  });

  it("rejects a decimal string and falls back to the default", () => {
    expect(resolveBackfillBatchConcurrency("8.5")).toBe(6);
  });

  it("rejects zero-padded integer-prefix garbage and falls back to the default", () => {
    expect(resolveBackfillBatchConcurrency("000bad")).toBe(6);
  });

  it("rejects scientific notation and falls back to the default", () => {
    expect(resolveBackfillBatchConcurrency("1e3")).toBe(6);
  });

  it("rejects zero and falls back to the default", () => {
    expect(resolveBackfillBatchConcurrency("0")).toBe(6);
  });

  it("rejects a negative string and falls back to the default", () => {
    expect(resolveBackfillBatchConcurrency("-3")).toBe(6);
  });

  it("trims surrounding whitespace around a valid integer string", () => {
    expect(resolveBackfillBatchConcurrency(" 8 ")).toBe(8);
  });

  it("clamps an oversized explicit number and rejects a non-integer number", () => {
    expect(resolveBackfillBatchConcurrency(999)).toBe(32);
    expect(resolveBackfillBatchConcurrency(6.7)).toBe(6);
  });

  it("falls back to the default when the value is undefined", () => {
    expect(resolveBackfillBatchConcurrency(undefined)).toBe(6);
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

function createEmbeddingMetadata(
  overrides: Partial<EmbeddingBackfillMetadata>
): EmbeddingBackfillMetadata {
  return {
    object_id: overrides.object_id ?? "memory-1",
    workspace_id: overrides.workspace_id ?? "workspace-1",
    content_hash: overrides.content_hash ?? "sha256:memory-1",
    provider_kind: overrides.provider_kind ?? "openai",
    model_id: overrides.model_id ?? "text-embedding-3-small",
    schema_version: overrides.schema_version ?? 1,
    dimensions: overrides.dimensions ?? 3,
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
