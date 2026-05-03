import { describe, expect, it, vi } from "vitest";
import {
  ClaimLifecycleState,
  DYNAMICS_CONSTANTS,
  PromotionState,
  ProposalResolutionState,
  RetentionPolicy,
  type ClaimForm,
  type EventLogEntry,
  type Proposal,
  type SynthesisCapsule
} from "@do-soul/alaya-protocol";
import { InMemoryKarmaEventStore } from "../karma-event-store.js";
import { ProposalService, type ProposalServiceDependencies } from "../proposal-service.js";

function createSynthesis(overrides: Partial<SynthesisCapsule> = {}): SynthesisCapsule {
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
    authority_round_count: 1,
    cooldown_until: null,
    promotion_state: PromotionState.CANDIDATE,
    summary: "Candidate summary",
    evidence_refs: ["evidence-1"],
    source_memory_refs: ["memory-1"],
    workspace_id: "workspace-1",
    run_id: "run-1",
    synthesis_status: "stable",
    ...overrides
  };
}

function createClaim(overrides: Partial<ClaimForm> = {}): ClaimForm {
  return {
    object_id: "590b6f34-7ea5-4f9b-ae74-fe8d4f5af96a",
    object_kind: "claim_form",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: "2026-03-21T00:00:00.000Z",
    updated_at: "2026-03-21T00:00:00.000Z",
    created_by: "user_action",
    governance_subject: {
      subject_domain: "signal.constraint",
      subject_qualifiers: { workspace: "workspace-1", run: "run-1" },
      canonical_key: "signal.constraint::run=run-1,workspace=workspace-1"
    },
    claim_kind: "constraint",
    scope_class: "project",
    enforcement_level: "strict",
    origin_tier: "compiler_extracted",
    precedence_basis: "evidence_strength",
    proposition_digest: "Use pnpm for workspace commands.",
    evidence_refs: ["evidence-1"],
    source_object_refs: ["memory-1"],
    workspace_id: "workspace-1",
    claim_status: ClaimLifecycleState.DRAFT,
    ...overrides
  };
}

function createProposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    runtime_id: "24c607da-7544-47a7-a28e-d649071f77f5",
    object_kind: "proposal",
    task_surface_ref: null,
    expires_at: null,
    derived_from: "f8b2124d-4954-4ea0-a77e-ad4b137ed8ee",
    retention_policy: RetentionPolicy.SESSION_ONLY,
    proposal_id: "24c607da-7544-47a7-a28e-d649071f77f5",
    dossier_ref: null,
    recommended_option_id: "590b6f34-7ea5-4f9b-ae74-fe8d4f5af96a",
    proposal_options: [
      {
        option_id: "590b6f34-7ea5-4f9b-ae74-fe8d4f5af96a",
        option_kind: "request_confirmation",
        preserves_protected_constraints: true,
        dropped_candidates: [],
        unresolved_after_apply: [],
        requires_confirmation: true
      }
    ],
    resolution_state: ProposalResolutionState.PENDING,
    last_updated_at: "2026-03-21T00:00:00.000Z",
    ...overrides
  };
}

function createDependencies(overrides: Partial<ProposalServiceDependencies> = {}): {
  readonly dependencies: ProposalServiceDependencies;
  readonly appendSpy: ReturnType<typeof vi.fn>;
  readonly queryByEntitySpy: ReturnType<typeof vi.fn>;
  readonly proposalCreateSpy: ReturnType<typeof vi.fn>;
  readonly proposalUpdateSpy: ReturnType<typeof vi.fn>;
  readonly claimTransitionSpy: ReturnType<typeof vi.fn>;
  readonly synthesisResolveSpy: ReturnType<typeof vi.fn>;
  readonly karmaStore: InMemoryKarmaEventStore;
  readonly dynamicsProcessSpy: ReturnType<typeof vi.fn>;
  readonly warnSpy: ReturnType<typeof vi.fn>;
  readonly notifySpy: ReturnType<typeof vi.fn>;
} {
  const appendSpy = vi.fn(async (event: Omit<EventLogEntry, "event_id" | "created_at">) => ({
    event_id: `event-${event.event_type}`,
    created_at: "2026-03-21T00:00:00.000Z",
    ...event
  }));
  const queryByEntitySpy = vi.fn(async () => [] as readonly EventLogEntry[]);
  const proposalCreateSpy = vi.fn(async ({ proposal }: { proposal: Proposal }) => Object.freeze({ ...proposal }));
  const proposalUpdateSpy = vi.fn(async (_proposalId: string, state: Proposal["resolution_state"], updatedAt: string) =>
    Object.freeze(createProposal({ resolution_state: state, last_updated_at: updatedAt }))
  );
  const claimTransitionSpy = vi.fn(async (_id, status) => Object.freeze(createClaim({ claim_status: status })));
  const synthesisResolveSpy = vi.fn(async (_id, nextState) =>
    Object.freeze(createSynthesis({ promotion_state: nextState }))
  );
  const karmaStore = new InMemoryKarmaEventStore();
  const dynamicsProcessSpy = vi.fn(async () => {});
  const warnSpy = vi.fn();
  const notifySpy = vi.fn(async () => {});

  const dependencies: ProposalServiceDependencies = {
    now: () => "2026-03-21T01:00:00.000Z",
    generateObjectId: () => "85b3671a-d8d8-4848-9e5c-07d0a89f5ae9",
    proposalRepo: {
      create: proposalCreateSpy,
      findById: vi.fn(async () => createProposal()),
      findByWorkspaceId: vi.fn(async () => []),
      findPending: vi.fn(async () => []),
      updateResolution: proposalUpdateSpy
    },
    claimService: {
      findById: vi.fn(async () => createClaim()),
      transitionLifecycle: claimTransitionSpy
    },
    synthesisService: {
      findById: vi.fn(async () => createSynthesis()),
      resolvePromotionDecision: synthesisResolveSpy
    },
    eventLogRepo: {
      append: appendSpy,
      queryByEntity: queryByEntitySpy
    },
    karmaEventStore: karmaStore,
    dynamicsService: {
      processKarmaEvent: dynamicsProcessSpy
    },
    warn: {
      warn: warnSpy
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
    proposalCreateSpy,
    proposalUpdateSpy,
    claimTransitionSpy,
    synthesisResolveSpy,
    karmaStore,
    dynamicsProcessSpy,
    warnSpy,
    notifySpy
  };
}

describe("ProposalService", () => {
  it("creates proposal from synthesis promotion candidate", async () => {
    const order: string[] = [];
    const { dependencies } = createDependencies({
      eventLogRepo: {
        queryByEntity: vi.fn(async () => {
          order.push("event_query");
          return [];
        }),
        append: vi.fn(async (event) => {
          order.push("event_log");
          return {
            event_id: "event-created",
            created_at: "2026-03-21T01:00:00.000Z",
            ...event
          };
        })
      },
      proposalRepo: {
        create: vi.fn(async (input) => {
          order.push("repo_create");
          return Object.freeze({ ...input.proposal });
        }),
        findById: vi.fn(async () => null),
        findByWorkspaceId: vi.fn(async () => []),
        findPending: vi.fn(async () => []),
        updateResolution: vi.fn(async () => {
          throw new Error("not used");
        })
      }
    });

    const service = new ProposalService(dependencies);
    const created = await service.createFromSynthesisPromotion(
      "f8b2124d-4954-4ea0-a77e-ad4b137ed8ee",
      "590b6f34-7ea5-4f9b-ae74-fe8d4f5af96a"
    );

    expect(order).toEqual(["event_query", "event_log", "repo_create"]);
    expect(created).toMatchObject({
      object_kind: "proposal",
      resolution_state: "pending",
      proposal_options: [
        expect.objectContaining({
          option_kind: "request_confirmation"
        })
      ]
    });
  });

  it("rejects create when synthesis is not candidate", async () => {
    const { dependencies, appendSpy } = createDependencies({
      synthesisService: {
        findById: vi.fn(async () => createSynthesis({ promotion_state: PromotionState.NONE })),
        resolvePromotionDecision: vi.fn(async () => createSynthesis())
      }
    });

    const service = new ProposalService(dependencies);

    await expect(
      service.createFromSynthesisPromotion(
        "f8b2124d-4954-4ea0-a77e-ad4b137ed8ee",
        "590b6f34-7ea5-4f9b-ae74-fe8d4f5af96a"
      )
    ).rejects.toMatchObject({
      name: "CoreError",
      code: "VALIDATION"
    });

    expect(appendSpy).not.toHaveBeenCalled();
  });

  it("rejects create when claim is not draft", async () => {
    const { dependencies, appendSpy } = createDependencies({
      claimService: {
        findById: vi.fn(async () => createClaim({ claim_status: ClaimLifecycleState.ACTIVE })),
        transitionLifecycle: vi.fn(async () => createClaim())
      }
    });

    const service = new ProposalService(dependencies);

    await expect(
      service.createFromSynthesisPromotion(
        "f8b2124d-4954-4ea0-a77e-ad4b137ed8ee",
        "590b6f34-7ea5-4f9b-ae74-fe8d4f5af96a"
      )
    ).rejects.toMatchObject({
      name: "CoreError",
      code: "VALIDATION"
    });

    expect(appendSpy).not.toHaveBeenCalled();
  });

  it("accept review transitions claim+synthesis and records karma gain", async () => {
    const reviewAppendSpy = vi.fn(async (event: Omit<EventLogEntry, "event_id" | "created_at">) => ({
      event_id: `event-${event.event_type}`,
      created_at: "2026-03-21T00:00:00.000Z",
      ...event
    }));

    const { dependencies, claimTransitionSpy, synthesisResolveSpy, karmaStore, dynamicsProcessSpy, proposalUpdateSpy } =
      createDependencies({
        eventLogRepo: {
          queryByEntity: vi.fn(async () =>
            [
              {
                event_id: "event-history",
                event_type: "soul.proposal.created",
                entity_type: "proposal",
                entity_id: "24c607da-7544-47a7-a28e-d649071f77f5",
                workspace_id: "workspace-1",
                run_id: "run-1",
                caused_by: "system",
                revision: 4,
                payload_json: {
                  object_id: "24c607da-7544-47a7-a28e-d649071f77f5",
                  object_kind: "proposal",
                  workspace_id: "workspace-1",
                  run_id: "run-1"
                },
                created_at: "2026-03-21T00:00:00.000Z"
              }
            ] as readonly EventLogEntry[]
          ),
          append: reviewAppendSpy
        }
      });

    const service = new ProposalService(dependencies);

    const updated = await service.review("24c607da-7544-47a7-a28e-d649071f77f5", {
      action: "accepted",
      note: "LGTM",
      reviewed_by: "user",
      reviewed_at: "2026-03-21T02:00:00.000Z"
    });

    expect(updated.resolution_state).toBe("accepted");
    expect(claimTransitionSpy).toHaveBeenCalledWith(
      "590b6f34-7ea5-4f9b-ae74-fe8d4f5af96a",
      "active",
      "proposal_accepted",
      "review",
      expect.objectContaining({ deferredNotificationEvents: expect.any(Array) })
    );
    expect(synthesisResolveSpy).toHaveBeenCalledWith(
      "f8b2124d-4954-4ea0-a77e-ad4b137ed8ee",
      "promoted",
      "proposal_accepted",
      "review",
      expect.objectContaining({ deferredNotificationEvents: expect.any(Array) })
    );
    expect(proposalUpdateSpy).toHaveBeenCalledWith(
      "24c607da-7544-47a7-a28e-d649071f77f5",
      "accepted",
      "2026-03-21T02:00:00.000Z"
    );

    const karmaEvents = karmaStore.findByObjectId("memory-1");
    expect(karmaEvents).toHaveLength(0);
    expect(dynamicsProcessSpy).toHaveBeenCalledWith(expect.objectContaining({
      kind: "accept_gain",
      object_id: "memory-1"
    }));

    expect(reviewAppendSpy).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        event_type: "soul.review.created",
        revision: 5
      })
    );
    expect(reviewAppendSpy).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        event_type: "soul.review.completed",
        revision: 6
      })
    );
    expect(reviewAppendSpy).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        event_type: "soul.proposal.resolved",
        revision: 7
      })
    );
  });

  it("reject review transitions synthesis to rejected with cooldown and records penalty", async () => {
    const { dependencies, claimTransitionSpy, synthesisResolveSpy, karmaStore, dynamicsProcessSpy, proposalUpdateSpy } =
      createDependencies();

    const service = new ProposalService(dependencies);

    const updated = await service.review("24c607da-7544-47a7-a28e-d649071f77f5", {
      action: "rejected",
      note: null,
      reviewed_by: "user",
      reviewed_at: "2026-03-21T03:00:00.000Z"
    });

    expect(updated.resolution_state).toBe("rejected");
    expect(claimTransitionSpy).not.toHaveBeenCalled();
    expect(synthesisResolveSpy).toHaveBeenCalledWith(
      "f8b2124d-4954-4ea0-a77e-ad4b137ed8ee",
      "rejected",
      "proposal_rejected",
      "review",
      expect.objectContaining({
        cooldownUntil: "2026-03-22T03:00:00.000Z",
        deferredNotificationEvents: expect.any(Array)
      })
    );
    expect(proposalUpdateSpy).toHaveBeenCalledWith(
      "24c607da-7544-47a7-a28e-d649071f77f5",
      "rejected",
      "2026-03-21T03:00:00.000Z"
    );

    const karmaEvents = karmaStore.findByObjectId("memory-1");
    expect(karmaEvents).toHaveLength(0);
    expect(dynamicsProcessSpy).toHaveBeenCalledWith(expect.objectContaining({
      kind: "reject_penalty",
      object_id: "memory-1"
    }));
  });

  it("skips karma+dynamics when no memory target can be resolved", async () => {
    const { dependencies, karmaStore, dynamicsProcessSpy, warnSpy } = createDependencies({
      claimService: {
        findById: vi.fn(async () => createClaim({ source_object_refs: [] })),
        transitionLifecycle: vi.fn(async () => createClaim())
      },
      synthesisService: {
        findById: vi.fn(async () => createSynthesis({ source_memory_refs: [] })),
        resolvePromotionDecision: vi.fn(async () => createSynthesis())
      }
    });

    const service = new ProposalService(dependencies);

    await expect(
      service.review("24c607da-7544-47a7-a28e-d649071f77f5", {
        action: "accepted",
        note: null,
        reviewed_by: "user",
        reviewed_at: "2026-03-21T02:00:00.000Z"
      })
    ).resolves.toMatchObject({ resolution_state: "accepted" });

    expect(karmaStore.findByObjectId("memory-1")).toHaveLength(0);
    expect(dynamicsProcessSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      "[ProposalService] Skipping dynamics update because no memory target is available for claim",
      expect.objectContaining({
        claim_id: "590b6f34-7ea5-4f9b-ae74-fe8d4f5af96a",
        synthesis_id: "f8b2124d-4954-4ea0-a77e-ad4b137ed8ee"
      })
    );
  });

  it("records karma in fallback mode when dynamics service is absent", async () => {
    const { dependencies, karmaStore, dynamicsProcessSpy } = createDependencies({
      dynamicsService: undefined
    });

    const service = new ProposalService(dependencies);

    await service.review("24c607da-7544-47a7-a28e-d649071f77f5", {
      action: "accepted",
      note: null,
      reviewed_by: "user",
      reviewed_at: "2026-03-21T02:00:00.000Z"
    });

    const karmaEvents = karmaStore.findByObjectId("memory-1");
    expect(karmaEvents).toHaveLength(1);
    expect(karmaEvents[0]).toMatchObject({
      kind: "accept_gain",
      object_id: "memory-1",
      amount: DYNAMICS_CONSTANTS.karma.accept_gain
    });
    expect(dynamicsProcessSpy).not.toHaveBeenCalled();
  });

  it("rejects review when proposal is not pending", async () => {
    const { dependencies, appendSpy } = createDependencies({
      proposalRepo: {
        create: vi.fn(async ({ proposal }) => proposal),
        findById: vi.fn(async () => createProposal({ resolution_state: ProposalResolutionState.ACCEPTED })),
        findByWorkspaceId: vi.fn(async () => []),
        findPending: vi.fn(async () => []),
        updateResolution: vi.fn(async () => createProposal())
      }
    });

    const service = new ProposalService(dependencies);

    await expect(
      service.review("24c607da-7544-47a7-a28e-d649071f77f5", {
        action: "accepted",
        note: null,
        reviewed_by: "user",
        reviewed_at: "2026-03-21T02:00:00.000Z"
      })
    ).rejects.toMatchObject({
      name: "CoreError",
      code: "VALIDATION"
    });

    expect(appendSpy).not.toHaveBeenCalled();
  });

  it("rejects review when dossier_ref is set", async () => {
    const { dependencies, appendSpy } = createDependencies({
      proposalRepo: {
        create: vi.fn(async ({ proposal }) => proposal),
        findById: vi.fn(async () => createProposal({ dossier_ref: "dossier-1" })),
        findByWorkspaceId: vi.fn(async () => []),
        findPending: vi.fn(async () => []),
        updateResolution: vi.fn(async () => createProposal())
      }
    });

    const service = new ProposalService(dependencies);

    await expect(
      service.review("24c607da-7544-47a7-a28e-d649071f77f5", {
        action: "accepted",
        note: null,
        reviewed_by: "user",
        reviewed_at: "2026-03-21T02:00:00.000Z"
      })
    ).rejects.toMatchObject({
      name: "CoreError",
      code: "VALIDATION"
    });

    expect(appendSpy).not.toHaveBeenCalled();
  });

  it("passes deferredNotificationEvents to claimService so claim transition does not notify before reviewCreated", async () => {
    // Regression for P2-a: ClaimService.transitionLifecycle() must receive the
    // deferredNotificationEvents array so it defers notification rather than
    // firing before reviewCreated is notified. Verify the option is threaded through.
    const notificationOrder: string[] = [];
    // Claim lifecycle events are workspace-scoped and carry run_id: null in production.
    const deferredEventFromClaim: EventLogEntry = {
      event_id: "event-claim-transition",
      event_type: "soul.claim.lifecycle_changed",
      entity_type: "claim_form",
      entity_id: "590b6f34-7ea5-4f9b-ae74-fe8d4f5af96a",
      workspace_id: "workspace-1",
      run_id: null,
      caused_by: "review",
      revision: 1,
      payload_json: {},
      created_at: "2026-03-21T00:00:00.000Z"
    };

    const { dependencies } = createDependencies({
      claimService: {
        findById: vi.fn(async () => createClaim()),
        transitionLifecycle: vi.fn(async (_id, _state, _reason, _causedBy, options) => {
          // Simulate real ClaimService: push event to deferred array if provided.
          if (options?.deferredNotificationEvents) {
            options.deferredNotificationEvents.push(deferredEventFromClaim);
          }
          return Object.freeze(createClaim({ claim_status: "active" }));
        })
      },
      runtimeNotifier: {
        notifyEntry: vi.fn(async (entry: EventLogEntry) => {
          notificationOrder.push(entry.event_type);
        })
      }
    });

    const service = new ProposalService(dependencies);
    await service.review("24c607da-7544-47a7-a28e-d649071f77f5", {
      action: "accepted",
      note: null,
      reviewed_by: "user",
      reviewed_at: "2026-03-21T02:00:00.000Z"
    });

    // Full notification order on accept path must be:
    //   soul.review.created → soul.claim.lifecycle_changed → soul.review.completed → soul.proposal.resolved
    // (P5-system-review-r1 MR-B04: ProposalService/ClaimService property name drift caused
    // claim.lifecycle_changed to fire before review.created at runtime; covered here.)
    expect(notificationOrder).toEqual([
      "soul.review.created",
      "soul.claim.lifecycle_changed",
      "soul.review.completed",
      "soul.proposal.resolved"
    ]);
  });
});
