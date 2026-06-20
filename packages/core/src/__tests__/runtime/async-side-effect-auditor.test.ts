import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RuntimeGovernanceEventType,
  type EventLogEntry
} from "@do-soul/alaya-protocol";
import { reportAsyncSideEffectFailure } from "../../runtime/async-side-effect-auditor.js";

describe("async side-effect auditor", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("records fire-and-forget failures as EventLog audit rows", async () => {
    const emitWarning = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
    const append = vi.fn(
      async (entry: Omit<EventLogEntry, "event_id" | "created_at" | "revision">): Promise<EventLogEntry> => ({
        event_id: "event-side-effect-1",
        created_at: "2026-06-18T01:00:00.000Z",
        revision: 0,
        ...entry
      })
    );
    const notifyEntry = vi.fn(async () => undefined);

    await reportAsyncSideEffectFailure(
      {
        source: "MemoryService",
        operation: "green_reevaluate_after_memory_create",
        subjectType: "memory_entry",
        subjectId: "memory-1",
        workspaceId: "workspace-1",
        runId: "run-1",
        causedBy: "user-1",
        committedEventId: "event-memory-created",
        warningCode: "ALAYA_MEMORY_GREEN_REEVALUATE_FAILED",
        warningMessage: "[MemoryService] greenService.reevaluate rejected (fire-and-forget)",
        eventLogRepo: { append },
        runtimeNotifier: { notifyEntry },
        now: () => "2026-06-18T00:00:00.000Z"
      },
      new Error("green unavailable")
    );

    expect(emitWarning).toHaveBeenCalledWith(
      "[MemoryService] greenService.reevaluate rejected (fire-and-forget)",
      expect.objectContaining({ code: "ALAYA_MEMORY_GREEN_REEVALUATE_FAILED" })
    );
    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: RuntimeGovernanceEventType.RUNTIME_SIDE_EFFECT_FAILED,
        entity_type: "memory_entry",
        entity_id: "memory-1",
        workspace_id: "workspace-1",
        run_id: "run-1",
        caused_by: "user-1",
        payload_json: expect.objectContaining({
          source: "MemoryService",
          operation: "green_reevaluate_after_memory_create",
          committed_event_id: "event-memory-created",
          error_message: "green unavailable"
        })
      })
    );
    expect(notifyEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: RuntimeGovernanceEventType.RUNTIME_SIDE_EFFECT_FAILED,
        entity_id: "memory-1"
      })
    );
  });
});
