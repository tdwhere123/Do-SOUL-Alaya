import { describe, expect, it, vi } from "vitest";
import {
  EngineErrorKind,
  EngineProvider,
  RunMode,
  RunState,
  WorkspaceKind,
  WorkspaceState,
  type Run,
  type Workspace
} from "@do-soul/alaya-protocol";
import { EngineBindingService } from "../engine-binding-service.js";

// Helper: in-test publisher that simulates the appendManyWithMutation contract
// (sync mutate, batch-array first arg) used by EngineBindingService after #BL-022.
function fakeAppendManyWithMutation(publishedEvents?: Array<any>) {
  return vi.fn(async (events: any[], mutate: (entries: any[]) => any) => {
    if (publishedEvents) {
      for (const event of events) publishedEvents.push(event);
    }
    const persisted = events.map((event, idx) => ({
      ...event,
      event_id: `evt_${idx}`,
      created_at: "2026-03-18T00:00:00.000Z"
    }));
    return mutate(persisted);
  });
}

describe("EngineBindingService", () => {
  it("saves a workspace binding, records an event, and points the workspace default binding at it", async () => {
    let defaultBindingId: string | null = null;
    const savedRecords = new Map<string, any>();
    const publishedEvents: Array<any> = [];
    const upsertImpl = (record: any) => {
      const saved = {
        ...record,
        created_at: "2026-03-18T00:00:00.000Z",
        updated_at: "2026-03-18T00:00:00.000Z"
      };
      savedRecords.set(saved.binding_id, saved);
      return saved;
    };
    const updateDefaultBindingImpl = (_id: string, bindingId: string | null) => {
      defaultBindingId = bindingId;
      return createWorkspace({ default_engine_binding: defaultBindingId });
    };
    const service = new EngineBindingService({
      workspaceRepo: {
        getById: vi.fn(async () => createWorkspace({ default_engine_binding: defaultBindingId })),
        updateDefaultEngineBinding: vi.fn(async (id, bindingId) => updateDefaultBindingImpl(id, bindingId)),
        updateDefaultEngineBindingSync: vi.fn(updateDefaultBindingImpl)
      },
      bindingRepo: {
        upsert: vi.fn(async (record) => upsertImpl(record)),
        upsertSync: vi.fn(upsertImpl),
        getById: vi.fn(async (id) => savedRecords.get(id) ?? null)
      },
      eventPublisher: {
        appendManyWithMutation: fakeAppendManyWithMutation(publishedEvents)
      } as any,
      engineTester: {
        testBinding: vi.fn(async () => ({
          provider_type: EngineProvider.OPENAI,
          base_url: null,
          model: "gpt-4o-mini",
          available_models: ["gpt-4o-mini"]
        }))
      }
    });

    const saved = await service.saveWorkspaceBinding("ws_1", {
      provider_type: EngineProvider.OPENAI,
      base_url: null,
      api_key: "sk-openai",
      model: "gpt-4o-mini",
      config: {}
    });

    expect(saved).toMatchObject({
      workspace_id: "ws_1",
      provider_type: EngineProvider.OPENAI,
      api_key: "sk-openai"
    });
    expect(defaultBindingId).toBe(saved.binding_id);
    expect(publishedEvents).toEqual([
      expect.objectContaining({
        event_type: "workspace.engine_binding.updated",
        entity_id: "ws_1",
        workspace_id: "ws_1",
        payload_json: expect.objectContaining({
          binding_id: saved.binding_id,
          provider_type: EngineProvider.OPENAI,
          model: "gpt-4o-mini"
        })
      })
    ]);
    await expect(service.getWorkspaceBinding("ws_1")).resolves.toMatchObject({
      binding_id: saved.binding_id,
      api_key: "sk-openai"
    });
  });

  it("creates a fresh binding id for each workspace binding update and preserves older rows", async () => {
    let defaultBindingId: string | null = null;
    const savedRecords = new Map<string, any>();
    const upsertImpl = (record: any) => {
      const persisted = {
        ...record,
        created_at: "2026-03-18T00:00:00.000Z",
        updated_at: "2026-03-18T00:00:00.000Z"
      };
      savedRecords.set(persisted.binding_id, persisted);
      return persisted;
    };
    const updateDefaultBindingImpl = (_id: string, bindingId: string | null) => {
      defaultBindingId = bindingId;
      return createWorkspace({ default_engine_binding: defaultBindingId });
    };
    const service = new EngineBindingService({
      workspaceRepo: {
        getById: vi.fn(async () => createWorkspace({ default_engine_binding: defaultBindingId })),
        updateDefaultEngineBinding: vi.fn(async (id, bindingId) => updateDefaultBindingImpl(id, bindingId)),
        updateDefaultEngineBindingSync: vi.fn(updateDefaultBindingImpl)
      },
      bindingRepo: {
        upsert: vi.fn(async (record) => upsertImpl(record)),
        upsertSync: vi.fn(upsertImpl),
        getById: vi.fn(async (id) => savedRecords.get(id) ?? null)
      },
      eventPublisher: {
        appendManyWithMutation: fakeAppendManyWithMutation()
      } as any,
      engineTester: {
        testBinding: vi.fn()
      }
    });

    const first = await service.saveWorkspaceBinding("ws_1", {
      provider_type: EngineProvider.OPENAI,
      base_url: null,
      api_key: "sk-v1",
      model: "gpt-4o-mini",
      config: {}
    });
    const second = await service.saveWorkspaceBinding("ws_1", {
      provider_type: EngineProvider.OPENAI,
      base_url: null,
      api_key: "sk-v2",
      model: "gpt-4.1",
      config: {}
    });

    expect(second.binding_id).not.toBe(first.binding_id);
    expect(defaultBindingId).toBe(second.binding_id);
    expect(savedRecords.get(first.binding_id)).toMatchObject({
      binding_id: first.binding_id,
      workspace_id: "ws_1",
      api_key: "sk-v1",
      model: "gpt-4o-mini"
    });
    expect(savedRecords.get(second.binding_id)).toMatchObject({
      binding_id: second.binding_id,
      workspace_id: "ws_1",
      api_key: "sk-v2",
      model: "gpt-4.1"
    });
  });

  it("tests a binding through the engine tester and returns normalized status", async () => {
    const workspace = createWorkspace();
    const engineTester = {
      testBinding: vi.fn(async () => ({
        provider_type: EngineProvider.CUSTOM,
        base_url: "https://proxy.example/v1",
        model: "proxy-model",
        available_models: ["proxy-model", "proxy-model-mini"]
      }))
    };
    const service = new EngineBindingService({
      workspaceRepo: {
        getById: vi.fn(async () => workspace),
        updateDefaultEngineBinding: vi.fn(),
        updateDefaultEngineBindingSync: vi.fn()
      },
      bindingRepo: {
        upsert: vi.fn(),
        upsertSync: vi.fn(),
        getById: vi.fn()
      },
      eventPublisher: {
        appendManyWithMutation: vi.fn()
      } as any,
      engineTester
    });

    await expect(
      service.testWorkspaceBinding(workspace.workspace_id, {
        provider_type: EngineProvider.CUSTOM,
        base_url: "https://proxy.example/v1",
        api_key: "sk-proxy",
        model: "proxy-model",
        config: {}
      })
    ).resolves.toEqual({
      success: true,
      error: null,
      normalized_binding: {
        provider_type: EngineProvider.CUSTOM,
        base_url: "https://proxy.example/v1",
        model: "proxy-model"
      },
      available_models: ["proxy-model", "proxy-model-mini"]
    });
    expect(engineTester.testBinding).toHaveBeenCalledTimes(1);
  });

  it("prefers run.engine_binding_id over the workspace default binding", async () => {
    const runBinding = {
      binding_id: "binding_run",
      workspace_id: "ws_1",
      provider_type: EngineProvider.CUSTOM,
      base_url: "https://run.example/v1",
      api_key: "sk-run",
      model: "run-model",
      config: {}
    };
    const workspaceBinding = {
      binding_id: "binding_workspace",
      workspace_id: "ws_1",
      provider_type: EngineProvider.OPENAI,
      base_url: null,
      api_key: "sk-workspace",
      model: "gpt-4o-mini",
      config: {}
    };
    const records = new Map<string, any>([
      [runBinding.binding_id, { ...runBinding, created_at: "2026-03-18T00:00:00.000Z", updated_at: "2026-03-18T00:00:00.000Z" }],
      [workspaceBinding.binding_id, { ...workspaceBinding, created_at: "2026-03-18T00:00:00.000Z", updated_at: "2026-03-18T00:00:00.000Z" }]
    ]);
    const workspace = createWorkspace({ default_engine_binding: workspaceBinding.binding_id });
    const service = new EngineBindingService({
      workspaceRepo: {
        getById: vi.fn(async () => workspace),
        updateDefaultEngineBinding: vi.fn()
      },
      bindingRepo: {
        upsert: vi.fn(),
        getById: vi.fn(async (id) => records.get(id) ?? null)
      },
      eventPublisher: {
        publishWithMutation: vi.fn()
      } as any,
      engineTester: {
        testBinding: vi.fn()
      }
    });

    await expect(
      service.resolveConversationBinding(
        createRun({ engine_binding_id: runBinding.binding_id }),
        workspace
      )
    ).resolves.toMatchObject({
      binding_id: runBinding.binding_id,
      provider: EngineProvider.CUSTOM,
      base_url: "https://run.example/v1",
      api_key: "sk-run",
      model: "run-model"
    });
  });

  it("keeps legacy fallback for null run bindings while honoring persisted run binding snapshots", async () => {
    const oldBinding = {
      binding_id: "binding_old",
      workspace_id: "ws_1",
      provider_type: EngineProvider.CUSTOM,
      base_url: "https://old.example/v1",
      api_key: "sk-old",
      model: "old-model",
      config: {},
      created_at: "2026-03-18T00:00:00.000Z",
      updated_at: "2026-03-18T00:00:00.000Z"
    };
    const newDefaultBinding = {
      binding_id: "binding_new",
      workspace_id: "ws_1",
      provider_type: EngineProvider.OPENAI,
      base_url: null,
      api_key: "sk-new",
      model: "gpt-4.1-mini",
      config: {},
      created_at: "2026-03-18T00:00:00.000Z",
      updated_at: "2026-03-18T00:00:00.000Z"
    };
    const records = new Map<string, any>([
      [oldBinding.binding_id, oldBinding],
      [newDefaultBinding.binding_id, newDefaultBinding]
    ]);
    const workspace = createWorkspace({ default_engine_binding: newDefaultBinding.binding_id });
    const service = new EngineBindingService({
      workspaceRepo: {
        getById: vi.fn(async () => workspace),
        updateDefaultEngineBinding: vi.fn()
      },
      bindingRepo: {
        upsert: vi.fn(),
        getById: vi.fn(async (id) => records.get(id) ?? null)
      },
      eventPublisher: {
        publishWithMutation: vi.fn()
      } as any,
      engineTester: {
        testBinding: vi.fn()
      }
    });

    await expect(
      service.resolveConversationBinding(createRun({ engine_binding_id: oldBinding.binding_id }), workspace)
    ).resolves.toMatchObject({
      binding_id: oldBinding.binding_id,
      model: "old-model"
    });

    await expect(service.resolveConversationBinding(createRun({ engine_binding_id: null }), workspace)).resolves.toMatchObject({
      binding_id: newDefaultBinding.binding_id,
      model: "gpt-4.1-mini"
    });
  });

  it("rejects a run binding that belongs to a different workspace", async () => {
    const foreignBinding = {
      binding_id: "binding_foreign",
      workspace_id: "ws_2",
      provider_type: EngineProvider.OPENAI,
      base_url: null,
      api_key: "sk-foreign",
      model: "gpt-4o-mini",
      config: {},
      created_at: "2026-03-18T00:00:00.000Z",
      updated_at: "2026-03-18T00:00:00.000Z"
    };
    const service = new EngineBindingService({
      workspaceRepo: {
        getById: vi.fn(async () => createWorkspace()),
        updateDefaultEngineBinding: vi.fn()
      },
      bindingRepo: {
        upsert: vi.fn(),
        getById: vi.fn(async () => foreignBinding)
      },
      eventPublisher: {
        publishWithMutation: vi.fn()
      } as any,
      engineTester: {
        testBinding: vi.fn()
      }
    });

    await expect(
      service.resolveConversationBinding(
        createRun({ engine_binding_id: foreignBinding.binding_id }),
        createWorkspace()
      )
    ).rejects.toMatchObject({
      kind: EngineErrorKind.MODEL_ERROR,
      message: "Configured engine binding does not belong to this workspace."
    });
  });

  it("rejects workspace binding reads that point across workspaces", async () => {
    const foreignBinding = {
      binding_id: "binding_foreign",
      workspace_id: "ws_2",
      provider_type: EngineProvider.OPENAI,
      base_url: null,
      api_key: "sk-foreign",
      model: "gpt-4o-mini",
      config: {},
      created_at: "2026-03-18T00:00:00.000Z",
      updated_at: "2026-03-18T00:00:00.000Z"
    };
    const service = new EngineBindingService({
      workspaceRepo: {
        getById: vi.fn(async () => createWorkspace({ default_engine_binding: foreignBinding.binding_id })),
        updateDefaultEngineBinding: vi.fn()
      },
      bindingRepo: {
        upsert: vi.fn(),
        getById: vi.fn(async () => foreignBinding)
      },
      eventPublisher: {
        publishWithMutation: vi.fn()
      } as any,
      engineTester: {
        testBinding: vi.fn()
      }
    });

    await expect(service.getWorkspaceBinding("ws_1")).rejects.toMatchObject({
      code: "CONFLICT",
      message: "Engine binding does not belong to this workspace"
    });
  });

  it("fails honestly when no conversation binding is configured", async () => {
    const service = new EngineBindingService({
      workspaceRepo: {
        getById: vi.fn(async () => createWorkspace()),
        updateDefaultEngineBinding: vi.fn()
      },
      bindingRepo: {
        upsert: vi.fn(),
        getById: vi.fn(async () => null)
      },
      eventPublisher: {
        publishWithMutation: vi.fn()
      } as any,
      engineTester: {
        testBinding: vi.fn()
      }
    });

    await expect(
      service.resolveConversationBinding(createRun(), createWorkspace())
    ).rejects.toMatchObject({
      kind: EngineErrorKind.MODEL_ERROR,
      message: "Conversation engine is not configured."
    });
  });
});

function createWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    workspace_id: "ws_1",
    name: "workspace",
    root_path: "/tmp/workspace",
    workspace_kind: WorkspaceKind.LOCAL_REPO,
    repo_path: null,
    default_engine_binding: null,
    workspace_state: WorkspaceState.ACTIVE,
    created_at: "2026-03-18T00:00:00.000Z",
    archived_at: null,
    ...overrides
  };
}

function createRun(overrides: Partial<Run> = {}): Run {
  return {
    run_id: "run_1",
    workspace_id: "ws_1",
    title: "run",
    goal: null,
    run_mode: RunMode.CHAT,
    engine_binding_id: null,
    engine_class: null,
    run_state: RunState.IDLE,
    current_surface_id: null,
    created_at: "2026-03-18T00:00:00.000Z",
    last_active_at: "2026-03-18T00:00:00.000Z",
    ...overrides
  };
}
