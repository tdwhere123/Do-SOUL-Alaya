import { describe, expect, it, vi } from "vitest";
import type { RuntimeEvent } from "@do-soul/alaya-protocol";
import { CoreError } from "../../shared/errors.js";
import { ScriptedRuntimeAdapter } from "../../test-doubles/scripted-runtime-adapter.js";
import {
  FIXED_NOW,
  FIXED_WORKER_RUN_ID,
  createDispatchInput,
  createHarness,
  createManualRuntimeAdapter,
  createWorkerRun,
  flushAsync,
  flushRecoveryGracePeriod,
  flushTimerTick,
  messageDeltaEvent,
  sessionFinishedEvent
} from "./serial-delegation-service-test-fixtures.js";

describe("SerialDelegationService", () => {
  it("forwards runtime events to the normalizer with workspace, principal, and worker context", async () => {
    const harness = createHarness([
      messageDeltaEvent("First chunk.", 0),
      sessionFinishedEvent("completed", "done")
    ]);
    const completeSpy = vi.spyOn(harness.workerRunLifecycle, "complete");

    await harness.service.dispatch(createDispatchInput());
    await (harness.runtimeAdapter as ScriptedRuntimeAdapter).replay();
    await flushAsync();

    expect(harness.eventNormalizer.normalize).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        type: "message_delta",
        delta: "First chunk."
      }),
      {
        workspaceId: "ws-serial-delegation",
        principalRunId: "principal-run-1",
        workerRunId: FIXED_WORKER_RUN_ID
      }
    );
    expect(completeSpy).toHaveBeenCalledWith(FIXED_WORKER_RUN_ID, []);
  });

  it("aborts the worker when the runtime session finishes with failed status", async () => {
    const harness = createHarness([sessionFinishedEvent("failed", "tool execution failed")]);
    const abortSpy = vi.spyOn(harness.workerRunLifecycle, "abort");

    await harness.service.dispatch(createDispatchInput());
    await (harness.runtimeAdapter as ScriptedRuntimeAdapter).replay();
    await flushAsync();

    expect(abortSpy).toHaveBeenCalledWith(FIXED_WORKER_RUN_ID, {
      reason: "tool execution failed",
      rollbackAttempted: false
    });
  });

  it("aborts the worker when the runtime session finishes with cancelled status and no summary", async () => {
    const harness = createHarness([sessionFinishedEvent("cancelled", null)]);
    const abortSpy = vi.spyOn(harness.workerRunLifecycle, "abort");

    await harness.service.dispatch(createDispatchInput());
    await (harness.runtimeAdapter as ScriptedRuntimeAdapter).replay();
    await flushAsync();

    expect(abortSpy).toHaveBeenCalledWith(FIXED_WORKER_RUN_ID, {
      reason: "cancelled",
      rollbackAttempted: false
    });
  });

  it("unsubscribes from runtime events after session_finished", async () => {
    const harness = createHarness([
      messageDeltaEvent("before finish", 0),
      sessionFinishedEvent("completed", "done"),
      messageDeltaEvent("after finish", 1)
    ]);

    await harness.service.dispatch(createDispatchInput());
    await (harness.runtimeAdapter as ScriptedRuntimeAdapter).replay();
    await flushAsync();

    expect(harness.eventNormalizer.normalize).toHaveBeenCalledTimes(2);
    expect(
      harness.eventNormalizer.normalize.mock.calls.some((call) => {
        const event = call[0];
        return event?.type === "message_delta" && event.delta === "after finish";
      })
    ).toBe(false);
  });

  it("suppresses already-queued trailing events after session_finished closes the session", async () => {
    const manual = createManualRuntimeAdapter();
    const harness = createHarness([], { runtimeAdapter: manual.adapter });

    await harness.service.dispatch(createDispatchInput());
    manual.emit({
      ...messageDeltaEvent("before finish", 0),
      session_id: "scripted-session-1"
    });
    manual.emit({
      ...sessionFinishedEvent("completed", "done"),
      session_id: "scripted-session-1"
    });
    manual.emit({
      ...messageDeltaEvent("after finish", 1),
      session_id: "scripted-session-1"
    });
    await flushAsync();
    await flushAsync();

    expect(harness.eventNormalizer.normalize).toHaveBeenCalledTimes(2);
    expect(
      harness.eventNormalizer.normalize.mock.calls.some(
        (call) => call[0]?.type === "message_delta" && call[0].delta === "after finish"
      )
    ).toBe(false);
  });

  it("cancels runtime, clears normalizer state, and freezes before reporting startup failures", async () => {
    const reportAsyncFailure = vi.fn(async () => undefined);
    const harness = createHarness([messageDeltaEvent("should not leak", 0)], {
      reportAsyncFailure
    });
    const freezeSpy = vi.spyOn(harness.workerRunLifecycle, "freeze");
    const cancelSpy = vi.spyOn(harness.runtimeAdapter, "cancel");

    vi.spyOn(harness.runtimeAdapter, "prompt").mockRejectedValueOnce(new Error("prompt exploded"));

    await expect(harness.service.dispatch(createDispatchInput())).rejects.toThrow("prompt exploded");

    expect(cancelSpy).toHaveBeenCalledWith("session-1");
    expect(harness.eventNormalizer.clearSessionState).toHaveBeenCalledWith("session-1");
    expect(freezeSpy).toHaveBeenCalledWith(
      FIXED_WORKER_RUN_ID,
      "serial_delegation_startup",
      "runtime startup failure"
    );
    expect(reportAsyncFailure).toHaveBeenCalledWith(expect.any(Error), {
      phase: "startup",
      workerRunId: FIXED_WORKER_RUN_ID,
      sessionId: "session-1"
    });
    expect(freezeSpy.mock.invocationCallOrder[0]).toBeLessThan(
      reportAsyncFailure.mock.invocationCallOrder[0]!
    );
    expect(harness.getById(FIXED_WORKER_RUN_ID)).toEqual(
      createWorkerRun({
        worker_run_id: FIXED_WORKER_RUN_ID,
        state: "frozen",
        updated_at: FIXED_NOW
      })
    );

    await (harness.runtimeAdapter as ScriptedRuntimeAdapter).replay();
    await flushAsync();

    expect(harness.eventNormalizer.normalize).not.toHaveBeenCalled();
  });

  it("keeps a terminal worker terminal when prompt rejects after session_finished already completed", async () => {
    const reportAsyncFailure = vi.fn(async () => undefined);
    const manual = createManualRuntimeAdapter({
      prompt: async (sessionId, _input, emit) => {
        emit({
          ...sessionFinishedEvent("completed", "done"),
          session_id: sessionId
        });
        throw new Error("prompt exploded");
      }
    });
    const harness = createHarness([], {
      runtimeAdapter: manual.adapter,
      reportAsyncFailure
    });
    const freezeSpy = vi.spyOn(harness.workerRunLifecycle, "freeze");

    await expect(harness.service.dispatch(createDispatchInput())).rejects.toThrow("prompt exploded");
    await flushAsync();
    await flushAsync();

    expect(freezeSpy).not.toHaveBeenCalled();
    expect(harness.getById(FIXED_WORKER_RUN_ID)).toEqual(
      createWorkerRun({
        worker_run_id: FIXED_WORKER_RUN_ID,
        state: "completed",
        updated_at: FIXED_NOW
      })
    );
    expect(reportAsyncFailure).toHaveBeenCalledWith(expect.any(Error), {
      phase: "startup",
      workerRunId: FIXED_WORKER_RUN_ID,
      sessionId: "scripted-session-1"
    });
  });

  it("does not report remains in-flight when startup cancel rejects after terminal commit", async () => {
    const reportAsyncFailure = vi.fn(async () => undefined);
    const manual = createManualRuntimeAdapter({
      prompt: async (sessionId, _input, emit) => {
        emit({
          ...sessionFinishedEvent("completed", "done"),
          session_id: sessionId
        });
        throw new Error("prompt exploded");
      },
      cancel: async () => {
        throw new Error("cancel exploded");
      }
    });
    const harness = createHarness([], {
      runtimeAdapter: manual.adapter,
      reportAsyncFailure
    });

    await expect(harness.service.dispatch(createDispatchInput())).rejects.toThrow("prompt exploded");
    await flushAsync();
    await flushAsync();

    expect(harness.getById(FIXED_WORKER_RUN_ID)).toEqual(
      createWorkerRun({
        worker_run_id: FIXED_WORKER_RUN_ID,
        state: "completed",
        updated_at: FIXED_NOW
      })
    );
    expect(
      (reportAsyncFailure.mock.calls as unknown[][]).some((call) => {
        const error = call[0] as unknown;
        return error instanceof CoreError && error.message.includes("Worker remains in-flight");
      })
    ).toBe(false);
  });

  it("does not misreport startup cancel failure as in-flight when terminal reread also fails", async () => {
    const reportAsyncFailure = vi.fn(async () => undefined);
    const manual = createManualRuntimeAdapter({
      prompt: async (sessionId, _input, emit) => {
        emit({
          ...sessionFinishedEvent("completed", "done"),
          session_id: sessionId
        });
        throw new Error("prompt exploded");
      },
      cancel: async () => {
        throw new Error("cancel exploded");
      }
    });
    const harness = createHarness([], {
      runtimeAdapter: manual.adapter,
      reportAsyncFailure
    });
    let lookupCount = 0;

    harness.repo.getById.mockImplementation(async (workerRunId: string) => {
      lookupCount += 1;

      if (lookupCount === 4) {
        throw new Error("lookup exploded");
      }

      return harness.getById(workerRunId);
    });

    await expect(harness.service.dispatch(createDispatchInput())).rejects.toThrow(
      "could not verify worker"
    );
    await flushAsync();
    await flushAsync();

    expect(harness.getById(FIXED_WORKER_RUN_ID)).toEqual(
      createWorkerRun({
        worker_run_id: FIXED_WORKER_RUN_ID,
        state: "completed",
        updated_at: FIXED_NOW
      })
    );
    expect(
      (reportAsyncFailure.mock.calls as unknown[][]).some((call) => {
        const error = call[0] as unknown;
        return error instanceof CoreError && error.message.includes("Worker remains in-flight");
      })
    ).toBe(false);
    expect(
      (reportAsyncFailure.mock.calls as unknown[][]).some((call) => {
        const error = call[0] as unknown;
        return error instanceof CoreError && error.message.includes("Worker may remain in-flight");
      })
    ).toBe(true);
  });

  it("still freezes startup failures when the async failure reporter throws", async () => {
    const harness = createHarness([messageDeltaEvent("should not leak", 0)], {
      reportAsyncFailure: vi.fn(async () => {
        throw new Error("reporter exploded");
      })
    });

    vi.spyOn(harness.runtimeAdapter, "prompt").mockRejectedValueOnce(new Error("prompt exploded"));

    await expect(harness.service.dispatch(createDispatchInput())).rejects.toThrow("prompt exploded");

    expect(harness.getById(FIXED_WORKER_RUN_ID)).toEqual(
      createWorkerRun({
        worker_run_id: FIXED_WORKER_RUN_ID,
        state: "frozen",
        updated_at: FIXED_NOW
      })
    );
  });

  it("fences already-enqueued runtime events when prompt fails after the adapter emitted them", async () => {
    let releaseDelta!: () => void;
    const deltaGate = new Promise<void>((resolve) => {
      releaseDelta = resolve;
    });
    const manual = createManualRuntimeAdapter({
      prompt: async (sessionId, _input, emit) => {
        emit({
          ...messageDeltaEvent("queued before prompt failure", 0),
          session_id: sessionId
        });
        emit({
          ...sessionFinishedEvent("completed", "late completion should be ignored"),
          session_id: sessionId
        });
        throw new Error("prompt exploded");
      }
    });
    const harness = createHarness([], { runtimeAdapter: manual.adapter });
    const completeSpy = vi.spyOn(harness.workerRunLifecycle, "complete");

    harness.eventNormalizer.normalize.mockImplementation(async (event: RuntimeEvent) => {
      if (event.type === "message_delta") {
        await deltaGate;
      }

      return null;
    });

    const dispatchPromise = harness.service.dispatch(createDispatchInput());
    await flushAsync();
    releaseDelta();

    await expect(dispatchPromise).rejects.toThrow("prompt exploded");
    await flushAsync();

    expect(completeSpy).not.toHaveBeenCalled();
    expect(
      harness.eventNormalizer.normalize.mock.calls.some(
        (call) => call[0]?.type === "session_finished"
      )
    ).toBe(false);
    expect(harness.getById(FIXED_WORKER_RUN_ID)).toEqual(
      createWorkerRun({
        worker_run_id: FIXED_WORKER_RUN_ID,
        state: "frozen",
        updated_at: FIXED_NOW
      })
    );
  });

  it("does not resolve dispatch before the queued runtime events finish normalizing", async () => {
    let releaseDelta!: () => void;
    const deltaGate = new Promise<void>((resolve) => {
      releaseDelta = resolve;
    });
    const manual = createManualRuntimeAdapter({
      prompt: async (sessionId, _input, emit) => {
        emit({
          ...messageDeltaEvent("queued before dispatch resolves", 0),
          session_id: sessionId
        });
        emit({
          ...sessionFinishedEvent("completed", "done"),
          session_id: sessionId
        });
      }
    });
    const harness = createHarness([], { runtimeAdapter: manual.adapter });
    let settled = false;

    harness.eventNormalizer.normalize.mockImplementation(async (event: RuntimeEvent) => {
      if (event.type === "message_delta") {
        await deltaGate;
      }

      return null;
    });

    const dispatchPromise = harness.service.dispatch(createDispatchInput());
    void dispatchPromise.finally(() => {
      settled = true;
    });

    await flushAsync();
    expect(settled).toBe(false);

    releaseDelta();

    await expect(dispatchPromise).resolves.toMatchObject({
      worker_run_id: FIXED_WORKER_RUN_ID,
      state: "active"
    });
    expect(harness.getById(FIXED_WORKER_RUN_ID)).toEqual(
      createWorkerRun({
        worker_run_id: FIXED_WORKER_RUN_ID,
        state: "completed",
        updated_at: FIXED_NOW
      })
    );
  });

  it("keeps the worker in-flight and reports startup cleanup failures with startup metadata when cancel rejects", async () => {
    const reportAsyncFailure = vi.fn(async () => undefined);
    const manual = createManualRuntimeAdapter({
      prompt: async () => {
        throw new Error("prompt exploded");
      },
      cancel: async () => {
        throw new Error("cancel exploded");
      }
    });
    const harness = createHarness([], {
      runtimeAdapter: manual.adapter,
      reportAsyncFailure
    });
    const freezeSpy = vi.spyOn(harness.workerRunLifecycle, "freeze");

    await expect(harness.service.dispatch(createDispatchInput())).rejects.toMatchObject({
      name: "CoreError",
      code: "VALIDATION",
      message:
        "Serial delegation startup recovery could not cancel the runtime session. Worker remains in-flight."
    });

    expect(freezeSpy).not.toHaveBeenCalled();
    expect(harness.eventNormalizer.clearSessionState).not.toHaveBeenCalled();
    expect(harness.getById(FIXED_WORKER_RUN_ID)).toEqual(
      createWorkerRun({
        worker_run_id: FIXED_WORKER_RUN_ID,
        state: "active",
        updated_at: FIXED_NOW
      })
    );
    expect(reportAsyncFailure).toHaveBeenNthCalledWith(1, expect.any(Error), {
      phase: "startup",
      workerRunId: FIXED_WORKER_RUN_ID,
      sessionId: "scripted-session-1"
    });
    expect(reportAsyncFailure).toHaveBeenNthCalledWith(2, expect.any(Error), {
      phase: "startup",
      workerRunId: FIXED_WORKER_RUN_ID,
      sessionId: "scripted-session-1"
    });
  });

  it("falls back to abort when startup freeze fails after cancel succeeds", async () => {
    const reportAsyncFailure = vi.fn(async () => undefined);
    const harness = createHarness([messageDeltaEvent("should not leak", 0)], {
      reportAsyncFailure
    });
    const abortSpy = vi.spyOn(harness.workerRunLifecycle, "abort");

    vi.spyOn(harness.runtimeAdapter, "prompt").mockRejectedValueOnce(new Error("prompt exploded"));
    vi.spyOn(harness.workerRunLifecycle, "freeze").mockRejectedValueOnce(new Error("freeze exploded"));

    await expect(harness.service.dispatch(createDispatchInput())).rejects.toThrow("prompt exploded");

    expect(harness.getById(FIXED_WORKER_RUN_ID)).toEqual(
      createWorkerRun({
        worker_run_id: FIXED_WORKER_RUN_ID,
        state: "aborted",
        updated_at: FIXED_NOW
      })
    );
    expect(abortSpy).toHaveBeenCalledWith(FIXED_WORKER_RUN_ID, {
      reason: "serial_delegation_startup recovery fallback after freeze failure: freeze transition failed",
      rollbackAttempted: false
    });
    expect(reportAsyncFailure).toHaveBeenCalledWith(expect.any(Error), {
      phase: "startup",
      workerRunId: FIXED_WORKER_RUN_ID,
      sessionId: "session-1"
    });
  });

  it("does not raise a false in-flight alarm when startup freeze already committed", async () => {
    const reportAsyncFailure = vi.fn(async () => undefined);
    const harness = createHarness([messageDeltaEvent("should not leak", 0)], {
      reportAsyncFailure
    });

    vi.spyOn(harness.runtimeAdapter, "prompt").mockRejectedValueOnce(new Error("prompt exploded"));
    vi.spyOn(harness.workerRunLifecycle, "freeze").mockImplementationOnce(async (workerRunId) => {
      await harness.repo.updateState(workerRunId, "active", "frozen", FIXED_NOW);
      throw new Error("freeze propagated exploded");
    });

    await expect(harness.service.dispatch(createDispatchInput())).rejects.toThrow("prompt exploded");

    expect(harness.getById(FIXED_WORKER_RUN_ID)).toEqual(
      createWorkerRun({
        worker_run_id: FIXED_WORKER_RUN_ID,
        state: "frozen",
        updated_at: FIXED_NOW
      })
    );
    expect(
      (reportAsyncFailure.mock.calls as unknown[][]).some((call) => {
        const error = call[0] as unknown;
        return error instanceof CoreError && error.message.includes("Worker remains in-flight");
      })
    ).toBe(false);
  });

  it("ignores events from a different runtime session", async () => {
    const manual = createManualRuntimeAdapter();
    const harness = createHarness([], { runtimeAdapter: manual.adapter });

    await harness.service.dispatch(createDispatchInput());
    manual.emit({
      ...messageDeltaEvent("foreign chunk", 0),
      session_id: "different-session"
    });
    manual.emit({
      ...messageDeltaEvent("owned chunk", 1),
      session_id: "scripted-session-1"
    });
    manual.emit({
      ...sessionFinishedEvent("completed", "done"),
      session_id: "scripted-session-1"
    });
    await flushAsync();

    expect(harness.eventNormalizer.normalize).toHaveBeenCalledTimes(2);
    expect(
      harness.eventNormalizer.normalize.mock.calls.some(
        (call) => call[0]?.type === "message_delta" && call[0].delta === "foreign chunk"
      )
    ).toBe(false);
  });

  it("processes runtime events in adapter order even when earlier normalization is slow", async () => {
    const manual = createManualRuntimeAdapter();
    const harness = createHarness([], { runtimeAdapter: manual.adapter });
    const completeSpy = vi.spyOn(harness.workerRunLifecycle, "complete");
    let releaseDelta!: () => void;
    let markDeltaStarted!: () => void;
    const deltaStarted = new Promise<void>((resolve) => {
      markDeltaStarted = resolve;
    });
    const deltaGate = new Promise<void>((resolve) => {
      releaseDelta = resolve;
    });

    harness.eventNormalizer.normalize.mockImplementation(async (event: RuntimeEvent) => {
      if (event.type === "message_delta") {
        markDeltaStarted();
        await deltaGate;
      }

      return null;
    });

    await harness.service.dispatch(createDispatchInput());

    manual.emit({
      ...messageDeltaEvent("slow chunk", 0),
      session_id: "scripted-session-1"
    });
    manual.emit({
      ...sessionFinishedEvent("completed", "done"),
      session_id: "scripted-session-1"
    });

    await deltaStarted;
    await flushAsync();

    expect(harness.eventNormalizer.normalize).toHaveBeenCalledTimes(1);
    expect(completeSpy).not.toHaveBeenCalled();

    releaseDelta();
    await flushAsync();

    expect(harness.eventNormalizer.normalize).toHaveBeenCalledTimes(2);
    expect(harness.eventNormalizer.normalize).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ type: "session_finished" }),
      expect.any(Object)
    );
    expect(completeSpy).toHaveBeenCalledWith(FIXED_WORKER_RUN_ID, []);
  });

  it("cancels runtime, clears normalizer state, and freezes when runtime event handling fails", async () => {
    const reportAsyncFailure = vi.fn(async () => {
      throw new Error("reporter exploded");
    });
    const manual = createManualRuntimeAdapter({
      cancel: async (sessionId) => ({
        session_id: sessionId,
        status: "already_finished"
      })
    });
    const harness = createHarness([], {
      runtimeAdapter: manual.adapter,
      reportAsyncFailure
    });
    const freezeSpy = vi.spyOn(harness.workerRunLifecycle, "freeze");
    const cancelSpy = vi.spyOn(manual.adapter, "cancel");

    harness.eventNormalizer.normalize.mockRejectedValueOnce(new Error("normalizer exploded"));

    await harness.service.dispatch(createDispatchInput());
    manual.emit({
      ...messageDeltaEvent("bad chunk", 0),
      session_id: "scripted-session-1"
    });
    await flushTimerTick();
    await flushAsync();
    await flushTimerTick();
    await flushAsync();
    await flushRecoveryGracePeriod();
    await flushRecoveryGracePeriod();

    expect(cancelSpy).toHaveBeenCalledWith("scripted-session-1");
    expect(harness.eventNormalizer.clearSessionState).toHaveBeenCalledWith("scripted-session-1");
    expect(freezeSpy).toHaveBeenCalledWith(
      FIXED_WORKER_RUN_ID,
      "runtime_event_handler",
      "message_delta: event handling failure"
    );
    await flushAsync();
    expect(reportAsyncFailure).toHaveBeenCalledWith(expect.any(Error), {
      phase: "event",
      workerRunId: FIXED_WORKER_RUN_ID,
      sessionId: "scripted-session-1",
      eventType: "message_delta"
    });
    expect(freezeSpy.mock.invocationCallOrder[0]).toBeLessThan(
      reportAsyncFailure.mock.invocationCallOrder[0]!
    );
    expect(harness.getById(FIXED_WORKER_RUN_ID)).toEqual(
      createWorkerRun({
        worker_run_id: FIXED_WORKER_RUN_ID,
        state: "frozen",
        updated_at: FIXED_NOW
      })
    );
  });

  it("keeps later session events observable when runtime event recovery cannot cancel the session", async () => {
    const reportAsyncFailure = vi.fn(async () => undefined);
    let releaseCancel!: () => void;
    let markCancelStarted!: () => void;
    const cancelStarted = new Promise<void>((resolve) => {
      markCancelStarted = resolve;
    });
    const cancelGate = new Promise<void>((resolve) => {
      releaseCancel = resolve;
    });
    const manual = createManualRuntimeAdapter({
      cancel: async () => {
        markCancelStarted();
        await cancelGate;
        throw new Error("cancel exploded");
      }
    });
    const harness = createHarness([], {
      runtimeAdapter: manual.adapter,
      reportAsyncFailure
    });
    const freezeSpy = vi.spyOn(harness.workerRunLifecycle, "freeze");
    const completeSpy = vi.spyOn(harness.workerRunLifecycle, "complete");

    harness.eventNormalizer.normalize.mockRejectedValueOnce(new Error("normalizer exploded"));

    await harness.service.dispatch(createDispatchInput());
    manual.emit({
      ...messageDeltaEvent("bad chunk", 0),
      session_id: "scripted-session-1"
    });
    await cancelStarted;

    manual.emit({
      ...sessionFinishedEvent("completed", "done"),
      session_id: "scripted-session-1"
    });
    releaseCancel();
    await flushAsync();
    await flushAsync();

    expect(freezeSpy).not.toHaveBeenCalled();
    expect(harness.eventNormalizer.clearSessionState).not.toHaveBeenCalled();
    expect(completeSpy).toHaveBeenCalledWith(FIXED_WORKER_RUN_ID, []);
    expect(harness.getById(FIXED_WORKER_RUN_ID)).toEqual(
      createWorkerRun({
        worker_run_id: FIXED_WORKER_RUN_ID,
        state: "completed",
        updated_at: FIXED_NOW
      })
    );
    expect(reportAsyncFailure).toHaveBeenCalledWith(expect.any(Error), {
      phase: "event",
      workerRunId: FIXED_WORKER_RUN_ID,
      sessionId: "scripted-session-1",
      eventType: "message_delta"
    });
  });

  it("falls back to abort when runtime event recovery cancels successfully but freeze fails", async () => {
    const reportAsyncFailure = vi.fn(async () => undefined);
    const manual = createManualRuntimeAdapter();
    const harness = createHarness([], {
      runtimeAdapter: manual.adapter,
      reportAsyncFailure
    });
    const freezeSpy = vi
      .spyOn(harness.workerRunLifecycle, "freeze")
      .mockRejectedValueOnce(new Error("freeze exploded"));
    const abortSpy = vi.spyOn(harness.workerRunLifecycle, "abort");

    harness.eventNormalizer.normalize.mockRejectedValueOnce(new Error("normalizer exploded"));

    await harness.service.dispatch(createDispatchInput());
    manual.emit({
      ...messageDeltaEvent("bad chunk", 0),
      session_id: "scripted-session-1"
    });
    await flushTimerTick();
    await flushAsync();
    await flushTimerTick();
    await flushAsync();
    await flushRecoveryGracePeriod();

    expect(harness.eventNormalizer.clearSessionState).toHaveBeenCalledWith("scripted-session-1");
    expect(freezeSpy).toHaveBeenCalledWith(
      FIXED_WORKER_RUN_ID,
      "runtime_event_handler",
      "message_delta: event handling failure"
    );
    expect(abortSpy).toHaveBeenCalledWith(FIXED_WORKER_RUN_ID, {
      reason: "runtime_event_handler recovery fallback after freeze failure: freeze transition failed",
      rollbackAttempted: false
    });
    expect(harness.getById(FIXED_WORKER_RUN_ID)).toEqual(
      createWorkerRun({
        worker_run_id: FIXED_WORKER_RUN_ID,
        state: "aborted",
        updated_at: FIXED_NOW
      })
    );
    expect(reportAsyncFailure).toHaveBeenCalledWith(expect.any(Error), {
      phase: "event",
      workerRunId: FIXED_WORKER_RUN_ID,
      sessionId: "scripted-session-1",
      eventType: "message_delta"
    });
  });

  it("honors a queued session_finished when cancel resolves after terminal delivery", async () => {
    const reportAsyncFailure = vi.fn(async () => undefined);
    let releaseCancel!: () => void;
    let markCancelStarted!: () => void;
    const cancelStarted = new Promise<void>((resolve) => {
      markCancelStarted = resolve;
    });
    const cancelGate = new Promise<void>((resolve) => {
      releaseCancel = resolve;
    });
    const manual = createManualRuntimeAdapter({
      cancel: async (sessionId) => {
        markCancelStarted();
        await cancelGate;
        return {
          session_id: sessionId,
          status: "cancelled"
        };
      }
    });
    const harness = createHarness([], {
      runtimeAdapter: manual.adapter,
      reportAsyncFailure
    });
    const completeSpy = vi.spyOn(harness.workerRunLifecycle, "complete");
    const freezeSpy = vi.spyOn(harness.workerRunLifecycle, "freeze");
    const abortSpy = vi.spyOn(harness.workerRunLifecycle, "abort");

    harness.eventNormalizer.normalize.mockRejectedValueOnce(new Error("normalizer exploded"));

    await harness.service.dispatch(createDispatchInput());
    manual.emit({
      ...messageDeltaEvent("bad chunk", 0),
      session_id: "scripted-session-1"
    });
    await cancelStarted;

    manual.emit({
      ...sessionFinishedEvent("completed", "done"),
      session_id: "scripted-session-1"
    });
    releaseCancel();
    await flushAsync();
    await flushAsync();

    expect(completeSpy).toHaveBeenCalledWith(FIXED_WORKER_RUN_ID, []);
    expect(freezeSpy).not.toHaveBeenCalled();
    expect(abortSpy).not.toHaveBeenCalled();
    expect(harness.getById(FIXED_WORKER_RUN_ID)).toEqual(
      createWorkerRun({
        worker_run_id: FIXED_WORKER_RUN_ID,
        state: "completed",
        updated_at: FIXED_NOW
      })
    );
    expect(reportAsyncFailure).toHaveBeenCalledWith(expect.any(Error), {
      phase: "event",
      workerRunId: FIXED_WORKER_RUN_ID,
      sessionId: "scripted-session-1",
      eventType: "message_delta"
    });
  });

  it("honors a session_finished emitted on the next turn after cancel resolves", async () => {
    const reportAsyncFailure = vi.fn(async () => undefined);
    const manual = createManualRuntimeAdapter({
      cancel: async (sessionId, emit) => {
        setTimeout(() => {
          emit({
            ...sessionFinishedEvent("completed", "done"),
            session_id: sessionId
          });
        }, 0);

        return {
          session_id: sessionId,
          status: "cancelled"
        };
      }
    });
    const harness = createHarness([], {
      runtimeAdapter: manual.adapter,
      reportAsyncFailure
    });
    const completeSpy = vi.spyOn(harness.workerRunLifecycle, "complete");
    const freezeSpy = vi.spyOn(harness.workerRunLifecycle, "freeze");
    const abortSpy = vi.spyOn(harness.workerRunLifecycle, "abort");

    harness.eventNormalizer.normalize.mockRejectedValueOnce(new Error("normalizer exploded"));

    await harness.service.dispatch(createDispatchInput());
    manual.emit({
      ...messageDeltaEvent("bad chunk", 0),
      session_id: "scripted-session-1"
    });
    await flushTimerTick();
    await flushAsync();
    await flushTimerTick();
    await flushAsync();
    await flushRecoveryGracePeriod();

    expect(completeSpy).toHaveBeenCalledWith(FIXED_WORKER_RUN_ID, []);
    expect(freezeSpy).not.toHaveBeenCalled();
    expect(abortSpy).not.toHaveBeenCalled();
    expect(harness.getById(FIXED_WORKER_RUN_ID)).toEqual(
      createWorkerRun({
        worker_run_id: FIXED_WORKER_RUN_ID,
        state: "completed",
        updated_at: FIXED_NOW
      })
    );
    expect(reportAsyncFailure).toHaveBeenCalledWith(expect.any(Error), {
      phase: "event",
      workerRunId: FIXED_WORKER_RUN_ID,
      sessionId: "scripted-session-1",
      eventType: "message_delta"
    });
  });
});
