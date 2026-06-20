import {
  MemoryDimension,
  RunMode,
  RunState,
  ScopeClass,
  WorkspaceKind,
  WorkspaceState,
  type MemoryEntry
} from "@do-soul/alaya-protocol";
import { initDatabase } from "../../../sqlite/db.js";
import { SqliteMemoryEntryRepo } from "../../../repos/memory-entry/index.js";
import { SqliteRunRepo } from "../../../repos/runtime/run-repo.js";
import { SqliteWorkspaceRepo } from "../../../repos/runtime/workspace-repo.js";
import type {
  MemoryEmbeddingMetadata,
  MemoryEmbeddingRecord
} from "../../../repos/memory/memory-embedding-repo.js";

export const trackedDatabases = new Set<ReturnType<typeof initDatabase>>();

export async function createRepoContext(): Promise<{
  readonly database: ReturnType<typeof initDatabase>;
  readonly workspaceId: string;
  readonly memoryRepo: SqliteMemoryEntryRepo;
  readonly repo: {
    upsert(record: MemoryEmbeddingRecord): Promise<Readonly<MemoryEmbeddingRecord>>;
    upsertIfContentHashMatchesCurrentMemory(
      record: MemoryEmbeddingRecord
    ): Promise<Readonly<MemoryEmbeddingRecord> | null>;
    findByObjectId(objectId: string): Promise<Readonly<MemoryEmbeddingRecord> | null>;
    findMetadataByObjectIds(
      objectIds: readonly string[]
    ): Promise<readonly Readonly<MemoryEmbeddingMetadata>[]>;
    listByWorkspace(
      workspaceId: string,
      options?: {
        readonly tierFilter?: readonly ("hot" | "warm" | "cold")[];
        readonly limit?: number;
        readonly providerKind?: string;
        readonly modelId?: string;
        readonly schemaVersion?: number;
      }
    ): Promise<readonly Readonly<MemoryEmbeddingRecord>[]>;
    listByObjectIds(
      workspaceId: string,
      objectIds: readonly string[]
    ): Promise<readonly Readonly<MemoryEmbeddingRecord>[]>;
  };
}> {
  const database = initDatabase({ filename: ":memory:" });
  trackedDatabases.add(database);

  const workspaceRepo = new SqliteWorkspaceRepo(database);
  const runRepo = new SqliteRunRepo(database);
  const memoryRepo = new SqliteMemoryEntryRepo(database);
  const { SqliteMemoryEmbeddingRepo } = await import("../../../index.js");

  await workspaceRepo.create({
    workspace_id: "workspace-1",
    name: "Embedding Repo Workspace",
    root_path: "/tmp/embedding-repo-workspace",
    workspace_kind: WorkspaceKind.LOCAL_REPO,
    default_engine_binding: null,
    default_engine_class: "conversation_engine",
    workspace_state: WorkspaceState.ACTIVE
  });
  await runRepo.create({
    run_id: "run-1",
    workspace_id: "workspace-1",
    title: "Embedding Repo Run",
    goal: null,
    run_mode: RunMode.CHAT,
    engine_binding_id: null,
    engine_class: null,
    run_state: RunState.IDLE,
    current_surface_id: null
  });
  await memoryRepo.create(createMemoryEntry({ object_id: "11111111-1111-4111-8111-111111111111" }));
  await memoryRepo.create(createMemoryEntry({ object_id: "22222222-2222-4222-8222-222222222222" }));

  return {
    database,
    workspaceId: "workspace-1",
    memoryRepo,
    repo: new SqliteMemoryEmbeddingRepo(database)
  };
}

export function createMemoryEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    object_id: overrides.object_id ?? "11111111-1111-4111-8111-111111111111",
    object_kind: "memory_entry",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: "2026-04-23T00:00:00.000Z",
    updated_at: "2026-04-23T00:00:00.000Z",
    created_by: "system",
    dimension: overrides.dimension ?? MemoryDimension.PROCEDURE,
    source_kind: "user",
    formation_kind: "explicit",
    scope_class: overrides.scope_class ?? ScopeClass.PROJECT,
    content:
      overrides.content ??
      `Embedding source content for ${overrides.object_id ?? "11111111-1111-4111-8111-111111111111"}.`,
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
    superseded_by: null,
    ...overrides
  };
}

export function createEmbeddingRecord(
  overrides: Partial<MemoryEmbeddingRecord> & Pick<MemoryEmbeddingRecord, "object_id" | "workspace_id">
): MemoryEmbeddingRecord {
  return {
    object_id: overrides.object_id,
    workspace_id: overrides.workspace_id,
    content_hash: overrides.content_hash ?? `sha256:${overrides.object_id}`,
    provider_kind: overrides.provider_kind ?? "openai",
    model_id: overrides.model_id ?? "text-embedding-3-small",
    schema_version: overrides.schema_version ?? 1,
    dimensions: overrides.dimensions ?? overrides.embedding?.length ?? 3,
    embedding: overrides.embedding ?? new Float32Array([1, 0, 0]),
    created_at: overrides.created_at ?? "2026-04-23T00:00:00.000Z",
    updated_at: overrides.updated_at ?? "2026-04-23T00:00:00.000Z"
  };
}

export function getColumnNames(database: ReturnType<typeof initDatabase>, tableName: string): string[] {
  return (database.connection
    .prepare(`PRAGMA table_info(${tableName})`)
    .all() as ReadonlyArray<{ readonly name: string }>).map((column) => column.name);
}
