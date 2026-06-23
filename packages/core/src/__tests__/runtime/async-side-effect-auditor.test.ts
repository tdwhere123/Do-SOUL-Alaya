import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RuntimeGovernanceEventType,
  type EventLogEntry
} from "@do-soul/alaya-protocol";
import {
  reportAsyncSideEffectFailure,
  scheduleAuditedAsyncSideEffect,
  type AuditedAsyncSideEffect
} from "../../runtime/async-side-effect-auditor.js";

function baseAudit(overrides: Partial<AuditedAsyncSideEffect> = {}): AuditedAsyncSideEffect {
  return {
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
    now: () => "2026-06-18T00:00:00.000Z",
    ...overrides
  };
}

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
      baseAudit({
        eventLogRepo: { append },
        runtimeNotifier: { notifyEntry }
      }),
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

  it("emits exactly one structured warning and skips append when no event-log repo is wired", async () => {
    const emitWarning = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);

    await reportAsyncSideEffectFailure(baseAudit({ eventLogRepo: undefined }), new Error("green unavailable"));

    expect(emitWarning).toHaveBeenCalledTimes(1);
    expect(emitWarning).toHaveBeenCalledWith(
      "[MemoryService] greenService.reevaluate rejected (fire-and-forget)",
      expect.objectContaining({ code: "ALAYA_MEMORY_GREEN_REEVALUATE_FAILED" })
    );
    expect(emitWarning).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ code: "ALAYA_ASYNC_SIDE_EFFECT_AUDIT_APPEND_FAILED" })
    );
  });

  it("resolves and emits a second append-failure warning when the append port throws", async () => {
    const emitWarning = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
    const append = vi.fn(async () => {
      throw new Error("event log offline");
    });

    await expect(
      reportAsyncSideEffectFailure(baseAudit({ eventLogRepo: { append } }), new Error("green unavailable"))
    ).resolves.toBeUndefined();

    expect(emitWarning).toHaveBeenCalledTimes(2);
    expect(emitWarning).toHaveBeenNthCalledWith(
      1,
      "[MemoryService] greenService.reevaluate rejected (fire-and-forget)",
      expect.objectContaining({ code: "ALAYA_MEMORY_GREEN_REEVALUATE_FAILED" })
    );
    expect(emitWarning).toHaveBeenNthCalledWith(
      2,
      "[AsyncSideEffectAudit] failed to append async side-effect failure event",
      expect.objectContaining({
        code: "ALAYA_ASYNC_SIDE_EFFECT_AUDIT_APPEND_FAILED",
        detail: expect.stringContaining("event log offline")
      })
    );
  });

  it("resolves and emits a second append-failure warning when the notifier port throws", async () => {
    const emitWarning = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
    const append = vi.fn(
      async (entry: Omit<EventLogEntry, "event_id" | "created_at" | "revision">): Promise<EventLogEntry> => ({
        event_id: "event-side-effect-1",
        created_at: "2026-06-18T01:00:00.000Z",
        revision: 0,
        ...entry
      })
    );
    const notifyEntry = vi.fn(async () => {
      throw new Error("notifier down");
    });

    await expect(
      reportAsyncSideEffectFailure(
        baseAudit({ eventLogRepo: { append }, runtimeNotifier: { notifyEntry } }),
        new Error("green unavailable")
      )
    ).resolves.toBeUndefined();

    expect(notifyEntry).toHaveBeenCalledTimes(1);
    expect(emitWarning).toHaveBeenCalledTimes(2);
    expect(emitWarning).toHaveBeenNthCalledWith(
      2,
      "[AsyncSideEffectAudit] failed to append async side-effect failure event",
      expect.objectContaining({
        code: "ALAYA_ASYNC_SIDE_EFFECT_AUDIT_APPEND_FAILED",
        detail: expect.stringContaining("notifier down")
      })
    );
  });

  it("catches a rejected scheduled side-effect and reports it without throwing to the caller", async () => {
    const emitWarning = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);

    expect(() =>
      scheduleAuditedAsyncSideEffect(Promise.reject(new Error("scheduled work failed")), baseAudit())
    ).not.toThrow();

    // Let the fire-and-forget catch + report microtasks settle.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(emitWarning).toHaveBeenCalledWith(
      "[MemoryService] greenService.reevaluate rejected (fire-and-forget)",
      expect.objectContaining({ code: "ALAYA_MEMORY_GREEN_REEVALUATE_FAILED" })
    );
  });

  it("is a no-op for null or undefined work", async () => {
    const emitWarning = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);

    scheduleAuditedAsyncSideEffect(null, baseAudit());
    scheduleAuditedAsyncSideEffect(undefined, baseAudit());

    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(emitWarning).not.toHaveBeenCalled();
  });
});
