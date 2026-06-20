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
  type EdgeProposal,
  type MemoryEntry,
  type PathRelation
} from "@do-soul/alaya-protocol";
import { initDatabase } from "../../../sqlite/db.js";
import { SqliteEdgeProposalRepo } from "../../../repos/path/edge-proposal-repo.js";
import { SqliteMemoryEntryRepo } from "../../../repos/memory-entry/index.js";
import { SqlitePathRelationRepo } from "../../../repos/path/path-relation-repo.js";
import { SqliteRunRepo } from "../../../repos/runtime/run-repo.js";
import { SqliteWorkspaceRepo } from "../../../repos/runtime/workspace-repo.js";

export const trackedDatabases = new Set<ReturnType<typeof initDatabase>>();
export const MEMORY_1 = "00000000-0000-4000-8000-000000000001";
export const MEMORY_2 = "00000000-0000-4000-8000-000000000002";
export const MEMORY_3 = "00000000-0000-4000-8000-000000000003";

export async function createRepo(extraMemoryIds: readonly string[] = []): Promise<{
  readonly repo: SqliteEdgeProposalRepo;
  readonly pathRepo: SqlitePathRelationRepo;
  readonly database: ReturnType<typeof initDatabase>;
}> {
  const database = initDatabase({ filename: ":memory:" });
  trackedDatabases.add(database);
  const workspaceRepo = new SqliteWorkspaceRepo(database);
  const runRepo = new SqliteRunRepo(database);
  const memoryRepo = new SqliteMemoryEntryRepo(database);

  await workspaceRepo.create({
    workspace_id: "workspace-1",
    name: "workspace",
    root_path: "/tmp/workspace",
    workspace_kind: WorkspaceKind.LOCAL_REPO,
    default_engine_binding: null,
    workspace_state: WorkspaceState.ACTIVE
  });
  await runRepo.create({
    run_id: "run-1",
    workspace_id: "workspace-1",
    title: "edge proposal run",
    goal: null,
    run_mode: RunMode.CHAT,
    engine_binding_id: null,
    engine_class: null,
    run_state: RunState.IDLE,
    current_surface_id: null
  });
  await memoryRepo.create(createMemoryEntry(MEMORY_1));
  await memoryRepo.create(createMemoryEntry(MEMORY_2));
  await memoryRepo.create(createMemoryEntry(MEMORY_3));
  for (const memoryId of extraMemoryIds) {
    await memoryRepo.create(createMemoryEntry(memoryId));
  }

  return {
    repo: new SqliteEdgeProposalRepo(database),
    pathRepo: new SqlitePathRelationRepo(database),
    database
  };
}

// Mirrors the accept mint's landing topology: a path_relations row whose
// source/target are object anchors on the two memory ids. `index` keeps path_id
// unique per fixture.
export function mintObjectPath(
  pathRepo: SqlitePathRelationRepo,
  index: number,
  sourceMemoryId: string,
  targetMemoryId: string,
  overrides: Partial<PathRelation> = {}
): void {
  const relation: PathRelation = {
    path_id: `path-${index}`,
    workspace_id: "workspace-1",
    anchors: {
      source_anchor: { kind: "object", object_id: sourceMemoryId },
      target_anchor: { kind: "object", object_id: targetMemoryId }
    },
    constitution: {
      relation_kind: "recalls",
      why_this_relation_exists: ["edge proposal accepted"]
    },
    effect_vector: {
      salience: 0.5,
      recall_bias: 0.5,
      verification_bias: 0,
      unfinishedness_bias: 0,
      default_manifestation_preference: "lens_entry"
    },
    plasticity_state: {
      strength: 0.5,
      direction_bias: "bidirectional_asymmetric",
      stability_class: "stable",
      support_events_count: 1,
      contradiction_events_count: 0
    },
    lifecycle: {
      status: "active",
      retirement_rule: "manual"
    },
    legitimacy: {
      evidence_basis: ["evidence-1"],
      governance_class: "recall_allowed"
    },
    created_at: "2026-05-24T00:00:00.000Z",
    updated_at: "2026-05-24T00:00:00.000Z",
    ...overrides
  };
  pathRepo.create(relation);
}

export function objectId(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

export function createProposalInput(
  proposalId: string,
  sourceMemoryId: string,
  targetMemoryId: string,
  edgeType: EdgeProposal["edge_type"],
  createdAt = "2026-05-24T00:00:00.000Z"
) {
  return {
    proposal_id: proposalId,
    workspace_id: "workspace-1",
    source_memory_id: sourceMemoryId,
    target_memory_id: targetMemoryId,
    edge_type: edgeType,
    trigger_source: "recall_cross_link" as const,
    confidence: 0.5,
    reason: "test proposal",
    source_signal_id: null,
    run_id: "run-1",
    created_at: createdAt,
    expires_at: null
  };
}

export function createMemoryEntry(objectId: string): MemoryEntry {
  return {
    object_id: objectId,
    object_kind: "memory_entry",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: "2026-05-24T00:00:00.000Z",
    updated_at: "2026-05-24T00:00:00.000Z",
    created_by: "edge-proposal-test",
    dimension: MemoryDimension.PROCEDURE,
    source_kind: SourceKind.USER,
    formation_kind: FormationKind.EXPLICIT,
    scope_class: ScopeClass.PROJECT,
    content: `memory ${objectId}`,
    domain_tags: ["test"],
    evidence_refs: [],
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
    superseded_by: null
  };
}
