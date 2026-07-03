import { describe, expect, it, vi } from "vitest";
import { EngineStatus, WorkspaceRunEventType, type Run } from "@do-soul/alaya-protocol";
import { RunHotStateService } from "../../runs/run-hot-state-service.js";

function createRun(overrides: Partial<Run> = {}): Run {
  return {
    run_id: "run-1",
    workspace_id: "workspace-1",
    title: "streamed run",
    goal: null,
    run_mode: "chat",
    engine_binding_id: null,
    engine_class: null,
    current_surface_id: null,
    run_state: "active",
    created_at: "2026-04-12T00:00:00.000Z",
    last_active_at: "2026-04-12T00:00:20.000Z",
    ...overrides
  };
}

describe("RunHotStateService", () => {
  it("rehydrates last_message_at from streamed assistant completion events", async () => {
    const run = createRun();
    const service = new RunHotStateService({
      runRepo: {
        getById: vi.fn(async (runId: string) => (runId === run.run_id ? run : null))
      },
      eventLogRepo: {
        getLatestMessageTimestampByRun: vi.fn(async () => "2026-04-12T00:00:15.000Z")
      }
    });

    await expect(service.getSnapshot("run-1")).resolves.toEqual({
      run_id: "run-1",
      run_state: "active",
      active_surface_id: null,
      last_message_at: "2026-04-12T00:00:15.000Z",
      engine_status: EngineStatus.IDLE,
      updated_at: "2026-04-12T00:00:20.000Z"
    });
  });

  it("returns null when the run does not exist", async () => {
    const service = new RunHotStateService({
      runRepo: {
        getById: vi.fn(async () => null)
      },
      eventLogRepo: {
        getLatestMessageTimestampByRun: vi.fn(async () => null)
      }
    });

    await expect(service.getSnapshot("missing-run")).resolves.toBeNull();
  });

  it("rehydrates with last_message_at null when no message events exist", async () => {
    const service = new RunHotStateService({
      runRepo: {
        getById: vi.fn(async () => createRun())
      },
      eventLogRepo: {
        getLatestMessageTimestampByRun: vi.fn(async () => null)
      }
    });

    await expect(service.getSnapshot("run-1")).resolves.toEqual({
      run_id: "run-1",
      run_state: "active",
      active_surface_id: null,
      last_message_at: null,
      engine_status: EngineStatus.IDLE,
      updated_at: "2026-04-12T00:00:20.000Z"
    });
  });

  it("updates state through run lifecycle apply events", async () => {
    const service = new RunHotStateService({
      runRepo: {
        getById: vi.fn(async () => null)
      },
      eventLogRepo: {
        getLatestMessageTimestampByRun: vi.fn(async () => null)
      }
    });

    await service.apply({
      event_id: "evt-run-created",
      event_type: WorkspaceRunEventType.RUN_CREATED,
      entity_type: "run",
      entity_id: "run-1",
      workspace_id: "workspace-1",
      run_id: "run-1",
      caused_by: "user_action",
      revision: 0,
      created_at: "2026-04-12T00:00:00.000Z",
      payload: {
        run_id: "run-1",
        workspace_id: "workspace-1",
        run_mode: "chat",
        title: "streamed run"
      }
    });
    await expect(service.getSnapshot("run-1")).resolves.toMatchObject({
      run_state: "idle",
      engine_status: EngineStatus.IDLE,
      last_message_at: null,
      updated_at: "2026-04-12T00:00:00.000Z"
    });

    await service.apply({
      event_id: "evt-message-appended",
      event_type: WorkspaceRunEventType.RUN_MESSAGE_APPENDED,
      entity_type: "message",
      entity_id: "msg-user-1",
      workspace_id: "workspace-1",
      run_id: "run-1",
      caused_by: "user_action",
      revision: 1,
      created_at: "2026-04-12T00:00:05.000Z",
      payload: {
        run_id: "run-1",
        role: "user",
        content: "hello",
        message_id: "msg-user-1"
      }
    });
    await expect(service.getSnapshot("run-1")).resolves.toMatchObject({
      run_state: "active",
      engine_status: EngineStatus.STREAMING,
      last_message_at: "2026-04-12T00:00:05.000Z",
      updated_at: "2026-04-12T00:00:05.000Z"
    });

    await service.apply({
      event_id: "evt-engine-response",
      event_type: WorkspaceRunEventType.ENGINE_RESPONSE_RECEIVED,
      entity_type: "message",
      entity_id: "msg-asst-1",
      workspace_id: "workspace-1",
      run_id: "run-1",
      caused_by: "engine",
      revision: 2,
      created_at: "2026-04-12T00:00:15.000Z",
      payload: {
        run_id: "run-1",
        message_id: "msg-asst-1",
        content: "world",
        finish_reason: "stop"
      }
    });
    await expect(service.getSnapshot("run-1")).resolves.toMatchObject({
      run_state: "active",
      engine_status: EngineStatus.IDLE,
      last_message_at: "2026-04-12T00:00:15.000Z",
      updated_at: "2026-04-12T00:00:15.000Z"
    });

    await service.apply({
      event_id: "evt-run-deleted",
      event_type: WorkspaceRunEventType.RUN_DELETED,
      entity_type: "run",
      entity_id: "run-1",
      workspace_id: "workspace-1",
      run_id: "run-1",
      caused_by: "user_action",
      revision: 3,
      created_at: "2026-04-12T00:00:20.000Z",
      payload: {
        run_id: "run-1",
        workspace_id: "workspace-1"
      }
    });
    await expect(service.getSnapshot("run-1")).resolves.toBeNull();
  });

  it("updates engine status and last_message_at via setEngineStatus", async () => {
    const service = new RunHotStateService({
      runRepo: {
        getById: vi.fn(async () => null)
      },
      eventLogRepo: {
        getLatestMessageTimestampByRun: vi.fn(async () => null)
      }
    });

    await service.setEngineStatus(
      "run-1",
      EngineStatus.ERROR,
      "2026-04-12T00:00:30.000Z",
      "2026-04-12T00:00:25.000Z"
    );

    await expect(service.getSnapshot("run-1")).resolves.toEqual({
      run_id: "run-1",
      run_state: "active",
      active_surface_id: null,
      last_message_at: "2026-04-12T00:00:25.000Z",
      engine_status: EngineStatus.ERROR,
      updated_at: "2026-04-12T00:00:30.000Z"
    });
  });

  it("bounds cached snapshots and refreshes recently used runs", async () => {
    const service = new RunHotStateService({
      runRepo: {
        getById: vi.fn(async (runId: string) => createRun({ run_id: runId }))
      },
      eventLogRepo: {
        getLatestMessageTimestampByRun: vi.fn(async () => null)
      },
      maxSnapshots: 2
    });
    const cacheView = service as unknown as {
      readonly snapshots: ReadonlyMap<string, unknown>;
    };

    await service.getSnapshot("run-1");
    await service.getSnapshot("run-2");
    await service.getSnapshot("run-1");
    await service.getSnapshot("run-3");

    expect([...cacheView.snapshots.keys()]).toEqual(["run-1", "run-3"]);

    await service.apply({
      event_id: "evt-run-deleted",
      event_type: WorkspaceRunEventType.RUN_DELETED,
      entity_type: "run",
      entity_id: "run-1",
      workspace_id: "workspace-1",
      run_id: "run-1",
      caused_by: "user_action",
      revision: 4,
      created_at: "2026-04-12T00:00:40.000Z",
      payload: {
        run_id: "run-1",
        workspace_id: "workspace-1"
      }
    });

    expect([...cacheView.snapshots.keys()]).toEqual(["run-3"]);
  });
});
