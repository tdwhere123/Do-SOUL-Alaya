import type { EventLogEntry } from "@do-soul/alaya-protocol";
import { CoreError } from "../../shared/errors.js";
import type { MemoryServiceEventLogRepoPort } from "./types.js";
import { isPromiseLike } from "./validators.js";

// invariant: audit-inside-transaction seams require a synchronous EventLog
// append port, otherwise storage mutation could commit without atomic audit.
export function appendAuditEventSynchronously(
  eventLogRepo: MemoryServiceEventLogRepoPort,
  eventInput: Omit<EventLogEntry, "event_id" | "created_at" | "revision">
): EventLogEntry {
  const event = eventLogRepo.append(eventInput);
  if (isPromiseLike(event)) {
    throw new CoreError(
      "CONFLICT",
      "Autonomous audit-inside-transaction requires a synchronous EventLog append port."
    );
  }
  return event;
}
