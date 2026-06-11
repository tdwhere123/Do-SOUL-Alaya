import { describe, expect, it, vi } from "vitest";
import { PathRelationSchema, type EventLogEntry, type PathRelation } from "@do-soul/alaya-protocol";
import {
  PathRelationProposalService,
  PATH_RELATION_PROPOSE_THRESHOLD,
  CO_RECALLED_SEED_PROFILE,
  SUPPORTS_SEED_PROFILE,
  SHARES_ENTITY_SEED_PROFILE,
  SIGNAL_GRAPH_REF_SEED_PROFILE,
  SUPERSEDES_SEED_PROFILE,
  CONTRADICTS_SEED_PROFILE,
  EXCEPTION_TO_SEED_PROFILE,
  type CoUsageCounterPort,
  type MemoryAnchorExistencePort,
  type PathRelationProposalEventPublisherPort,
  type PathRelationProposalRepoPort,
  type SubmitCandidateInput
} from "../../path-graph/path-relation-proposal-service.js";

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

describe("PathRelationProposalService — submitCandidate generalized intake", () => {
  function objectAnchor(id: string) {
    return { kind: "object" as const, object_id: id };
  }

  function baseInput(overrides: Partial<SubmitCandidateInput>): SubmitCandidateInput {
    return {
      workspaceId: "workspace-1",
      sourceAnchor: objectAnchor("mem-A"),
      targetAnchor: objectAnchor("mem-B"),
      relationKind: "supports",
      initialStrength: 0.5,
      governanceClass: "attention_only",
      evidenceBasis: ["llm_supports_inference"],
      recallBiasSign: 1,
      ...overrides
    };
  }

  it("mints once on submission with the LLM supports profile (0.5 / attention_only / +bias)", async () => {
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

    const result = await service.submitCandidate(
      baseInput({
        relationKind: SUPPORTS_SEED_PROFILE.relationKind,
        initialStrength: SUPPORTS_SEED_PROFILE.initialStrength,
        governanceClass: SUPPORTS_SEED_PROFILE.governanceClass,
        evidenceBasis: SUPPORTS_SEED_PROFILE.evidenceBasis,
        recallBiasSign: SUPPORTS_SEED_PROFILE.recallBiasSign,
        recallBiasMagnitude: SUPPORTS_SEED_PROFILE.recallBiasMagnitude
      })
    );

    expect(result).toBe("applied");
    expect(repo.create).toHaveBeenCalledTimes(1);
    expect(appendManyWithMutation).toHaveBeenCalledTimes(1);
    const written = repo.create.mock.calls[0][0];
    expect(written.constitution.relation_kind).toBe("supports");
    expect(written.plasticity_state.strength).toBe(0.5);
    expect(written.legitimacy.governance_class).toBe("attention_only");
    expect(written.effect_vector.recall_bias).toBeGreaterThan(0);
    expect(() => PathRelationSchema.parse(written)).not.toThrow();
  });

  it("seeds shares_entity at hint_only / 0.2 and signal_graph_ref at recall_allowed / 0.6", async () => {
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

    await service.submitCandidate(
      baseInput({
        relationKind: SHARES_ENTITY_SEED_PROFILE.relationKind,
        initialStrength: SHARES_ENTITY_SEED_PROFILE.initialStrength,
        governanceClass: SHARES_ENTITY_SEED_PROFILE.governanceClass,
        evidenceBasis: SHARES_ENTITY_SEED_PROFILE.evidenceBasis,
        recallBiasSign: SHARES_ENTITY_SEED_PROFILE.recallBiasSign
      })
    );
    await service.submitCandidate(
      baseInput({
        sourceAnchor: objectAnchor("mem-C"),
        targetAnchor: objectAnchor("mem-D"),
        relationKind: SIGNAL_GRAPH_REF_SEED_PROFILE.relationKind,
        initialStrength: SIGNAL_GRAPH_REF_SEED_PROFILE.initialStrength,
        governanceClass: SIGNAL_GRAPH_REF_SEED_PROFILE.governanceClass,
        evidenceBasis: SIGNAL_GRAPH_REF_SEED_PROFILE.evidenceBasis,
        recallBiasSign: SIGNAL_GRAPH_REF_SEED_PROFILE.recallBiasSign
      })
    );

    const sharesEntity = repo.create.mock.calls[0][0];
    expect(sharesEntity.constitution.relation_kind).toBe("shares_entity");
    expect(sharesEntity.plasticity_state.strength).toBe(0.2);
    expect(sharesEntity.legitimacy.governance_class).toBe("hint_only");

    const signalRef = repo.create.mock.calls[1][0];
    expect(signalRef.constitution.relation_kind).toBe("signal_graph_ref");
    expect(signalRef.plasticity_state.strength).toBe(0.6);
    expect(signalRef.legitimacy.governance_class).toBe("recall_allowed");
  });

  it("negative family seeds a negative recall_bias with the harder initial parameters", async () => {
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

    await service.submitCandidate(
      baseInput({
        relationKind: SUPERSEDES_SEED_PROFILE.relationKind,
        initialStrength: SUPERSEDES_SEED_PROFILE.initialStrength,
        governanceClass: SUPERSEDES_SEED_PROFILE.governanceClass,
        evidenceBasis: SUPERSEDES_SEED_PROFILE.evidenceBasis,
        recallBiasSign: SUPERSEDES_SEED_PROFILE.recallBiasSign,
        recallBiasMagnitude: SUPERSEDES_SEED_PROFILE.recallBiasMagnitude
      })
    );
    await service.submitCandidate(
      baseInput({
        sourceAnchor: objectAnchor("mem-C"),
        targetAnchor: objectAnchor("mem-D"),
        relationKind: CONTRADICTS_SEED_PROFILE.relationKind,
        initialStrength: CONTRADICTS_SEED_PROFILE.initialStrength,
        governanceClass: CONTRADICTS_SEED_PROFILE.governanceClass,
        evidenceBasis: CONTRADICTS_SEED_PROFILE.evidenceBasis,
        recallBiasSign: CONTRADICTS_SEED_PROFILE.recallBiasSign,
        recallBiasMagnitude: CONTRADICTS_SEED_PROFILE.recallBiasMagnitude
      })
    );

    const supersedes = repo.create.mock.calls[0][0];
    expect(supersedes.constitution.relation_kind).toBe("supersedes");
    expect(supersedes.effect_vector.recall_bias).toBeLessThan(0);
    expect(supersedes.plasticity_state.strength).toBe(0.9);
    expect(supersedes.legitimacy.governance_class).toBe("recall_allowed");
    expect(supersedes.legitimacy.evidence_basis.length).toBeGreaterThanOrEqual(1);

    const contradicts = repo.create.mock.calls[1][0];
    expect(contradicts.effect_vector.recall_bias).toBeLessThan(0);
    expect(contradicts.plasticity_state.strength).toBe(0.9);
  });

  it("neutral exception_to profile (sign 0) mints recall_bias exactly 0", async () => {
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

    const result = await service.submitCandidate(
      baseInput({
        relationKind: EXCEPTION_TO_SEED_PROFILE.relationKind,
        initialStrength: EXCEPTION_TO_SEED_PROFILE.initialStrength,
        governanceClass: EXCEPTION_TO_SEED_PROFILE.governanceClass,
        evidenceBasis: EXCEPTION_TO_SEED_PROFILE.evidenceBasis,
        recallBiasSign: EXCEPTION_TO_SEED_PROFILE.recallBiasSign,
        recallBiasMagnitude: EXCEPTION_TO_SEED_PROFILE.recallBiasMagnitude
      })
    );

    expect(result).toBe("applied");
    const written = repo.create.mock.calls[0][0];
    expect(written.constitution.relation_kind).toBe("exception_to");
    expect(written.effect_vector.recall_bias).toBe(0);
    expect(written.plasticity_state.strength).toBe(0.9);
    expect(written.legitimacy.governance_class).toBe("recall_allowed");
    expect(written.legitimacy.evidence_basis.length).toBeGreaterThanOrEqual(1);
    expect(() => PathRelationSchema.parse(written)).not.toThrow();
  });

  it("sign 0 with a non-zero magnitude still mints recall_bias 0", async () => {
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

    await service.submitCandidate(
      baseInput({
        relationKind: "exception_to",
        governanceClass: "recall_allowed",
        evidenceBasis: ["exception_evidence"],
        recallBiasSign: 0,
        recallBiasMagnitude: 0.5
      })
    );

    const written = repo.create.mock.calls[0][0];
    expect(written.effect_vector.recall_bias).toBe(0);
  });

  it("clamps a strictly_governed request down to the auto-build ceiling (recall_allowed)", async () => {
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

    await service.submitCandidate(
      baseInput({ governanceClass: "strictly_governed" })
    );

    const written = repo.create.mock.calls[0][0];
    expect(written.legitimacy.governance_class).toBe("recall_allowed");
    expect(written.legitimacy.governance_class).not.toBe("strictly_governed");
  });

  it("submitCandidate dedups against an existing path for the same pair", async () => {
    const existing = {
      anchors: {
        source_anchor: { kind: "object" as const, object_id: "mem-A" },
        target_anchor: { kind: "object" as const, object_id: "mem-B" }
      },
      constitution: { relation_kind: "supports" },
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
      eventPublisher: publisher
    });

    const result = await service.submitCandidate(baseInput({}));

    expect(result).toBe("already_present");
    expect(repo.create).not.toHaveBeenCalled();
  });

  it("submitCandidate does not dedup contradicts against an existing co_recalled path", async () => {
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
      eventPublisher: publisher
    });

    const result = await service.submitCandidate(
      baseInput({
        relationKind: CONTRADICTS_SEED_PROFILE.relationKind,
        initialStrength: CONTRADICTS_SEED_PROFILE.initialStrength,
        governanceClass: CONTRADICTS_SEED_PROFILE.governanceClass,
        evidenceBasis: CONTRADICTS_SEED_PROFILE.evidenceBasis,
        recallBiasSign: CONTRADICTS_SEED_PROFILE.recallBiasSign,
        recallBiasMagnitude: CONTRADICTS_SEED_PROFILE.recallBiasMagnitude
      })
    );

    expect(result).toBe("applied");
    expect(repo.create).toHaveBeenCalledTimes(1);
    expect(repo.create.mock.calls[0][0].constitution.relation_kind).toBe("contradicts");
  });

  it("submitCandidate does not dedup supports against an existing contradicts path", async () => {
    const existing = {
      anchors: {
        source_anchor: { kind: "object" as const, object_id: "mem-A" },
        target_anchor: { kind: "object" as const, object_id: "mem-B" }
      },
      constitution: { relation_kind: "contradicts" },
      effect_vector: { recall_bias: -0.5 }
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
      eventPublisher: publisher
    });

    const result = await service.submitCandidate(baseInput({}));

    expect(result).toBe("applied");
    expect(repo.create).toHaveBeenCalledTimes(1);
    expect(repo.create.mock.calls[0][0].constitution.relation_kind).toBe("supports");
  });

  it("rejects a foreign object_facet backing object before materializing", async () => {
    const repo = {
      create: vi.fn((relation: any) => relation),
      findByAnchorMemoryId: vi.fn(async () => [])
    };
    const memoryExistence: MemoryAnchorExistencePort = {
      workspaceOfObject: vi.fn(async (objectId: string) =>
        objectId === "mem-foreign" ? "workspace-2" : "workspace-1"
      )
    };
    const { publisher, appendManyWithMutation } = createEventPublisher();
    const service = new PathRelationProposalService({
      repo,
      counterStore: createCounterStore(),
      eventPublisher: publisher,
      memoryExistence
    });

    const result = await service.submitCandidate(
      baseInput({
        sourceAnchor: {
          kind: "object_facet",
          object_id: "mem-foreign",
          facet_key: "status"
        }
      })
    );

    expect(result).toBe("rejected");
    expect(repo.create).not.toHaveBeenCalled();
    expect(memoryExistence.workspaceOfObject).toHaveBeenCalledWith("mem-foreign");
    const [eventInputs] = appendManyWithMutation.mock.calls[0]!;
    expect(eventInputs[0].event_type).toBe("path.relation_rejected");
    expect(eventInputs[0].payload_json.rejection_reason).toBe("object_foreign_workspace");
  });

  it("rejects a missing time_concern backing object before materializing", async () => {
    const repo = {
      create: vi.fn((relation: any) => relation),
      findByAnchorMemoryId: vi.fn(async () => [])
    };
    const memoryExistence: MemoryAnchorExistencePort = {
      workspaceOfObject: vi.fn(async (objectId: string) =>
        objectId === "mem-missing" ? null : "workspace-1"
      )
    };
    const { publisher, appendManyWithMutation } = createEventPublisher();
    const service = new PathRelationProposalService({
      repo,
      counterStore: createCounterStore(),
      eventPublisher: publisher,
      memoryExistence
    });

    const result = await service.submitCandidate(
      baseInput({
        targetAnchor: {
          kind: "time_concern",
          source_object_id: "mem-missing",
          window_digest: "next_week"
        }
      })
    );

    expect(result).toBe("rejected");
    expect(repo.create).not.toHaveBeenCalled();
    expect(memoryExistence.workspaceOfObject).toHaveBeenCalledWith("mem-missing");
    const [eventInputs] = appendManyWithMutation.mock.calls[0]!;
    expect(eventInputs[0].event_type).toBe("path.relation_rejected");
    expect(eventInputs[0].payload_json.rejection_reason).toBe("object_missing");
  });

  it("submitCandidate swallows a materialize failure and returns failed with a warn", async () => {
    const repo = {
      create: vi.fn(() => {
        throw new Error("simulated row-insert failure");
      }),
      findByAnchorMemoryId: vi.fn(async () => [])
    };
    const { publisher } = createEventPublisher();
    const warn = vi.fn();
    const service = new PathRelationProposalService({
      repo,
      counterStore: createCounterStore(),
      eventPublisher: publisher,
      warn
    });

    const result = await service.submitCandidate(baseInput({}));

    expect(result).toBe("failed");
    expect(warn).toHaveBeenCalledWith(
      "PathRelation submitCandidate failed",
      expect.objectContaining({ workspace_id: "workspace-1", relation_kind: "supports" })
    );
  });
});
