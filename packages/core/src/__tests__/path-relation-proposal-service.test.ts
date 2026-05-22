import { describe, expect, it, vi } from "vitest";
import { PathRelationSchema, type EventLogEntry } from "@do-soul/alaya-protocol";
import {
  PathRelationProposalService,
  PATH_RELATION_PROPOSE_THRESHOLD,
  type PathRelationProposalEventPublisherPort
} from "../path-relation-proposal-service.js";

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
    const service = new PathRelationProposalService({ repo, eventPublisher: publisher });

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
    const service = new PathRelationProposalService({ repo, eventPublisher: publisher });

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
    const service = new PathRelationProposalService({ repo, eventPublisher: publisher });

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
    const repo = {
      create: vi.fn((relation: any) => relation),
      findByAnchorMemoryId: vi.fn(async () => [])
    };
    const { publisher } = createEventPublisher();
    const service = new PathRelationProposalService({ repo, eventPublisher: publisher });

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
    const service = new PathRelationProposalService({ repo, eventPublisher: publisher });

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
    const service = new PathRelationProposalService({ repo, eventPublisher: publisher });

    for (let i = 0; i < PATH_RELATION_PROPOSE_THRESHOLD; i += 1) {
      await service.onCoUsage(["mem-A"], "workspace-1");
    }

    expect(repo.create).not.toHaveBeenCalled();
  });

  it("skips propose when a PathRelation already exists between the pair", async () => {
    const existing = {
      anchors: {
        source_anchor: { kind: "object" as const, object_id: "mem-A" },
        target_anchor: { kind: "object" as const, object_id: "mem-B" }
      }
    };
    const repo = {
      create: vi.fn((relation: any) => relation),
      findByAnchorMemoryId: vi.fn(async () => [existing])
    };
    const { publisher } = createEventPublisher();
    const service = new PathRelationProposalService({
      repo,
      eventPublisher: publisher,
      threshold: 1
    });

    await service.onCoUsage(["mem-A", "mem-B"], "workspace-1");

    expect(repo.create).not.toHaveBeenCalled();
  });

  it("evictExpired shrinks the in-process counter for stale sub-threshold pairs", async () => {
    const repo = {
      create: vi.fn((relation: any) => relation),
      findByAnchorMemoryId: vi.fn(async () => [])
    };
    const { publisher } = createEventPublisher();
    let nowMs = 1_000_000;
    const service = new PathRelationProposalService({
      repo,
      eventPublisher: publisher,
      threshold: 5,
      nowMs: () => nowMs,
      counterTtlMs: 1_000
    });

    await service.onCoUsage(["mem-A", "mem-B"], "workspace-1");
    nowMs = 1_001_500;
    await service.onCoUsage(["mem-C", "mem-D"], "workspace-1");
    expect(service.counterSize()).toBe(2);

    nowMs = 1_002_000;
    const removed = service.evictExpired();
    expect(removed).toBe(1);
    expect(service.counterSize()).toBe(1);

    nowMs = 1_003_000;
    const removedAgain = service.evictExpired();
    expect(removedAgain).toBe(1);
    expect(service.counterSize()).toBe(0);
  });

  it("evictExpired uses firstSeenAtMs (does not reset on each onCoUsage re-increment)", async () => {
    const repo = {
      create: vi.fn((relation: any) => relation),
      findByAnchorMemoryId: vi.fn(async () => [])
    };
    const { publisher } = createEventPublisher();
    let nowMs = 1_000_000;
    const service = new PathRelationProposalService({
      repo,
      eventPublisher: publisher,
      threshold: 10,
      nowMs: () => nowMs,
      counterTtlMs: 5_000
    });

    await service.onCoUsage(["mem-A", "mem-B"], "workspace-1");
    expect(service.counterSize()).toBe(1);

    nowMs = 1_004_000;
    await service.onCoUsage(["mem-A", "mem-B"], "workspace-1");
    expect(service.counterSize()).toBe(1);

    nowMs = 1_005_500;
    const removed = service.evictExpired();
    expect(removed).toBe(1);
    expect(service.counterSize()).toBe(0);
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
      eventPublisher: publisher,
      threshold: 5,
      nowMs: () => nowMs,
      counterTtlMs: 10_000
    });

    await service.onCoUsage(["mem-A", "mem-B"], "workspace-1");
    await service.onCoUsage(["mem-C", "mem-D"], "workspace-1");
    expect(service.counterSize()).toBe(2);

    nowMs = 2_005_000;
    expect(service.evictExpired()).toBe(0);
    expect(service.counterSize()).toBe(2);
  });
});
