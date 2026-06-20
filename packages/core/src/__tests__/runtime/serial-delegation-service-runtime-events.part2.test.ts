import { describe, expect, it, vi } from "vitest";
import type { RuntimeEvent } from "@do-soul/alaya-protocol";
import { CoreError } from "../../shared/errors.js";
import { FIXED_NOW, FIXED_WORKER_RUN_ID, createDispatchInput, createHarness, createManualRuntimeAdapter, createWorkerRun, flushAsync, flushRecoveryGracePeriod, flushTimerTick, messageDeltaEvent, sessionFinishedEvent } from "./serial-delegation-service-test-fixtures.js";

describe("SerialDelegationService", () => {
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
