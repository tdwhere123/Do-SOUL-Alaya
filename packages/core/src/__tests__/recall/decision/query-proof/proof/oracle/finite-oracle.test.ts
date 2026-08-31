import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  assertFiniteOracleExhaustive,
  enumerateFiniteDecisionOracle
} from "../../../../../../recall/decision/query-proof/proof/oracle/oracle.js";
import {
  normalizeFiniteFixture,
  type FiniteDecisionOperator,
  type FiniteOracleFixture,
  type FiniteRefinementKind,
  type TransferAbstractKind
} from "../../../../../../recall/decision/query-proof/proof/oracle/contract.js";
import type { PreparedRecallRequest } from
  "../../../../../../recall/runtime/recall-service-runner-types.js";
import {
  authorityFrom,
  cleanup,
  preparedAuthority
} from "../../../../integration/shadow/live-receipt-fixtures.js";

let prepared: PreparedRecallRequest;

beforeAll(async () => {
  prepared = await preparedAuthority();
});

afterAll(() => cleanup(prepared));

describe("source-bound finite exhaustive oracle", () => {
  it("matches a hand-enumerated membership corpus", () => {
    const fixture = oneCandidateFixture();
    const operator = membershipOperator();
    const result = enumerate(fixture, operator);

    expect(result.refinement_count).toBe(2);
    expect(result.outcomes.map(({ candidate_prefix }) => candidate_prefix))
      .toEqual([[], ["candidate-a"]]);
    expect(() => assertFiniteOracleExhaustive({
      authority: authorityFrom(prepared), fixture, operator, result
    })).not.toThrow();
  });

  it("enumerates all four simultaneous combinations without source exclusion", () => {
    const fixture = pairFixture();
    const result = enumerate(fixture, pairOperator());

    expect(result.refinement_count).toBe(4);
    expect(result.choice_coverage.every(({ refinement_count }) =>
      refinement_count === 2)).toBe(true);
    expect(result.outcomes.map(({ candidate_prefix }) => candidate_prefix)).toEqual([
      [], ["left"], ["left", "right"], ["right"]
    ]);
  });

  it("rejects a naked self-digested exclusion instead of deleting a branch", () => {
    const fixture = pairFixture();
    const planted = {
      ...fixture,
      mutual_exclusion_receipts: [{
        fixture_digest: fixture.snapshot_digest,
        forbidden_combinations: [[
          { coordinate_id: "left", choice_id: "true" },
          { coordinate_id: "right", choice_id: "true" }
        ]],
        receipt_digest: fixture.snapshot_digest
      }]
    } as unknown as FiniteOracleFixture;

    expect(() => enumerate(planted, pairOperator()))
      .toThrow(/unknown or missing fields/u);
    expect(enumerate(fixture, pairOperator()).refinement_count).toBe(4);
  });

  it("detects an omitted legal branch even if the result is freshly relabeled", () => {
    const fixture = oneCandidateFixture();
    const operator = membershipOperator();
    const result = enumerate(fixture, operator);
    const omitted = { ...result,
      refinement_count: 1,
      refinements: result.refinements.slice(1)
    };

    expect(() => assertFiniteOracleExhaustive({
      authority: authorityFrom(prepared), fixture, operator, result: omitted
    })).toThrow(/omitted or duplicated/u);
  });

  it("binds the exact concrete operator identity and replay", () => {
    const fixture = oneCandidateFixture();
    const operator = membershipOperator();
    const result = enumerate(fixture, operator);
    const relabeled = Object.freeze({ ...operator,
      operator_id: "fixture_relabelled_membership_v1" });

    expect(() => assertFiniteOracleExhaustive({
      authority: authorityFrom(prepared), fixture, operator: relabeled, result
    })).toThrow(/exact operator replay/u);
  });

  it("normalizes and deeply freezes caller-owned fixture state", () => {
    const base = { nested: { values: ["original"] } };
    const choices = [{ choice_id: "false", value: false },
      { choice_id: "true", value: true }];
    const mutable = {
      fixture_id: "mutable-fixture",
      snapshot_digest: prepared.snapshotVector.vector_digest,
      k_max: 1,
      base_state: base,
      coordinates: [{
        coordinate_id: "membership",
        sensitivity_id: "sensitivity:membership",
        owner_id: "owner:membership",
        kind: "candidate_membership" as const,
        abstract_kind: "membership" as const,
        choices
      }]
    };
    const normalized = normalizeFiniteFixture(mutable);
    base.nested.values[0] = "mutated";
    choices[0]!.value = true;
    mutable.coordinates.push(coordinate("second", "candidate_membership",
      "membership", [false]));

    expect(normalized.base_state).toEqual({ nested: { values: ["original"] } });
    expect(normalized.coordinates).toHaveLength(1);
    expect(normalized.coordinates[0]!.choices[0]!.value).toBe(false);
    expect(Object.isFrozen(normalized.base_state)).toBe(true);
    expect(Object.isFrozen((normalized.base_state as { nested: object }).nested)).toBe(true);
    expect(Object.isFrozen(normalized.coordinates[0]!.choices)).toBe(true);
  });

  it("uses locale-independent canonical operator-name rejection", () => {
    expect(() => enumerate(oneCandidateFixture(), {
      operator_id: "DECİDE_Q",
      decide: () => trace([], "invalid")
    })).toThrow(/named Decide_Q/u);
    expect(() => enumerate(oneCandidateFixture(), {
      operator_id: "fixture_turkish_i_v1",
      decide: () => trace([], "valid")
    })).not.toThrow();
  });
});

function enumerate(fixture: FiniteOracleFixture, operator: FiniteDecisionOperator) {
  return enumerateFiniteDecisionOracle({
    authority: authorityFrom(prepared), fixture, operator
  });
}

function oneCandidateFixture(): FiniteOracleFixture {
  return {
    fixture_id: "one-candidate-membership",
    snapshot_digest: prepared.snapshotVector.vector_digest,
    k_max: 1,
    base_state: { candidate: "candidate-a" },
    coordinates: [coordinate("membership", "candidate_membership",
      "membership", [false, true])]
  };
}

function pairFixture(): FiniteOracleFixture {
  return {
    fixture_id: "simultaneous-membership",
    snapshot_digest: prepared.snapshotVector.vector_digest,
    k_max: 2,
    base_state: {},
    coordinates: [
      coordinate("left", "candidate_membership", "membership", [false, true]),
      coordinate("right", "candidate_membership", "membership", [false, true])
    ]
  };
}

function coordinate(
  coordinateId: string,
  kind: FiniteRefinementKind,
  abstractKind: TransferAbstractKind,
  values: readonly (string | boolean)[]
) {
  return {
    coordinate_id: coordinateId,
    sensitivity_id: `sensitivity:${coordinateId}`,
    owner_id: `owner:${coordinateId}`,
    kind,
    abstract_kind: abstractKind,
    choices: values.map((value) => ({ choice_id: String(value), value }))
  } as const;
}

function membershipOperator(): FiniteDecisionOperator {
  return {
    operator_id: "fixture_membership_operator_v1",
    decide: ({ refinement }) => trace(
      valueOf(refinement, "membership") === true ? ["candidate-a"] : [],
      "membership"
    )
  };
}

function pairOperator(): FiniteDecisionOperator {
  return {
    operator_id: "fixture_pair_operator_v1",
    decide: ({ refinement }) => trace([
      ...(valueOf(refinement, "left") === true ? ["left"] : []),
      ...(valueOf(refinement, "right") === true ? ["right"] : [])
    ], "pair")
  };
}

function valueOf(
  refinement: { readonly assignments: readonly {
    readonly coordinate_id: string;
    readonly value: unknown;
  }[] },
  coordinateId: string
): unknown {
  return refinement.assignments.find(({ coordinate_id }) =>
    coordinate_id === coordinateId)?.value;
}

function trace(candidatePrefix: readonly string[], reason: string) {
  return {
    candidate_prefix: candidatePrefix,
    answer_bindings: [],
    pick_reasons: candidatePrefix.map((candidateKey, position) => ({
      position,
      candidate_key: candidateKey,
      reason_id: reason
    }))
  };
}
