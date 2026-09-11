import {
  CONDITIONAL_FIELD_SCHEMA_VERSION,
  type ClaimState,
  type Derivation,
  type SupportRecord
} from "@do-soul/alaya-protocol";
import { joinDerivation, leafDerivation, mergeDerivations } from "../engine/path-derivation.js";
import { compareText } from "../../../shared/compare-text.js";
import { evaluateGovernance } from "./governance.js";
import {
  completeWitnessesFor,
  explanationIdsFrom,
  SupportWorkMeter
} from "./witnesses.js";
import type {
  EvidenceAssessment,
  EvidenceAssessmentInput,
  EvidenceCorrelationRecord,
  EvidenceObservation,
  EvidencePolarity,
  GovernanceOutcome,
  PolarizedWitness,
  PropositionDemand
} from "./types.js";

export {
  COMMON_CAUSE_PROPOSITION_KIND,
  CONDITIONAL_FIELD_EVIDENCE_OPERATOR_ID
} from "./types.js";
export type {
  ClaimRead,
  EvidenceAccess,
  EvidenceAssessment,
  EvidenceAssessmentInput,
  EvidenceCorrelationRecord,
  EvidenceCorrelationState,
  EvidenceObservation,
  EvidencePolarity,
  GovernanceOutcome,
  GovernanceReason,
  OwnerObservationInput,
  PropositionDemand,
  RelationAssertionRead,
  SupportWorkStatus,
  WitnessTemplate
} from "./types.js";
export { evaluateGovernance, observationsFromOwners } from "./governance.js";
export { compatiblePremises, retainCompleteAlternatives } from "./witnesses.js";

export function assessEvidence(input: EvidenceAssessmentInput): EvidenceAssessment {
  const work = new SupportWorkMeter(input.work_limit);
  const { admitted, governance } = admitObservations(input, work);
  const correlations = correlationsAmong(admitted);
  const collapsed = collapseDuplicateEvidence(admitted);
  const records: SupportRecord[] = [];
  const polarities: Record<string, EvidencePolarity> = {};
  const derivations: Derivation[] = [];
  for (const demand of input.propositions) {
    const assessed = assessProposition(demand, collapsed, input, work);
    records.push(assessed.record);
    Object.assign(polarities, assessed.polarities);
    derivations.push(...assessed.derivations);
  }
  return {
    query_id: input.query_id,
    snapshot_id: input.snapshot_id,
    ...(input.source_revision === undefined ? {} : { source_revision: input.source_revision }),
    records,
    polarities,
    governance,
    explanation_ids: explanationIdsFrom(records.flatMap((record) => record.witnesses)),
    work_status: work.interrupted ? "open" : "complete",
    correlations,
    derivations: mergeDerivations(derivations)
  };
}

function admitObservations(
  input: EvidenceAssessmentInput,
  work: SupportWorkMeter
): Readonly<{
  readonly admitted: readonly EvidenceObservation[];
  readonly governance: readonly GovernanceOutcome[];
}> {
  const governance: GovernanceOutcome[] = [];
  const admitted: EvidenceObservation[] = [];
  for (const observation of input.observations) {
    if (!work.spend()) break;
    const outcome = evaluateGovernance(observation, input);
    governance.push(outcome);
    if (outcome.admitted) admitted.push(observation);
  }
  return { admitted, governance };
}

function collapseDuplicateEvidence(
  observations: readonly EvidenceObservation[]
): readonly EvidenceObservation[] {
  const unique = new Map<string, EvidenceObservation>();
  for (const observation of observations) {
    const key = [
      observation.evidence_id,
      observation.polarity,
      observation.premise_id,
      observation.proposition_id
    ].join("\0");
    if (!unique.has(key)) unique.set(key, observation);
  }
  return [...unique.values()];
}

function assessProposition(
  demand: PropositionDemand,
  observations: readonly EvidenceObservation[],
  input: EvidenceAssessmentInput,
  work: SupportWorkMeter
): Readonly<{
  readonly record: SupportRecord;
  readonly polarities: Readonly<Record<string, EvidencePolarity>>;
  readonly derivations: readonly Derivation[];
}> {
  const scoped = observations.filter(
    (observation) => observation.proposition_id === demand.proposition.proposition_id
  );
  if (!work.spend()) return unknownRecord(demand, []);
  const supporting = completeWitnessesFor(demand.templates, scoped, "supports", input, work);
  const refuting = completeWitnessesFor(demand.templates, scoped, "refutes", input, work);
  const witnesses = [...supporting, ...refuting];
  const polarities: Record<string, EvidencePolarity> = {};
  for (const witness of witnesses) polarities[witness.witness_id] = witness.polarity;
  return {
    record: {
      schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
      proposition_id: demand.proposition.proposition_id,
      claim: claimFromSides(supporting, refuting),
      witnesses: witnesses.map(stripPolarity)
    },
    polarities,
    derivations: derivationsFromWitnesses(witnesses)
  };
}

function claimFromSides(
  supporting: readonly PolarizedWitness[],
  refuting: readonly PolarizedWitness[]
): ClaimState {
  // Association milligrades never prove, refute, or break a conflict.
  const hasSupport = supporting.some((witness) => witness.complete);
  const hasRefute = refuting.some((witness) => witness.complete);
  if (hasSupport && hasRefute) return "conflict";
  if (hasSupport) return "supported";
  if (hasRefute) return "refuted";
  return "unknown";
}

function unknownRecord(
  demand: PropositionDemand,
  witnesses: readonly PolarizedWitness[]
): Readonly<{
  readonly record: SupportRecord;
  readonly polarities: Readonly<Record<string, EvidencePolarity>>;
  readonly derivations: readonly Derivation[];
}> {
  return {
    record: {
      schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
      proposition_id: demand.proposition.proposition_id,
      claim: "unknown",
      witnesses: witnesses.map(stripPolarity)
    },
    polarities: {},
    derivations: []
  };
}

function derivationsFromWitnesses(witnesses: readonly PolarizedWitness[]): readonly Derivation[] {
  const complete = witnesses.filter((witness) => witness.complete);
  const nodes: Derivation[] = [];
  for (const witness of complete) {
    const leaves = witness.premises.map((premise) => leafDerivation({
      derivation_id: `leaf:${premise}`,
      observation_id: premise,
      leaf_id: premise,
      witness_id: witness.witness_id
    }));
    const first = leaves[0];
    if (first === undefined) continue;
    nodes.push(...leaves);
    nodes.push(
      leaves.length === 1
        ? first
        : joinDerivation("and", leaves, { witness_id: witness.witness_id })
    );
  }
  return mergeDerivations(nodes);
}

function stripPolarity(witness: PolarizedWitness): SupportRecord["witnesses"][number] {
  return {
    schema_version: witness.schema_version,
    witness_id: witness.witness_id,
    premises: witness.premises,
    cost: witness.cost,
    complete: witness.complete
  };
}

function correlationsAmong(
  observations: readonly EvidenceObservation[]
): readonly EvidenceCorrelationRecord[] {
  const unique = new Map<string, EvidenceCorrelationRecord>();
  for (let left = 0; left < observations.length; left += 1) {
    for (let right = left + 1; right < observations.length; right += 1) {
      const pair = correlationPair(observations[left]!, observations[right]!);
      if (pair === null) continue;
      unique.set(`${pair.state}\0${pair.left_id}\0${pair.right_id}`, pair);
    }
  }
  return [...unique.values()].sort((left, right) =>
    compareText(`${left.left_id}\0${left.right_id}\0${left.state}`, `${right.left_id}\0${right.right_id}\0${right.state}`)
  );
}

function correlationPair(
  left: EvidenceObservation,
  right: EvidenceObservation
): EvidenceCorrelationRecord | null {
  const [first, second] = left.evidence_id <= right.evidence_id
    ? [left, right]
    : [right, left];
  if (first.evidence_id === second.evidence_id) {
    return { left_id: first.evidence_id, right_id: second.evidence_id, state: "same_evidence_unit" };
  }
  if (first.lineage_id === second.lineage_id) {
    return { left_id: first.evidence_id, right_id: second.evidence_id, state: "same_source_lineage" };
  }
  if (first.independence_key === second.independence_key) {
    return { left_id: first.evidence_id, right_id: second.evidence_id, state: "possibly_correlated" };
  }
  // Distinct keys and routes do not certify independence.
  return null;
}

