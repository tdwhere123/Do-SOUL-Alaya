import { describe, expect, it, vi } from "vitest";
import {
  PromotionState,
  SynthesisStatus,
  TransitionCausedBy,
  type EventLogEntry,
  type SynthesisCapsule
} from "@do-soul/alaya-protocol";
import {
  SynthesisService,
  type SynthesisCapsuleInput,
  type SynthesisServiceDependencies
} from "../synthesis-service.js";

function createSynthesisInput(overrides: Partial<SynthesisCapsuleInput> = {}): SynthesisCapsuleInput {
  return {
    created_by: "user_action",
    topic_key: "tooling/pnpm",
    synthesis_type: "phase_synthesis",
    summary: "Use pnpm for workspace commands.",
    evidence_refs: ["evidence-1"],
    source_memory_refs: ["memory-1"],
    workspace_id: "workspace-1",
    run_id: "run-1",
    ...overrides
  };
}

function createSynthesisCapsule(overrides: Partial<SynthesisCapsule> = {}): SynthesisCapsule {
  return {
    object_id: "f8b2124d-4954-4ea0-a77e-ad4b137ed8ee",
    object_kind: "synthesis_capsule",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: "2026-03-21T00:00:00.000Z",
    updated_at: "2026-03-21T00:00:00.000Z",
    created_by: "user_action",
    topic_key: "tooling/pnpm",
    synthesis_type: "phase_synthesis",
    authority_round_count: 0,
    cooldown_until: null,
    promotion_state: PromotionState.NONE,
    summary: "Use pnpm for workspace commands.",
    evidence_refs: ["evidence-1"],
    source_memory_refs: ["memory-1"],
    workspace_id: "workspace-1",
    run_id: "run-1",
    synthesis_status: SynthesisStatus.WORKING,
    ...overrides
  };
}

function createEventLogHistory(maxRevision: number): readonly EventLogEntry[] {
  return [
    {
      event_id: "event-history",
      event_type: "soul.synthesis.created",
      entity_type: "synthesis_capsule",
      entity_id: "f8b2124d-4954-4ea0-a77e-ad4b137ed8ee",
      workspace_id: "workspace-1",
      run_id: "run-1",
      caused_by: "user_action",
      revision: maxRevision,
      payload_json: {
        object_id: "f8b2124d-4954-4ea0-a77e-ad4b137ed8ee",
        object_kind: "synthesis_capsule",
        workspace_id: "workspace-1",
        run_id: "run-1"
      },
      created_at: "2026-03-21T00:00:00.000Z"
    }
  ];
}

function createDependencies(overrides: Partial<SynthesisServiceDependencies> = {}): {
  readonly dependencies: SynthesisServiceDependencies;
  readonly appendSpy: ReturnType<typeof vi.fn>;
  readonly queryByEntitySpy: ReturnType<typeof vi.fn>;
  readonly evidenceFindByIdSpy: ReturnType<typeof vi.fn>;
  readonly memoryFindByIdSpy: ReturnType<typeof vi.fn>;
  readonly notifySpy: ReturnType<typeof vi.fn>;
} {
  const appendSpy = vi.fn(async (event: Omit<EventLogEntry, "event_id" | "created_at">) => ({
    event_id: `event-${event.event_type}`,
    created_at: "2026-03-21T00:00:00.000Z",
    ...event
  }));
  const queryByEntitySpy = vi.fn(async () => [] as readonly EventLogEntry[]);
  const evidenceFindByIdSpy = vi.fn(async () => ({ object_id: "evidence" }));
  const memoryFindByIdSpy = vi.fn(async () => ({ object_id: "memory" }));
  const notifySpy = vi.fn(async () => {});

  const dependencies: SynthesisServiceDependencies = {
    now: () => "2026-03-21T01:00:00.000Z",
    generateObjectId: () => "85b3671a-d8d8-4848-9e5c-07d0a89f5ae9",
    synthesisCapsuleRepo: {
      create: vi.fn(async (capsule) => Object.freeze({ ...capsule })),
      findById: vi.fn(async () => createSynthesisCapsule()),
      findByWorkspaceId: vi.fn(async () => []),
      findByTopicKey: vi.fn(async () => []),
      updateStatus: vi.fn(async (_objectId, status, updatedAt) =>
        Object.freeze(createSynthesisCapsule({ synthesis_status: status, updated_at: updatedAt }))
      ),
      updatePromotionState: vi.fn(async (_objectId, state, updatedAt) =>
        Object.freeze(createSynthesisCapsule({ promotion_state: state, updated_at: updatedAt }))
      ),
      incrementAuthorityRound: vi.fn(async (_objectId, updatedAt) =>
        Object.freeze(createSynthesisCapsule({ authority_round_count: 1, updated_at: updatedAt }))
      ),
      setCooldownUntil: vi.fn(async (_objectId, cooldownUntil, updatedAt) =>
        Object.freeze(createSynthesisCapsule({ cooldown_until: cooldownUntil, updated_at: updatedAt }))
      )
    },
    evidenceService: {
      findById: evidenceFindByIdSpy
    },
    memoryService: {
      findById: memoryFindByIdSpy
    },
    eventLogRepo: {
      append: appendSpy,
      queryByEntity: queryByEntitySpy
    },
    runtimeNotifier: {
      notifyEntry: notifySpy
    },
    ...overrides
  };

  return {
    dependencies,
    appendSpy,
    queryByEntitySpy,
    evidenceFindByIdSpy,
    memoryFindByIdSpy,
    notifySpy
  };
}

describe("SynthesisService", () => {
  it("writes soul.synthesis.created before persistence and runtime notification", async () => {
    const order: string[] = [];

    const { dependencies } = createDependencies({
      eventLogRepo: {
        append: vi.fn(async (event) => {
          order.push("event_log");
          return {
            event_id: "event-created",
            created_at: "2026-03-21T01:00:00.000Z",
            ...event
          };
        }),
        queryByEntity: vi.fn(async () => {
          order.push("event_query");
          return [];
        })
      },
      synthesisCapsuleRepo: {
        create: vi.fn(async (capsule) => {
          order.push("repo_create");
          return Object.freeze({ ...capsule });
        }),
        findById: vi.fn(async () => null),
        findByWorkspaceId: vi.fn(async () => []),
        findByTopicKey: vi.fn(async () => []),
        updateStatus: vi.fn(async () => {
          throw new Error("not used");
        }),
        updatePromotionState: vi.fn(async () => {
          throw new Error("not used");
        }),
        incrementAuthorityRound: vi.fn(async () => {
          throw new Error("not used");
        }),
        setCooldownUntil: vi.fn(async () => {
          throw new Error("not used");
        })
      },
      runtimeNotifier: {
        notifyEntry: vi.fn(async () => {
          order.push("notify");
        })
      }
    });

    const service = new SynthesisService(dependencies);
    const created = await service.create(createSynthesisInput());

    expect(order).toEqual(["event_query", "event_log", "repo_create", "notify"]);
    expect(created.object_id).toBe("85b3671a-d8d8-4848-9e5c-07d0a89f5ae9");
  });

  it("rejects create when evidence reference is missing before EventLog writes", async () => {
    const { dependencies, appendSpy, queryByEntitySpy } = createDependencies({
      evidenceService: {
        findById: vi.fn(async () => null)
      }
    });

    const service = new SynthesisService(dependencies);

    await expect(service.create(createSynthesisInput())).rejects.toMatchObject({
      name: "CoreError",
      code: "VALIDATION",
      message: "Evidence reference not found: evidence-1"
    });

    expect(queryByEntitySpy).not.toHaveBeenCalled();
    expect(appendSpy).not.toHaveBeenCalled();
  });

  it("rejects create when source memory reference is missing before EventLog writes", async () => {
    const { dependencies, appendSpy, queryByEntitySpy } = createDependencies({
      memoryService: {
        findById: vi.fn(async () => null)
      }
    });

    const service = new SynthesisService(dependencies);

    await expect(service.create(createSynthesisInput())).rejects.toMatchObject({
      name: "CoreError",
      code: "VALIDATION",
      message: "Source memory reference not found: memory-1"
    });

    expect(queryByEntitySpy).not.toHaveBeenCalled();
    expect(appendSpy).not.toHaveBeenCalled();
  });

  it("transitions status in one direction only", async () => {
    const order: string[] = [];
    const existing = createSynthesisCapsule({ synthesis_status: SynthesisStatus.WORKING });

    const { dependencies } = createDependencies({
      eventLogRepo: {
        queryByEntity: vi.fn(async () => {
          order.push("event_query");
          return createEventLogHistory(3);
        }),
        append: vi.fn(async (event) => {
          order.push("event_log");
          return {
            event_id: "event-status",
            created_at: "2026-03-21T02:00:00.000Z",
            ...event
          };
        })
      },
      synthesisCapsuleRepo: {
        create: vi.fn(async (capsule) => capsule),
        findById: vi.fn(async () => existing),
        findByWorkspaceId: vi.fn(async () => []),
        findByTopicKey: vi.fn(async () => []),
        updateStatus: vi.fn(async (_objectId, status, updatedAt) => {
          order.push("repo_update");
          return Object.freeze({ ...existing, synthesis_status: status, updated_at: updatedAt });
        }),
        updatePromotionState: vi.fn(async () => {
          throw new Error("not used");
        }),
        incrementAuthorityRound: vi.fn(async () => {
          throw new Error("not used");
        }),
        setCooldownUntil: vi.fn(async () => {
          throw new Error("not used");
        })
      },
      runtimeNotifier: {
        notifyEntry: vi.fn(async () => {
          order.push("notify");
        })
      }
    });

    const service = new SynthesisService(dependencies);
    const updated = await service.transitionStatus(
      existing.object_id,
      SynthesisStatus.STABLE,
      "stabilized",
      TransitionCausedBy.REVIEW
    );

    expect(order).toEqual(["event_query", "event_log", "repo_update", "notify"]);
    expect(updated.synthesis_status).toBe(SynthesisStatus.STABLE);
  });

  it("rejects reverse status transition", async () => {
    const existing = createSynthesisCapsule({ synthesis_status: SynthesisStatus.STABLE });

    const { dependencies } = createDependencies({
      synthesisCapsuleRepo: {
        create: vi.fn(async (capsule) => capsule),
        findById: vi.fn(async () => existing),
        findByWorkspaceId: vi.fn(async () => []),
        findByTopicKey: vi.fn(async () => []),
        updateStatus: vi.fn(async () => existing),
        updatePromotionState: vi.fn(async () => existing),
        incrementAuthorityRound: vi.fn(async () => existing),
        setCooldownUntil: vi.fn(async () => existing)
      }
    });

    const service = new SynthesisService(dependencies);

    await expect(
      service.transitionStatus(existing.object_id, SynthesisStatus.WORKING, "rollback", TransitionCausedBy.REVIEW)
    ).rejects.toMatchObject({
      name: "CoreError",
      code: "VALIDATION"
    });
  });

  it("requests promotion to candidate", async () => {
    const existing = createSynthesisCapsule({ promotion_state: PromotionState.NONE, cooldown_until: null });

    const { dependencies } = createDependencies({
      eventLogRepo: {
        queryByEntity: vi.fn(async () => createEventLogHistory(1)),
        append: vi.fn(async (event) => ({
          event_id: "event-promoted",
          created_at: "2026-03-21T03:00:00.000Z",
          ...event
        }))
      },
      synthesisCapsuleRepo: {
        create: vi.fn(async (capsule) => capsule),
        findById: vi.fn(async () => existing),
        findByWorkspaceId: vi.fn(async () => []),
        findByTopicKey: vi.fn(async () => []),
        updateStatus: vi.fn(async () => {
          throw new Error("not used");
        }),
        updatePromotionState: vi.fn(async (_objectId, state, updatedAt) =>
          Object.freeze({ ...existing, promotion_state: state, updated_at: updatedAt })
        ),
        incrementAuthorityRound: vi.fn(async () => {
          throw new Error("not used");
        }),
        setCooldownUntil: vi.fn(async () => {
          throw new Error("not used");
        })
      }
    });

    const service = new SynthesisService(dependencies);
    const updated = await service.requestPromotion(existing.object_id);

    expect(updated.promotion_state).toBe(PromotionState.CANDIDATE);
  });

  it("rejects promotion while in cooldown", async () => {
    const existing = createSynthesisCapsule({ cooldown_until: "2026-03-22T00:00:00.000Z" });

    const { dependencies } = createDependencies({
      now: () => "2026-03-21T01:00:00.000Z",
      synthesisCapsuleRepo: {
        create: vi.fn(async (capsule) => capsule),
        findById: vi.fn(async () => existing),
        findByWorkspaceId: vi.fn(async () => []),
        findByTopicKey: vi.fn(async () => []),
        updateStatus: vi.fn(async () => existing),
        updatePromotionState: vi.fn(async () => existing),
        incrementAuthorityRound: vi.fn(async () => existing),
        setCooldownUntil: vi.fn(async () => existing)
      }
    });

    const service = new SynthesisService(dependencies);

    await expect(service.requestPromotion(existing.object_id)).rejects.toMatchObject({
      name: "CoreError",
      code: "VALIDATION"
    });
  });

  it("rejects promotion when state is already active", async () => {
    const existing = createSynthesisCapsule({ promotion_state: PromotionState.PROPOSED, cooldown_until: null });

    const { dependencies } = createDependencies({
      synthesisCapsuleRepo: {
        create: vi.fn(async (capsule) => capsule),
        findById: vi.fn(async () => existing),
        findByWorkspaceId: vi.fn(async () => []),
        findByTopicKey: vi.fn(async () => []),
        updateStatus: vi.fn(async () => existing),
        updatePromotionState: vi.fn(async () => existing),
        incrementAuthorityRound: vi.fn(async () => existing),
        setCooldownUntil: vi.fn(async () => existing)
      }
    });

    const service = new SynthesisService(dependencies);

    await expect(service.requestPromotion(existing.object_id)).rejects.toMatchObject({
      name: "CoreError",
      code: "VALIDATION"
    });
  });


  it("resolves candidate promotion to promoted", async () => {
    const existing = createSynthesisCapsule({
      promotion_state: PromotionState.CANDIDATE,
      cooldown_until: "2026-03-22T00:00:00.000Z"
    });

    const { dependencies } = createDependencies({
      eventLogRepo: {
        queryByEntity: vi.fn(async () => createEventLogHistory(2)),
        append: vi.fn(async (event) => ({
          event_id: "event-promoted",
          created_at: "2026-03-21T03:00:00.000Z",
          ...event
        }))
      },
      synthesisCapsuleRepo: {
        create: vi.fn(async (capsule) => capsule),
        findById: vi.fn(async () => existing),
        findByWorkspaceId: vi.fn(async () => []),
        findByTopicKey: vi.fn(async () => []),
        updateStatus: vi.fn(async () => existing),
        updatePromotionState: vi.fn(async (_objectId, state, updatedAt) =>
          Object.freeze({ ...existing, promotion_state: state, updated_at: updatedAt })
        ),
        incrementAuthorityRound: vi.fn(async () => existing),
        setCooldownUntil: vi.fn(async (_objectId, cooldownUntil, updatedAt) =>
          Object.freeze({
            ...existing,
            promotion_state: PromotionState.PROMOTED,
            cooldown_until: cooldownUntil,
            updated_at: updatedAt
          })
        )
      }
    });

    const service = new SynthesisService(dependencies);
    const updated = await service.resolvePromotionDecision(
      existing.object_id,
      PromotionState.PROMOTED,
      "proposal_accepted",
      TransitionCausedBy.REVIEW
    );

    expect(updated.promotion_state).toBe(PromotionState.PROMOTED);
    expect(updated.cooldown_until).toBeNull();
  });

  it("resolves candidate promotion to rejected with cooldown", async () => {
    const existing = createSynthesisCapsule({
      promotion_state: PromotionState.CANDIDATE,
      cooldown_until: null
    });

    const { dependencies } = createDependencies({
      synthesisCapsuleRepo: {
        create: vi.fn(async (capsule) => capsule),
        findById: vi.fn(async () => existing),
        findByWorkspaceId: vi.fn(async () => []),
        findByTopicKey: vi.fn(async () => []),
        updateStatus: vi.fn(async () => existing),
        updatePromotionState: vi.fn(async (_objectId, state, updatedAt) =>
          Object.freeze({ ...existing, promotion_state: state, updated_at: updatedAt })
        ),
        incrementAuthorityRound: vi.fn(async () => existing),
        setCooldownUntil: vi.fn(async (_objectId, cooldownUntil, updatedAt) =>
          Object.freeze({
            ...existing,
            promotion_state: PromotionState.REJECTED,
            cooldown_until: cooldownUntil,
            updated_at: updatedAt
          })
        )
      }
    });

    const service = new SynthesisService(dependencies);
    const updated = await service.resolvePromotionDecision(
      existing.object_id,
      PromotionState.REJECTED,
      "proposal_rejected",
      TransitionCausedBy.REVIEW,
      { cooldownUntil: "2026-03-22T04:00:00.000Z" }
    );

    expect(updated.promotion_state).toBe(PromotionState.REJECTED);
    expect(updated.cooldown_until).toBe("2026-03-22T04:00:00.000Z");
  });

  it("rejects promotion resolution when synthesis is not candidate", async () => {
    const existing = createSynthesisCapsule({
      promotion_state: PromotionState.NONE,
      cooldown_until: null
    });

    const { dependencies } = createDependencies({
      synthesisCapsuleRepo: {
        create: vi.fn(async (capsule) => capsule),
        findById: vi.fn(async () => existing),
        findByWorkspaceId: vi.fn(async () => []),
        findByTopicKey: vi.fn(async () => []),
        updateStatus: vi.fn(async () => existing),
        updatePromotionState: vi.fn(async () => existing),
        incrementAuthorityRound: vi.fn(async () => existing),
        setCooldownUntil: vi.fn(async () => existing)
      }
    });

    const service = new SynthesisService(dependencies);

    await expect(
      service.resolvePromotionDecision(
        existing.object_id,
        PromotionState.PROMOTED,
        "proposal_accepted",
        TransitionCausedBy.REVIEW
      )
    ).rejects.toMatchObject({
      name: "CoreError",
      code: "VALIDATION"
    });
  });
  it("increments authority rounds", async () => {
    const existing = createSynthesisCapsule({ authority_round_count: 3 });

    const { dependencies } = createDependencies({
      synthesisCapsuleRepo: {
        create: vi.fn(async (capsule) => capsule),
        findById: vi.fn(async () => existing),
        findByWorkspaceId: vi.fn(async () => []),
        findByTopicKey: vi.fn(async () => []),
        updateStatus: vi.fn(async () => existing),
        updatePromotionState: vi.fn(async () => existing),
        incrementAuthorityRound: vi.fn(async (_objectId, updatedAt) =>
          Object.freeze({ ...existing, authority_round_count: 4, updated_at: updatedAt })
        ),
        setCooldownUntil: vi.fn(async () => existing)
      }
    });

    const service = new SynthesisService(dependencies);
    const updated = await service.incrementAuthority(existing.object_id);

    expect(updated.authority_round_count).toBe(4);
  });
});
