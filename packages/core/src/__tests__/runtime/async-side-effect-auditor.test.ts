import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RuntimeGovernanceEventType,
  type EventLogEntry
} from "@do-soul/alaya-protocol";
import {
  drainAuditedAsyncSideEffects,
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

    await expect(drainAuditedAsyncSideEffects())
      .rejects.toThrow(/1 failed task\(s\).*scheduled work failed/u);

    expect(emitWarning).toHaveBeenCalledWith(
      "[MemoryService] greenService.reevaluate rejected (fire-and-forget)",
      expect.objectContaining({ code: "ALAYA_MEMORY_GREEN_REEVALUATE_FAILED" })
    );
    await expect(drainAuditedAsyncSideEffects({ timeoutMs: 10 }))
      .resolves.toBeUndefined();
  });

  it("includes work scheduled while the drain is in progress", async () => {
    vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
    let resolveOuter: (() => void) | undefined;
    const outer = new Promise<void>((resolve) => {
      resolveOuter = resolve;
    }).then(() => {
      scheduleAuditedAsyncSideEffect(
        Promise.reject(new Error("nested work failed")),
        baseAudit({ operation: "nested_operation" })
      );
    });
    scheduleAuditedAsyncSideEffect(outer, baseAudit({ operation: "outer_operation" }));

    const drain = drainAuditedAsyncSideEffects({ timeoutMs: 1_000 });
    resolveOuter?.();

    await expect(drain)
      .rejects.toThrow(/nested_operation: nested work failed/u);
    await expect(drainAuditedAsyncSideEffects({ timeoutMs: 10 }))
      .resolves.toBeUndefined();
  });

  it("reports concurrent failures in scheduling order", async () => {
    vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
    let rejectFirst: ((error: Error) => void) | undefined;
    let rejectSecond: ((error: Error) => void) | undefined;
    scheduleAuditedAsyncSideEffect(new Promise<void>((_resolve, reject) => {
      rejectFirst = reject;
    }), baseAudit({ operation: "first_operation" }));
    scheduleAuditedAsyncSideEffect(new Promise<void>((_resolve, reject) => {
      rejectSecond = reject;
    }), baseAudit({ operation: "second_operation" }));
    const drain = drainAuditedAsyncSideEffects({ timeoutMs: 1_000 });

    rejectSecond?.(new Error("second failed"));
    await Promise.resolve();
    rejectFirst?.(new Error("first failed"));

    const error = await drain.then(
      () => undefined,
      (failure: unknown) => failure instanceof Error
        ? failure
        : new Error(String(failure))
    );
    expect(error).toBeInstanceOf(AggregateError);
    expect(error!.message.indexOf("first_operation"))
      .toBeLessThan(error!.message.indexOf("second_operation"));
  });

  it("surfaces an audit-report failure without poisoning later drains", async () => {
    vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);

    expect(() => scheduleAuditedAsyncSideEffect(
      Promise.reject(new Error("work failed")),
      baseAudit({
        eventLogRepo: {
          append: vi.fn(async () => {
            throw new Error("audit append failed");
          })
        }
      })
    )).not.toThrow();

    await expect(drainAuditedAsyncSideEffects())
      .rejects.toThrow(/work failed; audit report failed: audit append failed/u);
    await expect(drainAuditedAsyncSideEffects({ timeoutMs: 10 }))
      .resolves.toBeUndefined();
  });

  it("is a no-op for null or undefined work", async () => {
    const emitWarning = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);

    scheduleAuditedAsyncSideEffect(null, baseAudit());
    scheduleAuditedAsyncSideEffect(undefined, baseAudit());

    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(emitWarning).not.toHaveBeenCalled();
  });

  it("waits for scheduled work and removes it after settlement", async () => {
    let resolveWork: (() => void) | undefined;
    const work = new Promise<void>((resolve) => {
      resolveWork = resolve;
    });
    scheduleAuditedAsyncSideEffect(work, baseAudit());
    let drained = false;
    const drain = drainAuditedAsyncSideEffects({ timeoutMs: 1_000 })
      .then(() => { drained = true; });

    await Promise.resolve();
    expect(drained).toBe(false);
    resolveWork?.();
    await drain;
    await expect(drainAuditedAsyncSideEffects({ timeoutMs: 10 }))
      .resolves.toBeUndefined();
  });

  it("fails closed with diagnostics instead of waiting forever", async () => {
    let resolveWork: (() => void) | undefined;
    const work = new Promise<void>((resolve) => {
      resolveWork = resolve;
    });
    scheduleAuditedAsyncSideEffect(work, baseAudit());
    try {
      await expect(drainAuditedAsyncSideEffects({ timeoutMs: 20 }))
        .rejects.toThrow(/timed out after 20ms with 1 task\(s\) pending/u);
    } finally {
      resolveWork?.();
      await drainAuditedAsyncSideEffects({ timeoutMs: 1_000 });
    }
  });
});
