import { compareText, sameTextSet } from "../../../../../shared/compare-text.js";
import { digestRecallFieldIdentity } from
  "../../../../field/field-identity.js";
import {
  assertIdentity,
  decisionTraceSortKey,
  digestFiniteFixture,
  normalizeDecisionTrace,
  normalizeFiniteFixture,
  verifyFiniteDecisionTrace,
  type FiniteConcreteRefinement,
  type FiniteDecisionOperator,
  type FiniteDecisionOracleResult,
  type FiniteDecisionTrace,
  type FiniteOracleChoiceCoverage,
  type FiniteOracleFixture,
  type FiniteOracleRefinementResult,
  type FiniteRefinementAssignment
} from "./contract.js";
import { verifyFiniteMutualExclusionReceipt } from "./mutual-exclusion.js";
import {
  verifyFiniteTransferParticipants,
  type FiniteTransferAuthority
} from "./transfer-authority.js";

const issuedOracleResults = new WeakSet<object>();

export function enumerateFiniteDecisionOracle(
  fixtureInput: FiniteOracleFixture,
  operator: FiniteDecisionOperator,
  authority: FiniteTransferAuthority
): FiniteDecisionOracleResult {
  const transfer = verifyFiniteTransferParticipants({
    authority,
    fixture: fixtureInput,
    concrete_operator: operator
  });
  (fixtureInput.mutual_exclusion_receipts ?? []).forEach((receipt) =>
    verifyFiniteMutualExclusionReceipt(receipt, fixtureInput));
  const fixture = normalizeFiniteFixture(fixtureInput);
  assertOperator(operator);
  const concrete = enumerateLegalRefinements(fixture);
  const traces = new Map<string, FiniteDecisionTrace>();
  const refinements: FiniteOracleRefinementResult[] = [];
  for (const refinement of concrete) {
    const trace = decideDeterministically(operator, fixture, refinement);
    traces.set(trace.trace_digest, trace);
    refinements.push(Object.freeze({
      refinement_digest: refinement.refinement_digest,
      trace_digest: trace.trace_digest
    }));
  }
  refinements.sort((left, right) =>
    compareText(left.refinement_digest, right.refinement_digest));
  const outcomes = [...traces.values()].sort((left, right) =>
    compareText(decisionTraceSortKey(left), decisionTraceSortKey(right)));
  const body = Object.freeze({
    schema_version: 1 as const,
    operator_id: "finite_exhaustive_decision_oracle_v1" as const,
    fixture_digest: digestFiniteFixture(fixture),
    decision_operator_id: operator.operator_id,
    abstract_operator_id: transfer.abstract_operator.operator_id,
    transfer_digest: transfer.transfer_digest,
    manifest_digest: transfer.manifest_digest,
    refinement_count: concrete.length,
    refinements: Object.freeze(refinements),
    outcomes: Object.freeze(outcomes),
    choice_coverage: choiceCoverage(fixture, concrete)
  });
  const result = Object.freeze({ ...body, result_digest: digestRecallFieldIdentity(body) });
  issuedOracleResults.add(result);
  return result;
}

export function assertFiniteOracleExhaustive(
  fixtureInput: FiniteOracleFixture,
  result: FiniteDecisionOracleResult,
  authority: FiniteTransferAuthority
): void {
  const transfer = verifyFiniteTransferParticipants({ authority, fixture: fixtureInput });
  const fixture = normalizeFiniteFixture(fixtureInput);
  assertExactKeys(result, [
    "schema_version", "operator_id", "fixture_digest", "decision_operator_id",
    "abstract_operator_id", "transfer_digest", "manifest_digest",
    "refinement_count", "refinements", "outcomes", "choice_coverage",
    "result_digest"
  ], "finite oracle result");
  result.refinements.forEach((row) => {
    assertExactKeys(row, ["refinement_digest", "trace_digest"],
      "finite oracle refinement result");
  });
  result.outcomes.forEach((outcome) => verifyFiniteDecisionTrace(outcome, fixture.k_max));
  result.choice_coverage.forEach((row) => {
    assertExactKeys(row, ["coordinate_id", "choice_id", "refinement_count"],
      "finite oracle choice coverage");
    if (!Number.isSafeInteger(row.refinement_count) || row.refinement_count < 0) {
      throw new Error("finite oracle choice coverage count is invalid");
    }
  });
  const expected = enumerateLegalRefinements(fixture)
    .map(({ refinement_digest }) => refinement_digest);
  const actual = result.refinements.map(({ refinement_digest }) => refinement_digest);
  if (!sameTextSet(expected, actual) || result.refinement_count !== expected.length) {
    throw new Error("finite oracle omitted or duplicated a legal refinement branch");
  }
  if (!issuedOracleResults.has(result)) {
    throw new Error("finite oracle result is not source issued");
  }
  const outcomeDigests = new Set(result.outcomes.map(({ trace_digest }) => trace_digest));
  if (result.refinements.some(({ trace_digest }) => !outcomeDigests.has(trace_digest))) {
    throw new Error("finite oracle refinement references an omitted decision trace");
  }
  const { result_digest: _digest, ...body } = result;
  if (result.fixture_digest !== digestFiniteFixture(fixture) ||
      result.transfer_digest !== transfer.transfer_digest ||
      result.manifest_digest !== transfer.manifest_digest ||
      result.decision_operator_id !== transfer.concrete_operator.operator_id ||
      result.abstract_operator_id !== transfer.abstract_operator.operator_id ||
      result.result_digest !== digestRecallFieldIdentity(body)) {
    throw new Error("finite oracle result digest mismatch");
  }
}

function enumerateLegalRefinements(
  fixture: FiniteOracleFixture
): readonly FiniteConcreteRefinement[] {
  const normalized = normalizeFiniteFixture(fixture);
  let assignments: readonly (readonly FiniteRefinementAssignment[])[] = [Object.freeze([])];
  for (const coordinate of normalized.coordinates) {
    assignments = assignments.flatMap((prefix) => coordinate.choices.map((choice) =>
      Object.freeze([...prefix, Object.freeze({
        coordinate_id: coordinate.coordinate_id,
        kind: coordinate.kind,
        choice_id: choice.choice_id,
        value: choice.value
      })])));
  }
  return Object.freeze(assignments
    .filter((rows) => !isForbidden(rows, normalized))
    .map((rows) => Object.freeze({
      assignments: rows,
      refinement_digest: digestRecallFieldIdentity(rows)
    }))
    .sort((left, right) => compareText(left.refinement_digest, right.refinement_digest)));
}

function decideDeterministically(
  operator: FiniteDecisionOperator,
  fixture: FiniteOracleFixture,
  refinement: FiniteConcreteRefinement
): FiniteDecisionTrace {
  const input = Object.freeze({
    base_state: fixture.base_state,
    refinement,
    k_max: fixture.k_max
  });
  const first = normalizeDecisionTrace(operator.decide(input), fixture.k_max);
  const replay = normalizeDecisionTrace(operator.decide(input), fixture.k_max);
  if (first.trace_digest !== replay.trace_digest) {
    throw new Error("finite decision operator is not deterministic");
  }
  return first;
}

function isForbidden(
  assignments: readonly FiniteRefinementAssignment[],
  fixture: FiniteOracleFixture
): boolean {
  const selected = new Map(assignments.map((row) => [row.coordinate_id, row.choice_id]));
  return (fixture.mutual_exclusion_receipts ?? []).some((receipt) =>
    receipt.forbidden_combinations.some((combination) =>
      combination.every(({ coordinate_id, choice_id }) =>
        selected.get(coordinate_id) === choice_id)));
}

function choiceCoverage(
  fixture: FiniteOracleFixture,
  refinements: readonly FiniteConcreteRefinement[]
): readonly FiniteOracleChoiceCoverage[] {
  return Object.freeze(fixture.coordinates.flatMap((coordinate) =>
    coordinate.choices.map((choice) => Object.freeze({
      coordinate_id: coordinate.coordinate_id,
      choice_id: choice.choice_id,
      refinement_count: refinements.filter(({ assignments }) =>
        assignments.some((assignment) =>
          assignment.coordinate_id === coordinate.coordinate_id &&
          assignment.choice_id === choice.choice_id)).length
    }))));
}

function assertOperator(operator: FiniteDecisionOperator): void {
  assertIdentity(operator.operator_id, "finite decision operator id");
  if (!/^[a-z0-9][a-z0-9._:-]*$/u.test(operator.operator_id) ||
      operator.operator_id.includes("decide_q")) {
    throw new Error("finite fixture operator must not be named Decide_Q");
  }
}

function assertExactKeys(value: object, expectedFields: readonly string[], field: string): void {
  const keys = Object.keys(value).sort(compareText);
  const expected = [...expectedFields].sort(compareText);
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new Error(`${field} has unknown or missing fields`);
  }
}
