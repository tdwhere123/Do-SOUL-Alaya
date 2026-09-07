import { afterEach, describe, expect, it } from "vitest";
import {
  canonicalGovernanceSubject,
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
  type ClaimForm,
  type PathRelation
} from "@do-soul/alaya-protocol";
import { initDatabase, type StorageDatabase } from "../../../../sqlite/db.js";
import { findActiveConstraints } from "../../../../repos/governance/reads/active-constraints.js";
import { readBoundedActiveConstraints } from "../../../../repos/governance/reads/bounded-active-constraints.js";
import { SqliteGovernancePathReader } from "../../../../repos/path/reads/governance-path-reader.js";
import { SqliteClaimFormRepo } from "../../../../repos/governance/claim-form-repo.js";
import { SqliteMemoryEntryRepo } from "../../../../repos/memory-entry/index.js";
import { SqlitePathRelationRepo } from "../../../../repos/path/path-relation-repo.js";
import { SqliteRunRepo } from "../../../../repos/runtime/run-repo.js";
import { SqliteWorkspaceRepo } from "../../../../repos/runtime/workspace-repo.js";

const databases = new Set<StorageDatabase>();

const boundedRequest = {
  workspaceId: "workspace-1", asOf: "2026-05-19T00:00:00.000Z", snapshotId: "snapshot-1",
  cap: 20, nativeLimit: 128, byteLimit: 65536
};

describe("bounded active constraints snapshot", () => {
  it("filters global bodies and totals before hydration under project authorization", async () => {
    const { database, memoryRepo, claimFormRepo } = await createRepos();
    const project = createMemoryEntry();
    const globalId = "10000000-0000-4000-8000-000000000003";
    await memoryRepo.create(project);
    await memoryRepo.create(createMemoryEntry({ object_id: globalId, scope_class: "global_core", content: "secret ".repeat(3000) }));
    claimFormRepo.create(createActiveClaim({ source_object_refs: [project.object_id, globalId] }));
    const result = readBounded(database, { authorizedScopes: ["project", "project"] });
    expect(result).toMatchObject({ total_count: 1, completeness: "complete", binding: { authorized_scopes: ["project"] } });
    expect(result.constraints.map((row) => row.object_id)).toEqual([project.object_id]);
    expect(result.work.bytes_read).toBeLessThan(10000);
    expect(readBounded(database, { authorizedScopes: ["global_domain"] })).toMatchObject({
      constraints: [], total_count: 0, completeness: "complete", binding: { authorized_scopes: ["global_domain"] }
    });
    expect(readBounded(database).completeness).toBe("incomplete");
  });
  it("deduplicates real claim and strict path membership independently of relevance", async () => {
    const { database, memoryRepo, claimFormRepo, pathRelationRepo } = await createRepos();
    const memory = createMemoryEntry();
    await memoryRepo.create(memory);
    claimFormRepo.create(createActiveClaim());
    pathRelationRepo.create(createPathRelation({ legitimacy: {
      evidence_basis: ["evidence-1"], governance_class: PathGovernanceClass.STRICTLY_GOVERNED
    } }));
    const result = readBounded(database);
    expect(result).toMatchObject({ total_count: 1, completeness: "complete", temporal_uncertain: false });
    expect(result.constraints).toEqual([expect.objectContaining({
      object_id: memory.object_id, content: memory.content,
      governance_state: { claim_status: "active", governance_class: "strictly_governed", source_channels: ["claim_status", "path_relation"] }
    })]);
    expect(result.work.native_visits).toBeLessThanOrEqual(boundedRequest.nativeLimit);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(boundedRequest.byteLimit);
  });

  it("excludes inactive, foreign and future state while distinguishing historical uncertainty", async () => {
    const { database, memoryRepo, claimFormRepo, pathRelationRepo } = await createRepos();
    await memoryRepo.create(createMemoryEntry());
    claimFormRepo.create(createActiveClaim({ claim_status: "archived" }));
    pathRelationRepo.create(createPathRelation({
      lifecycle: { status: "retired", retirement_rule: "retired" },
      legitimacy: { evidence_basis: ["evidence-1"], governance_class: PathGovernanceClass.STRICTLY_GOVERNED }
    }));
    expect(readBounded(database)).toMatchObject({ constraints: [], total_count: 0, completeness: "complete" });
    claimFormRepo.create(createActiveClaim({ object_id: "590b6f34-7ea5-4f9b-ae74-fe8d4f5af96b", workspace_id: "workspace-elsewhere" }));
    expect(readBounded(database).total_count).toBe(0);
    claimFormRepo.create(createActiveClaim({ object_id: "590b6f34-7ea5-4f9b-ae74-fe8d4f5af96c", updated_at: "2026-05-20T00:00:00.000Z" }));
    expect(readBounded(database)).toMatchObject({ constraints: [], total_count: null, completeness: "incomplete", temporal_uncertain: true });
  });

  it("does not pretend a bounded claim prefix is an exact total", async () => {
    const { database, claimFormRepo } = await createRepos();
    for (let i = 0; i < 40; i += 1) claimFormRepo.create(createActiveClaim({ object_id: `590b6f34-7ea5-4f9b-ae74-${i.toString().padStart(12, "0")}` }));
    const result = readBounded(database, { nativeLimit: 12 });
    expect(result.total_count).toBeNull();
    expect(result.completeness).toBe("incomplete");
    expect(result.work.native_visits).toBeLessThanOrEqual(12);
  });

  it("refuses oversized source-ref hydration within a small byte budget", async () => {
    const { database, claimFormRepo } = await createRepos();
    claimFormRepo.create(createActiveClaim({ source_object_refs: ["x".repeat(10000)] }));
    const result = readBounded(database, { byteLimit: 2048 });
    expect(result).toMatchObject({ constraints: [], total_count: null, completeness: "incomplete" });
    expect(result.work.bytes_read).toBeLessThan(2048);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(2048);
  });

  it("reports the uncapped known count when cap is zero", async () => {
    const { database, memoryRepo, claimFormRepo } = await createRepos();
    await memoryRepo.create(createMemoryEntry());
    claimFormRepo.create(createActiveClaim());
    expect(readBounded(database, { cap: 0 })).toMatchObject({ constraints: [], total_count: 1, completeness: "complete" });
  });
});

function readBounded(database: StorageDatabase, overrides: Partial<typeof boundedRequest> & { authorizedScopes?: readonly string[] } = {}) {
  const paths = new SqliteGovernancePathReader(database);
  paths.prepareIndex();
  return readBoundedActiveConstraints(database, { ...boundedRequest, ...overrides }, (input) => paths.read(input));
}

function createActiveClaim(overrides: Partial<ClaimForm> = {}): ClaimForm {
  return {
    object_id: "590b6f34-7ea5-4f9b-ae74-fe8d4f5af96a", object_kind: "claim_form", schema_version: 1,
    lifecycle_state: "active", created_at: "2026-05-18T00:00:00.000Z", updated_at: "2026-05-18T00:00:00.000Z",
    created_by: "user", governance_subject: canonicalGovernanceSubject("tooling", { manager: "pnpm" }),
    claim_kind: "constraint", scope_class: "project", enforcement_level: "strict", origin_tier: "user_explicit",
    precedence_basis: "authority", proposition_digest: "Use pnpm", evidence_refs: ["evidence-1"],
    source_object_refs: ["10000000-0000-4000-8000-000000000001"], workspace_id: "workspace-1", claim_status: "active",
    ...overrides
  };
}

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
  readonly database: StorageDatabase;
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
    database,
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
