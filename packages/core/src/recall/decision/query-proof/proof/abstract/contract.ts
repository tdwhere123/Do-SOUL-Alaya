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
  digestFiniteFixture,
  digestFiniteManifest,
  normalizeFiniteFixture,
  verifyFiniteDecisionTrace,
  type FiniteDecisionOperator,
  type FiniteDecisionOracleResult,
  type FiniteDecisionTrace,
  type FiniteDecisionTraceInput,
  type FiniteOracleFixture,
  type FiniteValue
} from "../oracle/contract.js";
import { assertFiniteOracleExhaustive } from "../oracle/oracle.js";
import {
  captureVerifiedLiveClosureAuthority,
  type LiveClosureAuthorityBinding
} from
  "../../closure/live-authority-binding.js";
import type { LiveQueryProofAuthority } from "../../live-query-proof-authority.js";

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
  readonly live_authority: LiveQueryProofAuthority;
  readonly fixture: FiniteOracleFixture;
  readonly concrete_operator: FiniteDecisionOperator;
  readonly k_max: number;
  readonly closures: readonly ChannelClosureResult[];
  readonly coordinates: readonly AbstractCoordinate[];
  readonly limits: AbstractKernelLimits;
  readonly operator: AbstractDecisionOperator;
}>;

export type FiniteOracleDifferentialCertificate = Readonly<{
  readonly schema_version: 1;
  readonly operator_id: "finite_oracle_differential_certificate_v1";
  readonly authority_digest: RecallFieldDigest;
  readonly query_digest: RecallFieldDigest;
  readonly snapshot_digest: RecallFieldDigest;
  readonly principal_digest: RecallFieldDigest;
  readonly fixture_digest: RecallFieldDigest;
  readonly manifest_digest: RecallFieldDigest;
  readonly k_max: number;
  readonly concrete_operator_id: string;
  readonly abstract_operator_id: string;
  readonly oracle_result_digest: RecallFieldDigest;
  readonly abstract_premise_digest: RecallFieldDigest;
  readonly outcome_trace_digest: RecallFieldDigest;
  readonly false_singleton: false;
  readonly missing_concrete_outcome_digests: readonly [];
  readonly certificate_digest: RecallFieldDigest;
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
  readonly authority_digest: RecallFieldDigest;
  readonly query_digest: RecallFieldDigest;
  readonly snapshot_digest: RecallFieldDigest;
  readonly principal_digest: RecallFieldDigest;
  readonly decision_operator_id: string;
  readonly concrete_operator_id: string;
  readonly fixture_digest: RecallFieldDigest;
  readonly transfer_digest: RecallFieldDigest;
  readonly manifest_digest: RecallFieldDigest;
  readonly k_max: number;
  readonly premise_digest: RecallFieldDigest;
}>;

export type AbstractProofKernelResult =
  | (AbstractProofResultIdentity & Readonly<{
      readonly status: "PROVED_SINGLETON";
      readonly outcome: FiniteDecisionTrace;
      readonly differential_certificate: FiniteOracleDifferentialCertificate;
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

export function abstractResultIdentity(
  input: AbstractProofKernelInput,
  liveBinding?: LiveClosureAuthorityBinding
) {
  const transfer = safeProofIdentity(input, liveBinding);
  return Object.freeze({
    schema_version: 1 as const,
    operator_id: "operator_parametric_abstract_proof_kernel_v1" as const,
    authority_digest: transfer.authority_digest,
    query_digest: transfer.query_digest,
    snapshot_digest: transfer.snapshot_digest,
    principal_digest: transfer.principal_digest,
    decision_operator_id: input.operator.operator_id,
    concrete_operator_id: transfer.concrete_operator_id,
    fixture_digest: transfer.fixture_digest,
    transfer_digest: transfer.transfer_digest,
    manifest_digest: transfer.manifest_digest,
    k_max: input.k_max,
    premise_digest: digestAbstractProofPremise(input, transfer)
  });
}

function digestAbstractProofPremise(
  input: AbstractProofKernelInput,
  transfer: ReturnType<typeof safeProofIdentity>
): RecallFieldDigest {
  const closures = input.closures.map(({ channel_id, result_digest }) =>
    Object.freeze({ channel_id, result_digest }))
    .sort((left, right) => compareText(left.channel_id, right.channel_id) ||
      compareText(left.result_digest, right.result_digest));
  const coordinates = [...input.coordinates].sort((left, right) =>
    compareText(left.coordinate_id, right.coordinate_id));
  return digestRecallFieldIdentity({
    authority_digest: transfer.authority_digest,
    query_digest: transfer.query_digest,
    snapshot_digest: transfer.snapshot_digest,
    principal_digest: transfer.principal_digest,
    k_max: input.k_max,
    closures,
    coordinates,
    limits: input.limits,
    decision_operator_id: input.operator.operator_id,
    transfer_digest: transfer.transfer_digest,
    manifest_digest: transfer.manifest_digest
  });
}

function safeProofIdentity(
  input: AbstractProofKernelInput,
  liveBinding?: LiveClosureAuthorityBinding
) {
  try {
    const live = liveBinding ??
      captureVerifiedLiveClosureAuthority(input.live_authority).binding;
    const fixture = normalizeFiniteFixture(input.fixture);
    return Object.freeze({
      authority_digest: live.authority_digest,
      query_digest: live.query_digest,
      snapshot_digest: live.snapshot_digest,
      principal_digest: live.principal_digest,
      concrete_operator_id: input.concrete_operator.operator_id,
      fixture_digest: digestFiniteFixture(fixture),
      transfer_digest: digestRecallFieldIdentity({
        authority_digest: live.authority_digest,
        fixture_digest: digestFiniteFixture(fixture),
        concrete_operator_id: input.concrete_operator.operator_id,
        abstract_operator_id: input.operator.operator_id
      }),
      manifest_digest: digestFiniteManifest(fixture)
    });
  } catch {
    const invalid = digestRecallFieldIdentity({
      operator_id: "invalid_finite_transfer_authority",
      abstract_operator_id: input.operator?.operator_id ?? "unavailable"
    });
    return Object.freeze({
      authority_digest: invalid,
      query_digest: invalid,
      snapshot_digest: invalid,
      principal_digest: invalid,
      concrete_operator_id: "unverified_concrete_operator",
      fixture_digest: invalid,
      transfer_digest: invalid,
      manifest_digest: invalid
    });
  }
}

export function sealAbstractRefusalResult<T extends object>(body: T): Readonly<T> &
Readonly<{ readonly proof_digest: RecallFieldDigest }> {
  return Object.freeze({ ...body, proof_digest: digestRecallFieldIdentity(body) });
}

export function verifyAbstractProofKernelResult(
  result: AbstractProofKernelResult,
  input: AbstractProofKernelInput,
  oracle?: FiniteDecisionOracleResult
): void {
  const captured = captureVerifiedLiveClosureAuthority(input.live_authority);
  const stableInput = Object.freeze({ ...input, live_authority: captured.authority });
  verifyAbstractProofKernelResultAgainstBinding(
    result, stableInput, captured.binding, oracle);
}

function verifyAbstractProofKernelResultAgainstBinding(
  result: AbstractProofKernelResult,
  input: AbstractProofKernelInput,
  live: LiveClosureAuthorityBinding,
  oracle?: FiniteDecisionOracleResult
): void {
  const variant = ABSTRACT_RESULT_FIELDS[result.status];
  if (variant === undefined) throw new Error("abstract proof status is invalid");
  assertExactObjectKeys(result, [...ABSTRACT_RESULT_IDENTITY_FIELDS, ...variant,
    "proof_digest"], "abstract proof result");
  const { proof_digest: proofDigest, ...body } = result;
  if (proofDigest !== digestRecallFieldIdentity(body)) {
    throw new Error("abstract proof result digest mismatch");
  }
  assertDigest(result.query_digest, "abstract result query");
  assertDigest(result.authority_digest, "abstract result authority");
  assertDigest(result.snapshot_digest, "abstract result snapshot");
  assertDigest(result.principal_digest, "abstract result principal");
  assertDigest(result.fixture_digest, "abstract result fixture");
  assertDigest(result.transfer_digest, "abstract result transfer");
  assertDigest(result.manifest_digest, "abstract result manifest");
  assertDigest(result.premise_digest, "abstract result premise");
  if (result.status === "PROVED_SINGLETON") {
    verifyFiniteDecisionTrace(result.outcome, result.k_max);
    verifyDifferentialCertificate(result.differential_certificate, result, input, live, oracle);
  } else if (result.status === "OPEN") {
    assertIdentity(result.reason, "abstract open reason");
    result.requested_refinements.forEach(verifyRefinementRequest);
    result.possible_outcomes.forEach((outcome) =>
      verifyFiniteDecisionTrace(outcome, result.k_max));
  } else if (result.status === "CONFLICT") {
    assertIdentity(result.reason, "abstract conflict reason");
    result.conflict_coordinate_ids.forEach((id) => assertIdentity(id,
      "abstract conflict coordinate"));
  } else {
    assertIdentity(result.reason, "abstract unsupported reason");
  }
  const expectedIdentity = abstractResultIdentity(input, live);
  for (const field of ABSTRACT_RESULT_IDENTITY_FIELDS) {
    if (result[field] !== expectedIdentity[field]) {
      throw new Error("abstract proof result does not match the real input");
    }
  }
}

function verifyDifferentialCertificate(
  certificate: FiniteOracleDifferentialCertificate,
  result: Extract<AbstractProofKernelResult, { status: "PROVED_SINGLETON" }>,
  input: AbstractProofKernelInput,
  live: LiveClosureAuthorityBinding,
  oracle: FiniteDecisionOracleResult | undefined
): void {
  assertExactObjectKeys(certificate, [
    "schema_version", "operator_id", "authority_digest", "query_digest",
    "snapshot_digest", "principal_digest", "fixture_digest", "manifest_digest",
    "k_max", "concrete_operator_id", "abstract_operator_id", "oracle_result_digest",
    "abstract_premise_digest", "outcome_trace_digest", "false_singleton",
    "missing_concrete_outcome_digests", "certificate_digest"
  ], "finite oracle differential certificate");
  const { certificate_digest: _digest, ...body } = certificate;
  if (oracle === undefined || certificate.schema_version !== 1 ||
      certificate.operator_id !== "finite_oracle_differential_certificate_v1" ||
      certificate.false_singleton !== false ||
      !Array.isArray(certificate.missing_concrete_outcome_digests) ||
      certificate.missing_concrete_outcome_digests.length !== 0 ||
      certificate.certificate_digest !== digestRecallFieldIdentity(body) ||
      certificate.oracle_result_digest !== oracle.result_digest ||
      certificate.abstract_premise_digest !== result.premise_digest ||
      certificate.outcome_trace_digest !== result.outcome.trace_digest ||
      certificate.authority_digest !== result.authority_digest ||
      certificate.query_digest !== result.query_digest ||
      certificate.snapshot_digest !== result.snapshot_digest ||
      certificate.principal_digest !== result.principal_digest ||
      certificate.fixture_digest !== result.fixture_digest ||
      certificate.manifest_digest !== result.manifest_digest ||
      certificate.concrete_operator_id !== result.concrete_operator_id ||
      certificate.abstract_operator_id !== result.decision_operator_id ||
      certificate.k_max !== result.k_max || oracle.authority_digest !== result.authority_digest ||
      oracle.query_digest !== result.query_digest ||
      oracle.snapshot_digest !== result.snapshot_digest ||
      oracle.principal_digest !== result.principal_digest ||
      oracle.fixture_digest !== result.fixture_digest ||
      oracle.manifest_digest !== result.manifest_digest ||
      oracle.k_max !== result.k_max ||
      oracle.decision_operator_id !== result.concrete_operator_id ||
      oracle.outcomes.length !== 1 ||
      oracle.outcomes[0]!.trace_digest !== result.outcome.trace_digest) {
    throw new Error("finite oracle differential certificate mismatch");
  }
  assertFiniteOracleExhaustive({
    authority: input.live_authority,
    fixture: input.fixture,
    operator: input.concrete_operator,
    result: oracle
  });
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

export function assertIdentity(value: string, field: string): void {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new Error(`${field} must be a non-empty canonical identity`);
  }
}

export function assertDigest(value: string, field: string): asserts value is RecallFieldDigest {
  if (!/^sha256:[0-9a-f]{64}$/u.test(value)) throw new Error(`${field} must be sha256`);
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

const ABSTRACT_RESULT_IDENTITY_FIELDS = [
  "schema_version", "operator_id", "authority_digest", "query_digest", "snapshot_digest",
  "principal_digest", "decision_operator_id", "concrete_operator_id",
  "fixture_digest", "transfer_digest", "manifest_digest", "k_max", "premise_digest"
] as const;
const ABSTRACT_RESULT_FIELDS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  PROVED_SINGLETON: Object.freeze(["status", "outcome", "differential_certificate"]),
  OPEN: Object.freeze(["status", "reason", "requested_refinements", "possible_outcomes"]),
  CONFLICT: Object.freeze(["status", "reason", "conflict_coordinate_ids"]),
  UNSUPPORTED: Object.freeze(["status", "reason"])
});
const ABSTRACT_REQUEST_DOMAINS: ReadonlySet<string> = new Set([
  "membership", "numeric_interval", "finite_values", "binding",
  "temporal_interval", "four_valued_proposition", "correlation",
  "semantic_feasibility", "identity_tie", "channel_closure"
]);
