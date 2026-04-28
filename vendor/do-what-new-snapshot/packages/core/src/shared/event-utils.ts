import type { EventLogEntry } from "@do-what/protocol";

export interface EventRevisionLookupPort {
  queryByEntity(entityType: string, entityId: string): Promise<readonly EventLogEntry[]>;
}

export async function getNextRevision(
  lookup: EventRevisionLookupPort,
  entityType: string,
  entityId: string
): Promise<number> {
  const events = await lookup.queryByEntity(entityType, entityId);

  if (events.length === 0) {
    return 0;
  }

  const maxRevision = events.reduce((max, event) => Math.max(max, event.revision), 0);
  return maxRevision + 1;
}

export function isUniqueConstraintError(error: unknown): boolean {
  const message = String((error as { cause?: { message?: string } })?.cause?.message ?? "");
  return message.includes("UNIQUE constraint failed");
}
