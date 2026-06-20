import { describe, expect, it, vi } from "vitest";
import { PathRelationSchema, type PathRelation } from "@do-soul/alaya-protocol";
import { PathRelationProposalService, SUPPORTS_SEED_PROFILE, SHARES_ENTITY_SEED_PROFILE, SIGNAL_GRAPH_REF_SEED_PROFILE, SUPERSEDES_SEED_PROFILE, CONTRADICTS_SEED_PROFILE, EXCEPTION_TO_SEED_PROFILE, type MemoryAnchorExistencePort, type PathRelationProposalRepoPort, type SubmitCandidateInput } from "../../path-graph/path-relation-proposal-service.js";

import { createCounterStore, createEventPublisher } from "./path-relation-proposal-service.test-support.js";

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
