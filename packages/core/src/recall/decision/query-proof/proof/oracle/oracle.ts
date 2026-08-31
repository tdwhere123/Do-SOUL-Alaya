import { compareText, sameTextSet } from "../../../../../shared/compare-text.js";
import { stableStringify } from "../../../../../shared/stable-stringify.js";
import { digestRecallFieldIdentity } from "../../../../field/field-identity.js";
import { deriveLiveClosureAuthorityBinding } from
  "../../closure/live-authority-binding.js";
import type { LiveQueryProofAuthority } from "../../live-query-proof-authority.js";
import {
  assertIdentity,
  decisionTraceSortKey,
  digestFiniteFixture,
  digestFiniteManifest,
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

export function enumerateFiniteDecisionOracle(params: Readonly<{
  readonly authority: LiveQueryProofAuthority;
  readonly fixture: FiniteOracleFixture;
  readonly operator: FiniteDecisionOperator;
}>): FiniteDecisionOracleResult {
  assertExactKeys(params, ["authority", "fixture", "operator"], "finite oracle input");
  const live = deriveLiveClosureAuthorityBinding(params.authority);
  const fixture = normalizeFiniteFixture(params.fixture);
  if (fixture.snapshot_digest !== live.snapshot_digest) {
    throw new Error("finite oracle fixture snapshot is outside live authority");
  }
  assertOperator(params.operator);
  const concrete = enumerateLegalRefinements(fixture);
  const traces = new Map<string, FiniteDecisionTrace>();
  const refinements: FiniteOracleRefinementResult[] = [];
  for (const refinement of concrete) {
    const trace = decideDeterministically(params.operator, fixture, refinement);
    traces.set(trace.trace_digest, trace);
    refinements.push(Object.freeze({
      refinement_digest: refinement.refinement_digest,
      trace_digest: trace.trace_digest
    }));
  }
  refinements.sort((left, right) => compareText(
    left.refinement_digest, right.refinement_digest));
  const outcomes = [...traces.values()].sort((left, right) =>
    compareText(decisionTraceSortKey(left), decisionTraceSortKey(right)));
  const body = Object.freeze({
    schema_version: 1 as const,
    operator_id: "finite_exhaustive_decision_oracle_v1" as const,
    authority_digest: live.authority_digest,
    query_digest: live.query_digest,
    snapshot_digest: live.snapshot_digest,
    principal_digest: live.principal_digest,
    fixture_digest: digestFiniteFixture(fixture),
    k_max: fixture.k_max,
    decision_operator_id: params.operator.operator_id,
    manifest_digest: digestFiniteManifest(fixture),
    refinement_count: concrete.length,
    refinements: Object.freeze(refinements),
    outcomes: Object.freeze(outcomes),
    choice_coverage: choiceCoverage(fixture, concrete)
  });
  return Object.freeze({ ...body, result_digest: digestRecallFieldIdentity(body) });
}

export function assertFiniteOracleExhaustive(params: Readonly<{
  readonly authority: LiveQueryProofAuthority;
  readonly fixture: FiniteOracleFixture;
  readonly operator: FiniteDecisionOperator;
  readonly result: FiniteDecisionOracleResult;
}>): void {
  assertExactKeys(params, ["authority", "fixture", "operator", "result"],
    "finite oracle verification input");
  const fixture = normalizeFiniteFixture(params.fixture);
  const result = params.result;
  assertExactKeys(result, [
    "schema_version", "operator_id", "authority_digest", "query_digest",
    "snapshot_digest", "principal_digest", "fixture_digest", "k_max",
    "decision_operator_id", "manifest_digest", "refinement_count", "refinements",
    "outcomes", "choice_coverage", "result_digest"
  ], "finite oracle result");
  result.refinements.forEach((row) => assertExactKeys(row,
    ["refinement_digest", "trace_digest"], "finite oracle refinement result"));
  result.outcomes.forEach((outcome) => verifyFiniteDecisionTrace(outcome, fixture.k_max));
  result.choice_coverage.forEach((row) => {
    assertExactKeys(row, ["coordinate_id", "choice_id", "refinement_count"],
      "finite oracle choice coverage");
    if (!Number.isSafeInteger(row.refinement_count) || row.refinement_count < 0) {
      throw new Error("finite oracle choice coverage count is invalid");
    }
  });
  const expectedRefinements = enumerateLegalRefinements(fixture)
    .map(({ refinement_digest }) => refinement_digest);
  const actualRefinements = result.refinements.map(({ refinement_digest }) =>
    refinement_digest);
  if (!sameTextSet(expectedRefinements, actualRefinements) ||
      result.refinement_count !== expectedRefinements.length) {
    throw new Error("finite oracle omitted or duplicated a legal refinement branch");
  }
  const expected = enumerateFiniteDecisionOracle({
    authority: params.authority,
    fixture,
    operator: params.operator
  });
  if (stableStringify(expected) !== stableStringify(result)) {
    throw new Error("finite oracle result does not match the exact operator replay");
  }
}

function enumerateLegalRefinements(
  fixture: FiniteOracleFixture
): readonly FiniteConcreteRefinement[] {
  let assignments: readonly (readonly FiniteRefinementAssignment[])[] = [Object.freeze([])];
  for (const coordinate of fixture.coordinates) {
    assignments = assignments.flatMap((prefix) => coordinate.choices.map((choice) =>
      Object.freeze([...prefix, Object.freeze({
        coordinate_id: coordinate.coordinate_id,
        kind: coordinate.kind,
        choice_id: choice.choice_id,
        value: choice.value
      })])));
  }
  return Object.freeze(assignments.map((rows) => Object.freeze({
    assignments: rows,
    refinement_digest: digestRecallFieldIdentity(rows)
  })).sort((left, right) => compareText(
    left.refinement_digest, right.refinement_digest)));
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
  assertExactKeys(operator, ["operator_id", "decide"], "finite decision operator");
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
