import { describe, expect, it, vi } from "vitest";
import { PathRelationSchema, type PathRelation } from "@do-soul/alaya-protocol";
import { PathRelationProposalService, PATH_RELATION_PROPOSE_THRESHOLD, CO_RECALLED_SEED_PROFILE, type PathRelationProposalRepoPort } from "../../path-graph/edge-proposals/path-relation-proposal-service.js";

import { createCounterStore, createEventPublisher } from "./path-relation-proposal-service.test-support.js";

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
    const existing = {
      anchors: {
        source_anchor: { kind: "object" as const, object_id: "mem-A" },
        target_anchor: { kind: "object" as const, object_id: "mem-B" }
      },
      constitution: { relation_kind: "co_recalled" },
      effect_vector: { recall_bias: 0.5 }
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

  it("seeds the co-usage path at the co_recalled profile (0.3 / attention_only / +recall_bias)", async () => {
    const repo = {
      create: vi.fn((relation: any) => relation),
      findByAnchorMemoryId: vi.fn(async () => [])
    };
    const { publisher } = createEventPublisher();
    const service = new PathRelationProposalService({
      repo,
      counterStore: createCounterStore(),
      eventPublisher: publisher,
      threshold: 1
    });

    await service.onCoUsage(["mem-A", "mem-B"], "workspace-1");

    const written = repo.create.mock.calls[0][0];
    expect(written.constitution.relation_kind).toBe("co_recalled");
    expect(written.plasticity_state.strength).toBe(CO_RECALLED_SEED_PROFILE.initialStrength);
    expect(written.legitimacy.governance_class).toBe("attention_only");
    expect(written.effect_vector.recall_bias).toBeGreaterThan(0);
  });
});

describe("PathRelationProposalService — co-recall seeding", () => {
  it("counts co-recalled pairs and mints a co_recalled path at K", async () => {
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

    for (let i = 0; i < PATH_RELATION_PROPOSE_THRESHOLD - 1; i += 1) {
      await service.onCoRecall(["mem-A", "mem-B"], "workspace-1");
    }
    expect(repo.create).not.toHaveBeenCalled();

    await service.onCoRecall(["mem-A", "mem-B"], "workspace-1");
    expect(repo.create).toHaveBeenCalledTimes(1);
    const written = repo.create.mock.calls[0][0];
    expect(written.constitution.relation_kind).toBe("co_recalled");
    expect(written.legitimacy.governance_class).toBe("attention_only");
  });

  it("co-recall ignores fewer than two recalled objects", async () => {
    const repo = {
      create: vi.fn((relation: any) => relation),
      findByAnchorMemoryId: vi.fn(async () => [])
    };
    const { publisher } = createEventPublisher();
    const service = new PathRelationProposalService({
      repo,
      counterStore: createCounterStore(),
      eventPublisher: publisher,
      threshold: 1
    });

    await service.onCoRecall(["mem-solo"], "workspace-1");
    expect(repo.create).not.toHaveBeenCalled();
  });

  it("co-recall and co-usage share one counter space toward the same threshold", async () => {
    // invariant: one pair == one relation across both signals, so a mix of
    // co-recall and co-usage increments accrue toward a single threshold.
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

    await service.onCoRecall(["mem-A", "mem-B"], "workspace-1");
    await service.onCoUsage(["mem-A", "mem-B"], "workspace-1");
    expect(repo.create).not.toHaveBeenCalled();

    await service.onCoRecall(["mem-A", "mem-B"], "workspace-1");
    expect(repo.create).toHaveBeenCalledTimes(1);
  });
});
