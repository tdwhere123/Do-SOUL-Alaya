import { compareText } from "../../../../../shared/compare-text.js";
import {
  digestRecallFieldIdentity,
  type RecallFieldDigest
} from "../../../../field/field-identity.js";
import type {
  ChannelClosureResult,
  ChannelRemainingEffect
} from "../../closure/contract.js";
import {
  freezeFiniteValue,
  type FiniteDecisionTrace,
  type FiniteDecisionTraceInput,
  type FiniteValue
} from "../oracle/contract.js";

type CoordinateIdentity = Readonly<{
  readonly coordinate_id: string;
  readonly sensitivity_id: string;
  readonly owner_id: string;
  readonly decision_changing: boolean;
}>;

export type AbstractCoordinate =
  | (CoordinateIdentity & Readonly<{
      readonly kind: "membership";
      readonly possible_states: readonly ("absent" | "present")[];
    }>)
  | (CoordinateIdentity & Readonly<{
      readonly kind: "numeric_interval";
      readonly role: "proposition_bound" | "extremum" | "answer_position";
      readonly lower: number;
      readonly upper: number;
      readonly overlaps_decision_boundary: boolean;
    }>)
  | (CoordinateIdentity & Readonly<{
      readonly kind: "finite_values";
      readonly possible_values: readonly FiniteValue[];
    }>)
  | (CoordinateIdentity & Readonly<{
      readonly kind: "binding";
      readonly possible_bindings: readonly string[];
    }>)
  | (CoordinateIdentity & Readonly<{
      readonly kind: "temporal_interval";
      readonly minimum_epoch_ms: number;
      readonly maximum_epoch_ms: number;
    }>)
  | (CoordinateIdentity & Readonly<{
      readonly kind: "four_valued_proposition";
      readonly possible_values:
        readonly ("supported_only" | "refuted_only" | "both" | "unknown")[];
    }>)
  | (CoordinateIdentity & Readonly<{
      readonly kind: "correlation";
      readonly possible_relations:
        readonly ("same_group" | "different_group" | "unknown")[];
    }>)
  | (CoordinateIdentity & Readonly<{
      readonly kind: "semantic_feasibility";
      readonly possible_states:
        readonly ("feasible" | "infeasible" | "unresolved")[];
    }>)
  | (CoordinateIdentity & Readonly<{
      readonly kind: "identity_tie";
      readonly universe: "finite" | "open";
      readonly possible_winner_digests: readonly RecallFieldDigest[];
    }>);

export type AbstractOperatorEvaluation =
  | Readonly<{
      readonly status: "outcomes";
      readonly handled_sensitivity_ids: readonly string[];
      readonly outcomes: readonly FiniteDecisionTraceInput[];
    }>
  | Readonly<{ readonly status: "conflict"; readonly reason: string }>
  | Readonly<{ readonly status: "unsupported"; readonly reason: string }>;

export type AbstractDecisionOperator = Readonly<{
  readonly operator_id: string;
  readonly evaluate: (input: Readonly<{
    readonly coordinates: readonly AbstractCoordinate[];
    readonly remaining_effects: readonly ChannelRemainingEffect[];
    readonly k_max: number;
  }>) => AbstractOperatorEvaluation;
}>;

export type AbstractKernelLimits = Readonly<{
  readonly max_channels: number;
  readonly max_coordinates: number;
  readonly max_sensitivities: number;
}>;

export type AbstractProofKernelInput = Readonly<{
  readonly query_digest: RecallFieldDigest;
  readonly snapshot_digest: RecallFieldDigest;
  readonly principal_digest: RecallFieldDigest;
  readonly k_max: number;
  readonly closures: readonly ChannelClosureResult[];
  readonly coordinates: readonly AbstractCoordinate[];
  readonly limits: AbstractKernelLimits;
  readonly operator: AbstractDecisionOperator;
}>;

export type AbstractRefinementRequest = Readonly<{
  readonly coordinate_id: string;
  readonly sensitivity_id: string;
  readonly owner_id: string;
  readonly domain_kind: AbstractCoordinate["kind"] | "channel_closure";
  readonly reason: string;
}>;

type AbstractProofResultIdentity = Readonly<{
  readonly schema_version: 1;
  readonly operator_id: "operator_parametric_abstract_proof_kernel_v1";
  readonly query_digest: RecallFieldDigest;
  readonly snapshot_digest: RecallFieldDigest;
  readonly principal_digest: RecallFieldDigest;
  readonly decision_operator_id: string;
  readonly premise_digest: RecallFieldDigest;
}>;

export type AbstractProofKernelResult =
  | (AbstractProofResultIdentity & Readonly<{
      readonly status: "PROVED_SINGLETON";
      readonly outcome: FiniteDecisionTrace;
      readonly proof_digest: RecallFieldDigest;
    }>)
  | (AbstractProofResultIdentity & Readonly<{
      readonly status: "OPEN";
      readonly reason: string;
      readonly requested_refinements: readonly AbstractRefinementRequest[];
      readonly possible_outcomes: readonly FiniteDecisionTrace[];
      readonly proof_digest: RecallFieldDigest;
    }>)
  | (AbstractProofResultIdentity & Readonly<{
      readonly status: "CONFLICT";
      readonly reason: string;
      readonly conflict_coordinate_ids: readonly string[];
      readonly proof_digest: RecallFieldDigest;
    }>)
  | (AbstractProofResultIdentity & Readonly<{
      readonly status: "UNSUPPORTED";
      readonly reason: string;
      readonly proof_digest: RecallFieldDigest;
    }>);

export function normalizeAbstractCoordinates(
  coordinates: readonly AbstractCoordinate[]
): readonly AbstractCoordinate[] {
  const normalized = coordinates.map(normalizeCoordinate)
    .sort((left, right) => compareText(left.coordinate_id, right.coordinate_id));
  if (new Set(normalized.map(({ coordinate_id }) => coordinate_id)).size !==
      normalized.length) throw new Error("abstract coordinate ids must be unique");
  return Object.freeze(normalized);
}

export function abstractResultIdentity(input: AbstractProofKernelInput) {
  return Object.freeze({
    schema_version: 1 as const,
    operator_id: "operator_parametric_abstract_proof_kernel_v1" as const,
    query_digest: input.query_digest,
    snapshot_digest: input.snapshot_digest,
    principal_digest: input.principal_digest,
    decision_operator_id: input.operator.operator_id,
    premise_digest: digestAbstractProofPremise(input)
  });
}

function digestAbstractProofPremise(
  input: AbstractProofKernelInput
): RecallFieldDigest {
  const closures = input.closures.map(({ channel_id, result_digest }) =>
    Object.freeze({ channel_id, result_digest }))
    .sort((left, right) => compareText(left.channel_id, right.channel_id) ||
      compareText(left.result_digest, right.result_digest));
  const coordinates = [...input.coordinates].sort((left, right) =>
    compareText(left.coordinate_id, right.coordinate_id));
  return digestRecallFieldIdentity({
    query_digest: input.query_digest,
    snapshot_digest: input.snapshot_digest,
    principal_digest: input.principal_digest,
    k_max: input.k_max,
    closures,
    coordinates,
    limits: input.limits,
    decision_operator_id: input.operator.operator_id
  });
}

export function sealAbstractResult<T extends object>(body: T): Readonly<T> &
Readonly<{ readonly proof_digest: RecallFieldDigest }> {
  return Object.freeze({ ...body, proof_digest: digestRecallFieldIdentity(body) });
}

function normalizeCoordinate(coordinate: AbstractCoordinate): AbstractCoordinate {
  assertIdentity(coordinate.coordinate_id, "abstract coordinate id");
  assertIdentity(coordinate.sensitivity_id, "abstract sensitivity id");
  assertIdentity(coordinate.owner_id, "abstract coordinate owner");
  switch (coordinate.kind) {
    case "membership":
      return Object.freeze({ ...coordinate,
        possible_states: freezeStringSet(coordinate.possible_states) });
    case "semantic_feasibility":
      return Object.freeze({ ...coordinate,
        possible_states: freezeStringSet(coordinate.possible_states) });
    case "numeric_interval":
      assertInterval(coordinate.lower, coordinate.upper, "abstract numeric interval");
      return Object.freeze({ ...coordinate });
    case "finite_values": {
      const values = coordinate.possible_values.map(freezeFiniteValue)
        .sort((left, right) => compareText(
          digestRecallFieldIdentity(left), digestRecallFieldIdentity(right)));
      if (values.length === 0) throw new Error("abstract finite values cannot be empty");
      return Object.freeze({ ...coordinate, possible_values: Object.freeze(values) });
    }
    case "binding":
      return Object.freeze({ ...coordinate,
        possible_bindings: freezeStringSet(coordinate.possible_bindings) });
    case "temporal_interval":
      assertInterval(coordinate.minimum_epoch_ms, coordinate.maximum_epoch_ms,
        "abstract temporal interval");
      return Object.freeze({ ...coordinate });
    case "four_valued_proposition":
      return Object.freeze({ ...coordinate,
        possible_values: freezeStringSet(coordinate.possible_values) });
    case "correlation":
      return Object.freeze({ ...coordinate,
        possible_relations: freezeStringSet(coordinate.possible_relations) });
    case "identity_tie":
      coordinate.possible_winner_digests.forEach((value) =>
        assertDigest(value, "abstract tie winner"));
      return Object.freeze({ ...coordinate,
        possible_winner_digests: Object.freeze([
          ...new Set(coordinate.possible_winner_digests)
        ].sort(compareText)) });
    default:
      throw new Error("abstract coordinate domain is unsupported");
  }
}

function freezeStringSet<T extends string>(values: readonly T[]): readonly T[] {
  if (values.length === 0 || new Set(values).size !== values.length) {
    throw new Error("abstract finite domain must be nonempty and unique");
  }
  return Object.freeze([...values].sort(compareText));
}

function assertInterval(lower: number, upper: number, field: string): void {
  if (![lower, upper].every(Number.isFinite) || upper < lower) {
    throw new Error(`${field} is invalid`);
  }
}

export function assertIdentity(value: string, field: string): void {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new Error(`${field} must be a non-empty canonical identity`);
  }
}

export function assertDigest(value: string, field: string): asserts value is RecallFieldDigest {
  if (!/^sha256:[0-9a-f]{64}$/u.test(value)) throw new Error(`${field} must be sha256`);
}
