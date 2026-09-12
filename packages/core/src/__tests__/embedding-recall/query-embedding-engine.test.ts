import { describe, expect, it } from "vitest";
import { QueryEmbeddingEngine } from "../../embedding-recall/query-embedding-engine.js";

describe("QueryEmbeddingEngine warmup status", () => {
  it("reports failed when every provider batch throws and no vectors are ready", async () => {
    const engine = createEngine(async () => {
      throw new Error("provider down");
    });

    const summary = await engine.warmQueryEmbeddings({
      workspaceId: "workspace-1",
      runId: null,
      queryTexts: ["first", "second"]
    });
    expect(summary).toMatchObject({
      status: "failed",
      requested_count: 2,
      ready_count: 0,
      missing_count: 2,
      last_error: "provider down"
    });
    expect(engine.lastQueryEmbeddingWarmup()).toEqual(summary);
  });

  it("reports partial when some warmup batches succeed and a later batch fails", async () => {
    const queries = Array.from({ length: 33 }, (_, index) => `query-${index}`);
    const engine = createEngine(async (texts) => {
      if (texts.includes("query-16")) {
        throw new Error("provider temporarily unreachable");
      }
      return texts.map(() => new Float32Array([0, 1]));
    });

    const summary = await engine.warmQueryEmbeddings({
      workspaceId: "workspace-1",
      runId: null,
      queryTexts: queries
    });
    expect(summary).toMatchObject({
      status: "partial",
      requested_count: 33,
      ready_count: 17,
      missing_count: 16,
      last_error: "provider temporarily unreachable"
    });
    expect(engine.lastQueryEmbeddingWarmup()).toEqual(summary);
  });

  it("reports ready when every requested query embedding is cached", async () => {
    const engine = createEngine(async (texts) => texts.map(() => new Float32Array([0, 1])));

    await expect(engine.warmQueryEmbeddings({
      workspaceId: "workspace-1",
      runId: null,
      queryTexts: ["only"]
    })).resolves.toMatchObject({
      status: "ready",
      requested_count: 1,
      ready_count: 1,
      missing_count: 0
    });
  });
});

function createEngine(
  embedTexts: (texts: readonly string[]) => Promise<readonly Float32Array[]>
): QueryEmbeddingEngine {
  return new QueryEmbeddingEngine({
    provider: {
      providerKind: "fixture",
      modelId: "fixture-model",
      schemaVersion: 1,
      isAvailable: true,
      embedTexts
    },
    generateQueryId: () => "query-1",
    queryTimeoutMs: 100,
    queryEmbeddingCacheSize: 64
  });
}
