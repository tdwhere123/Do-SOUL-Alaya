import { describe, expect, it } from "vitest";
import { assertValidEmbeddingBatch } from "../../index.js";
import { isUsableEmbeddingRecordVector } from "../../embedding-recall/helpers.js";
import { computeCoherentPairKeys } from "../../embedding-recall/pool-scoring.js";
import { QueryEmbeddingEngine } from "../../embedding-recall/query-embedding-engine.js";
import type { EmbeddingVectorRecord } from "../../embedding-recall/types.js";

describe("embedding vector validation", () => {
  it("accepts a complete batch of finite nonzero vectors with one dimension", () => {
    expect(() => assertValidEmbeddingBatch([
      new Float32Array([1, 0]),
      new Float32Array([0, -1])
    ], 2)).not.toThrow();
  });

  it("requires the expected batch count and one shared dimension", () => {
    expect(() => assertValidEmbeddingBatch([new Float32Array([1])], 2))
      .toThrow(/Expected 2 embeddings/u);
    expect(() => assertValidEmbeddingBatch([
      new Float32Array([1]),
      new Float32Array([1, 0])
    ], 2)).toThrow(/dimensions/u);
  });

  it.each([
    ["empty", new Float32Array()],
    ["zero", new Float32Array([0, 0])],
    ["NaN", new Float32Array([Number.NaN, 1])],
    ["Infinity", new Float32Array([Number.POSITIVE_INFINITY, 1])]
  ])("rejects a %s vector", (_label, vector) => {
    expect(() => assertValidEmbeddingBatch([vector], 1)).toThrow(/nonzero norm/u);
  });

  it.each([
    ["declared dimension mismatch", { dimensions: 3, embedding: new Float32Array([1, 0]) }],
    ["stored length mismatch", { dimensions: 2, embedding: new Float32Array([1]) }],
    ["zero vector", { dimensions: 2, embedding: new Float32Array([0, 0]) }],
    ["non-finite vector", { dimensions: 2, embedding: new Float32Array([Number.NaN, 1]) }]
  ])("rejects a record with %s", (_label, record) => {
    expect(isUsableEmbeddingRecordVector(record, 2)).toBe(false);
  });

  it("accepts a finite nonzero record at the expected dimension", () => {
    expect(isUsableEmbeddingRecordVector(
      { dimensions: 2, embedding: new Float32Array([1, 0]) },
      2
    )).toBe(true);
  });

  it.each([
    ["zero", new Float32Array([0, 0])],
    ["NaN", new Float32Array([Number.NaN, 1])],
    ["Infinity", new Float32Array([Number.POSITIVE_INFINITY, 1])]
  ])("does not form a floor-zero pair from a %s stored vector", (_label, vector) => {
    expect(computePairs([
      embeddingRecord("a", vector),
      embeddingRecord("b", new Float32Array([1, 0]))
    ])).toEqual(new Set());
  });

  it("does not compare individually valid vectors from different dimensions", () => {
    expect(computePairs([
      embeddingRecord("a", new Float32Array([1, 0])),
      embeddingRecord("b", new Float32Array([1, 0, 0]))
    ])).toEqual(new Set());
  });

  it("preserves floor-zero coherence for valid orthogonal vectors", () => {
    expect(computePairs([
      embeddingRecord("a", new Float32Array([1, 0])),
      embeddingRecord("b", new Float32Array([0, 1]))
    ])).toEqual(new Set(["a|b"]));
  });
});

describe("QueryEmbeddingEngine vector boundary", () => {
  it.each([
    ["zero", new Float32Array([0, 0])],
    ["NaN", new Float32Array([Number.NaN, 1])]
  ])("rejects a %s prepared vector", async (_label, vector) => {
    const prepared = createEngine(async () => [vector]).prepareQueryEmbedding({
      workspaceId: "workspace-1",
      runId: null,
      queryText: "invalid vector"
    });

    await expect(prepared.waitForSnapshot!(50)).resolves.toMatchObject({
      status: "failed",
      reason: "query_embedding_failed"
    });
  });

  it("does not cache a dimensionally inconsistent warmup batch", async () => {
    const engine = createEngine(async () => [
      new Float32Array([1, 0]),
      new Float32Array([1, 0, 0])
    ]);

    await expect(engine.warmQueryEmbeddings({
      workspaceId: "workspace-1",
      runId: null,
      queryTexts: ["first", "second"]
    })).resolves.toMatchObject({ ready_count: 0, missing_count: 2 });
  });

  it("rejects an invalid immediate query response", async () => {
    const engine = createEngine(async () => [new Float32Array([Number.POSITIVE_INFINITY])]);
    await expect(engine.resolveQueryEmbeddingNow("invalid vector")).rejects.toThrow(/nonzero norm/u);
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
    queryEmbeddingCacheSize: 10
  });
}

function computePairs(records: readonly EmbeddingVectorRecord[]) {
  return computeCoherentPairKeys(records, ["a", "b"], 0, {
    providerKind: "fixture",
    modelId: "fixture-model",
    schemaVersion: 1,
    isAvailable: true,
    embedTexts: async () => []
  });
}

function embeddingRecord(
  objectId: string,
  embedding: Float32Array
): EmbeddingVectorRecord {
  return {
    object_id: objectId,
    workspace_id: "workspace-1",
    content_hash: `hash-${objectId}`,
    provider_kind: "fixture",
    model_id: "fixture-model",
    schema_version: 1,
    dimensions: embedding.length,
    embedding,
    created_at: "2026-07-16T00:00:00.000Z",
    updated_at: "2026-07-16T00:00:00.000Z"
  };
}
