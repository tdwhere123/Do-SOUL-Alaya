import type { ChannelClosureResult } from
  "../../../../../../recall/decision/query-proof/closure/contract.js";
import type { LiveQueryProofAuthority } from
  "../../../../../../recall/decision/query-proof/live-query-proof-authority.js";
import {
  normalizeFiniteFixture,
  type FiniteDecisionOperator,
  type FiniteOracleFixture,
  type FiniteRefinementKind,
  type TransferAbstractKind
} from "../../../../../../recall/decision/query-proof/proof/oracle/contract.js";
import type {
  AbstractCoordinate,
  AbstractDecisionOperator,
  AbstractKernelLimits,
  AbstractProofKernelInput
} from "../../../../../../recall/decision/query-proof/proof/abstract/contract.js";

export type KernelCaseInput = Readonly<{
  readonly coordinates?: readonly AbstractCoordinate[];
  readonly closures?: readonly ChannelClosureResult[];
  readonly limits?: AbstractKernelLimits;
  readonly operator?: AbstractDecisionOperator;
  readonly fixture?: FiniteOracleFixture;
  readonly concrete?: FiniteDecisionOperator;
  readonly k_max?: number;
}>;

export function createKernelCase(
  liveAuthority: LiveQueryProofAuthority,
  params: KernelCaseInput = {}
) {
  const coordinates = params.coordinates ?? [];
  const operator = params.operator ?? singletonOperator(
    coordinates.map(({ sensitivity_id }) => sensitivity_id));
  const fixture = normalizeFiniteFixture(params.fixture ?? fixtureFor(
    liveAuthority.snapshot_vector.vector_digest,
    coordinates,
    params.k_max ?? 2
  ));
  const concrete = params.concrete ?? Object.freeze({
    operator_id: "fixture_reference_concrete_v1",
    decide: () => trace(["candidate-a"], "singleton")
  });
  const input: AbstractProofKernelInput = Object.freeze({
    live_authority: liveAuthority,
    fixture,
    concrete_operator: concrete,
    k_max: params.k_max ?? fixture.k_max,
    closures: Object.freeze([...(params.closures ?? [])]),
    coordinates: Object.freeze([...coordinates]),
    limits: Object.freeze(params.limits ?? {
      max_channels: 8,
      max_coordinates: 16,
      max_sensitivities: 16
    }),
    operator
  });
  return Object.freeze({ input, fixture, concrete, operator });
}

export function membershipCoordinate(
  possibleStates: readonly ("absent" | "present")[],
  coordinateId = "membership",
  sensitivityId = "sensitivity:membership"
): AbstractCoordinate {
  return Object.freeze({
    coordinate_id: coordinateId,
    sensitivity_id: sensitivityId,
    owner_id: `owner:${coordinateId}`,
    kind: "membership" as const,
    possible_states: possibleStates
  });
}

export function feasibilityCoordinate(
  possibleStates: readonly ("feasible" | "infeasible" | "unresolved")[]
): AbstractCoordinate {
  return Object.freeze({
    coordinate_id: "feasibility",
    sensitivity_id: "sensitivity:feasibility",
    owner_id: "owner:feasibility",
    kind: "semantic_feasibility" as const,
    possible_states: possibleStates
  });
}

export function identityCoordinate(universe: "finite" | "open"): AbstractCoordinate {
  return Object.freeze({
    coordinate_id: "identity-tail",
    sensitivity_id: "sensitivity:identity-tail",
    owner_id: "owner:identity-tail",
    kind: "identity_tie" as const,
    universe,
    possible_winner_digests: [`sha256:${"1".repeat(64)}` as `sha256:${string}`]
  });
}

export function trace(candidatePrefix: readonly string[], reason = "fixture") {
  return Object.freeze({
    candidate_prefix: Object.freeze([...candidatePrefix]),
    answer_bindings: Object.freeze([]),
    pick_reasons: Object.freeze(candidatePrefix.map((candidateKey, position) =>
      Object.freeze({ position, candidate_key: candidateKey, reason_id: reason })))
  });
}

export function singletonOperator(
  handled: readonly string[] = [],
  candidatePrefix: readonly string[] = ["candidate-a"]
): AbstractDecisionOperator {
  return Object.freeze({
    operator_id: "fixture_singleton_abstract_v1",
    evaluate: () => Object.freeze({
      status: "outcomes" as const,
      handled_sensitivity_ids: Object.freeze([...handled]),
      outcomes: Object.freeze([trace(candidatePrefix, "singleton")])
    })
  });
}

export function fixtureCoordinate(
  coordinateId: string,
  kind: FiniteRefinementKind,
  abstractKind: TransferAbstractKind,
  values: readonly (string | boolean | null)[]
) {
  return Object.freeze({
    coordinate_id: coordinateId,
    sensitivity_id: `sensitivity:${coordinateId}`,
    owner_id: `owner:${coordinateId}`,
    kind,
    abstract_kind: abstractKind,
    choices: Object.freeze(values.map((value) => Object.freeze({
      choice_id: String(value), value
    })))
  });
}

function fixtureFor(
  snapshotDigest: FiniteOracleFixture["snapshot_digest"],
  coordinates: readonly AbstractCoordinate[],
  kMax: number
): FiniteOracleFixture {
  return {
    fixture_id: `abstract-${coordinates.map(({ coordinate_id }) => coordinate_id).join("-") ||
      "empty"}`,
    snapshot_digest: snapshotDigest,
    k_max: kMax,
    base_state: {},
    coordinates: coordinates.map((coordinate) => fixtureCoordinate(
      coordinate.coordinate_id,
      concreteKind(coordinate.kind),
      coordinate.kind,
      [null]
    ))
  };
}

function concreteKind(kind: AbstractCoordinate["kind"]): FiniteRefinementKind {
  switch (kind) {
    case "membership": return "candidate_membership";
    case "numeric_interval":
    case "finite_values":
    case "temporal_interval": return "witness_refinement";
    case "binding": return "answer_binding";
    case "four_valued_proposition": return "proposition_conflict";
    case "correlation": return "correlation_state";
    case "semantic_feasibility": return "semantic_feasibility";
    case "identity_tie": return "identity_tie";
  }
}
