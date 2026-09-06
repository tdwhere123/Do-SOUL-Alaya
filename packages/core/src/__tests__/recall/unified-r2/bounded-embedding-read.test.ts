import { writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { SqliteMemoryEmbeddingRepo, type MemoryEmbeddingRecord } from "@do-soul/alaya-storage";
import { LocalOnnxEmbeddingClient } from "../../../embedding-recall/local-onnx-embedding-client.js";
import { createSliceHarness } from "./harness.js";

const provider = new LocalOnnxEmbeddingClient({ execution: "in_process" });
const databases = new Set<{ close(): void }>();
let vector: Float32Array;
const content = "Alex works from Lisbon weekdays.";
const profile = { providerKind: provider.providerKind, modelId: provider.modelId, schemaVersion: provider.schemaVersion,
  maxRows: 3, maxMetadataUtf8Bytes: 1024 };
const options = { ...profile, expectedDimensions: 384, maxVectorBytes: 1536, maxObjectIds: 3 };

beforeAll(async () => {
  vi.stubGlobal("fetch", () => { throw new Error("bounded embedding test attempted network"); });
  const vectors = await provider.embedTexts([content], { timeoutMs: 60_000 });
  vector = vectors[0]!;
  expect(vector.length).toBe(384);
  expect(new Set(vector).size).toBeGreaterThan(1);
}, 120_000);
afterAll(async () => { await provider.close(); vi.unstubAllGlobals(); });
afterEach(() => { vi.restoreAllMocks(); for (const db of databases) db.close(); databases.clear(); });

function record(id: string, overrides: Partial<MemoryEmbeddingRecord> = {}): MemoryEmbeddingRecord {
  return { object_id: id, workspace_id: "workspace-1", content_hash: `sha256:${createHash("sha256").update(content).digest("hex")}`,
    provider_kind: provider.providerKind, model_id: provider.modelId, schema_version: provider.schemaVersion,
    dimensions: vector.length, embedding: vector, created_at: "2026-09-05T00:00:00Z", updated_at: "2026-09-05T00:00:00Z", ...overrides };
}

describe("bounded exact-profile embedding storage reads", () => {
  it("never materializes oversized vectors or metadata and admits the real local model vector", async () => {
    const slice = await createSliceHarness((db) => databases.add(db), ":memory:", provider);
    const repo = new SqliteMemoryEmbeddingRepo(slice.database);
    const ids = ["75000000-0000-4000-8000-000000000001", "75000000-0000-4000-8000-000000000002", "75000000-0000-4000-8000-000000000003"];
    for (const id of ids) await slice.writeMemory(id, content, "fact", false);
    await repo.upsert(record(ids[0]!, { dimensions: 32768, embedding: new Float32Array(32768).fill(0.1) }));
    await repo.upsert(record(ids[1]!, { content_hash: "x".repeat(131072) }));
    await repo.upsert(record(ids[2]!));
    const materialized: Record<string, unknown>[] = [];
    const prepare = slice.database.connection.prepare.bind(slice.database.connection);
    vi.spyOn(slice.database.connection, "prepare").mockImplementation((sql) => {
      const statement = prepare(sql);
      if (sql.includes("FROM json_each($ids)")) {
        const all = statement.all.bind(statement);
        vi.spyOn(statement, "all").mockImplementation((...args: unknown[]) => {
          const rows = all(...args) as Record<string, unknown>[]; materialized.push(...rows); return rows;
        });
      }
      return statement;
    });
    const result = await repo.listBoundedByObjectIds("workspace-1", ids, options);
    expect(result.records.map((row) => row.object_id)).toEqual([ids[2]]);
    expect(result.records[0]!.embedding).toEqual(vector);
    expect(result.rowVisits).toBe(3);
    expect(result.vectorBytes).toBe(1536);
    expect(result.filteredRows).toBe(2);
    expect(result.truncated).toBe(true);
    expect(materialized).toHaveLength(3);
    expect(materialized.filter((row) => row.eligible === 0).every((row) => row.embedding_blob === null && row.content_hash === null)).toBe(true);
    expect(materialized.flatMap(Object.values).filter(Buffer.isBuffer).reduce((sum, blob) => sum + blob.length, 0)).toBe(1536);
    expect(await repo.listBoundedByObjectIds("other-workspace", ids, options)).toMatchObject({ records: [], rowVisits: 0 });
    slice.database.connection.prepare("UPDATE memory_embeddings SET dimensions = 384 WHERE object_id = ?").run(ids[0]);
    expect(await repo.listBoundedByObjectIds("workspace-1", [ids[0]!], options)).toMatchObject({ records: [], vectorBytes: 0, filteredRows: 1, truncated: true });
    expect(materialized.at(-1)!.embedding_blob).toBeNull();
    const capped = await repo.listBoundedByObjectIds("workspace-1", [...ids].reverse(), { ...options, maxRows: 1 });
    expect(capped).toMatchObject({ records: [], rowVisits: 1, vectorBytes: 0, truncated: true });
    const recalled = await slice.runRecall({ text: "Who works remotely?", nBase: 0, rBase: 0, nExtension: 1, rExtension: 4,
      familyCaps: { lexical: "unavailable", typed_relation: "unavailable", embedding: "ready" } });
    expect(recalled.membership).toEqual([]);
    expect(recalled.counters.query_embed_count).toBe(0);
    expect(recalled.counters.embedding_vector_payload_bytes).toBe(0);
    expect(recalled.counters.row_visits).toBe(2);
    expect(recalled.pack.truncated).toBe(true);
    writeFileSync("/tmp/stop01-bounded-vector-raw-06.json", JSON.stringify({ createdAt: new Date().toISOString(),
      eligibleVectorBytes: result.vectorBytes, rows: result.rowVisits, filtered: result.filteredRows,
      materializedRows: materialized.map((row) => ({ eligible: row.eligible, vectorBytes: Buffer.isBuffer(row.embedding_blob) ? row.embedding_blob.length : 0, maskedMetadata: row.content_hash === null })),
      integratedRextension: 4, counters: recalled.counters, truncated: recalled.pack.truncated }, null, 2));
  });

  it("caps native indexed identity visits before inactive source filtering with no refill", async () => {
    const slice = await createSliceHarness((db) => databases.add(db), ":memory:", provider);
    const repo = new SqliteMemoryEmbeddingRepo(slice.database);
    repo.prepareBoundedRecallIndex();
    for (let index = 0; index < 64; index += 1) {
      const id = `aaaaaaaa-aaaa-4aaa-8aaa-${String(index).padStart(12, "0")}`;
      await slice.writeMemory(id, content, "fact", false);
      await repo.upsert(record(id));
    }
    slice.database.connection.prepare("UPDATE memory_entries SET retention_state = 'tombstoned' WHERE object_id LIKE 'aaaaaaaa-%'").run();
    let nativeVisits = 0;
    let instrumented = 0;
    slice.database.connection.function("bounded_embedding_visit", (_id: unknown) => { nativeVisits += 1; return 1; });
    const prepare = slice.database.connection.prepare.bind(slice.database.connection);
    vi.spyOn(slice.database.connection, "prepare").mockImplementation((sql) => {
      if (sql.includes("SELECT e.object_id AS object_id")) {
        instrumented += 1;
        return prepare(sql.replace("ORDER BY e.object_id ASC LIMIT", "AND bounded_embedding_visit(e.object_id) ORDER BY e.object_id ASC LIMIT"));
      }
      return prepare(sql);
    });
    const result = await repo.listBoundedIdsByWorkspace("workspace-1", profile);
    expect(instrumented).toBe(1);
    expect(nativeVisits).toBe(3);
    expect(result.rowVisits).toBe(3);
    expect(result.objectIds).toEqual([0, 1, 2].map((index) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(index).padStart(12, "0")}`));
    expect(result.metadataUtf8Bytes).toBe(108);
    writeFileSync("/tmp/stop01-bounded-embedding-ids-raw-06.json", JSON.stringify({ createdAt: new Date().toISOString(),
      storedCandidates: 64, maxRows: 3, nativeVisits, instrumented, result }, null, 2));
    expect(result.truncated).toBe(true);
  });
});
