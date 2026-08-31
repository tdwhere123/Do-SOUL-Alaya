import { describe, expect, it, vi } from "vitest";
import { PathRelationSchema, type EventLogEntry, type PathRelation } from "@do-soul/alaya-protocol";
import {
  PathRelationProposalService,
  CO_RECALLED_SEED_PROFILE,
  type PathRelationProposalRepoPort,
  type SubmitCandidateInput
} from "../../path-graph/edge-proposals/path-relation-proposal-service.js";

import { createCounterStore, createEventPublisher } from "./path-relation-proposal-service.test-support.js";
import { firstDefined, mockCallAt, requireAt } from "../helpers/defined.js";

type RelationEventInput = Omit<EventLogEntry, "event_id" | "created_at" | "revision">;

function firstMockEventInputs(mock: { mock: { calls: readonly unknown[][] } }): readonly RelationEventInput[] {
  return requireAt(mockCallAt(mock, 0), 0) as readonly RelationEventInput[];
}

function coRecalledCandidate(
  overrides: Partial<SubmitCandidateInput> = {}
): SubmitCandidateInput {
  return {
    workspaceId: "workspace-1",
    sourceAnchor: { kind: "object", object_id: "mem-A" },
    targetAnchor: { kind: "object", object_id: "mem-B" },
    relationKind: CO_RECALLED_SEED_PROFILE.relationKind,
    initialStrength: CO_RECALLED_SEED_PROFILE.initialStrength,
    governanceClass: CO_RECALLED_SEED_PROFILE.governanceClass,
    evidenceBasis: CO_RECALLED_SEED_PROFILE.evidenceBasis,
    recallBiasSign: CO_RECALLED_SEED_PROFILE.recallBiasSign,
    recallBiasMagnitude: CO_RECALLED_SEED_PROFILE.recallBiasMagnitude,
    ...overrides
  };
}

describe("PathRelationProposalService", () => {
  it("mints a PathRelation from submitCandidate", async () => {
    const repo = {
      create: vi.fn((relation: PathRelation) => relation),
      findByAnchorMemoryId: vi.fn(async () => [])
    };
    const { publisher, appendManyWithMutation } = createEventPublisher();
    const service = new PathRelationProposalService({
      repo,
      counterStore: createCounterStore(),
      eventPublisher: publisher
    });

    expect(await service.submitCandidate(coRecalledCandidate())).toBe("applied");
    expect(repo.create).toHaveBeenCalledTimes(1);
    expect(appendManyWithMutation).toHaveBeenCalledTimes(1);
    const written = firstDefined(mockCallAt(repo.create, 0));
    expect(written.workspace_id).toBe("workspace-1");
    const anchorIds = [
      written.anchors.source_anchor.object_id,
      written.anchors.target_anchor.object_id
    ].sort();
    expect(anchorIds).toEqual(["mem-A", "mem-B"]);
    expect(() => PathRelationSchema.parse(written)).not.toThrow();

    const eventInputs = firstMockEventInputs(appendManyWithMutation);
    expect(eventInputs).toHaveLength(1);
    expect(firstDefined(eventInputs).event_type).toBe("path.relation_created");
    expect(firstDefined(eventInputs).entity_type).toBe("path_relation");
    expect(firstDefined(eventInputs).entity_id).toBe(written.path_id);
    expect(firstDefined(eventInputs).workspace_id).toBe("workspace-1");
  });

  it("mints a co_recalled path at attention_only — not a recall-eligible class", async () => {
    const repo = {
      create: vi.fn((relation: PathRelation) => relation),
      findByAnchorMemoryId: vi.fn(async () => [])
    };
    const { publisher, appendManyWithMutation } = createEventPublisher();
    const service = new PathRelationProposalService({
      repo,
      counterStore: createCounterStore(),
      eventPublisher: publisher
    });

    await service.submitCandidate(coRecalledCandidate());

    const written = firstDefined(mockCallAt(repo.create, 0));
    expect(written.legitimacy.governance_class).toBe("attention_only");
    expect(written.legitimacy.governance_class).not.toBe("recall_allowed");
    expect(written.legitimacy.governance_class).not.toBe("strictly_governed");

    const eventInputs = firstMockEventInputs(appendManyWithMutation);
    expect(firstDefined(eventInputs).payload_json.governance_class).toBe("attention_only");
  });

  it("does not double-propose the same pair", async () => {
    const created: PathRelation[] = [];
    const repo = {
      create: vi.fn((relation: PathRelation) => {
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

    expect(await service.submitCandidate(coRecalledCandidate())).toBe("applied");
    expect(await service.submitCandidate(coRecalledCandidate())).toBe("already_present");
    expect(repo.create).toHaveBeenCalledTimes(1);
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
      create: vi.fn((relation: PathRelation) => relation),
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

    expect(await service.submitCandidate(coRecalledCandidate())).toBe("already_present");
    expect(repo.create).not.toHaveBeenCalled();
  });

  it("evictExpired shrinks the counter for stale sub-threshold pairs", async () => {
    const repo = {
      create: vi.fn((relation: PathRelation) => relation),
      findByAnchorMemoryId: vi.fn(async () => [])
    };
    const { publisher } = createEventPublisher();
    const counterStore = createCounterStore();
    let nowMs = 1_000_000;
    const service = new PathRelationProposalService({
      repo,
      counterStore,
      eventPublisher: publisher,
      now: () => new Date(nowMs).toISOString(),
      nowMs: () => nowMs,
      counterTtlMs: 1_000
    });

    await counterStore.increment({
      workspaceId: "workspace-1",
      lowMemoryId: "mem-A",
      highMemoryId: "mem-B",
      seenAt: new Date(nowMs).toISOString()
    });
    nowMs = 1_001_500;
    await counterStore.increment({
      workspaceId: "workspace-1",
      lowMemoryId: "mem-C",
      highMemoryId: "mem-D",
      seenAt: new Date(nowMs).toISOString()
    });
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
    const repo = {
      create: vi.fn((relation: PathRelation) => relation),
      findByAnchorMemoryId: vi.fn(async () => [])
    };
    const { publisher } = createEventPublisher();
    const counterStore = createCounterStore();
    let nowMs = 1_000_000;
    const service = new PathRelationProposalService({
      repo,
      counterStore,
      eventPublisher: publisher,
      now: () => new Date(nowMs).toISOString(),
      nowMs: () => nowMs,
      counterTtlMs: 5_000
    });

    await counterStore.increment({
      workspaceId: "workspace-1",
      lowMemoryId: "mem-A",
      highMemoryId: "mem-B",
      seenAt: new Date(nowMs).toISOString()
    });
    expect(await service.counterSize()).toBe(1);

    nowMs = 1_004_000;
    await counterStore.increment({
      workspaceId: "workspace-1",
      lowMemoryId: "mem-A",
      highMemoryId: "mem-B",
      seenAt: new Date(nowMs).toISOString()
    });
    expect(await service.counterSize()).toBe(1);

    nowMs = 1_005_500;
    const removed = await service.evictExpired();
    expect(removed).toBe(0);
    expect(await service.counterSize()).toBe(1);

    nowMs = 1_010_000;
    expect(await service.evictExpired()).toBe(1);
    expect(await service.counterSize()).toBe(0);
  });

  it("evictExpired keeps fresh sub-threshold pairs when ttl has not elapsed", async () => {
    const repo = {
      create: vi.fn((relation: PathRelation) => relation),
      findByAnchorMemoryId: vi.fn(async () => [])
    };
    const { publisher } = createEventPublisher();
    const counterStore = createCounterStore();
    let nowMs = 2_000_000;
    const service = new PathRelationProposalService({
      repo,
      counterStore,
      eventPublisher: publisher,
      now: () => new Date(nowMs).toISOString(),
      nowMs: () => nowMs,
      counterTtlMs: 10_000
    });

    await counterStore.increment({
      workspaceId: "workspace-1",
      lowMemoryId: "mem-A",
      highMemoryId: "mem-B",
      seenAt: new Date(nowMs).toISOString()
    });
    await counterStore.increment({
      workspaceId: "workspace-1",
      lowMemoryId: "mem-C",
      highMemoryId: "mem-D",
      seenAt: new Date(nowMs).toISOString()
    });
    expect(await service.counterSize()).toBe(2);

    nowMs = 2_005_000;
    expect(await service.evictExpired()).toBe(0);
    expect(await service.counterSize()).toBe(2);
  });

  it("seeds the co-usage path at the co_recalled profile (0.3 / attention_only / +recall_bias)", async () => {
    const repo = {
      create: vi.fn((relation: PathRelation) => relation),
      findByAnchorMemoryId: vi.fn(async () => [])
    };
    const { publisher } = createEventPublisher();
    const service = new PathRelationProposalService({
      repo,
      counterStore: createCounterStore(),
      eventPublisher: publisher
    });

    await service.submitCandidate(coRecalledCandidate());

    const written = firstDefined(mockCallAt(repo.create, 0));
    expect(written.constitution.relation_kind).toBe("co_recalled");
    expect(written.plasticity_state.strength).toBe(CO_RECALLED_SEED_PROFILE.initialStrength);
    expect(written.legitimacy.governance_class).toBe("attention_only");
    expect(written.effect_vector.recall_bias).toBeGreaterThan(0);
  });
});
