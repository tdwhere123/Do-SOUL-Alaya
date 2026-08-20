import {
  EffectRequestSchema,
  MemoryGovernanceEventType,
  PROOF_EFFECT_OPERATOR_ID,
  PROOF_EFFECT_OPERATOR_VERSION,
  hashEffectGovernanceFrontier,
  hashLabeledIdentity,
  type EffectDecisionReceipt,
  type EventLogEntry,
  type ProofEffectWitness
} from "@do-soul/alaya-protocol";
import {
  ProofCarryingEffectOwner,
  buildEffectAuditEventInput,
  fieldContractSha256,
  type EffectDecisionStore,
  type ProofEffectLookup,
  type ProofRecord
} from "@do-soul/alaya-core";
import type { ProposalResolutionEventInput } from "../proposal-workflow-types.js";

export type PrivacyEffectLookup = Pick<
  ProofEffectLookup,
  "isErased" | "isBridgeRevoked" | "competingClaims"
>;

export function createPrivacyEffectLookup(erase: Readonly<{
  isErased(workspaceId: string, subjectId: string): boolean;
}>): PrivacyEffectLookup {
  return {
    isErased: (workspaceId, target) => erase.isErased(workspaceId, target),
    isBridgeRevoked: () => false,
    competingClaims: () => []
  };
}

export function authorizePrivacyErase(input: Readonly<{
  readonly store: EffectDecisionStore;
  readonly lookup: PrivacyEffectLookup;
  readonly storedReviewEvents: readonly EventLogEntry[];
  readonly proposalId: string;
  readonly workspaceId: string;
  readonly targetObjectId: string;
  readonly reviewedAt: string;
  readonly createError: (code: "NEEDS_CONTEXT", message: string) => Error;
}>): readonly ProposalResolutionEventInput[] {
  const authorityEvent = findAuthorityEvent(input);
  const decision = decidePrivacyErase(input, authorityEvent);
  if (decision.decision !== "allow") {
    throw input.createError("NEEDS_CONTEXT", "Privacy erase hard-effect authority denied the erase.");
  }
  input.store.insert(decision);
  return [buildEffectAuditEventInput(decision)];
}

function findAuthorityEvent(input: Readonly<{
  readonly storedReviewEvents: readonly EventLogEntry[];
  readonly proposalId: string;
  readonly workspaceId: string;
  readonly createError: (code: "NEEDS_CONTEXT", message: string) => Error;
}>): EventLogEntry & { readonly run_id: string; readonly caused_by: string } {
  const event = input.storedReviewEvents.find((candidate) =>
    candidate.event_type === MemoryGovernanceEventType.SOUL_REVIEW_COMPLETED &&
    candidate.entity_type === "proposal" && candidate.entity_id === input.proposalId &&
    candidate.workspace_id === input.workspaceId && candidate.run_id !== null &&
    candidate.caused_by !== null
  );
  if (event === undefined || event.run_id === null || event.caused_by === null) {
    throw input.createError(
      "NEEDS_CONTEXT",
      "Privacy erase requires a run-bound durable review authority event."
    );
  }
  return event as EventLogEntry & { readonly run_id: string; readonly caused_by: string };
}

function decidePrivacyErase(
  input: Readonly<{
    readonly lookup: PrivacyEffectLookup;
    readonly workspaceId: string;
    readonly proposalId: string;
    readonly targetObjectId: string;
    readonly reviewedAt: string;
  }>,
  authorityEvent: EventLogEntry & { readonly run_id: string; readonly caused_by: string }
): EffectDecisionReceipt {
  const proofs = privacyProofs(input, authorityEvent);
  const witnesses = proofs.map((proof) => proofWitness(proof, authorityEvent.event_id));
  const request = EffectRequestSchema.parse({
    schema_version: 2,
    workspace_id: input.workspaceId,
    actor_id: authorityEvent.caused_by,
    run_id: authorityEvent.run_id,
    delivery_id: input.proposalId,
    action: "erase",
    target: input.targetObjectId,
    scope: input.workspaceId,
    effective_as_of: input.reviewedAt,
    supporting_receipt_ids: proofs.map((proof) => proof.id),
    supporting_proof_witnesses: witnesses,
    governance_frontier: hashEffectGovernanceFrontier(witnesses, fieldContractSha256),
    policy_operator_id: PROOF_EFFECT_OPERATOR_ID,
    policy_operator_version: PROOF_EFFECT_OPERATOR_VERSION
  });
  return new ProofCarryingEffectOwner({
    lookup: {
      findReceipts: (workspaceId, ids) => proofs.filter((proof) =>
        proof.workspace_id === workspaceId && ids.includes(proof.id)),
      isBridgeRevoked: input.lookup.isBridgeRevoked,
      competingClaims: input.lookup.competingClaims,
      isErased: input.lookup.isErased
    },
    now: () => input.reviewedAt,
    sha256: fieldContractSha256
  }).decide(request);
}

function privacyProofs(
  input: Readonly<{
    readonly workspaceId: string;
    readonly proposalId: string;
    readonly targetObjectId: string;
    readonly reviewedAt: string;
  }>,
  event: EventLogEntry & { readonly run_id: string; readonly caused_by: string }
): readonly ProofRecord[] {
  const base = {
    workspace_id: input.workspaceId,
    target: input.targetObjectId,
    scope: input.workspaceId,
    recorded_at: input.reviewedAt,
    event_time: input.reviewedAt,
    valid_from: input.reviewedAt,
    valid_to: null
  } as const;
  return [
    { ...base, id: proofId("actor_authority", input, event), kind: "actor_authority",
      actor_id: event.caused_by, run_id: event.run_id, delivery_id: input.proposalId },
    { ...base, id: proofId("confirmation", input, event), kind: "confirmation" }
  ];
}

function proofId(
  kind: string,
  input: Readonly<{ readonly workspaceId: string; readonly proposalId: string; readonly targetObjectId: string }>,
  event: EventLogEntry
): string {
  return hashLabeledIdentity("privacy_erase_proof", [
    kind, input.workspaceId, input.proposalId, input.targetObjectId, event.event_id
  ], fieldContractSha256);
}

function proofWitness(proof: ProofRecord, authorityEventId: string): ProofEffectWitness {
  return {
    receipt_id: proof.id,
    kind: proof.kind,
    authority_event_id: authorityEventId,
    source_record_id: null,
    source_content_digest: null
  };
}
