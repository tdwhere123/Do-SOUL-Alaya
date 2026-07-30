import type { EventLogEntry } from "@do-soul/alaya-protocol";
import { CoreError } from "../../shared/errors.js";
import {
  appendEventLogSynchronously,
  EventLogSyncAppendRequiredError
} from "../../runtime/event-publisher.js";
import type { MemoryServiceEventLogRepoPort } from "./types.js";

export function appendMemoryEventLogSynchronously(
  eventLogRepo: MemoryServiceEventLogRepoPort,
  eventInput: Omit<EventLogEntry, "event_id" | "created_at" | "revision">,
  conflictMessage: string
): EventLogEntry {
  try {
    return appendEventLogSynchronously(eventLogRepo, eventInput);
  } catch (error) {
    if (error instanceof EventLogSyncAppendRequiredError) {
      throw new CoreError("CONFLICT", conflictMessage, { cause: error });
    }
    throw error;
  }
}

// invariant: audit-inside-transaction seams require a synchronous EventLog
// append port, otherwise storage mutation could commit without atomic audit.
export function appendAuditEventSynchronously(
  eventLogRepo: MemoryServiceEventLogRepoPort,
  eventInput: Omit<EventLogEntry, "event_id" | "created_at" | "revision">
): EventLogEntry {
  return appendMemoryEventLogSynchronously(
    eventLogRepo,
    eventInput,
    "Autonomous audit-inside-transaction requires a synchronous EventLog append port."
  );
}
