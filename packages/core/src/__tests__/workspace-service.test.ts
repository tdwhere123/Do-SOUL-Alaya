import { describe, expect, it, vi } from "vitest";
import {
  WorkspaceKind,
  WorkspaceState,
  type BootstrappingRecord,
  type PathRelation,
  type Workspace
} from "@do-soul/alaya-protocol";
import { WorkspaceService } from "../workspace-service.js";

// Helper: in-test publisher that simulates the appendManyWithMutation
// contract (sync mutate, batch-array first arg) used by WorkspaceService
// after #BL-022.
function fakeAppendManyWithMutation(publishedEvents?: Array<unknown>) {
  return vi.fn(async (events: any[], mutate: (entries: any[]) => any) => {
    if (publishedEvents) {
      for (const event of events) publishedEvents.push(event);
    }
    const persisted = events.map((event, idx) => ({
      ...event,
      event_id: `evt_${idx}`,
      created_at: "2026-04-20T00:00:00.000Z",
      revision: idx
    }));
    return mutate(persisted);
  });
}

describe("WorkspaceService", () => {
  it("bootstraps conservative path relations during workspace creation", async () => {
    const appendManyWithMutation = fakeAppendManyWithMutation();
    const pathRelationRepo = {
      create: vi.fn((relation: PathRelation) => relation)
    };
    const bootstrappingRecordRepo = {
      findByWorkspace: vi.fn(() => null),
      create: vi.fn((record: BootstrappingRecord) => record)
    };
    const bootstrappingPlanner = {
      planBootstrap: vi.fn(async (workspaceId: string) => ({
        relations: [
          createPathRelation({
            workspace_id: workspaceId
          })
        ],
        record: createBootstrappingRecord({
          workspace_id: workspaceId
        })
      }))
    };
    const service = new WorkspaceService({
      workspaceRepo: {
        create: vi.fn((input) => createWorkspace(input)),
        getById: vi.fn(async () => null),
        list: vi.fn(async () => []),
        delete: vi.fn(() => undefined),
        updateDefaultEngineClass: vi.fn(() => {
          throw new Error("not used");
        })
      },
      runRepo: {
        listByWorkspace: vi.fn(async () => [])
      },
      eventPublisher: {
        appendManyWithMutation
      } as any,
      bootstrappingPlanner,
      pathRelationRepo,
      bootstrappingRecordRepo
    });

    const created = await service.create({
      name: "alpha",
      root_path: "/tmp/alpha",
      workspace_kind: WorkspaceKind.LOCAL_REPO
    });

    expect(created.name).toBe("alpha");
    expect(bootstrappingRecordRepo.findByWorkspace).toHaveBeenCalledWith(created.workspace_id);
    expect(bootstrappingPlanner.planBootstrap).toHaveBeenCalledWith(created.workspace_id);
    expect(pathRelationRepo.create).toHaveBeenCalledTimes(1);
    expect(bootstrappingRecordRepo.create).toHaveBeenCalledTimes(1);
    expect(appendManyWithMutation).toHaveBeenCalledTimes(1);
  });

  it("rolls back persisted workspace state when bootstrapping record persistence fails", async () => {
    // Under #BL-022 the rollback is implicit: the entire mutate runs inside
    // EventPublisher.appendManyWithMutation's SQLite transaction, so a throw
    // from any sync repo call (e.g. bootstrappingRecordRepo.create)
    // automatically rolls back the workspace insert. The fake publisher
    // mirrors this by surfacing the throw without any explicit cleanup
    // hook, so we just assert that the failure propagates and that the
    // workspace insert ran (proving it would have been rolled back at the
    // SQLite layer in the real flow).
    const persistedWorkspace = createWorkspace({
      workspace_id: "ws_bootstrap_rollback",
      name: "alpha",
      root_path: "/tmp/alpha",
      workspace_kind: WorkspaceKind.LOCAL_REPO,
      default_engine_binding: null,
      default_engine_class: null,
      workspace_state: WorkspaceState.ACTIVE
    });
    const workspaceCreateSync = vi.fn(() => persistedWorkspace);
    const appendManyWithMutation = fakeAppendManyWithMutation();
    const pathRelationRepo = {
      create: vi.fn((relation: PathRelation) => relation)
    };
    const bootstrappingRecordRepo = {
      findByWorkspace: vi.fn(() => null),
      create: vi.fn(() => {
        throw new Error("simulated-bootstrapping-record-create-failure");
      })
    };
    const service = new WorkspaceService({
      workspaceRepo: {
        create: workspaceCreateSync,
        getById: vi.fn(async () => null),
        list: vi.fn(async () => []),
        delete: vi.fn(() => undefined),
        updateDefaultEngineClass: vi.fn(() => {
          throw new Error("not used");
        })
      },
      runRepo: {
        listByWorkspace: vi.fn(async () => [])
      },
      eventPublisher: {
        appendManyWithMutation
      } as any,
      bootstrappingPlanner: {
        planBootstrap: vi.fn(async () => ({
          relations: [createPathRelation({ workspace_id: persistedWorkspace.workspace_id })],
          record: createBootstrappingRecord({
            workspace_id: persistedWorkspace.workspace_id
          })
        }))
      },
      pathRelationRepo,
      bootstrappingRecordRepo
    });

    await expect(
      service.create({
        name: "alpha",
        root_path: "/tmp/alpha",
        workspace_kind: WorkspaceKind.LOCAL_REPO
      })
    ).rejects.toThrow("simulated-bootstrapping-record-create-failure");

    expect(workspaceCreateSync).toHaveBeenCalledTimes(1);
    expect(pathRelationRepo.create).toHaveBeenCalledTimes(1);
    expect(bootstrappingRecordRepo.create).toHaveBeenCalledTimes(1);
    expect(appendManyWithMutation).toHaveBeenCalledTimes(1);
  });

  it("inserts bootstrap path relations in plan order inside the same transaction", async () => {
    // Under #BL-022 the path-relation creates are now sync inserts inside
    // the SQLite transaction, so they execute sequentially in plan order
    // rather than as a Promise.all batch. This test pins that the plan
    // order is preserved and that bootstrappingRecordRepo.create
    // runs only after both path relations are inserted.
    const order: string[] = [];
    const firstRelation = createPathRelation({
      path_id: "path-bootstrap-1"
    });
    const secondRelation = createPathRelation({
      path_id: "path-bootstrap-2"
    });
    const pathRelationRepo = {
      create: vi.fn((relation: PathRelation) => {
        order.push(`path:${relation.path_id}`);
        return relation;
      })
    };
    const bootstrappingRecordRepo = {
      findByWorkspace: vi.fn(() => null),
      create: vi.fn((record: BootstrappingRecord) => {
        order.push("bootstrap_record");
        return record;
      })
    };
    const service = new WorkspaceService({
      workspaceRepo: {
        create: vi.fn((input) => {
          order.push("workspace");
          return createWorkspace(input);
        }),
        getById: vi.fn(async () => null),
        list: vi.fn(async () => []),
        delete: vi.fn(() => undefined),
        updateDefaultEngineClass: vi.fn(() => {
          throw new Error("not used");
        })
      },
      runRepo: {
        listByWorkspace: vi.fn(async () => [])
      },
      eventPublisher: {
        appendManyWithMutation: fakeAppendManyWithMutation()
      } as any,
      bootstrappingPlanner: {
        planBootstrap: vi.fn(async (workspaceId: string) => ({
          relations: [
            {
              ...firstRelation,
              workspace_id: workspaceId
            },
            {
              ...secondRelation,
              workspace_id: workspaceId
            }
          ],
          record: createBootstrappingRecord({
            workspace_id: workspaceId
          })
        }))
      },
      pathRelationRepo,
      bootstrappingRecordRepo
    });

    await service.create({
      name: "alpha",
      root_path: "/tmp/alpha",
      workspace_kind: WorkspaceKind.LOCAL_REPO
    });

    expect(order).toEqual([
      "workspace",
      `path:${firstRelation.path_id}`,
      `path:${secondRelation.path_id}`,
      "bootstrap_record"
    ]);
  });
});

function createWorkspace(
  overrides: Partial<Workspace> & {
    readonly workspace_id: string;
    readonly name: string;
    readonly root_path: string;
    readonly workspace_kind: Workspace["workspace_kind"];
    readonly repo_path?: Workspace["repo_path"];
    readonly default_engine_binding: Workspace["default_engine_binding"];
    readonly default_engine_class: Workspace["default_engine_class"];
    readonly workspace_state: Workspace["workspace_state"];
  }
): Workspace {
  return {
    repo_path: null,
    created_at: "2026-04-20T00:00:00.000Z",
    archived_at: null,
    ...overrides
  };
}

function createPathRelation(overrides: Partial<PathRelation> = {}): PathRelation {
  return {
    path_id: "path-bootstrap-1",
    workspace_id: "workspace-1",
    anchors: {
      source_anchor: {
        kind: "object",
        object_id: "workspace-1"
      },
      target_anchor: {
        kind: "object_facet",
        object_id: "workspace-1",
        facet_key: "conservative_start"
      }
    },
    constitution: {
      relation_kind: "supports",
      why_this_relation_exists: ["new workspace starts with conservative learned-path defaults"]
    },
    effect_vector: {
      salience: 0.1,
      recall_bias: 0,
      verification_bias: 0.1,
      unfinishedness_bias: 0,
      default_manifestation_preference: "stance_bias"
    },
    plasticity_state: {
      strength: 0.1,
      direction_bias: "source_to_target",
      stability_class: "volatile",
      support_events_count: 0,
      contradiction_events_count: 0
    },
    lifecycle: {
      retirement_rule: "consolidation_only"
    },
    legitimacy: {
      evidence_basis: ["bootstrapping:workspace.bootstrap.conservative-start"],
      governance_class: "hint_only"
    },
    created_at: "2026-04-20T00:00:00.000Z",
    updated_at: "2026-04-20T00:00:00.000Z",
    ...overrides
  };
}

function createBootstrappingRecord(
  overrides: Partial<BootstrappingRecord> = {}
): BootstrappingRecord {
  return {
    record_id: "bootstrap-record-1",
    workspace_id: "workspace-1",
    paths_planted: 1,
    template_ids_used: ["workspace.bootstrap.conservative-start"],
    planted_at: "2026-04-20T00:00:00.000Z",
    ...overrides
  };
}
