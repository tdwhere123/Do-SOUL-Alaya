import {
  FormationKind,
  MemoryDimension,
  RunMode,
  RunState,
  ScopeClass,
  SourceKind,
  StorageTier,
  WorkspaceKind,
  WorkspaceState,
  type MemoryEntry
} from "@do-soul/alaya-protocol";
import {
  SqliteMemoryEntryRepo,
  SqliteRunRepo,
  SqliteWorkspaceRepo,
  initDatabase
} from "@do-soul/alaya-storage";

// Shared real-sqlite fixtures for reconciliation survivor-persistence tests:
// a fresh in-memory db with workspace-1/run-1 wired, plus a default memory_entry
// seed. Callers register afterEach(closeReconciliationTestDatabases).

const databases = new Set<ReturnType<typeof initDatabase>>();

export function closeReconciliationTestDatabases(): void {
  for (const database of databases) {
    database.close();
  }
  databases.clear();
}

export async function createReconciliationMemoryRepo(): Promise<SqliteMemoryEntryRepo> {
  const database = initDatabase({ filename: ":memory:" });
  databases.add(database);
  new SqliteWorkspaceRepo(database).create({
    workspace_id: "workspace-1",
    name: "workspace one",
    root_path: "/tmp/ws1",
    workspace_kind: WorkspaceKind.LOCAL_REPO,
    default_engine_binding: null,
    workspace_state: WorkspaceState.ACTIVE
  });
  new SqliteRunRepo(database).create({
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
  return new SqliteMemoryEntryRepo(database);
}

export function seedReconciliationEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    object_id: "11111111-1111-4111-8111-111111111111",
    object_kind: "memory_entry",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: "2026-06-01T00:00:00.000Z",
    updated_at: "2026-06-01T00:00:00.000Z",
    created_by: "user_action",
    dimension: MemoryDimension.FACT,
    source_kind: SourceKind.USER,
    formation_kind: FormationKind.EXPLICIT,
    scope_class: ScopeClass.PROJECT,
    content: "The user works at a firm in Berlin.",
    domain_tags: ["residence"],
    evidence_refs: ["evidence-old"],
    workspace_id: "workspace-1",
    run_id: "run-1",
    surface_id: null,
    storage_tier: StorageTier.HOT,
    activation_score: null,
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
    forget_disposition: null,
    forget_disposition_ref: null,
    ...overrides
  };
}
