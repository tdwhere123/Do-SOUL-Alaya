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

export type FiniteRefinementChoice = Readonly<{
  readonly choice_id: string;
  readonly value: FiniteValue;
}>;

export type FiniteRefinementCoordinate = Readonly<{
  readonly coordinate_id: string;
  readonly kind: FiniteRefinementKind;
  readonly choices: readonly FiniteRefinementChoice[];
}>;

export type FiniteMutualExclusionAssignment = Readonly<{
  readonly coordinate_id: string;
  readonly choice_id: string;
}>;

export type FiniteMutualExclusionReceipt = Readonly<{
  readonly schema_version: 1;
  readonly operator_id: "finite_fixture_mutual_exclusion_v1";
  readonly fixture_id: string;
  readonly snapshot_digest: RecallFieldDigest;
  readonly forbidden_combinations:
    readonly (readonly FiniteMutualExclusionAssignment[])[];
  readonly receipt_digest: RecallFieldDigest;
}>;

export type FiniteOracleFixture = Readonly<{
  readonly fixture_id: string;
  readonly snapshot_digest: RecallFieldDigest;
  readonly k_max: number;
  readonly base_state: FiniteValue;
  readonly coordinates: readonly FiniteRefinementCoordinate[];
  readonly mutual_exclusion_receipts?: readonly FiniteMutualExclusionReceipt[];
}>;

export type FiniteRefinementAssignment = Readonly<{
  readonly coordinate_id: string;
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
  readonly fixture_digest: RecallFieldDigest;
  readonly decision_operator_id: string;
  readonly refinement_count: number;
  readonly refinements: readonly FiniteOracleRefinementResult[];
  readonly outcomes: readonly FiniteDecisionTrace[];
  readonly choice_coverage: readonly FiniteOracleChoiceCoverage[];
  readonly result_digest: RecallFieldDigest;
}>;

export function normalizeFiniteFixture(
  fixture: FiniteOracleFixture
): FiniteOracleFixture {
  assertIdentity(fixture.fixture_id, "finite fixture id");
  assertDigest(fixture.snapshot_digest, "finite fixture snapshot");
  if (!Number.isSafeInteger(fixture.k_max) || fixture.k_max < 0) {
    throw new Error("finite fixture K_max must be a non-negative safe integer");
  }
  const coordinates = fixture.coordinates.map(normalizeCoordinate)
    .sort((left, right) => compareText(left.coordinate_id, right.coordinate_id));
  assertUnique(coordinates.map(({ coordinate_id }) => coordinate_id),
    "finite fixture coordinate ids");
  const receipts = (fixture.mutual_exclusion_receipts ?? [])
    .map((receipt) => verifyMutualExclusionReceipt(receipt, fixture))
    .sort((left, right) => compareText(left.receipt_digest, right.receipt_digest));
  return Object.freeze({
    fixture_id: fixture.fixture_id,
    snapshot_digest: fixture.snapshot_digest,
    k_max: fixture.k_max,
    base_state: freezeFiniteValue(fixture.base_state),
    coordinates: Object.freeze(coordinates),
    ...(receipts.length === 0
      ? {}
      : { mutual_exclusion_receipts: Object.freeze(receipts) })
  });
}

export function digestFiniteFixture(fixture: FiniteOracleFixture): RecallFieldDigest {
  return digestRecallFieldIdentity(normalizeFiniteFixture(fixture));
}

export function normalizeDecisionTrace(
  input: FiniteDecisionTraceInput,
  kMax: number
): FiniteDecisionTrace {
  if (input.candidate_prefix.length > kMax) {
    throw new Error("finite decision trace exceeds K_max");
  }
  const prefix = input.candidate_prefix.map((candidate) => {
    assertIdentity(candidate, "finite trace candidate");
    return candidate;
  });
  assertUnique(prefix, "finite trace candidate prefix");
  const bindings = input.answer_bindings.map((binding) => {
    assertIdentity(binding.binding_id, "finite trace binding id");
    return Object.freeze({
      binding_id: binding.binding_id,
      value: freezeFiniteValue(binding.value)
    });
  }).sort((left, right) => compareText(left.binding_id, right.binding_id));
  assertUnique(bindings.map(({ binding_id }) => binding_id), "finite trace binding ids");
  const reasons = input.pick_reasons.map((reason) => Object.freeze({ ...reason }))
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
    return Object.freeze(value.map((item) => freezeFiniteValue(item)));
  }
  const record = value as Readonly<Record<string, FiniteValue>>;
  return Object.freeze(Object.fromEntries(Object.entries(record)
    .sort(([left], [right]) => compareText(left, right))
    .map(([key, item]) => [key, freezeFiniteValue(item)])));
}

function normalizeCoordinate(
  coordinate: FiniteRefinementCoordinate
): FiniteRefinementCoordinate {
  assertIdentity(coordinate.coordinate_id, "finite coordinate id");
  if (!REFINEMENT_KINDS.has(coordinate.kind)) {
    throw new Error("finite coordinate kind is unsupported");
  }
  if (coordinate.choices.length === 0) {
    throw new Error("finite coordinate requires at least one choice");
  }
  const choices = coordinate.choices.map((choice) => {
    assertIdentity(choice.choice_id, "finite choice id");
    return Object.freeze({
      choice_id: choice.choice_id,
      value: freezeFiniteValue(choice.value)
    });
  }).sort((left, right) => compareText(left.choice_id, right.choice_id));
  assertUnique(choices.map(({ choice_id }) => choice_id), "finite coordinate choice ids");
  return Object.freeze({ ...coordinate, choices: Object.freeze(choices) });
}

function verifyMutualExclusionReceipt(
  receipt: FiniteMutualExclusionReceipt,
  fixture: Pick<FiniteOracleFixture, "fixture_id" | "snapshot_digest">
): FiniteMutualExclusionReceipt {
  const { receipt_digest: _digest, ...body } = receipt;
  if (receipt.schema_version !== 1 ||
      receipt.operator_id !== "finite_fixture_mutual_exclusion_v1" ||
      receipt.fixture_id !== fixture.fixture_id ||
      receipt.snapshot_digest !== fixture.snapshot_digest ||
      receipt.receipt_digest !== digestRecallFieldIdentity(body)) {
    throw new Error("finite mutual exclusion receipt digest or binding mismatch");
  }
  return Object.freeze({ ...receipt });
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

const REFINEMENT_KINDS: ReadonlySet<string> = new Set([
  "candidate_membership",
  "witness_refinement",
  "semantic_feasibility",
  "answer_binding",
  "proposition_conflict",
  "correlation_state",
  "identity_tie"
]);
