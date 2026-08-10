import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MemoryDimension,
  RunMode,
  RunState,
  ScopeClass,
  WorkspaceKind,
  WorkspaceState
} from "@do-soul/alaya-protocol";
import {
  initDatabase,
  readSchemaMigrationLedger,
  SqliteMemoryEntryRepo,
  SqliteRunRepo,
  SqliteWorkspaceRepo,
  type StorageDatabase
} from "@do-soul/alaya-storage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyEmbeddingCacheOverlay
} from "../../../longmemeval/snapshot/recall-eval/embedding-cache-overlay/importer.js";
import {
  writeEmbeddingCacheOverlay
} from "../../../longmemeval/snapshot/recall-eval/embedding-cache-overlay/writer.js";
import { sha256File } from
  "../../../longmemeval/snapshot/integrity.js";
import { prepareRecallEvalDataRoot } from
  "../../../longmemeval/lifecycle/recall-eval/recall-eval-runtime.js";
import type { RecallEvalSnapshotBundle } from
  "../../../longmemeval/snapshot/recall-eval/recall-eval-loader.js";

const SOURCE_MANIFEST_SHA = "b".repeat(64);
const MODEL_ARTIFACT_SHA = "c".repeat(64);
const MEMORY_ID = "11111111-1111-4111-8111-111111111111";
const EVIDENCE_ID = "22222222-2222-4222-8222-222222222222";
const VECTOR_SPACE = Object.freeze({
  provider_kind: "local_onnx" as const,
  model_id: "fixture-model",
  schema_version: 1,
  dimensions: 2,
  d2q_input: "raw_content" as const,
  model_artifact_sha256: MODEL_ARTIFACT_SHA
});

let root: string;
let sourceDbPath: string;
let warmedDbPath: string;
let targetDbPath: string;
let receiptPath: string;
let sourceDbSha256: string;
let sourceSchemaVersion: number;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "embedding-overlay-"));
  sourceDbPath = join(root, "source.db");
  warmedDbPath = join(root, "warmed.db");
  targetDbPath = join(root, "target.db");
  receiptPath = join(root, "overlay-receipt.json");
  await createSourceDatabase(sourceDbPath);
  sourceDbSha256 = await sha256File(sourceDbPath);
  sourceSchemaVersion = readSchemaMigrationLedger(sourceDbPath).at(-1)!;
  await copyFile(sourceDbPath, warmedDbPath);
  seedEmbeddings(warmedDbPath);
  await copyFile(sourceDbPath, targetDbPath);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("source-bound embedding cache overlay", () => {
  it("imports exact memory and evidence vectors into a clean snapshot copy", async () => {
    const written = await writeFixtureOverlay();

    const binding = await applyEmbeddingCacheOverlay({
      receiptPath,
      restoredDbPath: targetDbPath,
      expected: expectedBinding()
    });

    const target = initDatabase({ filename: targetDbPath });
    expect(countRows(target, "memory_embeddings")).toBe(1);
    expect(countRows(target, "evidence_recall_embeddings")).toBe(1);
    expect(binding).toMatchObject({
      receipt_sha256: written.receipt_sha256,
      overlay_sha256: written.overlay_sha256,
      memory_embedding_count: 1,
      evidence_embedding_count: 1,
      vector_space: VECTOR_SPACE
    });
    target.close();
  });

  it("applies the overlay after snapshot restore and exposes its receipt", async () => {
    const written = await writeFixtureOverlay();
    const dataDirRoot = join(root, "runtime-data");

    const prepared = await prepareRecallEvalDataRoot({
      snapshotDbPath: sourceDbPath,
      variant: "longmemeval_s",
      historyRoot: join(root, "history"),
      dataDirRoot,
      embeddingCacheOverlayReceiptPath: receiptPath
    }, {
      snapshotDbPath: sourceDbPath,
      manifest: {
        schema_migration_version: sourceSchemaVersion,
        recall_pipeline_version: "fusion-evidence-first-v3"
      }
    } as RecallEvalSnapshotBundle, undefined, expectedBinding());

    expect(prepared.embeddingCacheOverlay).toMatchObject({
      receipt_sha256: written.receipt_sha256,
      overlay_sha256: written.overlay_sha256
    });
    const restored = initDatabase({ filename: join(dataDirRoot, "alaya.db") });
    expect(countRows(restored, "memory_embeddings")).toBe(1);
    expect(countRows(restored, "evidence_recall_embeddings")).toBe(1);
    restored.close();
  });

  it("rejects source drift before importing any rows", async () => {
    await writeFixtureOverlay();

    await expect(applyEmbeddingCacheOverlay({
      receiptPath,
      restoredDbPath: targetDbPath,
      expected: {
        ...expectedBinding(),
        source_snapshot_db_sha256: "d".repeat(64)
      }
    })).rejects.toThrow(/source snapshot DB SHA-256 binding mismatch/u);

    const target = initDatabase({ filename: targetDbPath });
    expect(countRows(target, "memory_embeddings")).toBe(0);
    expect(countRows(target, "evidence_recall_embeddings")).toBe(0);
    target.close();
  });

  it("rolls back instead of overwriting a conflicting existing vector", async () => {
    await writeFixtureOverlay();
    seedMemoryEmbedding(targetDbPath, new Float32Array([9, 9]));

    await expect(applyEmbeddingCacheOverlay({
      receiptPath,
      restoredDbPath: targetDbPath,
      expected: expectedBinding()
    })).rejects.toThrow(/conflicts with restored embedding rows/u);

    const target = initDatabase({ filename: targetDbPath });
    const blob = target.connection.prepare(
      "SELECT embedding_blob FROM memory_embeddings WHERE object_id = ?"
    ).pluck().get(MEMORY_ID) as Buffer;
    expect(blob.readFloatLE(0)).toBe(9);
    expect(countRows(target, "evidence_recall_embeddings")).toBe(0);
    target.close();
  });

  it("preserves an existing receipt and removes an unpublished overlay", async () => {
    await writeFile(receiptPath, "occupied\n", "utf8");

    await expect(writeFixtureOverlay()).rejects.toThrow(/output already exists/u);

    await expect(readFile(join(root, "overlay-receipt.sqlite"))).rejects.toMatchObject({
      code: "ENOENT"
    });
    await expect(readFile(receiptPath, "utf8")).resolves.toBe("occupied\n");
  });
});

async function writeFixtureOverlay() {
  return writeEmbeddingCacheOverlay({
    warmedDbPath,
    receiptPath,
    source: expectedBinding()
  });
}

function expectedBinding() {
  return {
    source_snapshot_db_sha256: sourceDbSha256,
    source_snapshot_manifest_sha256: SOURCE_MANIFEST_SHA,
    source_schema_version: sourceSchemaVersion,
    recall_pipeline_version: "fusion-evidence-first-v3",
    vector_space: VECTOR_SPACE
  };
}

async function createSourceDatabase(path: string): Promise<void> {
  const database = initDatabase({ filename: path });
  await new SqliteWorkspaceRepo(database).create({
    workspace_id: "workspace-1",
    name: "workspace one",
    root_path: "/tmp/workspace-1",
    workspace_kind: WorkspaceKind.LOCAL_REPO,
    default_engine_binding: null,
    default_engine_class: "conversation_engine",
    workspace_state: WorkspaceState.ACTIVE
  });
  await new SqliteRunRepo(database).create({
    run_id: "run-1",
    workspace_id: "workspace-1",
    title: "run one",
    goal: null,
    run_mode: RunMode.CHAT,
    engine_binding_id: null,
    engine_class: null,
    run_state: RunState.IDLE,
    current_surface_id: null
  });
  await new SqliteMemoryEntryRepo(database).create({
    object_id: MEMORY_ID,
    object_kind: "memory_entry",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: "2026-08-10T00:00:00.000Z",
    updated_at: "2026-08-10T00:00:00.000Z",
    created_by: "embedding-overlay-test",
    dimension: MemoryDimension.FACT,
    source_kind: "user",
    formation_kind: "explicit",
    scope_class: ScopeClass.PROJECT,
    content: "Memory source.",
    domain_tags: [],
    evidence_refs: [],
    workspace_id: "workspace-1",
    run_id: "run-1",
    surface_id: null,
    storage_tier: "hot",
    activation_score: 0.5,
    retention_score: null,
    manifestation_state: null,
    retention_state: null,
    decay_profile: null,
    confidence: null,
    last_used_at: null,
    last_hit_at: null,
    reinforcement_count: null,
    contradiction_count: null,
    superseded_by: null
  });
  database.connection.prepare(`
    INSERT INTO evidence_capsules (
      object_id, created_at, updated_at, created_by, evidence_kind,
      semantic_anchor, physical_anchor, evidence_health_state, gist, excerpt,
      source_hash, run_id, workspace_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    EVIDENCE_ID, "2026-08-10T00:00:00.000Z", "2026-08-10T00:00:00.000Z",
    "garden_compile", "conversation_excerpt", "{}", null, "verified",
    "Evidence source.", "Evidence source.", "sha256:fixture", "run-1", "workspace-1"
  );
  database.close();
}

function seedEmbeddings(path: string): void {
  seedMemoryEmbedding(path, new Float32Array([1, 2]));
  const database = initDatabase({ filename: path });
  database.connection.prepare(`
    INSERT INTO evidence_recall_embeddings (
      workspace_id, owner_object_id, document_identity, content_hash,
      document_role, provider_kind, model_id, schema_version, dimensions,
      embedding_blob, vector_valid, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'evidence_document', ?, ?, ?, ?, ?, 1, ?, ?)
  `).run(
    "workspace-1", EVIDENCE_ID, "owner", "sha256:evidence",
    VECTOR_SPACE.provider_kind, VECTOR_SPACE.model_id, VECTOR_SPACE.schema_version,
    VECTOR_SPACE.dimensions, encodeVector(new Float32Array([3, 4])),
    "2026-08-10T00:00:00.000Z", "2026-08-10T00:00:00.000Z"
  );
  database.close();
}

function seedMemoryEmbedding(path: string, vector: Float32Array): void {
  const database = initDatabase({ filename: path });
  database.connection.prepare(`
    INSERT INTO memory_embeddings (
      object_id, workspace_id, content_hash, provider_kind, model_id,
      schema_version, dimensions, embedding_blob, vector_valid, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
  `).run(
    MEMORY_ID, "workspace-1", "sha256:memory", VECTOR_SPACE.provider_kind,
    VECTOR_SPACE.model_id, VECTOR_SPACE.schema_version, VECTOR_SPACE.dimensions,
    encodeVector(vector), "2026-08-10T00:00:00.000Z", "2026-08-10T00:00:00.000Z"
  );
  database.close();
}

function encodeVector(vector: Float32Array): Buffer {
  const bytes = Buffer.alloc(vector.length * Float32Array.BYTES_PER_ELEMENT);
  vector.forEach((value, index) => bytes.writeFloatLE(
    value, index * Float32Array.BYTES_PER_ELEMENT
  ));
  return bytes;
}

function countRows(database: StorageDatabase, table: string): number {
  return database.connection.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get() as number;
}
