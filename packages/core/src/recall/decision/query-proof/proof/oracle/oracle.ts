import { compareText, sameTextSet } from "../../../../../shared/compare-text.js";
import { digestRecallFieldIdentity } from
  "../../../../field/field-identity.js";
import {
  assertIdentity,
  decisionTraceSortKey,
  digestFiniteFixture,
  normalizeDecisionTrace,
  normalizeFiniteFixture,
  type FiniteConcreteRefinement,
  type FiniteDecisionOperator,
  type FiniteDecisionOracleResult,
  type FiniteDecisionTrace,
  type FiniteOracleChoiceCoverage,
  type FiniteOracleFixture,
  type FiniteOracleRefinementResult,
  type FiniteRefinementAssignment
} from "./contract.js";

export function enumerateFiniteDecisionOracle(
  fixtureInput: FiniteOracleFixture,
  operator: FiniteDecisionOperator
): FiniteDecisionOracleResult {
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
    refinement_count: concrete.length,
    refinements: Object.freeze(refinements),
    outcomes: Object.freeze(outcomes),
    choice_coverage: choiceCoverage(fixture, concrete)
  });
  return Object.freeze({ ...body, result_digest: digestRecallFieldIdentity(body) });
}

export function assertFiniteOracleExhaustive(
  fixtureInput: FiniteOracleFixture,
  result: FiniteDecisionOracleResult
): void {
  const fixture = normalizeFiniteFixture(fixtureInput);
  const expected = enumerateLegalRefinements(fixture)
    .map(({ refinement_digest }) => refinement_digest);
  const actual = result.refinements.map(({ refinement_digest }) => refinement_digest);
  if (!sameTextSet(expected, actual) || result.refinement_count !== expected.length) {
    throw new Error("finite oracle omitted or duplicated a legal refinement branch");
  }
  const outcomeDigests = new Set(result.outcomes.map(({ trace_digest }) => trace_digest));
  if (result.refinements.some(({ trace_digest }) => !outcomeDigests.has(trace_digest))) {
    throw new Error("finite oracle refinement references an omitted decision trace");
  }
  const { result_digest: _digest, ...body } = result;
  if (result.fixture_digest !== digestFiniteFixture(fixture) ||
      result.result_digest !== digestRecallFieldIdentity(body)) {
    throw new Error("finite oracle result digest mismatch");
  }
}

export function enumerateLegalRefinements(
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
  if (operator.operator_id.toLocaleLowerCase().includes("decide_q")) {
    throw new Error("finite fixture operator must not be named Decide_Q");
  }
}
