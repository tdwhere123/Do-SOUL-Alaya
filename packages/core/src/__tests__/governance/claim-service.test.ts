import { describe, expect, it, vi } from "vitest";
import {
  ClaimLifecycleState,
  PROOF_EFFECT_OPERATOR_ID,
  PROOF_EFFECT_OPERATOR_VERSION,
  TransitionCausedBy,
  hashEffectGovernanceFrontier,
  type EffectRequest,
  type EventLogEntry,
  type Slot
} from "@do-soul/alaya-protocol";
import { ClaimService, derivePrecedenceBasis } from "../../governance/claims/claim-service.js";
import { CanonicalAliasService } from "../../governance/claims/canonical-alias-service.js";
import { StubEventPublisher } from "../support/event-publisher-stub.js";
import type { SlotElectionResult } from "../../surfaces/slot-service.js";
import { buildEffectDecisionReceipt } from "../../governance/effects/proof-effect-policy.js";
import { fieldContractSha256 } from "../../shared/field-hash.js";

import { createClaimForm, createClaimInput, createDependencies, createEventLogHistory } from "./claim-service.test-support.js";

function lifecycleAuditInput(
  claim: ReturnType<typeof createClaimForm>,
  eventType: string
): Omit<EventLogEntry, "event_id" | "created_at" | "revision"> {
  return {
    event_type: eventType as EventLogEntry["event_type"],
    entity_type: "claim_form",
    entity_id: claim.object_id,
    workspace_id: claim.workspace_id,
    run_id: "run-1",
    caused_by: "actor-1",
    payload_json: {}
  };
}

function effectReceipt(
  claim: ReturnType<typeof createClaimForm>,
  decision: "allow" | "deny" = "allow"
) {
  const witnesses = [
    { receipt_id: "auth-1", kind: "actor_authority", authority_event_id: "delivery-event-1",
      source_record_id: null,
      source_content_digest: null },
    { receipt_id: "source-1", kind: "source_grounding", authority_event_id: null,
      source_record_id: "record-1",
      source_content_digest: "digest-1" }
  ];
  return buildEffectDecisionReceipt({
    schema_version: 2,
    workspace_id: claim.workspace_id,
    actor_id: "actor-1",
    run_id: "run-1",
    delivery_id: "delivery-1",
    action: "activate",
    target: claim.object_id,
    scope: claim.workspace_id,
    effective_as_of: "2026-03-21T01:00:00.000Z",
    supporting_receipt_ids: ["auth-1", "source-1"],
    supporting_proof_witnesses: witnesses,
    governance_frontier: hashEffectGovernanceFrontier(witnesses, fieldContractSha256),
    policy_operator_id: PROOF_EFFECT_OPERATOR_ID,
    policy_operator_version: PROOF_EFFECT_OPERATOR_VERSION
  } satisfies EffectRequest, decision, "2026-03-21T01:00:00.000Z", fieldContractSha256);
}

describe("ClaimService", () => {
  it("creates a draft claim and emits soul.claim.created", async () => {
    const order: string[] = [];

    const { dependencies, broadcastSpy } = createDependencies({
      eventLogRepo: {
        append: vi.fn((event) => {
          order.push("event_log");
          return {
            event_id: "event-created",
            created_at: "2026-03-21T01:00:00.000Z",
            revision: 0,
            ...event
          };
        }),
        queryByEntity: vi.fn(async () => {
          order.push("event_query");
          return [];
        })
      },
      claimFormRepo: {
        create: vi.fn((claim) => {
          order.push("repo_create");
          return Object.freeze({ ...claim });
        }),
        findById: vi.fn(async () => null),
        findByWorkspaceId: vi.fn(async () => []),
        findByStatus: vi.fn(async () => []),
        findByCanonicalKey: vi.fn(async () => []),
        updateStatus: vi.fn(async () => {
          throw new Error("not used");
        })
      }
    });

    const service = new ClaimService(dependencies);
    const created = await service.create(createClaimInput());

    expect(order).toEqual(["event_log", "repo_create"]);
    expect(created.claim_status).toBe(ClaimLifecycleState.DRAFT);
    expect(created.governance_subject.canonical_key).toBe("code_style::language=typescript");
    expect(broadcastSpy).toHaveBeenCalledTimes(1);
  });

  it("batches canonicalization events with claim creation on the live create path", async () => {
    const publishedBatches: Array<readonly Omit<EventLogEntry, "event_id" | "created_at" | "revision">[]> = [];
    const appendManyWithMutation = vi.fn(
      async (
        events: readonly Omit<EventLogEntry, "event_id" | "created_at" | "revision">[],
        mutate: (entries: readonly EventLogEntry[]) => unknown
      ) => {
        publishedBatches.push(events);
        const persisted = events.map((event, idx) => ({
          ...event,
          event_id: `evt_${idx}`,
          created_at: "2026-03-21T01:00:00.000Z",
          revision: idx
        }));
        return mutate(persisted);
      }
    );
    const { dependencies } = createDependencies({
      canonicalAliasService: new CanonicalAliasService({
        aliasMap: {
          "governance_subject.domain": [
            {
              alias: "用户偏好",
              canonical: "user_preference",
              language: "zh",
              domain: "governance_subject.domain"
            }
          ],
          "governance_subject.qualifier.framework": [
            {
              alias: "类型脚本",
              canonical: "typescript",
              language: "zh",
              domain: "governance_subject.qualifier.framework"
            }
          ]
        }
      }),
      eventPublisher: new StubEventPublisher(appendManyWithMutation)
    });

    const service = new ClaimService(dependencies);
    const created = await service.create(
      createClaimInput({
        governance_subject_domain: "用户偏好",
        governance_subject_qualifiers: { framework: "类型脚本" }
      })
    );

    expect(created.governance_subject.canonical_key).toBe("user_preference::framework=typescript");
    expect(appendManyWithMutation).toHaveBeenCalledTimes(1);
    expect(publishedBatches[0]?.map((event) => event.event_type)).toEqual([
      "canonicalization.applied",
      "canonicalization.alias_resolved",
      "canonicalization.applied",
      "canonicalization.alias_resolved",
      "soul.claim.created"
    ]);
    expect(publishedBatches[0]?.[0]?.payload_json).toMatchObject({
      input: "用户偏好",
      canonical: "user_preference",
      domain: "governance_subject.domain",
      was_alias_resolved: true
    });
    expect(publishedBatches[0]?.[2]?.payload_json).toMatchObject({
      input: "类型脚本",
      canonical: "typescript",
      domain: "governance_subject.qualifier.framework",
      was_alias_resolved: true
    });
  });

  it("transitions draft to active and triggers slot election", async () => {
    const existing = createClaimForm({ claim_status: ClaimLifecycleState.DRAFT });

    const { dependencies, slotElectionSpy, broadcastSpy } = createDependencies({
      eventLogRepo: {
        queryByEntity: vi.fn(async () => createEventLogHistory(2)),
        append: vi.fn((event) => ({
          event_id: "event-lifecycle",
          created_at: "2026-03-21T02:00:00.000Z",
          revision: 0,
          ...event
        }))
      },
      claimFormRepo: {
        create: vi.fn((claim) => claim),
        findById: vi.fn(async () => existing),
        findByWorkspaceId: vi.fn(async () => []),
        findByStatus: vi.fn(async () => []),
        findByCanonicalKey: vi.fn(async () => []),
        updateStatus: vi.fn(async (_objectId, status, updatedAt) =>
          Object.freeze({ ...existing, claim_status: status, updated_at: updatedAt })
        ),
        updateStatusSync: vi.fn((_objectId, status, updatedAt) =>
          Object.freeze({ ...existing, claim_status: status, updated_at: updatedAt })
        )
      }
    });

    const service = new ClaimService(dependencies);
    const updated = await service.transitionLifecycle(
      existing.object_id,
      ClaimLifecycleState.ACTIVE,
      "review_accept",
      TransitionCausedBy.REVIEW
    );

    expect(updated.claim_status).toBe(ClaimLifecycleState.ACTIVE);
    expect(slotElectionSpy).toHaveBeenCalledTimes(1);
    expect(broadcastSpy).toHaveBeenCalledTimes(1);
  });

  it("uses the atomic EventPublisher path for lifecycle transitions when the repo exposes sync CAS", async () => {
    const existing = createClaimForm({ claim_status: ClaimLifecycleState.DRAFT });
    const mutationOrder: string[] = [];
    const publishedBatches: Array<readonly Omit<EventLogEntry, "event_id" | "created_at" | "revision">[]> = [];
    const updateStatusSync = vi.fn((_objectId, status, updatedAt) => {
      mutationOrder.push("claim-cas");
      return Object.freeze({ ...existing, claim_status: status, updated_at: updatedAt });
    });
    const effectDecisionReceipt = effectReceipt(existing);
    const effectDecisionStore = {
      insert: vi.fn(() => {
        mutationOrder.push("effect-decision");
        return effectDecisionReceipt;
      })
    };
    const appendManyWithMutation = vi.fn(
      async (
        events: readonly Omit<EventLogEntry, "event_id" | "created_at" | "revision">[],
        mutate: (entries: readonly EventLogEntry[]) => unknown
      ) => {
        publishedBatches.push(events);
        const persisted = events.map((event, idx) => ({
          ...event,
          event_id: `evt_${idx}`,
          created_at: "2026-03-21T01:00:00.000Z",
          revision: idx
        }));
        return mutate(persisted);
      }
    );
    const { dependencies, appendSpy, broadcastSpy } = createDependencies({
      claimFormRepo: {
        create: vi.fn((claim) => claim),
        findById: vi.fn(async () => existing),
        findByWorkspaceId: vi.fn(async () => []),
        findByStatus: vi.fn(async () => []),
        findByCanonicalKey: vi.fn(async () => []),
        updateStatus: vi.fn(async () => {
          throw new Error("async updateStatus must not be used");
        }),
        updateStatusSync
      },
      effectDecisionStore,
      eventPublisher: new StubEventPublisher(appendManyWithMutation)
    });

    const service = new ClaimService(dependencies);
    const updated = await service.transitionLifecycle(
      existing.object_id,
      ClaimLifecycleState.ACTIVE,
      "review_accept",
      TransitionCausedBy.REVIEW,
      {
        skipSlotElection: true,
        additionalEventInputs: [
          lifecycleAuditInput(existing, "resolution.audit"),
          lifecycleAuditInput(existing, "effect.audit")
        ],
        effectDecisionReceipt
      }
    );

    expect(updated.claim_status).toBe(ClaimLifecycleState.ACTIVE);
    expect(updateStatusSync).toHaveBeenCalledWith(
      existing.object_id,
      ClaimLifecycleState.ACTIVE,
      "2026-03-21T01:00:00.000Z",
      ClaimLifecycleState.DRAFT
    );
    expect(publishedBatches[0]?.map((event) => event.event_type)).toEqual([
      "soul.claim.lifecycle_changed",
      "resolution.audit",
      "effect.audit"
    ]);
    expect(mutationOrder).toEqual(["effect-decision", "claim-cas"]);
    expect(appendSpy).not.toHaveBeenCalled();
    expect(broadcastSpy).not.toHaveBeenCalled();
  });

  it("propagates effect-decision replay conflicts before any claim CAS", async () => {
    const existing = createClaimForm({ claim_status: ClaimLifecycleState.DRAFT });
    const updateStatusSync = vi.fn(() => existing);
    const appendManyWithMutation = vi.fn(async (
      events: readonly Omit<EventLogEntry, "event_id" | "created_at" | "revision">[],
      mutate: (entries: readonly EventLogEntry[]) => unknown
    ) => mutate(events.map((event, index) => ({
      ...event,
      event_id: `evt-${index}`,
      created_at: "2026-03-21T01:00:00.000Z",
      revision: index
    }))));
    const { dependencies } = createDependencies({
      claimFormRepo: {
        create: vi.fn((claim) => claim),
        findById: vi.fn(async () => existing),
        findByWorkspaceId: vi.fn(async () => []),
        findByStatus: vi.fn(async () => []),
        findByCanonicalKey: vi.fn(async () => []),
        updateStatus: vi.fn(async () => existing),
        updateStatusSync
      },
      effectDecisionStore: {
        insert: vi.fn(() => { throw new Error("proof effect decision replay conflict"); })
      },
      eventPublisher: new StubEventPublisher(appendManyWithMutation)
    });
    const service = new ClaimService(dependencies);

    await expect(service.recordEffectDecision(
      effectReceipt(existing, "deny"),
      lifecycleAuditInput(existing, "soul.field.effect.decided")
    )).rejects.toThrow(/replay conflict/);
    expect(updateStatusSync).not.toHaveBeenCalled();
  });

  it("supports active to contested transition", async () => {
    const existing = createClaimForm({ claim_status: ClaimLifecycleState.ACTIVE });

    const { dependencies } = createDependencies({
      claimFormRepo: {
        create: vi.fn((claim) => claim),
        findById: vi.fn(async () => existing),
        findByWorkspaceId: vi.fn(async () => []),
        findByStatus: vi.fn(async () => []),
        findByCanonicalKey: vi.fn(async () => []),
        updateStatus: vi.fn(async (_objectId, status, updatedAt) =>
          Object.freeze({ ...existing, claim_status: status, updated_at: updatedAt })
        ),
        updateStatusSync: vi.fn((_objectId, status, updatedAt) =>
          Object.freeze({ ...existing, claim_status: status, updated_at: updatedAt })
        )
      },
      eventLogRepo: {
        queryByEntity: vi.fn(async () => createEventLogHistory(1)),
        append: vi.fn((event) => ({
          event_id: "event-lifecycle",
          created_at: "2026-03-21T03:00:00.000Z",
          revision: 0,
          ...event
        }))
      }
    });

    const service = new ClaimService(dependencies);
    const updated = await service.transitionLifecycle(
      existing.object_id,
      ClaimLifecycleState.CONTESTED,
      "manual_review",
      TransitionCausedBy.REVIEW,
      { skipSlotElection: true }
    );

    expect(updated.claim_status).toBe(ClaimLifecycleState.CONTESTED);
  });

  it("marks claim as contested when slot election requires review", async () => {
    const existing = createClaimForm({ claim_status: ClaimLifecycleState.DRAFT });
    let appendSeq = 0;
    const contestedAppendSpy = vi.fn((event: Omit<EventLogEntry, "event_id" | "created_at" | "revision">) => ({
      event_id: `event-${event.event_type}-${(appendSeq += 1)}`,
      created_at: "2026-03-21T00:00:00.000Z",
      revision: 0,
      ...event
    }));

    const { dependencies, broadcastSpy } = createDependencies({
      slotService: {
        onClaimActivated: vi.fn(async (): Promise<SlotElectionResult> => ({
          decision: "contested",
          reason: "same_scope_conflict_requires_review",
          slot: {
            ...createClaimForm(),
            object_id: "slot-1",
            object_kind: "slot",
            winner_claim_id: "claim-incumbent"
          } as unknown as Slot
        }))
      },
      claimFormRepo: {
        create: vi.fn((claim) => claim),
        findById: vi.fn(async () => existing),
        findByWorkspaceId: vi.fn(async () => []),
        findByStatus: vi.fn(async () => []),
        findByCanonicalKey: vi.fn(async () => []),
        updateStatus: vi.fn(async (_objectId, status, updatedAt) =>
          Object.freeze({ ...existing, claim_status: status, updated_at: updatedAt })
        ),
        updateStatusSync: vi.fn((_objectId, status, updatedAt) =>
          Object.freeze({ ...existing, claim_status: status, updated_at: updatedAt })
        )
      },
      eventLogRepo: {
        queryByEntity: vi.fn(async () => []),
        append: contestedAppendSpy
      }
    });

    const service = new ClaimService(dependencies);
    const updated = await service.transitionLifecycle(
      existing.object_id,
      ClaimLifecycleState.ACTIVE,
      "proposal_accepted",
      TransitionCausedBy.REVIEW
    );

    expect(updated.claim_status).toBe(ClaimLifecycleState.CONTESTED);
    expect(contestedAppendSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: "soul.claim.contested"
      })
    );
    expect(broadcastSpy).toHaveBeenCalledTimes(3);
    expect(
      broadcastSpy.mock.calls.map((call) => (call[0] as EventLogEntry).event_type)
    ).toEqual([
      "soul.claim.lifecycle_changed",
      "soul.claim.lifecycle_changed",
      "soul.claim.contested"
    ]);
  });

  it("fails fast when slotService is missing on draft to active transition", async () => {
    const existing = createClaimForm({ claim_status: ClaimLifecycleState.DRAFT });

    const { dependencies } = createDependencies({
      slotService: undefined,
      claimFormRepo: {
        create: vi.fn((claim) => claim),
        findById: vi.fn(async () => existing),
        findByWorkspaceId: vi.fn(async () => []),
        findByStatus: vi.fn(async () => []),
        findByCanonicalKey: vi.fn(async () => []),
        updateStatus: vi.fn(async (_objectId, status, updatedAt) =>
          Object.freeze({ ...existing, claim_status: status, updated_at: updatedAt })
        ),
        updateStatusSync: vi.fn((_objectId, status, updatedAt) =>
          Object.freeze({ ...existing, claim_status: status, updated_at: updatedAt })
        )
      }
    });

    const service = new ClaimService(dependencies);

    await expect(
      service.transitionLifecycle(existing.object_id, ClaimLifecycleState.ACTIVE, "activate", TransitionCausedBy.REVIEW)
    ).rejects.toMatchObject({
      name: "CoreError",
      code: "CONFLICT",
      message: "Slot service is required for claim activation"
    });
  });
  describe("derivePrecedenceBasis", () => {
    it("returns evidence_strength for a normal Garden compile claim", () => {
      expect(
        derivePrecedenceBasis({
          source: "garden_compile",
          enforcement_level: "preferred"
        })
      ).toBe("evidence_strength");
    });

    it("returns recency when the new claim supersedes a prior one", () => {
      expect(
        derivePrecedenceBasis({
          source: "garden_compile",
          enforcement_level: "preferred",
          is_supersede: true
        })
      ).toBe("recency");
    });

    it("returns authority when enforcement_level is strict", () => {
      expect(
        derivePrecedenceBasis({
          source: "garden_compile",
          enforcement_level: "strict"
        })
      ).toBe("authority");
    });

    it("returns user_override when source is user_seed", () => {
      expect(
        derivePrecedenceBasis({
          source: "user_seed",
          enforcement_level: "preferred"
        })
      ).toBe("user_override");
    });

    it("returns user_override when signal carries an explicit override marker", () => {
      expect(
        derivePrecedenceBasis({
          source: "model_tool",
          enforcement_level: "preferred",
          user_override: true
        })
      ).toBe("user_override");
    });

    it("prefers authority over recency when both conditions match", () => {
      expect(
        derivePrecedenceBasis({
          source: "garden_compile",
          enforcement_level: "strict",
          is_supersede: true
        })
      ).toBe("authority");
    });

    it("prefers user_override over authority when both conditions match", () => {
      expect(
        derivePrecedenceBasis({
          source: "user_seed",
          enforcement_level: "strict",
          is_supersede: true
        })
      ).toBe("user_override");
    });
  });

  it("rejects invalid lifecycle transitions", async () => {
    const existing = createClaimForm({ claim_status: ClaimLifecycleState.DRAFT });

    const { dependencies } = createDependencies({
      claimFormRepo: {
        create: vi.fn((claim) => claim),
        findById: vi.fn(async () => existing),
        findByWorkspaceId: vi.fn(async () => []),
        findByStatus: vi.fn(async () => []),
        findByCanonicalKey: vi.fn(async () => []),
        updateStatus: vi.fn(async () => existing)
      }
    });

    const service = new ClaimService(dependencies);

    await expect(
      service.transitionLifecycle(existing.object_id, ClaimLifecycleState.WINNER, "invalid", TransitionCausedBy.REVIEW)
    ).rejects.toMatchObject({
      name: "CoreError",
      code: "VALIDATION"
    });
  });

  it("findByIdScoped returns the claim when the workspace matches", async () => {
    const claim = createClaimForm({ workspace_id: "workspace-1" });
    const { dependencies } = createDependencies({
      claimFormRepo: {
        create: vi.fn((value) => value),
        findById: vi.fn(async () => claim),
        findByWorkspaceId: vi.fn(async () => []),
        findByStatus: vi.fn(async () => []),
        findByCanonicalKey: vi.fn(async () => []),
        updateStatus: vi.fn(async () => claim)
      }
    });

    const service = new ClaimService(dependencies);

    await expect(service.findByIdScoped(claim.object_id, "workspace-1")).resolves.toEqual(claim);
  });

  it("rejects create when EventPublisher is missing", async () => {
    const { dependencies } = createDependencies({ eventPublisher: undefined });
    const service = new ClaimService(dependencies);

    await expect(service.create(createClaimInput())).rejects.toMatchObject({
      name: "CoreError",
      code: "CONFLICT",
      message: "Event publisher is required for atomic claim operations"
    });
  });

  it("rejects lifecycle transition when EventPublisher is missing", async () => {
    const existing = createClaimForm({ claim_status: ClaimLifecycleState.DRAFT });
    const { dependencies } = createDependencies({
      eventPublisher: undefined,
      claimFormRepo: {
        create: vi.fn((claim) => claim),
        findById: vi.fn(async () => existing),
        findByWorkspaceId: vi.fn(async () => []),
        findByStatus: vi.fn(async () => []),
        findByCanonicalKey: vi.fn(async () => []),
        updateStatus: vi.fn(async (_objectId, status, updatedAt) =>
          Object.freeze({ ...existing, claim_status: status, updated_at: updatedAt })
        ),
        updateStatusSync: vi.fn((_objectId, status, updatedAt) =>
          Object.freeze({ ...existing, claim_status: status, updated_at: updatedAt })
        )
      }
    });
    const service = new ClaimService(dependencies);

    await expect(
      service.transitionLifecycle(
        existing.object_id,
        ClaimLifecycleState.ACTIVE,
        "review_accept",
        TransitionCausedBy.REVIEW,
        { skipSlotElection: true }
      )
    ).rejects.toMatchObject({
      name: "CoreError",
      code: "CONFLICT",
      message: "Event publisher is required for atomic claim operations"
    });
  });

  it("findByIdScoped hides a claim that belongs to a different workspace", async () => {
    const claim = createClaimForm({ workspace_id: "workspace-1" });
    const { dependencies } = createDependencies({
      claimFormRepo: {
        create: vi.fn((value) => value),
        findById: vi.fn(async () => claim),
        findByWorkspaceId: vi.fn(async () => []),
        findByStatus: vi.fn(async () => []),
        findByCanonicalKey: vi.fn(async () => []),
        updateStatus: vi.fn(async () => claim)
      }
    });

    const service = new ClaimService(dependencies);

    await expect(service.findByIdScoped(claim.object_id, "workspace-b")).resolves.toBeNull();
  });
});
