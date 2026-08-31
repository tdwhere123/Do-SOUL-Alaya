import { describe, expect, it } from "vitest";
import { buildObjectEmbeddingFieldCaptures } from
  "../../../recall/field/object-embedding-field-capture.js";
import {
  createEmbeddingRecord,
  createMemoryEntry,
  createProvider
} from "../../embedding-recall/embedding-recall-test-helpers.js";

describe("object embedding field capture query skip", () => {
  it("keeps pool and workspace channels unavailable unless the query actually returned a vector", () => {
    const memory = createMemoryEntry({ object_id: "pool-1", content: "Pooled." });
    const scan = {
      records: [createEmbeddingRecord({
        object_id: memory.object_id,
        embedding: new Float32Array([1, 0])
      })],
      cap: 8,
      returned: 1,
      truncated: false,
      attempted: true,
      failed: false
    };
    const returnedNull = buildObjectEmbeddingFieldCaptures({
      workspaceId: "workspace-1",
      runId: null,
      queryText: "query",
      poolMemories: [memory],
      maxNeighbors: 4,
      provider: createProvider(),
      queryStatus: "provider_returned",
      queryEmbedding: null,
      scan,
      exactLookupFailed: false,
      poolScores: { [memory.object_id]: 0.9 },
      workspaceHits: [{ object_id: "near", normalized_similarity: 0.9 }],
      seedNeighborCount: 1,
      seedNeighborLimit: 8
    });
    const unusable = buildObjectEmbeddingFieldCaptures({
      workspaceId: "workspace-1",
      runId: null,
      queryText: "query",
      poolMemories: [memory],
      maxNeighbors: 4,
      provider: createProvider(),
      queryStatus: "query_embedding_unusable",
      queryEmbedding: null,
      scan,
      exactLookupFailed: false,
      poolScores: { [memory.object_id]: 0.9 },
      workspaceHits: [{ object_id: "near", normalized_similarity: 0.9 }],
      seedNeighborCount: 1,
      seedNeighborLimit: 8
    });

    expect(returnedNull.map(({ channel }) => channel.status)).toEqual([
      "unavailable",
      "unavailable"
    ]);
    expect(unusable.map(({ channel }) => channel.status)).toEqual([
      "unavailable",
      "unavailable"
    ]);
  });
});
