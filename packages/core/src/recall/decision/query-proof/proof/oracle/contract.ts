import { compareText } from "../../../../../shared/compare-text.js";
import { stableStringify } from "../../../../../shared/stable-stringify.js";
import {
  digestRecallFieldIdentity,
  type RecallFieldDigest
} from "../../../../field/field-identity.js";

export type FiniteValue =
  | null
  | boolean
  | number
  | string
  | readonly FiniteValue[]
  | Readonly<{ readonly [key: string]: FiniteValue }>;

export type FiniteRefinementKind =
  | "candidate_membership"
  | "witness_refinement"
  | "semantic_feasibility"
  | "answer_binding"
  | "proposition_conflict"
  | "correlation_state"
  | "identity_tie";

export type TransferAbstractKind =
  | "membership"
  | "numeric_interval"
  | "finite_values"
  | "binding"
  | "temporal_interval"
  | "four_valued_proposition"
  | "correlation"
  | "semantic_feasibility"
  | "identity_tie";

export type FiniteRefinementChoice = Readonly<{
  readonly choice_id: string;
  readonly value: FiniteValue;
}>;

export type FiniteRefinementCoordinate = Readonly<{
  readonly coordinate_id: string;
  readonly sensitivity_id: string;
  readonly owner_id: string;
  readonly kind: FiniteRefinementKind;
  readonly abstract_kind: TransferAbstractKind;
  readonly choices: readonly FiniteRefinementChoice[];
}>;

export type FiniteOracleFixture = Readonly<{
  readonly fixture_id: string;
  readonly snapshot_digest: RecallFieldDigest;
  readonly k_max: number;
  readonly base_state: FiniteValue;
  readonly coordinates: readonly FiniteRefinementCoordinate[];
}>;

export type FiniteRefinementAssignment = Readonly<{
  readonly coordinate_id: string;
  readonly owner_id: string;
  readonly kind: FiniteRefinementKind;
  readonly choice_id: string;
  readonly value: FiniteValue;
}>;

export type FiniteConcreteRefinement = Readonly<{
  readonly assignments: readonly FiniteRefinementAssignment[];
  readonly refinement_digest: RecallFieldDigest;
}>;

export type FiniteDecisionTraceInput = Readonly<{
  readonly candidate_prefix: readonly string[];
  readonly answer_bindings: readonly Readonly<{
    readonly binding_id: string;
    readonly value: FiniteValue;
  }>[];
  readonly pick_reasons: readonly Readonly<{
    readonly position: number;
    readonly candidate_key: string;
    readonly reason_id: string;
  }>[];
}>;

export type FiniteDecisionTrace = FiniteDecisionTraceInput & Readonly<{
  readonly trace_digest: RecallFieldDigest;
}>;

export type FiniteDecisionOperator = Readonly<{
  readonly operator_id: string;
  readonly decide: (input: Readonly<{
    readonly base_state: FiniteValue;
    readonly refinement: FiniteConcreteRefinement;
    readonly k_max: number;
  }>) => FiniteDecisionTraceInput;
}>;

export type FiniteOracleRefinementResult = Readonly<{
  readonly refinement_digest: RecallFieldDigest;
  readonly trace_digest: RecallFieldDigest;
}>;

export type FiniteOracleChoiceCoverage = Readonly<{
  readonly coordinate_id: string;
  readonly choice_id: string;
  readonly refinement_count: number;
}>;

export type FiniteDecisionOracleResult = Readonly<{
  readonly schema_version: 1;
  readonly operator_id: "finite_exhaustive_decision_oracle_v1";
  readonly authority_digest: RecallFieldDigest;
  readonly query_digest: RecallFieldDigest;
  readonly snapshot_digest: RecallFieldDigest;
  readonly principal_digest: RecallFieldDigest;
  readonly fixture_digest: RecallFieldDigest;
  readonly k_max: number;
  readonly decision_operator_id: string;
  readonly manifest_digest: RecallFieldDigest;
  readonly refinement_count: number;
  readonly refinements: readonly FiniteOracleRefinementResult[];
  readonly outcomes: readonly FiniteDecisionTrace[];
  readonly choice_coverage: readonly FiniteOracleChoiceCoverage[];
  readonly result_digest: RecallFieldDigest;
}>;

export function normalizeFiniteFixture(
  fixture: FiniteOracleFixture
): FiniteOracleFixture {
  assertAllowedKeys(fixture, [
    "fixture_id", "snapshot_digest", "k_max", "base_state", "coordinates"
  ], ["fixture_id", "snapshot_digest", "k_max", "base_state", "coordinates"],
  "finite fixture");
  assertIdentity(fixture.fixture_id, "finite fixture id");
  assertDigest(fixture.snapshot_digest, "finite fixture snapshot");
  if (!Number.isSafeInteger(fixture.k_max) || fixture.k_max < 0) {
    throw new Error("finite fixture K_max must be a non-negative safe integer");
  }
  const coordinates = fixture.coordinates.map(normalizeCoordinate)
    .sort((left, right) => compareText(left.coordinate_id, right.coordinate_id));
  assertUnique(coordinates.map(({ coordinate_id }) => coordinate_id),
    "finite fixture coordinate ids");
  return Object.freeze({
    fixture_id: fixture.fixture_id,
    snapshot_digest: fixture.snapshot_digest,
    k_max: fixture.k_max,
    base_state: freezeFiniteValue(fixture.base_state),
    coordinates: Object.freeze(coordinates)
  });
}

export function digestFiniteFixture(fixture: FiniteOracleFixture): RecallFieldDigest {
  return digestRecallFieldIdentity(normalizeFiniteFixture(fixture));
}

export function digestFiniteManifest(fixture: FiniteOracleFixture): RecallFieldDigest {
  return digestRecallFieldIdentity(normalizeFiniteFixture(fixture).coordinates.map((row) =>
    Object.freeze({
      coordinate_id: row.coordinate_id,
      sensitivity_id: row.sensitivity_id,
      owner_id: row.owner_id,
      concrete_kind: row.kind,
      abstract_kind: row.abstract_kind
    })));
}

export function normalizeDecisionTrace(
  input: FiniteDecisionTraceInput,
  kMax: number
): FiniteDecisionTrace {
  assertExactKeys(input, ["candidate_prefix", "answer_bindings", "pick_reasons"],
    "finite decision trace");
  if (input.candidate_prefix.length > kMax) {
    throw new Error("finite decision trace exceeds K_max");
  }
  const prefix = input.candidate_prefix.map((candidate) => {
    assertIdentity(candidate, "finite trace candidate");
    return candidate;
  });
  assertUnique(prefix, "finite trace candidate prefix");
  const bindings = input.answer_bindings.map((binding) => {
    assertExactKeys(binding, ["binding_id", "value"], "finite trace binding");
    assertIdentity(binding.binding_id, "finite trace binding id");
    return Object.freeze({
      binding_id: binding.binding_id,
      value: freezeFiniteValue(binding.value)
    });
  }).sort((left, right) => compareText(left.binding_id, right.binding_id));
  assertUnique(bindings.map(({ binding_id }) => binding_id), "finite trace binding ids");
  const reasons = input.pick_reasons.map((reason) => {
    assertExactKeys(reason, ["position", "candidate_key", "reason_id"],
      "finite trace reason");
    return Object.freeze({ ...reason });
  })
    .sort((left, right) => left.position - right.position);
  if (reasons.length !== prefix.length || reasons.some((reason, index) =>
    reason.position !== index || reason.candidate_key !== prefix[index] ||
    reason.reason_id.length === 0 || reason.reason_id.trim() !== reason.reason_id)) {
    throw new Error("finite decision trace pick reasons must cover the exact prefix");
  }
  const body = Object.freeze({
    candidate_prefix: Object.freeze(prefix),
    answer_bindings: Object.freeze(bindings),
    pick_reasons: Object.freeze(reasons)
  });
  return Object.freeze({ ...body, trace_digest: digestRecallFieldIdentity(body) });
}

export function verifyFiniteDecisionTrace(
  trace: FiniteDecisionTrace,
  kMax: number
): void {
  assertExactKeys(trace, [
    "candidate_prefix", "answer_bindings", "pick_reasons", "trace_digest"
  ], "finite decision trace result");
  const { trace_digest: traceDigest, ...body } = trace;
  const normalized = normalizeDecisionTrace(body, kMax);
  if (traceDigest !== normalized.trace_digest) {
    throw new Error("finite decision trace digest mismatch");
  }
}

export function decisionTraceSortKey(trace: FiniteDecisionTrace): string {
  return `${trace.candidate_prefix.join("\uffff")}\u0000${stableStringify({
    answer_bindings: trace.answer_bindings,
    pick_reasons: trace.pick_reasons
  })}`;
}

export function freezeFiniteValue(value: FiniteValue): FiniteValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("finite fixture value must be finite");
    return value;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!(index in value)) throw new Error("finite fixture array must be dense");
    }
    return Object.freeze(value.map((item) => freezeFiniteValue(item)));
  }
  if (typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error("finite fixture value must be a plain finite record");
  }
  const record = value as Readonly<Record<string, FiniteValue>>;
  return Object.freeze(Object.fromEntries(Object.entries(record)
    .sort(([left], [right]) => compareText(left, right))
    .map(([key, item]) => [key, freezeFiniteValue(item)])));
}

function normalizeCoordinate(
  coordinate: FiniteRefinementCoordinate
): FiniteRefinementCoordinate {
  assertExactKeys(coordinate, [
    "coordinate_id", "sensitivity_id", "owner_id", "kind", "abstract_kind", "choices"
  ],
    "finite coordinate");
  assertIdentity(coordinate.coordinate_id, "finite coordinate id");
  assertIdentity(coordinate.sensitivity_id, "finite coordinate sensitivity");
  assertIdentity(coordinate.owner_id, "finite coordinate owner");
  if (!REFINEMENT_KINDS.has(coordinate.kind) ||
      !compatibleKinds(coordinate.kind, coordinate.abstract_kind)) {
    throw new Error("finite coordinate kind is unsupported");
  }
  if (coordinate.choices.length === 0) {
    throw new Error("finite coordinate requires at least one choice");
  }
  const choices = coordinate.choices.map((choice) => {
    assertExactKeys(choice, ["choice_id", "value"], "finite choice");
    assertIdentity(choice.choice_id, "finite choice id");
    return Object.freeze({
      choice_id: choice.choice_id,
      value: freezeFiniteValue(choice.value)
    });
  }).sort((left, right) => compareText(left.choice_id, right.choice_id));
  assertUnique(choices.map(({ choice_id }) => choice_id), "finite coordinate choice ids");
  return Object.freeze({ ...coordinate, choices: Object.freeze(choices) });
}

function assertUnique(values: readonly string[], field: string): void {
  if (new Set(values).size !== values.length) throw new Error(`${field} must be unique`);
}

export function assertIdentity(value: string, field: string): void {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new Error(`${field} must be a non-empty canonical identity`);
  }
}

export function assertDigest(value: string, field: string): asserts value is RecallFieldDigest {
  if (!/^sha256:[0-9a-f]{64}$/u.test(value)) throw new Error(`${field} must be sha256`);
}

function assertAllowedKeys(
  value: object,
  allowed: readonly string[],
  required: readonly string[],
  field: string
): void {
  const keys = Object.keys(value);
  if (keys.some((key) => !allowed.includes(key)) ||
      required.some((key) => !Object.prototype.hasOwnProperty.call(value, key))) {
    throw new Error(`${field} has unknown or missing fields`);
  }
}

function assertExactKeys(value: object, expected: readonly string[], field: string): void {
  assertAllowedKeys(value, expected, expected, field);
}

const REFINEMENT_KINDS: ReadonlySet<string> = new Set([
  "candidate_membership",
  "witness_refinement",
  "semantic_feasibility",
  "answer_binding",
  "proposition_conflict",
  "correlation_state",
  "identity_tie"
]);

function compatibleKinds(concrete: FiniteRefinementKind, abstract: TransferAbstractKind) {
  switch (concrete) {
    case "candidate_membership": return abstract === "membership";
    case "witness_refinement":
      return abstract === "numeric_interval" || abstract === "finite_values" ||
        abstract === "temporal_interval";
    case "semantic_feasibility": return abstract === "semantic_feasibility";
    case "answer_binding": return abstract === "binding";
    case "proposition_conflict": return abstract === "four_valued_proposition";
    case "correlation_state": return abstract === "correlation";
    case "identity_tie": return abstract === "identity_tie";
  }
}
