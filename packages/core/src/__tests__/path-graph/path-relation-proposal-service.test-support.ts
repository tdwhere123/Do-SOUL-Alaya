import { vi } from "vitest";
import { type EventLogEntry } from "@do-soul/alaya-protocol";
import { type CoUsageCounterPort, type PathRelationProposalEventPublisherPort } from "../../path-graph/path-relation-proposal-service.js";

export interface CounterRow {
  count: number;
  updatedAt: string;
}

export // In-memory stand-in for SqliteCoUsageCounterRepo. Mirrors the durable repo's
// upsert-on-increment and DELETE-WHERE-updated_at<cutoff semantics so the
// service contract is exercised without a database.
function createCounterStore(): CoUsageCounterPort {
  const rows = new Map<string, CounterRow>();
  const keyOf = (workspaceId: string, low: string, high: string): string =>
    `${workspaceId}|${low}|${high}`;
  return {
    increment(input): number {
      const key = keyOf(input.workspaceId, input.lowMemoryId, input.highMemoryId);
      const existing = rows.get(key);
      const next: CounterRow = existing === undefined
        ? { count: 1, updatedAt: input.seenAt }
        : { count: existing.count + 1, updatedAt: input.seenAt };
      rows.set(key, next);
      return next.count;
    },
    delete(workspaceId, low, high): void {
      rows.delete(keyOf(workspaceId, low, high));
    },
    evictExpired(cutoff): number {
      let removed = 0;
      for (const [key, row] of rows) {
        if (row.updatedAt < cutoff) {
          rows.delete(key);
          removed += 1;
        }
      }
      return removed;
    },
    size(): number {
      return rows.size;
    }
  };
}

export function createEventPublisher(): {
  publisher: PathRelationProposalEventPublisherPort;
  appendManyWithMutation: ReturnType<typeof vi.fn>;
} {
  const appendManyWithMutation = vi.fn(
    async <T,>(
      eventInputs: readonly Omit<EventLogEntry, "event_id" | "created_at" | "revision">[],
      mutate: (entries: readonly EventLogEntry[]) => T
    ): Promise<T> => {
      const persisted: EventLogEntry[] = eventInputs.map((entry, idx) => ({
        event_id: `evt_${idx}`,
        created_at: "2026-05-16T00:00:00.000Z",
        revision: 0,
        ...entry
      })) as EventLogEntry[];
      return mutate(persisted);
    }
  );
  return {
    publisher: { appendManyWithMutation } as unknown as PathRelationProposalEventPublisherPort,
    appendManyWithMutation
  };
}
