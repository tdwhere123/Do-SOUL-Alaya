import { describe, expect, it, vi } from "vitest";
import { RecallService } from "../../recall/recall-service.js";
import { prepareEmbeddingSupplementQuery } from "../../recall/supplements/supplements.js";
import {
  createDependencies,
  createMemoryEntry,
  createPreparedQueryHandle,
  createTaskSurface,
  overridePolicy
} from "../recall/recall-service-test-fixtures.js";

describe("lexical recall does not wait for query embedding", () => {
  it("does not call waitForSnapshot when embedding is not requested", async () => {
    const waitForSnapshot = vi.fn(async () => {
      throw new Error("lexical path must not wait for query embedding");
    });
    const prepareQueryEmbedding = vi.fn(() => ({
      ...createPreparedQueryHandle("unused"),
      waitForSnapshot
    }));
    const scorePoolCandidates = vi.fn(async () => {
      throw new Error("lexical path must not score embeddings");
    });
    const prepareRecallEmbeddingSnapshot = vi.fn(async () => {
      throw new Error("lexical path must not prepare embedding snapshot");
    });
    const collectWorkspaceNeighbors = vi.fn(async () => {
      throw new Error("lexical path must not scan neighbors");
    });
    const memories = [createMemoryEntry({
      object_id: "memory-lexical",
      content: "Lexical baseline procedure."
    })];
    const { dependencies } = createDependencies(memories);
    const service = new RecallService({
      ...dependencies,
      embeddingRecallService: {
        hasStoredVectors: vi.fn(async () => true),
        prepareQueryEmbedding,
        scorePoolCandidates,
        prepareRecallEmbeddingSnapshot,
        collectWorkspaceNeighbors,
        querySupplementIfReady: vi.fn(async () => ({
          supplementaryEntries: Object.freeze([]),
          similarityHintsByObjectId: Object.freeze({})
        })),
        querySupplement: vi.fn(async () => ({
          supplementaryEntries: Object.freeze([]),
          similarityHintsByObjectId: Object.freeze({})
        }))
      }
    });

    await service.recall({
      taskSurface: createTaskSurface(),
      workspaceId: "workspace-1",
      strategy: "analyze"
    });

    expect(waitForSnapshot).not.toHaveBeenCalled();
    expect(prepareQueryEmbedding).not.toHaveBeenCalled();
    expect(scorePoolCandidates).not.toHaveBeenCalled();
    expect(prepareRecallEmbeddingSnapshot).not.toHaveBeenCalled();
    expect(collectWorkspaceNeighbors).not.toHaveBeenCalled();
  });

  it("skips supplement preparation when embedding is disabled", async () => {
    const waitForSnapshot = vi.fn(async () => {
      throw new Error("lexical path must not wait for query embedding");
    });
    const prepareQueryEmbedding = vi.fn(() => ({
      ...createPreparedQueryHandle("unused"),
      waitForSnapshot
    }));
    const basePolicy = new RecallService(createDependencies([]).dependencies)
      .buildDefaultPolicy("analyze", createTaskSurface().runtime_id);
    const prepared = await prepareEmbeddingSupplementQuery({
      dependencies: {
        embeddingRecallService: {
          prepareQueryEmbedding,
          prepareQuerySupplement: vi.fn(async () => {
            throw new Error("lexical path must not prepare supplement");
          }),
          querySupplement: vi.fn(async () => {
            throw new Error("lexical path must not query supplement");
          })
        }
      },
      config: overridePolicy(basePolicy, {
        coarse_filter: {
          ...basePolicy.coarse_filter,
          semantic_supplement: {
            ...basePolicy.coarse_filter.semantic_supplement,
            embedding_enabled: false
          }
        }
      }),
      workspaceId: "workspace-1",
      runId: "run-1",
      queryText: "query",
      localEligibleCandidates: [{ entry: createMemoryEntry() }],
      lexicalFallbackCount: 1
    });

    expect(prepared.handle).toBeNull();
    expect(prepareQueryEmbedding).not.toHaveBeenCalled();
    expect(waitForSnapshot).not.toHaveBeenCalled();
  });
});
