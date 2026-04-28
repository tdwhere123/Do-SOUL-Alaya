import { RuntimeEventSchema, type EventLogEntry, type RuntimeEvent } from "@do-what/protocol";
import { describe, expect, it, vi } from "vitest";
import { RuntimeEventNormalizer, type NormalizerContext } from "../runtime-event-normalizer.js";

const context: NormalizerContext = {
  workspaceId: "ws-1",
  principalRunId: "run-1",
  workerRunId: "worker-1"
};

describe("RuntimeEventNormalizer", () => {
  it("maps session_started to EventLog append then broadcast", async () => {
    const operations: string[] = [];
    const { normalizer, appendSpy, broadcastEntry } = createHarness(operations);
    const event = makeRuntimeEvent({
      type: "session_started",
      session_id: "session-1"
    });

    const result = await normalizer.normalize(event, context);

    expect(result).toEqual(
      createEventLogEntry({
        event_type: "worker.session_started",
        entity_type: "worker_run",
        entity_id: "worker-1",
        workspace_id: "ws-1",
        run_id: "run-1",
        caused_by: "worker",
        revision: 0,
        payload_json: {
          sessionId: "session-1",
          emittedAt: event.emitted_at
        }
      })
    );
    expect(operations).toEqual(["append:worker.session_started", "broadcast:worker.session_started"]);
    expect(appendSpy).toHaveBeenCalledTimes(1);
    expect(broadcastEntry).toHaveBeenCalledWith(result);
  });

  it("deduplicates message_delta only by session_id and sequence", async () => {
    const operations: string[] = [];
    const { normalizer, appendSpy, broadcastEntry } = createHarness(operations);
    const first = makeRuntimeEvent({
      type: "message_delta",
      session_id: "session-1",
      sequence: 7,
      delta: "hello"
    });
    const duplicate = makeRuntimeEvent({
      type: "message_delta",
      session_id: "session-1",
      sequence: 7,
      delta: "hello again"
    });
    const differentSession = makeRuntimeEvent({
      type: "message_delta",
      session_id: "session-2",
      sequence: 7,
      delta: "same sequence other session"
    });

    await expect(normalizer.normalize(first, context)).resolves.toEqual(
      expect.objectContaining({
        event_type: "worker.message_delta",
        entity_id: "worker-1",
        payload_json: expect.objectContaining({
          sessionId: "session-1",
          workerRunId: "worker-1",
          delta: "hello",
          sequence: 7
        })
      })
    );
    await expect(normalizer.normalize(duplicate, context)).resolves.toBeNull();
    await expect(normalizer.normalize(differentSession, context)).resolves.toEqual(
      expect.objectContaining({ event_type: "worker.message_delta" })
    );

    expect(operations).toEqual([
      "append:worker.message_delta",
      "broadcast:worker.message_delta",
      "append:worker.message_delta",
      "broadcast:worker.message_delta"
    ]);
    expect(appendSpy).toHaveBeenCalledTimes(2);
    expect(broadcastEntry).toHaveBeenCalledTimes(2);
  });

  it("reserves message_delta dedup before awaiting IO so concurrent duplicates do not double-append", async () => {
    let releaseAppend!: () => void;
    const appendSpy = vi.fn(
      async (entry: Omit<EventLogEntry, "event_id" | "created_at">) =>
        await new Promise<EventLogEntry>((resolve) => {
          releaseAppend = () => resolve(createEventLogEntry(entry));
        })
    );
    const broadcastEntry = vi.fn(async () => undefined);
    const normalizer = new RuntimeEventNormalizer({
      eventLogRepo: { append: appendSpy },
      sseBroadcaster: { broadcastEntry }
    });
    const event = makeRuntimeEvent({
      type: "message_delta",
      session_id: "session-1",
      sequence: 3,
      delta: "concurrent chunk"
    });

    const first = normalizer.normalize(event, context);
    const duplicate = normalizer.normalize(event, context);

    await expect(duplicate).resolves.toBeNull();
    expect(appendSpy).toHaveBeenCalledTimes(1);

    releaseAppend();

    await expect(first).resolves.toEqual(expect.objectContaining({ event_type: "worker.message_delta" }));
  });

  it("deduplicates session_finished after append succeeds but broadcast fails", async () => {
    const event = makeRuntimeEvent({
      type: "session_finished",
      session_id: "session-1",
      status: "completed",
      result_summary: "done"
    });
    const appendSpy = vi.fn(
      async (entry: Omit<EventLogEntry, "event_id" | "created_at">) => createEventLogEntry(entry)
    );
    const broadcastEntry = vi
      .fn<(entry: EventLogEntry) => Promise<void>>()
      .mockRejectedValueOnce(new Error("broadcast exploded"));
    const normalizer = new RuntimeEventNormalizer({
      eventLogRepo: { append: appendSpy },
      sseBroadcaster: { broadcastEntry }
    });

    await expect(normalizer.normalize(event, context)).rejects.toThrow("broadcast exploded");
    await expect(normalizer.normalize(event, context)).resolves.toBeNull();

    expect(appendSpy).toHaveBeenCalledTimes(1);
    expect(broadcastEntry).toHaveBeenCalledTimes(1);
  });

  it("releases session_finished dedup when append fails before persisting", async () => {
    const event = makeRuntimeEvent({
      type: "session_finished",
      session_id: "session-1",
      status: "completed",
      result_summary: "done"
    });
    const appendSpy = vi
      .fn<(entry: Omit<EventLogEntry, "event_id" | "created_at">) => Promise<EventLogEntry>>()
      .mockRejectedValueOnce(new Error("append exploded"))
      .mockImplementationOnce(async (entry) => createEventLogEntry(entry));
    const broadcastEntry = vi.fn(async () => undefined);
    const normalizer = new RuntimeEventNormalizer({
      eventLogRepo: { append: appendSpy },
      sseBroadcaster: { broadcastEntry }
    });

    await expect(normalizer.normalize(event, context)).rejects.toThrow("append exploded");
    await expect(normalizer.normalize(event, context)).resolves.toEqual(
      expect.objectContaining({ event_type: "worker.session_finished" })
    );

    expect(appendSpy).toHaveBeenCalledTimes(2);
    expect(broadcastEntry).toHaveBeenCalledTimes(1);
  });

  it("clears session_finished dedup state after session_finished succeeds", async () => {
    const { normalizer, appendSpy, broadcastEntry } = createHarness([]);
    const event = makeRuntimeEvent({
      type: "session_finished",
      session_id: "session-1",
      status: "completed",
      result_summary: "done"
    });

    await normalizer.normalize(event, context);
    await normalizer.normalize(event, context);

    expect(appendSpy).toHaveBeenCalledTimes(2);
    expect(broadcastEntry).toHaveBeenCalledTimes(2);
  });

  it("clearSessionState releases session_finished dedup after a partial-success cleanup", async () => {
    const event = makeRuntimeEvent({
      type: "session_finished",
      session_id: "session-1",
      status: "completed",
      result_summary: "done"
    });
    const appendSpy = vi.fn(
      async (entry: Omit<EventLogEntry, "event_id" | "created_at">) => createEventLogEntry(entry)
    );
    const broadcastEntry = vi
      .fn<(entry: EventLogEntry) => Promise<void>>()
      .mockRejectedValueOnce(new Error("broadcast exploded"))
      .mockResolvedValueOnce(undefined);
    const normalizer = new RuntimeEventNormalizer({
      eventLogRepo: { append: appendSpy },
      sseBroadcaster: { broadcastEntry }
    });

    await expect(normalizer.normalize(event, context)).rejects.toThrow("broadcast exploded");
    normalizer.clearSessionState("session-1");
    await expect(normalizer.normalize(event, context)).resolves.toEqual(
      expect.objectContaining({ event_type: "worker.session_finished" })
    );

    expect(appendSpy).toHaveBeenCalledTimes(2);
    expect(broadcastEntry).toHaveBeenCalledTimes(2);
  });

  it("clears message_delta dedup state after session_finished succeeds", async () => {
    const operations: string[] = [];
    const { normalizer, appendSpy, broadcastEntry } = createHarness(operations);
    const delta = makeRuntimeEvent({
      type: "message_delta",
      session_id: "session-1",
      sequence: 0,
      delta: "first pass"
    });
    const finished = makeRuntimeEvent({
      type: "session_finished",
      session_id: "session-1",
      status: "completed",
      result_summary: "done"
    });

    await normalizer.normalize(delta, context);
    await normalizer.normalize(finished, context);
    const replayed = await normalizer.normalize(delta, context);

    expect(replayed).toEqual(
      expect.objectContaining({
        event_type: "worker.message_delta",
        payload_json: {
          sessionId: "session-1",
          workerRunId: "worker-1",
          emittedAt: delta.emitted_at,
          delta: "first pass",
          sequence: 0
        }
      })
    );
    expect(appendSpy).toHaveBeenCalledTimes(3);
    expect(broadcastEntry).toHaveBeenCalledTimes(3);
    expect(operations).toEqual([
      "append:worker.message_delta",
      "broadcast:worker.message_delta",
      "append:worker.session_finished",
      "broadcast:worker.session_finished",
      "append:worker.message_delta",
      "broadcast:worker.message_delta"
    ]);
  });

  it("preserves message_delta dedup correctness across multiple live sessions", async () => {
    const operations: string[] = [];
    const { normalizer, appendSpy, broadcastEntry } = createHarness(operations);

    await normalizer.normalize(
      makeRuntimeEvent({
        type: "message_delta",
        session_id: "session-1",
        sequence: 0,
        delta: "first"
      }),
      context
    );
    await normalizer.normalize(
      makeRuntimeEvent({
        type: "message_delta",
        session_id: "session-2",
        sequence: 0,
        delta: "second"
      }),
      context
    );
    await normalizer.normalize(
      makeRuntimeEvent({
        type: "message_delta",
        session_id: "session-3",
        sequence: 0,
        delta: "third"
      }),
      context
    );
    const replayed = await normalizer.normalize(
      makeRuntimeEvent({
        type: "message_delta",
        session_id: "session-1",
        sequence: 0,
        delta: "first again"
      }),
      context
    );

    expect(replayed).toBeNull();
    expect(appendSpy).toHaveBeenCalledTimes(3);
    expect(broadcastEntry).toHaveBeenCalledTimes(3);
  });

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
        revision: 0,
        payload_json: {
          sessionId: "session-1",
          emittedAt: event.emitted_at,
          errorCode: "sdk_query_failed",
          message: "runtime crashed"
        }
      })
    );
    expect(operations).toEqual(["append:worker.runtime_error", "broadcast:worker.runtime_error"]);
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
        path_hints: ["packages/core/src/runtime-event-normalizer.ts"]
      }),
      "worker.patch_emitted",
      {
        sessionId: "session-1",
        emittedAt: "2026-04-13T12:00:00.000Z",
        patchId: "patch-1",
        pathHints: ["packages/core/src/runtime-event-normalizer.ts"]
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
        revision: 0,
        payload_json: expectedPayload
      })
    );
    expect(operations).toEqual([`append:${expectedType}`, `broadcast:${expectedType}`]);
  });

  it("does not broadcast when EventLog append fails", async () => {
    const appendError = new Error("append failed");
    const appendSpy = vi.fn(async () => {
      throw appendError;
    });
    const broadcastEntry = vi.fn(async () => undefined);
    const normalizer = new RuntimeEventNormalizer({
      eventLogRepo: { append: appendSpy },
      sseBroadcaster: { broadcastEntry }
    });
    const event = makeRuntimeEvent({
      type: "message_delta",
      session_id: "session-1",
      sequence: 1,
      delta: "hello"
    });

    await expect(normalizer.normalize(event, context)).rejects.toThrow("append failed");

    expect(appendSpy).toHaveBeenCalledTimes(1);
    expect(broadcastEntry).not.toHaveBeenCalled();
  });

  it("keeps message_delta reserved after append succeeds so broadcast retries do not double-append", async () => {
    const appendSpy = vi.fn(async (entry: Omit<EventLogEntry, "event_id" | "created_at">) => createEventLogEntry(entry));
    const broadcastEntry = vi.fn(async (_entry: EventLogEntry) => undefined);
    broadcastEntry.mockRejectedValueOnce(new Error("broadcast failed"));
    const normalizer = new RuntimeEventNormalizer({
      eventLogRepo: { append: appendSpy },
      sseBroadcaster: { broadcastEntry }
    });
    const event = makeRuntimeEvent({
      type: "message_delta",
      session_id: "session-1",
      sequence: 9,
      delta: "durable chunk"
    });

    await expect(normalizer.normalize(event, context)).rejects.toThrow("broadcast failed");
    await expect(normalizer.normalize(event, context)).resolves.toBeNull();

    expect(appendSpy).toHaveBeenCalledTimes(1);
    expect(broadcastEntry).toHaveBeenCalledTimes(1);
  });
});

function createHarness(operations: string[]) {
  const appendSpy = vi.fn(async (entry: Omit<EventLogEntry, "event_id" | "created_at">) => {
    operations.push(`append:${entry.event_type}`);
    return createEventLogEntry(entry);
  });
  const broadcastEntry = vi.fn(async (entry: EventLogEntry) => {
    operations.push(`broadcast:${entry.event_type}`);
  });
  const normalizer = new RuntimeEventNormalizer({
    eventLogRepo: { append: appendSpy },
    sseBroadcaster: { broadcastEntry }
  });

  return { normalizer, appendSpy, broadcastEntry };
}

function createEventLogEntry(input: Omit<EventLogEntry, "event_id" | "created_at">): EventLogEntry {
  return {
    event_id: `evt_${input.event_type}`,
    created_at: "2026-04-13T12:00:01.000Z",
    ...input
  };
}

function makeRuntimeEvent(event: Record<string, unknown>): RuntimeEvent {
  return RuntimeEventSchema.parse({
    emitted_at: "2026-04-13T12:00:00.000Z",
    ...event
  });
}
