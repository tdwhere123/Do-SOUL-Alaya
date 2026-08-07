import { afterEach, describe, expect, it } from "vitest";
import {
  AnswersWithEdgeProducerService,
  type RelationAssertionAdmissionRequest
} from "@do-soul/alaya-core";
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
  initDatabase,
  SqliteMemoryEntryRepo,
  SqliteRunRepo,
  SqliteWorkspaceRepo,
  type StorageDatabase
} from "@do-soul/alaya-storage";

import { loadBackfillFormationObjects } from "../../runtime/daemon/support/path-formation-order.js";

const databases: StorageDatabase[] = [];

afterEach(() => {
  while (databases.length > 0) databases.pop()?.close();
});

describe("production backfill formation order", () => {
  it("keeps topology stable across UUID reminting and DB row permutation", async () => {
    const first = await runTopology({
      alpha: "10000000-0000-4000-8000-000000000001",
      beta: "20000000-0000-4000-8000-000000000002",
      gamma: "30000000-0000-4000-8000-000000000003",
      delta: "40000000-0000-4000-8000-000000000004"
    }, ["delta", "beta", "alpha", "gamma"]);
    const reminted = await runTopology({
      alpha: "f0000000-0000-4000-8000-000000000001",
      beta: "10000000-0000-4000-8000-000000000002",
      gamma: "e0000000-0000-4000-8000-000000000003",
      delta: "20000000-0000-4000-8000-000000000004"
    }, ["gamma", "alpha", "delta", "beta"]);

    expect(reminted.repoOrder).not.toEqual(first.repoOrder);
    expect(reminted.topology).toEqual(first.topology);
  });

  it("fails closed when persisted formation evidence is incomplete", async () => {
    const database = initDatabase({ filename: ":memory:" });
    databases.push(database);
    const workspaceRepo = new SqliteWorkspaceRepo(database);
    const runRepo = new SqliteRunRepo(database);
    const memoryRepo = new SqliteMemoryEntryRepo(database);
    await seedWorkspace(workspaceRepo, runRepo);
    const presentId = "10000000-0000-4000-8000-000000000001";
    await memoryRepo.create(memory(presentId, "present"));

    await expect(loadBackfillFormationObjects(
      memoryRepo,
      "workspace-1",
      [presentId, "20000000-0000-4000-8000-000000000002"]
    )).rejects.toThrow(/formation evidence/u);
  });

  it("does not abort edge formation for equivalent persisted memories", async () => {
    const database = initDatabase({ filename: ":memory:" });
    databases.push(database);
    const workspaceRepo = new SqliteWorkspaceRepo(database);
    const runRepo = new SqliteRunRepo(database);
    const memoryRepo = new SqliteMemoryEntryRepo(database);
    await seedWorkspace(workspaceRepo, runRepo);
    const objectIds = [
      "10000000-0000-4000-8000-000000000001",
      "20000000-0000-4000-8000-000000000002"
    ];
    for (const objectId of objectIds) await memoryRepo.create(memory(objectId, "same content"));
    const objects = await loadBackfillFormationObjects(memoryRepo, "workspace-1", objectIds);
    const calls: RelationAssertionAdmissionRequest[] = [];
    const producer = new AnswersWithEdgeProducerService({
      pairSource: { answerCoRelevantPairs: async () => completePairWitnesses(objectIds) },
      assertionPort: { admit: async (input) => admissionResult(calls, input) }
    });

    expect(new Set(objects.map((object) => object.formationKey)).size).toBe(1);
    await expect(producer.crystallize({
      workspaceId: "workspace-1",
      runId: "run-1",
      objects,
      bar: 1,
      capPerNode: 1,
      crossSessionOnly: false
    })).resolves.toMatchObject({ admitted: 1 });
    expect(calls).toHaveLength(1);
  });
});

async function runTopology(
  idsByContent: Readonly<Record<string, string>>,
  queryOrder: readonly string[]
) {
  const database = initDatabase({ filename: ":memory:" });
  databases.push(database);
  const workspaceRepo = new SqliteWorkspaceRepo(database);
  const runRepo = new SqliteRunRepo(database);
  const memoryRepo = new SqliteMemoryEntryRepo(database);
  await seedWorkspace(workspaceRepo, runRepo);
  for (const [content, objectId] of Object.entries(idsByContent)) {
    await memoryRepo.create(memory(objectId, content));
  }
  const objectIds = queryOrder.map((content) => idsByContent[content]!);
  const repoRows = await memoryRepo.findByIds("workspace-1", objectIds);
  const objects = await loadBackfillFormationObjects(memoryRepo, "workspace-1", objectIds);
  const calls: RelationAssertionAdmissionRequest[] = [];
  const producer = new AnswersWithEdgeProducerService({
    pairSource: { answerCoRelevantPairs: async ({ objectIds: ids }) => completePairWitnesses(ids) },
    assertionPort: { admit: async (input) => admissionResult(calls, input) }
  });
  await producer.crystallize({
    workspaceId: "workspace-1",
    runId: "run-1",
    objects,
    bar: 1,
    capPerNode: 1,
    crossSessionOnly: false
  });
  const contentById = new Map(Object.entries(idsByContent).map(([content, id]) => [id, content]));
  return {
    repoOrder: repoRows.map((row) => row.content),
    topology: calls.map((call) => {
      const source = call.anchors.source_anchor.kind === "object"
        ? call.anchors.source_anchor.object_id : "";
      const target = call.anchors.target_anchor.kind === "object"
        ? call.anchors.target_anchor.object_id : "";
      return `${contentById.get(source)}->${contentById.get(target)}`;
    })
  };
}

async function seedWorkspace(
  workspaceRepo: SqliteWorkspaceRepo,
  runRepo: SqliteRunRepo
): Promise<void> {
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
    title: "run",
    goal: null,
    run_mode: RunMode.CHAT,
    engine_binding_id: null,
    engine_class: null,
    run_state: RunState.IDLE,
    current_surface_id: null
  });
}

function memory(objectId: string, content: string): MemoryEntry {
  return {
    object_id: objectId,
    object_kind: "memory_entry",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: "2026-07-10T00:00:00.000Z",
    updated_at: "2026-07-10T00:00:00.000Z",
    created_by: "formation-order-test",
    dimension: MemoryDimension.FACT,
    source_kind: SourceKind.USER,
    formation_kind: FormationKind.EXPLICIT,
    scope_class: ScopeClass.PROJECT,
    content,
    domain_tags: [],
    evidence_refs: [],
    workspace_id: "workspace-1",
    run_id: "run-1",
    surface_id: "surface-1",
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

function completePairWitnesses(ids: readonly string[]) {
  const observedAt = "2026-07-10T00:00:00.000Z";
  const witnesses = [];
  for (let left = 0; left < ids.length; left += 1) {
    for (let right = left + 1; right < ids.length; right += 1) {
      const pair = [ids[left]!, ids[right]!] as const;
      witnesses.push({
        pair,
        evidenceReceipts: [{
          evidence_id: `evidence-${left}-${right}`,
          source_event_anchor: {
            event_type: "soul.signal.emitted",
            event_id: `event-${left}-${right}`,
            occurred_at: observedAt
          }
        }],
        formationReceipt: {
          operator_id: "formation_order_test_v1",
          operator_sha256: "a".repeat(64),
          parameters: { bar: 1 },
          parameter_sha256: "b".repeat(64),
          source_observations: [{
            source_kind: "memory_hq_observation",
            source_id: `hq-${left}-${right}`,
            source_sha256: "c".repeat(64)
          }],
          decision: { shared_token_count: 1 },
          decision_sha256: "d".repeat(64)
        },
        validFrom: observedAt
      });
    }
  }
  return witnesses;
}

function admissionResult(
  calls: RelationAssertionAdmissionRequest[],
  input: RelationAssertionAdmissionRequest
) {
  calls.push(input);
  return {
    status: "admitted" as const,
    assertion: {} as never,
    activeProjectionCount: 1,
    projectionGeneration: "test-generation"
  };
}
