import { randomUUID } from "node:crypto";
import {
  ClaimLifecycleState,
  TransitionCausedBy,
  type ClaimForm,
  type ClaimLifecycleState as ClaimLifecycleStateType,
  type EventLogEntry,
  type TransitionCausedBy as TransitionCausedByType
} from "@do-soul/alaya-protocol";
import { CoreError } from "../../shared/errors.js";
import type { EventPublisherInput } from "../../runtime/event-publisher.js";
import { parseObjectId } from "../../shared/validators.js";
import { isPromiseLike } from "../../shared/promise-utils.js";
import {
  collectAdditionalEvents,
  createClaimContestedEventInput,
  createClaimCreatedEventInput,
  createLifecycleChangedEventInput,
  ensureAllowedLifecycleTransition,
  parseClaimForm,
  parseClaimLifecycleState,
  parseGovernanceSubject,
  parseReason,
  parseTransitionCausedBy,
  shouldRunSlotElection
} from "./claim-service-helpers.js";
import type {
  ClaimFormInput,
  ClaimLifecycleTransitionOptions,
  ClaimServiceDependencies,
  ElectionTransactionGuard,
  PreparedClaimLifecycleTransition
} from "./claim-service-types.js";
import type { EffectDecisionReceipt } from "@do-soul/alaya-protocol";

export type {
  ClaimFormInput,
  ClaimLifecycleTransitionOptions,
  ClaimRuntimeNotifierPort,
  ClaimServiceClaimFormRepoPort,
  ClaimServiceDependencies,
  ClaimServiceEventLogRepoPort,
  ClaimServiceSlotServicePort,
  EffectDecisionStore,
  PrecedenceBasisDecisionInput
} from "./claim-service-types.js";
export { derivePrecedenceBasis } from "./claim-service-helpers.js";

interface ClaimCanonicalizationPlan {
  readonly governanceSubject: ClaimForm["governance_subject"];
  readonly eventInputs: readonly EventPublisherInput[];
}

interface ClaimCreationContext {
  readonly claim: Readonly<ClaimForm>;
  readonly claimCreatedEventInput: EventPublisherInput;
  readonly canonicalizationPlan: ClaimCanonicalizationPlan | undefined;
}

interface ClaimLifecycleTransitionInput {
  readonly objectId: string;
  readonly newState: ClaimLifecycleStateType;
  readonly reason: string;
  readonly causedBy: TransitionCausedByType;
}

interface LifecycleAuditComposition {
  readonly additionalEventInputs?: readonly EventPublisherInput[];
  readonly additionalEventsSink?: EventLogEntry[];
  readonly effectDecisionReceipt?: ClaimLifecycleTransitionOptions["effectDecisionReceipt"];
  readonly transactionGuard?: ElectionTransactionGuard;
}

/** Activation and its audit are durable; only the subsequent election failed. */
export class ClaimElectionAfterActivationError extends CoreError {
  public constructor(public readonly claim: Readonly<ClaimForm>, cause: unknown) {
    super("CONFLICT", "Claim activation committed but slot election failed", { cause });
    this.name = "ClaimElectionAfterActivationError";
  }
}

export class ClaimService {
  private readonly generateObjectId: () => string;
  private readonly now: () => string;

  public constructor(private readonly dependencies: ClaimServiceDependencies) {
    this.generateObjectId = dependencies.generateObjectId ?? (() => randomUUID());
    this.now = dependencies.now ?? (() => new Date().toISOString());
  }

  public async create(input: ClaimFormInput): Promise<Readonly<ClaimForm>> {
    return await this.createClaimAtomically(this.buildClaimCreationContext(input, this.now()));
  }

  public async transitionLifecycle(
    objectId: string,
    newState: ClaimLifecycleStateType,
    reason: string,
    causedBy: TransitionCausedByType,
    options: ClaimLifecycleTransitionOptions = {}
  ): Promise<Readonly<ClaimForm>> {
    const transition = this.parseLifecycleTransition(objectId, newState, reason, causedBy);
    this.assertAdditionalAuditEventsAreAtomic(options);

    const existing = await this.requireExistingClaim(transition.objectId);
    ensureAllowedLifecycleTransition(existing.claim_status, transition.newState);

    const slotElectionRequired = shouldRunSlotElection(
      existing,
      transition.newState,
      options.skipSlotElection === true
    );
    this.requireSlotServiceForActivation(slotElectionRequired);

    const updated = await this.applyLifecycleTransition(
      existing,
      transition.newState,
      transition.reason,
      transition.causedBy,
      options.deferredNotificationEvents,
      {
        additionalEventInputs: options.additionalEventInputs,
        additionalEventsSink: options.additionalEventsSink,
        effectDecisionReceipt: options.effectDecisionReceipt,
        transactionGuard: options.transactionGuard
      }
    );

    if (!slotElectionRequired) return updated;
    try {
      return await this.resolveActivatedClaimElection(updated, options.deferredNotificationEvents);
    } catch (cause) {
      throw new ClaimElectionAfterActivationError(updated, cause);
    }
  }

  /** Retry the election of an already activated claim without repeating activation. */
  public async resumeActivationElection(objectId: string, transactionGuard?: ElectionTransactionGuard): Promise<Readonly<ClaimForm>> {
    const current = await this.requireExistingClaim(parseObjectId(objectId));
    if (current.claim_status === ClaimLifecycleState.ACTIVE) {
      return await this.resolveActivatedClaimElection(current, undefined, transactionGuard);
    }
    if (current.claim_status === ClaimLifecycleState.CONTESTED) {
      const resume = this.requireSlotService().resumeContestedElection;
      if (resume === undefined) throw new CoreError("CONFLICT", "Contested election recovery is unavailable");
      await resume.call(this.requireSlotService(), current, transactionGuard);
      return await this.requireExistingClaim(current.object_id);
    }
    if (current.claim_status === ClaimLifecycleState.WINNER || current.claim_status === ClaimLifecycleState.SUPERSEDED) {
      return current;
    }
    throw new CoreError("CONFLICT", "Claim no longer permits activation election recovery");
  }

  /**
   * Compose a lifecycle CAS with other audited mutations on the same connection.
   * Preparation has no effects; the caller owns the transaction and propagation.
   * Slot election must be explicitly skipped, as with transitionLifecycle.
   */
  public async prepareLifecycleTransition(
    objectId: string,
    newState: ClaimLifecycleStateType,
    reason: string,
    causedBy: TransitionCausedByType,
    options: { readonly skipSlotElection: true }
  ): Promise<PreparedClaimLifecycleTransition> {
    if (options.skipSlotElection !== true) {
      throw new CoreError("CONFLICT", "Prepared claim transitions require caller-owned slot election");
    }
    const transition = this.parseLifecycleTransition(objectId, newState, reason, causedBy);
    const existing = await this.requireExistingClaim(transition.objectId);
    this.assertAtomicLifecycleAvailable();
    return this.prepareExistingLifecycleTransition(existing, transition.newState, transition.reason, transition.causedBy);
  }

  public findById(objectId: string): Promise<Readonly<ClaimForm> | null> {
    return this.dependencies.claimFormRepo.findById(objectId);
  }

  public getStorageConnectionIdentity(): object | undefined {
    return this.dependencies.claimFormRepo.getStorageConnectionIdentity?.();
  }

  public getEventPublisherConnectionIdentity(): object | undefined {
    return this.dependencies.eventPublisher?.getStorageConnectionIdentity?.();
  }

  // invariant: scoped lookup hides cross-workspace claims so handlers cannot
  // distinguish them from missing objects (mirrors memoryService.findByIdScoped).
  public async findByIdScoped(
    objectId: string,
    workspaceId: string
  ): Promise<Readonly<ClaimForm> | null> {
    const claim = await this.dependencies.claimFormRepo.findById(objectId);
    if (claim === null || claim.workspace_id !== workspaceId) {
      return null;
    }
    return claim;
  }

  public findByCanonicalKey(workspaceId: string, canonicalKey: string): Promise<readonly Readonly<ClaimForm>[]> {
    return this.dependencies.claimFormRepo.findByCanonicalKey(workspaceId, canonicalKey);
  }

  public findByWorkspaceId(workspaceId: string): Promise<readonly Readonly<ClaimForm>[]> {
    return this.dependencies.claimFormRepo.findByWorkspaceId(workspaceId);
  }

  public async recordEffectDecision(
    receipt: EffectDecisionReceipt,
    eventInput: EventPublisherInput
  ): Promise<Readonly<EventLogEntry>> {
    const entries = await this.requireEventPublisher().appendManyWithMutation(
      [eventInput],
      (persistedEntries) => {
        this.requireEffectDecisionStore().insert(receipt);
        return persistedEntries;
      }
    );
    const entry = entries[0];
    if (entry === undefined) {
      throw new CoreError("CONFLICT", "Effect decision audit was not appended atomically");
    }
    return entry;
  }

  private async applyLifecycleTransition(
    existing: Readonly<ClaimForm>,
    newState: ClaimLifecycleStateType,
    reason: string,
    causedBy: TransitionCausedByType,
    deferredNotificationEvents?: EventLogEntry[],
    auditComposition: LifecycleAuditComposition = {}
  ): Promise<Readonly<ClaimForm>> {
    this.assertAtomicLifecycleAvailable(deferredNotificationEvents);
    const prepared = this.prepareExistingLifecycleTransition(existing, newState, reason, causedBy);
    return await this.applyAtomicLifecycleTransition(prepared, auditComposition);
  }

  private prepareExistingLifecycleTransition(
    existing: Readonly<ClaimForm>,
    newState: ClaimLifecycleStateType,
    reason: string,
    causedBy: TransitionCausedByType
  ): PreparedClaimLifecycleTransition {
    ensureAllowedLifecycleTransition(existing.claim_status, newState);
    const occurredAt = this.now();
    const syncStatusUpdate = this.requireStatusUpdateSync();
    return {
      eventInput: createLifecycleChangedEventInput(existing, newState, reason, causedBy, occurredAt),
      apply: () => {
        const updated = syncStatusUpdate.call(
          this.dependencies.claimFormRepo,
          existing.object_id,
          newState,
          occurredAt,
          existing.claim_status
        );
        if (isPromiseLike(updated)) {
          throw new CoreError("CONFLICT", "Prepared claim status CAS must be synchronous");
        }
        return updated;
      }
    };
  }

  private buildClaimCreationContext(input: ClaimFormInput, timestamp: string): ClaimCreationContext {
    const objectId = this.generateObjectId();
    const canonicalizationPlan = this.dependencies.canonicalAliasService?.planGovernanceSubjectCanonicalization(
      input.governance_subject_domain,
      input.governance_subject_qualifiers ?? {},
      {
        entityType: "claim_form",
        entityId: objectId,
        workspaceId: input.workspace_id,
        runId: null,
        causedBy: input.created_by,
        startingRevision: 0
      }
    );
    const governanceSubject =
      canonicalizationPlan?.governanceSubject ??
      parseGovernanceSubject(input.governance_subject_domain, input.governance_subject_qualifiers ?? {});
    const claim = parseClaimForm({
      object_id: objectId,
      object_kind: "claim_form",
      schema_version: 1,
      lifecycle_state: "active",
      created_at: timestamp,
      updated_at: timestamp,
      created_by: input.created_by,
      governance_subject: governanceSubject,
      claim_kind: input.claim_kind,
      scope_class: input.scope_class,
      enforcement_level: input.enforcement_level,
      origin_tier: input.origin_tier,
      precedence_basis: input.precedence_basis,
      proposition_digest: input.proposition_digest,
      evidence_refs: input.evidence_refs,
      source_object_refs: input.source_object_refs,
      workspace_id: input.workspace_id,
      claim_status: ClaimLifecycleState.DRAFT
    });

    return {
      claim,
      claimCreatedEventInput: createClaimCreatedEventInput(claim),
      canonicalizationPlan
    };
  }

  private async createClaimAtomically(
    creation: ClaimCreationContext
  ): Promise<Readonly<ClaimForm>> {
    const canonicalizationEvents = creation.canonicalizationPlan?.eventInputs ?? [];
    return await this.requireEventPublisher().appendManyWithMutation(
      [...canonicalizationEvents, creation.claimCreatedEventInput],
      () => this.dependencies.claimFormRepo.create(creation.claim)
    );
  }

  private parseLifecycleTransition(
    objectId: string,
    newState: ClaimLifecycleStateType,
    reason: string,
    causedBy: TransitionCausedByType
  ): ClaimLifecycleTransitionInput {
    return {
      objectId: parseObjectId(objectId),
      newState: parseClaimLifecycleState(newState),
      reason: parseReason(reason),
      causedBy: parseTransitionCausedBy(causedBy)
    };
  }

  private assertAdditionalAuditEventsAreAtomic(options: {
    readonly additionalEventInputs?: readonly EventPublisherInput[];
    readonly deferredNotificationEvents?: EventLogEntry[];
    readonly effectDecisionReceipt?: ClaimLifecycleTransitionOptions["effectDecisionReceipt"];
  }): void {
    const additionalEventInputs = options.additionalEventInputs ?? [];
    if (additionalEventInputs.length === 0 && options.effectDecisionReceipt === undefined) {
      return;
    }

    const atomicTransitionAvailable =
      this.dependencies.eventPublisher !== undefined &&
      this.dependencies.claimFormRepo.updateStatusSync !== undefined &&
      (options.effectDecisionReceipt === undefined ||
        this.dependencies.effectDecisionStore !== undefined) &&
      options.deferredNotificationEvents === undefined;
    if (!atomicTransitionAvailable) {
      throw new CoreError(
        "CONFLICT",
        "Atomic claim transition with additional audit events is not available"
      );
    }
  }

  private async requireExistingClaim(objectId: string): Promise<Readonly<ClaimForm>> {
    const existing = await this.dependencies.claimFormRepo.findById(objectId);
    if (existing === null) {
      throw new CoreError("NOT_FOUND", "Claim form not found");
    }
    return existing;
  }

  private requireSlotServiceForActivation(shouldRunSlotElection: boolean): void {
    if (shouldRunSlotElection && this.dependencies.slotService === undefined) {
      throw new CoreError("CONFLICT", "Slot service is required for claim activation");
    }
  }

  private async resolveActivatedClaimElection(
    updated: Readonly<ClaimForm>,
    deferredNotificationEvents?: EventLogEntry[],
    transactionGuard?: ElectionTransactionGuard
  ): Promise<Readonly<ClaimForm>> {
    const activeClaimGuard: ElectionTransactionGuard = connectionIdentity => {
      const find = this.dependencies.claimFormRepo.findByIdSync;
      if (connectionIdentity === undefined || this.getStorageConnectionIdentity() !== connectionIdentity || find === undefined ||
          find.call(this.dependencies.claimFormRepo, updated.object_id)?.claim_status !== ClaimLifecycleState.ACTIVE) {
        throw new CoreError("CONFLICT", "Activated claim changed before slot election committed");
      }
    };
    const election = await this.requireSlotService().onClaimActivated(
      updated,
      deferredNotificationEvents,
      transactionGuard,
      activeClaimGuard
    );
    if (election.decision !== "contested") return updated;
    const current = await this.requireExistingClaim(updated.object_id);
    if (current.claim_status !== ClaimLifecycleState.ACTIVE) return current;

    return await this.applyLifecycleTransition(
      current,
      ClaimLifecycleState.CONTESTED,
      "slot_conflict_review_required",
      TransitionCausedBy.SYSTEM,
      deferredNotificationEvents,
      { additionalEventInputs: [createClaimContestedEventInput(current, election.slot.winner_claim_id)], transactionGuard }
    );
  }

  private assertAtomicLifecycleAvailable(
    deferredNotificationEvents?: EventLogEntry[]
  ): void {
    this.requireEventPublisher();
    this.requireStatusUpdateSync();
    if (deferredNotificationEvents !== undefined) {
      throw new CoreError(
        "CONFLICT",
        "Deferred claim notification is incompatible with atomic EventLog-first transitions"
      );
    }
  }

  private requireStatusUpdateSync(): NonNullable<
    ClaimServiceDependencies["claimFormRepo"]["updateStatusSync"]
  > {
    const syncStatusUpdate = this.dependencies.claimFormRepo.updateStatusSync;
    if (syncStatusUpdate === undefined) {
      throw new CoreError(
        "CONFLICT",
        "Synchronous claim status CAS is required for atomic claim operations"
      );
    }
    return syncStatusUpdate;
  }

  private async applyAtomicLifecycleTransition(
    prepared: PreparedClaimLifecycleTransition,
    auditComposition: LifecycleAuditComposition
  ): Promise<Readonly<ClaimForm>> {
    const additionalEventInputs = auditComposition.additionalEventInputs ?? [];
    const publisher = this.requireEventPublisher();
    return await publisher.appendManyWithMutation(
      [prepared.eventInput, ...additionalEventInputs],
      (persistedEntries) => {
        if (auditComposition.transactionGuard !== undefined) {
          const identity = publisher.getStorageConnectionIdentity?.();
          auditComposition.transactionGuard(identity);
          if (identity === undefined || this.getStorageConnectionIdentity() !== identity) {
            throw new CoreError("CONFLICT", "Claim transition requires the election transaction connection");
          }
        }
        collectAdditionalEvents(persistedEntries, additionalEventInputs.length, auditComposition.additionalEventsSink);
        if (auditComposition.effectDecisionReceipt !== undefined) {
          this.requireEffectDecisionStore().insert(auditComposition.effectDecisionReceipt);
        }
        return prepared.apply();
      }
    );
  }

  private requireEventPublisher(): NonNullable<ClaimServiceDependencies["eventPublisher"]> {
    if (this.dependencies.eventPublisher === undefined) {
      throw new CoreError("CONFLICT", "Event publisher is required for atomic claim operations");
    }
    return this.dependencies.eventPublisher;
  }

  private requireEffectDecisionStore(): NonNullable<ClaimServiceDependencies["effectDecisionStore"]> {
    if (this.dependencies.effectDecisionStore === undefined) {
      throw new CoreError("CONFLICT", "Effect decision store is required for governed claim transitions");
    }
    return this.dependencies.effectDecisionStore;
  }

  private requireSlotService(): NonNullable<ClaimServiceDependencies["slotService"]> {
    if (this.dependencies.slotService === undefined) {
      throw new CoreError("CONFLICT", "Slot service is required for claim activation");
    }
    return this.dependencies.slotService;
  }
}
