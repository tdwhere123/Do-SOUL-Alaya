import {
  FormationKind,
  MemoryDimension,
  MemoryGovernanceEventType,
  RunMode,
  RunState,
  ScopeClass,
  SourceKind,
  StorageTier,
  WorkspaceKind,
  WorkspaceState,
  type MemoryEntry
} from "@do-soul/alaya-protocol";
import { initDatabase } from "../../../sqlite/db.js";
import { SqliteEventLogRepo } from "../../../repos/runtime/event-log-repo.js";
import { SqliteMemoryEntryRepo } from "../../../repos/memory-entry/index.js";
import { SqliteRunRepo } from "../../../repos/runtime/run-repo.js";
import { SqliteWorkspaceRepo } from "../../../repos/runtime/workspace-repo.js";

export const trackedDatabases = new Set<ReturnType<typeof initDatabase>>();

export function createMemoryEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    object_id: "70a0b18b-5f8b-4fd2-a1b0-97ce48113fca",
    object_kind: "memory_entry",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: "2026-03-21T00:00:00.000Z",
    updated_at: "2026-03-21T00:00:00.000Z",
    created_by: "user_action",
    dimension: MemoryDimension.PREFERENCE,
    source_kind: SourceKind.USER,
    formation_kind: FormationKind.EXPLICIT,
    scope_class: ScopeClass.PROJECT,
    content: "Use pnpm for all workspace commands.",
    domain_tags: ["tooling", "workflow"],
    evidence_refs: ["evidence-1", "evidence-2"],
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

export function createMemoryCreatedEventInput(
  entry: MemoryEntry
): Parameters<SqliteEventLogRepo["append"]>[0] {
  return {
    event_type: MemoryGovernanceEventType.SOUL_MEMORY_CREATED,
    entity_type: "memory_entry",
    entity_id: entry.object_id,
    workspace_id: entry.workspace_id,
    run_id: entry.run_id,
    caused_by: entry.created_by,
    payload_json: {
      object_id: entry.object_id,
      object_kind: entry.object_kind,
      workspace_id: entry.workspace_id,
      run_id: entry.run_id
    }
  };
}

export async function createRepo(options: { readonly filename?: string } = {}): Promise<{
  readonly database: ReturnType<typeof initDatabase>;
  readonly repo: SqliteMemoryEntryRepo;
}> {
  const database = initDatabase({ filename: options.filename ?? ":memory:" });
  trackedDatabases.add(database);

  const workspaceRepo = new SqliteWorkspaceRepo(database);
  const runRepo = new SqliteRunRepo(database);

  await workspaceRepo.create({
    workspace_id: "workspace-1",
    name: "workspace one",
    root_path: "/tmp/ws1",
    workspace_kind: WorkspaceKind.LOCAL_REPO,
    default_engine_binding: null,
    workspace_state: WorkspaceState.ACTIVE
  });
  await workspaceRepo.create({
    workspace_id: "workspace-2",
    name: "workspace two",
    root_path: "/tmp/ws2",
    workspace_kind: WorkspaceKind.LOCAL_REPO,
    default_engine_binding: null,
    workspace_state: WorkspaceState.ACTIVE
  });

  await runRepo.create({
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
  await runRepo.create({
    run_id: "run-2",
    workspace_id: "workspace-1",
    title: "run two",
    goal: null,
    run_mode: RunMode.CHAT,
    engine_binding_id: null,
    engine_class: null,
    run_state: RunState.IDLE,
    current_surface_id: null
  });
  await runRepo.create({
    run_id: "run-3",
    workspace_id: "workspace-2",
    title: "run three",
    goal: null,
    run_mode: RunMode.CHAT,
    engine_binding_id: null,
    engine_class: null,
    run_state: RunState.IDLE,
    current_surface_id: null
  });

  return {
    database,
    repo: new SqliteMemoryEntryRepo(database)
  };
}
