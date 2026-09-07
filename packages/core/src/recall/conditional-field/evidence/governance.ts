import {
  getPathAnchorBackingObjectId,
  isPathActiveForRecall,
  isRelationValidityActiveAt
} from "@do-soul/alaya-protocol";
import {
  ATTRIBUTABLE_CLAIM_STATUSES,
  REFUTING_RELATION_KINDS,
  type ClaimRead,
  type EvidenceAccess,
  type EvidenceIdentityContext,
  type EvidenceObservation,
  type EvidencePolarity,
  type GovernanceOutcome,
  type GovernanceReason,
  type OwnerObservationInput,
  type RelationAssertionRead
} from "./types.js";

export function evaluateGovernance(
  observation: EvidenceObservation,
  context: EvidenceIdentityContext
): GovernanceOutcome {
  const reason = governanceReason(observation, context);
  return {
    observation_id: observation.observation_id,
    evidence_id: observation.evidence_id,
    admitted: reason === "eligible",
    reason
  };
}

export function observationsFromOwners(input: OwnerObservationInput): readonly EvidenceObservation[] {
  const fromAssertions = input.assertions.flatMap((assertion) =>
    observationsFromAssertion(assertion, input)
  );
  const fromClaims = input.claims.flatMap((claim) => observationsFromClaim(claim, input));
  return [...fromAssertions, ...fromClaims];
}

function governanceReason(
  observation: EvidenceObservation,
  context: EvidenceIdentityContext
): GovernanceReason {
  if (observation.query_id !== context.query_id || observation.snapshot_id !== context.snapshot_id) {
    return "identity_mismatch";
  }
  if (observation.source_revision !== context.source_revision) return "source_revision_mismatch";
  // Eligible paths and explanations cannot launder ineligible or protected sources.
  if (observation.access === "protected") return "protected_source";
  if (observation.access === "ineligible") return "ineligible_source";
  if (observation.path_lifecycle !== undefined && !isPathActiveForRecall(observation.path_lifecycle)) {
    return "path_inactive";
  }
  if (observation.path_governance === "strictly_governed") return "strictly_governed";
  if (!isRelationValidityActiveAt(
    observation.validity,
    context.as_of,
    context.permitted_timeless_policy_ids
  )) {
    return "temporal_invalid";
  }
  if (!contextCompatible(observation, context)) return "incompatible_context";
  return "eligible";
}

export function contextCompatible(
  observation: Pick<
    EvidenceObservation,
    "hypothesis_id" | "binding_context" | "time_state" | "jurisdiction"
  >,
  context: Pick<
    EvidenceIdentityContext,
    "hypothesis_id" | "binding_context" | "time_state" | "jurisdiction"
  >
): boolean {
  return observation.hypothesis_id === context.hypothesis_id
    && observation.binding_context === context.binding_context
    && observation.time_state === context.time_state
    && observation.jurisdiction === context.jurisdiction;
}

function observationsFromAssertion(
  assertion: RelationAssertionRead,
  input: OwnerObservationInput
): readonly EvidenceObservation[] {
  const sourceId = getPathAnchorBackingObjectId(assertion.anchors.source_anchor);
  const targetId = getPathAnchorBackingObjectId(assertion.anchors.target_anchor);
  const sourceRevision = assertion.formation_receipt?.source_observations[0]?.source_sha256
    ?? input.source_revision;
  const polarity = polarityForRelation(assertion.relation_kind);
  return assertion.evidence_receipts.flatMap((receipt, index) => {
    const lineageId = receipt.source_event_anchor.event_id;
    return [sourceId, targetId].map((premiseId, premiseIndex) => observation({
      observation_id: `${assertion.assertion_id}:${receipt.evidence_id}:${String(index)}:${String(premiseIndex)}`,
      evidence_id: receipt.evidence_id,
      source_id: sourceId,
      source_revision: sourceRevision,
      premise_id: premiseId,
      proposition_id: assertion.assertion_id,
      polarity,
      access: resolveAccess(input.access, receipt.evidence_id, sourceId, targetId),
      validity: assertion.validity,
      lineage_id: lineageId,
      independence_key: receipt.evidence_id,
      path_governance: input.path_governance?.get(assertion.assertion_id),
      path_lifecycle: input.path_lifecycle?.get(assertion.assertion_id),
      context: input
    }));
  });
}

function observationsFromClaim(
  claim: ClaimRead,
  input: OwnerObservationInput
): readonly EvidenceObservation[] {
  if (!ATTRIBUTABLE_CLAIM_STATUSES.has(claim.claim_status)) return [];
  const sourceId = claim.source_object_refs[0] ?? claim.object_id;
  return claim.evidence_refs.map((evidenceId, index) => observation({
    observation_id: `${claim.object_id}:${evidenceId}:${String(index)}`,
    evidence_id: evidenceId,
    source_id: sourceId,
    source_revision: input.source_revision,
    premise_id: claim.object_id,
    proposition_id: claim.proposition_digest,
    polarity: polarityForRelation(claim.claim_kind),
    access: resolveAccess(input.access, evidenceId, sourceId),
    validity: { kind: "open", valid_from: input.as_of },
    lineage_id: claim.object_id,
    independence_key: evidenceId,
    context: input
  }));
}

function polarityForRelation(kind: string): EvidencePolarity {
  return REFUTING_RELATION_KINDS.has(kind) ? "refutes" : "supports";
}

function resolveAccess(
  access: ReadonlyMap<string, EvidenceAccess>,
  evidenceId: string,
  sourceId: string,
  targetId?: string
): EvidenceAccess {
  const ids = targetId === undefined ? [evidenceId, sourceId] : [evidenceId, sourceId, targetId];
  if (ids.some((id) => access.get(id) === "protected")) return "protected";
  if (ids.some((id) => access.get(id) === "ineligible")) return "ineligible";
  return access.get(evidenceId) ?? access.get(sourceId) ?? "eligible";
}

function observation(input: {
  readonly observation_id: string;
  readonly evidence_id: string;
  readonly source_id: string;
  readonly source_revision: string;
  readonly premise_id: string;
  readonly proposition_id: string;
  readonly polarity: EvidencePolarity;
  readonly access: EvidenceAccess;
  readonly validity: EvidenceObservation["validity"];
  readonly lineage_id: string;
  readonly independence_key: string;
  readonly path_governance?: EvidenceObservation["path_governance"];
  readonly path_lifecycle?: EvidenceObservation["path_lifecycle"];
  readonly context: EvidenceIdentityContext;
}): EvidenceObservation {
  return {
    observation_id: input.observation_id,
    evidence_id: input.evidence_id,
    source_id: input.source_id,
    source_revision: input.source_revision,
    query_id: input.context.query_id,
    snapshot_id: input.context.snapshot_id,
    hypothesis_id: input.context.hypothesis_id,
    binding_context: input.context.binding_context,
    time_state: input.context.time_state,
    jurisdiction: input.context.jurisdiction,
    premise_id: input.premise_id,
    proposition_id: input.proposition_id,
    polarity: input.polarity,
    access: input.access,
    validity: input.validity,
    as_of: input.context.as_of,
    lineage_id: input.lineage_id,
    independence_key: input.independence_key,
    association_milligrades: 0,
    cost: 0,
    path_governance: input.path_governance,
    path_lifecycle: input.path_lifecycle
  };
}
