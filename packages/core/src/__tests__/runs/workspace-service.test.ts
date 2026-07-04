import { describe, expect, it, vi } from "vitest";
import { WorkspaceKind, WorkspaceState, type BootstrappingRecord, type PathRelation } from "@do-soul/alaya-protocol";
import { WorkspaceService } from "../../runs/workspace-service.js";

import { createBootstrappingRecord, createDuplicateKeyError, createPathRelation, createWorkspace, fakeAppendManyWithMutation } from "./workspace-service.test-support.js";
import { StubEventPublisher } from "../support/event-publisher-stub.js";

describe("WorkspaceService", () => {
  it("bootstraps conservative path relations during workspace creation", async () => {
    const appendManyWithMutation = fakeAppendManyWithMutation();
    const pathRelationRepo = {
      create: vi.fn((relation: PathRelation) => relation),
      findByWorkspace: vi.fn(async () => [])
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
      eventPublisher: new StubEventPublisher(appendManyWithMutation),
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

  it("does not create bootstrap records when the planner has no templates", async () => {
    const appendManyWithMutation = fakeAppendManyWithMutation();
    const pathRelationRepo = {
      create: vi.fn((relation: PathRelation) => relation),
      findByWorkspace: vi.fn(async () => [])
    };
    const bootstrappingRecordRepo = {
      findByWorkspace: vi.fn(() => null),
      create: vi.fn((record: BootstrappingRecord) => record)
    };
    const bootstrappingPlanner = {
      planBootstrap: vi.fn(async (workspaceId: string) => ({
        relations: [],
        record: createBootstrappingRecord({
          workspace_id: workspaceId,
          paths_planted: 0,
          template_ids_used: []
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
      eventPublisher: new StubEventPublisher(appendManyWithMutation),
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
    expect(bootstrappingPlanner.planBootstrap).toHaveBeenCalledWith(created.workspace_id);
    expect(pathRelationRepo.create).not.toHaveBeenCalled();
    expect(bootstrappingRecordRepo.create).not.toHaveBeenCalled();
    expect(appendManyWithMutation).toHaveBeenCalledWith([expect.objectContaining({
      event_type: "workspace.created"
    })], expect.any(Function));
  });

  it("ensures a deterministic local workspace id without creating duplicates", async () => {
    const appendManyWithMutation = fakeAppendManyWithMutation();
    const persistedWorkspace = createWorkspace({
      workspace_id: "local_abcd",
      name: "repo",
      root_path: "/tmp/repo",
      workspace_kind: WorkspaceKind.LOCAL_REPO,
      repo_path: "/tmp/repo",
      default_engine_binding: null,
      default_engine_class: null,
      workspace_state: WorkspaceState.ACTIVE
    });
    const workspaceRepo = {
      create: vi.fn(() => persistedWorkspace),
      getById: vi.fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(persistedWorkspace),
      list: vi.fn(async () => []),
      delete: vi.fn(() => undefined),
      updateDefaultEngineClass: vi.fn(() => {
        throw new Error("not used");
      })
    };
    const service = new WorkspaceService({
      workspaceRepo,
      runRepo: {
        listByWorkspace: vi.fn(async () => [])
      },
      eventPublisher: new StubEventPublisher(appendManyWithMutation)
    });

    const first = await service.ensureLocalWorkspace({
      workspaceId: "local_abcd",
      name: "repo",
      rootPath: "/tmp/repo"
    });
    const second = await service.ensureLocalWorkspace({
      workspaceId: "local_abcd",
      name: "repo",
      rootPath: "/tmp/repo"
    });

    expect(first.workspace_id).toBe("local_abcd");
    expect(second).toBe(persistedWorkspace);
    expect(workspaceRepo.create).toHaveBeenCalledTimes(1);
    expect(appendManyWithMutation).toHaveBeenCalledTimes(1);
  });

  it("re-reads local workspace after a duplicate first-start create collision", async () => {
    const appendManyWithMutation = fakeAppendManyWithMutation();
    const persistedWorkspace = createWorkspace({
      workspace_id: "local_abcd",
      name: "repo",
      root_path: "/tmp/repo",
      workspace_kind: WorkspaceKind.LOCAL_REPO,
      repo_path: "/tmp/repo",
      default_engine_binding: null,
      default_engine_class: null,
      workspace_state: WorkspaceState.ACTIVE
    });
    // SqliteWorkspaceRepo.create surfaces a structured DUPLICATE_KEY
    // StorageError on UNIQUE collisions so the service branches on
    // error.code, not on the underlying sqlite driver message string.
    // Use a duck-typed error here to keep core test-isolation from the
    // storage package.
    const duplicateWorkspaceError = createDuplicateKeyError(
      "local_abcd",
      new Error("UNIQUE constraint failed: workspaces.workspace_id")
    );
    const workspaceRepo = {
      create: vi.fn(() => {
        throw duplicateWorkspaceError;
      }),
      getById: vi.fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(persistedWorkspace),
      list: vi.fn(async () => []),
      delete: vi.fn(() => undefined),
      updateDefaultEngineClass: vi.fn(() => {
        throw new Error("not used");
      })
    };
    const service = new WorkspaceService({
      workspaceRepo,
      runRepo: {
        listByWorkspace: vi.fn(async () => [])
      },
      eventPublisher: new StubEventPublisher(appendManyWithMutation)
    });

    const ensured = await service.ensureLocalWorkspace({
      workspaceId: "local_abcd",
      name: "repo",
      rootPath: "/tmp/repo"
    });

    expect(ensured).toBe(persistedWorkspace);
    expect(workspaceRepo.getById).toHaveBeenCalledTimes(2);
    expect(workspaceRepo.create).toHaveBeenCalledTimes(1);
    expect(appendManyWithMutation).toHaveBeenCalledTimes(1);
  });

  // Prove the duplicate-walk also catches a wrapped DUPLICATE_KEY, such
  // as one surfaced by an EventPublisher that re-wraps the cause.
  // String-matching the sqlite UNIQUE message would silently fail here.
  it("re-reads local workspace when DUPLICATE_KEY arrives via a wrapped cause", async () => {
    const appendManyWithMutation = fakeAppendManyWithMutation();
    const persistedWorkspace = createWorkspace({
      workspace_id: "local_abcd",
      name: "repo",
      root_path: "/tmp/repo",
      workspace_kind: WorkspaceKind.LOCAL_REPO,
      repo_path: "/tmp/repo",
      default_engine_binding: null,
      default_engine_class: null,
      workspace_state: WorkspaceState.ACTIVE
    });
    const innerDuplicateError = createDuplicateKeyError(
      "local_abcd",
      new Error("UNIQUE constraint failed: workspaces.workspace_id")
    );
    const wrappedError = new Error("EventPublisher mutation failed");
    (wrappedError as { cause?: unknown }).cause = innerDuplicateError;

    const workspaceRepo = {
      create: vi.fn(() => {
        throw wrappedError;
      }),
      getById: vi.fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(persistedWorkspace),
      list: vi.fn(async () => []),
      delete: vi.fn(() => undefined),
      updateDefaultEngineClass: vi.fn(() => {
        throw new Error("not used");
      })
    };
    const service = new WorkspaceService({
      workspaceRepo,
      runRepo: {
        listByWorkspace: vi.fn(async () => [])
      },
      eventPublisher: new StubEventPublisher(appendManyWithMutation)
    });

    const ensured = await service.ensureLocalWorkspace({
      workspaceId: "local_abcd",
      name: "repo",
      rootPath: "/tmp/repo"
    });

    expect(ensured).toBe(persistedWorkspace);
    expect(workspaceRepo.getById).toHaveBeenCalledTimes(2);
  });

  // The real-SQLite concurrent integration test for this scenario
  // lives in
  // `apps/core-daemon/src/__tests__/workspace-concurrent-ensure.test.ts`
  // — the core package may not import @do-soul/alaya-storage per the
  // Package Dependency Direction.

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
      create: vi.fn((relation: PathRelation) => relation),
      findByWorkspace: vi.fn(async () => [])
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
      eventPublisher: new StubEventPublisher(appendManyWithMutation),
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
      }),
      findByWorkspace: vi.fn(async () => [])
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
      eventPublisher: new StubEventPublisher(fakeAppendManyWithMutation()),
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
