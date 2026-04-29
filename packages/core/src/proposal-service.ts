import { randomUUID } from "node:crypto";
import {
  ClaimLifecycleState,
  DYNAMICS_CONSTANTS,
  Phase1BEventType,
  PromotionState,
  ProposalOptionKind,
  ProposalResolutionState,
  ProposalSchema,
  RetentionPolicy,
  SoulProposalCreatedPayloadSchema,
  SoulProposalResolvedPayloadSchema,
  SoulReviewCompletedPayloadSchema,
  SoulReviewCreatedPayloadSchema,
  TransitionCausedBy,
  type ClaimForm,
  type EventLogEntry,
  type Proposal,
  type ProposalResolutionState as ProposalResolutionStateType,
  type SynthesisCapsule
} from "@do-soul/alaya-protocol";
import type { KarmaEvent } from "@do-soul/alaya-protocol";
import type { KarmaEventStore } from "./karma-event-store.js";
import { CoreError } from "./errors.js";
import { parseNonEmptyString } from "./shared/validators.js";

export interface ReviewAction {
  readonly action: "accepted" | "rejected";
  readonly note: string | null;
  readonly reviewed_by: string;
  readonly reviewed_at: string;
}

export interface ProposalServiceEventLogRepoPort {
  append(event: Omit<EventLogEntry, "event_id" | "created_at">): Promise<EventLogEntry>;
  queryByEntity(entityType: string, entityId: string): Promise<readonly EventLogEntry[]>;
}

export interface ProposalServiceProposalRepoPort {
  create(input: {
    readonly proposal: Proposal;
    readonly workspace_id: string;
    readonly run_id: string | null;
  }): Promise<Readonly<Proposal>>;
  findById(proposalId: string): Promise<Readonly<Proposal> | null>;
  findByWorkspaceId(workspaceId: string): Promise<readonly Readonly<Proposal>[]>;
  findPending(workspaceId: string): Promise<readonly Readonly<Proposal>[]>;
  updateResolution(
    proposalId: string,
    state: ProposalResolutionStateType,
    updatedAt: string
  ): Promise<Readonly<Proposal>>;
}

export interface ProposalServiceClaimServicePort {
  findById(objectId: string): Promise<Readonly<ClaimForm> | null>;
  transitionLifecycle(
    objectId: string,
    newState: ClaimLifecycleState,
    reason: string,
    causedBy: TransitionCausedBy,
    options?: {
      readonly deferredNotificationEvents?: EventLogEntry[];
    }
  ): Promise<Readonly<ClaimForm>>;
}

export interface ProposalServiceSynthesisServicePort {
  findById(objectId: string): Promise<Readonly<SynthesisCapsule> | null>;
  resolvePromotionDecision(
    objectId: string,
    nextState: Extract<SynthesisCapsule["promotion_state"], "promoted" | "rejected">,
    reason: string,
    causedBy: TransitionCausedBy,
    options?: {
      readonly cooldownUntil?: string | null;
      // When provided, runtime notification is deferred: the event is pushed here
      // instead of being notified immediately. Callers must preserve order.
      readonly deferredNotificationEvents?: EventLogEntry[];
    }
  ): Promise<Readonly<SynthesisCapsule>>;
}

export interface ProposalRuntimeNotifier {
  notifyEntry(entry: EventLogEntry): void | Promise<void>;
}

export interface DynamicsServiceProcessPort {
  processKarmaEvent(event: KarmaEvent): Promise<void>;
}

export interface ProposalServiceWarnPort {
  warn(message: string, meta: Record<string, unknown>): void;
}

export interface ProposalServiceDependencies {
  readonly proposalRepo: ProposalServiceProposalRepoPort;
  readonly claimService: ProposalServiceClaimServicePort;
  readonly synthesisService: ProposalServiceSynthesisServicePort;
  readonly eventLogRepo: ProposalServiceEventLogRepoPort;
  readonly karmaEventStore: KarmaEventStore;
  readonly dynamicsService?: DynamicsServiceProcessPort;
  readonly warn?: ProposalServiceWarnPort;
  readonly runtimeNotifier: ProposalRuntimeNotifier;
  readonly generateObjectId?: () => string;
  readonly now?: () => string;
}

interface ReviewContext {
  readonly proposal: Readonly<Proposal>;
  readonly synthesis: Readonly<SynthesisCapsule>;
  readonly claim: Readonly<ClaimForm>;
}

export class ProposalService {
  private readonly generateObjectId: () => string;
  private readonly now: () => string;
  private readonly warn: ProposalServiceWarnPort;

  public constructor(private readonly dependencies: ProposalServiceDependencies) {
    this.generateObjectId = dependencies.generateObjectId ?? (() => randomUUID());
    this.now = dependencies.now ?? (() => new Date().toISOString());
    this.warn =
      dependencies.warn ??
      Object.freeze({
        warn: () => {
          // intentionally noop when logger is not injected
        }
      });
  }

  public async createFromSynthesisPromotion(
    synthesisId: string,
    claimDraftId: string
  ): Promise<Readonly<Proposal>> {
    const parsedSynthesisId = parseNonEmptyString(synthesisId, "synthesisId");
    const parsedClaimDraftId = parseNonEmptyString(claimDraftId, "claimDraftId");

    const synthesis = await this.dependencies.synthesisService.findById(parsedSynthesisId);

    if (synthesis === null) {
      throw new CoreError("NOT_FOUND", "Synthesis capsule not found");
    }

    if (synthesis.promotion_state !== PromotionState.CANDIDATE) {
      throw new CoreError(
        "VALIDATION",
        `Synthesis capsule must be in candidate state, got ${synthesis.promotion_state}`
      );
    }

    const claim = await this.dependencies.claimService.findById(parsedClaimDraftId);

    if (claim === null) {
      throw new CoreError("NOT_FOUND", "Claim form not found");
    }

    ensureDraftClaim(claim);
    ensureSharedWorkspace(synthesis.workspace_id, claim.workspace_id);

    const timestamp = this.now();
    const proposalId = this.generateObjectId();
    const proposal = parseProposal({
      runtime_id: proposalId,
      object_kind: "proposal",
      task_surface_ref: null,
      expires_at: null,
      derived_from: synthesis.object_id,
      retention_policy: RetentionPolicy.SESSION_ONLY,
      proposal_id: proposalId,
      dossier_ref: null,
      recommended_option_id: claim.object_id,
      proposal_options: [
        {
          option_id: claim.object_id,
          option_kind: ProposalOptionKind.REQUEST_CONFIRMATION,
          preserves_protected_constraints: true,
          dropped_candidates: [],
          unresolved_after_apply: [],
          requires_confirmation: true
        }
      ],
      resolution_state: ProposalResolutionState.PENDING,
      last_updated_at: timestamp
    });

    ensurePhase1BProposal(proposal);

    const revision = await this.getNextRevision("proposal", proposal.proposal_id);
    const event = await this.dependencies.eventLogRepo.append({
      event_type: Phase1BEventType.SOUL_PROPOSAL_CREATED,
      entity_type: "proposal",
      entity_id: proposal.proposal_id,
      workspace_id: synthesis.workspace_id,
      run_id: synthesis.run_id,
      caused_by: TransitionCausedBy.SYSTEM,
      revision,
      payload_json: SoulProposalCreatedPayloadSchema.parse({
        object_id: proposal.runtime_id,
        object_kind: proposal.object_kind,
        workspace_id: synthesis.workspace_id,
        run_id: synthesis.run_id
      })
    });

    const created = await this.dependencies.proposalRepo.create({
      proposal,
      workspace_id: synthesis.workspace_id,
      run_id: synthesis.run_id
    });

    // notifyEntry handles null run_id correctly (workspace-only notification).
    await this.dependencies.runtimeNotifier.notifyEntry(event);

    return created;
  }

  public async review(
    proposalId: string,
    action: ReviewAction
  ): Promise<Readonly<Proposal>> {
    const parsedProposalId = parseNonEmptyString(proposalId, "proposalId");
    const parsedAction = parseReviewAction(action);

    const context = await this.loadReviewContext(parsedProposalId);
    const nextRevision = this.createRevisionCursor(
      await this.getNextRevision("proposal", context.proposal.proposal_id)
    );

    const reviewCreated = await this.dependencies.eventLogRepo.append({
      event_type: Phase1BEventType.SOUL_REVIEW_CREATED,
      entity_type: "proposal",
      entity_id: context.proposal.proposal_id,
      workspace_id: context.synthesis.workspace_id,
      run_id: context.synthesis.run_id,
      caused_by: parsedAction.reviewed_by,
      revision: nextRevision(),
      payload_json: SoulReviewCreatedPayloadSchema.parse({
        object_id: context.proposal.runtime_id,
        object_kind: context.proposal.object_kind,
        workspace_id: context.synthesis.workspace_id,
        run_id: context.synthesis.run_id
      })
    });

    const resolutionState =
      parsedAction.action === "accepted"
        ? ProposalResolutionState.ACCEPTED
        : ProposalResolutionState.REJECTED;

    // Collect synthesis/claim notification events during sub-service calls so
    // they can be emitted after all EventLog appends complete, preserving order.
    const deferredNotificationEvents: EventLogEntry[] = [];

    if (parsedAction.action === "accepted") {
      await this.applyAcceptedReview(context, parsedAction.reviewed_at, deferredNotificationEvents);
    } else {
      await this.applyRejectedReview(context, parsedAction.reviewed_at, deferredNotificationEvents);
    }

    const reviewCompleted = await this.dependencies.eventLogRepo.append({
      event_type: Phase1BEventType.SOUL_REVIEW_COMPLETED,
      entity_type: "proposal",
      entity_id: context.proposal.proposal_id,
      workspace_id: context.synthesis.workspace_id,
      run_id: context.synthesis.run_id,
      caused_by: parsedAction.reviewed_by,
      revision: nextRevision(),
      payload_json: SoulReviewCompletedPayloadSchema.parse({
        object_id: context.proposal.runtime_id,
        object_kind: context.proposal.object_kind,
        workspace_id: context.synthesis.workspace_id,
        run_id: context.synthesis.run_id,
        from_state: context.proposal.resolution_state,
        to_state: resolutionState,
        reason_code: parsedAction.action,
        caused_by: TransitionCausedBy.REVIEW,
        evidence_refs: null,
        occurred_at: parsedAction.reviewed_at
      })
    });

    const resolved = await this.dependencies.eventLogRepo.append({
      event_type: Phase1BEventType.SOUL_PROPOSAL_RESOLVED,
      entity_type: "proposal",
      entity_id: context.proposal.proposal_id,
      workspace_id: context.synthesis.workspace_id,
      run_id: context.synthesis.run_id,
      caused_by: parsedAction.reviewed_by,
      revision: nextRevision(),
      payload_json: SoulProposalResolvedPayloadSchema.parse({
        object_id: context.proposal.runtime_id,
        object_kind: context.proposal.object_kind,
        workspace_id: context.synthesis.workspace_id,
        run_id: context.synthesis.run_id,
        from_state: context.proposal.resolution_state,
        to_state: resolutionState,
        reason_code: parsedAction.action,
        caused_by: TransitionCausedBy.REVIEW,
        evidence_refs: null,
        occurred_at: parsedAction.reviewed_at
      })
    });

    const updated = await this.dependencies.proposalRepo.updateResolution(
      context.proposal.proposal_id,
      resolutionState,
      parsedAction.reviewed_at
    );

    // Notify all deferred events in EventLog insertion order:
    //   reviewCreated → [synthesis/claim/slot sub-events] → reviewCompleted → resolved
    // notifyEntry handles null run_id correctly for workspace-only notifications.
    await this.notifyDeferredEvents([reviewCreated, ...deferredNotificationEvents, reviewCompleted, resolved]);

    return updated;
  }

  public findById(proposalId: string): Promise<Readonly<Proposal> | null> {
    return this.dependencies.proposalRepo.findById(proposalId);
  }

  public findByWorkspaceId(workspaceId: string): Promise<readonly Readonly<Proposal>[]> {
    return this.dependencies.proposalRepo.findByWorkspaceId(workspaceId);
  }

  public findPending(workspaceId: string): Promise<readonly Readonly<Proposal>[]> {
    return this.dependencies.proposalRepo.findPending(workspaceId);
  }

  private async loadReviewContext(proposalId: string): Promise<ReviewContext> {
    const proposal = await this.dependencies.proposalRepo.findById(proposalId);

    if (proposal === null) {
      throw new CoreError("NOT_FOUND", "Proposal not found");
    }

    ensurePendingProposal(proposal);
    ensurePhase1BProposal(proposal);

    const synthesisId = parseReferenceId(proposal.derived_from, "derived_from");
    const claimDraftId = parseReferenceId(proposal.recommended_option_id, "recommended_option_id");

    const synthesis = await this.dependencies.synthesisService.findById(synthesisId);

    if (synthesis === null) {
      throw new CoreError("NOT_FOUND", "Synthesis capsule not found");
    }

    if (synthesis.promotion_state !== PromotionState.CANDIDATE) {
      throw new CoreError(
        "VALIDATION",
        `Synthesis capsule must be in candidate state, got ${synthesis.promotion_state}`
      );
    }

    const claim = await this.dependencies.claimService.findById(claimDraftId);

    if (claim === null) {
      throw new CoreError("NOT_FOUND", "Claim form not found");
    }

    ensureDraftClaim(claim);
    ensureSharedWorkspace(synthesis.workspace_id, claim.workspace_id);

    return {
      proposal,
      synthesis,
      claim
    };
  }

  private async applyAcceptedReview(
    context: ReviewContext,
    reviewedAt: string,
    deferredNotificationEvents: EventLogEntry[]
  ): Promise<void> {
    await this.dependencies.claimService.transitionLifecycle(
      context.claim.object_id,
      ClaimLifecycleState.ACTIVE,
      "proposal_accepted",
      TransitionCausedBy.REVIEW,
      { deferredNotificationEvents }
    );

    await this.dependencies.synthesisService.resolvePromotionDecision(
      context.synthesis.object_id,
      PromotionState.PROMOTED,
      "proposal_accepted",
      TransitionCausedBy.REVIEW,
      { deferredNotificationEvents }
    );

    await this.recordKarmaAndProcess(
      context,
      reviewedAt,
      "accept_gain",
      DYNAMICS_CONSTANTS.karma.accept_gain
    );
  }

  private async applyRejectedReview(
    context: ReviewContext,
    reviewedAt: string,
    deferredNotificationEvents: EventLogEntry[]
  ): Promise<void> {
    await this.dependencies.synthesisService.resolvePromotionDecision(
      context.synthesis.object_id,
      PromotionState.REJECTED,
      "proposal_rejected",
      TransitionCausedBy.REVIEW,
      { cooldownUntil: addHours(reviewedAt, 24), deferredNotificationEvents }
    );

    await this.recordKarmaAndProcess(
      context,
      reviewedAt,
      "reject_penalty",
      DYNAMICS_CONSTANTS.karma.reject_penalty
    );
  }

  private async recordKarmaAndProcess(
    context: ReviewContext,
    reviewedAt: string,
    kind: KarmaEvent["kind"],
    amount: number
  ): Promise<void> {
    const targetObjectId = resolvePrimaryMemoryObjectId(context.claim, context.synthesis);

    if (targetObjectId === null) {
      this.warn.warn("[ProposalService] Skipping dynamics update because no memory target is available for claim", {
        claim_id: context.claim.object_id,
        synthesis_id: context.synthesis.object_id
      });
      return;
    }

    const karmaEvent: KarmaEvent = {
      event_id: this.generateObjectId(),
      kind,
      object_id: targetObjectId,
      amount,
      created_at: reviewedAt,
      workspace_id: context.synthesis.workspace_id
    };

    if (this.dependencies.dynamicsService !== undefined) {
      await this.dependencies.dynamicsService.processKarmaEvent(karmaEvent);
    } else {
      this.dependencies.karmaEventStore.record(karmaEvent);
    }
  }

  private createRevisionCursor(startRevision: number): () => number {
    let currentRevision = startRevision;

    return () => {
      const revision = currentRevision;
      currentRevision += 1;
      return revision;
    };
  }

  private async notifyDeferredEvents(events: readonly EventLogEntry[]): Promise<void> {
    for (const event of events) {
      await this.dependencies.runtimeNotifier.notifyEntry(event);
    }
  }

  private async getNextRevision(entityType: string, entityId: string): Promise<number> {
    const events = await this.dependencies.eventLogRepo.queryByEntity(entityType, entityId);

    if (events.length === 0) {
      return 0;
    }

    const maxRevision = events.reduce((max, event) => Math.max(max, event.revision), 0);
    return maxRevision + 1;
  }
}

function parseProposal(value: Proposal): Proposal {
  try {
    return ProposalSchema.parse(value);
  } catch (error) {
    throw new CoreError("VALIDATION", "Invalid proposal payload", { cause: error });
  }
}

function parseReviewAction(action: ReviewAction): ReviewAction {
  if (action.action !== "accepted" && action.action !== "rejected") {
    throw new CoreError("VALIDATION", "Review action must be accepted or rejected");
  }

  const reviewedBy = action.reviewed_by.trim();
  if (reviewedBy.length === 0) {
    throw new CoreError("VALIDATION", "reviewed_by is required");
  }

  const reviewedAtEpoch = Date.parse(action.reviewed_at);
  if (!Number.isFinite(reviewedAtEpoch)) {
    throw new CoreError("VALIDATION", "reviewed_at must be a valid ISO timestamp");
  }

  const note = action.note === null ? null : action.note.trim().length === 0 ? null : action.note;

  return {
    action: action.action,
    note,
    reviewed_by: reviewedBy,
    reviewed_at: new Date(reviewedAtEpoch).toISOString()
  };
}

function parseReferenceId(value: string | null, field: "derived_from" | "recommended_option_id"): string {
  if (value === null || value.trim().length === 0) {
    throw new CoreError("VALIDATION", `Proposal ${field} is required`);
  }

  return value;
}

function ensureDraftClaim(claim: ClaimForm): void {
  if (claim.claim_status !== ClaimLifecycleState.DRAFT) {
    throw new CoreError("VALIDATION", `Claim form must be in draft state, got ${claim.claim_status}`);
  }
}

function ensurePendingProposal(proposal: Proposal): void {
  if (proposal.resolution_state !== ProposalResolutionState.PENDING) {
    throw new CoreError("VALIDATION", `Proposal is already ${proposal.resolution_state}`);
  }
}

function ensureSharedWorkspace(synthesisWorkspaceId: string, claimWorkspaceId: string): void {
  if (synthesisWorkspaceId !== claimWorkspaceId) {
    throw new CoreError("VALIDATION", "Synthesis and claim must belong to the same workspace");
  }
}

function ensurePhase1BProposal(proposal: Proposal): void {
  if (proposal.dossier_ref !== null) {
    throw new CoreError("VALIDATION", "dossier_ref must be null in Phase 1B");
  }

  const hasInvalidOption = proposal.proposal_options.some(
    (option) => option.option_kind !== ProposalOptionKind.REQUEST_CONFIRMATION
  );

  if (hasInvalidOption) {
    throw new CoreError(
      "VALIDATION",
      "Phase 1B only supports proposal option kind request_confirmation"
    );
  }
}

function resolvePrimaryMemoryObjectId(
  claim: Readonly<ClaimForm>,
  synthesis: Readonly<SynthesisCapsule>
): string | null {
  const claimRef = claim.source_object_refs.find((value) => value.trim().length > 0);

  if (claimRef !== undefined) {
    return claimRef;
  }

  const synthesisRef = synthesis.source_memory_refs.find((value) => value.trim().length > 0);

  if (synthesisRef !== undefined) {
    return synthesisRef;
  }

  return null;
}

function addHours(iso: string, hours: number): string {
  const base = Date.parse(iso);

  if (!Number.isFinite(base)) {
    throw new CoreError("VALIDATION", "reviewed_at must be a valid ISO timestamp");
  }

  return new Date(base + hours * 60 * 60 * 1000).toISOString();
}
