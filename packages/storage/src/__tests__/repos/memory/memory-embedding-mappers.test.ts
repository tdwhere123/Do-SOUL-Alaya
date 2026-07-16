import { afterEach, describe, expect, it, vi } from "vitest";
import {
  parseMemoryEmbeddingRecord,
  parseMemoryEmbeddingRow,
  runUpsertArgs,
  type MemoryEmbeddingRow
} from "../../../repos/memory/memory-embedding-mappers.js";
import type { MemoryEmbeddingRecord } from "../../../repos/memory/memory-embedding-repo.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("memory embedding mappers", () => {
  it("hydrates one owned vector without retaining the SQLite buffer", () => {
    const row = createRow(new Float32Array([0.25, -0.5, 0.75]));
    const allocations = trackFloat32Allocations();

    const parsed = parseMemoryEmbeddingRow(row);

    expect(allocations()).toBe(1);
    expect(parsed.embedding.buffer).not.toBe(row.embedding_blob.buffer);
    row.embedding_blob.writeFloatLE(9, 0);
    expect(parsed.embedding[0]).toBe(0.25);
    parsed.embedding[1] = 8;
    expect(row.embedding_blob.readFloatLE(4)).toBe(-0.5);
  });

  it("serializes an isolated buffer without another Float32 vector copy", () => {
    const parsed = parseMemoryEmbeddingRecord(createRecord());
    const allocations = trackFloat32Allocations();

    const blob = runUpsertArgs(parsed)[7];

    expect(allocations()).toBe(0);
    expect(blob.buffer).not.toBe(parsed.embedding.buffer);
    parsed.embedding[0] = 9;
    expect(blob.readFloatLE(0)).toBe(0.25);
    blob.writeFloatLE(8, 4);
    expect(parsed.embedding[1]).toBe(-0.5);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "rejects a non-finite persisted component %s",
    (component) => {
      expect(() => parseMemoryEmbeddingRow(
        createRow(new Float32Array([0.25, component, 0.75]))
      )).toThrow(expect.objectContaining({ code: "VALIDATION_FAILED" }));
    }
  );

  it("rejects zero-norm vectors at the storage write and read boundaries", () => {
    const zero = new Float32Array([0, 0, 0]);
    expect(() => parseMemoryEmbeddingRecord({
      ...createRecord(),
      embedding: zero
    })).toThrow(expect.objectContaining({ code: "VALIDATION_FAILED" }));
    expect(() => parseMemoryEmbeddingRow(createRow(zero)))
      .toThrow(expect.objectContaining({ code: "VALIDATION_FAILED" }));
  });

  it("rejects persisted vectors whose bytes do not match the declared dimensions", () => {
    expect(() => parseMemoryEmbeddingRow({
      ...createRow(new Float32Array([0.25, -0.5])),
      dimensions: 3
    })).toThrow(expect.objectContaining({ code: "VALIDATION_FAILED" }));
  });
});

function createRow(embedding: Float32Array): MemoryEmbeddingRow {
  const record = createRecord();
  return {
    object_id: record.object_id,
    workspace_id: record.workspace_id,
    content_hash: record.content_hash,
    provider_kind: record.provider_kind,
    model_id: record.model_id,
    schema_version: record.schema_version,
    dimensions: embedding.length,
    embedding_blob: Buffer.from(
      embedding.buffer.slice(embedding.byteOffset, embedding.byteOffset + embedding.byteLength)
    ),
    created_at: record.created_at,
    updated_at: record.updated_at
  };
}

function createRecord(): MemoryEmbeddingRecord {
  return {
    object_id: "11111111-1111-4111-8111-111111111111",
    workspace_id: "workspace-1",
    content_hash: "sha256:content",
    provider_kind: "openai",
    model_id: "text-embedding-3-small",
    schema_version: 1,
    dimensions: 3,
    embedding: new Float32Array([0.25, -0.5, 0.75]),
    created_at: "2026-07-14T00:00:00.000Z",
    updated_at: "2026-07-14T00:00:00.000Z"
  };
}

function trackFloat32Allocations(): () => number {
  let allocations = 0;
  const CountingFloat32Array = new Proxy(Float32Array, {
    construct(target, args, newTarget) {
      allocations += 1;
      return Reflect.construct(target, args, newTarget);
    }
  });
  vi.stubGlobal("Float32Array", CountingFloat32Array);
  return () => allocations;
}
