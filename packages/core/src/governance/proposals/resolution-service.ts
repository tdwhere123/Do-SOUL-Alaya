import {
  ClaimLifecycleState,
  GovernanceResolutionPayloadSchema,
  ObjectLifecycleState,
  RESOLUTION_KIND_TO_EVENT_TYPE,
  SoulResolutionKind,
  TransitionCausedBy,
  type ClaimForm,
  type EventLogEntry,
  type EffectDecisionReceipt,
  type MemoryEntry,
} from "@do-soul/alaya-protocol";
import { CoreError } from "../../shared/errors.js";
import type { EventPublisherInput } from "../../runtime/event-publisher.js";
import { GovernedEffectAction } from "../effects/proof-effect-policy.js";
import {
  buildEffectAuditEventInput,
  decideClaimEffect,
  requireDeliveryAuthority,
  type ResolutionDeliveryAuthorityPort,
  type ResolutionEffectAuthorityPort
} from "./resolution-service-effects.js";
export type {
  ResolutionDeliveryAuthorityPort,
  ResolutionEffectAuthorityPort
} from "./resolution-service-effects.js";
import type {
  ResolveInput,
  ResolveOutcome,
  ResolutionServiceDependencies
} from "./resolution-service-types.js";
export type {
  ResolveInput,
  ResolveOutcome,
  ResolutionServiceClaimRepoPort,
  ResolutionServiceClaimServicePort,
  ResolutionServiceDependencies,
  ResolutionServiceMemoryRepoPort,
  ResolutionServiceMemoryServicePort
} from "./resolution-service-types.js";

export class ResolutionService {
  private readonly now: () => string;

  public constructor(private readonly deps: ResolutionServiceDependencies) {
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  public async resolve(input: ResolveInput): Promise<ResolveOutcome> {
    this.validateInput(input);
    await requireDeliveryAuthority(this.deps.deliveryAuthority, input);
    const resolvedAt = this.now();
    switch (input.resolution) {
      case SoulResolutionKind.CONFIRM:
        return await this.applyConfirm(input, resolvedAt);
      case SoulResolutionKind.REJECT:
        return await this.applyReject(input, resolvedAt);
      case SoulResolutionKind.CORRECT:
        return await this.applyCorrect(input, resolvedAt);
      case SoulResolutionKind.STALE:
        return await this.applyStale(input, resolvedAt);
      case SoulResolutionKind.DEFER:
        return await this.applyDefer(input, resolvedAt);
      case SoulResolutionKind.NOT_RELEVANT:
        return await this.applyNotRelevant(input, resolvedAt);
    }
  }

  // invariant: confirm activates a draft claim_form. The transition
  // draft → active is the L3 replacement for the retired
  // SynthesisCapsule.promotion path; the audit event records the
  // activated_claim_id so EventLog readers can correlate.
  // invariant: the claim_status mutation and the governance-resolution
  // audit event are appended in one SQLite transaction (composed through
  // claimService.transitionLifecycle additionalEventInputs). A crash can
  // no longer leave an ACTIVE claim with no resolution audit row.
  // see also: ClaimService.transitionLifecycle (lifecycle gate)
  private async applyConfirm(input: ResolveInput, effectiveAsOf: string): Promise<ResolveOutcome> {
    const claim = await this.requireDraftClaim(input);
    const decision = await this.decideEffect(input, GovernedEffectAction.ACTIVATE, effectiveAsOf);
    if (decision.decision !== "allow") {
      return await this.persistNonAllowDecision(input, decision);
    }
    const auditEventInput = this.buildAuditEventInput(input, effectiveAsOf, {
      activatedClaimId: claim.object_id
    });
    const auditEventsSink: EventLogEntry[] = [];
    const activated = await this.deps.claimService.transitionLifecycle(
      claim.object_id,
      ClaimLifecycleState.ACTIVE,
      input.reason ?? "soul_resolve_confirm",
      TransitionCausedBy.USER,
      {
        additionalEventInputs: [auditEventInput, buildEffectAuditEventInput(decision)],
        additionalEventsSink: auditEventsSink,
        effectDecisionReceipt: decision
      }
    );
    const entry = requireAuditEntry(auditEventsSink);
    return {
      resolution: input.resolution,
      status: "applied",
      auditEventType: entry.event_type,
      auditEventId: entry.event_id,
      activatedClaimId: activated.object_id,
      effectDecision: decision.decision
    };
  }

  private async requireDraftClaim(input: ResolveInput): Promise<Readonly<ClaimForm>> {
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
    return claim;
  }

  // invariant: reject archives the claim_form regardless of starting
  // state. Draft claims archive directly via the claim_form
  // transition matrix (draft -> archived); active / contested /
  // winner / superseded archive through the standard path. For
  // memory_entry targets the resolution emits the audit event only —
  // durable memory is not mutated by the reject path.
  // invariant: when reject archives a claim, the claim_status mutation
  // and the resolution audit event are appended in one SQLite
  // transaction. The audit-only branches (already-archived claim,
  // memory_entry target) publish the audit event standalone — no
  // governance mutation to pair it with.
  // see also: packages/protocol/src/soul/claim-form.ts claimTransitions
  private async applyReject(input: ResolveInput, effectiveAsOf: string): Promise<ResolveOutcome> {
    const claim = await this.deps.claimRepo.findById(input.targetObjectId);
    if (claim !== null && claim.workspace_id !== input.workspaceId) {
      throw new CoreError(
        "VALIDATION",
        `Claim form ${input.targetObjectId} is not in workspace ${input.workspaceId}`
      );
    }
    if (claim !== null && claim.claim_status !== ClaimLifecycleState.ARCHIVED) {
      return await this.applyClaimReject(input, claim, effectiveAsOf);
    }
    const entry = await this.emitAuditEvent(input, effectiveAsOf, {});
    return {
      resolution: input.resolution,
      status: "applied",
      auditEventType: entry.event_type,
      auditEventId: entry.event_id
    };
  }

  private async applyClaimReject(
    input: ResolveInput,
    claim: Readonly<ClaimForm>,
    effectiveAsOf: string
  ): Promise<ResolveOutcome> {
    const decision = isHardActiveClaim(claim)
      ? await this.decideEffect(input, GovernedEffectAction.REVOKE, effectiveAsOf)
      : undefined;
    if (decision !== undefined && decision.decision !== "allow") {
      return await this.persistNonAllowDecision(input, decision);
    }
    const auditEventInput = this.buildAuditEventInput(input, effectiveAsOf, {});
    const additionalEventInputs = decision === undefined
      ? [auditEventInput]
      : [auditEventInput, buildEffectAuditEventInput(decision)];
    const auditEventsSink: EventLogEntry[] = [];
    await this.deps.claimService.transitionLifecycle(
      claim.object_id,
      ClaimLifecycleState.ARCHIVED,
      input.reason ?? "soul_resolve_reject",
      TransitionCausedBy.USER,
      {
        additionalEventInputs,
        additionalEventsSink: auditEventsSink,
        effectDecisionReceipt: decision
      }
    );
    const entry = requireAuditEntry(auditEventsSink);
    return {
      resolution: input.resolution,
      status: "applied",
      auditEventType: entry.event_type,
      auditEventId: entry.event_id,
      effectDecision: decision?.decision
    };
  }

  // invariant: correction receipts and their payload commit through the proof-effect owner.
  private async applyCorrect(input: ResolveInput, effectiveAsOf: string): Promise<ResolveOutcome> {
    if (input.correction === undefined || input.correction.trim().length === 0) {
      throw new CoreError(
        "VALIDATION",
        "resolution=correct requires a non-empty correction"
      );
    }
    await this.requireTargetExists(input);
    const decision = await this.decideEffect(
      input,
      GovernedEffectAction.CORRECT,
      effectiveAsOf,
      input.correction
    );
    if (decision.decision !== "allow") {
      return await this.persistNonAllowDecision(input, decision);
    }
    const predecessor = decision.supporting_proof_witnesses.find(
      (witness) => witness.kind === "predecessor"
    );
    const successor = decision.supporting_proof_witnesses.find(
      (witness) => witness.kind === "successor"
    );
    if (predecessor === undefined || successor === undefined) {
      throw new CoreError("CONFLICT", "Correction effect lacks predecessor/successor receipts");
    }
    const entry = await this.deps.claimService.recordEffectDecision(
      decision,
      this.buildAuditEventInput(input, effectiveAsOf, {
        correction: input.correction,
        predecessorReceiptId: predecessor.receipt_id,
        successorReceiptId: successor.receipt_id
      })
    );
    return {
      resolution: input.resolution,
      status: "applied",
      auditEventType: entry.event_type,
      auditEventId: entry.event_id,
      effectDecision: decision.decision
    };
  }

  // invariant: stale transitions a memory_entry active → dormant.
  // see also: MemoryService.transitionLifecycle (lifecycle gate)
  private async applyStale(input: ResolveInput, resolvedAt: string): Promise<ResolveOutcome> {
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
    const entry = await this.emitAuditEvent(input, resolvedAt, {});
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
  private async applyDefer(input: ResolveInput, resolvedAt: string): Promise<ResolveOutcome> {
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
    const auditEventsSink: EventLogEntry[] = [];
    const obligation = await this.deps.deferredObligationService.create({
      kind: "evidence_refresh",
      description: input.reason ?? "soul_resolve_defer",
      sourceRunId: input.runId,
      workspaceId: input.workspaceId,
      targetEntityId: input.targetObjectId,
      expiresAt: input.deferUntil
    }, {
      buildAdditionalEventInputs: (created) => [this.buildAuditEventInput(input, resolvedAt, {
        obligationId: created.obligation_id
      })],
      additionalEventsSink: auditEventsSink
    });
    const entry = requireAuditEntry(auditEventsSink);
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
  private async applyNotRelevant(input: ResolveInput, resolvedAt: string): Promise<ResolveOutcome> {
    await this.requireTargetExists(input);
    const entry = await this.emitAuditEvent(input, resolvedAt, {});
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
      throw new CoreError("VALIDATION", "actor_id is required");
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

  // invariant: pure builder for the governance-resolution audit EventLog
  // input. Kept separate from the publish so confirm/reject can compose
  // this row into the claim lifecycle transaction (atomic audit), while
  // correct/stale/defer/not_relevant publish it directly.
  private buildAuditEventInput(
    input: ResolveInput,
    occurredAt: string,
    extras: Readonly<{
      readonly obligationId?: string;
      readonly activatedClaimId?: string;
      readonly correction?: string;
      readonly predecessorReceiptId?: string;
      readonly successorReceiptId?: string;
    }>
  ): EventPublisherInput {
    const eventType = RESOLUTION_KIND_TO_EVENT_TYPE[input.resolution];
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
      correction: extras.correction ?? null,
      obligation_id: extras.obligationId ?? null,
      activated_claim_id: extras.activatedClaimId ?? null,
      predecessor_receipt_id: extras.predecessorReceiptId ?? null,
      successor_receipt_id: extras.successorReceiptId ?? null,
      occurred_at: occurredAt
    });
    return {
      event_type: eventType,
      entity_type: "soul_resolution",
      entity_id: input.targetObjectId,
      workspace_id: input.workspaceId,
      run_id: input.runId,
      caused_by: input.agentTarget,
      payload_json: payload
    };
  }

  private async emitAuditEvent(
    input: ResolveInput,
    occurredAt: string,
    extras: Readonly<{
      readonly obligationId?: string;
      readonly activatedClaimId?: string;
    }>
  ): Promise<Readonly<EventLogEntry>> {
    return await this.deps.eventPublisher.publish(
      this.buildAuditEventInput(input, occurredAt, extras)
    );
  }

  private async decideEffect(
    input: ResolveInput,
    action: "activate" | "revoke" | "correct",
    effectiveAsOf: string,
    correction?: string
  ): Promise<EffectDecisionReceipt> {
    return await decideClaimEffect(
      { effectAuthority: this.deps.effectAuthority },
      input,
      action,
      effectiveAsOf,
      correction
    );
  }

  private async persistNonAllowDecision(
    input: ResolveInput,
    decision: EffectDecisionReceipt
  ): Promise<ResolveOutcome> {
    const entry = await this.deps.claimService.recordEffectDecision(
      decision,
      buildEffectAuditEventInput(decision)
    );
    return {
      resolution: input.resolution,
      status: "noop",
      auditEventType: entry.event_type,
      auditEventId: entry.event_id,
      effectDecision: decision.decision
    };
  }
}

function isHardActiveClaim(claim: Readonly<ClaimForm>): boolean {
  return claim.claim_status === ClaimLifecycleState.ACTIVE ||
    claim.claim_status === ClaimLifecycleState.CONTESTED ||
    claim.claim_status === ClaimLifecycleState.WINNER;
}

// invariant: a composed claim transition must yield exactly its one
// additional audit row in the sink. An empty sink means the claim service
// took a path that did not append the audit event atomically — surfacing
// it as an error is correct: a silently-skipped governance audit is the
// exact failure this fix exists to prevent.
function requireAuditEntry(sink: readonly EventLogEntry[]): Readonly<EventLogEntry> {
  const entry = sink[0];
  if (entry === undefined) {
    throw new CoreError(
      "CONFLICT",
      "Resolution audit event was not appended atomically with the claim transition"
    );
  }
  return entry;
}
