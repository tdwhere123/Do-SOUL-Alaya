import { describe, expect, it } from "vitest";

import {
  assertFiniteOracleExhaustive as assertSourceOracleExhaustive,
  enumerateFiniteDecisionOracle as enumerateSourceOracle
} from "../../../../../../recall/decision/query-proof/proof/oracle/oracle.js";
import { createFiniteMutualExclusionReceipt } from
  "../../../../../../recall/decision/query-proof/proof/oracle/mutual-exclusion.js";
import {
  issueFiniteTransferAuthority,
  type FiniteTransferAuthority,
  type TransferAbstractKind
} from "../../../../../../recall/decision/query-proof/proof/oracle/transfer-authority.js";
import type {
  FiniteDecisionOperator,
  FiniteDecisionOracleResult,
  FiniteOracleFixture
} from "../../../../../../recall/decision/query-proof/proof/oracle/contract.js";

const SNAPSHOT = `sha256:${"a".repeat(64)}` as const;
const QUERY = `sha256:${"b".repeat(64)}` as const;
const PRINCIPAL = `sha256:${"c".repeat(64)}` as const;
const authorities = new WeakMap<object, FiniteTransferAuthority>();

describe("operator-parametric finite exhaustive oracle", () => {
  it("matches hand-enumerated one-candidate membership outcomes", () => {
    const fixture = oneCandidateFixture();
    const result = enumerateFiniteDecisionOracle(fixture, membershipOperator());

    expect(result.refinement_count).toBe(2);
    expect(result.outcomes.map(({ candidate_prefix }) => candidate_prefix))
      .toEqual([[], ["candidate-a"]]);
    expect(() => assertFiniteOracleExhaustive(fixture, result)).not.toThrow();
  });

  it("enumerates simultaneous membership and feasibility changes", () => {
    const fixture: FiniteOracleFixture = {
      fixture_id: "two-candidate-simultaneous",
      snapshot_digest: SNAPSHOT,
      k_max: 2,
      base_state: { candidates: ["candidate-a", "candidate-b"] },
      coordinates: [
        coordinate("membership-a", "candidate_membership", [false, true]),
        coordinate("feasibility-b", "semantic_feasibility", ["infeasible", "feasible"])
      ]
    };
    const result = enumerateFiniteDecisionOracle(fixture, {
      operator_id: "fixture_simultaneous_operator_v1",
      decide: ({ refinement }) => {
        const includeA = valueOf(refinement, "membership-a") === true;
        const includeB = valueOf(refinement, "feasibility-b") === "feasible";
        const prefix = [
          ...(includeA ? ["candidate-a"] : []),
          ...(includeB ? ["candidate-b"] : [])
        ];
        return trace(prefix, "simultaneous");
      }
    });

    expect(result.refinement_count).toBe(4);
    expect(result.outcomes.map(({ candidate_prefix }) => candidate_prefix)).toEqual([
      [],
      ["candidate-a"],
      ["candidate-a", "candidate-b"],
      ["candidate-b"]
    ]);
  });

  it("keeps equal prefixes with different binding and reason traces distinct", () => {
    const fixture: FiniteOracleFixture = {
      fixture_id: "binding-reason-distinctness",
      snapshot_digest: SNAPSHOT,
      k_max: 1,
      base_state: {},
      coordinates: [coordinate("binding", "answer_binding", ["alpha", "beta"])]
    };
    const result = enumerateFiniteDecisionOracle(fixture, {
      operator_id: "fixture_binding_reason_operator_v1",
      decide: ({ refinement }) => {
        const binding = String(valueOf(refinement, "binding"));
        return {
          candidate_prefix: ["candidate-a"],
          answer_bindings: [{ binding_id: "answer", value: binding }],
          pick_reasons: [{
            position: 0,
            candidate_key: "candidate-a",
            reason_id: `binding:${binding}`
          }]
        };
      }
    });

    expect(result.outcomes).toHaveLength(2);
    expect(result.outcomes.map(({ answer_bindings }) => answer_bindings[0]?.value))
      .toEqual(["alpha", "beta"]);
  });

  it("exposes an unseen identity-tail winner when an exact tie is legal", () => {
    const fixture: FiniteOracleFixture = {
      fixture_id: "identity-tail",
      snapshot_digest: SNAPSHOT,
      k_max: 1,
      base_state: {},
      coordinates: [coordinate("tie-membership", "identity_tie", ["a-only", "a-and-0"])]
    };
    const result = enumerateFiniteDecisionOracle(fixture, {
      operator_id: "fixture_identity_tail_operator_v1",
      decide: ({ refinement }) => trace([
        valueOf(refinement, "tie-membership") === "a-only" ? "a" : "0"
      ], "exact-tie-identity")
    });

    expect(result.outcomes.map(({ candidate_prefix }) => candidate_prefix))
      .toEqual([["0"], ["a"]]);
  });

  it("applies mutual exclusion only through a verified fixture-bound receipt", () => {
    const fixture: FiniteOracleFixture = {
      fixture_id: "verified-exclusion",
      snapshot_digest: SNAPSHOT,
      k_max: 2,
      base_state: {},
      coordinates: [
        coordinate("left", "candidate_membership", [false, true]),
        coordinate("right", "candidate_membership", [false, true])
      ]
    };
    const receipt = createFiniteMutualExclusionReceipt({
      fixture,
      proposition_digest: QUERY,
      evidence_digest: PRINCIPAL,
      forbidden_combinations: [[
        { coordinate_id: "left", choice_id: "true" },
        { coordinate_id: "right", choice_id: "true" }
      ]]
    });
    const constrained = { ...fixture, mutual_exclusion_receipts: [receipt] };

    expect(enumerateFiniteDecisionOracle(fixture, membershipPairOperator())
      .refinement_count).toBe(4);
    expect(enumerateFiniteDecisionOracle(constrained, membershipPairOperator())
      .refinement_count).toBe(3);
    expect(() => enumerateFiniteDecisionOracle({
      ...fixture,
      mutual_exclusion_receipts: [{ ...receipt, receipt_digest: SNAPSHOT }]
    }, membershipPairOperator())).toThrow(/mutual exclusion.*(?:authority|binding|digest)/u);
    expect(() => enumerateFiniteDecisionOracle({
      ...fixture,
      mutual_exclusion_receipts: [{ ...receipt }]
    }, membershipPairOperator())).toThrow(/mutual exclusion.*(?:authority|binding)/u);
  });

  it("normalizes coordinate, choice, and input enumeration order", () => {
    const forward = twoCoordinateFixture(false);
    const reversed = twoCoordinateFixture(true);

    expect(enumerateFiniteDecisionOracle(forward, membershipPairOperator()))
      .toEqual(enumerateFiniteDecisionOracle(reversed, membershipPairOperator()));
  });

  it("detects a planted omitted refinement branch", () => {
    const fixture = oneCandidateFixture();
    const result = enumerateFiniteDecisionOracle(fixture, membershipOperator());
    const omitted = { ...result, refinements: result.refinements.slice(1) };
    authorities.set(omitted, authorities.get(result)!);

    expect(() => assertFiniteOracleExhaustive(fixture, omitted))
      .toThrow(/omitted.*refinement/u);
  });

  it("covers every declared finite sensitivity kind in one simultaneous corpus", () => {
    const kinds = [
      "candidate_membership",
      "witness_refinement",
      "semantic_feasibility",
      "answer_binding",
      "proposition_conflict",
      "correlation_state",
      "identity_tie"
    ] as const;
    const fixture: FiniteOracleFixture = {
      fixture_id: "all-kinds",
      snapshot_digest: SNAPSHOT,
      k_max: 1,
      base_state: {},
      coordinates: kinds.map((kind) => coordinate(kind, kind, [false, true]))
    };
    const result = enumerateFiniteDecisionOracle(fixture, {
      operator_id: "fixture_all_kinds_operator_v1",
      decide: ({ refinement }) => trace(
        refinement.assignments.some(({ value }) => value === true)
          ? ["candidate-a"] : [],
        "all-kinds"
      )
    });

    expect(result.refinement_count).toBe(128);
    expect(result.choice_coverage).toHaveLength(14);
  });

  it("rejects operator relabeling even when its id and function are copied", () => {
    const fixture = oneCandidateFixture();
    const concrete = membershipOperator();
    const abstract = Object.freeze({
      operator_id: "fixture_relabel_abstract_v1",
      evaluate: () => ({ status: "unsupported", reason: "oracle only" })
    });
    const authority = issueFiniteTransferAuthority({
      fixture,
      concrete_operator: concrete,
      abstract_operator: abstract,
      query_digest: QUERY,
      principal_digest: PRINCIPAL,
      manifest: [{
        coordinate_id: "membership",
        sensitivity_id: "sensitivity:membership",
        owner_id: "owner:membership",
        concrete_kind: "candidate_membership",
        abstract_kind: "membership"
      }]
    });
    expect(() => enumerateSourceOracle(fixture, Object.freeze({ ...concrete }), authority))
      .toThrow(/participant identity/u);
  });

  it("uses locale-independent operator identity validation", () => {
    const fixture = oneCandidateFixture();
    const abstract = Object.freeze({
      operator_id: "fixture_locale_abstract_v1",
      evaluate: () => ({ status: "unsupported", reason: "oracle only" })
    });
    expect(() => issueFiniteTransferAuthority({
      fixture,
      concrete_operator: {
        operator_id: "DECİDE_Q",
        decide: () => trace([], "invalid")
      },
      abstract_operator: abstract,
      query_digest: QUERY,
      principal_digest: PRINCIPAL,
      manifest: [{
        coordinate_id: "membership",
        sensitivity_id: "sensitivity:membership",
        owner_id: "owner:membership",
        concrete_kind: "candidate_membership",
        abstract_kind: "membership"
      }]
    })).toThrow(/noncanonical|reserved/u);
  });
});

function oneCandidateFixture(): FiniteOracleFixture {
  return {
    fixture_id: "one-candidate-membership",
    snapshot_digest: SNAPSHOT,
    k_max: 1,
    base_state: { candidate: "candidate-a" },
    coordinates: [coordinate("membership", "candidate_membership", [false, true])]
  };
}

function twoCoordinateFixture(reverse: boolean): FiniteOracleFixture {
  const coordinates = [
    coordinate("left", "candidate_membership", reverse ? [true, false] : [false, true]),
    coordinate("right", "candidate_membership", reverse ? [true, false] : [false, true])
  ];
  return {
    fixture_id: "permutation",
    snapshot_digest: SNAPSHOT,
    k_max: 2,
    base_state: {},
    coordinates: reverse ? coordinates.reverse() : coordinates
  };
}

function coordinate(
  coordinate_id: string,
  kind: FiniteOracleFixture["coordinates"][number]["kind"],
  values: readonly (string | boolean)[]
) {
  return {
    coordinate_id,
    kind,
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

function membershipPairOperator(): FiniteDecisionOperator {
  return {
    operator_id: "fixture_membership_pair_operator_v1",
    decide: ({ refinement }) => trace([
      ...(valueOf(refinement, "left") === true ? ["left"] : []),
      ...(valueOf(refinement, "right") === true ? ["right"] : [])
    ], "pair")
  };
}

function valueOf(
  refinement: { readonly assignments: readonly { readonly coordinate_id: string;
    readonly value: unknown }[] },
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

function enumerateFiniteDecisionOracle(
  fixture: FiniteOracleFixture,
  concrete: FiniteDecisionOperator
): FiniteDecisionOracleResult {
  const abstract = Object.freeze({
    operator_id: "fixture_reference_abstract_v1",
    evaluate: () => Object.freeze({ status: "unsupported", reason: "oracle only" })
  });
  const authority = issueFiniteTransferAuthority({
    fixture,
    concrete_operator: concrete,
    abstract_operator: abstract,
    query_digest: QUERY,
    principal_digest: PRINCIPAL,
    manifest: fixture.coordinates.map((row) => Object.freeze({
      coordinate_id: row.coordinate_id,
      sensitivity_id: `sensitivity:${row.coordinate_id}`,
      owner_id: `owner:${row.coordinate_id}`,
      concrete_kind: row.kind,
      abstract_kind: abstractKind(row.kind)
    }))
  });
  const result = enumerateSourceOracle(fixture, concrete, authority);
  authorities.set(result, authority);
  return result;
}

function assertFiniteOracleExhaustive(
  fixture: FiniteOracleFixture,
  result: FiniteDecisionOracleResult
): void {
  const authority = authorities.get(result);
  if (authority === undefined) throw new Error("test oracle authority is unavailable");
  assertSourceOracleExhaustive(fixture, result, authority);
}

function abstractKind(kind: FiniteOracleFixture["coordinates"][number]["kind"]):
TransferAbstractKind {
  switch (kind) {
    case "candidate_membership": return "membership";
    case "witness_refinement": return "numeric_interval";
    case "semantic_feasibility": return "semantic_feasibility";
    case "answer_binding": return "binding";
    case "proposition_conflict": return "four_valued_proposition";
    case "correlation_state": return "correlation";
    case "identity_tie": return "identity_tie";
  }
}
