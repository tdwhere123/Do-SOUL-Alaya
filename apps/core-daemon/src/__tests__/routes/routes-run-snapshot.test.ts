import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EngineStatus,
  RunState,
  WorkerRuntimeEventType,
  WorkspaceRunEventType,
  type EventLogEntry,
  type RunHotState
} from "@do-soul/alaya-protocol";
import {
  enrichRunSnapshot,
  resetSnapshotCacheForTesting,
  type SnapshotCursorState
} from "../../routes/run-snapshot.js";

afterEach(() => {
  resetSnapshotCacheForTesting();
  vi.restoreAllMocks();
});

describe("run snapshot route compaction", () => {
  it("fully replays empty-cache deltas when the after-cursor probe is capped", async () => {
    const seedEvent = createEvent("evt-seed", WorkspaceRunEventType.RUN_MESSAGE_APPENDED, {
      run_id: "run-a",
      role: "user",
      content: "seed only",
      message_id: "msg-seed"
    });
    const deltaEvents = Array.from({ length: 501 }, (_, index) =>
      createWorkerIntegrationEvent(index + 1)
    );
    const allEvents = [seedEvent, ...deltaEvents];
    let replayEvents: readonly EventLogEntry[] = [seedEvent];
    const queryByRunAll = vi.fn(async () => {
      throw new Error("queryByRunAll must not be used for snapshot replay");
    });
    const eventLogRepo = {
      queryByRun: vi.fn(async () => allEvents),
      queryByRunAll,
      queryByRunPage: vi.fn(async (_runId: string, page: { readonly limit: number; readonly offset: number }) =>
        replayEvents.slice(page.offset, page.offset + page.limit)
      ),
      queryByRunAfterEventId: vi.fn(async () => deltaEvents.slice(0, 500)),
      queryByRunCursorState: vi.fn(async (): Promise<SnapshotCursorState> => ({
        cursorExists: true,
        eventsUpToCursor: 1,
        latestEventId: "evt-worker-501"
      }))
    };

    await enrichRunSnapshot(createHotState(), "run-a", eventLogRepo, undefined);
    replayEvents = allEvents;
    const snapshot = await enrichRunSnapshot(createHotState(), "run-a", eventLogRepo, undefined);

    expect(eventLogRepo.queryByRunAfterEventId).toHaveBeenCalledWith("run-a", "evt-seed");
    expect(queryByRunAll).not.toHaveBeenCalled();
    expect(eventLogRepo.queryByRunPage).toHaveBeenCalledTimes(3);
    expect(eventLogRepo.queryByRunPage).toHaveBeenLastCalledWith("run-a", {
      limit: 500,
      offset: 500
    });
    expect(snapshot.surface_state.worker_integration_statuses).toHaveLength(501);
    expect(snapshot.surface_state.worker_integration_statuses?.at(-1)).toMatchObject({
      workerRunId: "worker-501"
    });
    expect(snapshot.bootstrap_control_plane_cutoff_event_id).toBe("evt-worker-501");
  });
});

function createHotState(): RunHotState {
  return {
    run_id: "run-a",
    run_state: RunState.IDLE,
    active_surface_id: null,
    last_message_at: null,
    engine_status: EngineStatus.IDLE,
    updated_at: "2026-05-07T00:00:00.000Z"
  };
}

function createWorkerIntegrationEvent(index: number): EventLogEntry {
  return createEvent(`evt-worker-${index}`, WorkerRuntimeEventType.WORKER_INTEGRATION_STATUS, {
    workerRunId: `worker-${index}`,
    level: "soft_stale",
    reason: `integration status ${index}`,
    detectedAt: "2026-05-07T00:00:00.000Z"
  });
}

function createEvent(
  eventId: string,
  eventType: EventLogEntry["event_type"],
  payload: Record<string, unknown>
): EventLogEntry {
  return {
    event_id: eventId,
    event_type: eventType,
    entity_type: "run",
    entity_id: "run-a",
    workspace_id: "workspace-a",
    run_id: "run-a",
    caused_by: "test",
    revision: Number(eventId.replace(/\D+/g, "")) || 1,
    payload_json: payload,
    created_at: "2026-05-07T00:00:00.000Z"
  };
}
