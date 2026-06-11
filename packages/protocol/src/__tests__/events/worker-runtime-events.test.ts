import { describe, expect, it } from "vitest";
import { EventTypeSchema } from "../../events/event-log.js";
import {
  WorkerRuntimeEventType,
  WorkerRuntimeEventTypeSchema,
  WorkerRuntimeEventUnionSchema,
  WorkerIntegrationStatusPayloadSchema,
  WorkerMessageDeltaPayloadSchema,
  WorkerSessionFinishedPayloadSchema,
  parseWorkerRuntimeEventPayload
} from "../../events/worker-runtime.js";

const validTimestamp = "2026-04-13T00:00:00.000Z";

describe("Phase A3 event registry", () => {
  it("exports the frozen worker runtime wire events and parses every A3 payload", () => {
    const expectedEventTypes = [
      "worker.session_started",
      "worker.session_finished",
      "worker.message_delta",
      "worker.tool_call_started",
      "worker.tool_call_finished",
      "worker.permission_requested",
      "worker.patch_emitted",
      "worker.integration_status",
      "worker.runtime_error"
    ] as const;

    expect(Object.values(WorkerRuntimeEventType)).toEqual(expectedEventTypes);
    expect(WorkerRuntimeEventTypeSchema.options).toEqual(expectedEventTypes);
    expect(expectedEventTypes.every((eventType) => eventType.includes("."))).toBe(true);

    const sessionStartedPayload = {
      sessionId: "session-1",
      emittedAt: validTimestamp
    } as const;
    const sessionFinishedPayload = {
      sessionId: "session-1",
      emittedAt: validTimestamp,
      status: "completed",
      resultSummary: "worker finished successfully"
    } as const;
    const messageDeltaPayload = {
      sessionId: "session-1",
      workerRunId: "worker-1",
      emittedAt: validTimestamp,
      delta: "hello",
      sequence: 0
    } as const;
    const toolCallStartedPayload = {
      sessionId: "session-1",
      emittedAt: validTimestamp,
      callId: "call-1",
      toolId: "tools.read_file"
    } as const;
    const toolCallFinishedPayload = {
      sessionId: "session-1",
      emittedAt: validTimestamp,
      callId: "call-1",
      toolId: "tools.read_file",
      outcome: "success",
      resultSummary: "read complete"
    } as const;
    const permissionRequestedPayload = {
      sessionId: "session-1",
      emittedAt: validTimestamp,
      requestId: "perm-1",
      toolId: "tools.exec_shell",
      reason: "requires write access"
    } as const;
    const patchEmittedPayload = {
      sessionId: "session-1",
      emittedAt: validTimestamp,
      patchId: "patch-1",
      pathHints: ["packages/core/src/runtime/runtime-event-normalizer.ts"]
    } as const;
    const runtimeErrorPayload = {
      sessionId: "session-1",
      emittedAt: validTimestamp,
      errorCode: "runtime_failed",
      message: "runtime crashed"
    } as const;
    const integrationStatusPayload = {
      workerRunId: "worker-1",
      level: "soft_stale",
      reason: "supports_streaming_updates mismatch",
      detectedAt: validTimestamp
    } as const;

    expect(parseWorkerRuntimeEventPayload(WorkerRuntimeEventType.WORKER_SESSION_STARTED, sessionStartedPayload)).toEqual(
      sessionStartedPayload
    );
    expect(parseWorkerRuntimeEventPayload(WorkerRuntimeEventType.WORKER_SESSION_FINISHED, sessionFinishedPayload)).toEqual(
      sessionFinishedPayload
    );
    expect(parseWorkerRuntimeEventPayload(WorkerRuntimeEventType.WORKER_MESSAGE_DELTA, messageDeltaPayload)).toEqual(
      messageDeltaPayload
    );
    expect(parseWorkerRuntimeEventPayload(WorkerRuntimeEventType.WORKER_TOOL_CALL_STARTED, toolCallStartedPayload)).toEqual(
      toolCallStartedPayload
    );
    expect(parseWorkerRuntimeEventPayload(WorkerRuntimeEventType.WORKER_TOOL_CALL_FINISHED, toolCallFinishedPayload)).toEqual(
      toolCallFinishedPayload
    );
    expect(
      parseWorkerRuntimeEventPayload(WorkerRuntimeEventType.WORKER_PERMISSION_REQUESTED, permissionRequestedPayload)
    ).toEqual(permissionRequestedPayload);
    expect(parseWorkerRuntimeEventPayload(WorkerRuntimeEventType.WORKER_PATCH_EMITTED, patchEmittedPayload)).toEqual(
      patchEmittedPayload
    );
    expect(
      parseWorkerRuntimeEventPayload(WorkerRuntimeEventType.WORKER_INTEGRATION_STATUS, integrationStatusPayload)
    ).toEqual(integrationStatusPayload);
    expect(parseWorkerRuntimeEventPayload(WorkerRuntimeEventType.WORKER_RUNTIME_ERROR, runtimeErrorPayload)).toEqual(
      runtimeErrorPayload
    );

    expect(WorkerSessionFinishedPayloadSchema.parse(sessionFinishedPayload)).toEqual(sessionFinishedPayload);
    expect(WorkerMessageDeltaPayloadSchema.parse(messageDeltaPayload)).toEqual(messageDeltaPayload);
    expect(WorkerIntegrationStatusPayloadSchema.parse(integrationStatusPayload)).toEqual(integrationStatusPayload);

    expect(
      WorkerRuntimeEventUnionSchema.parse({
        type: WorkerRuntimeEventType.WORKER_MESSAGE_DELTA,
        payload: messageDeltaPayload
      })
    ).toEqual({
      type: WorkerRuntimeEventType.WORKER_MESSAGE_DELTA,
      payload: messageDeltaPayload
    });

    expect(EventTypeSchema.parse(WorkerRuntimeEventType.WORKER_SESSION_STARTED)).toBe(
      WorkerRuntimeEventType.WORKER_SESSION_STARTED
    );
    expect(EventTypeSchema.parse(WorkerRuntimeEventType.WORKER_PATCH_EMITTED)).toBe(
      WorkerRuntimeEventType.WORKER_PATCH_EMITTED
    );
    expect(EventTypeSchema.parse(WorkerRuntimeEventType.WORKER_INTEGRATION_STATUS)).toBe(
      WorkerRuntimeEventType.WORKER_INTEGRATION_STATUS
    );
    expect(EventTypeSchema.parse(WorkerRuntimeEventType.WORKER_RUNTIME_ERROR)).toBe(
      WorkerRuntimeEventType.WORKER_RUNTIME_ERROR
    );
  });

  it("rejects unknown names and invalid A3 payloads", () => {
    expect(() => EventTypeSchema.parse("worker.message.delta")).toThrow();
    expect(() => EventTypeSchema.parse("worker.tool_call.started")).toThrow();
    expect(() => WorkerRuntimeEventTypeSchema.parse("worker.session")).toThrow();

    expect(() =>
      parseWorkerRuntimeEventPayload(WorkerRuntimeEventType.WORKER_SESSION_STARTED, {
        emittedAt: validTimestamp
      })
    ).toThrow();

    expect(() =>
      parseWorkerRuntimeEventPayload(WorkerRuntimeEventType.WORKER_SESSION_FINISHED, {
        sessionId: "session-1",
        emittedAt: validTimestamp,
        status: "done",
        resultSummary: null
      })
    ).toThrow();

    expect(() =>
      parseWorkerRuntimeEventPayload(WorkerRuntimeEventType.WORKER_MESSAGE_DELTA, {
        sessionId: "session-1",
        emittedAt: validTimestamp,
        delta: "hello",
        sequence: -1
      })
    ).toThrow();

    expect(() =>
      parseWorkerRuntimeEventPayload(WorkerRuntimeEventType.WORKER_TOOL_CALL_FINISHED, {
        sessionId: "session-1",
        emittedAt: validTimestamp,
        callId: "call-1",
        toolId: "tools.read_file",
        outcome: "partial",
        resultSummary: null
      })
    ).toThrow();

    expect(() =>
      parseWorkerRuntimeEventPayload(WorkerRuntimeEventType.WORKER_PERMISSION_REQUESTED, {
        sessionId: "session-1",
        emittedAt: validTimestamp,
        requestId: "perm-1",
        toolId: "tools.exec_shell"
      })
    ).toThrow();

    expect(() =>
      parseWorkerRuntimeEventPayload(WorkerRuntimeEventType.WORKER_PATCH_EMITTED, {
        sessionId: "session-1",
        emittedAt: validTimestamp,
        patchId: "patch-1"
      })
    ).toThrow();

    expect(() =>
      parseWorkerRuntimeEventPayload(WorkerRuntimeEventType.WORKER_INTEGRATION_STATUS, {
        workerRunId: "worker-1",
        level: "degraded",
        reason: "mismatch",
        detectedAt: validTimestamp
      })
    ).toThrow();

    expect(() =>
      parseWorkerRuntimeEventPayload(WorkerRuntimeEventType.WORKER_RUNTIME_ERROR, {
        sessionId: "session-1",
        emittedAt: validTimestamp,
        errorCode: "runtime_failed"
      })
    ).toThrow();
  });
});
