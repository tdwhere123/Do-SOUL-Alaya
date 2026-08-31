import { createChannelClosureResult } from
  "../../../../../../recall/decision/query-proof/closure/contract.js";
import type {
  ChannelClosureResult,
  ChannelClosureScope,
  ChannelRemainingEffect
} from "../../../../../../recall/decision/query-proof/closure/contract.js";
import type { RecallFieldDigest } from
  "../../../../../../recall/field/field-identity.js";
import type {
  FiniteDecisionOperator,
  FiniteOracleFixture,
  FiniteRefinementKind
} from "../../../../../../recall/decision/query-proof/proof/oracle/contract.js";
import {
  issueFiniteTransferAuthority,
  type FiniteTransferManifestRow,
  type TransferAbstractKind
} from "../../../../../../recall/decision/query-proof/proof/oracle/transfer-authority.js";
import type {
  AbstractCoordinate,
  AbstractDecisionOperator,
  AbstractKernelLimits,
  AbstractProofKernelInput
} from "../../../../../../recall/decision/query-proof/proof/abstract/contract.js";

export const SNAPSHOT = `sha256:${"a".repeat(64)}` as const;
export const QUERY = `sha256:${"b".repeat(64)}` as const;
export const PRINCIPAL = `sha256:${"c".repeat(64)}` as const;

export type KernelCaseInput = Readonly<{
  readonly coordinates?: readonly AbstractCoordinate[];
  readonly closures?: readonly ChannelClosureResult[];
  readonly limits?: AbstractKernelLimits;
  readonly operator?: AbstractDecisionOperator;
  readonly fixture?: FiniteOracleFixture;
  readonly concrete?: FiniteDecisionOperator;
  readonly query_digest?: RecallFieldDigest;
  readonly principal_digest?: RecallFieldDigest;
  readonly k_max?: number;
}>;

export function createKernelCase(params: KernelCaseInput = {}) {
  const coordinates = params.coordinates ?? [];
  const operator = params.operator ?? singletonOperator(coordinates.map(({ sensitivity_id }) =>
    sensitivity_id));
  const fixture = params.fixture ?? fixtureFor(coordinates, params.k_max ?? 2);
  const concrete = params.concrete ?? Object.freeze({
    operator_id: "fixture_reference_concrete_v1",
    decide: () => trace([])
  });
  const queryDigest = params.query_digest ?? QUERY;
  const principalDigest = params.principal_digest ?? PRINCIPAL;
  const authority = issueFiniteTransferAuthority({
    fixture,
    concrete_operator: concrete,
    abstract_operator: operator,
    query_digest: queryDigest,
    principal_digest: principalDigest,
    manifest: manifestFor(coordinates, fixture)
  });
  const input: AbstractProofKernelInput = Object.freeze({
    query_digest: queryDigest,
    snapshot_digest: fixture.snapshot_digest,
    principal_digest: principalDigest,
    k_max: params.k_max ?? fixture.k_max,
    closures: params.closures ?? [notApplicableClosure("test-channel")],
    coordinates,
    limits: params.limits ?? {
      max_channels: 8,
      max_coordinates: 16,
      max_sensitivities: 16
    },
    operator,
    transfer_authority: authority
  });
  return Object.freeze({ input, authority, fixture, concrete, operator });
}

export function scope(
  channelId: string,
  sensitivities: ChannelClosureScope["sensitivities"] = []
): ChannelClosureScope {
  return Object.freeze({
    query_digest: QUERY,
    request_digest: `sha256:${"d".repeat(64)}`,
    snapshot_digest: SNAPSHOT,
    principal_digest: PRINCIPAL,
    workspace_id: "workspace-1",
    observer_id: `${channelId}-observer`,
    channel_id: channelId,
    domain_id: "query-answer-domain",
    universe_digest: `sha256:${"e".repeat(64)}`,
    sensitivities: Object.freeze(sensitivities)
  });
}

export function notApplicableClosure(channelId: string): ChannelClosureResult {
  return createChannelClosureResult({
    scope: scope(channelId),
    status: "not_applicable",
    reason: "not_applicable_fixture"
  });
}

export function boundedClosure(
  channelId: string,
  effect: ChannelRemainingEffect
): ChannelClosureResult {
  return createChannelClosureResult({
    scope: scope(channelId, [{
      sensitivity_id: effect.sensitivity_id,
      effect: effect.effect,
      target: `${channelId}:${effect.sensitivity_id}`
    }]),
    status: "bounded_open",
    remaining_effects: [effect],
    reason: "bounded_fixture"
  });
}

export function membershipCoordinate(
  possible_states: readonly ("absent" | "present")[],
  coordinate_id = "membership",
  sensitivity_id = "membership"
): AbstractCoordinate {
  return Object.freeze({
    coordinate_id,
    sensitivity_id,
    owner_id: "test-channel",
    kind: "membership" as const,
    possible_states
  });
}

export function feasibilityCoordinate(
  possible_states: readonly ("feasible" | "infeasible" | "unresolved")[]
): AbstractCoordinate {
  return Object.freeze({
    coordinate_id: "feasibility",
    sensitivity_id: "feasibility",
    owner_id: "test-channel",
    kind: "semantic_feasibility" as const,
    possible_states
  });
}

export function identityCoordinate(universe: "finite" | "open"): AbstractCoordinate {
  return Object.freeze({
    coordinate_id: "identity-tail",
    sensitivity_id: "identity-tail",
    owner_id: "test-channel",
    kind: "identity_tie" as const,
    universe,
    possible_winner_digests: [`sha256:${"1".repeat(64)}`]
  });
}

export function trace(candidatePrefix: readonly string[], reason = "fixture") {
  return Object.freeze({
    candidate_prefix: candidatePrefix,
    answer_bindings: Object.freeze([]),
    pick_reasons: Object.freeze(candidatePrefix.map((candidateKey, position) =>
      Object.freeze({ position, candidate_key: candidateKey, reason_id: reason })))
  });
}

export function singletonOperator(
  handled: readonly string[] = []
): AbstractDecisionOperator {
  return Object.freeze({
    operator_id: "fixture_singleton_abstract_v1",
    evaluate: () => Object.freeze({
      status: "outcomes" as const,
      handled_sensitivity_ids: handled,
      outcomes: Object.freeze([trace(["candidate-a"], "singleton")])
    })
  });
}

function fixtureFor(
  coordinates: readonly AbstractCoordinate[],
  kMax: number
): FiniteOracleFixture {
  return Object.freeze({
    fixture_id: `abstract-${coordinates.map(({ coordinate_id }) => coordinate_id).join("-") ||
      "empty"}`,
    snapshot_digest: SNAPSHOT,
    k_max: kMax,
    base_state: Object.freeze({}),
    coordinates: Object.freeze(coordinates.map((coordinate) => Object.freeze({
      coordinate_id: coordinate.coordinate_id,
      kind: concreteKind(coordinate.kind),
      choices: Object.freeze([{ choice_id: "fixture", value: null }])
    })))
  });
}

function manifestFor(
  coordinates: readonly AbstractCoordinate[],
  fixture: FiniteOracleFixture
): readonly FiniteTransferManifestRow[] {
  const byId = new Map(coordinates.map((coordinate) => [coordinate.coordinate_id, coordinate]));
  return Object.freeze(fixture.coordinates.map((row) => {
    const coordinate = byId.get(row.coordinate_id);
    if (coordinate === undefined) throw new Error("fixture coordinate lacks abstract mapping");
    return Object.freeze({
      coordinate_id: row.coordinate_id,
      sensitivity_id: coordinate.sensitivity_id,
      owner_id: coordinate.owner_id,
      concrete_kind: row.kind,
      abstract_kind: coordinate.kind as TransferAbstractKind
    });
  }));
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
