import { access, copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  closeCachedDatabase,
  initDatabase,
  readSchemaMigrationLedger,
  SqliteMemoryEmbeddingRepo,
  SqliteMemoryEntryRepo,
  SqliteRunRepo,
  SqliteWorkspaceRepo,
  type StorageDatabase
} from "@do-soul/alaya-storage";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyEmbeddingCacheOverlay
} from "../../../bench/snapshot/recall-eval/embedding-cache-overlay/importer.js";
import {
  writeEmbeddingCacheOverlay
} from "../../../bench/snapshot/recall-eval/embedding-cache-overlay/writer.js";
import {
  emitEmbeddingCacheOverlay,
  productOverlayEmbeddingClientOptions
} from "../../../bench/snapshot/recall-eval/embedding-cache-overlay/emit.js";
import { sha256File } from
  "../../../bench/snapshot/integrity.js";
import { prepareRecallEvalDataRoot } from
  "../../../bench/lifecycle/recall-eval/recall-eval-runtime.js";
import { openRecallEvalWorkingSqlite, recallEvalWorkingDbPath } from
  "../../../bench/snapshot/recall-eval/recall-eval-working-sqlite.js";
import type { RecallEvalSnapshotBundle } from
  "../../../bench/snapshot/recall-eval/recall-eval-loader.js";

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
  it("binds overlay vectors without inserting blobs into the restored copy", async () => {
    const written = await writeFixtureOverlay();

    const binding = await applyEmbeddingCacheOverlay({
      receiptPath,
      restoredDbPath: targetDbPath,
      expected: expectedBinding()
    });

    const target = openProjected(targetDbPath);
    expect(countMainRows(target, "memory_embeddings")).toBe(0);
    expect(countMainRows(target, "evidence_recall_embeddings")).toBe(0);
    expect(countRows(target, "memory_embeddings")).toBe(1);
    expect(countRows(target, "evidence_recall_embeddings")).toBe(1);
    const loaded = await new SqliteMemoryEmbeddingRepo(target).findByObjectId(MEMORY_ID);
    expect(loaded?.embedding).toEqual(new Float32Array([1, 2]));
    expect(() => target.connection.exec("CREATE TEMP TABLE overlay_write_probe(x INTEGER)")).not.toThrow();
    expect(binding).toMatchObject({
      receipt_sha256: written.receipt_sha256,
      overlay_sha256: written.overlay_sha256,
      memory_embedding_count: 1,
      evidence_embedding_count: 1,
      vector_space: VECTOR_SPACE
    });
    await expect(access(join(root, `.embedding-cache-overlay-${written.overlay_sha256}.sqlite`)))
      .resolves.toBeUndefined();
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
    const unbound = openProjected(join(dataDirRoot, "alaya.db"));
    expect(countMainRows(unbound, "memory_embeddings")).toBe(0);
    expect(countRows(unbound, "memory_embeddings")).toBe(0);
    unbound.close();
    await openRecallEvalWorkingSqlite({
      restoredDbPath: recallEvalWorkingDbPath(dataDirRoot),
      options: {
        snapshotDbPath: sourceDbPath,
        variant: "longmemeval_s",
        historyRoot: join(root, "history"),
        dataDirRoot,
        embeddingCacheOverlayReceiptPath: receiptPath
      },
      manifest: {
        schema_migration_version: sourceSchemaVersion,
        recall_pipeline_version: "fusion-evidence-first-v3"
      } as RecallEvalSnapshotBundle["manifest"],
      warm: null,
      overlayExpected: expectedBinding()
    });
    const restored = openProjected(join(dataDirRoot, "alaya.db"));
    expect(countMainRows(restored, "memory_embeddings")).toBe(0);
    expect(countRows(restored, "memory_embeddings")).toBe(1);
    expect(countRows(restored, "evidence_recall_embeddings")).toBe(1);
    restored.close();
  });

  it("rejects source drift before binding any overlay", async () => {
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
    expect(countMainRows(target, "memory_embeddings")).toBe(0);
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
      "SELECT embedding_blob FROM main.memory_embeddings WHERE object_id = ?"
    ).pluck().get(MEMORY_ID) as Buffer;
    expect(blob.readFloatLE(0)).toBe(9);
    expect(countMainRows(target, "evidence_recall_embeddings")).toBe(0);
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

describe("readonly snapshot overlay emit", () => {
  it("writes vectors to the overlay without mutating the frozen snapshot", async () => {
    const beforeSha = await sha256File(sourceDbPath);
    const embedTexts = vi.fn(async (texts: readonly string[]) =>
      texts.map(() => new Float32Array([1, 2]))
    );

    const binding = await emitEmbeddingCacheOverlay({
      snapshotDbPath: sourceDbPath,
      receiptPath,
      provider: {
        providerKind: VECTOR_SPACE.provider_kind,
        modelId: VECTOR_SPACE.model_id,
        schemaVersion: VECTOR_SPACE.schema_version,
        isAvailable: true,
        embedTexts
      },
      source: expectedBinding()
    });

    expect(embedTexts).toHaveBeenCalled();
    expect(binding.memory_embedding_count).toBe(1);
    expect(await sha256File(sourceDbPath)).toBe(beforeSha);
    const source = initDatabase({ filename: sourceDbPath });
    expect(countRows(source, "memory_embeddings")).toBe(0);
    source.close();

    await applyEmbeddingCacheOverlay({
      receiptPath,
      restoredDbPath: targetDbPath,
      expected: expectedBinding()
    });
    const target = openProjected(targetDbPath);
    expect(countMainRows(target, "memory_embeddings")).toBe(0);
    expect(countRows(target, "memory_embeddings")).toBe(1);
    target.close();
  });

  it("refuses content_plus_hq overlays so mint-time HQ cannot leak into the sidecar", async () => {
    await expect(emitEmbeddingCacheOverlay({
      snapshotDbPath: sourceDbPath,
      receiptPath,
      provider: {
        providerKind: VECTOR_SPACE.provider_kind,
        modelId: VECTOR_SPACE.model_id,
        schemaVersion: VECTOR_SPACE.schema_version,
        isAvailable: true,
        embedTexts: async () => [new Float32Array([1, 2])]
      },
      source: {
        ...expectedBinding(),
        vector_space: { ...VECTOR_SPACE, d2q_input: "content_plus_hq" }
      }
    })).rejects.toThrow(/raw_content d2q input/u);
    const source = initDatabase({ filename: sourceDbPath });
    expect(countRows(source, "memory_embeddings")).toBe(0);
    source.close();
  });

  it("uses the product ONNX cache tree when ALAYA_LOCAL_EMBEDDING_CACHE_DIR is unset", () => {
    expect(productOverlayEmbeddingClientOptions({})).not.toHaveProperty("cacheDir");
    expect(productOverlayEmbeddingClientOptions({
      ALAYA_LOCAL_EMBEDDING_CACHE_DIR: "/tmp/alaya-onnx-cache"
    }).cacheDir).toBe("/tmp/alaya-onnx-cache");
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

function openProjected(filename: string): StorageDatabase {
  closeCachedDatabase(filename);
  return initDatabase({ filename });
}

function countRows(database: StorageDatabase, table: string): number {
  return database.connection.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get() as number;
}

function countMainRows(database: StorageDatabase, table: string): number {
  return database.connection.prepare(`SELECT COUNT(*) FROM main.${table}`).pluck().get() as number;
}
