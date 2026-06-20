import { RuntimeEventSchema, type EventLogEntry, type RuntimeEvent } from "@do-soul/alaya-protocol";
import { vi } from "vitest";
import { RuntimeEventNormalizer, type NormalizerContext } from "../../runtime/runtime-event-normalizer.js";

export const context: NormalizerContext = {
  workspaceId: "ws-1",
  principalRunId: "run-1",
  workerRunId: "worker-1"
};

export function createHarness(operations: string[]) {
  const appendSpy = vi.fn(async (entry: Omit<EventLogEntry, "event_id" | "created_at" | "revision">) => {
    operations.push(`append:${entry.event_type}`);
    return createEventLogEntry(entry);
  });
  const notifyEntry = vi.fn(async (entry: EventLogEntry) => {
    operations.push(`notify:${entry.event_type}`);
  });
  const normalizer = new RuntimeEventNormalizer({
    eventLogRepo: { append: appendSpy },
    runtimeNotifier: { notifyEntry }
  });

  return { normalizer, appendSpy, notifyEntry };
}

export function createEventLogEntry(input: Omit<EventLogEntry, "event_id" | "created_at" | "revision">): EventLogEntry {
  return {
    event_id: `evt_${input.event_type}`,
    created_at: "2026-04-13T12:00:01.000Z",
    revision: 0,
    ...input
  };
}

export function makeRuntimeEvent(event: Record<string, unknown>): RuntimeEvent {
  return RuntimeEventSchema.parse({
    emitted_at: "2026-04-13T12:00:00.000Z",
    ...event
  });
}
