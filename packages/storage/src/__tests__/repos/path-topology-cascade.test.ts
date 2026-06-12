import { afterEach, describe, expect, it } from "vitest";
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
  type MemoryEntry,
  type PathAnchorRef,
  type PathRelation
} from "@do-soul/alaya-protocol";
import { initDatabase, type StorageDatabase } from "../../sqlite/db.js";
import { SqliteCoUsageCounterRepo } from "../../repos/co-usage-counter-repo.js";
import { SqliteMemoryEntryRepo } from "../../repos/memory-entry/index.js";
import { SqlitePathRelationRepo } from "../../repos/path/path-relation-repo.js";
import { SqliteRunRepo } from "../../repos/run-repo.js";
import { SqliteWorkspaceRepo } from "../../repos/workspace-repo.js";

// invariant: hard-deleted memory ids must not remain reachable through path topology.
// see also: packages/storage/src/repos/path/cascade-delete.ts:pruneOrphanedPathTopology
// see also: packages/storage/src/repos/memory-entry/lifecycle-workflows.ts:hardDeleteTombstonedMemoryEntry
// see also: packages/core/src/path-graph/graph-contract-service.ts:derive

const DELETED_MEMORY_ID = "11111111-1111-4111-8111-111111111111";
const SURVIVING_MEMORY_ID = "22222222-2222-4222-8222-222222222222";

const databases = new Set<StorageDatabase>();

afterEach(() => {
  for (const database of databases) {
    database.close();
  }
  databases.clear();
});

describe("path topology cascade on memory hard-delete", () => {
  it("cascadeDeleteRun prunes path relations and co-usage counters for the run's memories", async () => {
    const ctx = await createContext();

    // Two memories under run-1; one survivor under run-2 referenced only by an
    // unrelated relation that must remain.
    await ctx.memoryRepo.create(memoryFixture({ object_id: DELETED_MEMORY_ID, run_id: "run-1" }));
    await ctx.memoryRepo.create(memoryFixture({ object_id: SURVIVING_MEMORY_ID, run_id: "run-2" }));

    // object→object_facet relation whose source backs on the deleted memory.
    ctx.pathRepo.create(
      pathRelationFixture("path-object", {
        source_anchor: { kind: "object", object_id: DELETED_MEMORY_ID },
        target_anchor: { kind: "object_facet", object_id: SURVIVING_MEMORY_ID, facet_key: "status" }
      })
    );
    // obligation relation whose TARGET source_object_id backs on the deleted
    // memory — proves the backing-id mapping covers non-object anchor kinds.
    ctx.pathRepo.create(
      pathRelationFixture("path-obligation", {
        source_anchor: { kind: "object", object_id: SURVIVING_MEMORY_ID },
        target_anchor: {
          kind: "obligation",
          source_object_id: DELETED_MEMORY_ID,
          obligation_digest: "digest-1"
        }
      })
    );
    // risk_concern relation: identical source_object_id backing path as
    // obligation. Closes the cascade matrix over every memory-backing kind.
    ctx.pathRepo.create(
      pathRelationFixture("path-risk-concern", {
        source_anchor: { kind: "object", object_id: SURVIVING_MEMORY_ID },
        target_anchor: {
          kind: "risk_concern",
          source_object_id: DELETED_MEMORY_ID,
          concern_digest: "risk-1"
        }
      })
    );
    // time_concern relation: same source_object_id backing path.
    ctx.pathRepo.create(
      pathRelationFixture("path-time-concern", {
        source_anchor: { kind: "object", object_id: SURVIVING_MEMORY_ID },
        target_anchor: {
          kind: "time_concern",
          source_object_id: DELETED_MEMORY_ID,
          window_digest: "window-1"
        }
      })
    );
    // relation referencing neither deleted memory — must survive.
    ctx.pathRepo.create(
      pathRelationFixture("path-survivor", {
        source_anchor: { kind: "object", object_id: SURVIVING_MEMORY_ID },
        target_anchor: { kind: "object", object_id: "33333333-3333-4333-8333-333333333333" }
      })
    );

    ctx.coUsageRepo.increment({
      workspaceId: "workspace-1",
      lowMemoryId: DELETED_MEMORY_ID,
      highMemoryId: SURVIVING_MEMORY_ID,
      seenAt: "2026-04-17T00:00:00.000Z"
    });
    ctx.coUsageRepo.increment({
      workspaceId: "workspace-1",
      lowMemoryId: SURVIVING_MEMORY_ID,
      highMemoryId: "33333333-3333-4333-8333-333333333333",
      seenAt: "2026-04-17T00:00:00.000Z"
    });

    await ctx.runRepo.delete("run-1");

    // No path relation surfaces for the deleted memory at either endpoint.
    await expect(
      ctx.pathRepo.findByAnchor("workspace-1", { kind: "object", object_id: DELETED_MEMORY_ID })
    ).resolves.toEqual([]);
    await expect(
      ctx.pathRepo.findByAnchor("workspace-1", {
        kind: "obligation",
        source_object_id: DELETED_MEMORY_ID,
        obligation_digest: "digest-1"
      })
    ).resolves.toEqual([]);
    await expect(
      ctx.pathRepo.findByAnchor("workspace-1", {
        kind: "risk_concern",
        source_object_id: DELETED_MEMORY_ID,
        concern_digest: "risk-1"
      })
    ).resolves.toEqual([]);
    await expect(
      ctx.pathRepo.findByAnchor("workspace-1", {
        kind: "time_concern",
        source_object_id: DELETED_MEMORY_ID,
        window_digest: "window-1"
      })
    ).resolves.toEqual([]);
    // The unrelated relation survives.
    expect((await ctx.pathRepo.findByWorkspace("workspace-1")).map((relation) => relation.path_id)).toEqual([
      "path-survivor"
    ]);
    // No graph node can form for the deleted memory: zero active relations name it.
    await expect(activeRelationCountForMemory(ctx.pathRepo, DELETED_MEMORY_ID)).resolves.toBe(0);
    // Co-usage counters touching the deleted memory are gone; the unrelated pair stays.
    expect(ctx.coUsageRepo.size()).toBe(1);
  });

  it("hardDeleteTombstoned prunes path relations and co-usage counters for the deleted memory", async () => {
    const ctx = await createContext();

    await ctx.memoryRepo.create(
      memoryFixture({
        object_id: DELETED_MEMORY_ID,
        run_id: "run-1",
        retention_state: "tombstoned"
      })
    );
    await ctx.memoryRepo.create(memoryFixture({ object_id: SURVIVING_MEMORY_ID, run_id: "run-2" }));

    ctx.pathRepo.create(
      pathRelationFixture("path-object", {
        source_anchor: { kind: "object", object_id: SURVIVING_MEMORY_ID },
        target_anchor: { kind: "object", object_id: DELETED_MEMORY_ID }
      })
    );
    ctx.pathRepo.create(
      pathRelationFixture("path-survivor", {
        source_anchor: { kind: "object", object_id: SURVIVING_MEMORY_ID },
        target_anchor: { kind: "object", object_id: "33333333-3333-4333-8333-333333333333" }
      })
    );

    ctx.coUsageRepo.increment({
      workspaceId: "workspace-1",
      lowMemoryId: DELETED_MEMORY_ID,
      highMemoryId: SURVIVING_MEMORY_ID,
      seenAt: "2026-04-17T00:00:00.000Z"
    });

    await expect(ctx.memoryRepo.hardDeleteTombstoned(DELETED_MEMORY_ID)).resolves.toBeUndefined();

    await expect(
      ctx.pathRepo.findByAnchor("workspace-1", { kind: "object", object_id: DELETED_MEMORY_ID })
    ).resolves.toEqual([]);
    expect((await ctx.pathRepo.findByWorkspace("workspace-1")).map((relation) => relation.path_id)).toEqual([
      "path-survivor"
    ]);
    expect(ctx.coUsageRepo.size()).toBe(0);
  });

  it("hardDeleteTombstoned leaves topology intact when the memory is not GC-eligible", async () => {
    const ctx = await createContext();

    // active (non-tombstoned) memory: hard-delete must be a no-op and must NOT
    // strip its live path relation or counter.
    await ctx.memoryRepo.create(memoryFixture({ object_id: DELETED_MEMORY_ID, run_id: "run-1" }));

    ctx.pathRepo.create(
      pathRelationFixture("path-object", {
        source_anchor: { kind: "object", object_id: DELETED_MEMORY_ID },
        target_anchor: { kind: "object", object_id: SURVIVING_MEMORY_ID }
      })
    );
    ctx.coUsageRepo.increment({
      workspaceId: "workspace-1",
      lowMemoryId: DELETED_MEMORY_ID,
      highMemoryId: SURVIVING_MEMORY_ID,
      seenAt: "2026-04-17T00:00:00.000Z"
    });

    await expect(ctx.memoryRepo.hardDeleteTombstoned(DELETED_MEMORY_ID)).rejects.toMatchObject({
      code: "NOT_FOUND"
    });

    expect((await ctx.pathRepo.findByWorkspace("workspace-1")).map((relation) => relation.path_id)).toEqual([
      "path-object"
    ]);
    expect(ctx.coUsageRepo.size()).toBe(1);
  });
});

async function activeRelationCountForMemory(
  pathRepo: SqlitePathRelationRepo,
  memoryId: string
): Promise<number> {
  const active = await pathRepo.findActive("workspace-1");
  return active.filter(
    (relation) =>
      backingObjectId(relation.anchors.source_anchor) === memoryId ||
      backingObjectId(relation.anchors.target_anchor) === memoryId
  ).length;
}

function backingObjectId(anchor: PathAnchorRef): string | undefined {
  switch (anchor.kind) {
    case "object":
    case "object_facet":
      return anchor.object_id;
    case "obligation":
    case "risk_concern":
    case "time_concern":
      return anchor.source_object_id;
    default:
      return undefined;
  }
}

interface CascadeTestContext {
  readonly database: StorageDatabase;
  readonly memoryRepo: SqliteMemoryEntryRepo;
  readonly pathRepo: SqlitePathRelationRepo;
  readonly coUsageRepo: SqliteCoUsageCounterRepo;
  readonly runRepo: SqliteRunRepo;
}

async function createContext(): Promise<CascadeTestContext> {
  const database = initDatabase({ filename: ":memory:" });
  databases.add(database);

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

  return {
    database,
    memoryRepo: new SqliteMemoryEntryRepo(database),
    pathRepo: new SqlitePathRelationRepo(database),
    coUsageRepo: new SqliteCoUsageCounterRepo(database),
    runRepo
  };
}

function memoryFixture(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    object_id: DELETED_MEMORY_ID,
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
    domain_tags: ["tooling"],
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

function pathRelationFixture(
  pathId: string,
  anchors: { source_anchor: PathAnchorRef; target_anchor: PathAnchorRef }
): PathRelation {
  return {
    path_id: pathId,
    workspace_id: "workspace-1",
    anchors,
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
      last_reinforced_at: "2026-04-17T00:00:00.000Z"
    },
    lifecycle: {
      retirement_rule: "retire_after_cooldown",
      cooldown_rule: "7d_without_support"
    },
    legitimacy: {
      evidence_basis: ["evidence-1"],
      governance_class: "hint_only"
    },
    created_at: "2026-04-17T00:00:00.000Z",
    updated_at: "2026-04-17T00:00:00.000Z"
  };
}
