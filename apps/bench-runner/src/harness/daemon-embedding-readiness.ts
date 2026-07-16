import { createHash } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { assertValidEmbeddingBatch } from "@do-soul/alaya-core";
import type { BenchEmbeddingWarmupSummary } from "./daemon-types.js";
import { embeddingInputIdentityForSchemaVersion } from "./strict-treatment-config.js";

interface EmbeddingReadinessRow {
  readonly object_id: string;
  readonly content_hash: string;
  readonly provider_kind: string;
  readonly model_id: string;
  readonly schema_version: number;
  readonly dimensions: number;
  readonly embedding_blob: Uint8Array;
  readonly vector_valid: number;
  readonly content: string;
}

const READINESS_ID_CHUNK_SIZE = 5_000;

export async function readEmbeddingWarmupSummary(input: {
  readonly dataDir: string;
  readonly workspaceId: string;
  readonly objectIds: readonly string[];
  readonly providerKind: string;
  readonly modelId: string;
  readonly schemaVersion: number;
  readonly expectedDimensions: number;
  readonly passCount: number;
}): Promise<BenchEmbeddingWarmupSummary> {
  const expectedIds = [...new Set(input.objectIds)];
  const inputIdentity = embeddingInputIdentityForSchemaVersion(input.schemaVersion);
  if (expectedIds.length === 0) {
    return Object.freeze({
      status: "ready",
      expected_count: 0,
      ready_count: 0,
      ready_rate: 0,
      pass_count: input.passCount,
      missing_object_ids: Object.freeze([]),
      provider_kind: input.providerKind,
      model_id: input.modelId,
      ...inputIdentity
    });
  }

  const db = new DatabaseSync(join(input.dataDir, "alaya.db"), { readOnly: true });
  try {
    const readyIds = readReadyEmbeddingIds(db, input, expectedIds);
    const missingObjectIds = expectedIds.filter((objectId) => !readyIds.has(objectId));
    return Object.freeze({
      status: "ready",
      expected_count: expectedIds.length,
      ready_count: readyIds.size,
      ready_rate: ratio(readyIds.size, expectedIds.length),
      pass_count: input.passCount,
      missing_object_ids: Object.freeze(missingObjectIds),
      provider_kind: input.providerKind,
      model_id: input.modelId,
      ...inputIdentity
    });
  } finally {
    db.close();
  }
}

function readReadyEmbeddingIds(
  db: DatabaseSync,
  input: Parameters<typeof readEmbeddingWarmupSummary>[0],
  expectedIds: readonly string[]
): ReadonlySet<string> {
  const readyIds = new Set<string>();
  const cachedDimensions = new Set<number>();
  const statement = db.prepare(`
    SELECT e.object_id, e.content_hash, e.provider_kind, e.model_id,
           e.schema_version, e.dimensions, e.embedding_blob, e.vector_valid,
           m.content
      FROM memory_embeddings e
      JOIN memory_entries m
        ON m.object_id = e.object_id AND m.workspace_id = e.workspace_id
     WHERE e.workspace_id = ?
       AND e.object_id IN (SELECT value FROM json_each(?))
  `);
  for (let offset = 0; offset < expectedIds.length; offset += READINESS_ID_CHUNK_SIZE) {
    const chunk = expectedIds.slice(offset, offset + READINESS_ID_CHUNK_SIZE);
    const rows = statement.all(
      input.workspaceId, JSON.stringify(chunk)
    ) as unknown as EmbeddingReadinessRow[];
    for (const row of rows) {
      if (!isReadyEmbeddingRow(row, input)) continue;
      cachedDimensions.add(row.dimensions);
      if (row.dimensions === input.expectedDimensions) readyIds.add(row.object_id);
    }
  }
  return cachedDimensions.size > 1 ? new Set() : readyIds;
}

function isReadyEmbeddingRow(
  row: EmbeddingReadinessRow,
  input: Parameters<typeof readEmbeddingWarmupSummary>[0]
): boolean {
  return row.provider_kind === input.providerKind &&
    row.model_id === input.modelId &&
    row.schema_version === input.schemaVersion &&
    row.vector_valid === 1 &&
    row.content_hash === hashMemoryContent(row.content) &&
    hasValidEmbeddingBlob(row.embedding_blob, row.dimensions);
}

function hasValidEmbeddingBlob(blob: Uint8Array, dimensions: number): boolean {
  if (!Number.isInteger(dimensions) || dimensions <= 0 ||
      blob.byteLength !== dimensions * Float32Array.BYTES_PER_ELEMENT) {
    return false;
  }
  try {
    const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
    const embedding = new Float32Array(dimensions);
    for (let index = 0; index < dimensions; index += 1) {
      embedding[index] = view.getFloat32(index * Float32Array.BYTES_PER_ELEMENT, true);
    }
    assertValidEmbeddingBatch([embedding], 1);
    return true;
  } catch {
    return false;
  }
}

function hashMemoryContent(content: string): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function ratio(count: number, total: number): number {
  return total === 0 ? 0 : count / total;
}
