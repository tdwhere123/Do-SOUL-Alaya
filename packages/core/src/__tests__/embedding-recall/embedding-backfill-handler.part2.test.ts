import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EmbeddingBackfillHandler, isEmbeddingBackfillPartialFailureError, resolveBackfillBatchConcurrency } from "../../embedding-recall/embedding-backfill-handler.js";
import type { EmbeddingVectorRecord } from "../../embedding-recall/embedding-recall-service.js";

import { createMemoryEntry, createProvider } from "./embedding-backfill-handler.test-support.js";

describe("EmbeddingBackfillHandler", () => {
beforeEach(() => {
    vi.stubEnv("ALAYA_EMBEDDING_RECALL_TIERS", "hot");
  });

afterEach(() => {
    vi.unstubAllEnvs();
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
