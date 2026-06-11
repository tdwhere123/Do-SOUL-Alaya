import { describe, expect, it, vi } from "vitest";
import {
  RunMode,
  RunState,
  WorkspaceKind,
  WorkspaceState,
  type EngineBindingRecord,
  type Run,
  type Workspace
} from "@do-soul/alaya-protocol";
import { RunService } from "../../runs/run-service.js";

describe("RunService", () => {
  it("rejects create when principal engine_class cannot be resolved", async () => {
    const service = createService({
      workspace: createWorkspace({
        default_engine_class: null
      })
    });

    await expect(
      service.create("ws_1", {
        title: "new run"
      })
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: "Run principal engine is not configured for this workspace"
    });
  });

  it("still enforces coding_engine principal readiness", async () => {
    const service = createService({
      workspace: createWorkspace({
        default_engine_class: "coding_engine"
      }),
      isPrincipalCodingEngineAvailable: () => false
    });

    await expect(service.create("ws_1", {})).rejects.toMatchObject({
      code: "CONFLICT",
      message: "coding_engine is not available for principal runs on this backend"
    });
  });

  it("rejects conversation_engine when no binding resolves from run or workspace", async () => {
    const service = createService({
      workspace: createWorkspace({
        default_engine_class: "conversation_engine",
        default_engine_binding: null
      })
    });

    await expect(service.create("ws_1", {})).rejects.toMatchObject({
      code: "CONFLICT",
      message: "conversation_engine requires an existing workspace engine binding"
    });
  });

  it("rejects conversation_engine when resolved binding record is missing", async () => {
    const service = createService({
      workspace: createWorkspace({
        default_engine_class: "conversation_engine",
        default_engine_binding: "binding_missing"
      }),
      bindingById: {}
    });

    await expect(service.create("ws_1", {})).rejects.toMatchObject({
      code: "CONFLICT",
      message: "Configured conversation engine binding could not be found"
    });
  });

  it("rejects conversation_engine when resolved binding belongs to another workspace", async () => {
    const foreignBinding = createBindingRecord({
      binding_id: "binding_foreign",
      workspace_id: "ws_other"
    });
    const service = createService({
      workspace: createWorkspace({
        default_engine_class: "conversation_engine"
      }),
      bindingById: {
        [foreignBinding.binding_id]: foreignBinding
      }
    });

    await expect(
      service.create("ws_1", {
        engine_class: "conversation_engine",
        engine_binding_id: foreignBinding.binding_id
      })
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: "Configured conversation engine binding does not belong to this workspace"
    });
  });

  it("creates conversation_engine runs only when resolved binding is workspace-owned", async () => {
    const ownedBinding = createBindingRecord({
      binding_id: "binding_owned",
      workspace_id: "ws_1"
    });
    const service = createService({
      workspace: createWorkspace({
        default_engine_class: "conversation_engine",
        default_engine_binding: ownedBinding.binding_id
      }),
      bindingById: {
        [ownedBinding.binding_id]: ownedBinding
      }
    });

    const created = await service.create("ws_1", {
      title: "Conversation run"
    });

    expect(created).toMatchObject({
      workspace_id: "ws_1",
      run_mode: RunMode.CHAT,
      engine_class: "conversation_engine"
    });
  });

  it("snapshots the resolved workspace default binding id for conversation_engine runs", async () => {
    const ownedBinding = createBindingRecord({
      binding_id: "binding_snapshot",
      workspace_id: "ws_1"
    });
    const service = createService({
      workspace: createWorkspace({
        default_engine_class: "conversation_engine",
        default_engine_binding: ownedBinding.binding_id
      }),
      bindingById: {
        [ownedBinding.binding_id]: ownedBinding
      }
    });

    const created = await service.create("ws_1", {
      title: "Snapshot binding run"
    });

    expect(created).toMatchObject({
      workspace_id: "ws_1",
      run_mode: RunMode.CHAT,
      engine_class: "conversation_engine",
      engine_binding_id: ownedBinding.binding_id
    });
  });

  it("creates attached MCP session runs without requiring a principal engine", async () => {
    const service = createService({
      workspace: createWorkspace({
        default_engine_class: null
      })
    });

    const created = await service.ensureAttachedMcpSessionRun({
      workspaceId: "ws_1",
      sessionId: "mcp-session-1",
      agentTarget: "codex"
    });

    expect(created).toMatchObject({
      run_id: "mcp-session-1",
      workspace_id: "ws_1",
      title: "MCP session codex",
      goal: "Attached MCP session",
      run_mode: RunMode.CHAT,
      engine_class: null,
      run_state: RunState.ACTIVE
    });
  });
});

interface CreateServiceOptions {
  readonly workspace?: Workspace;
  readonly bindingById?: Record<string, EngineBindingRecord>;
  readonly isPrincipalCodingEngineAvailable?: () => boolean;
}

function createService(options: CreateServiceOptions): RunService {
  const workspace = options.workspace ?? createWorkspace();
  const bindingById = options.bindingById ?? {};
  const runRepoCreate = vi.fn(async (input: {
    readonly run_id: string;
    readonly workspace_id: string;
    readonly title: Run["title"];
    readonly goal: Run["goal"];
    readonly run_mode: Run["run_mode"];
    readonly engine_binding_id: Run["engine_binding_id"];
    readonly engine_class: Run["engine_class"];
    readonly run_state: Run["run_state"];
    readonly current_surface_id: Run["current_surface_id"];
  }) => {
    return createRun({
      ...input,
      created_at: "2026-04-15T00:00:00.000Z",
      last_active_at: "2026-04-15T00:00:00.000Z"
    });
  });

  return new RunService({
    workspaceRepo: {
      getById: vi.fn(async () => workspace)
    },
    runRepo: {
      create: vi.fn((input) =>
        createRun({
          ...input,
          created_at: "2026-04-15T00:00:00.000Z",
          last_active_at: "2026-04-15T00:00:00.000Z"
        })
      ),
      getById: vi.fn(async () => null),
      listByWorkspace: vi.fn(async () => []),
      delete: vi.fn(),
      update: vi.fn((_id, patch) => createRun({ ...patch }))
    },
    bindingRepo: {
      getById: vi.fn(async (id) => bindingById[id] ?? null)
    },
    eventPublisher: {
      // RunService now uses the atomic appendManyWithMutation primitive
      // (#BL-022). Mock executes the sync mutate against the first batch entry.
      appendManyWithMutation: vi.fn(async (inputs, mutate) => {
        const persisted = inputs.map((entry: any, idx: number) => ({
          event_id: `evt_${idx}`,
          created_at: "2026-04-15T00:00:00.000Z",
          revision: 0,
          ...entry
        }));
        return mutate(persisted);
      })
    } as any,
    isPrincipalCodingEngineAvailable: options.isPrincipalCodingEngineAvailable
  });
}

function createWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    workspace_id: "ws_1",
    name: "workspace",
    root_path: "/tmp/workspace",
    workspace_kind: WorkspaceKind.LOCAL_REPO,
    repo_path: null,
    default_engine_binding: null,
    default_engine_class: null,
    workspace_state: WorkspaceState.ACTIVE,
    created_at: "2026-04-15T00:00:00.000Z",
    archived_at: null,
    ...overrides
  };
}

function createBindingRecord(overrides: Partial<EngineBindingRecord> = {}): EngineBindingRecord {
  return {
    binding_id: "binding_1",
    workspace_id: "ws_1",
    provider_type: "openai",
    base_url: null,
    api_key: "sk-openai",
    model: "gpt-4o-mini",
    config: {},
    created_at: "2026-04-15T00:00:00.000Z",
    updated_at: "2026-04-15T00:00:00.000Z",
    ...overrides
  };
}

function createRun(overrides: Partial<Run> = {}): Run {
  return {
    run_id: "run_1",
    workspace_id: "ws_1",
    title: "Run title",
    goal: null,
    run_mode: RunMode.CHAT,
    engine_binding_id: null,
    engine_class: "conversation_engine",
    run_state: RunState.IDLE,
    current_surface_id: null,
    created_at: "2026-04-15T00:00:00.000Z",
    last_active_at: "2026-04-15T00:00:00.000Z",
    ...overrides
  };
}
