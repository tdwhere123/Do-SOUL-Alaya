import {
  compareUtcInstants,
  GovernanceResolutionPayloadSchema,
  GovernanceConfirmElectionCompletedPayloadSchema,
  GovernanceResolutionEventType,
  RESOLUTION_KIND_TO_EVENT_TYPE,
  type ClaimForm,
  type EventLogEntry
} from "@do-soul/alaya-protocol";
import { randomUUID } from "node:crypto";
import { CoreError } from "../../shared/errors.js";
import type { ResolveInput, ResolveOutcome, ResolutionServiceDependencies } from "./resolution-service-types.js";
import type { ElectionTransactionGuard } from "../claims/claim-service-types.js";

/** Only the original delivery and reviewer may resume an already committed confirmation. */
export async function recoverConfirmedElection(
  input: ResolveInput,
  claim: Readonly<ClaimForm>,
  deps: ResolutionServiceDependencies
): Promise<ResolveOutcome> {
  const result = await findConfirmedElection(input, claim, deps, true);
  if (result === null) {
    throw new CoreError("CONFLICT", `Claim form ${claim.object_id} is not in draft (current: ${claim.claim_status})`);
  }
  return result;
}

/** A concurrent first caller may still own election; report its committed confirmation without running another. */
export async function findConcurrentConfirmation(
  input: ResolveInput, claim: Readonly<ClaimForm>, deps: ResolutionServiceDependencies
): Promise<ResolveOutcome | null> {
  return await findConfirmedElection(input, claim, deps, false);
}

async function findConfirmedElection(
  input: ResolveInput, claim: Readonly<ClaimForm>, deps: ResolutionServiceDependencies, resume: boolean
): Promise<ResolveOutcome | null> {
  const entries = await deps.resolutionAuditRepo.queryByEntityAll("soul_resolution", claim.object_id);
  const entry = entries.find((candidate) => matchesConfirmation(candidate, input));
  if (entry === undefined) return null;
  let electionStatus: NonNullable<ResolveOutcome["electionStatus"]> = "completed";
  if (!entries.some(candidate => matchesCompletedElection(candidate, entry, input))) {
    if (!resume) {
      electionStatus = "pending";
    } else {
      electionStatus = await runConfirmedElection(input, entry, deps);
    }
  }
  return {
    resolution: input.resolution,
    status: "applied",
    auditEventType: entry.event_type,
    auditEventId: entry.event_id,
    activatedClaimId: claim.object_id,
    effectDecision: "allow",
    electionStatus
  };
}

async function persistElectionCompletion(
  input: ResolveInput,
  confirmation: Readonly<EventLogEntry>,
  deps: ResolutionServiceDependencies,
  transactionGuard?: ElectionTransactionGuard
): Promise<"completed" | "pending"> {
  const reviewerIdentity = input.reviewerIdentity ?? input.agentTarget;
  try {
    if (deps.eventPublisher.getStorageConnectionIdentity() !== deps.resolutionAuditRepo.getStorageConnectionIdentity()) {
      throw new CoreError("CONFLICT", "election completion audit requires the EventLog transaction connection");
    }
    const event = {
      event_type: GovernanceResolutionEventType.SOUL_RESOLUTION_CONFIRM_ELECTION_COMPLETED,
      entity_type: "soul_resolution", entity_id: input.targetObjectId, workspace_id: input.workspaceId,
      run_id: input.runId, caused_by: reviewerIdentity,
      payload_json: GovernanceConfirmElectionCompletedPayloadSchema.parse({
        confirmation_event_id: confirmation.event_id, target_object_id: input.targetObjectId,
        workspace_id: input.workspaceId, run_id: input.runId, agent_target: input.agentTarget,
        delivery_id: input.deliveryId, reviewer_identity: reviewerIdentity,
        occurred_at: deps.now?.() ?? new Date().toISOString()
      })
    } as const;
    await deps.eventPublisher.mutateThenAppendMany(() => {
      transactionGuard?.(deps.eventPublisher.getStorageConnectionIdentity());
      const existing = deps.resolutionAuditRepo.queryByEntityInCurrentTransaction("soul_resolution", input.targetObjectId);
      return { events: existing.some(candidate => matchesCompletedElection(candidate, confirmation, input)) ? [] : [event],
        result: undefined };
    });
    return "completed";
  } catch {
    // Election already ran; a missing completion fact is recoverable by the original caller.
    try {
      const entries = await deps.resolutionAuditRepo.queryByEntityAll("soul_resolution", input.targetObjectId);
      if (entries.some(candidate => matchesCompletedElection(candidate, confirmation, input))) return "completed";
    } catch { /* Preserve pending when the completion fact cannot be read. */ }
    return "pending";
  }
}

export function requireElectionLease(deps: ResolutionServiceDependencies): NonNullable<ResolutionServiceDependencies["electionLease"]> {
  const lease = deps.electionLease;
  if (lease === undefined || lease.getStorageConnectionIdentity() !== deps.eventPublisher.getStorageConnectionIdentity() ||
      lease.getStorageConnectionIdentity() !== deps.resolutionAuditRepo.getStorageConnectionIdentity() ||
      lease.getStorageConnectionIdentity() !== deps.claimRepo.getStorageConnectionIdentity?.() ||
      lease.getStorageConnectionIdentity() !== deps.claimService.getStorageConnectionIdentity?.() ||
      lease.getStorageConnectionIdentity() !== deps.claimService.getEventPublisherConnectionIdentity?.() ||
      deps.claimRepo.findByIdSync === undefined) {
    throw new CoreError("CONFLICT", "Claim election requires lease, claim and EventLog on one transaction connection");
  }
  return lease;
}

/** Lease ownership is rechecked inside every SQLite mutation; expiry permits safe takeover. */
export async function runConfirmedElection(
  input: ResolveInput, confirmation: Readonly<EventLogEntry>, deps: ResolutionServiceDependencies
): Promise<"completed" | "failed" | "pending"> {
  const now = deps.electionNow ?? (() => new Date().toISOString());
  const owner = randomUUID();
  const key = `claim-election:${JSON.stringify([input.workspaceId, input.targetObjectId])}`;
  let lease: NonNullable<ResolutionServiceDependencies["electionLease"]>;
  try {
    lease = requireElectionLease(deps);
    const acquiredAt = now();
    const expires = new Date(Date.parse(acquiredAt) + (deps.electionLeaseTtlMs ?? 300_000)).toISOString();
    if (lease.tryAcquire(key, owner, acquiredAt, expires) === null) return "pending";
  } catch {
    // Activation is already committed; lease storage failure is recoverable.
    return "pending";
  }
  const guard: ElectionTransactionGuard = connectionIdentity => {
    if (connectionIdentity === undefined || connectionIdentity !== lease.getStorageConnectionIdentity()) {
      throw new CoreError("CONFLICT", "Election mutation uses a different SQLite connection");
    }
    const current = lease.findByKey(key);
    if (current?.owner_token !== owner || compareUtcInstants(current.expires_at, now()) !== 1) {
      throw new CoreError("CONFLICT", "Claim election lease was lost");
    }
    const claim = deps.claimRepo.findByIdSync!(input.targetObjectId);
    if (claim === null || claim.workspace_id !== input.workspaceId ||
        !["active", "contested", "winner", "superseded"].includes(claim.claim_status)) {
      throw new CoreError("CONFLICT", "Claim no longer permits election completion");
    }
  };
  try {
    // A prior owner may have completed between our first read and lease acquisition.
    const entries = await deps.resolutionAuditRepo.queryByEntityAll("soul_resolution", input.targetObjectId);
    if (entries.some(candidate => matchesCompletedElection(candidate, confirmation, input))) return "completed";
    await deps.claimService.resumeActivationElection(input.targetObjectId, guard);
    return await persistElectionCompletion(input, confirmation, deps, guard);
  } catch {
    // A takeover may have completed while this owner was paused or failing.
    try {
      const entries = await deps.resolutionAuditRepo.queryByEntityAll("soul_resolution", input.targetObjectId);
      if (entries.some(candidate => matchesCompletedElection(candidate, confirmation, input))) return "completed";
    } catch { /* The committed activation remains visible as a failed election attempt. */ }
    return "failed";
  } finally {
    try { lease.release(key, owner); } catch { /* Expiry permits recovery. */ }
  }
}

function matchesCompletedElection(entry: EventLogEntry, confirmation: EventLogEntry, input: ResolveInput): boolean {
  if (entry.event_type !== GovernanceResolutionEventType.SOUL_RESOLUTION_CONFIRM_ELECTION_COMPLETED ||
      entry.workspace_id !== input.workspaceId || entry.run_id !== input.runId ||
      entry.caused_by !== (input.reviewerIdentity ?? input.agentTarget)) return false;
  const result = GovernanceConfirmElectionCompletedPayloadSchema.safeParse(entry.payload_json);
  if (!result.success) return false;
  const payload = result.data;
  return payload.confirmation_event_id === confirmation.event_id && payload.target_object_id === input.targetObjectId &&
    payload.workspace_id === input.workspaceId && payload.run_id === input.runId && payload.agent_target === input.agentTarget &&
    payload.delivery_id === input.deliveryId && payload.reviewer_identity === (input.reviewerIdentity ?? input.agentTarget);
}

function matchesConfirmation(entry: EventLogEntry, input: ResolveInput): boolean {
  if (entry.event_type !== RESOLUTION_KIND_TO_EVENT_TYPE.confirm || entry.workspace_id !== input.workspaceId ||
      entry.run_id !== input.runId || entry.caused_by !== (input.reviewerIdentity ?? input.agentTarget)) return false;
  const result = GovernanceResolutionPayloadSchema.safeParse(entry.payload_json);
  if (!result.success) return false;
  const payload = result.data;
  return payload.resolution === "confirm" && payload.target_object_id === input.targetObjectId &&
    payload.activated_claim_id === input.targetObjectId && payload.workspace_id === input.workspaceId &&
    payload.run_id === input.runId && payload.agent_target === input.agentTarget &&
    payload.delivery_id === input.deliveryId && payload.policy === (input.policy ?? null) &&
    payload.policy_classification === (input.policyClassification ?? null) && payload.reason === (input.reason ?? null);
}
