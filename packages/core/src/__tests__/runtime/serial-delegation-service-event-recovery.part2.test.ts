import { describe, expect, it, vi } from "vitest";
import type { AgentRuntimePort } from "@do-soul/alaya-protocol";
import { CoreError } from "../../shared/errors.js";
import { FIXED_NOW, FIXED_WORKER_RUN_ID, createDispatchInput, createHarness, createManualRuntimeAdapter, createWorkerRun, flushAsync, flushRecoveryGracePeriod, flushTimerTick, messageDeltaEvent, sessionFinishedEvent } from "./serial-delegation-service-test-fixtures.js";

describe("SerialDelegationService", () => {
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
