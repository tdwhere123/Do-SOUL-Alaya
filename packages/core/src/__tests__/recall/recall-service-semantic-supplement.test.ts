import { describe, expect, it, vi } from "vitest";
import { RecallService } from "../../recall/recall-service.js";
import { prepareEmbeddingSupplementQuery } from "../../recall/supplements/supplements.js";
import { createDependencies, createMemoryEntry, createPreparedQueryHandle, createTaskSurface, overridePolicy } from "./recall-service-test-fixtures.js";

describe("retained component contracts", () => {
it("preserves the legacy query-embedding receiver", async () => {
    const basePolicy = new RecallService(createDependencies([]).dependencies)
      .buildDefaultPolicy("analyze", createTaskSurface().runtime_id);
    const preparedQuery = createPreparedQueryHandle("prepared-query-receiver");
    const embeddingRecallService = {
      preparedQuery,
      prepareQueryEmbedding() { return this.preparedQuery; },
      querySupplement: vi.fn(async () => ({
        supplementaryEntries: Object.freeze([]), similarityHintsByObjectId: Object.freeze({})
      }))
    };
    const result = await prepareEmbeddingSupplementQuery({
      dependencies: { embeddingRecallService },
      config: overridePolicy(basePolicy, {
        coarse_filter: {
          ...basePolicy.coarse_filter,
          semantic_supplement: { enabled: true, max_supplement: 1, embedding_enabled: true }
        }
      }),
      workspaceId: "workspace-1",
      runId: "run-1",
      queryText: "query",
      localEligibleCandidates: [{ entry: createMemoryEntry() }],
      lexicalFallbackCount: 1
    });
    expect(result.handle).toBe(preparedQuery);
  });

it("reports no_stored_vectors from the legacy hasStoredVectors precheck", async () => {
    const basePolicy = new RecallService(createDependencies([]).dependencies)
      .buildDefaultPolicy("analyze", createTaskSurface().runtime_id);
    const eligibleMemory = createMemoryEntry({ object_id: "memory-lexical" });
    const result = await prepareEmbeddingSupplementQuery({
      dependencies: {
        embeddingRecallService: {
          hasStoredVectors: vi.fn(async () => false),
          prepareQueryEmbedding: vi.fn(() => createPreparedQueryHandle("prepared-query-unused")),
          querySupplement: vi.fn(async () => ({
            supplementaryEntries: Object.freeze([]),
            similarityHintsByObjectId: Object.freeze({})
          }))
        }
      },
      config: overridePolicy(basePolicy, {
        coarse_filter: {
          ...basePolicy.coarse_filter,
          semantic_supplement: { enabled: true, max_supplement: 1, embedding_enabled: true }
        }
      }),
      workspaceId: "workspace-1",
      runId: "run-1",
      queryText: "query",
      localEligibleCandidates: [{ entry: eligibleMemory }],
      lexicalFallbackCount: 1
    });

    expect(result.handle).toBeNull();
    expect(result.degradedReason).toBe("no_stored_vectors");
  });
});
