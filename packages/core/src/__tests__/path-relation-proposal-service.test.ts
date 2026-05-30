import { describe, expect, it, vi } from "vitest";
import { PathRelationSchema, type EventLogEntry, type PathRelation } from "@do-soul/alaya-protocol";
import {
  PathRelationProposalService,
  PATH_RELATION_PROPOSE_THRESHOLD,
  type CoUsageCounterPort,
  type PathRelationProposalEventPublisherPort,
  type PathRelationProposalRepoPort
} from "../path-relation-proposal-service.js";

interface CounterRow {
  count: number;
  updatedAt: string;
}

// In-memory stand-in for SqliteCoUsageCounterRepo. Mirrors the durable repo's
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

function createEventPublisher(): {
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

describe("PathRelationProposalService", () => {
  it("does not propose before the threshold is reached", async () => {
    const repo = {
      create: vi.fn((relation: any) => relation),
      findByAnchorMemoryId: vi.fn(async () => [])
    };
    const { publisher } = createEventPublisher();
    const service = new PathRelationProposalService({
      repo,
      counterStore: createCounterStore(),
      eventPublisher: publisher
    });

    for (let i = 1; i < PATH_RELATION_PROPOSE_THRESHOLD; i += 1) {
      await service.onCoUsage(["mem-A", "mem-B"], "workspace-1");
    }

    expect(repo.create).not.toHaveBeenCalled();
  });

  it("proposes a PathRelation when the same pair co-occurs K times", async () => {
    const repo = {
      create: vi.fn((relation: any) => relation),
      findByAnchorMemoryId: vi.fn(async () => [])
    };
    const { publisher, appendManyWithMutation } = createEventPublisher();
    const service = new PathRelationProposalService({
      repo,
      counterStore: createCounterStore(),
      eventPublisher: publisher
    });

    for (let i = 0; i < PATH_RELATION_PROPOSE_THRESHOLD; i += 1) {
      await service.onCoUsage(["mem-A", "mem-B"], "workspace-1");
    }

    expect(repo.create).toHaveBeenCalledTimes(1);
    expect(appendManyWithMutation).toHaveBeenCalledTimes(1);
    const written = repo.create.mock.calls[0][0];
    expect(written.workspace_id).toBe("workspace-1");
    const anchorIds = [
      written.anchors.source_anchor.object_id,
      written.anchors.target_anchor.object_id
    ].sort();
    expect(anchorIds).toEqual(["mem-A", "mem-B"]);
    expect(() => PathRelationSchema.parse(written)).not.toThrow();

    const [eventInputs] = appendManyWithMutation.mock.calls[0]!;
    expect(eventInputs).toHaveLength(1);
    expect(eventInputs[0].event_type).toBe("path.relation_created");
    expect(eventInputs[0].entity_type).toBe("path_relation");
    expect(eventInputs[0].entity_id).toBe(written.path_id);
    expect(eventInputs[0].workspace_id).toBe("workspace-1");
  });

  it("mints a co-usage path at attention_only — not a recall-eligible class", async () => {
    // A co-usage path is an agent self-report aggregate. It must be born
    // below the recall-eligible governance band: attention_only is
    // auditable and lens-visible but earns no recall-expansion boost and
    // cannot bias agent dialogue until it accrues support_events_count >= 8
    // through the legitimate path-manifestation-policy ladder.
    const repo = {
      create: vi.fn((relation: any) => relation),
      findByAnchorMemoryId: vi.fn(async () => [])
    };
    const { publisher, appendManyWithMutation } = createEventPublisher();
    const service = new PathRelationProposalService({
      repo,
      counterStore: createCounterStore(),
      eventPublisher: publisher
    });

    for (let i = 0; i < PATH_RELATION_PROPOSE_THRESHOLD; i += 1) {
      await service.onCoUsage(["mem-A", "mem-B"], "workspace-1");
    }

    const written = repo.create.mock.calls[0][0];
    expect(written.legitimacy.governance_class).toBe("attention_only");
    expect(written.legitimacy.governance_class).not.toBe("recall_allowed");
    expect(written.legitimacy.governance_class).not.toBe("strictly_governed");

    const [eventInputs] = appendManyWithMutation.mock.calls[0]!;
    expect(eventInputs[0].payload_json.governance_class).toBe("attention_only");
  });

  it("does not double-propose the same pair", async () => {
    // invariant: durable dedup. A persisted PathRelation is surfaced by
    // findByAnchorMemoryId, so the pair does not re-propose even when its
    // counter row drops on propose and then re-accrues from co-usage.
    const created: any[] = [];
    const repo = {
      create: vi.fn((relation: any) => {
        created.push(relation);
        return relation;
      }),
      findByAnchorMemoryId: vi.fn(async () => created)
    };
    const { publisher } = createEventPublisher();
    const service = new PathRelationProposalService({
      repo,
      counterStore: createCounterStore(),
      eventPublisher: publisher
    });

    for (let i = 0; i < PATH_RELATION_PROPOSE_THRESHOLD + 5; i += 1) {
      await service.onCoUsage(["mem-A", "mem-B"], "workspace-1");
    }

    expect(repo.create).toHaveBeenCalledTimes(1);
  });

  it("counts pairs symmetrically (mem-A,mem-B == mem-B,mem-A)", async () => {
    const repo = {
      create: vi.fn((relation: any) => relation),
      findByAnchorMemoryId: vi.fn(async () => [])
    };
    const { publisher } = createEventPublisher();
    const service = new PathRelationProposalService({
      repo,
      counterStore: createCounterStore(),
      eventPublisher: publisher,
      threshold: 3
    });

    await service.onCoUsage(["mem-A", "mem-B"], "workspace-1");
    await service.onCoUsage(["mem-B", "mem-A"], "workspace-1");
    await service.onCoUsage(["mem-A", "mem-B"], "workspace-1");

    expect(repo.create).toHaveBeenCalledTimes(1);
  });

  it("ignores single-used pairs (no propose when len < 2)", async () => {
    const repo = {
      create: vi.fn((relation: any) => relation),
      findByAnchorMemoryId: vi.fn(async () => [])
    };
    const { publisher } = createEventPublisher();
    const service = new PathRelationProposalService({
      repo,
      counterStore: createCounterStore(),
      eventPublisher: publisher
    });

    for (let i = 0; i < PATH_RELATION_PROPOSE_THRESHOLD; i += 1) {
      await service.onCoUsage(["mem-A"], "workspace-1");
    }

    expect(repo.create).not.toHaveBeenCalled();
  });

  it("skips propose when a PathRelation already exists between the pair", async () => {
    // Only `anchors` is load-bearing here: anchorPointsAt dedup reads
    // relation.anchors and nothing else, so a partial stub asserted to
    // PathRelation exercises the skip-on-existing branch without a full clone.
    const existing = {
      anchors: {
        source_anchor: { kind: "object" as const, object_id: "mem-A" },
        target_anchor: { kind: "object" as const, object_id: "mem-B" }
      }
    } as PathRelation;
    const repo = {
      create: vi.fn((relation: any) => relation),
      findByAnchorMemoryId: vi.fn<NonNullable<PathRelationProposalRepoPort["findByAnchorMemoryId"]>>(
        async () => [existing]
      )
    };
    const { publisher } = createEventPublisher();
    const service = new PathRelationProposalService({
      repo,
      counterStore: createCounterStore(),
      eventPublisher: publisher,
      threshold: 1
    });

    await service.onCoUsage(["mem-A", "mem-B"], "workspace-1");

    expect(repo.create).not.toHaveBeenCalled();
  });

  it("reads the default threshold from DYNAMICS_CONSTANTS (3) and honors a lower override", async () => {
    const overrideRepo = {
      create: vi.fn((relation: any) => relation),
      findByAnchorMemoryId: vi.fn(async () => [])
    };
    const { publisher: overridePublisher } = createEventPublisher();
    const overrideService = new PathRelationProposalService({
      repo: overrideRepo,
      counterStore: createCounterStore(),
      eventPublisher: overridePublisher,
      threshold: 1
    });
    await overrideService.onCoUsage(["mem-A", "mem-B"], "workspace-1");
    expect(overrideRepo.create).toHaveBeenCalledTimes(1);

    const defaultRepo = {
      create: vi.fn((relation: any) => relation),
      findByAnchorMemoryId: vi.fn(async () => [])
    };
    const { publisher: defaultPublisher } = createEventPublisher();
    const defaultService = new PathRelationProposalService({
      repo: defaultRepo,
      counterStore: createCounterStore(),
      eventPublisher: defaultPublisher
    });
    expect(PATH_RELATION_PROPOSE_THRESHOLD).toBe(3);
    await defaultService.onCoUsage(["mem-A", "mem-B"], "workspace-1");
    await defaultService.onCoUsage(["mem-A", "mem-B"], "workspace-1");
    expect(defaultRepo.create).not.toHaveBeenCalled();
    await defaultService.onCoUsage(["mem-A", "mem-B"], "workspace-1");
    expect(defaultRepo.create).toHaveBeenCalledTimes(1);
  });

  it("evictExpired shrinks the counter for stale sub-threshold pairs", async () => {
    const repo = {
      create: vi.fn((relation: any) => relation),
      findByAnchorMemoryId: vi.fn(async () => [])
    };
    const { publisher } = createEventPublisher();
    let nowMs = 1_000_000;
    const service = new PathRelationProposalService({
      repo,
      counterStore: createCounterStore(),
      eventPublisher: publisher,
      threshold: 5,
      now: () => new Date(nowMs).toISOString(),
      nowMs: () => nowMs,
      counterTtlMs: 1_000
    });

    await service.onCoUsage(["mem-A", "mem-B"], "workspace-1");
    nowMs = 1_001_500;
    await service.onCoUsage(["mem-C", "mem-D"], "workspace-1");
    expect(await service.counterSize()).toBe(2);

    nowMs = 1_002_000;
    const removed = await service.evictExpired();
    expect(removed).toBe(1);
    expect(await service.counterSize()).toBe(1);

    nowMs = 1_003_000;
    const removedAgain = await service.evictExpired();
    expect(removedAgain).toBe(1);
    expect(await service.counterSize()).toBe(0);
  });

  it("evictExpired keys on updated_at: a re-incremented pair refreshes and survives", async () => {
    // Durable counters DELETE WHERE updated_at < cutoff. A pair that is
    // re-used inside the TTL window refreshes updated_at and is therefore not
    // evicted, even if its first observation predates the cutoff.
    const repo = {
      create: vi.fn((relation: any) => relation),
      findByAnchorMemoryId: vi.fn(async () => [])
    };
    const { publisher } = createEventPublisher();
    let nowMs = 1_000_000;
    const service = new PathRelationProposalService({
      repo,
      counterStore: createCounterStore(),
      eventPublisher: publisher,
      threshold: 10,
      now: () => new Date(nowMs).toISOString(),
      nowMs: () => nowMs,
      counterTtlMs: 5_000
    });

    await service.onCoUsage(["mem-A", "mem-B"], "workspace-1");
    expect(await service.counterSize()).toBe(1);

    // Re-use at +4s refreshes updated_at to 1_004_000.
    nowMs = 1_004_000;
    await service.onCoUsage(["mem-A", "mem-B"], "workspace-1");
    expect(await service.counterSize()).toBe(1);

    // At +5.5s the cutoff (now - ttl = 1_000_500) is below the refreshed
    // updated_at, so the pair survives.
    nowMs = 1_005_500;
    const removed = await service.evictExpired();
    expect(removed).toBe(0);
    expect(await service.counterSize()).toBe(1);

    // Once the refreshed updated_at falls past the cutoff it is evicted.
    nowMs = 1_010_000;
    expect(await service.evictExpired()).toBe(1);
    expect(await service.counterSize()).toBe(0);
  });

  it("evictExpired keeps fresh sub-threshold pairs when ttl has not elapsed", async () => {
    const repo = {
      create: vi.fn((relation: any) => relation),
      findByAnchorMemoryId: vi.fn(async () => [])
    };
    const { publisher } = createEventPublisher();
    let nowMs = 2_000_000;
    const service = new PathRelationProposalService({
      repo,
      counterStore: createCounterStore(),
      eventPublisher: publisher,
      threshold: 5,
      now: () => new Date(nowMs).toISOString(),
      nowMs: () => nowMs,
      counterTtlMs: 10_000
    });

    await service.onCoUsage(["mem-A", "mem-B"], "workspace-1");
    await service.onCoUsage(["mem-C", "mem-D"], "workspace-1");
    expect(await service.counterSize()).toBe(2);

    nowMs = 2_005_000;
    expect(await service.evictExpired()).toBe(0);
    expect(await service.counterSize()).toBe(2);
  });
});
