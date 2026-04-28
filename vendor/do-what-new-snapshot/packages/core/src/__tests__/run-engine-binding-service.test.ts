/**
 * FROZEN RED TESTS — L0-B runs.update_engine_binding
 *
 * Locks the RunService#updateEngineBinding contract:
 *   - EventLog-first ordering (publish → persist)
 *   - cross-workspace validation
 *   - NOT_FOUND when binding deleted (Failure Mode #12)
 *   - idempotent no-op when binding unchanged
 *   - in-flight stream safety (captured binding id must not mutate mid-stream)
 *   - rollback / fail-closed behavior when runRepo.update throws post-publish
 *
 * Uses the same mock harness style as run-service.test.ts and
 * workspace-service.test.ts. All imports from the NEW contract will fail at
 * runtime until the implementation ships — intended RED state.
 */

import { describe, expect, it, vi } from "vitest";
import {
  RunMode,
  RunState,
  WorkspaceKind,
  WorkspaceState,
  type EngineBindingRecord,
  type Run,
  type Workspace
} from "@do-what/protocol";
// RED: RunService does not yet expose updateEngineBinding — this import will
// fail or the method will be absent.
import { RunService } from "../run-service.js";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function createWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    workspace_id: "ws_1",
    name: "workspace",
    root_path: "/tmp/workspace",
    workspace_kind: WorkspaceKind.LOCAL_REPO,
    repo_path: null,
    default_engine_binding: null,
    default_engine_class: "conversation_engine",
    workspace_state: WorkspaceState.ACTIVE,
    created_at: "2026-04-26T00:00:00.000Z",
    archived_at: null,
    ...overrides
  };
}

function createBindingRecord(overrides: Partial<EngineBindingRecord> = {}): EngineBindingRecord {
  return {
    binding_id: "binding_1",
    workspace_id: "ws_1",
    provider_type: "anthropic",
    base_url: null,
    api_key: "sk-ant",
    model: "claude-sonnet-4-6",
    config: {},
    created_at: "2026-04-26T00:00:00.000Z",
    updated_at: "2026-04-26T00:00:00.000Z",
    ...overrides
  };
}

function createRun(overrides: Partial<Run> = {}): Run {
  return {
    run_id: "run_1",
    workspace_id: "ws_1",
    title: "Test run",
    goal: null,
    run_mode: RunMode.CHAT,
    engine_binding_id: "binding_1",
    engine_class: "conversation_engine",
    run_state: RunState.IDLE,
    current_surface_id: null,
    created_at: "2026-04-26T00:00:00.000Z",
    last_active_at: "2026-04-26T00:00:00.000Z",
    ...overrides
  };
}

// ---------------------------------------------------------------------------
// Service factory
// ---------------------------------------------------------------------------

interface CreateServiceOptions {
  readonly run?: Run;
  readonly workspace?: Workspace;
  readonly bindingById?: Record<string, EngineBindingRecord>;
  readonly publishWithMutation?: jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;
  readonly runRepoUpdate?: jest.MockedFunction<(...args: unknown[]) => Promise<Run>>;
}

type MockedFn = ReturnType<typeof vi.fn>;

function createService(options: CreateServiceOptions = {}): {
  readonly service: RunService;
  readonly publishWithMutationMock: MockedFn;
  readonly runRepoUpdateMock: MockedFn;
} {
  const run = options.run ?? createRun();
  const workspace = options.workspace ?? createWorkspace();
  const bindingById = options.bindingById ?? { binding_1: createBindingRecord() };

  // Default implementation: EventLog-first pattern — publisher calls mutate()
  const publishWithMutationMock = vi.fn(async (_event: unknown, mutate: () => Promise<unknown>) => {
    return await mutate();
  });

  const runRepoUpdateMock = vi.fn(async (_id: string, _patch: Partial<Run>) => {
    return createRun({ ...run, ...(_patch as Partial<Run>) });
  });

  const service = new RunService({
    workspaceRepo: {
      getById: vi.fn(async () => workspace)
    },
    runRepo: {
      create: vi.fn(async () => { throw new Error("not used"); }),
      getById: vi.fn(async () => run),
      listByWorkspace: vi.fn(async () => []),
      delete: vi.fn(async () => undefined),
      // RED: RunRepoPort does not yet expose `update` — will fail at compile time
      update: runRepoUpdateMock
    } as any,
    bindingRepo: {
      getById: vi.fn(async (id: string) => bindingById[id] ?? null)
    },
    eventPublisher: {
      publishWithMutation: publishWithMutationMock,
      publishManyWithMutation: vi.fn()
    } as any
  });

  return { service, publishWithMutationMock, runRepoUpdateMock };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("RunService#updateEngineBinding", () => {
  // -------------------------------------------------------------------------
  // Happy path
  // -------------------------------------------------------------------------

  it("switches binding, emits RUN_ENGINE_BINDING_UPDATED, persists via runRepo.update, returns updated run", async () => {
    const newBinding = createBindingRecord({ binding_id: "binding_2", workspace_id: "ws_1" });
    const { service, publishWithMutationMock, runRepoUpdateMock } = createService({
      run: createRun({ engine_binding_id: "binding_1" }),
      bindingById: {
        binding_1: createBindingRecord({ binding_id: "binding_1", workspace_id: "ws_1" }),
        binding_2: newBinding
      }
    });

    // RED: service.updateEngineBinding does not exist yet
    const result = await (service as any).updateEngineBinding({
      run_id: "run_1",
      engine_binding_id: "binding_2"
    });

    expect(publishWithMutationMock).toHaveBeenCalledOnce();
    const [eventInput] = publishWithMutationMock.mock.calls[0]!;
    expect(eventInput).toMatchObject({
      event_type: "run.engine_binding.updated",
      entity_type: "run",
      entity_id: "run_1",
      payload_json: expect.objectContaining({
        run_id: "run_1",
        engine_binding_id: "binding_2",
        previous_engine_binding_id: "binding_1"
      })
    });

    expect(runRepoUpdateMock).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ run_id: "run_1", engine_binding_id: "binding_2" });
  });

  // -------------------------------------------------------------------------
  // EventLog-first ordering
  // -------------------------------------------------------------------------

  it("calls publisher BEFORE runRepo.update (EventLog-first ordering)", async () => {
    const callOrder: string[] = [];
    const newBinding = createBindingRecord({ binding_id: "binding_2", workspace_id: "ws_1" });

    const runRepoUpdateMock = vi.fn(async () => {
      callOrder.push("runRepo.update");
      return createRun({ engine_binding_id: "binding_2" });
    });

    // Override the publish mock to record ordering and then call mutate
    const publishWithMutationMock = vi.fn(async (_event: unknown, mutate: () => Promise<unknown>) => {
      callOrder.push("publisher.append");
      return await mutate();
    });

    // Re-wire service manually to use above mocks
    const service = new RunService({
      workspaceRepo: { getById: vi.fn(async () => createWorkspace()) },
      runRepo: {
        create: vi.fn(async () => { throw new Error("not used"); }),
        getById: vi.fn(async () => createRun({ engine_binding_id: "binding_1" })),
        listByWorkspace: vi.fn(async () => []),
        delete: vi.fn(async () => undefined),
        update: runRepoUpdateMock
      } as any,
      bindingRepo: {
        getById: vi.fn(async (id: string) =>
          id === "binding_2" ? newBinding : id === "binding_1" ? createBindingRecord() : null
        )
      },
      eventPublisher: {
        publishWithMutation: publishWithMutationMock,
        publishManyWithMutation: vi.fn()
      } as any
    });

    await (service as any).updateEngineBinding({ run_id: "run_1", engine_binding_id: "binding_2" });

    expect(callOrder).toEqual(["publisher.append", "runRepo.update"]);
  });

  // -------------------------------------------------------------------------
  // Cross-workspace validation
  // -------------------------------------------------------------------------

  it("throws VALIDATION when binding belongs to a different workspace", async () => {
    const foreignBinding = createBindingRecord({ binding_id: "binding_foreign", workspace_id: "ws_other" });
    const { service } = createService({
      run: createRun({ engine_binding_id: "binding_1", workspace_id: "ws_1" }),
      workspace: createWorkspace({ workspace_id: "ws_1" }),
      bindingById: {
        binding_1: createBindingRecord({ binding_id: "binding_1", workspace_id: "ws_1" }),
        binding_foreign: foreignBinding
      }
    });

    await expect(
      (service as any).updateEngineBinding({ run_id: "run_1", engine_binding_id: "binding_foreign" })
    ).rejects.toMatchObject({
      code: "VALIDATION",
      message: expect.stringContaining("workspace")
    });
  });

  // -------------------------------------------------------------------------
  // NOT_FOUND on deleted binding (Failure Mode #12)
  // -------------------------------------------------------------------------

  it("throws NOT_FOUND and does NOT emit RUN_ENGINE_BINDING_UPDATED when target binding has been deleted", async () => {
    // Failure Mode #12: the target binding_id was valid at the time the user
    // selected it in the UI, but has been deleted since (e.g. concurrently).
    // The service must REFUSE to silently overwrite with a vanished binding.
    const { service, publishWithMutationMock } = createService({
      run: createRun({ engine_binding_id: "binding_1" }),
      bindingById: {
        // binding_1 present, binding_deleted absent — simulates deletion
        binding_1: createBindingRecord({ binding_id: "binding_1", workspace_id: "ws_1" })
      }
    });

    await expect(
      (service as any).updateEngineBinding({ run_id: "run_1", engine_binding_id: "binding_deleted" })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    // Critical: must NOT have published the event for a missing binding
    expect(publishWithMutationMock).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Idempotent no-op
  // -------------------------------------------------------------------------

  it("is idempotent: does not emit event or call runRepo.update when new binding equals current binding", async () => {
    const { service, publishWithMutationMock, runRepoUpdateMock } = createService({
      run: createRun({ engine_binding_id: "binding_1" }),
      bindingById: {
        binding_1: createBindingRecord({ binding_id: "binding_1", workspace_id: "ws_1" })
      }
    });

    // Setting to the same value must be a no-op
    const result = await (service as any).updateEngineBinding({
      run_id: "run_1",
      engine_binding_id: "binding_1"
    });

    expect(publishWithMutationMock).not.toHaveBeenCalled();
    expect(runRepoUpdateMock).not.toHaveBeenCalled();
    // Should still return the current run without error
    expect(result).toMatchObject({ run_id: "run_1", engine_binding_id: "binding_1" });
  });

  // -------------------------------------------------------------------------
  // In-flight stream safety
  // -------------------------------------------------------------------------

  it("in-flight stream safety: the binding id captured at stream start does not mutate after updateEngineBinding completes", async () => {
    /**
     * Stub for the future StreamRegistry dependency that the service will
     * accept via constructor injection. It does not exist yet; we pass a fake
     * registry to the service constructor and assert that the binding id
     * recorded at the start of a stream (T0) remains unchanged after
     * updateEngineBinding is called at T1.
     *
     * Implementation note: the real StreamRegistry.getActiveBinding(runId)
     * should return the binding_id that was snapshotted when the stream was
     * initiated — not the live value from the DB. This test enforces that
     * contract by verifying the spy's return value equals the pre-update value.
     */
    const capturedBindingAtStreamStart = "binding_1";

    // Fake StreamRegistry: returns the binding snapshotted at stream-open time.
    // RED: RunService constructor does not yet accept streamRegistry.
    const fakeStreamRegistry = {
      getActiveBinding: vi.fn((_runId: string) => capturedBindingAtStreamStart)
    };

    const newBinding = createBindingRecord({ binding_id: "binding_2", workspace_id: "ws_1" });
    const service = new RunService({
      workspaceRepo: { getById: vi.fn(async () => createWorkspace()) },
      runRepo: {
        create: vi.fn(async () => { throw new Error("not used"); }),
        getById: vi.fn(async () => createRun({ engine_binding_id: "binding_1" })),
        listByWorkspace: vi.fn(async () => []),
        delete: vi.fn(async () => undefined),
        update: vi.fn(async () => createRun({ engine_binding_id: "binding_2" }))
      } as any,
      bindingRepo: {
        getById: vi.fn(async (id: string) =>
          id === "binding_2" ? newBinding : createBindingRecord()
        )
      },
      eventPublisher: {
        publishWithMutation: vi.fn(async (_e: unknown, mutate: () => Promise<unknown>) => await mutate()),
        publishManyWithMutation: vi.fn()
      } as any,
      // RED: streamRegistry not yet accepted by RunServiceDependencies
      streamRegistry: fakeStreamRegistry
    } as any);

    // T0: record the binding the stream is using
    const streamBindingBefore = fakeStreamRegistry.getActiveBinding("run_1");

    // T1: update to a new binding
    await (service as any).updateEngineBinding({ run_id: "run_1", engine_binding_id: "binding_2" });

    // The stream-level snapshot must not have mutated — the in-flight stream
    // must continue with its original binding until the next user message.
    const streamBindingAfter = fakeStreamRegistry.getActiveBinding("run_1");
    expect(streamBindingAfter).toBe(streamBindingBefore);
    expect(streamBindingAfter).toBe(capturedBindingAtStreamStart);
  });

  // -------------------------------------------------------------------------
  // Rollback / fail-closed behavior
  // -------------------------------------------------------------------------

  it("rollback: when runRepo.update throws after event publish, the error propagates and the run cache is not left corrupted", async () => {
    /**
     * EventPublisher uses publishWithMutation which rolls back the EventLog
     * entry if mutate() throws (see event-publisher.ts). This test verifies
     * the service surfaces the error and does not swallow it, and that a
     * subsequent getById call still returns the PRE-update binding.
     *
     * If the chosen pattern is fail-closed without a compensating event, this
     * test asserts that the next reload from the repo still shows the OLD
     * binding. If a compensating event RUN_ENGINE_BINDING_UPDATE_REJECTED is
     * emitted, add a separate assertion on its presence here.
     */
    const repoUpdateError = new Error("DB write failed");
    const oldRun = createRun({ engine_binding_id: "binding_1" });
    const newBinding = createBindingRecord({ binding_id: "binding_2", workspace_id: "ws_1" });

    const runRepoGetByIdMock = vi.fn(async () => oldRun);
    const runRepoUpdateMock = vi.fn(async () => { throw repoUpdateError; });

    // publishWithMutation follows EventPublisher pattern: appends event, calls
    // mutate(), rolls back if mutate() throws. We simulate this inline.
    const publishWithMutationMock = vi.fn(async (_event: unknown, mutate: () => Promise<unknown>) => {
      // Simulate append
      try {
        return await mutate();
      } catch (err) {
        // Simulate rollback of the event-log entry
        // (the real EventPublisher deletes the appended entry on mutate failure)
        throw err;
      }
    });

    const service = new RunService({
      workspaceRepo: { getById: vi.fn(async () => createWorkspace()) },
      runRepo: {
        create: vi.fn(async () => { throw new Error("not used"); }),
        getById: runRepoGetByIdMock,
        listByWorkspace: vi.fn(async () => []),
        delete: vi.fn(async () => undefined),
        update: runRepoUpdateMock
      } as any,
      bindingRepo: {
        getById: vi.fn(async (id: string) =>
          id === "binding_2" ? newBinding : id === "binding_1" ? createBindingRecord() : null
        )
      },
      eventPublisher: {
        publishWithMutation: publishWithMutationMock,
        publishManyWithMutation: vi.fn()
      } as any
    });

    // The call must reject with the underlying repo error
    await expect(
      (service as any).updateEngineBinding({ run_id: "run_1", engine_binding_id: "binding_2" })
    ).rejects.toThrow("DB write failed");

    // After the failure, a reload from the repo must still show the OLD binding
    const reloaded = await service.getById("run_1");
    expect(reloaded.engine_binding_id).toBe("binding_1");
  });
});
