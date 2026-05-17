import { randomUUID } from "node:crypto";
import {
  ClaimFormSchema,
  ClaimLifecycleState,
  ClaimLifecycleStateSchema,
  MemoryGovernanceEventType,
  PrecedenceBasis,
  SoulClaimContestedPayloadSchema,
  SoulClaimCreatedPayloadSchema,
  SoulClaimLifecycleChangedPayloadSchema,
  TransitionCausedBy,
  TransitionCausedBySchema,
  canonicalGovernanceSubject,
  isValidClaimTransition,
  type ClaimForm,
  type ClaimLifecycleState as ClaimLifecycleStateType,
  type EnforcementLevel as EnforcementLevelType,
  type EventLogEntry,
  type PrecedenceBasis as PrecedenceBasisType,
  type TransitionCausedBy as TransitionCausedByType
} from "@do-soul/alaya-protocol";
import type { CanonicalAliasService } from "./canonical-alias-service.js";
import { CoreError } from "./errors.js";
import type { EventPublisher } from "./event-publisher.js";
import { parseObjectId } from "./shared/validators.js";
import type { SlotElectionResult } from "./slot-service.js";

export type ClaimFormInput = Omit<
  ClaimForm,
  | "object_id"
  | "object_kind"
  | "schema_version"
  | "lifecycle_state"
  | "created_at"
  | "updated_at"
  | "governance_subject"
  | "claim_status"
> & {
  readonly governance_subject_domain: string;
  readonly governance_subject_qualifiers?: Record<string, string>;
};

// invariant: shared producer-side rule for picking precedence_basis on a
// newly minted claim. Priority order (highest wins):
//   user_override  > authority > recency > evidence_strength
// Consumers: arbitration-service.scoreClaim treats user_override as a
// score boost; slot-service.evaluateSameScopeElection short-circuits to
// auto-win when the challenger carries user_override; the other three
// values are governance metadata for downstream review/audit.
// see also: packages/soul/src/garden/materialization-router.ts buildClaimInput
// see also: packages/soul/src/garden/session-override-remediation.ts (USER_OVERRIDE)
export interface PrecedenceBasisDecisionInput {
  readonly source: string;
  readonly enforcement_level: EnforcementLevelType;
  readonly is_supersede?: boolean;
  readonly user_override?: boolean;
}

export function derivePrecedenceBasis(
  input: PrecedenceBasisDecisionInput
): PrecedenceBasisType {
  if (input.user_override === true || input.source === "user_seed") {
    return PrecedenceBasis.USER_OVERRIDE;
  }
  if (input.enforcement_level === "strict") {
    return PrecedenceBasis.AUTHORITY;
  }
  if (input.is_supersede === true) {
    return PrecedenceBasis.RECENCY;
  }
  return PrecedenceBasis.EVIDENCE_STRENGTH;
}

export interface ClaimServiceEventLogRepoPort {
  append(event: Omit<EventLogEntry, "event_id" | "created_at" | "revision">): EventLogEntry | Promise<EventLogEntry>;
  queryByEntity(entityType: string, entityId: string): Promise<readonly EventLogEntry[]>;
}

export interface ClaimServiceClaimFormRepoPort {
  create(claim: ClaimForm): Readonly<ClaimForm>;
  findById(objectId: string): Promise<Readonly<ClaimForm> | null>;
  findByWorkspaceId(workspaceId: string): Promise<readonly Readonly<ClaimForm>[]>;
  findByStatus(workspaceId: string, status: ClaimLifecycleStateType): Promise<readonly Readonly<ClaimForm>[]>;
  findByCanonicalKey(workspaceId: string, canonicalKey: string): Promise<readonly Readonly<ClaimForm>[]>;
  // invariant: expectedFromStatus is the optimistic-concurrency guard.
  // Storage writes WHERE object_id = ? AND claim_status = ?; a zero-
  // row result means another transition raced ahead and the caller
  // must retry or surface CONFLICT.
  // see also: packages/storage/src/repos/claim-form-repo.ts
  updateStatus(
    objectId: string,
    status: ClaimLifecycleStateType,
    updatedAt: string,
    expectedFromStatus: ClaimLifecycleStateType
  ): Promise<Readonly<ClaimForm>>;
}

export interface ClaimServiceSlotServicePort {
  onClaimActivated(claim: Readonly<ClaimForm>, deferredNotificationEvents?: EventLogEntry[]): Promise<SlotElectionResult>;
}

export interface ClaimRuntimeNotifierPort {
  notifyEntry(entry: EventLogEntry): void | Promise<void>;
}

export interface ClaimServiceDependencies {
  readonly claimFormRepo: ClaimServiceClaimFormRepoPort;
  readonly eventLogRepo: ClaimServiceEventLogRepoPort;
  readonly runtimeNotifier: ClaimRuntimeNotifierPort;
  readonly canonicalAliasService?: Pick<CanonicalAliasService, "planGovernanceSubjectCanonicalization">;
  readonly eventPublisher?: Pick<EventPublisher, "appendManyWithMutation">;
  readonly slotService?: ClaimServiceSlotServicePort;
  readonly generateObjectId?: () => string;
  readonly now?: () => string;
}

export class ClaimService {
  private readonly generateObjectId: () => string;
  private readonly now: () => string;

  public constructor(private readonly dependencies: ClaimServiceDependencies) {
    this.generateObjectId = dependencies.generateObjectId ?? (() => randomUUID());
    this.now = dependencies.now ?? (() => new Date().toISOString());
  }

  public async create(input: ClaimFormInput): Promise<Readonly<ClaimForm>> {
    const timestamp = this.now();
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

    const claimCreatedEventInput = createClaimCreatedEventInput(claim);

    if (canonicalizationPlan !== undefined && this.dependencies.eventPublisher !== undefined) {
      return await this.dependencies.eventPublisher.appendManyWithMutation(
        [...canonicalizationPlan.eventInputs, claimCreatedEventInput],
        () => this.dependencies.claimFormRepo.create(claim)
      );
    }

    const appendedEvents: EventLogEntry[] = [];

    if (canonicalizationPlan !== undefined) {
      for (const eventInput of canonicalizationPlan.eventInputs) {
        appendedEvents.push(await this.dependencies.eventLogRepo.append(eventInput));
      }
    }

    const createdEvent = await this.dependencies.eventLogRepo.append(claimCreatedEventInput);
    const created = await this.dependencies.claimFormRepo.create(claim);

    for (const event of [...appendedEvents, createdEvent]) {
      await this.dependencies.runtimeNotifier.notifyEntry(event);
    }

    return created;
  }

  public async transitionLifecycle(
    objectId: string,
    newState: ClaimLifecycleStateType,
    reason: string,
    causedBy: TransitionCausedByType,
    options: {
      readonly skipSlotElection?: boolean;
      readonly deferredNotificationEvents?: EventLogEntry[];
    } = {}
  ): Promise<Readonly<ClaimForm>> {
    const parsedObjectId = parseObjectId(objectId);
    const parsedNewState = parseClaimLifecycleState(newState);
    const parsedReason = parseReason(reason);
    const parsedCausedBy = parseTransitionCausedBy(causedBy);

    const existing = await this.dependencies.claimFormRepo.findById(parsedObjectId);

    if (existing === null) {
      throw new CoreError("NOT_FOUND", "Claim form not found");
    }

    ensureAllowedLifecycleTransition(existing.claim_status, parsedNewState);

    const shouldRunSlotElection =
      !options.skipSlotElection &&
      parsedNewState === ClaimLifecycleState.ACTIVE &&
      existing.claim_status === ClaimLifecycleState.DRAFT;
    const slotService = this.dependencies.slotService;

    if (shouldRunSlotElection && slotService === undefined) {
      throw new CoreError("CONFLICT", "Slot service is required for claim activation");
    }

    const updated = await this.applyLifecycleTransition(
      existing, parsedNewState, parsedReason, parsedCausedBy, options.deferredNotificationEvents
    );

    if (shouldRunSlotElection) {
      if (slotService === undefined) {
        throw new CoreError("CONFLICT", "Slot service is required for claim activation");
      }

      const election = await slotService.onClaimActivated(updated, options.deferredNotificationEvents);

      if (election.decision === "contested") {
        const contested = await this.applyLifecycleTransition(
          updated,
          ClaimLifecycleState.CONTESTED,
          "slot_conflict_review_required",
          TransitionCausedBy.SYSTEM,
          options.deferredNotificationEvents
        );

        await this.emitContestedEvent(contested, election.slot.winner_claim_id, options.deferredNotificationEvents);
        return contested;
      }
    }

    return updated;
  }

  public findById(objectId: string): Promise<Readonly<ClaimForm> | null> {
    return this.dependencies.claimFormRepo.findById(objectId);
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
    deferredNotificationEvents?: EventLogEntry[]
  ): Promise<Readonly<ClaimForm>> {
    const occurredAt = this.now();
    const event = await this.dependencies.eventLogRepo.append({
      event_type: MemoryGovernanceEventType.SOUL_CLAIM_LIFECYCLE_CHANGED,
      entity_type: "claim_form",
      entity_id: existing.object_id,
      workspace_id: existing.workspace_id,
      run_id: null,
      caused_by: causedBy,
      payload_json: SoulClaimLifecycleChangedPayloadSchema.parse({
        object_id: existing.object_id,
        object_kind: existing.object_kind,
        workspace_id: existing.workspace_id,
        run_id: null,
        from_state: existing.claim_status,
        to_state: newState,
        reason_code: reason,
        caused_by: causedBy,
        evidence_refs: null,
        occurred_at: occurredAt
      })
    });

    const updated = await this.dependencies.claimFormRepo.updateStatus(
      existing.object_id,
      newState,
      occurredAt,
      existing.claim_status
    );

    if (deferredNotificationEvents !== undefined) {
      deferredNotificationEvents.push(event);
    } else {
      await this.dependencies.runtimeNotifier.notifyEntry(event);
    }

    return updated;
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

}

function parseClaimForm(value: ClaimForm): ClaimForm {
  try {
    return ClaimFormSchema.parse(value);
  } catch (error) {
    throw new CoreError("VALIDATION", "Invalid claim form payload", { cause: error });
  }
}

function parseGovernanceSubject(domain: string, qualifiers: Record<string, string>) {
  try {
    return canonicalGovernanceSubject(domain, qualifiers);
  } catch (error) {
    throw new CoreError("VALIDATION", "Invalid governance subject input", { cause: error });
  }
}

function createClaimCreatedEventInput(claim: Readonly<ClaimForm>): Omit<EventLogEntry, "event_id" | "created_at" | "revision"> {
  return {
    event_type: MemoryGovernanceEventType.SOUL_CLAIM_CREATED,
    entity_type: "claim_form",
    entity_id: claim.object_id,
    workspace_id: claim.workspace_id,
    run_id: null,
    caused_by: claim.created_by,
    payload_json: SoulClaimCreatedPayloadSchema.parse({
      object_id: claim.object_id,
      object_kind: claim.object_kind,
      workspace_id: claim.workspace_id,
      run_id: null
    })
  };
}

function parseReason(value: string): string {
  if (value.trim().length === 0) {
    throw new CoreError("VALIDATION", "Reason is required");
  }

  return value;
}

function parseClaimLifecycleState(value: ClaimLifecycleStateType): ClaimLifecycleStateType {
  try {
    return ClaimLifecycleStateSchema.parse(value);
  } catch (error) {
    throw new CoreError("VALIDATION", "Invalid claim lifecycle state", { cause: error });
  }
}

function parseTransitionCausedBy(value: TransitionCausedByType): TransitionCausedByType {
  try {
    return TransitionCausedBySchema.parse(value);
  } catch (error) {
    throw new CoreError("VALIDATION", "Invalid transition caused_by", { cause: error });
  }
}

function ensureAllowedLifecycleTransition(
  from: ClaimLifecycleStateType,
  to: ClaimLifecycleStateType
): void {
  if (!isValidClaimTransition(from, to)) {
    throw new CoreError("VALIDATION", `Invalid claim lifecycle transition: ${from} -> ${to}`);
  }
}
