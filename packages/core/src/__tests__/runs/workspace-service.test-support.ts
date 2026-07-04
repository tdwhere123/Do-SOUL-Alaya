import { vi } from "vitest";
import { WorkspaceKind, WorkspaceState, type BootstrappingRecord, type PathRelation, type Workspace } from "@do-soul/alaya-protocol";
import { WorkspaceService } from "../../runs/workspace-service.js";
import {
  StubEventPublisher,
  fakeAppendManyWithMutation,
  type AppendManyWithMutationErased,
  type AppendManyWithMutationMock
} from "../support/event-publisher-stub.js";

export // Duck-typed shape that mirrors @do-soul/alaya-storage StorageError
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

export { fakeAppendManyWithMutation };

export interface ReconcileHarnessOptions {
  readonly withBootstrapping?: boolean;
  readonly getById?: (id: string) => Promise<Workspace | null>;
  readonly recordFindByWorkspace?: () => BootstrappingRecord | null;
  readonly pathFindByWorkspace?: () => Promise<readonly PathRelation[]>;
  readonly pathRelationCreate?: (relation: PathRelation) => void;
  readonly planBootstrap?: (workspaceId: string) => Promise<{
    readonly relations: readonly PathRelation[];
    readonly record: BootstrappingRecord;
  }>;
  readonly appendManyWithMutation?: AppendManyWithMutationErased;
}

export function makeReconcileService(options: ReconcileHarnessOptions = {}) {
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
  const appendManyWithMutation: AppendManyWithMutationMock = options.appendManyWithMutation
    ? vi.fn(options.appendManyWithMutation)
    : fakeAppendManyWithMutation();
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
    eventPublisher: new StubEventPublisher(appendManyWithMutation),
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

export function createWorkspace(
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

export function createPathRelation(overrides: Partial<PathRelation> = {}): PathRelation {
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

export function createBootstrappingRecord(
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
