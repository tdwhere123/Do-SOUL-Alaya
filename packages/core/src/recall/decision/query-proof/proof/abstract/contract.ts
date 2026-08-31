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
  verifyFiniteDecisionTrace,
  type FiniteDecisionTrace,
  type FiniteDecisionTraceInput,
  type FiniteValue
} from "../oracle/contract.js";
import {
  readFiniteTransferAuthority,
  type FiniteTransferAuthority
} from "../oracle/transfer-authority.js";

type CoordinateIdentity = Readonly<{
  readonly coordinate_id: string;
  readonly sensitivity_id: string;
  readonly owner_id: string;
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
    readonly transfer_digest: RecallFieldDigest;
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
  readonly transfer_authority: FiniteTransferAuthority;
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
  readonly concrete_operator_id: string;
  readonly fixture_digest: RecallFieldDigest;
  readonly transfer_digest: RecallFieldDigest;
  readonly manifest_digest: RecallFieldDigest;
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

const issuedAbstractResults = new WeakSet<object>();

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
  const transfer = safeTransferIdentity(input);
  return Object.freeze({
    schema_version: 1 as const,
    operator_id: "operator_parametric_abstract_proof_kernel_v1" as const,
    query_digest: input.query_digest,
    snapshot_digest: input.snapshot_digest,
    principal_digest: input.principal_digest,
    decision_operator_id: input.operator.operator_id,
    concrete_operator_id: transfer.concrete_operator_id,
    fixture_digest: transfer.fixture_digest,
    transfer_digest: transfer.transfer_digest,
    manifest_digest: transfer.manifest_digest,
    premise_digest: digestAbstractProofPremise(input)
  });
}

function digestAbstractProofPremise(
  input: AbstractProofKernelInput
): RecallFieldDigest {
  const transfer = safeTransferIdentity(input);
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
    decision_operator_id: input.operator.operator_id,
    transfer_digest: transfer.transfer_digest,
    manifest_digest: transfer.manifest_digest
  });
}

function safeTransferIdentity(input: AbstractProofKernelInput) {
  try {
    const state = readFiniteTransferAuthority(input.transfer_authority);
    return Object.freeze({
      concrete_operator_id: state.concrete_operator.operator_id,
      fixture_digest: state.fixture_digest,
      transfer_digest: state.transfer_digest,
      manifest_digest: state.manifest_digest
    });
  } catch {
    const invalid = digestRecallFieldIdentity({
      operator_id: "invalid_finite_transfer_authority",
      query_digest: input.query_digest,
      snapshot_digest: input.snapshot_digest,
      principal_digest: input.principal_digest,
      abstract_operator_id: input.operator?.operator_id ?? "unavailable"
    });
    return Object.freeze({
      concrete_operator_id: "unverified_concrete_operator",
      fixture_digest: invalid,
      transfer_digest: invalid,
      manifest_digest: invalid
    });
  }
}

export function sealAbstractResult<T extends object>(body: T): Readonly<T> &
Readonly<{ readonly proof_digest: RecallFieldDigest }> {
  const result = Object.freeze({ ...body, proof_digest: digestRecallFieldIdentity(body) });
  issuedAbstractResults.add(result);
  return result;
}

export function verifyAbstractProofKernelResult(
  result: AbstractProofKernelResult
): void {
  if (!issuedAbstractResults.has(result)) {
    throw new Error("abstract proof result is not source issued");
  }
  const variant = ABSTRACT_RESULT_FIELDS[result.status];
  if (variant === undefined) throw new Error("abstract proof status is invalid");
  assertExactObjectKeys(result, [...ABSTRACT_RESULT_IDENTITY_FIELDS, ...variant,
    "proof_digest"], "abstract proof result");
  const { proof_digest: proofDigest, ...body } = result;
  if (proofDigest !== digestRecallFieldIdentity(body)) {
    throw new Error("abstract proof result digest mismatch");
  }
  assertDigest(result.query_digest, "abstract result query");
  assertDigest(result.snapshot_digest, "abstract result snapshot");
  assertDigest(result.principal_digest, "abstract result principal");
  assertDigest(result.fixture_digest, "abstract result fixture");
  assertDigest(result.transfer_digest, "abstract result transfer");
  assertDigest(result.manifest_digest, "abstract result manifest");
  assertDigest(result.premise_digest, "abstract result premise");
  if (result.status === "PROVED_SINGLETON") {
    verifyFiniteDecisionTrace(result.outcome, result.outcome.candidate_prefix.length);
  } else if (result.status === "OPEN") {
    assertIdentity(result.reason, "abstract open reason");
    result.requested_refinements.forEach(verifyRefinementRequest);
    result.possible_outcomes.forEach((outcome) =>
      verifyFiniteDecisionTrace(outcome, outcome.candidate_prefix.length));
  } else if (result.status === "CONFLICT") {
    assertIdentity(result.reason, "abstract conflict reason");
    result.conflict_coordinate_ids.forEach((id) => assertIdentity(id,
      "abstract conflict coordinate"));
  } else {
    assertIdentity(result.reason, "abstract unsupported reason");
  }
}

function verifyRefinementRequest(request: AbstractRefinementRequest): void {
  assertExactObjectKeys(request, [
    "coordinate_id", "sensitivity_id", "owner_id", "domain_kind", "reason"
  ], "abstract refinement request");
  assertIdentity(request.coordinate_id, "abstract refinement coordinate");
  assertIdentity(request.sensitivity_id, "abstract refinement sensitivity");
  assertIdentity(request.owner_id, "abstract refinement owner");
  assertIdentity(request.reason, "abstract refinement reason");
  if (!ABSTRACT_REQUEST_DOMAINS.has(request.domain_kind)) {
    throw new Error("abstract refinement domain is invalid");
  }
}

function normalizeCoordinate(coordinate: AbstractCoordinate): AbstractCoordinate {
  assertIdentity(coordinate.coordinate_id, "abstract coordinate id");
  assertIdentity(coordinate.sensitivity_id, "abstract sensitivity id");
  assertIdentity(coordinate.owner_id, "abstract coordinate owner");
  switch (coordinate.kind) {
    case "membership":
      assertCoordinateKeys(coordinate, ["possible_states"]);
      assertEnumValues(coordinate.possible_states, MEMBERSHIP_STATES,
        "abstract membership state");
      return Object.freeze({ ...coordinate,
        possible_states: freezeStringSet(coordinate.possible_states) });
    case "semantic_feasibility":
      assertCoordinateKeys(coordinate, ["possible_states"]);
      assertEnumValues(coordinate.possible_states, FEASIBILITY_STATES,
        "abstract feasibility state");
      return Object.freeze({ ...coordinate,
        possible_states: freezeStringSet(coordinate.possible_states) });
    case "numeric_interval":
      assertCoordinateKeys(coordinate, [
        "role", "lower", "upper", "overlaps_decision_boundary"
      ]);
      if (!NUMERIC_ROLES.has(coordinate.role) ||
          typeof coordinate.overlaps_decision_boundary !== "boolean") {
        throw new Error("abstract numeric interval metadata is invalid");
      }
      assertInterval(coordinate.lower, coordinate.upper, "abstract numeric interval");
      return Object.freeze({ ...coordinate });
    case "finite_values": {
      assertCoordinateKeys(coordinate, ["possible_values"]);
      const values = coordinate.possible_values.map(freezeFiniteValue)
        .sort((left, right) => compareText(
          digestRecallFieldIdentity(left), digestRecallFieldIdentity(right)));
      if (values.length === 0) throw new Error("abstract finite values cannot be empty");
      return Object.freeze({ ...coordinate, possible_values: Object.freeze(values) });
    }
    case "binding":
      assertCoordinateKeys(coordinate, ["possible_bindings"]);
      return Object.freeze({ ...coordinate,
        possible_bindings: freezeStringSet(coordinate.possible_bindings) });
    case "temporal_interval":
      assertCoordinateKeys(coordinate, ["minimum_epoch_ms", "maximum_epoch_ms"]);
      assertInterval(coordinate.minimum_epoch_ms, coordinate.maximum_epoch_ms,
        "abstract temporal interval");
      return Object.freeze({ ...coordinate });
    case "four_valued_proposition":
      assertCoordinateKeys(coordinate, ["possible_values"]);
      assertEnumValues(coordinate.possible_values, PROPOSITION_VALUES,
        "abstract proposition value");
      return Object.freeze({ ...coordinate,
        possible_values: freezeStringSet(coordinate.possible_values) });
    case "correlation":
      assertCoordinateKeys(coordinate, ["possible_relations"]);
      assertEnumValues(coordinate.possible_relations, CORRELATION_RELATIONS,
        "abstract correlation relation");
      return Object.freeze({ ...coordinate,
        possible_relations: freezeStringSet(coordinate.possible_relations) });
    case "identity_tie":
      assertCoordinateKeys(coordinate, ["universe", "possible_winner_digests"]);
      if (!IDENTITY_UNIVERSES.has(coordinate.universe)) {
        throw new Error("abstract identity universe is invalid");
      }
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

function assertCoordinateKeys(
  coordinate: AbstractCoordinate,
  domainKeys: readonly string[]
): void {
  const expected = ["coordinate_id", "sensitivity_id", "owner_id", "kind",
    ...domainKeys].sort(compareText);
  const keys = Object.keys(coordinate).sort(compareText);
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new Error("abstract coordinate has unknown or missing fields");
  }
}

function assertExactObjectKeys(
  value: object,
  allowed: readonly string[],
  field: string
): void {
  const keys = Object.keys(value).sort(compareText);
  const expected = [...allowed].sort(compareText);
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new Error(`${field} has unknown or missing fields`);
  }
}

function assertEnumValues(
  values: readonly string[],
  allowed: ReadonlySet<string>,
  field: string
): void {
  if (values.some((value) => !allowed.has(value))) throw new Error(`${field} is invalid`);
}

const MEMBERSHIP_STATES: ReadonlySet<string> = new Set(["absent", "present"]);
const FEASIBILITY_STATES: ReadonlySet<string> = new Set([
  "feasible", "infeasible", "unresolved"
]);
const NUMERIC_ROLES: ReadonlySet<string> = new Set([
  "proposition_bound", "extremum", "answer_position"
]);
const PROPOSITION_VALUES: ReadonlySet<string> = new Set([
  "supported_only", "refuted_only", "both", "unknown"
]);
const CORRELATION_RELATIONS: ReadonlySet<string> = new Set([
  "same_group", "different_group", "unknown"
]);
const IDENTITY_UNIVERSES: ReadonlySet<string> = new Set(["finite", "open"]);
const ABSTRACT_RESULT_IDENTITY_FIELDS = [
  "schema_version", "operator_id", "query_digest", "snapshot_digest",
  "principal_digest", "decision_operator_id", "concrete_operator_id",
  "fixture_digest", "transfer_digest", "manifest_digest", "premise_digest"
] as const;
const ABSTRACT_RESULT_FIELDS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  PROVED_SINGLETON: Object.freeze(["status", "outcome"]),
  OPEN: Object.freeze(["status", "reason", "requested_refinements", "possible_outcomes"]),
  CONFLICT: Object.freeze(["status", "reason", "conflict_coordinate_ids"]),
  UNSUPPORTED: Object.freeze(["status", "reason"])
});
const ABSTRACT_REQUEST_DOMAINS: ReadonlySet<string> = new Set([
  "membership", "numeric_interval", "finite_values", "binding",
  "temporal_interval", "four_valued_proposition", "correlation",
  "semantic_feasibility", "identity_tie", "channel_closure"
]);
