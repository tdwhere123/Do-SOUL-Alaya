import {
  ClaimLifecycleState,
  GovernanceResolutionPayloadSchema,
  ObjectLifecycleState,
  RESOLUTION_KIND_TO_EVENT_TYPE,
  SoulResolutionKind,
  TransitionCausedBy,
  type ClaimForm,
  type EventLogEntry,
  type GovernanceResolutionPolicyClassification,
  type MemoryEntry,
  type SoulResolutionKind as SoulResolutionKindType
} from "@do-soul/alaya-protocol";
import { CoreError } from "./errors.js";
import type { EventPublisher } from "./event-publisher.js";
import type { DeferredObligationService } from "./deferred-obligation-service.js";

// invariant: producer-side input shape. workspace_id / run_id /
// agent_target / delivery_id are bound from the trusted MCP call
// context before calling resolve.
// see also: apps/core-daemon/src/mcp-memory-resolve-handler.ts
//   (binding site)
export interface ResolveInput {
  readonly targetObjectId: string;
  readonly resolution: SoulResolutionKindType;
  readonly workspaceId: string;
  readonly runId: string | null;
  readonly agentTarget: string;
  readonly deliveryId: string;
  readonly policy?: string;
  readonly policyClassification?: GovernanceResolutionPolicyClassification;
  readonly correction?: string;
  readonly reason?: string;
  readonly deferUntil?: string;
}

export interface ResolveOutcome {
  readonly resolution: SoulResolutionKindType;
  readonly status: "applied" | "deferred" | "noop";
  readonly auditEventType: string;
  readonly auditEventId: string;
  readonly obligationId?: string;
  readonly activatedClaimId?: string;
}

// invariant: claim-form repository slice the dispatcher needs to look
// up a draft claim for `confirm` and to detect whether a target is a
// claim_form at all.
export interface ResolutionServiceClaimRepoPort {
  findById(objectId: string): Promise<Readonly<ClaimForm> | null>;
}

export interface ResolutionServiceMemoryRepoPort {
  findById(objectId: string): Promise<Readonly<MemoryEntry> | null>;
}

export interface ResolutionServiceClaimServicePort {
  transitionLifecycle(
    objectId: string,
    newState: ClaimForm["claim_status"],
    reason: string,
    causedBy: typeof TransitionCausedBy[keyof typeof TransitionCausedBy]
  ): Promise<Readonly<ClaimForm>>;
}

export interface ResolutionServiceMemoryServicePort {
  transitionLifecycle(
    objectId: string,
    nextState: MemoryEntry["lifecycle_state"],
    reason: string,
    causedBy: typeof TransitionCausedBy[keyof typeof TransitionCausedBy]
  ): Promise<Readonly<MemoryEntry>>;
}

export interface ResolutionServiceDependencies {
  readonly eventPublisher: EventPublisher;
  readonly claimRepo: ResolutionServiceClaimRepoPort;
  readonly memoryRepo: ResolutionServiceMemoryRepoPort;
  readonly claimService: ResolutionServiceClaimServicePort;
  readonly memoryService: ResolutionServiceMemoryServicePort;
  readonly deferredObligationService: Pick<DeferredObligationService, "create">;
  readonly now?: () => string;
}

export class ResolutionService {
  private readonly now: () => string;

  public constructor(private readonly deps: ResolutionServiceDependencies) {
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  public async resolve(input: ResolveInput): Promise<ResolveOutcome> {
    this.validateInput(input);
    switch (input.resolution) {
      case SoulResolutionKind.CONFIRM:
        return await this.applyConfirm(input);
      case SoulResolutionKind.REJECT:
        return await this.applyReject(input);
      case SoulResolutionKind.CORRECT:
        return await this.applyCorrect(input);
      case SoulResolutionKind.STALE:
        return await this.applyStale(input);
      case SoulResolutionKind.DEFER:
        return await this.applyDefer(input);
      case SoulResolutionKind.NOT_RELEVANT:
        return await this.applyNotRelevant(input);
    }
  }

  // invariant: confirm activates a draft claim_form. The transition
  // draft → active is the L3 replacement for the retired
  // SynthesisCapsule.promotion path; the audit event records the
  // activated_claim_id so EventLog readers can correlate.
  // see also: ClaimService.transitionLifecycle (lifecycle gate)
  private async applyConfirm(input: ResolveInput): Promise<ResolveOutcome> {
    const claim = await this.deps.claimRepo.findById(input.targetObjectId);
    if (claim === null) {
      throw new CoreError(
        "NOT_FOUND",
        `Claim form ${input.targetObjectId} not found for resolution=confirm`
      );
    }
    if (claim.workspace_id !== input.workspaceId) {
      throw new CoreError(
        "VALIDATION",
        `Claim form ${input.targetObjectId} is not in workspace ${input.workspaceId}`
      );
    }
    if (claim.claim_status !== ClaimLifecycleState.DRAFT) {
      throw new CoreError(
        "CONFLICT",
        `Claim form ${input.targetObjectId} is not in draft (current: ${claim.claim_status})`
      );
    }
    const activated = await this.deps.claimService.transitionLifecycle(
      claim.object_id,
      ClaimLifecycleState.ACTIVE,
      input.reason ?? "soul_resolve_confirm",
      TransitionCausedBy.USER
    );
    const entry = await this.emitAuditEvent(input, {
      activatedClaimId: activated.object_id
    });
    return {
      resolution: input.resolution,
      status: "applied",
      auditEventType: entry.event_type,
      auditEventId: entry.event_id,
      activatedClaimId: activated.object_id
    };
  }

  // invariant: reject archives the claim_form regardless of starting
  // state. Draft claims archive directly via the claim_form
  // transition matrix (draft -> archived); active / contested /
  // winner / superseded archive through the standard path. For
  // memory_entry targets the resolution emits the audit event only —
  // durable memory is not mutated by the reject path.
  // see also: packages/protocol/src/soul/claim-form.ts claimTransitions
  private async applyReject(input: ResolveInput): Promise<ResolveOutcome> {
    const claim = await this.deps.claimRepo.findById(input.targetObjectId);
    if (claim !== null) {
      if (claim.workspace_id !== input.workspaceId) {
        throw new CoreError(
          "VALIDATION",
          `Claim form ${input.targetObjectId} is not in workspace ${input.workspaceId}`
        );
      }
      if (claim.claim_status !== ClaimLifecycleState.ARCHIVED) {
        await this.deps.claimService.transitionLifecycle(
          claim.object_id,
          ClaimLifecycleState.ARCHIVED,
          input.reason ?? "soul_resolve_reject",
          TransitionCausedBy.USER
        );
      }
    }
    const entry = await this.emitAuditEvent(input, {});
    return {
      resolution: input.resolution,
      status: "applied",
      auditEventType: entry.event_type,
      auditEventId: entry.event_id
    };
  }

  // invariant: correct emits the audit event with the agent-supplied
  // correction prose. Downstream consumers (Inspector, materialization)
  // pick the corrected proposition up via the audit row; the resolve
  // surface itself does not create a new claim_form (that path goes
  // through soul.emit_candidate_signal + soul.propose_memory_update).
  private async applyCorrect(input: ResolveInput): Promise<ResolveOutcome> {
    if (input.correction === undefined || input.correction.trim().length === 0) {
      throw new CoreError(
        "VALIDATION",
        "resolution=correct requires a non-empty correction"
      );
    }
    await this.requireTargetExists(input);
    const entry = await this.emitAuditEvent(input, {});
    return {
      resolution: input.resolution,
      status: "applied",
      auditEventType: entry.event_type,
      auditEventId: entry.event_id
    };
  }

  // invariant: stale transitions a memory_entry active → dormant.
  // see also: MemoryService.transitionLifecycle (lifecycle gate)
  private async applyStale(input: ResolveInput): Promise<ResolveOutcome> {
    const memory = await this.deps.memoryRepo.findById(input.targetObjectId);
    if (memory === null) {
      throw new CoreError(
        "NOT_FOUND",
        `Memory entry ${input.targetObjectId} not found for resolution=stale`
      );
    }
    if (memory.workspace_id !== input.workspaceId) {
      throw new CoreError(
        "VALIDATION",
        `Memory entry ${input.targetObjectId} is not in workspace ${input.workspaceId}`
      );
    }
    if (memory.lifecycle_state === ObjectLifecycleState.ACTIVE) {
      await this.deps.memoryService.transitionLifecycle(
        memory.object_id,
        ObjectLifecycleState.DORMANT,
        input.reason ?? "soul_resolve_stale",
        TransitionCausedBy.USER
      );
    }
    const entry = await this.emitAuditEvent(input, {});
    return {
      resolution: input.resolution,
      status: "applied",
      auditEventType: entry.event_type,
      auditEventId: entry.event_id
    };
  }

  // invariant: defer creates a DeferredObligation kind=evidence_refresh
  // bound to the target entity. The obligation_id is echoed back so
  // the caller can fulfil / expire it through DeferredObligationService.
  private async applyDefer(input: ResolveInput): Promise<ResolveOutcome> {
    if (input.deferUntil === undefined || input.deferUntil.trim().length === 0) {
      throw new CoreError(
        "VALIDATION",
        "resolution=defer requires a defer_until ISO datetime"
      );
    }
    if (input.runId === null) {
      throw new CoreError(
        "VALIDATION",
        "resolution=defer requires a bound run_id on the MCP call context"
      );
    }
    await this.requireTargetExists(input);
    const obligation = await this.deps.deferredObligationService.create({
      kind: "evidence_refresh",
      description: input.reason ?? "soul_resolve_defer",
      sourceRunId: input.runId,
      workspaceId: input.workspaceId,
      targetEntityId: input.targetObjectId,
      expiresAt: input.deferUntil
    });
    const entry = await this.emitAuditEvent(input, {
      obligationId: obligation.obligation_id
    });
    return {
      resolution: input.resolution,
      status: "deferred",
      auditEventType: entry.event_type,
      auditEventId: entry.event_id,
      obligationId: obligation.obligation_id
    };
  }

  // invariant: not_relevant is the dismissal path. Audit event records
  // the dismissal so trust-state consumers see the agent's decision,
  // but the target object lifecycle is unchanged.
  private async applyNotRelevant(input: ResolveInput): Promise<ResolveOutcome> {
    await this.requireTargetExists(input);
    const entry = await this.emitAuditEvent(input, {});
    return {
      resolution: input.resolution,
      status: "noop",
      auditEventType: entry.event_type,
      auditEventId: entry.event_id
    };
  }

  private validateInput(input: ResolveInput): void {
    if (input.targetObjectId.trim().length === 0) {
      throw new CoreError("VALIDATION", "target_object_id is required");
    }
    if (input.deliveryId.trim().length === 0) {
      throw new CoreError("VALIDATION", "delivery_id is required");
    }
    if (input.workspaceId.trim().length === 0) {
      throw new CoreError("VALIDATION", "workspace_id is required");
    }
    if (input.agentTarget.trim().length === 0) {
      throw new CoreError("VALIDATION", "agent_target is required");
    }
  }

  private async requireTargetExists(input: ResolveInput): Promise<void> {
    const claim = await this.deps.claimRepo.findById(input.targetObjectId);
    if (claim !== null) {
      if (claim.workspace_id !== input.workspaceId) {
        throw new CoreError(
          "VALIDATION",
          `Claim form ${input.targetObjectId} is not in workspace ${input.workspaceId}`
        );
      }
      return;
    }
    const memory = await this.deps.memoryRepo.findById(input.targetObjectId);
    if (memory === null) {
      throw new CoreError(
        "NOT_FOUND",
        `Target object ${input.targetObjectId} not found`
      );
    }
    if (memory.workspace_id !== input.workspaceId) {
      throw new CoreError(
        "VALIDATION",
        `Target object ${input.targetObjectId} is not in workspace ${input.workspaceId}`
      );
    }
  }

  private async emitAuditEvent(
    input: ResolveInput,
    extras: Readonly<{
      readonly obligationId?: string;
      readonly activatedClaimId?: string;
    }>
  ): Promise<Readonly<EventLogEntry>> {
    const eventType = RESOLUTION_KIND_TO_EVENT_TYPE[input.resolution];
    const occurredAt = this.now();
    const payload = GovernanceResolutionPayloadSchema.parse({
      target_object_id: input.targetObjectId,
      resolution: input.resolution,
      workspace_id: input.workspaceId,
      run_id: input.runId,
      agent_target: input.agentTarget,
      delivery_id: input.deliveryId,
      policy: input.policy ?? null,
      policy_classification: input.policyClassification ?? null,
      reason: input.reason ?? null,
      obligation_id: extras.obligationId ?? null,
      activated_claim_id: extras.activatedClaimId ?? null,
      occurred_at: occurredAt
    });
    return await this.deps.eventPublisher.publish({
      event_type: eventType,
      entity_type: "soul_resolution",
      entity_id: input.targetObjectId,
      workspace_id: input.workspaceId,
      run_id: input.runId,
      caused_by: input.agentTarget,
      payload_json: payload
    });
  }
}
