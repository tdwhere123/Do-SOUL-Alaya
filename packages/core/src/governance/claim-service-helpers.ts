import {
  ClaimFormSchema,
  ClaimLifecycleStateSchema,
  MemoryGovernanceEventType,
  PrecedenceBasis,
  SoulClaimCreatedPayloadSchema,
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
