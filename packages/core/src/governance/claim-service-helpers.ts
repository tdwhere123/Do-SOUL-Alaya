import {
  ClaimFormSchema,
  ClaimLifecycleState,
  ClaimLifecycleStateSchema,
  MemoryGovernanceEventType,
  PrecedenceBasis,
  SoulClaimCreatedPayloadSchema,
  SoulClaimLifecycleChangedPayloadSchema,
  TransitionCausedBySchema,
  canonicalGovernanceSubject,
  isValidClaimTransition,
  type ClaimForm,
  type ClaimLifecycleState as ClaimLifecycleStateType,
  type EventLogEntry,
  type PrecedenceBasis as PrecedenceBasisType,
  type TransitionCausedBy as TransitionCausedByType
} from "@do-soul/alaya-protocol";
import { CoreError } from "../shared/errors.js";
import type { EventPublisherInput } from "../runtime/event-publisher.js";
import type { PrecedenceBasisDecisionInput } from "./claim-service-types.js";

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

export function parseClaimForm(value: ClaimForm): ClaimForm {
  try {
    return ClaimFormSchema.parse(value);
  } catch (error) {
    throw new CoreError("VALIDATION", "Invalid claim form payload", { cause: error });
  }
}

export function parseGovernanceSubject(
  domain: string,
  qualifiers: Record<string, string>
) {
  try {
    return canonicalGovernanceSubject(domain, qualifiers);
  } catch (error) {
    throw new CoreError("VALIDATION", "Invalid governance subject input", { cause: error });
  }
}

export function createClaimCreatedEventInput(
  claim: Readonly<ClaimForm>
): Omit<EventLogEntry, "event_id" | "created_at" | "revision"> {
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

export function parseReason(value: string): string {
  if (value.trim().length === 0) {
    throw new CoreError("VALIDATION", "Reason is required");
  }

  return value;
}

export function parseClaimLifecycleState(
  value: ClaimLifecycleStateType
): ClaimLifecycleStateType {
  try {
    return ClaimLifecycleStateSchema.parse(value);
  } catch (error) {
    throw new CoreError("VALIDATION", "Invalid claim lifecycle state", { cause: error });
  }
}

export function parseTransitionCausedBy(
  value: TransitionCausedByType
): TransitionCausedByType {
  try {
    return TransitionCausedBySchema.parse(value);
  } catch (error) {
    throw new CoreError("VALIDATION", "Invalid transition caused_by", { cause: error });
  }
}

export function ensureAllowedLifecycleTransition(
  from: ClaimLifecycleStateType,
  to: ClaimLifecycleStateType
): void {
  if (!isValidClaimTransition(from, to)) {
    throw new CoreError("VALIDATION", `Invalid claim lifecycle transition: ${from} -> ${to}`);
  }
}

export function shouldRunSlotElection(
  existing: Readonly<ClaimForm>,
  newState: ClaimLifecycleStateType,
  skipSlotElection: boolean
): boolean {
  return (
    !skipSlotElection &&
    newState === ClaimLifecycleState.ACTIVE &&
    existing.claim_status === ClaimLifecycleState.DRAFT
  );
}

export function createLifecycleChangedEventInput(
  existing: Readonly<ClaimForm>,
  newState: ClaimLifecycleStateType,
  reason: string,
  causedBy: TransitionCausedByType,
  occurredAt: string
): EventPublisherInput {
  return {
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
  };
}

export function collectAdditionalEvents(
  persistedEntries: readonly EventLogEntry[],
  additionalEventCount: number,
  additionalEventsSink: EventLogEntry[] | undefined
): void {
  if (additionalEventsSink === undefined) {
    return;
  }

  for (let index = 0; index < additionalEventCount; index += 1) {
    const persisted = persistedEntries[index + 1];
    if (persisted !== undefined) {
      additionalEventsSink.push(persisted);
    }
  }
}

export function assertNoAdditionalEventInputs(
  additionalEventInputs: readonly EventPublisherInput[]
): void {
  if (additionalEventInputs.length > 0) {
    throw new CoreError(
      "CONFLICT",
      "Atomic claim transition with additional audit events is not available"
    );
  }
}
