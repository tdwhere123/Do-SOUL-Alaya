import { describe, expect, it, vi } from "vitest";
import { composeEmbeddingBackfillHandlers } from
  "../../embedding-backfill/handler-composition.js";

const TASK = { workspace_id: "workspace-1" };

describe("embedding backfill handler composition", () => {
  it("runs memory and evidence backfill in production mode", async () => {
    const memory = vi.fn(async () => ({
      objectsAffected: ["memory-1"],
      auditEntries: ["embedding_backfill:1"]
    }));
    const evidence = vi.fn(async () => ({
      documentsAffected: 2,
      auditEntries: ["evidence_embedding_backfill:persisted:2"]
    }));
    const handler = composeEmbeddingBackfillHandlers(
      { handle: memory },
      { handle: evidence }
    );

    await expect(handler.handle(TASK)).resolves.toEqual({
      objectsAffected: ["memory-1"],
      auditEntries: [
        "embedding_backfill:1",
        "evidence_embedding_backfill:persisted:2"
      ]
    });
    expect(evidence).toHaveBeenCalledOnce();
  });

  it("warms only requested memory vectors in memory-cache-only mode", async () => {
    const memory = vi.fn(async () => ({
      objectsAffected: ["memory-1"],
      auditEntries: ["embedding_backfill:1"]
    }));
    const evidence = vi.fn();
    const handler = composeEmbeddingBackfillHandlers(
      { handle: memory },
      { handle: evidence }
    );

    await expect(handler.handle(TASK, "memory_cache_only")).resolves.toEqual({
      objectsAffected: ["memory-1"],
      auditEntries: [
        "embedding_backfill:1",
        "evidence_embedding_backfill_skipped:memory_cache_only"
      ]
    });
    expect(evidence).not.toHaveBeenCalled();
  });
});
