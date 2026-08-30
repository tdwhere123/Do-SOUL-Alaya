import { freezeShadow } from "../../contract-primitives.js";
import {
  createFourValuedWitness,
  type FourValuedPolarity,
  type FourValuedWitness
} from "../witness/index.js";
import { unionProvenance } from "../witness/shared/provenance.js";
import { createMeasurementGroupContractV1 } from "./contract.js";

export const PROPOSITION_STATE_MEASUREMENT_CONTRACT =
  createMeasurementGroupContractV1({
    contract_id: "measure.proposition.state.v1",
    operator_version: "1",
    proposition_schema: "support.proposition.state.v1",
    measurement_domain: "four_valued_proposition",
    comparison_direction: "exact",
    correlation_policy: "identity_dedupe",
    combine_operator: "exact_state_only",
    soundness_preconditions: ["same_binding", "identical_known_state"],
    upper_bound_rule: "none_declared"
  });

export type PropositionStateCollapseV1 =
  | Readonly<{
      readonly status: "collapsed";
      readonly contract: typeof PROPOSITION_STATE_MEASUREMENT_CONTRACT;
      readonly witness: FourValuedWitness;
    }>
  | Readonly<{
      readonly status: "blocked";
      readonly reason: string;
      readonly observations: readonly FourValuedWitness[];
    }>;

export type PropositionStateVoteV1 = "eq" | "incomparable" | "blocked";

export function collapsePropositionStateMeasurement(input: Readonly<{
  readonly contract: typeof PROPOSITION_STATE_MEASUREMENT_CONTRACT;
  readonly observations: readonly FourValuedWitness[];
}>): PropositionStateCollapseV1 {
  if (input.contract !== PROPOSITION_STATE_MEASUREMENT_CONTRACT) {
    return blocked("proposition-state contract is not predeclared", input.observations);
  }
  if (input.observations.length === 0) {
    return blocked("proposition-state observation is absent", input.observations);
  }
  if (!sameBinding(input.observations)) {
    return blocked("proposition-state observations have different bindings", input.observations);
  }
  const states = input.observations.map(knownState);
  if (states.some((state) => state === null)) {
    return blocked("unknown, both, or unavailable proposition state blocks", input.observations);
  }
  const first = states[0]!;
  if (!states.every((state) => state === first)) {
    return blocked("different known proposition states are incomparable", input.observations);
  }
  return freezeShadow({
    status: "collapsed" as const,
    contract: PROPOSITION_STATE_MEASUREMENT_CONTRACT,
    witness: createFourValuedWitness({
      identity: collapsedIdentity(input.observations[0]!),
      provenance: mergedProvenance(input.observations),
      epistemic: { kind: "exact" },
      payload: { polarity: first }
    })
  });
}

export function compareCollapsedPropositionStatesExact(
  left: PropositionStateCollapseV1,
  right: PropositionStateCollapseV1
): PropositionStateVoteV1 {
  if (left.status !== "collapsed" || right.status !== "collapsed") return "blocked";
  const leftState = knownState(left.witness);
  const rightState = knownState(right.witness);
  if (leftState === null || rightState === null) return "blocked";
  return leftState === rightState ? "eq" : "incomparable";
}

function knownState(
  witness: FourValuedWitness
): Exclude<FourValuedPolarity, "both" | "unknown"> | null {
  if (witness.epistemic.kind !== "exact" || witness.payload === null) return null;
  const state = witness.payload.polarity;
  return state === "supported_only" || state === "refuted_only" ? state : null;
}

function sameBinding(observations: readonly FourValuedWitness[]): boolean {
  const first = observations[0]!;
  return observations.every((observation) =>
    observation.identity.query_id === first.identity.query_id &&
    observation.identity.snapshot_digest === first.identity.snapshot_digest &&
    observation.identity.candidate_id === first.identity.candidate_id &&
    observation.identity.proposition_id === first.identity.proposition_id);
}

function collapsedIdentity(
  observation: FourValuedWitness
): FourValuedWitness["identity"] {
  return {
    coordinate_id: `measure:${observation.identity.proposition_id}`,
    query_id: observation.identity.query_id,
    snapshot_digest: observation.identity.snapshot_digest,
    candidate_id: observation.identity.candidate_id,
    proposition_id: observation.identity.proposition_id
  };
}

function mergedProvenance(
  observations: readonly FourValuedWitness[]
): FourValuedWitness["provenance"] {
  let provenance = observations[0]!.provenance;
  for (const observation of observations.slice(1)) {
    provenance = unionProvenance(provenance, observation.provenance);
  }
  return Object.freeze([...provenance].sort((left, right) =>
    compareText(left.source_id, right.source_id) ||
    compareText(left.producer, right.producer)));
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function blocked(
  reason: string,
  observations: readonly FourValuedWitness[]
): Extract<PropositionStateCollapseV1, { status: "blocked" }> {
  return freezeShadow({
    status: "blocked" as const,
    reason,
    observations: Object.freeze([...observations])
  });
}
