import { describe, expect, it, vi } from "vitest";
import type { EventLogEntry } from "@do-soul/alaya-protocol";
import {
  PathRelationProposalService,
  PATH_RELATION_PROPOSE_THRESHOLD,
  type CoUsageCounterPort,
  type PathRelationProposalEventPublisherPort
} from "../path-relation-proposal-service.js";

// invariant: PathRelation row insert and `path.relation_created` EventLog row
// MUST land in a single SQLite transaction. This locks the contract from the
// service side; the SQLite transaction wrapper itself is exercised in the
// EventPublisher atomicity tests.

function inMemoryCounterStore(): CoUsageCounterPort {
  const rows = new Map<string, number>();
  const keyOf = (workspaceId: string, low: string, high: string): string =>
    `${workspaceId}|${low}|${high}`;
  return {
    increment: (input) => {
      const key = keyOf(input.workspaceId, input.lowMemoryId, input.highMemoryId);
      const next = (rows.get(key) ?? 0) + 1;
      rows.set(key, next);
      return next;
    },
    delete: (workspaceId, low, high) => {
      rows.delete(keyOf(workspaceId, low, high));
    },
    evictExpired: () => 0,
    size: () => rows.size
  };
}

describe("PathRelationProposalService — EventLog-first contract", () => {
  it("invokes appendManyWithMutation once per propose, with the path.relation_created event before the row insert", async () => {
    const order: string[] = [];
    const repoCreate = vi.fn((relation: any) => {
      order.push(`row_insert:${relation.path_id}`);
      return relation;
    });
    const appendManyWithMutation = vi.fn(
      async <T,>(
        eventInputs: readonly Omit<EventLogEntry, "event_id" | "created_at" | "revision">[],
        mutate: (entries: readonly EventLogEntry[]) => T
      ): Promise<T> => {
        for (const event of eventInputs) {
          order.push(`event_append:${event.event_type}:${event.entity_id}`);
        }
        const persisted = eventInputs.map((entry, idx) => ({
          event_id: `evt_${idx}`,
          created_at: "2026-05-16T00:00:00.000Z",
          revision: 0,
          ...entry
        })) as EventLogEntry[];
        return mutate(persisted);
      }
    );

    const service = new PathRelationProposalService({
      repo: {
        create: repoCreate,
        findByAnchorMemoryId: vi.fn(async () => [])
      },
      counterStore: inMemoryCounterStore(),
      eventPublisher: {
        appendManyWithMutation
      } as unknown as PathRelationProposalEventPublisherPort,
      generateId: () => "path-fixed-1"
    });

    for (let i = 0; i < PATH_RELATION_PROPOSE_THRESHOLD; i += 1) {
      await service.onCoUsage(["mem-A", "mem-B"], "workspace-1");
    }

    expect(appendManyWithMutation).toHaveBeenCalledTimes(1);
    expect(repoCreate).toHaveBeenCalledTimes(1);
    expect(order).toEqual([
      "event_append:path.relation_created:path-fixed-1",
      "row_insert:path-fixed-1"
    ]);

    const [eventInputs] = appendManyWithMutation.mock.calls[0]!;
    expect(eventInputs).toHaveLength(1);
    expect(eventInputs[0].event_type).toBe("path.relation_created");
    expect(eventInputs[0].entity_type).toBe("path_relation");
    expect(eventInputs[0].entity_id).toBe("path-fixed-1");
    expect(eventInputs[0].payload_json).toMatchObject({
      path_id: "path-fixed-1",
      workspace_id: "workspace-1",
      relation_kind: "co_recalled",
      governance_class: "attention_only",
      source_anchor_kind: "object",
      target_anchor_kind: "object"
    });
  });

  it("rolls back the staged path.relation_created event when repo.create throws inside the tx callback", async () => {
    const repoCreate = vi.fn(() => {
      throw new Error("simulated row-insert failure");
    });
    const persistedEvents: EventLogEntry[] = [];
    // Mirrors better-sqlite3 BEGIN IMMEDIATE / COMMIT: staged event rows
    // become visible only after the synchronous mutate callback returns
    // without throwing. A thrown error discards the staged events.
    const appendManyWithMutation = vi.fn(
      async <T,>(
        eventInputs: readonly Omit<EventLogEntry, "event_id" | "created_at" | "revision">[],
        mutate: (entries: readonly EventLogEntry[]) => T
      ): Promise<T> => {
        const staged = eventInputs.map((entry, idx) => ({
          event_id: `evt_${idx}`,
          created_at: "2026-05-16T00:00:00.000Z",
          revision: 0,
          ...entry
        })) as EventLogEntry[];
        const result = mutate(staged);
        for (const event of staged) {
          persistedEvents.push(event);
        }
        return result;
      }
    );

    const warn = vi.fn();
    const service = new PathRelationProposalService({
      repo: {
        create: repoCreate,
        findByAnchorMemoryId: vi.fn(async () => [])
      },
      counterStore: inMemoryCounterStore(),
      eventPublisher: {
        appendManyWithMutation
      } as unknown as PathRelationProposalEventPublisherPort,
      warn
    });

    for (let i = 0; i < PATH_RELATION_PROPOSE_THRESHOLD; i += 1) {
      await service.onCoUsage(["mem-A", "mem-B"], "workspace-1");
    }

    expect(repoCreate).toHaveBeenCalledTimes(1);
    expect(persistedEvents).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(
      "PathRelation propose failed",
      expect.objectContaining({
        workspace_id: "workspace-1",
        error: "simulated row-insert failure"
      })
    );
  });
});
