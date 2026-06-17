import { describe, expect, it, vi } from "vitest";
import type { RuntimeEvent } from "@do-soul/alaya-protocol";
import { SerialDelegationEventIntake } from "../../runtime/serial-delegation-event-intake.js";

describe("SerialDelegationEventIntake", () => {
  it("surfaces the current operation failure while allowing later enqueues to recover", async () => {
    const intake = new SerialDelegationEventIntake();
    const operations: string[] = [];
    const emitWarning = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);

    intake.enqueue(async () => {
      operations.push("first");
      throw new Error("boom");
    });

    await expect(intake.drain()).rejects.toThrow("boom");
    expect(emitWarning).toHaveBeenCalledWith(
      "[SerialDelegationEventIntake] Queued runtime event operation failed",
      expect.objectContaining({
        code: "ALAYA_SERIAL_DELEGATION_QUEUE_FAILED"
      })
    );

    intake.enqueue(async () => {
      operations.push("second");
    });

    await expect(intake.drain()).resolves.toBeUndefined();
    expect(operations).toEqual(["first", "second"]);

    emitWarning.mockRestore();
  });

  it("drains a large FIFO batch in enqueue order without dropping operations", async () => {
    const intake = new SerialDelegationEventIntake();
    const operations: number[] = [];

    for (let index = 0; index < 1000; index += 1) {
      intake.enqueue(async () => {
        operations.push(index);
      });
    }

    await expect(intake.drain()).resolves.toBeUndefined();
    expect(operations).toHaveLength(1000);
    expect(operations[0]).toBe(0);
    expect(operations[999]).toBe(999);
    for (let index = 1; index < operations.length; index += 1) {
      expect(operations[index]).toBe((operations[index - 1] ?? -1) + 1);
    }
  });

  it("rejects overflow, drops the excess operation, and surfaces the capacity error on drain", async () => {
    const intake = new SerialDelegationEventIntake();
    const emitWarning = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
    const capacity = 4096;
    let releaseFirstOperation: (() => void) | undefined;
    let firstOperationStarted: (() => void) | undefined;
    const firstOperationStartedPromise = new Promise<void>((resolve) => {
      firstOperationStarted = resolve;
    });
    const releaseFirstOperationPromise = new Promise<void>((resolve) => {
      releaseFirstOperation = resolve;
    });
    let drainedCount = 0;
    let overflowRan = false;

    intake.enqueue(async () => {
      firstOperationStarted?.();
      await releaseFirstOperationPromise;
    });
    await firstOperationStartedPromise;

    for (let index = 0; index < capacity; index += 1) {
      intake.enqueue(async () => {
        drainedCount += 1;
      });
    }
    intake.enqueue(async () => {
      overflowRan = true;
    });

    expect(emitWarning).toHaveBeenCalledWith(
      "[SerialDelegationEventIntake] Queued runtime event operation rejected",
      expect.objectContaining({
        code: "ALAYA_SERIAL_DELEGATION_QUEUE_CAPACITY_EXCEEDED"
      })
    );

    releaseFirstOperation?.();

    await expect(intake.drain()).rejects.toThrow(
      "Serial delegation event queue capacity exceeded"
    );
    expect(drainedCount).toBe(capacity);
    expect(overflowRan).toBe(false);

    emitWarning.mockRestore();
  });

  it("unrefs the session-finished grace timer", async () => {
    const intake = new SerialDelegationEventIntake();
    const unref = vi.fn();
    const originalSetTimeout = globalThis.setTimeout;
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation(
      ((...args: Parameters<typeof setTimeout>) => {
        const handle = originalSetTimeout(...args);
        return Object.assign(handle, { unref }) as ReturnType<typeof setTimeout>;
      }) as typeof setTimeout
    );

    const pendingWait = intake.awaitPendingSessionFinishedEvent();
    intake.note(createSessionFinishedEvent());

    await expect(pendingWait).resolves.toEqual(createSessionFinishedEvent());
    expect(setTimeoutSpy).toHaveBeenCalled();
    expect(unref).toHaveBeenCalled();
  });

  it("resolves waiters with the pending session_finished event observed during the grace window", async () => {
    const intake = new SerialDelegationEventIntake();
    const pendingWait = intake.awaitPendingSessionFinishedEvent();

    intake.note(createSessionFinishedEvent());

    await expect(pendingWait).resolves.toEqual(createSessionFinishedEvent());
  });
});

function createSessionFinishedEvent(): Extract<RuntimeEvent, { readonly type: "session_finished" }> {
  return {
    type: "session_finished",
    session_id: "session-intake-1",
    emitted_at: "2026-04-14T12:00:00.000Z",
    status: "completed",
    result_summary: "done"
  };
}
