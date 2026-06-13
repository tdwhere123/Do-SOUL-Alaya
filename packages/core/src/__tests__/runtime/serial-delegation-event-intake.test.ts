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
