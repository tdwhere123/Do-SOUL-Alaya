import { describe, expect, it, vi } from "vitest";
import type { AgentRuntimePort, RuntimeEvent } from "@do-soul/alaya-protocol";
import { CoreError } from "../../shared/errors.js";
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
  it("honors a session_finished emitted after a later timer turn once cancel resolves", async () => {
    const reportAsyncFailure = vi.fn(async () => undefined);
    const manual = createManualRuntimeAdapter({
      cancel: async (sessionId, emit) => {
        setTimeout(() => {
          setTimeout(() => {
            emit({
              ...sessionFinishedEvent("completed", "done"),
              session_id: sessionId
            });
          }, 0);
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
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
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

  it.each([
    {
      status: "failed" as const,
      resultSummary: "tool execution failed",
      expectedReason: "tool execution failed"
    },
    {
      status: "cancelled" as const,
      resultSummary: null,
      expectedReason: "cancelled"
    }
  ])(
    "honors a queued $status session_finished when cancel resolves after terminal delivery",
    async ({ status, resultSummary, expectedReason }) => {
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
      const abortSpy = vi.spyOn(harness.workerRunLifecycle, "abort");
      const freezeSpy = vi.spyOn(harness.workerRunLifecycle, "freeze");

      harness.eventNormalizer.normalize.mockRejectedValueOnce(new Error("normalizer exploded"));

      await harness.service.dispatch(createDispatchInput());
      manual.emit({
        ...messageDeltaEvent("bad chunk", 0),
        session_id: "scripted-session-1"
      });
      await cancelStarted;

      manual.emit({
        ...sessionFinishedEvent(status, resultSummary),
        session_id: "scripted-session-1"
      });
      releaseCancel();
      await flushAsync();
      await flushAsync();

      expect(freezeSpy).not.toHaveBeenCalled();
      expect(abortSpy).toHaveBeenCalledWith(FIXED_WORKER_RUN_ID, {
        reason: expectedReason,
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
    }
  );

  it("falls back to fenced recovery when replaying a queued session_finished also fails", async () => {
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
    const freezeSpy = vi.spyOn(harness.workerRunLifecycle, "freeze");

    harness.eventNormalizer.normalize
      .mockRejectedValueOnce(new Error("normalizer exploded"))
      .mockRejectedValueOnce(new Error("session_finished replay exploded"));

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

    expect(harness.eventNormalizer.clearSessionState).toHaveBeenCalledWith("scripted-session-1");
    expect(freezeSpy).toHaveBeenCalledWith(
      FIXED_WORKER_RUN_ID,
      "runtime_event_handler",
      "session_finished after message_delta: terminal recovery failure"
    );
    expect(harness.getById(FIXED_WORKER_RUN_ID)).toEqual(
      createWorkerRun({
        worker_run_id: FIXED_WORKER_RUN_ID,
        state: "frozen",
        updated_at: FIXED_NOW
      })
    );
    expect(reportAsyncFailure).toHaveBeenCalledWith(expect.any(Error), {
      phase: "event",
      workerRunId: FIXED_WORKER_RUN_ID,
      sessionId: "scripted-session-1",
      eventType: "message_delta"
    });
    expect(reportAsyncFailure).toHaveBeenCalledWith(expect.any(Error), {
      phase: "event",
      workerRunId: FIXED_WORKER_RUN_ID,
      sessionId: "scripted-session-1",
      eventType: "session_finished"
    });
  });

  it("does not abort after freeze errors if the worker is already frozen", async () => {
    const reportAsyncFailure = vi.fn(async () => undefined);
    const manual = createManualRuntimeAdapter();
    const harness = createHarness([], {
      runtimeAdapter: manual.adapter,
      reportAsyncFailure
    });
    const abortSpy = vi.spyOn(harness.workerRunLifecycle, "abort");

    vi.spyOn(harness.workerRunLifecycle, "freeze").mockImplementationOnce(async (workerRunId) => {
      await harness.repo.updateState(workerRunId, "active", "frozen", FIXED_NOW);
      throw new Error("freeze propagated exploded");
    });

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

    expect(abortSpy).not.toHaveBeenCalled();
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

  it("honors the current session_finished when normalization fails and cancel also rejects", async () => {
    const reportAsyncFailure = vi.fn(async () => undefined);
    const manual = createManualRuntimeAdapter({
      cancel: async () => {
        throw new Error("cancel exploded");
      }
    });
    const harness = createHarness([], {
      runtimeAdapter: manual.adapter,
      reportAsyncFailure
    });
    const completeSpy = vi.spyOn(harness.workerRunLifecycle, "complete");
    const terminalEvent = {
      ...sessionFinishedEvent("completed", "done"),
      session_id: "scripted-session-1"
    } satisfies RuntimeEvent;

    harness.eventNormalizer.normalize
      .mockRejectedValueOnce(new Error("normalizer exploded"))
      .mockResolvedValueOnce(null);

    await harness.service.dispatch(createDispatchInput());
    manual.emit(terminalEvent);
    await flushAsync();
    await flushAsync();

    expect(harness.eventNormalizer.normalize).toHaveBeenCalledTimes(2);
    expect(harness.eventNormalizer.normalize).toHaveBeenNthCalledWith(
      1,
      terminalEvent,
      expect.any(Object)
    );
    expect(harness.eventNormalizer.normalize).toHaveBeenNthCalledWith(
      2,
      terminalEvent,
      expect.any(Object)
    );
    expect(completeSpy).toHaveBeenCalledWith(FIXED_WORKER_RUN_ID, []);
    expect(harness.getById(FIXED_WORKER_RUN_ID)).toEqual(
      createWorkerRun({
        worker_run_id: FIXED_WORKER_RUN_ID,
        state: "completed",
        updated_at: FIXED_NOW
      })
    );
  });

  it("does not replay a stale session_finished after an earlier cancel rejection", async () => {
    const reportAsyncFailure = vi.fn(async () => undefined);
    let cancelAttempts = 0;
    const manual = createManualRuntimeAdapter({
      cancel: async (sessionId) => {
        cancelAttempts += 1;

        if (cancelAttempts === 1) {
          throw new Error("cancel exploded");
        }

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
    const freezeSpy = vi.spyOn(harness.workerRunLifecycle, "freeze");
    const firstTerminal = {
      ...sessionFinishedEvent("completed", "first terminal"),
      session_id: "scripted-session-1",
      emitted_at: "2026-04-13T11:00:02.000Z"
    } satisfies RuntimeEvent;
    const secondTerminal = {
      ...sessionFinishedEvent("completed", "second terminal"),
      session_id: "scripted-session-1",
      emitted_at: "2026-04-13T11:00:03.000Z"
    } satisfies RuntimeEvent;

    harness.eventNormalizer.normalize
      .mockRejectedValueOnce(new Error("first terminal exploded"))
      .mockResolvedValueOnce(null);

    await harness.service.dispatch(createDispatchInput());
    manual.emit(firstTerminal);
    await flushAsync();

    manual.emit(secondTerminal);
    await flushAsync();
    await flushAsync();

    expect(harness.eventNormalizer.normalize).toHaveBeenCalledTimes(2);
    expect(harness.eventNormalizer.normalize).toHaveBeenNthCalledWith(
      1,
      firstTerminal,
      expect.any(Object)
    );
    expect(harness.eventNormalizer.normalize).toHaveBeenNthCalledWith(
      2,
      firstTerminal,
      expect.any(Object)
    );
    expect(freezeSpy).not.toHaveBeenCalled();
    expect(harness.getById(FIXED_WORKER_RUN_ID)).toEqual(
      createWorkerRun({
        worker_run_id: FIXED_WORKER_RUN_ID,
        state: "completed",
        updated_at: FIXED_NOW
      })
    );
  });

  it("still completes when a retried session_finished was already normalized", async () => {
    const manual = createManualRuntimeAdapter();
    const harness = createHarness([], {
      runtimeAdapter: manual.adapter
    });
    const completeSpy = vi.spyOn(harness.workerRunLifecycle, "complete");

    harness.eventNormalizer.normalize.mockResolvedValueOnce(null);

    await harness.service.dispatch(createDispatchInput());
    manual.emit({
      ...sessionFinishedEvent("completed", "done"),
      session_id: "scripted-session-1"
    });
    await flushAsync();
    await flushAsync();

    expect(completeSpy).toHaveBeenCalledWith(FIXED_WORKER_RUN_ID, []);
    expect(harness.getById(FIXED_WORKER_RUN_ID)).toEqual(
      createWorkerRun({
        worker_run_id: FIXED_WORKER_RUN_ID,
        state: "completed",
        updated_at: FIXED_NOW
      })
    );
  });

  it("replays the current session_finished after append succeeds but broadcast fails", async () => {
    const reportAsyncFailure = vi.fn(async () => undefined);
    const manual = createManualRuntimeAdapter();
    const harness = createHarness([], {
      runtimeAdapter: manual.adapter,
      reportAsyncFailure
    });
    const completeSpy = vi.spyOn(harness.workerRunLifecycle, "complete");
    const freezeSpy = vi.spyOn(harness.workerRunLifecycle, "freeze");

    harness.eventNormalizer.normalize
      .mockRejectedValueOnce(new Error("broadcast exploded"))
      .mockResolvedValueOnce(null);

    await harness.service.dispatch(createDispatchInput());
    manual.emit({
      ...sessionFinishedEvent("completed", "done"),
      session_id: "scripted-session-1"
    });
    await flushAsync();
    await flushAsync();

    expect(completeSpy).toHaveBeenCalledWith(FIXED_WORKER_RUN_ID, []);
    expect(harness.eventNormalizer.clearSessionState).toHaveBeenCalledWith("scripted-session-1");
    expect(freezeSpy).not.toHaveBeenCalled();
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
      eventType: "session_finished"
    });
  });

  it("fails closed when startup recovery cannot prove terminal worker state", async () => {
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
    let lookupCount = 0;

    harness.repo.getById.mockImplementation(async (workerRunId: string) => {
      lookupCount += 1;

      if (lookupCount === 4) {
        throw new Error("lookup exploded");
      }

      return harness.getById(workerRunId);
    });

    await expect(harness.service.dispatch(createDispatchInput())).rejects.toThrow("prompt exploded");
    await flushAsync();
    await flushAsync();

    expect(freezeSpy).toHaveBeenCalledWith(
      FIXED_WORKER_RUN_ID,
      "serial_delegation_startup",
      "runtime startup failure"
    );
    expect(harness.getById(FIXED_WORKER_RUN_ID)).toEqual(
      createWorkerRun({
        worker_run_id: FIXED_WORKER_RUN_ID,
        state: "frozen",
        updated_at: FIXED_NOW
      })
    );
    expect(reportAsyncFailure).toHaveBeenCalled();
  });

  it("continues startup recovery when terminal-state guard cannot re-read a non-terminal worker", async () => {
    const reportAsyncFailure = vi.fn(async () => undefined);
    const harness = createHarness([], {
      reportAsyncFailure
    });
    const freezeSpy = vi.spyOn(harness.workerRunLifecycle, "freeze");
    let lookupCount = 0;

    vi.spyOn(harness.runtimeAdapter, "prompt").mockRejectedValueOnce(new Error("prompt exploded"));
    harness.repo.getById.mockImplementation(async (workerRunId: string) => {
      lookupCount += 1;

      if (lookupCount === 2) {
        throw new Error("lookup exploded");
      }

      return harness.getById(workerRunId);
    });

    await expect(harness.service.dispatch(createDispatchInput())).rejects.toThrow("prompt exploded");

    expect(freezeSpy).toHaveBeenCalledWith(
      FIXED_WORKER_RUN_ID,
      "serial_delegation_startup",
      "runtime startup failure"
    );
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
        return error instanceof CoreError && error.message.includes("Worker may remain in-flight");
      })
    ).toBe(true);
  });

  it("does not freeze when event-recovery terminal-state guard cannot re-read a terminal worker", async () => {
    const reportAsyncFailure = vi.fn(async () => undefined);
    const manual = createManualRuntimeAdapter();
    const harness = createHarness([], {
      runtimeAdapter: manual.adapter,
      reportAsyncFailure
    });
    const freezeSpy = vi.spyOn(harness.workerRunLifecycle, "freeze");
    let lookupCount = 0;

    harness.repo.getById.mockImplementation(async (workerRunId: string) => {
      lookupCount += 1;

      if (lookupCount === 5) {
        throw new Error("lookup exploded");
      }

      return harness.getById(workerRunId);
    });

    harness.eventNormalizer.normalize
      .mockRejectedValueOnce(new Error("broadcast exploded"))
      .mockResolvedValueOnce(null);
    vi.spyOn(harness.workerRunLifecycle, "complete").mockImplementationOnce(async (workerRunId) => {
      await harness.repo.updateState(workerRunId, "active", "completed", FIXED_NOW);
      throw new Error("state changed broadcast exploded");
    });

    await harness.service.dispatch(createDispatchInput());
    manual.emit({
      ...sessionFinishedEvent("completed", "done"),
      session_id: "scripted-session-1"
    });
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
    expect(reportAsyncFailure).toHaveBeenCalled();
  });

  it("continues event recovery when terminal-state guard cannot re-read a non-terminal worker", async () => {
    const reportAsyncFailure = vi.fn(async () => undefined);
    const manual = createManualRuntimeAdapter();
    const harness = createHarness([], {
      runtimeAdapter: manual.adapter,
      reportAsyncFailure
    });
    const freezeSpy = vi.spyOn(harness.workerRunLifecycle, "freeze");
    let lookupCount = 0;

    harness.repo.getById.mockImplementation(async (workerRunId: string) => {
      lookupCount += 1;

      if (lookupCount === 2) {
        throw new Error("lookup exploded");
      }

      return harness.getById(workerRunId);
    });

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

    expect(freezeSpy).toHaveBeenCalledWith(
      FIXED_WORKER_RUN_ID,
      "runtime_event_handler",
      "message_delta: event handling failure"
    );
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
        return error instanceof CoreError && error.message.includes("Worker may remain in-flight");
      })
    ).toBe(true);
  });

  it("keeps a completed worker terminal when complete fails after durable state mutation", async () => {
    const reportAsyncFailure = vi.fn(async () => undefined);
    const manual = createManualRuntimeAdapter();
    const harness = createHarness([], {
      runtimeAdapter: manual.adapter,
      reportAsyncFailure
    });
    const freezeSpy = vi.spyOn(harness.workerRunLifecycle, "freeze");

    vi.spyOn(harness.workerRunLifecycle, "complete").mockImplementationOnce(async (workerRunId) => {
      await harness.repo.updateState(workerRunId, "active", "completed", FIXED_NOW);
      throw new Error("state changed broadcast exploded");
    });

    await harness.service.dispatch(createDispatchInput());
    manual.emit({
      ...sessionFinishedEvent("completed", "done"),
      session_id: "scripted-session-1"
    });
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
      phase: "event",
      workerRunId: FIXED_WORKER_RUN_ID,
      sessionId: "scripted-session-1",
      eventType: "session_finished"
    });
  });

  it("reports explicit escalation when freeze and abort both fail during runtime event recovery", async () => {
    const reportAsyncFailure = vi.fn(async () => undefined);
    const manual = createManualRuntimeAdapter();
    const harness = createHarness([], {
      runtimeAdapter: manual.adapter,
      reportAsyncFailure
    });

    vi.spyOn(harness.workerRunLifecycle, "freeze").mockRejectedValueOnce(new Error("freeze exploded"));
    vi.spyOn(harness.workerRunLifecycle, "abort").mockRejectedValueOnce(new Error("abort exploded"));

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

    expect(harness.getById(FIXED_WORKER_RUN_ID)).toEqual(
      createWorkerRun({
        worker_run_id: FIXED_WORKER_RUN_ID,
        state: "active",
        updated_at: FIXED_NOW
      })
    );
    expect(
      (reportAsyncFailure.mock.calls as unknown[][]).some((call) => {
        const error = call[0] as unknown;
        return error instanceof CoreError && error.message.includes("in-flight");
      })
    ).toBe(true);
  });

  it("can resolve a fresh runtime adapter from a factory for each dispatch", async () => {
    const runtimeA = createManualRuntimeAdapter();
    const runtimeB = createManualRuntimeAdapter();
    let nextWorkerRunId = 1;
    const runtimeAdapterFactory = vi
      .fn<() => AgentRuntimePort>()
      .mockReturnValueOnce(runtimeA.adapter)
      .mockReturnValueOnce(runtimeB.adapter);
    const harness = createHarness([], {
      runtimeAdapterFactory,
      generateWorkerRunId: () => `worker-run-serial-${nextWorkerRunId++}`
    });

    const firstRun = await harness.service.dispatch(createDispatchInput());
    runtimeA.emit({
      ...sessionFinishedEvent("completed", "done"),
      session_id: "scripted-session-1"
    });
    await flushAsync();

    const secondRun = await harness.service.dispatch(createDispatchInput());

    expect(firstRun.worker_run_id).toBe("worker-run-serial-1");
    expect(secondRun.worker_run_id).toBe("worker-run-serial-2");
    expect(runtimeAdapterFactory).toHaveBeenCalledTimes(2);
    expect(runtimeA.adapter.createSession).toHaveBeenCalledTimes(1);
    expect(runtimeB.adapter.createSession).toHaveBeenCalledTimes(1);
  });
});
