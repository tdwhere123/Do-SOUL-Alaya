import { describe, expect, it, vi } from "vitest";
import {
  WorkspaceKind,
  WorkspaceState,
  type BootstrappingRecord,
  type PathRelation
} from "@do-soul/alaya-protocol";
import { WorkspaceService } from "../../../runtime/runs/workspace-service.js";
import {
  createBootstrappingRecord,
  createPathRelation,
  createWorkspace,
  fakeAppendManyWithMutation
} from "./workspace-service.test-support.js";
import { StubEventPublisher } from "../../support/event-publisher-stub.js";

describe("WorkspaceService workspaceCreationMutation", () => {
  it("runs the creation mutation immediately after the workspace row inside mutate", async () => {
    const order: string[] = [];
    const mutation = vi.fn((workspace: { readonly workspace_id: string }) => {
      order.push(`mutation:${workspace.workspace_id}`);
    });
    const { service } = makeService({
      mutation,
      onWorkspaceCreate: (workspaceId) => {
        order.push(`workspace:${workspaceId}`);
      },
      onPathCreate: (pathId) => {
        order.push(`path:${pathId}`);
      },
      onBootstrapRecordCreate: () => {
        order.push("bootstrap_record");
      }
    });

    const created = await service.create({
      name: "alpha",
      root_path: "/tmp/alpha",
      workspace_kind: WorkspaceKind.LOCAL_REPO
    });

    expect(mutation).toHaveBeenCalledTimes(1);
    expect(mutation).toHaveBeenCalledWith(expect.objectContaining({
      workspace_id: created.workspace_id
    }));
    expect(order).toEqual([
      `workspace:${created.workspace_id}`,
      `mutation:${created.workspace_id}`,
      "path:path-bootstrap-1",
      "bootstrap_record"
    ]);
  });

  it("propagates a creation-mutation throw from create", async () => {
    const mutation = vi.fn(() => {
      throw new Error("planted workspace birth mutation failure");
    });
    const { service, workspaceCreate } = makeService({ mutation });

    await expect(service.create({
      name: "alpha",
      root_path: "/tmp/alpha",
      workspace_kind: WorkspaceKind.LOCAL_REPO
    })).rejects.toThrow("planted workspace birth mutation failure");
    expect(workspaceCreate).toHaveBeenCalledTimes(1);
    expect(mutation).toHaveBeenCalledTimes(1);
  });

  it("invokes the creation mutation when ensure creates a missing workspace", async () => {
    const mutation = vi.fn();
    const { service } = makeService({ mutation, withBootstrap: false });

    const ensured = await service.ensureLocalWorkspace({
      workspaceId: "local_birth",
      name: "repo",
      rootPath: "/tmp/repo"
    });

    expect(ensured.workspace_id).toBe("local_birth");
    expect(mutation).toHaveBeenCalledTimes(1);
    expect(mutation).toHaveBeenCalledWith(expect.objectContaining({
      workspace_id: "local_birth"
    }));
  });

  it("does not invoke the creation mutation when ensure finds an existing workspace", async () => {
    const mutation = vi.fn();
    const existing = createWorkspace({
      workspace_id: "local_existing",
      name: "repo",
      root_path: "/tmp/repo",
      workspace_kind: WorkspaceKind.LOCAL_REPO,
      repo_path: "/tmp/repo",
      default_engine_binding: null,
      default_engine_class: null,
      workspace_state: WorkspaceState.ACTIVE
    });
    const { service, workspaceCreate } = makeService({
      mutation,
      withBootstrap: false,
      getById: async () => existing
    });

    const ensured = await service.ensureLocalWorkspace({
      workspaceId: "local_existing",
      name: "repo",
      rootPath: "/tmp/repo"
    });

    expect(ensured).toBe(existing);
    expect(workspaceCreate).not.toHaveBeenCalled();
    expect(mutation).not.toHaveBeenCalled();
  });
});

function makeService(options: {
  readonly mutation?: (workspace: ReturnType<typeof createWorkspace>) => void;
  readonly withBootstrap?: boolean;
  readonly getById?: (id: string) => Promise<ReturnType<typeof createWorkspace> | null>;
  readonly onWorkspaceCreate?: (workspaceId: string) => void;
  readonly onPathCreate?: (pathId: string) => void;
  readonly onBootstrapRecordCreate?: () => void;
}) {
  const withBootstrap = options.withBootstrap !== false;
  const workspaceCreate = vi.fn((input: Parameters<typeof createWorkspace>[0]) => {
    options.onWorkspaceCreate?.(input.workspace_id);
    return createWorkspace(input);
  });
  const pathRelationRepo = {
    create: vi.fn((relation: PathRelation) => {
      options.onPathCreate?.(relation.path_id);
      return relation;
    }),
    findByWorkspace: vi.fn(async () => [])
  };
  const bootstrappingRecordRepo = {
    findByWorkspace: vi.fn(() => null),
    create: vi.fn((record: BootstrappingRecord) => {
      options.onBootstrapRecordCreate?.();
      return record;
    })
  };
  const service = new WorkspaceService({
    workspaceRepo: {
      create: workspaceCreate,
      getById: vi.fn(options.getById ?? (async () => null)),
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
    workspaceCreationMutation: options.mutation,
    ...(withBootstrap
      ? {
          bootstrappingPlanner: {
            planBootstrap: vi.fn(async (workspaceId: string) => ({
              relations: [createPathRelation({ workspace_id: workspaceId })],
              record: createBootstrappingRecord({ workspace_id: workspaceId })
            }))
          },
          pathRelationRepo,
          bootstrappingRecordRepo
        }
      : {})
  });
  return { service, workspaceCreate };
}
