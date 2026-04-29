import { describe, expect, it, vi } from "vitest";
import {
  WorkspaceKind,
  WorkspaceState,
  type BootstrappingRecord,
  type PathRelation,
  type Workspace
} from "@do-soul/alaya-protocol";
import { WorkspaceService } from "../workspace-service.js";

describe("WorkspaceService", () => {
  it("bootstraps conservative path relations during workspace creation", async () => {
    const publishManyWithMutation = vi.fn(
      async (_events: readonly unknown[], mutate: () => Promise<Workspace>) => await mutate()
    );
    const pathRelationRepo = {
      create: vi.fn(async (relation: PathRelation) => relation)
    };
    const bootstrappingRecordRepo = {
      findByWorkspace: vi.fn(async () => null),
      create: vi.fn(async (record: BootstrappingRecord) => record)
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
        create: vi.fn(async (input) => createWorkspace(input)),
        getById: vi.fn(async () => null),
        list: vi.fn(async () => []),
        delete: vi.fn(async () => undefined),
        updateDefaultEngineClass: vi.fn(async () => {
          throw new Error("not used");
        })
      },
      runRepo: {
        listByWorkspace: vi.fn(async () => [])
      },
      eventPublisher: {
        publishWithMutation: vi.fn(),
        publishManyWithMutation
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
    expect(publishManyWithMutation).toHaveBeenCalledTimes(1);
  });

  it("rolls back persisted workspace state when bootstrapping record persistence fails", async () => {
    const persistedWorkspace = createWorkspace({
      workspace_id: "ws_bootstrap_rollback",
      name: "alpha",
      root_path: "/tmp/alpha",
      workspace_kind: WorkspaceKind.LOCAL_REPO,
      default_engine_binding: null,
      default_engine_class: null,
      workspace_state: WorkspaceState.ACTIVE
    });
    const workspaceRepoDelete = vi.fn(async () => undefined);
    const publishManyWithMutation = vi.fn(
      async (_events: readonly unknown[], mutate: () => Promise<Workspace>) => await mutate()
    );
    const pathRelationRepo = {
      create: vi.fn(async (relation: PathRelation) => relation)
    };
    const bootstrappingRecordRepo = {
      findByWorkspace: vi.fn(async () => null),
      create: vi.fn(async () => {
        throw new Error("simulated-bootstrapping-record-create-failure");
      })
    };
    const service = new WorkspaceService({
      workspaceRepo: {
        create: vi.fn(async () => persistedWorkspace),
        getById: vi.fn(async () => null),
        list: vi.fn(async () => []),
        delete: workspaceRepoDelete,
        updateDefaultEngineClass: vi.fn(async () => {
          throw new Error("not used");
        })
      },
      runRepo: {
        listByWorkspace: vi.fn(async () => [])
      },
      eventPublisher: {
        publishWithMutation: vi.fn(),
        publishManyWithMutation
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

    expect(pathRelationRepo.create).toHaveBeenCalledTimes(1);
    expect(bootstrappingRecordRepo.create).toHaveBeenCalledTimes(1);
    expect(workspaceRepoDelete).toHaveBeenCalledWith(persistedWorkspace.workspace_id);
    expect(publishManyWithMutation).toHaveBeenCalledTimes(1);
  });

  it("starts bootstrap path relation inserts without serial awaits", async () => {
    const publishManyWithMutation = vi.fn(
      async (_events: readonly unknown[], mutate: () => Promise<Workspace>) => await mutate()
    );
    const firstInsert = createDeferred<PathRelation>();
    const secondInsert = createDeferred<PathRelation>();
    const firstRelation = createPathRelation({
      path_id: "path-bootstrap-1"
    });
    const secondRelation = createPathRelation({
      path_id: "path-bootstrap-2"
    });
    const pathRelationRepo = {
      create: vi.fn((relation: PathRelation) => {
        if (relation.path_id === firstRelation.path_id) {
          return firstInsert.promise;
        }

        return secondInsert.promise;
      })
    };
    const bootstrappingRecordRepo = {
      findByWorkspace: vi.fn(async () => null),
      create: vi.fn(async (record: BootstrappingRecord) => record)
    };
    const service = new WorkspaceService({
      workspaceRepo: {
        create: vi.fn(async (input) => createWorkspace(input)),
        getById: vi.fn(async () => null),
        list: vi.fn(async () => []),
        delete: vi.fn(async () => undefined),
        updateDefaultEngineClass: vi.fn(async () => {
          throw new Error("not used");
        })
      },
      runRepo: {
        listByWorkspace: vi.fn(async () => [])
      },
      eventPublisher: {
        publishWithMutation: vi.fn(),
        publishManyWithMutation
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

    const createPromise = service.create({
      name: "alpha",
      root_path: "/tmp/alpha",
      workspace_kind: WorkspaceKind.LOCAL_REPO
    });

    await vi.waitFor(() => {
      expect(pathRelationRepo.create).toHaveBeenCalledTimes(2);
    });

    expect(pathRelationRepo.create).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ path_id: firstRelation.path_id })
    );
    expect(pathRelationRepo.create).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ path_id: secondRelation.path_id })
    );
    expect(bootstrappingRecordRepo.create).not.toHaveBeenCalled();

    firstInsert.resolve(firstRelation);
    await Promise.resolve();
    expect(bootstrappingRecordRepo.create).not.toHaveBeenCalled();

    secondInsert.resolve(secondRelation);
    await createPromise;

    expect(bootstrappingRecordRepo.create).toHaveBeenCalledTimes(1);
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

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });

  return {
    promise,
    resolve
  };
}
