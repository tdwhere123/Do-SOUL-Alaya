import { describe, expect, it, vi } from "vitest";
import { RecoveryPrimitives } from "../../runtime/serial-delegation-recovery-primitives.js";
import type {
  RecoveryMetadata,
  SerialDelegationRecoveryDependencies
} from "../../runtime/serial-delegation-recovery-ports.js";

function buildPrimitives(
  reportAsyncFailure: SerialDelegationRecoveryDependencies["reportAsyncFailure"]
): RecoveryPrimitives {
  return new RecoveryPrimitives({
    workerRunLifecycle: {} as SerialDelegationRecoveryDependencies["workerRunLifecycle"],
    workerRunRepo: {
      getById: vi.fn(async () => null),
      deleteIfState: vi.fn(async () => undefined)
    },
    eventNormalizer: {
      normalize: vi.fn(async () => null),
      clearSessionState: vi.fn()
    },
    constraintProxy: { assertNoViolation: vi.fn(async () => undefined) },
    reportAsyncFailure
  });
}

const metadata: RecoveryMetadata = {
  phase: "event",
  workerRunId: "worker-1",
  sessionId: "session-1"
};

describe("RecoveryPrimitives.safeReportAsyncFailure", () => {
  it("emits a warning capturing the original recovery error when the reporter throws", async () => {
    const emitWarning = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
    try {
      const primitives = buildPrimitives(
        vi.fn(async () => {
          throw new Error("reporter offline");
        })
      );

      await expect(
        primitives.safeReportAsyncFailure(new Error("freeze failed"), metadata)
      ).resolves.toBeUndefined();

      expect(emitWarning).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ code: "ALAYA_WORKER_RECOVERY_REPORT_FAILED" })
      );
      const detail = JSON.parse((emitWarning.mock.calls[0]![1] as { detail: string }).detail);
      expect(detail).toMatchObject({
        session_id: "session-1",
        recovery_error: "freeze failed",
        report_error: "reporter offline"
      });
    } finally {
      emitWarning.mockRestore();
    }
  });

  it("does not emit a warning when the reporter succeeds", async () => {
    const emitWarning = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
    try {
      const primitives = buildPrimitives(vi.fn(async () => undefined));
      await primitives.safeReportAsyncFailure(new Error("freeze failed"), metadata);
      expect(emitWarning).not.toHaveBeenCalled();
    } finally {
      emitWarning.mockRestore();
    }
  });
});
