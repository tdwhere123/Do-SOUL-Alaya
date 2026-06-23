import { randomUUID } from "node:crypto";
import {
  ClaimLifecycleState,
  MemoryGovernanceEventType,
  SoulClaimContestedPayloadSchema,
  TransitionCausedBy,
  type ClaimForm,
  type ClaimLifecycleState as ClaimLifecycleStateType,
  type EventLogEntry,
  type TransitionCausedBy as TransitionCausedByType
} from "@do-soul/alaya-protocol";
import { CoreError } from "../shared/errors.js";
import type { EventPublisherInput } from "../runtime/event-publisher.js";
import { parseObjectId } from "../shared/validators.js";
import {
  assertNoAdditionalEventInputs,
  collectAdditionalEvents,
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
  ClaimServiceDependencies
} from "./claim-service-types.js";

export type {
  ClaimFormInput,
  ClaimRuntimeNotifierPort,
  ClaimServiceClaimFormRepoPort,
  ClaimServiceDependencies,
  ClaimServiceEventLogRepoPort,
  ClaimServiceSlotServicePort,
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
}

export class ClaimService {
  private readonly generateObjectId: () => string;
  private readonly now: () => string;

  public constructor(private readonly dependencies: ClaimServiceDependencies) {
    this.generateObjectId = dependencies.generateObjectId ?? (() => randomUUID());
    this.now = dependencies.now ?? (() => new Date().toISOString());
  }

  public async create(input: ClaimFormInput): Promise<Readonly<ClaimForm>> {
    const creation = this.buildClaimCreationContext(input, this.now());
    if (
      creation.canonicalizationPlan !== undefined &&
      this.dependencies.eventPublisher !== undefined
    ) {
      return await this.createClaimAtomically(creation);
    }
    return await this.createClaimWithEventLog(creation);
  }

  public async transitionLifecycle(
    objectId: string,
    newState: ClaimLifecycleStateType,
    reason: string,
    causedBy: TransitionCausedByType,
    options: {
      readonly skipSlotElection?: boolean;
      readonly deferredNotificationEvents?: EventLogEntry[];
      readonly additionalEventInputs?: readonly EventPublisherInput[];
      readonly additionalEventsSink?: EventLogEntry[];
    } = {}
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
        additionalEventsSink: options.additionalEventsSink
      }
    );

    return slotElectionRequired
      ? await this.resolveActivatedClaimElection(updated, options.deferredNotificationEvents)
      : updated;
  }

  public findById(objectId: string): Promise<Readonly<ClaimForm> | null> {
    return this.dependencies.claimFormRepo.findById(objectId);
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

  private async applyLifecycleTransition(
    existing: Readonly<ClaimForm>,
    newState: ClaimLifecycleStateType,
    reason: string,
    causedBy: TransitionCausedByType,
    deferredNotificationEvents?: EventLogEntry[],
    auditComposition: LifecycleAuditComposition = {}
  ): Promise<Readonly<ClaimForm>> {
    const occurredAt = this.now();
    const eventInput = createLifecycleChangedEventInput(
      existing,
      newState,
      reason,
      causedBy,
      occurredAt
    );
    const additionalEventInputs = auditComposition.additionalEventInputs ?? [];
    const syncStatusUpdate = this.dependencies.claimFormRepo.updateStatusSync;

    if (this.canApplyAtomicLifecycleTransition(syncStatusUpdate, deferredNotificationEvents)) {
      return await this.applyAtomicLifecycleTransition(
        existing,
        newState,
        occurredAt,
        eventInput,
        additionalEventInputs,
        auditComposition.additionalEventsSink,
        syncStatusUpdate!
      );
    }

    assertNoAdditionalEventInputs(additionalEventInputs);
    return await this.applyNonAtomicLifecycleTransition(
      existing,
      newState,
      occurredAt,
      eventInput,
      deferredNotificationEvents
    );
  }

  private async emitContestedEvent(
    claim: Readonly<ClaimForm>,
    contestedBy: string | null,
    deferredNotificationEvents?: EventLogEntry[]
  ): Promise<void> {
    const event = await this.dependencies.eventLogRepo.append({
      event_type: MemoryGovernanceEventType.SOUL_CLAIM_CONTESTED,
      entity_type: "claim_form",
      entity_id: claim.object_id,
      workspace_id: claim.workspace_id,
      run_id: null,
      caused_by: TransitionCausedBy.SYSTEM,
      payload_json: SoulClaimContestedPayloadSchema.parse({
        object_id: claim.object_id,
        object_kind: claim.object_kind,
        workspace_id: claim.workspace_id,
        run_id: null,
        contested_by: contestedBy,
        triage_result: "deferred"
      })
    });

    if (deferredNotificationEvents !== undefined) {
      deferredNotificationEvents.push(event);
    } else {
      await this.dependencies.runtimeNotifier.notifyEntry(event);
    }
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
    return await this.dependencies.eventPublisher!.appendManyWithMutation(
      [...creation.canonicalizationPlan!.eventInputs, creation.claimCreatedEventInput],
      () => this.dependencies.claimFormRepo.create(creation.claim)
    );
  }

  private async createClaimWithEventLog(
    creation: ClaimCreationContext
  ): Promise<Readonly<ClaimForm>> {
    const appendedEvents = await this.appendCanonicalizationEvents(creation.canonicalizationPlan);
    const createdEvent = await this.dependencies.eventLogRepo.append(creation.claimCreatedEventInput);
    const created = await this.dependencies.claimFormRepo.create(creation.claim);
    for (const event of [...appendedEvents, createdEvent]) {
      await this.dependencies.runtimeNotifier.notifyEntry(event);
    }
    return created;
  }

  private async appendCanonicalizationEvents(
    canonicalizationPlan: ClaimCanonicalizationPlan | undefined
  ): Promise<EventLogEntry[]> {
    const appendedEvents: EventLogEntry[] = [];
    if (canonicalizationPlan === undefined) {
      return appendedEvents;
    }

    for (const eventInput of canonicalizationPlan.eventInputs) {
      appendedEvents.push(await this.dependencies.eventLogRepo.append(eventInput));
    }

    return appendedEvents;
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
  }): void {
    const additionalEventInputs = options.additionalEventInputs ?? [];
    if (additionalEventInputs.length === 0) {
      return;
    }

    const atomicTransitionAvailable =
      this.dependencies.eventPublisher !== undefined &&
      this.dependencies.claimFormRepo.updateStatusSync !== undefined &&
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
    deferredNotificationEvents?: EventLogEntry[]
  ): Promise<Readonly<ClaimForm>> {
    const election = await this.dependencies.slotService!.onClaimActivated(
      updated,
      deferredNotificationEvents
    );
    if (election.decision !== "contested") {
      return updated;
    }

    const contested = await this.applyLifecycleTransition(
      updated,
      ClaimLifecycleState.CONTESTED,
      "slot_conflict_review_required",
      TransitionCausedBy.SYSTEM,
      deferredNotificationEvents
    );
    await this.emitContestedEvent(contested, election.slot.winner_claim_id, deferredNotificationEvents);
    return contested;
  }

  private canApplyAtomicLifecycleTransition(
    syncStatusUpdate: ClaimServiceDependencies["claimFormRepo"]["updateStatusSync"],
    deferredNotificationEvents?: EventLogEntry[]
  ): boolean {
    return (
      this.dependencies.eventPublisher !== undefined &&
      syncStatusUpdate !== undefined &&
      deferredNotificationEvents === undefined
    );
  }

  private async applyAtomicLifecycleTransition(
    existing: Readonly<ClaimForm>,
    newState: ClaimLifecycleStateType,
    occurredAt: string,
    eventInput: EventPublisherInput,
    additionalEventInputs: readonly EventPublisherInput[],
    additionalEventsSink: EventLogEntry[] | undefined,
    syncStatusUpdate: NonNullable<ClaimServiceDependencies["claimFormRepo"]["updateStatusSync"]>
  ): Promise<Readonly<ClaimForm>> {
    return await this.dependencies.eventPublisher!.appendManyWithMutation(
      [eventInput, ...additionalEventInputs],
      (persistedEntries) => {
        collectAdditionalEvents(persistedEntries, additionalEventInputs.length, additionalEventsSink);
        return syncStatusUpdate.call(
          this.dependencies.claimFormRepo,
          existing.object_id,
          newState,
          occurredAt,
          existing.claim_status
        );
      }
    );
  }

  private async applyNonAtomicLifecycleTransition(
    existing: Readonly<ClaimForm>,
    newState: ClaimLifecycleStateType,
    occurredAt: string,
    eventInput: EventPublisherInput,
    deferredNotificationEvents?: EventLogEntry[]
  ): Promise<Readonly<ClaimForm>> {
    const updated = await this.dependencies.claimFormRepo.updateStatus(
      existing.object_id,
      newState,
      occurredAt,
      existing.claim_status
    );
    const event = await this.dependencies.eventLogRepo.append(eventInput);
    if (deferredNotificationEvents !== undefined) {
      deferredNotificationEvents.push(event);
    } else {
      await this.dependencies.runtimeNotifier.notifyEntry(event);
    }
    return updated;
  }
}
