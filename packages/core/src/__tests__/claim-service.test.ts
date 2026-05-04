import { describe, expect, it, vi } from "vitest";
import {
  ClaimLifecycleState,
  TransitionCausedBy,
  canonicalGovernanceSubject,
  type ClaimForm,
  type EventLogEntry,
  type Slot
} from "@do-soul/alaya-protocol";
import { ClaimService, type ClaimFormInput, type ClaimServiceDependencies } from "../claim-service.js";
import { CanonicalAliasService } from "../canonical-alias-service.js";
import type { SlotElectionResult } from "../slot-service.js";

function createClaimInput(overrides: Partial<ClaimFormInput> = {}): ClaimFormInput {
  return {
    created_by: "user_action",
    governance_subject_domain: "code_style",
    governance_subject_qualifiers: { language: "TypeScript" },
    claim_kind: "constraint",
    scope_class: "project",
    enforcement_level: "strict",
    origin_tier: "user_explicit",
    precedence_basis: "authority",
    proposition_digest: "Use pnpm for workspace commands.",
    evidence_refs: ["evidence-1"],
    source_object_refs: ["synthesis-1"],
    workspace_id: "workspace-1",
    ...overrides
  };
}

function createClaimForm(overrides: Partial<ClaimForm> = {}): ClaimForm {
  return {
    object_id: "590b6f34-7ea5-4f9b-ae74-fe8d4f5af96a",
    object_kind: "claim_form",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: "2026-03-21T00:00:00.000Z",
    updated_at: "2026-03-21T00:00:00.000Z",
    created_by: "user_action",
    governance_subject: canonicalGovernanceSubject("code_style", { language: "typescript" }),
    claim_kind: "constraint",
    scope_class: "project",
    enforcement_level: "strict",
    origin_tier: "user_explicit",
    precedence_basis: "authority",
    proposition_digest: "Use pnpm for workspace commands.",
    evidence_refs: ["evidence-1"],
    source_object_refs: ["synthesis-1"],
    workspace_id: "workspace-1",
    claim_status: ClaimLifecycleState.DRAFT,
    ...overrides
  };
}

function createEventLogHistory(maxRevision: number): readonly EventLogEntry[] {
  return [
    {
      event_id: "event-history",
      event_type: "soul.claim.created",
      entity_type: "claim_form",
      entity_id: "590b6f34-7ea5-4f9b-ae74-fe8d4f5af96a",
      workspace_id: "workspace-1",
      run_id: null,
      caused_by: "user_action",
      revision: maxRevision,
      payload_json: {
        object_id: "590b6f34-7ea5-4f9b-ae74-fe8d4f5af96a",
        object_kind: "claim_form",
        workspace_id: "workspace-1",
        run_id: null
      },
      created_at: "2026-03-21T00:00:00.000Z"
    }
  ];
}

function createDependencies(overrides: Partial<ClaimServiceDependencies> = {}): {
  readonly dependencies: ClaimServiceDependencies;
  readonly appendSpy: ReturnType<typeof vi.fn>;
  readonly queryByEntitySpy: ReturnType<typeof vi.fn>;
  readonly broadcastSpy: ReturnType<typeof vi.fn>;
  readonly slotElectionSpy: ReturnType<typeof vi.fn>;
} {
  const appendSpy = vi.fn(async (event: Omit<EventLogEntry, "event_id" | "created_at">) => ({
    event_id: `event-${event.event_type}-${Math.random()}`,
    created_at: "2026-03-21T00:00:00.000Z",
    ...event
  }));
  const queryByEntitySpy = vi.fn(async () => [] as readonly EventLogEntry[]);
  const broadcastSpy = vi.fn(async () => {});
  const slotElectionSpy = vi.fn(async (): Promise<SlotElectionResult> => ({
    decision: "new_slot_created",
    reason: "first_claim_for_subject",
    slot: {
      object_id: "slot-1",
      object_kind: "slot",
      schema_version: 1,
      lifecycle_state: "active",
      created_at: "2026-03-21T00:00:00.000Z",
      updated_at: "2026-03-21T00:00:00.000Z",
      created_by: "system",
      governance_subject: canonicalGovernanceSubject("code_style", { language: "typescript" }),
      claim_kind: "constraint",
      scope_class: "project",
      winner_claim_id: "590b6f34-7ea5-4f9b-ae74-fe8d4f5af96a",
      incumbent_since: "2026-03-21T00:00:00.000Z",
      flip_conditions: [],
      workspace_id: "workspace-1"
    } satisfies Slot
  }));

  const dependencies: ClaimServiceDependencies = {
    now: () => "2026-03-21T01:00:00.000Z",
    generateObjectId: () => "85b3671a-d8d8-4848-9e5c-07d0a89f5ae9",
    claimFormRepo: {
      create: vi.fn(async (claim) => Object.freeze({ ...claim })),
      createSync: vi.fn((claim) => Object.freeze({ ...claim })),
      findById: vi.fn(async () => createClaimForm()),
      findByWorkspaceId: vi.fn(async () => []),
      findByStatus: vi.fn(async () => []),
      findByCanonicalKey: vi.fn(async () => []),
      updateStatus: vi.fn(async (_objectId, status, updatedAt) =>
        Object.freeze(createClaimForm({ claim_status: status, updated_at: updatedAt }))
      )
    },
    eventLogRepo: {
      append: appendSpy,
      queryByEntity: queryByEntitySpy
    },
    slotService: {
      onClaimActivated: slotElectionSpy
    },
    runtimeNotifier: {
      notifyEntry: broadcastSpy
    },
    ...overrides
  };

  return {
    dependencies,
    appendSpy,
    queryByEntitySpy,
    broadcastSpy,
    slotElectionSpy
  };
}

describe("ClaimService", () => {
  it("creates a draft claim and emits soul.claim.created", async () => {
    const order: string[] = [];

    const { dependencies, broadcastSpy } = createDependencies({
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
      claimFormRepo: {
        create: vi.fn(async (claim) => {
          order.push("repo_create");
          return Object.freeze({ ...claim });
        }),
        createSync: vi.fn((claim) => {
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

    expect(order).toEqual(["event_query", "event_log", "repo_create"]);
    expect(created.claim_status).toBe(ClaimLifecycleState.DRAFT);
    expect(created.governance_subject.canonical_key).toBe("code_style::language=typescript");
    expect(broadcastSpy).toHaveBeenCalledTimes(1);
  });

  it("batches canonicalization events with claim creation on the live create path", async () => {
    const publishedBatches: Array<readonly Omit<EventLogEntry, "event_id" | "created_at">[]> = [];
    const appendManyWithMutation = vi.fn(
      async (
        events: readonly Omit<EventLogEntry, "event_id" | "created_at">[],
        mutate: (entries: readonly EventLogEntry[]) => Readonly<ClaimForm>
      ) => {
        publishedBatches.push(events);
        const persisted = events.map((event, idx) => ({
          ...event,
          event_id: `evt_${idx}`,
          created_at: "2026-03-21T01:00:00.000Z"
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
      } as any),
      eventPublisher: {
        appendManyWithMutation
      } as any
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
        append: vi.fn(async (event) => ({
          event_id: "event-lifecycle",
          created_at: "2026-03-21T02:00:00.000Z",
          ...event
        }))
      },
      claimFormRepo: {
        create: vi.fn(async (claim) => claim),
        createSync: vi.fn((claim) => claim),
        findById: vi.fn(async () => existing),
        findByWorkspaceId: vi.fn(async () => []),
        findByStatus: vi.fn(async () => []),
        findByCanonicalKey: vi.fn(async () => []),
        updateStatus: vi.fn(async (_objectId, status, updatedAt) =>
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

  it("supports active to contested transition in Phase 2A", async () => {
    const existing = createClaimForm({ claim_status: ClaimLifecycleState.ACTIVE });

    const { dependencies } = createDependencies({
      claimFormRepo: {
        create: vi.fn(async (claim) => claim),
        createSync: vi.fn((claim) => claim),
        findById: vi.fn(async () => existing),
        findByWorkspaceId: vi.fn(async () => []),
        findByStatus: vi.fn(async () => []),
        findByCanonicalKey: vi.fn(async () => []),
        updateStatus: vi.fn(async (_objectId, status, updatedAt) =>
          Object.freeze({ ...existing, claim_status: status, updated_at: updatedAt })
        )
      },
      eventLogRepo: {
        queryByEntity: vi.fn(async () => createEventLogHistory(1)),
        append: vi.fn(async (event) => ({
          event_id: "event-lifecycle",
          created_at: "2026-03-21T03:00:00.000Z",
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
    const contestedAppendSpy = vi.fn(async (event: Omit<EventLogEntry, "event_id" | "created_at">) => ({
      event_id: `event-${event.event_type}-${Math.random()}`,
      created_at: "2026-03-21T00:00:00.000Z",
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
        create: vi.fn(async (claim) => claim),
        createSync: vi.fn((claim) => claim),
        findById: vi.fn(async () => existing),
        findByWorkspaceId: vi.fn(async () => []),
        findByStatus: vi.fn(async () => []),
        findByCanonicalKey: vi.fn(async () => []),
        updateStatus: vi.fn(async (_objectId, status, updatedAt) =>
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
        create: vi.fn(async (claim) => claim),
        createSync: vi.fn((claim) => claim),
        findById: vi.fn(async () => existing),
        findByWorkspaceId: vi.fn(async () => []),
        findByStatus: vi.fn(async () => []),
        findByCanonicalKey: vi.fn(async () => []),
        updateStatus: vi.fn(async (_objectId, status, updatedAt) =>
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
  it("rejects invalid lifecycle transitions", async () => {
    const existing = createClaimForm({ claim_status: ClaimLifecycleState.DRAFT });

    const { dependencies } = createDependencies({
      claimFormRepo: {
        create: vi.fn(async (claim) => claim),
        createSync: vi.fn((claim) => claim),
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
});
