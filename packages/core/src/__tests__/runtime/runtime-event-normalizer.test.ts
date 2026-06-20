import { type EventLogEntry } from "@do-soul/alaya-protocol";
import { describe, expect, it, vi } from "vitest";
import { RuntimeEventNormalizer, RuntimeEventNormalizerPropagationError } from "../../runtime/runtime-event-normalizer.js";

import { context, createEventLogEntry, createHarness, makeRuntimeEvent } from "./runtime-event-normalizer.test-support.js";

describe("RuntimeEventNormalizer", () => {
it("maps session_started to EventLog append then notify", async () => {
    const operations: string[] = [];
    const { normalizer, appendSpy, notifyEntry } = createHarness(operations);
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
        payload_json: {
          sessionId: "session-1",
          emittedAt: event.emitted_at
        }
      })
    );
    expect(operations).toEqual(["append:worker.session_started", "notify:worker.session_started"]);
    expect(appendSpy).toHaveBeenCalledTimes(1);
    expect(notifyEntry).toHaveBeenCalledWith(result);
  });

it("retries a pending session_started notification without appending a duplicate", async () => {
    const event = makeRuntimeEvent({
      type: "session_started",
      session_id: "session-1"
    });
    const appendSpy = vi.fn(
      async (entry: Omit<EventLogEntry, "event_id" | "created_at" | "revision">) => createEventLogEntry(entry)
    );
    const notifyEntry = vi
      .fn<(entry: EventLogEntry) => Promise<void>>()
      .mockRejectedValueOnce(new Error("notify exploded"))
      .mockResolvedValueOnce(undefined);
    const normalizer = new RuntimeEventNormalizer({
      eventLogRepo: { append: appendSpy },
      runtimeNotifier: { notifyEntry }
    });

    const rejection = await normalizer.normalize(event, context).catch((error: unknown) => error);

    expect(rejection).toBeInstanceOf(RuntimeEventNormalizerPropagationError);
    expect(rejection).toMatchObject({
      name: "RuntimeEventNormalizerPropagationError",
      entry: expect.objectContaining({ event_type: "worker.session_started" })
    });
    await expect(normalizer.normalize(event, context)).resolves.toEqual(
      expect.objectContaining({ event_type: "worker.session_started" })
    );

    expect(appendSpy).toHaveBeenCalledTimes(1);
    expect(notifyEntry).toHaveBeenCalledTimes(2);
  });

it("single-flights concurrent retries for the same pending notification", async () => {
    const event = makeRuntimeEvent({
      type: "session_started",
      session_id: "session-1"
    });
    let releaseRetry!: () => void;
    const appendSpy = vi.fn(
      async (entry: Omit<EventLogEntry, "event_id" | "created_at" | "revision">) => createEventLogEntry(entry)
    );
    const notifyEntry = vi
      .fn<(entry: EventLogEntry) => Promise<void>>()
      .mockRejectedValueOnce(new Error("notify exploded"))
      .mockImplementationOnce(
        async () =>
          await new Promise<void>((resolve) => {
            releaseRetry = resolve;
          })
      );
    const normalizer = new RuntimeEventNormalizer({
      eventLogRepo: { append: appendSpy },
      runtimeNotifier: { notifyEntry }
    });

    await expect(normalizer.normalize(event, context)).rejects.toMatchObject({
      name: "RuntimeEventNormalizerPropagationError",
      entry: expect.objectContaining({ event_type: "worker.session_started" })
    });

    const firstRetry = normalizer.normalize(event, context);
    const secondRetry = normalizer.normalize(event, context);
    await Promise.resolve();

    expect(appendSpy).toHaveBeenCalledTimes(1);
    expect(notifyEntry).toHaveBeenCalledTimes(2);

    releaseRetry();

    await expect(Promise.all([firstRetry, secondRetry])).resolves.toEqual([
      expect.objectContaining({ event_type: "worker.session_started" }),
      expect.objectContaining({ event_type: "worker.session_started" })
    ]);
    expect(appendSpy).toHaveBeenCalledTimes(1);
    expect(notifyEntry).toHaveBeenCalledTimes(2);
  });

it("keeps a pending notification retryable after the retry itself fails", async () => {
    const event = makeRuntimeEvent({
      type: "session_started",
      session_id: "session-1"
    });
    const appendSpy = vi.fn(
      async (entry: Omit<EventLogEntry, "event_id" | "created_at" | "revision">) => createEventLogEntry(entry)
    );
    const notifyEntry = vi
      .fn<(entry: EventLogEntry) => void | Promise<void>>()
      .mockRejectedValueOnce(new Error("initial notify failed"))
      .mockImplementationOnce(() => {
        throw new Error("retry notify failed");
      })
      .mockResolvedValueOnce(undefined);
    const normalizer = new RuntimeEventNormalizer({
      eventLogRepo: { append: appendSpy },
      runtimeNotifier: { notifyEntry }
    });

    await expect(normalizer.normalize(event, context)).rejects.toMatchObject({
      name: "RuntimeEventNormalizerPropagationError",
      entry: expect.objectContaining({ event_type: "worker.session_started" })
    });
    await expect(normalizer.normalize(event, context)).rejects.toMatchObject({
      name: "RuntimeEventNormalizerPropagationError",
      entry: expect.objectContaining({ event_type: "worker.session_started" })
    });
    await expect(normalizer.normalize(event, context)).resolves.toEqual(
      expect.objectContaining({ event_type: "worker.session_started" })
    );

    expect(appendSpy).toHaveBeenCalledTimes(1);
    expect(notifyEntry).toHaveBeenCalledTimes(3);
  });

it("deduplicates message_delta only by session_id and sequence", async () => {
    const operations: string[] = [];
    const { normalizer, appendSpy, notifyEntry } = createHarness(operations);
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
      "notify:worker.message_delta",
      "append:worker.message_delta",
      "notify:worker.message_delta"
    ]);
    expect(appendSpy).toHaveBeenCalledTimes(2);
    expect(notifyEntry).toHaveBeenCalledTimes(2);
  });

it("reserves message_delta dedup before awaiting IO so concurrent duplicates do not double-append", async () => {
    let releaseAppend!: () => void;
    const appendSpy = vi.fn(
      async (entry: Omit<EventLogEntry, "event_id" | "created_at" | "revision">) =>
        await new Promise<EventLogEntry>((resolve) => {
          releaseAppend = () => resolve(createEventLogEntry(entry));
        })
    );
    const notifyEntry = vi.fn(async () => undefined);
    const normalizer = new RuntimeEventNormalizer({
      eventLogRepo: { append: appendSpy },
      runtimeNotifier: { notifyEntry }
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

it("retries a pending session_finished notification without appending a duplicate", async () => {
    const event = makeRuntimeEvent({
      type: "session_finished",
      session_id: "session-1",
      status: "completed",
      result_summary: "done"
    });
    const appendSpy = vi.fn(
      async (entry: Omit<EventLogEntry, "event_id" | "created_at" | "revision">) => createEventLogEntry(entry)
    );
    const notifyEntry = vi
      .fn<(entry: EventLogEntry) => Promise<void>>()
      .mockRejectedValueOnce(new Error("notify exploded"))
      .mockResolvedValueOnce(undefined);
    const normalizer = new RuntimeEventNormalizer({
      eventLogRepo: { append: appendSpy },
      runtimeNotifier: { notifyEntry }
    });

    const rejection = await normalizer.normalize(event, context).catch((error: unknown) => error);

    expect(rejection).toBeInstanceOf(RuntimeEventNormalizerPropagationError);
    expect(rejection).toMatchObject({
      name: "RuntimeEventNormalizerPropagationError",
      entry: expect.objectContaining({ event_type: "worker.session_finished" })
    });
    await expect(normalizer.normalize(event, context)).resolves.toEqual(
      expect.objectContaining({ event_type: "worker.session_finished" })
    );
    await expect(normalizer.normalize(event, context)).resolves.toEqual(
      expect.objectContaining({ event_type: "worker.session_finished" })
    );

    expect(appendSpy).toHaveBeenCalledTimes(2);
    expect(notifyEntry).toHaveBeenCalledTimes(3);
  });

it("releases session_finished dedup when append fails before persisting", async () => {
    const event = makeRuntimeEvent({
      type: "session_finished",
      session_id: "session-1",
      status: "completed",
      result_summary: "done"
    });
    const appendSpy = vi
      .fn<(entry: Omit<EventLogEntry, "event_id" | "created_at" | "revision">) => Promise<EventLogEntry>>()
      .mockRejectedValueOnce(new Error("append exploded"))
      .mockImplementationOnce(async (entry) => createEventLogEntry(entry));
    const notifyEntry = vi.fn(async () => undefined);
    const normalizer = new RuntimeEventNormalizer({
      eventLogRepo: { append: appendSpy },
      runtimeNotifier: { notifyEntry }
    });

    await expect(normalizer.normalize(event, context)).rejects.toThrow("append exploded");
    await expect(normalizer.normalize(event, context)).resolves.toEqual(
      expect.objectContaining({ event_type: "worker.session_finished" })
    );

    expect(appendSpy).toHaveBeenCalledTimes(2);
    expect(notifyEntry).toHaveBeenCalledTimes(1);
  });

it("clears session_finished dedup state after session_finished succeeds", async () => {
    const { normalizer, appendSpy, notifyEntry } = createHarness([]);
    const event = makeRuntimeEvent({
      type: "session_finished",
      session_id: "session-1",
      status: "completed",
      result_summary: "done"
    });

    await normalizer.normalize(event, context);
    await normalizer.normalize(event, context);

    expect(appendSpy).toHaveBeenCalledTimes(2);
    expect(notifyEntry).toHaveBeenCalledTimes(2);
  });

it("clearSessionState releases session_finished dedup after a partial-success cleanup", async () => {
    const event = makeRuntimeEvent({
      type: "session_finished",
      session_id: "session-1",
      status: "completed",
      result_summary: "done"
    });
    const appendSpy = vi.fn(
      async (entry: Omit<EventLogEntry, "event_id" | "created_at" | "revision">) => createEventLogEntry(entry)
    );
    const notifyEntry = vi
      .fn<(entry: EventLogEntry) => Promise<void>>()
      .mockRejectedValueOnce(new Error("notify exploded"))
      .mockResolvedValueOnce(undefined);
    const normalizer = new RuntimeEventNormalizer({
      eventLogRepo: { append: appendSpy },
      runtimeNotifier: { notifyEntry }
    });

    await expect(normalizer.normalize(event, context)).rejects.toMatchObject({
      name: "RuntimeEventNormalizerPropagationError",
      entry: expect.objectContaining({ event_type: "worker.session_finished" })
    });
    normalizer.clearSessionState("session-1");
    await expect(normalizer.normalize(event, context)).resolves.toEqual(
      expect.objectContaining({ event_type: "worker.session_finished" })
    );

    expect(appendSpy).toHaveBeenCalledTimes(2);
    expect(notifyEntry).toHaveBeenCalledTimes(2);
  });

it("keeps the earliest pending notification when the pending cap is reached", async () => {
    const warnings: Array<{ message: string; meta: Record<string, unknown> }> = [];
    const appendSpy = vi.fn(
      async (entry: Omit<EventLogEntry, "event_id" | "created_at" | "revision">) => createEventLogEntry(entry)
    );
    const notifyEntry = vi
      .fn<(entry: EventLogEntry) => Promise<void>>()
      .mockRejectedValue(new Error("notify exploded"));
    const normalizer = new RuntimeEventNormalizer({
      eventLogRepo: { append: appendSpy },
      runtimeNotifier: { notifyEntry },
      maxPendingNotifications: 1,
      warn: (message, meta) => {
        warnings.push({ message, meta });
      }
    });
    const first = makeRuntimeEvent({
      type: "session_started",
      session_id: "session-1"
    });
    const second = makeRuntimeEvent({
      type: "session_started",
      session_id: "session-2"
    });

    await expect(normalizer.normalize(first, context)).rejects.toMatchObject({
      name: "RuntimeEventNormalizerPropagationError",
      entry: expect.objectContaining({ event_type: "worker.session_started" })
    });
    await expect(normalizer.normalize(second, context)).rejects.toMatchObject({
      name: "RuntimeEventNormalizerPropagationError",
      entry: expect.objectContaining({ event_type: "worker.session_started" })
    });

    expect(warnings).toEqual([
      {
        message: "Runtime event normalizer pending-notification cap reached; new pending notification will not be retained for retry.",
        meta: expect.objectContaining({
          max_pending_notifications: 1,
          pending_key: "session_started:session-2",
          event_type: "worker.session_started"
        })
      }
    ]);
    await expect(normalizer.normalize(first, context)).rejects.toMatchObject({
      name: "RuntimeEventNormalizerPropagationError",
      entry: expect.objectContaining({ event_type: "worker.session_started" })
    });
    expect(appendSpy).toHaveBeenCalledTimes(2);
  });

it("clears message_delta dedup state after session_finished succeeds", async () => {
    const operations: string[] = [];
    const { normalizer, appendSpy, notifyEntry } = createHarness(operations);
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
    expect(notifyEntry).toHaveBeenCalledTimes(3);
    expect(operations).toEqual([
      "append:worker.message_delta",
      "notify:worker.message_delta",
      "append:worker.session_finished",
      "notify:worker.session_finished",
      "append:worker.message_delta",
      "notify:worker.message_delta"
    ]);
  });

it("preserves message_delta dedup correctness across multiple live sessions", async () => {
    const operations: string[] = [];
    const { normalizer, appendSpy, notifyEntry } = createHarness(operations);

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
    expect(notifyEntry).toHaveBeenCalledTimes(3);
  });
});
