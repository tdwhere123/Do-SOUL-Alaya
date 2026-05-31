import { describe, expect, it, vi } from "vitest";
import type { EventLogEntry } from "@do-soul/alaya-protocol";
import { EventPublisherPropagationError } from "../event-publisher.js";
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
    // Counter-gated co-recall accrues across runs; no single run owns the
    // mint, so the audit row's run attribution stays null.
    expect(eventInputs[0].run_id).toBeNull();
    expect(eventInputs[0].payload_json).toMatchObject({
      path_id: "path-fixed-1",
      workspace_id: "workspace-1",
      relation_kind: "co_recalled",
      governance_class: "attention_only",
      source_anchor_kind: "object",
      target_anchor_kind: "object"
    });
  });

  it("threads submitCandidate runId into the path.relation_created audit row", async () => {
    const capturedRunIds: (string | null)[] = [];
    const appendManyWithMutation = vi.fn(
      async <T,>(
        eventInputs: readonly Omit<EventLogEntry, "event_id" | "created_at" | "revision">[],
        mutate: (entries: readonly EventLogEntry[]) => T
      ): Promise<T> => {
        for (const event of eventInputs) {
          capturedRunIds.push(event.run_id);
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
        create: vi.fn((relation: any) => relation),
        findByAnchorMemoryId: vi.fn(async () => [])
      },
      counterStore: inMemoryCounterStore(),
      eventPublisher: {
        appendManyWithMutation
      } as unknown as PathRelationProposalEventPublisherPort,
      generateId: () => "path-attributed-1"
    });

    const minted = await service.submitCandidate({
      workspaceId: "workspace-1",
      sourceAnchor: { kind: "object", object_id: "mem-A" },
      targetAnchor: { kind: "object", object_id: "mem-B" },
      relationKind: "supports",
      initialStrength: 0.5,
      governanceClass: "attention_only",
      evidenceBasis: ["llm_supports_verdict"],
      recallBiasSign: 1,
      recallBiasMagnitude: 0.5,
      runId: "run-7f3c"
    });

    expect(minted).toBe("applied");
    expect(appendManyWithMutation).toHaveBeenCalledTimes(1);
    const [eventInputs] = appendManyWithMutation.mock.calls[0]!;
    expect(eventInputs[0].event_type).toBe("path.relation_created");
    expect(eventInputs[0].run_id).toBe("run-7f3c");
    expect(capturedRunIds).toEqual(["run-7f3c"]);
  });

  it("leaves the audit run_id null when submitCandidate omits runId", async () => {
    let capturedRunId: string | null = "unset";
    const appendManyWithMutation = vi.fn(
      async <T,>(
        eventInputs: readonly Omit<EventLogEntry, "event_id" | "created_at" | "revision">[],
        mutate: (entries: readonly EventLogEntry[]) => T
      ): Promise<T> => {
        capturedRunId = eventInputs[0]!.run_id;
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
        create: vi.fn((relation: any) => relation),
        findByAnchorMemoryId: vi.fn(async () => [])
      },
      counterStore: inMemoryCounterStore(),
      eventPublisher: {
        appendManyWithMutation
      } as unknown as PathRelationProposalEventPublisherPort,
      generateId: () => "path-unattributed-1"
    });

    await service.submitCandidate({
      workspaceId: "workspace-1",
      sourceAnchor: { kind: "object", object_id: "mem-A" },
      targetAnchor: { kind: "object", object_id: "mem-B" },
      relationKind: "supports",
      initialStrength: 0.5,
      governanceClass: "attention_only",
      evidenceBasis: ["llm_supports_verdict"],
      recallBiasSign: 1
    });

    expect(capturedRunId).toBeNull();
  });

  // invariant (FIX-4): a propagation failure AFTER the row+event committed is
  // not a mint failure. EventPublisher.appendManyWithMutation commits the
  // path_relations row + PATH_RELATION_CREATED event in the transaction, runs
  // propagate() after, and surfaces a propagate() throw as
  // EventPublisherPropagationError — the path is DURABLE. submitCandidate must
  // return "applied", not "failed", so a no-drop consumer (edge-proposal accept)
  // does not record a misleading PATH_MINT_FAILED audit and needlessly revert an
  // accepted proposal whose path exists.
  it("returns applied (not failed) when propagation throws AFTER the row committed", async () => {
    const repoCreate = vi.fn((relation: any) => relation);
    const committedEntries: EventLogEntry[] = [];
    const appendManyWithMutation = vi.fn(
      async <T,>(
        eventInputs: readonly Omit<EventLogEntry, "event_id" | "created_at" | "revision">[],
        mutate: (entries: readonly EventLogEntry[]) => T
      ): Promise<T> => {
        const persisted = eventInputs.map((entry, idx) => ({
          event_id: `evt_${idx}`,
          created_at: "2026-05-16T00:00:00.000Z",
          revision: 0,
          ...entry
        })) as EventLogEntry[];
        // The transaction commits (mutate runs, row + event durable) BEFORE the
        // post-commit propagate() throw surfaces.
        const result = mutate(persisted);
        committedEntries.push(...persisted);
        void result;
        throw new EventPublisherPropagationError(
          persisted[0]!,
          new Error("in-process listener rejected"),
          persisted
        );
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
      generateId: () => "path-post-commit-1",
      warn
    });

    const outcome = await service.submitCandidate({
      workspaceId: "workspace-1",
      sourceAnchor: { kind: "object", object_id: "mem-A" },
      targetAnchor: { kind: "object", object_id: "mem-B" },
      relationKind: "supports",
      initialStrength: 0.5,
      governanceClass: "attention_only",
      evidenceBasis: ["llm_supports_verdict"],
      recallBiasSign: 1
    });

    // The durable row landed and the outcome is applied (eventually-consistent
    // propagation), NOT a transient failed.
    expect(outcome).toBe("applied");
    expect(repoCreate).toHaveBeenCalledTimes(1);
    expect(committedEntries).toHaveLength(1);
    // It is logged as a committed-but-propagation-failed, not a mint failure.
    expect(warn).toHaveBeenCalledWith(
      "PathRelation submitCandidate committed but propagation failed",
      expect.objectContaining({ workspace_id: "workspace-1", relation_kind: "supports" })
    );
    expect(warn).not.toHaveBeenCalledWith("PathRelation submitCandidate failed", expect.anything());
  });

  // invariant (FIX-4): a genuine pre-commit failure (the row never committed)
  // is still "failed" — the post-commit guard must not mask a real mint failure.
  it("returns failed for a non-propagation throw (row never committed)", async () => {
    const appendManyWithMutation = vi.fn(async (): Promise<never> => {
      throw new Error("BEGIN IMMEDIATE failed before commit");
    });
    const warn = vi.fn();
    const service = new PathRelationProposalService({
      repo: {
        create: vi.fn((relation: any) => relation),
        findByAnchorMemoryId: vi.fn(async () => [])
      },
      counterStore: inMemoryCounterStore(),
      eventPublisher: {
        appendManyWithMutation
      } as unknown as PathRelationProposalEventPublisherPort,
      generateId: () => "path-precommit-fail-1",
      warn
    });

    const outcome = await service.submitCandidate({
      workspaceId: "workspace-1",
      sourceAnchor: { kind: "object", object_id: "mem-A" },
      targetAnchor: { kind: "object", object_id: "mem-B" },
      relationKind: "supports",
      initialStrength: 0.5,
      governanceClass: "attention_only",
      evidenceBasis: ["llm_supports_verdict"],
      recallBiasSign: 1
    });

    expect(outcome).toBe("failed");
    expect(warn).toHaveBeenCalledWith(
      "PathRelation submitCandidate failed",
      expect.objectContaining({ workspace_id: "workspace-1" })
    );
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
