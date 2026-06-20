import { afterEach, describe, expect, it } from "vitest";
import {
  FormationKind,
  MemoryDimension,
  PathGovernanceClass,
  RunMode,
  RunState,
  ScopeClass,
  SourceKind,
  StorageTier,
  WorkspaceKind,
  WorkspaceState,
  type MemoryEntry,
  type PathRelation
} from "@do-soul/alaya-protocol";
import { initDatabase, type StorageDatabase } from "../../../sqlite/db.js";
import { findActiveConstraints } from "../../../repos/governance/active-constraints.js";
import { SqliteClaimFormRepo } from "../../../repos/governance/claim-form-repo.js";
import { SqliteMemoryEntryRepo } from "../../../repos/memory-entry/index.js";
import { SqlitePathRelationRepo } from "../../../repos/path/path-relation-repo.js";
import { SqliteRunRepo } from "../../../repos/runtime/run-repo.js";
import { SqliteWorkspaceRepo } from "../../../repos/runtime/workspace-repo.js";

const databases = new Set<StorageDatabase>();

afterEach(() => {
  for (const database of databases) {
    database.close();
  }
  databases.clear();
});

describe("findActiveConstraints", () => {
  it("reads full active path history before applying the output cap", async () => {
    const { memoryRepo, claimFormRepo, pathRelationRepo } = await createRepos();
    const strictMemoryId = "10000000-0000-4000-8000-000000009999";

    for (let index = 0; index < 500; index += 1) {
      const timestamp = new Date(Date.UTC(2026, 4, 18, 1, 0, index)).toISOString();
      await pathRelationRepo.create(createPathRelation({
        path_id: `hint-path-${index}`,
        anchors: {
          source_anchor: { kind: "object", object_id: `missing-hint-${index}` },
          target_anchor: { kind: "object", object_id: `missing-target-${index}` }
        },
        created_at: timestamp,
        updated_at: timestamp
      }));
    }

    await memoryRepo.create(createMemoryEntry({
      object_id: strictMemoryId,
      dimension: MemoryDimension.FACT,
      content: "Strict path candidate beyond the default active page.",
      created_at: "2026-05-18T01:10:00.000Z",
      updated_at: "2026-05-18T01:10:00.000Z"
    }));
    await pathRelationRepo.create(createPathRelation({
      path_id: "strict-path-after-default-cap",
      anchors: {
        source_anchor: { kind: "object", object_id: strictMemoryId },
        target_anchor: { kind: "object", object_id: "missing-strict-target" }
      },
      legitimacy: {
        evidence_basis: ["evidence-1"],
        governance_class: PathGovernanceClass.STRICTLY_GOVERNED
      },
      created_at: "2026-05-18T01:10:00.000Z",
      updated_at: "2026-05-18T01:10:00.000Z"
    }));

    const result = await findActiveConstraints({
      workspaceId: "workspace-1",
      memoryRepo,
      claimFormRepo,
      pathRelationRepo,
      cap: 1
    });

    expect(result.total_count).toBe(1);
    expect(result.constraints).toHaveLength(1);
    expect(result.constraints[0]?.memory.object_id).toBe(strictMemoryId);
    expect(result.constraints[0]?.source_channels).toEqual(["path_relation"]);
  });
});

async function createRepos(): Promise<{
  readonly memoryRepo: SqliteMemoryEntryRepo;
  readonly claimFormRepo: SqliteClaimFormRepo;
  readonly pathRelationRepo: SqlitePathRelationRepo;
}> {
  const database = initDatabase({ filename: ":memory:" });
  databases.add(database);
  await new SqliteWorkspaceRepo(database).create({
    workspace_id: "workspace-1",
    name: "workspace one",
    root_path: "/tmp/workspace-1",
    workspace_kind: WorkspaceKind.LOCAL_REPO,
    default_engine_binding: null,
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
  return {
    memoryRepo: new SqliteMemoryEntryRepo(database),
    claimFormRepo: new SqliteClaimFormRepo(database),
    pathRelationRepo: new SqlitePathRelationRepo(database)
  };
}

function createMemoryEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    object_id: "10000000-0000-4000-8000-000000000001",
    object_kind: "memory_entry",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: "2026-05-18T00:00:00.000Z",
    updated_at: "2026-05-18T00:00:00.000Z",
    created_by: "user_action",
    dimension: MemoryDimension.PREFERENCE,
    source_kind: SourceKind.USER,
    formation_kind: FormationKind.EXPLICIT,
    scope_class: ScopeClass.PROJECT,
    content: "Use pnpm for workspace commands.",
    domain_tags: ["workflow"],
    evidence_refs: ["evidence-1"],
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
    ...overrides
  };
}

function createPathRelation(overrides: Partial<PathRelation> = {}): PathRelation {
  return {
    path_id: "path-1",
    workspace_id: "workspace-1",
    anchors: {
      source_anchor: { kind: "object", object_id: "10000000-0000-4000-8000-000000000001" },
      target_anchor: { kind: "object", object_id: "10000000-0000-4000-8000-000000000002" }
    },
    constitution: {
      relation_kind: "supports",
      why_this_relation_exists: ["evidence_alignment"]
    },
    effect_vector: {
      salience: 0.4,
      recall_bias: 0.5,
      verification_bias: 0.2,
      unfinishedness_bias: 0.1,
      default_manifestation_preference: "stance_bias"
    },
    plasticity_state: {
      strength: 0.5,
      direction_bias: "source_to_target",
      stability_class: "volatile",
      support_events_count: 2,
      contradiction_events_count: 0,
      last_reinforced_at: "2026-05-18T00:00:00.000Z"
    },
    lifecycle: {
      status: "active",
      retirement_rule: "retire_after_cooldown",
      cooldown_rule: "7d_without_support"
    },
    legitimacy: {
      evidence_basis: ["evidence-1"],
      governance_class: PathGovernanceClass.HINT_ONLY
    },
    created_at: "2026-05-18T00:00:00.000Z",
    updated_at: "2026-05-18T00:00:00.000Z",
    ...overrides
  };
}
