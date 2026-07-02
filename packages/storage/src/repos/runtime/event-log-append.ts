import { randomUUID } from "node:crypto";
import { StorageError } from "../../shared/errors.js";
import { parseEventLogEntry } from "./event-log-rows.js";
import type { EventLogRevisionStatements, EventLogMutationStatements } from "./event-log-statement-groups.js";
import type { EventLogAppendInput } from "./event-log-types.js";
import type { EventLogEntry } from "@do-soul/alaya-protocol";

export function computeNextRevision(
  statements: Pick<EventLogRevisionStatements, "nextRevisionStatement">,
  entityType: string,
  entityId: string
): number {
  const row = statements.nextRevisionStatement.get(entityType, entityId) as
    | { readonly max_revision: number | null }
    | undefined;
  return (row?.max_revision ?? -1) + 1;
}

export function appendInCurrentTransaction(
  statements: Pick<EventLogMutationStatements, "appendStatement"> &
    Pick<EventLogRevisionStatements, "nextRevisionStatement">,
  event: EventLogAppendInput
): EventLogEntry {
  const revision = computeNextRevision(statements, event.entity_type, event.entity_id);
  const entry = parseEventLogEntry({
    ...event,
    event_id: randomUUID(),
    revision,
    created_at: new Date().toISOString()
  });

  statements.appendStatement.run(
    entry.event_id,
    entry.event_type,
    entry.entity_type,
    entry.entity_id,
    entry.workspace_id,
    entry.run_id,
    entry.caused_by,
    entry.revision,
    JSON.stringify(entry.payload_json),
    entry.created_at
  );

  return entry;
}

export function wrapAppendError(error: unknown): never {
  throw new StorageError("QUERY_FAILED", "Failed to append event log entry.", error);
}
