import { describe, expect, it, vi } from "vitest";
import { RuntimeGovernanceEventType, type EventLogEntry } from "@do-soul/alaya-protocol";
import { EventPublisherPropagationError } from "@do-soul/alaya-core";
import { withSecurityStatusWorkspaceService } from "../../security/status-bootstrap.js";

function createPropagationError(): EventPublisherPropagationError {
  const entry: EventLogEntry = {
    event_id: "event-1",
    event_type: RuntimeGovernanceEventType.SECURITY_PASSTHROUGH_STATUS_CHANGED,
    entity_type: "workspace",
    entity_id: "workspace-1",
    workspace_id: "workspace-1",
    run_id: null,
    caused_by: "system",
    revision: 0,
    payload_json: {
      workspace_id: "workspace-1",
      posture: "baseline",
      zero_day_active: false,
      active_security_locks: 0,
      reason: "workspace_initialized",
      changed_at: "2026-04-22T00:00:00.000Z"
    },
    created_at: "2026-04-22T00:00:00.000Z"
  };

  return new EventPublisherPropagationError(entry, new Error("broadcast failed"));
}

describe("withSecurityStatusWorkspaceService", () => {
  it("keeps create successful and skips initialization-failed witness on propagation failure", async () => {
    const workspace = {
      workspace_id: "workspace-1",
      name: "workspace",
      root_path: "/tmp/workspace",
      workspace_kind: "local_repo",
      created_at: "2026-04-22T00:00:00.000Z",
      updated_at: "2026-04-22T00:00:00.000Z"
    };
    const initializeWorkspace = vi.fn(async () => {
      throw createPropagationError();
    });
    const recordInitializationFailure = vi.fn(async () => undefined);
    const service = withSecurityStatusWorkspaceService(
      {
        create: vi.fn(async () => workspace)
      } as never,
      {
        initializeWorkspace,
        recordInitializationFailure
      }
    );

    await expect(service.create({} as never)).resolves.toEqual(workspace);
    expect(initializeWorkspace).toHaveBeenCalledWith("workspace-1");
    expect(recordInitializationFailure).not.toHaveBeenCalled();
  });

  it("keeps read paths non-fatal and skips initialization-failed witness on propagation failure", async () => {
    const workspace = {
      workspace_id: "workspace-1",
      name: "workspace",
      root_path: "/tmp/workspace",
      workspace_kind: "local_repo",
      created_at: "2026-04-22T00:00:00.000Z",
      updated_at: "2026-04-22T00:00:00.000Z"
    };
    const initializeWorkspace = vi.fn(async () => {
      throw createPropagationError();
    });
    const recordInitializationFailure = vi.fn(async () => undefined);
    const service = withSecurityStatusWorkspaceService(
      {
        getById: vi.fn(async () => workspace),
        list: vi.fn(async () => [workspace])
      } as never,
      {
        initializeWorkspace,
        recordInitializationFailure
      }
    );

    await expect(service.getById("workspace-1")).resolves.toEqual(workspace);
    await expect(service.list()).resolves.toEqual([workspace]);
    expect(recordInitializationFailure).not.toHaveBeenCalled();
  });

  it("keeps ensureLocalWorkspace successful and skips initialization-failed witness on propagation failure", async () => {
    const workspace = {
      workspace_id: "workspace-1",
      name: "workspace",
      root_path: "/tmp/workspace",
      workspace_kind: "local_repo",
      created_at: "2026-04-22T00:00:00.000Z",
      updated_at: "2026-04-22T00:00:00.000Z"
    };
    const initializeWorkspace = vi.fn(async () => {
      throw createPropagationError();
    });
    const recordInitializationFailure = vi.fn(async () => undefined);
    const service = withSecurityStatusWorkspaceService(
      {
        ensureLocalWorkspace: vi.fn(async () => workspace)
      } as never,
      {
        initializeWorkspace,
        recordInitializationFailure
      }
    );

    await expect(service.ensureLocalWorkspace({
      workspaceId: "workspace-1",
      name: "workspace",
      rootPath: "/tmp/workspace"
    })).resolves.toEqual(workspace);
    expect(initializeWorkspace).toHaveBeenCalledWith("workspace-1");
    expect(recordInitializationFailure).not.toHaveBeenCalled();
  });

  it("runs workspaceEnsureMutation after ensure and before security initialization", async () => {
    const workspace = {
      workspace_id: "workspace-1",
      name: "workspace",
      root_path: "/tmp/workspace",
      workspace_kind: "local_repo",
      created_at: "2026-04-22T00:00:00.000Z",
      updated_at: "2026-04-22T00:00:00.000Z"
    };
    const order: string[] = [];
    const service = withSecurityStatusWorkspaceService(
      {
        ensureLocalWorkspace: vi.fn(async () => {
          order.push("ensure");
          return workspace;
        })
      } as never,
      {
        initializeWorkspace: vi.fn(async () => {
          order.push("security");
        }),
        recordInitializationFailure: vi.fn(async () => undefined)
      },
      () => {
        order.push("ensure_mutation");
      }
    );

    await service.ensureLocalWorkspace({
      workspaceId: "workspace-1",
      name: "workspace",
      rootPath: "/tmp/workspace"
    });
    expect(order).toEqual(["ensure", "ensure_mutation", "security"]);
  });

  it("propagates workspaceEnsureMutation failure without initializing security", async () => {
    const workspace = {
      workspace_id: "workspace-1",
      name: "workspace",
      root_path: "/tmp/workspace",
      workspace_kind: "local_repo",
      created_at: "2026-04-22T00:00:00.000Z",
      updated_at: "2026-04-22T00:00:00.000Z"
    };
    const initializeWorkspace = vi.fn(async () => undefined);
    const service = withSecurityStatusWorkspaceService(
      {
        ensureLocalWorkspace: vi.fn(async () => workspace)
      } as never,
      {
        initializeWorkspace,
        recordInitializationFailure: vi.fn(async () => undefined)
      },
      () => {
        throw new Error("planted ensure failure");
      }
    );

    await expect(service.ensureLocalWorkspace({
      workspaceId: "workspace-1",
      name: "workspace",
      rootPath: "/tmp/workspace"
    })).rejects.toThrow(/planted ensure failure/u);
    expect(initializeWorkspace).not.toHaveBeenCalled();
  });

  it("records create as the initialization-failure operation for create", async () => {
    const workspace = sampleWorkspace();
    const recordInitializationFailure = vi.fn(async () => undefined);
    const service = withSecurityStatusWorkspaceService(
      {
        create: vi.fn(async () => workspace)
      } as never,
      {
        initializeWorkspace: vi.fn(async () => {
          throw new Error("zero-day policy store offline");
        }),
        recordInitializationFailure
      }
    );

    await expect(service.create({} as never)).resolves.toEqual(workspace);
    expect(recordInitializationFailure).toHaveBeenCalledWith(
      "workspace-1",
      "create",
      "zero-day policy store offline",
      "Error"
    );
  });

  it("records ensure as the initialization-failure operation for ensureLocalWorkspace", async () => {
    const workspace = sampleWorkspace();
    const recordInitializationFailure = vi.fn(async () => undefined);
    const service = withSecurityStatusWorkspaceService(
      {
        ensureLocalWorkspace: vi.fn(async () => workspace)
      } as never,
      {
        initializeWorkspace: vi.fn(async () => {
          throw new Error("zero-day policy store offline");
        }),
        recordInitializationFailure
      }
    );

    await expect(service.ensureLocalWorkspace({
      workspaceId: "workspace-1",
      name: "workspace",
      rootPath: "/tmp/workspace"
    })).resolves.toEqual(workspace);
    expect(recordInitializationFailure).toHaveBeenCalledWith(
      "workspace-1",
      "ensure",
      "zero-day policy store offline",
      "Error"
    );
  });

  it("does not invoke workspaceEnsureMutation on getById or list", async () => {
    const workspace = sampleWorkspace();
    const workspaceEnsureMutation = vi.fn();
    const service = withSecurityStatusWorkspaceService(
      {
        getById: vi.fn(async () => workspace),
        list: vi.fn(async () => [workspace])
      } as never,
      {
        initializeWorkspace: vi.fn(async () => undefined),
        recordInitializationFailure: vi.fn(async () => undefined)
      },
      workspaceEnsureMutation
    );

    await expect(service.getById("workspace-1")).resolves.toEqual(workspace);
    await expect(service.list()).resolves.toEqual([workspace]);
    expect(workspaceEnsureMutation).not.toHaveBeenCalled();
  });
});

function sampleWorkspace() {
  return {
    workspace_id: "workspace-1",
    name: "workspace",
    root_path: "/tmp/workspace",
    workspace_kind: "local_repo",
    created_at: "2026-04-22T00:00:00.000Z",
    updated_at: "2026-04-22T00:00:00.000Z"
  };
}
