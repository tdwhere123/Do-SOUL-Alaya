import { describe, expect, it } from "vitest";
import { EMBEDDING_WORKSPACE_SCAN_CAP } from "../../embedding-recall/constants.js";
import { computeCoherentPairKeys } from "../../embedding-recall/pool-scoring.js";
import type { EmbeddingVectorRecord } from "../../embedding-recall/types.js";

const provider = {
  providerKind: "fixture",
  modelId: "fixture-model",
  schemaVersion: 1,
  isAvailable: true,
  embedTexts: async () => []
};

describe("coherent pair scan cap", () => {
  it("bounds pairwise cosine work to the workspace scan cap for large object sets", () => {
    const sizes = [100, 1000, 5000] as const;
    const elapsed: number[] = [];
    for (const size of sizes) {
      const objectIds = Array.from({ length: size }, (_value, index) => `obj-${String(index)}`);
      const records = objectIds.map((objectId) => embeddingRecord(objectId));
      const started = performance.now();
      const pairs = computeCoherentPairKeys(records, objectIds, 0.5, provider);
      elapsed.push(performance.now() - started);
      expect(pairs.has(`obj-0|obj-1`)).toBe(true);
      if (size > EMBEDDING_WORKSPACE_SCAN_CAP) {
        const overflow = `obj-${String(EMBEDDING_WORKSPACE_SCAN_CAP)}`;
        expect([...pairs].some((key) => key.includes(overflow) || key.includes(`obj-${String(size - 1)}`))).toBe(false);
      }
    }
    expect(elapsed[1] ?? 0).toBeLessThan(1_000);
    expect(elapsed[2] ?? 0).toBeLessThan(1_000);
  });
});

function embeddingRecord(objectId: string): EmbeddingVectorRecord {
  return {
    object_id: objectId,
    workspace_id: "workspace-1",
    content_hash: `hash-${objectId}`,
    provider_kind: "fixture",
    model_id: "fixture-model",
    schema_version: 1,
    dimensions: 2,
    embedding: new Float32Array([1, 0]),
    created_at: "2026-07-16T00:00:00.000Z",
    updated_at: "2026-07-16T00:00:00.000Z"
  };
}
