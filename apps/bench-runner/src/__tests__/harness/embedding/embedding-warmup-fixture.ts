import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";

import {
  MemoryDimension,
  RunMode,
  RunState,
  ScopeClass,
  WorkspaceKind,
  WorkspaceState,
  type MemoryEntry
} from "@do-soul/alaya-protocol";
import {
  initDatabase,
  SqliteMemoryEntryRepo,
  SqliteRunRepo,
  SqliteWorkspaceRepo
} from "@do-soul/alaya-storage";
import { afterEach, vi } from "vitest";

import type { BenchEmbeddingWarmupSummary } from "../../../harness/embedding/embedding-warmup.js";

export const READY_MEMORY_ID = "11111111-1111-4111-8111-111111111111";
export const MISSING_MEMORY_ID = "22222222-2222-4222-8222-222222222222";

const tmpDirs = new Set<string>();

export function registerEmbeddingWarmupCleanup(): void {
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all([...tmpDirs].map(
      async (dir) => await rm(dir, { recursive: true, force: true })
    ));
    tmpDirs.clear();
  });
}

export async function createEmbeddingWarmupTempDir(prefix: string): Promise<string> {
  const dataDir = await mkdtemp(join(tmpdir(), prefix));
  tmpDirs.add(dataDir);
  return dataDir;
}

export function embeddingWarmupSummary(
  expected: number,
  ready: number,
  passCount: number
): BenchEmbeddingWarmupSummary {
  const clampedReady = Math.min(ready, expected);
  return {
    status: "ready",
    expected_count: expected,
    ready_count: clampedReady,
    ready_rate: expected === 0 ? 0 : clampedReady / expected,
    pass_count: passCount,
    missing_object_ids: [],
    provider_kind: "openai",
    model_id: "text-embedding-3-small",
    schema_version: 1,
    d2q_input: "raw_content"
  };
}

export async function createReadinessFixture(
  contentHash: string,
  blobBytes: number
): Promise<string> {
  const dataDir = await createEmbeddingWarmupTempDir("embedding-readiness-fixture-");
  const database = initDatabase({ filename: join(dataDir, "alaya.db") });
  const workspaceRepo = new SqliteWorkspaceRepo(database);
  const runRepo = new SqliteRunRepo(database);
  const memoryRepo = new SqliteMemoryEntryRepo(database);
  await createEmbeddingWorkspace(workspaceRepo, runRepo);
  await memoryRepo.create(createMemoryEntry(READY_MEMORY_ID));
  database.connection.prepare(
    `INSERT INTO memory_embeddings (
      object_id, workspace_id, content_hash, provider_kind, model_id,
      schema_version, dimensions, embedding_blob, vector_valid, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
  ).run(
    READY_MEMORY_ID, "workspace-1", contentHash, "openai", "text-embedding-3-small",
    1, 1, blobBytes === Float32Array.BYTES_PER_ELEMENT
      ? validEmbeddingBlob(1)
      : Buffer.alloc(blobBytes),
    "2026-06-01T00:00:00.000Z", "2026-06-01T00:00:00.000Z"
  );
  return dataDir;
}

export function validEmbeddingBlob(dimensions: number): Buffer {
  const vector = new Float32Array(dimensions);
  vector[0] = 1;
  return encodeFloat32LittleEndian(vector);
}

export function overwriteEmbeddingBlob(dataDir: string, vector: Float32Array): void {
  const database = initDatabase({ filename: join(dataDir, "alaya.db") });
  try {
    database.connection.prepare(
      "UPDATE memory_embeddings SET embedding_blob = ? WHERE object_id = ?"
    ).run(encodeFloat32LittleEndian(vector), READY_MEMORY_ID);
  } finally {
    database.close();
  }
}

export function hashContent(content: string): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

async function createEmbeddingWorkspace(
  workspaceRepo: SqliteWorkspaceRepo,
  runRepo: SqliteRunRepo
): Promise<void> {
  await workspaceRepo.create({
    workspace_id: "workspace-1", name: "workspace one", root_path: "/tmp/workspace-1",
    workspace_kind: WorkspaceKind.LOCAL_REPO, default_engine_binding: null,
    default_engine_class: "conversation_engine", workspace_state: WorkspaceState.ACTIVE
  });
  await runRepo.create({
    run_id: "run-1", workspace_id: "workspace-1", title: "run one", goal: null,
    run_mode: RunMode.CHAT, engine_binding_id: null, engine_class: null,
    run_state: RunState.IDLE, current_surface_id: null
  });
}

function encodeFloat32LittleEndian(vector: Float32Array): Buffer {
  const blob = Buffer.alloc(vector.length * Float32Array.BYTES_PER_ELEMENT);
  vector.forEach((value, index) => {
    blob.writeFloatLE(value, index * Float32Array.BYTES_PER_ELEMENT);
  });
  return blob;
}

export function createMemoryEntry(objectId: string): MemoryEntry {
  return {
    object_id: objectId,
    object_kind: "memory_entry",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: "2026-06-01T00:00:00.000Z",
    updated_at: "2026-06-01T00:00:00.000Z",
    created_by: "embedding-warmup-summary-test",
    dimension: MemoryDimension.FACT,
    source_kind: "user",
    formation_kind: "explicit",
    scope_class: ScopeClass.PROJECT,
    content: `Embedding warmup source for ${objectId}.`,
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
  };
}
