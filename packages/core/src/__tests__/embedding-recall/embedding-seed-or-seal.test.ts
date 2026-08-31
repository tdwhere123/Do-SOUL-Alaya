import { afterEach, describe, expect, it, vi } from "vitest";

import {
  installCoreConfigFromProcessEnv,
  resetCoreConfigForTests
} from "../../runtime/config/index.js";
import { RequestScoreSnapshotBuilder } from
  "../../embedding-recall/scoring/request-score-snapshot.js";
import type { QueryEmbeddingEngine } from
  "../../embedding-recall/query-embedding-engine.js";
import { EmbeddingRecallService } from "../../embedding-recall/embedding-recall-service.js";
import { createPreparedEmbeddingQueryHandle } from
  "../../embedding-recall/helpers.js";
import {
  createEmbeddingRecord,
  createMemoryEntry,
  createProvider,
  hashMemoryContent
} from "./embedding-recall-test-helpers.js";

describe("embedding seed-or-seal", () => {
  afterEach(() => {
    resetCoreConfigForTests();
  });

  it("names an unusable ready query vector instead of scoring an empty ledger as observed", async () => {
    const memory = createMemoryEntry({ object_id: "pool-zero-query", content: "Zero query." });
    const provider = createProvider();
    const builder = new RequestScoreSnapshotBuilder({
      provider,
      embeddingRepo: {
        listByObjectIds: vi.fn(async () => [createEmbeddingRecord({
          object_id: memory.object_id,
          content_hash: hashMemoryContent(memory.content),
          embedding: new Float32Array([1, 0])
        })])
      },
      queryEngine: {
        prepareQueryEmbedding: () => createPreparedEmbeddingQueryHandle(
          "query-zero",
          Object.freeze({ status: "ready", embedding: new Float32Array([0, 0]) }),
          { cacheHit: true }
        )
      } as unknown as QueryEmbeddingEngine,
      queryTimeoutMs: 50,
      generateQueryId: () => "query-zero",
      nowEpochMs: () => 0,
      warn: vi.fn()
    });

    const snapshot = await builder.prepare({
      workspaceId: "workspace-1",
      runId: null,
      queryText: "zero vector query",
      poolMemories: [memory],
      maxNeighbors: 0
    });

    expect(snapshot.degradedReason).toBe("query_embedding_unusable");
    expect(snapshot.poolScoresByObjectId).toEqual({});
    expect(snapshot.workspaceNeighbors.query_embedding_status).toBe("query_embedding_unusable");
    expect(snapshot.fieldChannelCaptures?.find(({ channel }) =>
      channel.channel_id === "object_embedding_pool")?.channel.status).toBe("unavailable");
  });

  it("seals the workspace seed channel when neighbor top-k truncates a complete scan", async () => {
    installCoreConfigFromProcessEnv({ ALAYA_EMBEDDING_WORKSPACE_SCAN_CAP: "8" });
    const pooled = createMemoryEntry({ object_id: "pool-keep", content: "Pooled." });
    const neighbors = ["seed-a", "seed-b", "seed-c"].map((objectId) =>
      createMemoryEntry({ object_id: objectId, content: objectId }));
    const service = new EmbeddingRecallService({
      embeddingRepo: {
        listByWorkspace: vi.fn(async () => [
          createEmbeddingRecord({
            object_id: pooled.object_id,
            content_hash: hashMemoryContent(pooled.content),
            embedding: new Float32Array([1, 0])
          }),
          ...neighbors.map((memory, index) => createEmbeddingRecord({
            object_id: memory.object_id,
            content_hash: hashMemoryContent(memory.content),
            embedding: new Float32Array([0.9 - index * 0.1, 0.1])
          }))
        ]),
        listByObjectIds: vi.fn(async () => [])
      },
      provider: createProvider({ embedTexts: vi.fn(async () => [new Float32Array([1, 0])]) }),
      eventLogRepo: {
        append: vi.fn(async (entry) => ({
          event_id: "event-1",
          created_at: "2026-07-14T00:00:00.000Z",
          revision: 0,
          ...entry
        })),
        queryByEntity: vi.fn(async () => [])
      }
    });

    const snapshot = await service.prepareRecallEmbeddingSnapshot({
      workspaceId: "workspace-1",
      runId: null,
      queryText: "seed query",
      poolMemories: [pooled],
      maxNeighbors: 1
    });

    const workspace = snapshot.fieldChannelCaptures?.find(({ channel }) =>
      channel.channel_id === "object_embedding_workspace")?.channel;
    expect(snapshot.workspaceNeighbors.hits).toHaveLength(1);
    expect(workspace?.status).toBe("truncated");
    expect(workspace?.unseen_upper_bound).toBe(1);
  });
});
