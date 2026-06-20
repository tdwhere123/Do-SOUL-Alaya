import { type EventLogEntry, type RuntimeEvent } from "@do-soul/alaya-protocol";
import { describe, expect, it, vi } from "vitest";
import { RuntimeEventNormalizer, RuntimeEventNormalizerPropagationError } from "../../runtime/runtime-event-normalizer.js";

import { context, createEventLogEntry, createHarness, makeRuntimeEvent } from "./runtime-event-normalizer.test-support.js";

describe("RuntimeEventNormalizer", () => {
it("maps runtime_error to worker.runtime_error", async () => {
    const operations: string[] = [];
    const { normalizer } = createHarness(operations);
    const event = makeRuntimeEvent({
      type: "runtime_error",
      session_id: "session-1",
      error_code: "sdk_query_failed",
      message: "runtime crashed"
    });

    const result = await normalizer.normalize(event, context);

    expect(result).toEqual(
      createEventLogEntry({
        event_type: "worker.runtime_error",
        entity_type: "worker_run",
        entity_id: "worker-1",
        workspace_id: "ws-1",
        run_id: "run-1",
        caused_by: "worker",
        payload_json: {
          sessionId: "session-1",
          emittedAt: event.emitted_at,
          errorCode: "sdk_query_failed",
          message: "runtime crashed"
        }
      })
    );
    expect(operations).toEqual(["append:worker.runtime_error", "notify:worker.runtime_error"]);
  });

const optionalEventCases: ReadonlyArray<
    readonly [string, RuntimeEvent, EventLogEntry["event_type"], Record<string, unknown>]
  > = [
    [
      "tool_call_started",
      makeRuntimeEvent({
        type: "tool_call_started",
        session_id: "session-1",
        call_id: "call-1",
        tool_id: "tools.read_file"
      }),
      "worker.tool_call_started",
      {
        sessionId: "session-1",
        emittedAt: "2026-04-13T12:00:00.000Z",
        callId: "call-1",
        toolId: "tools.read_file"
      }
    ],
    [
      "tool_call_finished",
      makeRuntimeEvent({
        type: "tool_call_finished",
        session_id: "session-1",
        call_id: "call-1",
        tool_id: "tools.read_file",
        outcome: "success",
        result_summary: "done"
      }),
      "worker.tool_call_finished",
      {
        sessionId: "session-1",
        emittedAt: "2026-04-13T12:00:00.000Z",
        callId: "call-1",
        toolId: "tools.read_file",
        outcome: "success",
        resultSummary: "done"
      }
    ],
    [
      "permission_requested",
      makeRuntimeEvent({
        type: "permission_requested",
        session_id: "session-1",
        request_id: "req-1",
        tool_id: "tools.exec_shell",
        reason: "needs permission"
      }),
      "worker.permission_requested",
      {
        sessionId: "session-1",
        emittedAt: "2026-04-13T12:00:00.000Z",
        requestId: "req-1",
        toolId: "tools.exec_shell",
        reason: "needs permission"
      }
    ],
    [
      "patch_emitted",
      makeRuntimeEvent({
        type: "patch_emitted",
        session_id: "session-1",
        patch_id: "patch-1",
        path_hints: ["packages/core/src/runtime/runtime-event-normalizer.ts"]
      }),
      "worker.patch_emitted",
      {
        sessionId: "session-1",
        emittedAt: "2026-04-13T12:00:00.000Z",
        patchId: "patch-1",
        pathHints: ["packages/core/src/runtime/runtime-event-normalizer.ts"]
      }
    ]
  ];

it.each(optionalEventCases)("maps %s when the runtime actually emits it", async (_name, event, expectedType, expectedPayload) => {
    const operations: string[] = [];
    const { normalizer } = createHarness(operations);

    const result = await normalizer.normalize(event, context);

    expect(result).toEqual(
      createEventLogEntry({
        event_type: expectedType,
        entity_type: "worker_run",
        entity_id: "worker-1",
        workspace_id: "ws-1",
        run_id: "run-1",
        caused_by: "worker",
        payload_json: expectedPayload
      })
    );
    expect(operations).toEqual([`append:${expectedType}`, `notify:${expectedType}`]);
  });

it("does not notify when EventLog append fails", async () => {
    const appendError = new Error("append failed");
    const appendSpy = vi.fn(async () => {
      throw appendError;
    });
    const notifyEntry = vi.fn(async () => undefined);
    const normalizer = new RuntimeEventNormalizer({
      eventLogRepo: { append: appendSpy },
      runtimeNotifier: { notifyEntry }
    });
    const event = makeRuntimeEvent({
      type: "message_delta",
      session_id: "session-1",
      sequence: 1,
      delta: "hello"
    });

    await expect(normalizer.normalize(event, context)).rejects.toThrow("append failed");

    expect(appendSpy).toHaveBeenCalledTimes(1);
    expect(notifyEntry).not.toHaveBeenCalled();
  });

it("retries a pending message_delta notification without appending a duplicate", async () => {
    const appendSpy = vi.fn(async (entry: Omit<EventLogEntry, "event_id" | "created_at" | "revision">) => createEventLogEntry(entry));
    const notifyEntry = vi.fn(async (_entry: EventLogEntry) => undefined);
    notifyEntry.mockRejectedValueOnce(new Error("notify failed"));
    const normalizer = new RuntimeEventNormalizer({
      eventLogRepo: { append: appendSpy },
      runtimeNotifier: { notifyEntry }
    });
    const event = makeRuntimeEvent({
      type: "message_delta",
      session_id: "session-1",
      sequence: 9,
      delta: "durable chunk"
    });

    const rejection = await normalizer.normalize(event, context).catch((error: unknown) => error);

    expect(rejection).toBeInstanceOf(RuntimeEventNormalizerPropagationError);
    expect(rejection).toMatchObject({
      name: "RuntimeEventNormalizerPropagationError",
      entry: expect.objectContaining({ event_type: "worker.message_delta" })
    });
    await expect(normalizer.normalize(event, context)).resolves.toEqual(
      expect.objectContaining({ event_type: "worker.message_delta" })
    );
    await expect(normalizer.normalize(event, context)).resolves.toBeNull();

    expect(appendSpy).toHaveBeenCalledTimes(1);
    expect(notifyEntry).toHaveBeenCalledTimes(2);
  });
});
