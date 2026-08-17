import { describe, expect, it, vi } from "vitest";
import {
  ClaimLifecycleState,
  GovernanceResolutionEventType,
  MemoryDimension,
  ObjectLifecycleState,
  PROOF_EFFECT_OPERATOR_ID,
  PROOF_EFFECT_OPERATOR_VERSION,
  ScopeClass,
  SoulResolutionKind,
  hashEffectGovernanceFrontier,
  type ClaimForm,
  type DeferredObligation,
  type EffectRequest,
  type EventLogEntry,
  type MemoryEntry
} from "@do-soul/alaya-protocol";
import {
  ResolutionService,
  type ResolutionServiceClaimRepoPort,
  type ResolutionServiceClaimServicePort,
  type ResolutionServiceMemoryRepoPort,
  type ResolutionServiceMemoryServicePort
} from "../../governance/proposals/resolution-service.js";
import { EventPublisher } from "../../runtime/event-publisher.js";
import type { DeferredObligationService } from "../../governance/policy/deferred-obligation-service.js";
import { buildEffectDecisionReceipt } from "../../governance/effects/proof-effect-policy.js";
import { fieldContractSha256 } from "../../shared/field-hash.js";
import { firstDefined } from "../helpers/defined.js";
const FIXED_NOW = "2026-05-17T00:00:00.000Z";
type EffectAuthorityInput = Readonly<{
  workspaceId: string;
  actorId: string;
  runId: string;
  deliveryId: string;
  targetObjectId: string;
  scope: string;
  effectiveAsOf: string;
  action: "activate" | "revoke" | "correct";
  correction?: string;
}>;

function effectRequest(input: EffectAuthorityInput): EffectRequest {
  const witnesses: EffectRequest["supporting_proof_witnesses"] = input.action === "correct"
    ? [
        { receipt_id: "predecessor-1", kind: "predecessor", authority_event_id: null,
          source_record_id: null, source_content_digest: null },
        { receipt_id: "successor-1", kind: "successor", authority_event_id: null,
          source_record_id: null, source_content_digest: null }
      ]
    : [];
  return {
    schema_version: 2,
    workspace_id: input.workspaceId,
    actor_id: input.actorId,
    run_id: input.runId,
    delivery_id: input.deliveryId,
    action: input.action,
    target: input.targetObjectId,
    scope: input.scope,
    effective_as_of: input.effectiveAsOf,
    supporting_receipt_ids: witnesses.map((witness) => witness.receipt_id),
    supporting_proof_witnesses: witnesses,
    governance_frontier: hashEffectGovernanceFrontier(witnesses, fieldContractSha256),
    policy_operator_id: PROOF_EFFECT_OPERATOR_ID,
    policy_operator_version: PROOF_EFFECT_OPERATOR_VERSION
  };
}
interface Harness {
  readonly service: ResolutionService;
  readonly claimRepo: ResolutionServiceClaimRepoPort & {
    readonly findById: ReturnType<typeof vi.fn>;
  };
  readonly memoryRepo: ResolutionServiceMemoryRepoPort & {
    readonly findById: ReturnType<typeof vi.fn>;
  };
  readonly claimService: ResolutionServiceClaimServicePort & {
    readonly transitionLifecycle: ReturnType<typeof vi.fn>;
  };
  readonly memoryService: ResolutionServiceMemoryServicePort & {
    readonly transitionLifecycle: ReturnType<typeof vi.fn>;
  };
  readonly deferredObligationService: Pick<DeferredObligationService, "create"> & {
    readonly create: ReturnType<typeof vi.fn>;
  };
  readonly deliveryAuthority: { readonly authorize: ReturnType<typeof vi.fn> };
  readonly effectAuthority: { readonly decide: ReturnType<typeof vi.fn> };
  readonly now: ReturnType<typeof vi.fn>;
  readonly published: Array<Omit<EventLogEntry, "event_id" | "created_at" | "revision">>;
}
function createHarness(): Harness {
  const published: Array<Omit<EventLogEntry, "event_id" | "created_at" | "revision">> = [];
  let counter = 0;
  const eventPublisher = {
    publish: vi.fn(async (input: Omit<EventLogEntry, "event_id" | "created_at" | "revision">) => {
      counter += 1;
      published.push(input);
      return {
        ...input,
        event_id: `evt-${counter}`,
        created_at: FIXED_NOW,
        revision: 0
      } satisfies EventLogEntry;
    })
  } as unknown as EventPublisher;
  const claimRepo = { findById: vi.fn(async (_id: string) => null as ClaimForm | null) };
  const memoryRepo = { findById: vi.fn(async (_id: string) => null as MemoryEntry | null) };
  const claimService = {
    // The mock honors the atomic-audit-composition contract: additional
    // event inputs are persisted (in the same logical transaction as the
    // claim mutation) and the persisted rows are pushed into the sink in
    // input order, exactly like ClaimService.transitionLifecycle does.
    transitionLifecycle: vi.fn(async (
      objectId: string,
      newState: ClaimForm["claim_status"],
      _reason: string,
      _causedBy: "user" | "system" | "review" | "deterministic_rule" | "auditor" | "bootstrap",
      options?: {
        readonly additionalEventInputs?: readonly Omit<
          EventLogEntry,
          "event_id" | "created_at" | "revision"
        >[];
        readonly additionalEventsSink?: EventLogEntry[];
      }
    ): Promise<Readonly<ClaimForm>> => {
      for (const eventInput of options?.additionalEventInputs ?? []) {
        counter += 1;
        published.push(eventInput);
        options?.additionalEventsSink?.push({
          ...eventInput,
          event_id: `evt-${counter}`,
          created_at: FIXED_NOW,
          revision: 0
        } satisfies EventLogEntry);
      }
      return buildClaim({ object_id: objectId, claim_status: newState });
    }),
    recordEffectDecision: vi.fn(async (
      _receipt: unknown,
      eventInput: Omit<EventLogEntry, "event_id" | "created_at" | "revision">
    ) => {
      counter += 1;
      published.push(eventInput);
      return { ...eventInput, event_id: `evt-${counter}`, created_at: FIXED_NOW, revision: 0 };
    })
  };
  const memoryService = {
    transitionLifecycle: vi.fn(async (
      objectId: string,
      nextState: MemoryEntry["lifecycle_state"],
      _reason: string,
      _causedBy: "user" | "system" | "review" | "deterministic_rule" | "auditor" | "bootstrap"
    ): Promise<Readonly<MemoryEntry>> =>
      buildMemory({ object_id: objectId, lifecycle_state: nextState }))
  };
  const deferredObligationService = {
    create: vi.fn(async (
      _input: unknown,
      options?: {
        readonly buildAdditionalEventInputs?: (
          obligation: Readonly<DeferredObligation>
        ) => readonly Omit<EventLogEntry, "event_id" | "created_at" | "revision">[];
        readonly additionalEventsSink?: EventLogEntry[];
      }
    ): Promise<Readonly<DeferredObligation>> => {
      const obligation = {
      obligation_id: "obligation-1",
      kind: "evidence_refresh",
      state: "pending",
      description: "test-defer",
      source_run_id: "run-1",
      workspace_id: "ws-1",
      target_entity_id: "claim-1",
      created_at: FIXED_NOW,
      expires_at: "2026-05-18T00:00:00.000Z"
      } satisfies DeferredObligation;
      for (const eventInput of options?.buildAdditionalEventInputs?.(obligation) ?? []) {
        counter += 1;
        published.push(eventInput);
        options?.additionalEventsSink?.push({
          ...eventInput,
          event_id: `evt-${counter}`,
          created_at: FIXED_NOW,
          revision: 0
        });
      }
      return obligation;
    })
  };
  const deliveryAuthority = {
    authorize: vi.fn(async () => ({ deliveredAt: FIXED_NOW }))
  };
  const effectAuthority = {
    decide: vi.fn(async (input: EffectAuthorityInput) =>
      buildEffectDecisionReceipt(effectRequest(input), "allow", FIXED_NOW, fieldContractSha256))
  };
  const now = vi.fn(() => FIXED_NOW);
  const service = new ResolutionService({
    eventPublisher,
    claimRepo,
    memoryRepo,
    claimService,
    memoryService,
    deferredObligationService,
    deliveryAuthority,
    effectAuthority,
    now
  });
  return {
    service,
    claimRepo,
    memoryRepo,
    claimService,
    memoryService,
    deferredObligationService,
    deliveryAuthority,
    effectAuthority,
    now,
    published
  };
}
function buildClaim(overrides: Partial<ClaimForm> = {}): Readonly<ClaimForm> {
  return {
    object_id: overrides.object_id ?? "claim-1",
    object_kind: "claim_form",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: FIXED_NOW,
    updated_at: FIXED_NOW,
    created_by: "test",
    governance_subject: {
      domain: "test",
      qualifiers: {},
      canonical_key: "test:test"
    },
    claim_kind: "preference",
    scope_class: ScopeClass.PROJECT,
    enforcement_level: "advisory",
    origin_tier: "consolidated",
    precedence_basis: "evidence_strength",
    proposition_digest: "digest",
    evidence_refs: [],
    source_object_refs: [],
    workspace_id: "ws-1",
    claim_status: ClaimLifecycleState.DRAFT,
    ...overrides
  } as ClaimForm;
}
function buildMemory(overrides: Partial<MemoryEntry> = {}): Readonly<MemoryEntry> {
  return {
    object_id: overrides.object_id ?? "mem-1",
    object_kind: "memory_entry",
    schema_version: 1,
    created_at: FIXED_NOW,
    updated_at: FIXED_NOW,
    created_by: "test",
    lifecycle_state: ObjectLifecycleState.ACTIVE,
    dimension: MemoryDimension.PROCEDURE,
    source_kind: "user",
    formation_kind: "explicit",
    scope_class: ScopeClass.PROJECT,
    content: "content",
    domain_tags: [],
    evidence_refs: [],
    workspace_id: "ws-1",
    run_id: "run-1",
    surface_id: null,
    storage_tier: "hot",
    activation_score: 0.5,
    retention_score: 0.5,
    manifestation_state: "excerpt",
    retention_state: "working",
    decay_profile: "stable",
    confidence: 0.9,
    last_used_at: null,
    last_hit_at: null,
    reinforcement_count: 0,
    contradiction_count: 0,
    superseded_by: null,
    ...overrides
  } as MemoryEntry;
}
const baseInput = {
  targetObjectId: "claim-1",
  workspaceId: "ws-1",
  runId: "run-1",
  agentTarget: "codex",
  deliveryId: "delivery-1"
};

describe("ResolutionService dispatch", () => {
  it("rejects a direct service call when delivery authority does not match", async () => {
    const harness = createHarness();
    harness.deliveryAuthority.authorize.mockResolvedValueOnce(null);
    await expect(harness.service.resolve({
      ...baseInput,
      resolution: SoulResolutionKind.CONFIRM
    })).rejects.toThrow(/Delivery authority/);
    expect(harness.claimRepo.findById).not.toHaveBeenCalled();
    expect(harness.claimService.transitionLifecycle).not.toHaveBeenCalled();
    expect(harness.deliveryAuthority.authorize).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      actorId: "codex",
      runId: "run-1",
      deliveryId: "delivery-1",
      targetObjectId: "claim-1"
    });
  });

  it("uses the single resolution operation time instead of delivery time", async () => {
    const harness = createHarness();
    harness.now.mockReset()
      .mockReturnValueOnce(FIXED_NOW)
      .mockReturnValue("2026-05-17T00:00:01.000Z");
    harness.deliveryAuthority.authorize.mockResolvedValue({
      deliveredAt: "2026-05-16T12:00:00.000Z"
    });
    harness.claimRepo.findById.mockResolvedValue(buildClaim());

    await harness.service.resolve({ ...baseInput, resolution: SoulResolutionKind.CONFIRM });

    expect(harness.effectAuthority.decide).toHaveBeenCalledWith(expect.objectContaining({
      effectiveAsOf: FIXED_NOW
    }));
    expect(firstDefined(harness.published).payload_json).toMatchObject({
      occurred_at: FIXED_NOW
    });
  });

  it("confirm activates a draft claim and emits the confirm event", async () => {
    const harness = createHarness();
    harness.claimRepo.findById.mockResolvedValueOnce(buildClaim({ claim_status: ClaimLifecycleState.DRAFT }));
    const outcome = await harness.service.resolve({
      ...baseInput,
      resolution: SoulResolutionKind.CONFIRM
    });
    expect(outcome.status).toBe("applied");
    expect(outcome.activatedClaimId).toBe("claim-1");
    expect(outcome.auditEventType).toBe(
      GovernanceResolutionEventType.SOUL_RESOLUTION_CONFIRM_APPLIED
    );
    // The resolution audit event is composed into the claim transition so
    // the claim_status mutation and the audit row append atomically.
    expect(harness.claimService.transitionLifecycle).toHaveBeenCalledWith(
      "claim-1",
      ClaimLifecycleState.ACTIVE,
      expect.any(String),
      "user",
      expect.objectContaining({
        additionalEventInputs: [
          expect.objectContaining({
            event_type: GovernanceResolutionEventType.SOUL_RESOLUTION_CONFIRM_APPLIED
          }),
          expect.objectContaining({ event_type: "soul.field.effect.decided" })
        ],
        additionalEventsSink: expect.any(Array),
        effectDecisionReceipt: expect.objectContaining({ decision: "allow" })
      })
    );
    expect(harness.published).toHaveLength(2);
    expect(firstDefined(harness.published).event_type).toBe(
      GovernanceResolutionEventType.SOUL_RESOLUTION_CONFIRM_APPLIED
    );
    expect(firstDefined(harness.published).payload_json).toMatchObject({
      target_object_id: "claim-1",
      resolution: "confirm",
      activated_claim_id: "claim-1"
    });
  });

  it.each(["deny", "defer", "require_confirmation"] as const)(
    "persists and audits %s without changing the claim",
    async (policyDecision) => {
      const harness = createHarness();
      harness.claimRepo.findById.mockResolvedValueOnce(buildClaim());
      harness.effectAuthority.decide.mockImplementationOnce(async (input: EffectAuthorityInput) =>
        buildEffectDecisionReceipt(
          effectRequest(input),
          policyDecision,
          FIXED_NOW,
          fieldContractSha256
        ));

      const outcome = await harness.service.resolve({
        ...baseInput,
        resolution: SoulResolutionKind.CONFIRM
      });

      expect(outcome).toMatchObject({ status: "noop", effectDecision: policyDecision });
      expect(harness.claimService.transitionLifecycle).not.toHaveBeenCalled();
      expect(harness.claimService.recordEffectDecision).toHaveBeenCalledWith(
        expect.objectContaining({ decision: policyDecision }),
        expect.objectContaining({ event_type: "soul.field.effect.decided" })
      );
      expect(harness.published).toHaveLength(1);
    }
  );

  it("reject archives a non-draft claim and emits the reject event", async () => {
    const harness = createHarness();
    harness.claimRepo.findById.mockResolvedValueOnce(
      buildClaim({ claim_status: ClaimLifecycleState.ACTIVE })
    );
    const outcome = await harness.service.resolve({
      ...baseInput,
      resolution: SoulResolutionKind.REJECT
    });
    expect(outcome.status).toBe("applied");
    expect(outcome.auditEventType).toBe(
      GovernanceResolutionEventType.SOUL_RESOLUTION_REJECT_APPLIED
    );
    expect(harness.claimService.transitionLifecycle).toHaveBeenCalledWith(
      "claim-1",
      ClaimLifecycleState.ARCHIVED,
      expect.any(String),
      "user",
      expect.objectContaining({
        additionalEventInputs: [
          expect.objectContaining({
            event_type: GovernanceResolutionEventType.SOUL_RESOLUTION_REJECT_APPLIED
          }),
          expect.objectContaining({ event_type: "soul.field.effect.decided" })
        ],
        additionalEventsSink: expect.any(Array),
        effectDecisionReceipt: expect.objectContaining({ decision: "allow" })
      })
    );
    expect(firstDefined(harness.published).event_type).toBe(
      GovernanceResolutionEventType.SOUL_RESOLUTION_REJECT_APPLIED
    );
  });

  // invariant: agents resolving a staged warning's reject_pending
  // option (which mapResolutionOptionToKind sends as SoulResolutionKind.REJECT)
  // must be able to archive a DRAFT claim directly. Without the
  // draft -> archived transition, the advertised resolution would
  // throw CONFLICT and the agent has no way to decline a pending claim.
  it("reject archives a DRAFT claim directly", async () => {
    const harness = createHarness();
    harness.claimRepo.findById.mockResolvedValueOnce(
      buildClaim({ claim_status: ClaimLifecycleState.DRAFT })
    );
    const outcome = await harness.service.resolve({
      ...baseInput,
      resolution: SoulResolutionKind.REJECT
    });
    expect(outcome.status).toBe("applied");
    expect(outcome.auditEventType).toBe(
      GovernanceResolutionEventType.SOUL_RESOLUTION_REJECT_APPLIED
    );
    expect(harness.claimService.transitionLifecycle).toHaveBeenCalledWith(
      "claim-1",
      ClaimLifecycleState.ARCHIVED,
      expect.any(String),
      "user",
      expect.objectContaining({
        additionalEventInputs: [
          expect.objectContaining({
            event_type: GovernanceResolutionEventType.SOUL_RESOLUTION_REJECT_APPLIED
          })
        ],
        additionalEventsSink: expect.any(Array)
      })
    );
  });

  it("correct requires a non-empty correction prose and emits the correct event", async () => {
    const harness = createHarness();
    harness.claimRepo.findById.mockResolvedValue(
      buildClaim({ claim_status: ClaimLifecycleState.ACTIVE })
    );
    await expect(
      harness.service.resolve({
        ...baseInput,
        resolution: SoulResolutionKind.CORRECT
      })
    ).rejects.toThrow(/correction/);
    const outcome = await harness.service.resolve({
      ...baseInput,
      resolution: SoulResolutionKind.CORRECT,
      correction: "the canonical key should be foo"
    });
    expect(outcome.status).toBe("applied");
    expect(outcome.auditEventType).toBe(
      GovernanceResolutionEventType.SOUL_RESOLUTION_CORRECT_APPLIED
    );
    expect(harness.claimService.transitionLifecycle).not.toHaveBeenCalled();
    expect(harness.claimService.recordEffectDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "correct",
        supporting_receipt_ids: ["predecessor-1", "successor-1"]
      }),
      expect.objectContaining({
        payload_json: expect.objectContaining({
          correction: "the canonical key should be foo",
          predecessor_receipt_id: "predecessor-1",
          successor_receipt_id: "successor-1"
        })
      })
    );
  });

  it("stale transitions an active memory_entry to dormant", async () => {
    const harness = createHarness();
    harness.memoryRepo.findById.mockResolvedValueOnce(
      buildMemory({ object_id: "mem-1", lifecycle_state: ObjectLifecycleState.ACTIVE })
    );
    const outcome = await harness.service.resolve({
      ...baseInput,
      targetObjectId: "mem-1",
      resolution: SoulResolutionKind.STALE
    });
    expect(outcome.status).toBe("applied");
    expect(outcome.auditEventType).toBe(
      GovernanceResolutionEventType.SOUL_RESOLUTION_STALE_APPLIED
    );
    expect(harness.memoryService.transitionLifecycle).toHaveBeenCalledWith(
      "mem-1",
      ObjectLifecycleState.DORMANT,
      expect.any(String),
      "user"
    );
  });

  it("defer creates a DeferredObligation and emits the defer event", async () => {
    const harness = createHarness();
    harness.claimRepo.findById.mockResolvedValueOnce(buildClaim({ claim_status: ClaimLifecycleState.ACTIVE }));
    const outcome = await harness.service.resolve({
      ...baseInput,
      resolution: SoulResolutionKind.DEFER,
      deferUntil: "2026-05-18T00:00:00.000Z",
      reason: "need more evidence"
    });
    expect(outcome.status).toBe("deferred");
    expect(outcome.obligationId).toBe("obligation-1");
    expect(outcome.auditEventType).toBe(
      GovernanceResolutionEventType.SOUL_RESOLUTION_DEFER_APPLIED
    );
    expect(harness.deferredObligationService.create).toHaveBeenCalledWith(
      {
        kind: "evidence_refresh",
        description: "need more evidence",
        sourceRunId: "run-1",
        workspaceId: "ws-1",
        targetEntityId: "claim-1",
        expiresAt: "2026-05-18T00:00:00.000Z"
      },
      expect.objectContaining({
        buildAdditionalEventInputs: expect.any(Function),
        additionalEventsSink: expect.any(Array)
      })
    );
    expect(firstDefined(harness.published).payload_json).toMatchObject({
      resolution: "defer",
      obligation_id: "obligation-1"
    });
  });

  it("defer requires defer_until", async () => {
    const harness = createHarness();
    await expect(
      harness.service.resolve({
        ...baseInput,
        resolution: SoulResolutionKind.DEFER
      })
    ).rejects.toThrow(/defer_until/);
  });

  it("not_relevant emits the dismissal event without lifecycle changes", async () => {
    const harness = createHarness();
    harness.claimRepo.findById.mockResolvedValueOnce(
      buildClaim({ claim_status: ClaimLifecycleState.ACTIVE })
    );
    const outcome = await harness.service.resolve({
      ...baseInput,
      resolution: SoulResolutionKind.NOT_RELEVANT
    });
    expect(outcome.status).toBe("noop");
    expect(outcome.auditEventType).toBe(
      GovernanceResolutionEventType.SOUL_RESOLUTION_NOT_RELEVANT_APPLIED
    );
    expect(harness.claimService.transitionLifecycle).not.toHaveBeenCalled();
    expect(harness.memoryService.transitionLifecycle).not.toHaveBeenCalled();
  });

  it("rejects workspace-mismatched targets", async () => {
    const harness = createHarness();
    harness.claimRepo.findById.mockResolvedValueOnce(
      buildClaim({ workspace_id: "other-ws", claim_status: ClaimLifecycleState.DRAFT })
    );
    await expect(
      harness.service.resolve({
        ...baseInput,
        resolution: SoulResolutionKind.CONFIRM
      })
    ).rejects.toThrow(/workspace/);
  });

  it("confirm rejects when the claim is not in draft", async () => {
    const harness = createHarness();
    harness.claimRepo.findById.mockResolvedValueOnce(
      buildClaim({ claim_status: ClaimLifecycleState.ACTIVE })
    );
    await expect(
      harness.service.resolve({
        ...baseInput,
        resolution: SoulResolutionKind.CONFIRM
      })
    ).rejects.toThrow(/draft/);
  });
});
