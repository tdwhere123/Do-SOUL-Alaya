import { randomUUID } from "node:crypto";
import {
  ClaimFormSchema,
  SlotEventType,
  SlotSchema,
  SoulSlotCreatedPayloadSchema,
  SoulSlotWinnerChangedPayloadSchema,
  TransitionCausedBy,
  TransitionCausedBySchema,
  type ClaimForm,
  type EventLogEntry,
  type ScopeClass,
  type Slot,
  type TransitionCausedBy as TransitionCausedByType
} from "@do-soul/alaya-protocol";
import { CoreError } from "../shared/errors.js";
import { bindEventPublisher, type EventPublisher } from "../runtime/event-publisher.js";
import { parseObjectId } from "../shared/validators.js";
import type { ElectionTransactionGuard } from "../governance/claims/claim-service-types.js";

export type SlotElectionDecision = "new_slot_created" | "auto_won" | "contested" | "no_change";

export type SlotElectionResult = {
  readonly slot: Readonly<Slot>;
  readonly decision: SlotElectionDecision;
  readonly reason: string;
};

export interface SlotServiceSlotRepoPort {
  getStorageConnectionIdentity?(): object;
  create(slot: Readonly<Slot>, subjectClaimId?: string): Readonly<Slot>;
  findById(objectId: string): Promise<Readonly<Slot> | null>;
  findByUniqueKey(
    canonicalKey: string,
    claimKind: Slot["claim_kind"],
    scopeClass: Slot["scope_class"],
    workspaceId: string
  ): Promise<Readonly<Slot> | null>;
  findByWorkspace(workspaceId: string): Promise<readonly Readonly<Slot>[]>;
  findByWinnerClaimId(claimId: string): Promise<Readonly<Slot> | null>;
  updateWinner(
    objectId: string,
    winnerClaimId: string | null,
    incumbentSince: string | null,
    updatedAt: string,
    expectedWinnerClaimId: string | null
  ): Readonly<Slot>;
}

export interface SlotServiceEventLogRepoPort {
  append(entry: Omit<EventLogEntry, "event_id" | "created_at" | "revision">): EventLogEntry | Promise<EventLogEntry>;
  queryByEntity(entityType: string, entityId: string): Promise<readonly EventLogEntry[]>;
  transactional<T>(fn: () => T): T;
}


export interface SlotServiceArbitrationResult {
  readonly slot: Readonly<Slot>;
  readonly decision: "winner_changed" | "contested" | "no_change";
  readonly winner_claim_id: string | null;
  readonly contested_claim_ids: readonly string[];
  readonly reason: string;
}

export interface SlotServiceArbitrationServicePort {
  arbitrateSlot(
    slotId: string,
    options?: {
      readonly dryRun?: boolean;
      readonly transactionGuard?: ElectionTransactionGuard;
    }
  ): Promise<SlotServiceArbitrationResult>;
}
export interface SlotRuntimeNotifierPort {
  notifyEntry(entry: EventLogEntry): void | Promise<void>;
}

export interface SlotServiceDependencies {
  readonly slotRepo: SlotServiceSlotRepoPort;
  readonly eventLogRepo: SlotServiceEventLogRepoPort;
  readonly eventPublisher?: EventPublisher;
  readonly runtimeNotifier: SlotRuntimeNotifierPort;
  readonly arbitrationService?: SlotServiceArbitrationServicePort;
  readonly generateObjectId?: () => string;
  readonly now?: () => string;
}

const scopePriority: Readonly<Record<ScopeClass, number>> = {
  project: 3,
  global_domain: 2,
  global_core: 1
};

const defaultFlipConditions: Slot["flip_conditions"] = [
  {
    condition_kind: "stronger_evidence",
    description: "Challenger has significantly stronger evidence.",
    threshold: null
  },
  {
    condition_kind: "higher_authority",
    description: "Challenger has higher authority in origin_tier or precedence_basis.",
    threshold: null
  },
  {
    condition_kind: "user_override",
    description: "User explicitly overrides incumbent winner.",
    threshold: null
  },
  {
    condition_kind: "scope_escalation",
    description: "Cross-scope challenger with higher scope class supersedes incumbent.",
    threshold: null
  },
  {
    condition_kind: "time_decay",
    description: "Incumbent becomes stale over time.",
    threshold: null
  }
] as const;

export class SlotService {
  private readonly generateObjectId: () => string;
  private readonly now: () => string;

  public constructor(private readonly dependencies: SlotServiceDependencies) {
    this.generateObjectId = dependencies.generateObjectId ?? (() => randomUUID());
    this.now = dependencies.now ?? (() => new Date().toISOString());
  }

  public async onClaimActivated(
    claim: Readonly<ClaimForm>,
    deferredNotifyEvents?: EventLogEntry[],
    transactionGuard?: ElectionTransactionGuard,
    activeClaimGuard?: ElectionTransactionGuard
  ): Promise<SlotElectionResult> {
    const parsedClaim = parseClaim(claim);
    if (transactionGuard !== undefined) this.guardElectionMutation(this.eventPublisher(), transactionGuard);

    if (parsedClaim.claim_status !== "active") {
      throw new CoreError("VALIDATION", "Slot election requires claim_status=active");
    }

    const sameScopeSlot = await this.dependencies.slotRepo.findByUniqueKey(
      parsedClaim.governance_subject.canonical_key,
      parsedClaim.claim_kind,
      parsedClaim.scope_class,
      parsedClaim.workspace_id
    );

    if (sameScopeSlot !== null) {
      return await this.evaluateSameScopeElection(sameScopeSlot, parsedClaim, deferredNotifyEvents, transactionGuard, activeClaimGuard);
    }

    const relatedSlots = await this.findRelatedSlots(parsedClaim);

    if (relatedSlots.length === 0) {
      const created = await this.createSlotForClaim(parsedClaim, deferredNotifyEvents, transactionGuard, activeClaimGuard);
      return {
        slot: created,
        decision: "new_slot_created",
        reason: "first_claim_for_subject"
      };
    }

    return await this.evaluateCrossScopeElection(relatedSlots, parsedClaim, deferredNotifyEvents, transactionGuard, activeClaimGuard);
  }

  /** Re-run arbitration when a previous election committed only some contested transitions. */
  public async resumeContestedElection(claim: Readonly<ClaimForm>, transactionGuard?: ElectionTransactionGuard): Promise<SlotElectionResult> {
    const parsed = parseClaim(claim);
    if (transactionGuard !== undefined) this.guardElectionMutation(this.eventPublisher(), transactionGuard);
    if (parsed.claim_status !== "contested") throw new CoreError("VALIDATION", "Claim is not contested");
    const slot = await this.dependencies.slotRepo.findByUniqueKey(
      parsed.governance_subject.canonical_key, parsed.claim_kind, parsed.scope_class, parsed.workspace_id
    );
    if (slot === null || this.dependencies.arbitrationService === undefined) {
      throw new CoreError("CONFLICT", "Contested election recovery is unavailable");
    }
    const result = transactionGuard === undefined
      ? await this.dependencies.arbitrationService.arbitrateSlot(slot.object_id)
      : await this.dependencies.arbitrationService.arbitrateSlot(slot.object_id, { transactionGuard });
    return {
      slot: result.slot,
      decision: result.decision === "contested" ? "contested" :
        result.decision === "winner_changed" && result.winner_claim_id === parsed.object_id ? "auto_won" : "no_change",
      reason: result.reason
    };
  }

  public async findByWorkspace(workspaceId: string): Promise<readonly Readonly<Slot>[]> {
    return await this.dependencies.slotRepo.findByWorkspace(workspaceId);
  }

  public async findById(objectId: string, workspaceId: string): Promise<Readonly<Slot>> {
    const parsedObjectId = parseObjectId(objectId);
    const slot = await this.dependencies.slotRepo.findById(parsedObjectId);

    // Cross-workspace slots are indistinguishable from missing ones.
    if (slot === null || slot.workspace_id !== workspaceId) {
      throw new CoreError("NOT_FOUND", "Slot not found");
    }

    return slot;
  }

  private async findRelatedSlots(claim: Readonly<ClaimForm>): Promise<readonly Readonly<Slot>[]> {
    const workspaceSlots = await this.dependencies.slotRepo.findByWorkspace(claim.workspace_id);

    return workspaceSlots.filter(
      (slot) =>
        slot.claim_kind === claim.claim_kind &&
        slot.governance_subject.canonical_key === claim.governance_subject.canonical_key
    );
  }

  private async evaluateSameScopeElection(
    existingSlot: Readonly<Slot>,
    claim: Readonly<ClaimForm>,
    deferredNotifyEvents?: EventLogEntry[],
    transactionGuard?: ElectionTransactionGuard,
    activeClaimGuard?: ElectionTransactionGuard
  ): Promise<SlotElectionResult> {
    if (existingSlot.winner_claim_id === claim.object_id) {
      return {
        slot: existingSlot,
        decision: "no_change",
        reason: "already_incumbent"
      };
    }

    if (existingSlot.winner_claim_id === null) {
      const updated = await this.changeWinner(existingSlot, claim.object_id, "seed_winner", TransitionCausedBy.SYSTEM, deferredNotifyEvents, transactionGuard, activeClaimGuard);
      return {
        slot: updated,
        decision: "auto_won",
        reason: "seed_winner"
      };
    }

    if (claim.precedence_basis === "user_override") {
      const updated = await this.changeWinner(
        existingSlot,
        claim.object_id,
        "user_override",
        TransitionCausedBy.REVIEW,
        deferredNotifyEvents,
        transactionGuard,
        activeClaimGuard
      );
      return {
        slot: updated,
        decision: "auto_won",
        reason: "user_override"
      };
    }

    const arbitrationService = this.dependencies.arbitrationService;

    if (arbitrationService !== undefined) {
      const arbitrationResult = transactionGuard === undefined
        ? await arbitrationService.arbitrateSlot(existingSlot.object_id)
        : await arbitrationService.arbitrateSlot(existingSlot.object_id, { transactionGuard });

      if (arbitrationResult.decision === "winner_changed") {
        if (arbitrationResult.winner_claim_id === claim.object_id) {
          return {
            slot: arbitrationResult.slot,
            decision: "auto_won",
            reason: arbitrationResult.reason
          };
        }

        return {
          slot: arbitrationResult.slot,
          decision: "no_change",
          reason: arbitrationResult.reason
        };
      }

      if (arbitrationResult.decision === "contested") {
        return {
          slot: arbitrationResult.slot,
          decision: "contested",
          reason: arbitrationResult.reason
        };
      }

      return {
        slot: arbitrationResult.slot,
        decision: "no_change",
        reason: arbitrationResult.reason
      };
    }

    return {
      slot: existingSlot,
      decision: "contested",
      reason: "same_scope_conflict_requires_review"
    };
  }

  private async evaluateCrossScopeElection(
    relatedSlots: readonly Readonly<Slot>[],
    claim: Readonly<ClaimForm>,
    deferredNotifyEvents?: EventLogEntry[],
    transactionGuard?: ElectionTransactionGuard,
    activeClaimGuard?: ElectionTransactionGuard
  ): Promise<SlotElectionResult> {
    const incumbent = selectHighestScopeSlot(relatedSlots);

    if (incumbent === null) {
      const created = await this.createSlotForClaim(claim, deferredNotifyEvents, transactionGuard, activeClaimGuard);
      return {
        slot: created,
        decision: "new_slot_created",
        reason: "first_claim_for_subject"
      };
    }

    const challengerPriority = scopePriority[claim.scope_class];
    const incumbentPriority = scopePriority[incumbent.scope_class];

    if (challengerPriority > incumbentPriority) {
      const created = await this.createSlotForClaim(claim, deferredNotifyEvents, transactionGuard, activeClaimGuard);
      return {
        slot: created,
        decision: "auto_won",
        reason: "scope_escalation"
      };
    }

    return {
      slot: incumbent,
      decision: "no_change",
      reason: "lower_or_equal_scope_challenger"
    };
  }

  private async createSlotForClaim(claim: Readonly<ClaimForm>, deferredNotifyEvents?: EventLogEntry[], transactionGuard?: ElectionTransactionGuard, activeClaimGuard?: ElectionTransactionGuard): Promise<Readonly<Slot>> {
    const now = this.now();
    const slot = parseSlot({
      object_id: this.generateObjectId(),
      object_kind: "slot",
      schema_version: 1,
      lifecycle_state: "active",
      created_at: now,
      updated_at: now,
      created_by: claim.created_by,
      governance_subject: claim.governance_subject,
      claim_kind: claim.claim_kind,
      scope_class: claim.scope_class,
      winner_claim_id: claim.object_id,
      incumbent_since: now,
      flip_conditions: defaultFlipConditions,
      workspace_id: claim.workspace_id
    });
    const eventInput = {
      event_type: SlotEventType.SOUL_SLOT_CREATED,
      entity_type: "slot",
      entity_id: slot.object_id,
      workspace_id: slot.workspace_id,
      run_id: null,
      caused_by: slot.created_by,
      payload_json: SoulSlotCreatedPayloadSchema.parse({
        object_id: slot.object_id,
        object_kind: slot.object_kind,
        workspace_id: slot.workspace_id,
        run_id: null,
        governance_subject: slot.governance_subject,
        claim_kind: slot.claim_kind,
        scope_class: slot.scope_class,
        winner_claim_id: slot.winner_claim_id
      })
    };
    const publisher = this.eventPublisher();
    return await publisher.appendManyWithMutation([eventInput], (entries) => {
      this.guardElectionMutation(publisher, transactionGuard, activeClaimGuard);
      const created = this.dependencies.slotRepo.create(slot, claim.object_id);
      const event = entries[0];
      if (event !== undefined) {
        deferredNotifyEvents?.push(event);
      }
      return created;
    });
  }

  private async changeWinner(
    slot: Readonly<Slot>,
    winnerClaimId: string,
    reasonCode: string,
    causedBy: TransitionCausedByType,
    deferredNotifyEvents?: EventLogEntry[],
    transactionGuard?: ElectionTransactionGuard,
    activeClaimGuard?: ElectionTransactionGuard
  ): Promise<Readonly<Slot>> {
    const now = this.now();
    const parsedCausedBy = parseTransitionCausedBy(causedBy);
    const eventInput = {
      event_type: SlotEventType.SOUL_SLOT_WINNER_CHANGED,
      entity_type: "slot",
      entity_id: slot.object_id,
      workspace_id: slot.workspace_id,
      run_id: null,
      caused_by: parsedCausedBy,
      payload_json: SoulSlotWinnerChangedPayloadSchema.parse({
        object_id: slot.object_id,
        object_kind: slot.object_kind,
        workspace_id: slot.workspace_id,
        run_id: null,
        from_claim_id: slot.winner_claim_id,
        to_claim_id: winnerClaimId,
        reason_code: reasonCode,
        caused_by: parsedCausedBy,
        evidence_refs: null,
        occurred_at: now
      })
    };
    const publisher = this.eventPublisher();
    return await publisher.appendManyWithMutation([eventInput], (entries) => {
      this.guardElectionMutation(publisher, transactionGuard, activeClaimGuard);
      const updated = this.dependencies.slotRepo.updateWinner(slot.object_id, winnerClaimId, now, now, slot.winner_claim_id);
      const event = entries[0];
      if (event !== undefined) {
        deferredNotifyEvents?.push(event);
      }
      return updated;
    });
  }

  private guardElectionMutation(publisher: EventPublisher, guard?: ElectionTransactionGuard, active?: ElectionTransactionGuard): void {
    if (guard === undefined && active === undefined) return;
    const identity = publisher.getStorageConnectionIdentity();
    guard?.(identity);
    active?.(identity);
    if (identity === undefined || this.dependencies.slotRepo.getStorageConnectionIdentity?.() !== identity) {
      throw new CoreError("CONFLICT", "Slot mutation requires the election transaction connection");
    }
  }

  private eventPublisher() {
    return bindEventPublisher({
      eventPublisher: this.dependencies.eventPublisher,
      eventLogRepo: this.dependencies.eventLogRepo,
      runtimeNotifier: this.dependencies.runtimeNotifier,
      purpose: "SlotService"
    });
  }
}

function selectHighestScopeSlot(slots: readonly Readonly<Slot>[]): Readonly<Slot> | null {
  if (slots.length === 0) {
    return null;
  }

  let selected: Readonly<Slot> | null = null;

  for (const slot of slots) {
    if (selected === null) {
      selected = slot;
      continue;
    }

    if (scopePriority[slot.scope_class] > scopePriority[selected.scope_class]) {
      selected = slot;
      continue;
    }

    if (
      scopePriority[slot.scope_class] === scopePriority[selected.scope_class] &&
      slot.created_at < selected.created_at
    ) {
      selected = slot;
    }
  }

  return selected;
}

function parseSlot(value: Slot): Slot {
  try {
    return SlotSchema.parse(value);
  } catch (error) {
    throw new CoreError("VALIDATION", "Invalid slot payload", { cause: error });
  }
}

function parseClaim(value: ClaimForm): ClaimForm {
  try {
    return ClaimFormSchema.parse(value);
  } catch (error) {
    throw new CoreError("VALIDATION", "Invalid claim payload", { cause: error });
  }
}

function parseTransitionCausedBy(value: TransitionCausedByType): TransitionCausedByType {
  try {
    return TransitionCausedBySchema.parse(value);
  } catch (error) {
    throw new CoreError("VALIDATION", "Invalid transition caused_by", { cause: error });
  }
}
