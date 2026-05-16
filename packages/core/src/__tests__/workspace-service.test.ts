import { describe, expect, it, vi } from "vitest";
import {
  WorkspaceKind,
  WorkspaceState,
  type BootstrappingRecord,
  type PathRelation,
  type Workspace
} from "@do-soul/alaya-protocol";
import { WorkspaceService } from "../workspace-service.js";

// Duck-typed shape that mirrors @do-soul/alaya-storage StorageError
// without importing the storage package — core may not depend on
// storage per the Package Dependency Direction (invariants §<dep-dir>).
// Real SqliteWorkspaceRepo behavior is exercised end-to-end by the
// daemon-level integration test
// `apps/core-daemon/src/__tests__/workspace-concurrent-ensure.test.ts`.
function createDuplicateKeyError(workspaceId: string, cause?: unknown): Error & {
  readonly code: string;
} {
  const error = new Error(`Workspace ${workspaceId} already exists.`) as Error & {
    code: string;
    cause?: unknown;
  };
  error.code = "DUPLICATE_KEY";
  if (cause !== undefined) {
    error.cause = cause;
  }
  return error;
}

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
      eventPublisher: {
        appendManyWithMutation
      } as any
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
      eventPublisher: {
        appendManyWithMutation
      } as any
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
      eventPublisher: {
        appendManyWithMutation
      } as any
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

describe("WorkspaceService.reconcileBootstrapPaths", () => {
  it("returns skipped_no_planner when bootstrapping deps are not wired", async () => {
    const harness = makeReconcileService({ withBootstrapping: false });

    const result = await harness.service.reconcileBootstrapPaths("ws_alpha");
    expect(result).toEqual({
      status: "skipped_no_planner",
      workspace_id: "ws_alpha"
    });
  });

  it("plants seed paths when the workspace has no record and no relations", async () => {
    const planted: string[] = [];
    const seedRecord = createBootstrappingRecord({ workspace_id: "ws_alpha" });
    const seedRelation = createPathRelation({ workspace_id: "ws_alpha" });
    const harness = makeReconcileService({
      pathRelationCreate: (relation) => {
        planted.push(relation.path_id);
      },
      planBootstrap: async () => ({
        relations: [seedRelation],
        record: seedRecord
      })
    });

    const result = await harness.service.reconcileBootstrapPaths("ws_alpha");

    expect(result).toEqual({
      status: "planted",
      workspace_id: "ws_alpha",
      paths_planted: 1,
      record_id: seedRecord.record_id,
      template_ids: seedRecord.template_ids_used
    });
    expect(harness.planner.planBootstrap).toHaveBeenCalledWith("ws_alpha");
    expect(planted).toEqual([seedRelation.path_id]);
    expect(harness.recordRepo.create).toHaveBeenCalledTimes(1);
    expect(harness.appendManyWithMutation).toHaveBeenCalledTimes(1);
  });

  it("skips reconcile when the bootstrapping planner has no templates", async () => {
    const harness = makeReconcileService({
      planBootstrap: async () => ({
        relations: [],
        record: createBootstrappingRecord({
          workspace_id: "ws_alpha",
          paths_planted: 0,
          template_ids_used: []
        })
      })
    });

    const result = await harness.service.reconcileBootstrapPaths("ws_alpha");

    expect(result).toEqual({
      status: "skipped_no_templates",
      workspace_id: "ws_alpha",
      template_ids: []
    });
    expect(harness.planner.planBootstrap).toHaveBeenCalledWith("ws_alpha");
    expect(harness.recordRepo.create).not.toHaveBeenCalled();
    expect(harness.pathRepo.create).not.toHaveBeenCalled();
    expect(harness.appendManyWithMutation).not.toHaveBeenCalled();
  });

  it("reports corrupt_partial when a record exists without seed relations", async () => {
    const existingRecord = createBootstrappingRecord({ workspace_id: "ws_alpha" });
    const harness = makeReconcileService({
      recordFindByWorkspace: () => existingRecord
    });

    const result = await harness.service.reconcileBootstrapPaths("ws_alpha");

    expect(result).toEqual({
      status: "corrupt_partial",
      workspace_id: "ws_alpha",
      record_id: existingRecord.record_id,
      relation_count: 0,
      reason: "bootstrapping_record_without_relations"
    });
    expect(harness.planner.planBootstrap).not.toHaveBeenCalled();
    expect(harness.recordRepo.create).not.toHaveBeenCalled();
    expect(harness.pathRepo.create).not.toHaveBeenCalled();
  });

  it("treats non-empty path_relations as already_planted even when record is null", async () => {
    // invariant: corrupted state (relations present, record null) must not
    // trigger a second plant — re-planting would create orphan seeds. Operator
    // recovery: either DELETE the orphan relations OR INSERT a synthetic
    // bootstrapping_record covering them, then reconcile is a no-op either way.
    const existingRelation = createPathRelation({ workspace_id: "ws_alpha" });
    const harness = makeReconcileService({
      pathFindByWorkspace: async () => [existingRelation]
    });

    const result = await harness.service.reconcileBootstrapPaths("ws_alpha");

    expect(result).toEqual({
      status: "already_planted",
      workspace_id: "ws_alpha",
      record_id: null,
      relation_count: 1
    });
    expect(harness.planner.planBootstrap).not.toHaveBeenCalled();
  });

  it("aborts planting when an in-transaction race writes the record first", async () => {
    // @anchor: race-guard mirrors createWithId in-transaction re-check;
    // throws a sentinel so SQLite rolls back the queued plant event.
    const racedRecord = createBootstrappingRecord({
      workspace_id: "ws_alpha",
      record_id: "bootstrap-record-raced"
    });
    let recordPersisted = false;
    const harness = makeReconcileService({
      recordFindByWorkspace: () => (recordPersisted ? racedRecord : null),
      planBootstrap: async () => ({
        relations: [createPathRelation({ workspace_id: "ws_alpha" })],
        record: createBootstrappingRecord({ workspace_id: "ws_alpha" })
      }),
      appendManyWithMutation: async (_events, mutate) => {
        recordPersisted = true;
        mutate();
      }
    });

    const result = await harness.service.reconcileBootstrapPaths("ws_alpha");

    expect(result).toEqual({
      status: "corrupt_partial",
      workspace_id: "ws_alpha",
      record_id: racedRecord.record_id,
      relation_count: 0,
      reason: "bootstrapping_record_without_relations"
    });
    expect(harness.pathRepo.create).not.toHaveBeenCalled();
    expect(harness.recordRepo.create).not.toHaveBeenCalled();
  });

  it("rejects reconcile against a non-existent workspace with CoreError NOT_FOUND", async () => {
    const harness = makeReconcileService({
      getById: async () => null
    });

    await expect(harness.service.reconcileBootstrapPaths("ws_missing")).rejects.toMatchObject({
      code: "NOT_FOUND"
    });
    expect(harness.planner.planBootstrap).not.toHaveBeenCalled();
  });

  it("threads causedBy=user_action through the BOOTSTRAPPING_PATHS_PLANTED event", async () => {
    const seenEvents: ReadonlyArray<{ readonly caused_by: string }>[] = [];
    const harness = makeReconcileService({
      appendManyWithMutation: async (events, mutate) => {
        seenEvents.push(events as ReadonlyArray<{ readonly caused_by: string }>);
        mutate();
      }
    });

    await harness.service.reconcileBootstrapPaths("ws_alpha", {
      causedBy: "user_action"
    });

    expect(seenEvents).toHaveLength(1);
    expect(seenEvents[0]).toHaveLength(1);
    expect(seenEvents[0][0].caused_by).toBe("user_action");
  });
});

interface ReconcileHarnessOptions {
  readonly withBootstrapping?: boolean;
  readonly getById?: (id: string) => Promise<Workspace | null>;
  readonly recordFindByWorkspace?: () => BootstrappingRecord | null;
  readonly pathFindByWorkspace?: () => Promise<readonly PathRelation[]>;
  readonly pathRelationCreate?: (relation: PathRelation) => void;
  readonly planBootstrap?: (workspaceId: string) => Promise<{
    readonly relations: readonly PathRelation[];
    readonly record: BootstrappingRecord;
  }>;
  readonly appendManyWithMutation?: (events: unknown[], mutate: () => void) => Promise<unknown>;
}

function makeReconcileService(options: ReconcileHarnessOptions = {}) {
  const placeholderWorkspace = createWorkspace({
    workspace_id: "ws_alpha",
    name: "alpha",
    root_path: "/tmp/alpha",
    workspace_kind: WorkspaceKind.LOCAL_REPO,
    default_engine_binding: null,
    default_engine_class: null,
    workspace_state: WorkspaceState.ACTIVE
  });
  const recordRepo = {
    findByWorkspace: vi.fn(options.recordFindByWorkspace ?? (() => null)),
    create: vi.fn((record: BootstrappingRecord) => record)
  };
  const pathRepo = {
    create: vi.fn((relation: PathRelation) => {
      options.pathRelationCreate?.(relation);
      return relation;
    }),
    findByWorkspace: vi.fn(options.pathFindByWorkspace ?? (async () => []))
  };
  const planner = {
    planBootstrap: vi.fn(
      options.planBootstrap ??
        (async (workspaceId: string) => ({
          relations: [createPathRelation({ workspace_id: workspaceId })],
          record: createBootstrappingRecord({ workspace_id: workspaceId })
        }))
    )
  };
  const appendManyWithMutation = vi.fn(
    options.appendManyWithMutation ?? fakeAppendManyWithMutation()
  );
  const service = new WorkspaceService({
    workspaceRepo: {
      create: vi.fn(),
      getById: vi.fn(options.getById ?? (async () => placeholderWorkspace)),
      list: vi.fn(async () => []),
      delete: vi.fn(() => undefined),
      updateDefaultEngineClass: vi.fn(() => {
        throw new Error("not used");
      })
    },
    runRepo: { listByWorkspace: vi.fn(async () => []) },
    eventPublisher: { appendManyWithMutation } as any,
    ...(options.withBootstrapping === false
      ? {}
      : {
          bootstrappingPlanner: planner,
          pathRelationRepo: pathRepo,
          bootstrappingRecordRepo: recordRepo
        })
  });
  return { service, appendManyWithMutation, planner, recordRepo, pathRepo };
}

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
        facet_key: "explicit_test_seed"
      }
    },
    constitution: {
      relation_kind: "supports",
      why_this_relation_exists: ["test-configured ontology seed"]
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
      evidence_basis: ["bootstrapping:workspace.bootstrap.explicit-test"],
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
    template_ids_used: ["workspace.bootstrap.explicit-test"],
    planted_at: "2026-04-20T00:00:00.000Z",
    ...overrides
  };
}
