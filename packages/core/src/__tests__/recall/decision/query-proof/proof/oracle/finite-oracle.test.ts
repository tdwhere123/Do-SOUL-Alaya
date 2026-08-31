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
import {
  certifyAbstractSingletonWithFiniteOracle
} from "../../../../../../recall/decision/query-proof/proof/abstract/differential.js";
import type { LiveQueryProofAuthority } from
  "../../../../../../recall/decision/query-proof/live-query-proof-authority.js";
import type { PreparedRecallRequest } from
  "../../../../../../recall/runtime/recall-service-runner-types.js";
import {
  authorityFrom,
  cleanup,
  preparedAuthority
} from "../../../../integration/shadow/live-receipt-fixtures.js";
import {
  createKernelCase,
  membershipCoordinate,
  singletonOperator
} from "../abstract/proof-fixture.js";

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

  it("keeps one prefix with different answer bindings and reasons distinct", () => {
    const fixture: FiniteOracleFixture = {
      fixture_id: "binding-reason-distinctness",
      snapshot_digest: prepared.snapshotVector.vector_digest,
      k_max: 1,
      base_state: {},
      coordinates: [coordinate("binding", "answer_binding", "binding", ["alpha", "beta"])]
    };
    const result = enumerate(fixture, {
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
    expect(new Set(result.outcomes.map(({ trace_digest }) => trace_digest)).size).toBe(2);
  });

  it("exposes the legal identity-tail winner in the exact outcome set", () => {
    const fixture: FiniteOracleFixture = {
      fixture_id: "legal-identity-tail",
      snapshot_digest: prepared.snapshotVector.vector_digest,
      k_max: 1,
      base_state: {},
      coordinates: [coordinate("tie", "identity_tie", "identity_tie",
        ["a-only", "a-and-0"])]
    };
    const result = enumerate(fixture, {
      operator_id: "fixture_identity_tail_operator_v1",
      decide: ({ refinement }) => trace([
        valueOf(refinement, "tie") === "a-only" ? "a" : "0"
      ], "exact-tie-identity")
    });

    expect(result.outcomes.map(({ candidate_prefix }) => candidate_prefix))
      .toEqual([["0"], ["a"]]);
  });

  it("normalizes coordinate and choice permutations to identical oracle bytes", () => {
    const forward = pairFixture();
    const reverse: FiniteOracleFixture = {
      ...forward,
      coordinates: [...forward.coordinates].reverse().map((row) => ({
        ...row,
        choices: [...row.choices].reverse()
      }))
    };

    expect(enumerate(reverse, pairOperator())).toEqual(enumerate(forward, pairOperator()));
  });

  it("enumerates all refinement kinds as one 128-state simultaneous Cartesian product", () => {
    const specifications = [
      ["membership", "candidate_membership", "membership", [false, true]],
      ["witness", "witness_refinement", "numeric_interval", [0, 1]],
      ["feasibility", "semantic_feasibility", "semantic_feasibility",
        ["infeasible", "feasible"]],
      ["binding", "answer_binding", "binding", ["alpha", "beta"]],
      ["conflict", "proposition_conflict", "four_valued_proposition",
        ["supported_only", "both"]],
      ["correlation", "correlation_state", "correlation",
        ["same_group", "different_group"]],
      ["tie", "identity_tie", "identity_tie", ["a", "0"]]
    ] as const;
    const fixture: FiniteOracleFixture = {
      fixture_id: "all-refinement-kinds-simultaneous",
      snapshot_digest: prepared.snapshotVector.vector_digest,
      k_max: 1,
      base_state: {},
      coordinates: specifications.map(([id, kind, abstractKind, values]) =>
        coordinate(id, kind, abstractKind, values))
    };
    const result = enumerate(fixture, {
      operator_id: "fixture_all_kinds_operator_v1",
      decide: ({ refinement }) => trace(
        refinement.assignments.some(({ choice_id }) =>
          choice_id === "true" || choice_id === "1" || choice_id === "feasible" ||
          choice_id === "beta" || choice_id === "both" ||
          choice_id === "different_group" || choice_id === "0")
          ? ["candidate-a"] : [],
        "all-kinds"
      )
    });

    expect(result.refinement_count).toBe(128);
    expect(result.choice_coverage).toHaveLength(14);
    expect(result.choice_coverage.every(({ refinement_count }) =>
      refinement_count === 64)).toBe(true);
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

  it("captures the concrete operator id and callback once", () => {
    const fixture = oneCandidateFixture();
    const valid = membershipOperator();
    let idReads = 0;
    let decideReads = 0;
    const switching = new Proxy(valid, {
      get(target, property, receiver) {
        if (property === "operator_id") {
          idReads += 1;
          return idReads === 1 ? valid.operator_id : "decide_q";
        }
        if (property === "decide") {
          decideReads += 1;
          return decideReads === 1
            ? valid.decide
            : () => trace(["injected"], "injected");
        }
        return Reflect.get(target, property, receiver);
      }
    });

    const result = enumerate(fixture, switching);

    expect(result.outcomes).toHaveLength(2);
    expect(idReads).toBe(1);
    expect(decideReads).toBe(1);
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
    mutable.coordinates.push({
      coordinate_id: "second",
      sensitivity_id: "sensitivity:second",
      owner_id: "owner:second",
      kind: "candidate_membership" as const,
      abstract_kind: "membership" as const,
      choices: [{ choice_id: "false", value: false }]
    });

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

  it("captures the oracle result before an outcomes-array switch", () => {
    const fixture = pairFixture();
    const operator = pairOperator();
    const exact = enumerate(fixture, operator);
    let outcomesReads = 0;
    const switching = new Proxy(exact, {
      get(target, property, receiver) {
        if (property === "outcomes") {
          outcomesReads += 1;
          return outcomesReads === 1
            ? exact.outcomes
            : Object.freeze([exact.outcomes[0]!]);
        }
        return Reflect.get(target, property, receiver);
      }
    });

    const captured = assertFiniteOracleExhaustive({
      authority: authorityFrom(prepared), fixture, operator, result: switching
    });

    expect(captured.outcomes).toHaveLength(4);
    expect(outcomesReads).toBe(1);
  });

  it("rejects an oracle result whose caller-owned outcomes later switch to singleton", () => {
    const fixture = pairFixture();
    const operator = pairOperator();
    const exact = enumerate(fixture, operator);
    const testCase = createKernelCase(authorityFrom(prepared), {
      fixture,
      concrete: operator,
      coordinates: [
        membershipCoordinate(["absent", "present"], "left", "sensitivity:left"),
        membershipCoordinate(["absent", "present"], "right", "sensitivity:right")
      ],
      operator: singletonOperator(["sensitivity:left", "sensitivity:right"]),
      k_max: fixture.k_max
    });
    let outcomesReads = 0;
    const switching = new Proxy(exact, {
      get(target, property, receiver) {
        if (property === "outcomes") {
          outcomesReads += 1;
          return outcomesReads <= 1
            ? exact.outcomes
            : Object.freeze([exact.outcomes[0]!]);
        }
        return Reflect.get(target, property, receiver);
      }
    });

    const result = certifyAbstractSingletonWithFiniteOracle(testCase.input, switching);

    expect(result.status).toBe("UNSUPPORTED");
    expect(outcomesReads).toBe(1);
  });
  it("uses one verified authority capture for the complete oracle operation", () => {
    const valid = authorityFrom(prepared);
    let workspaceReads = 0;
    const switching = new Proxy({ ...valid }, {
      get(target, property, receiver) {
        if (property === "workspace_id") {
          workspaceReads += 1;
          return workspaceReads === 1 ? valid.workspace_id : "workspace-injected";
        }
        return Reflect.get(target, property, receiver);
      }
    }) as LiveQueryProofAuthority;

    expect(enumerateFiniteDecisionOracle({
      authority: switching,
      fixture: oneCandidateFixture(),
      operator: membershipOperator()
    }).authority_digest).toMatch(/^sha256:/u);
    expect(workspaceReads).toBe(1);
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
  values: readonly (string | boolean | number | null)[]
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
