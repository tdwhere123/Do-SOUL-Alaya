import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EmbeddingBackfillHandler } from "@do-soul/alaya-core";
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
  SqliteMemoryEmbeddingRepo,
  SqliteMemoryEntryRepo,
  SqliteRunRepo,
  SqliteWorkspaceRepo,
  type StorageDatabase
} from "@do-soul/alaya-storage";
import { readEmbeddingWarmupSummary } from "../../harness/daemon-embedding-readiness.js";

const tmpDirs = new Set<string>();
const databases = new Set<StorageDatabase>();

afterEach(async () => {
  for (const database of databases) {
    if (!database.isClosed()) database.close();
  }
  databases.clear();
  for (const dir of tmpDirs) await rm(dir, { recursive: true, force: true });
  tmpDirs.clear();
});

describe("embedding warmup vector validity", () => {
  it("repairs a legacy zero vector before readiness can pass", async () => {
    const fixture = await createFixture(["11111111-1111-4111-8111-111111111111"]);
    const memory = fixture.memories[0]!;
    insertLegacyVector(fixture.database, memory, new Float32Array([0, 0]));
    const embedTexts = vi.fn(async (texts: readonly string[]) =>
      texts.map(() => new Float32Array([1, 0]))
    );
    const handler = new EmbeddingBackfillHandler({
      memoryRepo: fixture.memoryRepo,
      memoryEmbeddingRepo: fixture.embeddingRepo,
      provider: createProvider(embedTexts),
      retryDelayMs: 0
    });

    expect((await readSummary(fixture, [memory.object_id])).ready_count).toBe(0);
    await handler.handle({ workspace_id: "workspace-1" });

    expect(embedTexts).toHaveBeenCalledOnce();
    expect((await readSummary(fixture, [memory.object_id])).ready_count).toBe(1);
    await expect(fixture.embeddingRepo.findMetadataByObjectIds([memory.object_id]))
      .resolves.toEqual([expect.objectContaining({ vector_valid: true })]);
    fixture.database.close();
  });

  it("reuses a migrated valid vector without provider work", async () => {
    const fixture = await createFixture(["11111111-1111-4111-8111-111111111111"]);
    const memory = fixture.memories[0]!;
    insertLegacyVector(fixture.database, memory, new Float32Array([1, 0]), 1);
    const embedTexts = vi.fn(async (texts: readonly string[]) =>
      texts.map(() => new Float32Array([1, 0]))
    );
    const handler = new EmbeddingBackfillHandler({
      memoryRepo: fixture.memoryRepo,
      memoryEmbeddingRepo: fixture.embeddingRepo,
      provider: createProvider(embedTexts),
      retryDelayMs: 0
    });

    const result = await handler.handle({ workspace_id: "workspace-1" });

    expect(embedTexts).not.toHaveBeenCalled();
    expect(result.objectsAffected).toEqual([]);
    expect((await readSummary(fixture, [memory.object_id])).ready_count).toBe(1);
    fixture.database.close();
  });

  it("keeps every row not-ready when one cache identity contains mixed dimensions", async () => {
    const fixture = await createFixture([
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222"
    ]);
    await fixture.embeddingRepo.upsert(createRecord(fixture.memories[0]!, new Float32Array([1, 0])));
    await fixture.embeddingRepo.upsert(createRecord(fixture.memories[1]!, new Float32Array([1, 0, 0])));

    await expect(readSummary(fixture, fixture.memories.map(({ object_id }) => object_id)))
      .resolves.toMatchObject({ ready_count: 0 });
    fixture.database.close();
  });

  it("rejects a complete cache from the provider's previous dimensions", async () => {
    const fixture = await createFixture(["11111111-1111-4111-8111-111111111111"]);
    const memory = fixture.memories[0]!;
    await fixture.embeddingRepo.upsert(createRecord(memory, new Float32Array([1, 0])));

    await expect(readSummary(fixture, [memory.object_id], 3))
      .resolves.toMatchObject({ ready_count: 0 });
    fixture.database.close();
  });
});

interface Fixture {
  readonly dataDir: string;
  readonly database: StorageDatabase;
  readonly memoryRepo: SqliteMemoryEntryRepo;
  readonly embeddingRepo: SqliteMemoryEmbeddingRepo;
  readonly memories: readonly MemoryEntry[];
}

async function createFixture(objectIds: readonly string[]): Promise<Fixture> {
  const dataDir = await mkdtemp(join(tmpdir(), "embedding-validity-"));
  tmpDirs.add(dataDir);
  const database = initDatabase({ filename: join(dataDir, "alaya.db") });
  databases.add(database);
  const memoryRepo = new SqliteMemoryEntryRepo(database);
  await seedWorkspace(database);
  const memories = objectIds.map(createMemory);
  for (const memory of memories) await memoryRepo.create(memory);
  return {
    dataDir,
    database,
    memoryRepo,
    embeddingRepo: new SqliteMemoryEmbeddingRepo(database),
    memories
  };
}

async function seedWorkspace(database: StorageDatabase): Promise<void> {
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
}

function insertLegacyVector(
  database: StorageDatabase,
  memory: MemoryEntry,
  embedding: Float32Array,
  vectorValid = 0
): void {
  database.connection.prepare(`
    INSERT INTO memory_embeddings (
      object_id, workspace_id, content_hash, provider_kind, model_id,
      schema_version, dimensions, embedding_blob, vector_valid, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    memory.object_id,
    memory.workspace_id,
    hashContent(memory.content),
    "openai",
    "fixture-model",
    1,
    embedding.length,
    encodeFloat32LittleEndian(embedding),
    vectorValid,
    memory.created_at,
    memory.updated_at
  );
}

function createRecord(memory: MemoryEntry, embedding: Float32Array) {
  return {
    object_id: memory.object_id,
    workspace_id: memory.workspace_id!,
    content_hash: hashContent(memory.content),
    provider_kind: "openai",
    model_id: "fixture-model",
    schema_version: 1,
    dimensions: embedding.length,
    embedding,
    created_at: memory.created_at,
    updated_at: memory.updated_at
  };
}

function createProvider(embedTexts: (texts: readonly string[]) => Promise<readonly Float32Array[]>) {
  return {
    providerKind: "openai",
    modelId: "fixture-model",
    schemaVersion: 1,
    isAvailable: true,
    embedTexts
  };
}

function encodeFloat32LittleEndian(vector: Float32Array): Buffer {
  const blob = Buffer.alloc(vector.length * Float32Array.BYTES_PER_ELEMENT);
  vector.forEach((value, index) => {
    blob.writeFloatLE(value, index * Float32Array.BYTES_PER_ELEMENT);
  });
  return blob;
}

async function readSummary(
  fixture: Fixture,
  objectIds: readonly string[],
  expectedDimensions = 2
) {
  return await readEmbeddingWarmupSummary({
    dataDir: fixture.dataDir,
    workspaceId: "workspace-1",
    objectIds,
    providerKind: "openai",
    modelId: "fixture-model",
    schemaVersion: 1,
    expectedDimensions,
    passCount: 0
  });
}

function hashContent(content: string): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function createMemory(objectId: string): MemoryEntry {
  const now = "2026-07-16T00:00:00.000Z";
  return {
    object_id: objectId,
    object_kind: "memory_entry",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: now,
    updated_at: now,
    created_by: "embedding-validity-test",
    dimension: MemoryDimension.FACT,
    source_kind: "user",
    formation_kind: "explicit",
    scope_class: ScopeClass.PROJECT,
    content: `Embedding validity source for ${objectId}.`,
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
