import { digestRecallFieldIdentity } from "../../field/field-identity.js";
import { compareText } from "../../../shared/compare-text.js";
import { freezeShadow } from "../envelope.js";
import {
  collapsePropositionStateMeasurement,
  issueMeasurementGroupAdmission,
  PROPOSITION_STATE_MEASUREMENT_CONTRACT,
  type PropositionStateCollapseV1,
  type VerifiedMeasurementAuthorityV1
} from "../measurement/index.js";
import type {
  SupportMaterializationOutcomeV1,
  SupportMaterializationV1,
  SupportPropositionObservationV1
} from "../support/index.js";
import { createFourValuedWitness, type FourValuedWitness } from "../witness/index.js";
import type { PsiV2CandidateV1, PsiV2CoordinateV1 } from "./types.js";

type CandidateCoordinateMap = Map<string, Map<string, PsiV2CoordinateV1>>;

export function psiV2CandidatesFromSupport(input: Readonly<{
  readonly candidate_keys: readonly string[];
  readonly support: SupportMaterializationV1;
  readonly measurement_authority?: VerifiedMeasurementAuthorityV1;
}>): readonly PsiV2CandidateV1[] {
  const coordinates: CandidateCoordinateMap = new Map(
    input.candidate_keys.map((candidateId) => [candidateId, new Map()])
  );
  for (const observation of input.support.proposition_observations) {
    addPropositionCoordinate(coordinates, observation, input.measurement_authority);
  }
  for (const outcome of input.support.outcomes) {
    if (outcome.status === "observed") continue;
    addOutcomeCoordinate(coordinates, outcome);
  }
  for (const gap of input.support.gaps) {
    if (gap.kind !== "binding_absent") continue;
    addBlockedCoordinate(
      coordinates,
      gap.owner,
      comparisonId("support.binding", gap.detail),
      `support binding unresolved: ${gap.detail}`
    );
  }
  return Object.freeze([...coordinates].map(([candidateId, rows]) => freezeShadow({
    candidate_id: candidateId,
    coordinates: Object.freeze([...rows.values()].sort((left, right) =>
      compareText(left.proposition_id, right.proposition_id)))
  })));
}

function addPropositionCoordinate(
  coordinates: CandidateCoordinateMap,
  observation: SupportPropositionObservationV1,
  authority: VerifiedMeasurementAuthorityV1 | undefined
): void {
  const propositionId = comparisonPropositionId(observation);
  const group = coordinates.get(observation.candidate_id);
  if (group === undefined) return;
  if (observation.hypothesis_digest === null) {
    addBlockedCoordinate(coordinates, observation.candidate_id, propositionId,
      "support proposition hypothesis binding is absent");
    return;
  }
  if (!/^sha256:[0-9a-f]{64}$/u.test(observation.hypothesis_digest)) {
    addBlockedCoordinate(coordinates, observation.candidate_id, propositionId,
      "support proposition hypothesis binding is malformed");
    return;
  }
  if (authority === undefined) {
    addBlockedCoordinate(coordinates, observation.candidate_id, propositionId,
      "verified support measurement authority is unavailable");
    return;
  }
  if (!witnessMatchesAuthority(observation, authority)) {
    addBlockedCoordinate(coordinates, observation.candidate_id, propositionId,
      "support proposition query or snapshot binding mismatch");
    return;
  }
  const bound = boundWitness(observation, propositionId);
  const previous = group.get(propositionId);
  const observations = previous === undefined
    ? [bound]
    : collapseObservations(previous, bound);
  group.set(propositionId, admittedCoordinate(propositionId, observations, authority));
}

function admittedCoordinate(
  propositionId: string,
  observations: Parameters<typeof collapsePropositionStateMeasurement>[0]["observations"],
  authority: VerifiedMeasurementAuthorityV1
): PsiV2CoordinateV1 {
  const collapse = collapsePropositionStateMeasurement({
    contract: PROPOSITION_STATE_MEASUREMENT_CONTRACT,
    observations
  });
  if (collapse.status !== "collapsed") {
    return blockedCoordinate(propositionId, collapse.reason, collapse);
  }
  try {
    const admission = issueMeasurementGroupAdmission({
      authority,
      contract: PROPOSITION_STATE_MEASUREMENT_CONTRACT,
      proposition_schema: PROPOSITION_STATE_MEASUREMENT_CONTRACT.proposition_schema,
      collapse
    });
    return freezeShadow({
      proposition_id: propositionId,
      proposition_schema: PROPOSITION_STATE_MEASUREMENT_CONTRACT.proposition_schema,
      applicable: true,
      identity: admission,
      lex_domain: null,
      envelope_identity: null,
      collapse,
      admission
    });
  } catch (error) {
    return blockedCoordinate(
      propositionId,
      `support measurement admission unavailable: ${errorMessage(error)}`,
      collapse
    );
  }
}

function boundWitness(
  observation: SupportPropositionObservationV1,
  propositionId: string
) {
  const witness = observation.witness;
  return createFourValuedWitness({
    identity: {
      coordinate_id: `support.measure:${propositionId}:${observation.candidate_id}`,
      query_id: witness.identity.query_id,
      snapshot_digest: witness.identity.snapshot_digest,
      candidate_id: observation.candidate_id,
      proposition_id: propositionId
    },
    provenance: witness.provenance,
    epistemic: witness.epistemic,
    payload: witness.payload
  });
}

function collapseObservations(
  coordinate: PsiV2CoordinateV1,
  observation: ReturnType<typeof boundWitness>
): readonly FourValuedWitness[] {
  const collapse = coordinate.collapse;
  const existing = collapse.status === "collapsed" || collapse.status === "conflict"
    ? (collapse.witness.domain === "four_valued_proposition" ? [collapse.witness] : [])
    : collapse.observations.filter(isFourValuedWitness);
  const digest = digestRecallFieldIdentity(observation);
  return existing.some((row) => digestRecallFieldIdentity(row) === digest)
    ? existing
    : [...existing, observation];
}

function isFourValuedWitness(value: unknown): value is FourValuedWitness {
  return typeof value === "object" && value !== null &&
    "domain" in value && value.domain === "four_valued_proposition";
}

function addOutcomeCoordinate(
  coordinates: CandidateCoordinateMap,
  outcome: Exclude<SupportMaterializationOutcomeV1, { readonly status: "observed" }>
): void {
  const detail = outcome.status === "malformed" ? outcome.contract_code : outcome.reason;
  addBlockedCoordinate(
    coordinates,
    outcome.owner,
    comparisonId("support.producer", outcome.source_owner),
    `support producer ${outcome.status}: ${detail}`
  );
}

function addBlockedCoordinate(
  coordinates: CandidateCoordinateMap,
  candidateId: string,
  propositionId: string,
  reason: string
): void {
  const group = coordinates.get(candidateId);
  if (group === undefined) return;
  group.set(propositionId, blockedCoordinate(propositionId, reason));
}

function blockedCoordinate(
  propositionId: string,
  reason: string,
  source?: PropositionStateCollapseV1
): PsiV2CoordinateV1 {
  const observations = source === undefined
    ? []
    : source.status === "collapsed" ? [source.witness] : source.observations;
  return freezeShadow({
    proposition_id: propositionId,
    proposition_schema: PROPOSITION_STATE_MEASUREMENT_CONTRACT.proposition_schema,
    applicable: true,
    identity: null,
    lex_domain: null,
    envelope_identity: null,
    collapse: freezeShadow({ status: "blocked" as const, reason, observations }),
    admission: null
  });
}

function comparisonPropositionId(observation: SupportPropositionObservationV1): string {
  return comparisonId("support.proposition", {
    hypothesis_digest: observation.hypothesis_digest ?? "unbound",
    local_proposition_id: observation.local_proposition_id
  });
}

function comparisonId(kind: string, binding: unknown): string {
  return `${kind}:${digestRecallFieldIdentity({ kind, binding })}`;
}

function witnessMatchesAuthority(
  observation: SupportPropositionObservationV1,
  authority: VerifiedMeasurementAuthorityV1
): boolean {
  const identity = observation.witness.identity;
  return identity.query_id === authority.query_id &&
    identity.snapshot_digest === authority.snapshot_digest &&
    identity.candidate_id === observation.candidate_id &&
    identity.proposition_id === observation.local_proposition_id;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown admission failure";
}
