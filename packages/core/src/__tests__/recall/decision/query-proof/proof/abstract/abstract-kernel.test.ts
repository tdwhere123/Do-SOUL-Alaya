import { describe, expect, it } from "vitest";

import { digestRecallFieldIdentity } from
  "../../../../../../recall/field/field-identity.js";
import { createChannelClosureResult, type ChannelClosureResult } from
  "../../../../../../recall/decision/query-proof/closure/contract.js";
import { enumerateFiniteDecisionOracle } from
  "../../../../../../recall/decision/query-proof/proof/oracle/oracle.js";
import type {
  FiniteDecisionOperator,
  FiniteOracleFixture
} from "../../../../../../recall/decision/query-proof/proof/oracle/contract.js";
import { evaluateAbstractProofKernel } from
  "../../../../../../recall/decision/query-proof/proof/abstract/kernel.js";
import { compareAbstractProofToOracle } from
  "../../../../../../recall/decision/query-proof/proof/abstract/differential.js";
import type {
  AbstractCoordinate,
  AbstractDecisionOperator
} from "../../../../../../recall/decision/query-proof/proof/abstract/contract.js";
import {
  SNAPSHOT,
  createKernelCase,
  feasibilityCoordinate,
  identityCoordinate,
  membershipCoordinate,
  notApplicableClosure,
  scope,
  singletonOperator,
  trace
} from "./proof-fixture.js";

describe("sound operator-parametric abstract proof kernel", () => {
  it("has zero false singleton proofs and over-approximates the finite corpus", () => {
    const cases = [pairedMembership([false, true]), pairedMembership([true]),
      pairedSimultaneous()];
    const comparisons = cases.map(({ oracle, proof, authority }) =>
      compareAbstractProofToOracle(proof, oracle, authority));

    expect(comparisons.some(({ false_singleton }) => false_singleton)).toBe(false);
    expect(comparisons.flatMap(({ missing_concrete_outcome_digests }) =>
      missing_concrete_outcome_digests)).toEqual([]);
    expect(cases[0]!.proof.status).toBe("OPEN");
    expect(cases[1]!.proof.status).toBe("PROVED_SINGLETON");
    expect(cases[2]!.oracle.outcomes).toHaveLength(4);
  });

  it.each([
    ["open identity tail", identityCoordinate("open")],
    ["unknown correlation", correlationCoordinate()],
    ["unresolved feasibility", feasibilityCoordinate(["feasible", "unresolved"])],
    ["overlapping extremum", numericCoordinate()]
  ] as const)("keeps %s OPEN", (_name, coordinate) => {
    const testCase = createKernelCase({
      coordinates: [coordinate],
      operator: singletonOperator([coordinate.sensitivity_id])
    });
    const result = evaluateAbstractProofKernel(testCase.input);
    expect(result.status).toBe("OPEN");
    if (result.status === "OPEN") expect(result.requested_refinements).toHaveLength(1);
  });

  it("keeps every uncertified channel reason OPEN", () => {
    for (const reason of ["source_unavailable", "truncated_without_effect_bound",
      "open_ann_without_sound_bound", "open_graph_without_sound_bound", "osf_not_run"]) {
      const closure = createChannelClosureResult({
        scope: scope("test-channel"), status: "uncertified", reason
      });
      const result = evaluateAbstractProofKernel(createKernelCase({
        closures: [closure]
      }).input);
      expect(result.status).toBe("OPEN");
    }
  });

  it("returns CONFLICT for a four-valued proposition conflict", () => {
    const coordinate: AbstractCoordinate = {
      coordinate_id: "proposition",
      sensitivity_id: "proposition",
      owner_id: "test-channel",
      kind: "four_valued_proposition",
      possible_values: ["both"]
    };
    const result = evaluateAbstractProofKernel(createKernelCase({
      coordinates: [coordinate], operator: singletonOperator(["proposition"])
    }).input);
    expect(result.status).toBe("CONFLICT");
  });

  it("returns UNSUPPORTED rather than treating any cap as proof", () => {
    const coordinates = [membershipCoordinate(["present"]),
      membershipCoordinate(["present"], "second", "second")];
    const operator = singletonOperator(["membership", "second"]);
    expect(evaluateAbstractProofKernel(createKernelCase({
      coordinates, operator,
      limits: { max_channels: 8, max_coordinates: 1, max_sensitivities: 8 }
    }).input).status).toBe("UNSUPPORTED");
    expect(evaluateAbstractProofKernel(createKernelCase({
      coordinates, operator,
      limits: { max_channels: 8, max_coordinates: 8, max_sensitivities: 1 }
    }).input).status).toBe("UNSUPPORTED");
    expect(evaluateAbstractProofKernel(createKernelCase({
      closures: [notApplicableClosure("a"), notApplicableClosure("b")],
      limits: { max_channels: 1, max_coordinates: 8, max_sensitivities: 8 }
    }).input).status).toBe("UNSUPPORTED");
  });

  it("requires exact manifest coverage and explicit operator handling", () => {
    const coordinate = membershipCoordinate(["present"]);
    const identity = identityCoordinate("finite");
    const handled = createKernelCase({
      coordinates: [coordinate, identity],
      operator: singletonOperator(["membership", "identity-tail"])
    });
    const omitted = evaluateAbstractProofKernel({
      ...handled.input,
      coordinates: [coordinate]
    });
    expect(omitted.status).toBe("UNSUPPORTED");

    const unhandled = createKernelCase({
      coordinates: [coordinate], operator: singletonOperator([])
    });
    expect(evaluateAbstractProofKernel(unhandled.input).status).toBe("OPEN");
  });

  it("rejects caller relevance flags, operator relabels, and result extras", () => {
    const coordinate = membershipCoordinate(["present"]);
    const openTail = identityCoordinate("open");
    const planted = { ...openTail, decision_changing: false } as never;
    expect(evaluateAbstractProofKernel(createKernelCase({
      coordinates: [coordinate], operator: singletonOperator(["membership"])
    }).input).status).toBe("PROVED_SINGLETON");
    const plantedCase = createKernelCase({
      coordinates: [planted], operator: singletonOperator(["identity-tail"])
    });
    expect(evaluateAbstractProofKernel(plantedCase.input).status).toBe("UNSUPPORTED");

    const valid = createKernelCase({ coordinates: [coordinate],
      operator: singletonOperator(["membership"]) });
    const relabeled = Object.freeze({ ...valid.operator });
    expect(evaluateAbstractProofKernel({ ...valid.input, operator: relabeled }).status)
      .toBe("UNSUPPORTED");

    const extraOperator: AbstractDecisionOperator = Object.freeze({
      operator_id: "fixture_extra_result_abstract_v1",
      evaluate: () => ({
        status: "outcomes", handled_sensitivity_ids: ["membership"],
        outcomes: [trace(["candidate-a"])], extra: true
      } as never)
    });
    expect(evaluateAbstractProofKernel(createKernelCase({
      coordinates: [coordinate], operator: extraOperator
    }).input).status).toBe("UNSUPPORTED");
  });

  it("fails unauthorized principal/universe mutation but reflects authorized scope", () => {
    const valid = createKernelCase({ closures: [] });
    const proof = evaluateAbstractProofKernel(valid.input);
    expect(evaluateAbstractProofKernel({
      ...valid.input,
      principal_digest: `sha256:${"9".repeat(64)}`
    }).status).toBe("UNSUPPORTED");

    const closure = notApplicableClosure("test-channel");
    const { result_digest: _digest, ...body } = closure;
    const forgedBody = { ...body, universe_digest: `sha256:${"8".repeat(64)}` };
    const forged = { ...forgedBody,
      result_digest: digestRecallFieldIdentity(forgedBody) } as ChannelClosureResult;
    expect(evaluateAbstractProofKernel(createKernelCase({
      closures: [forged]
    }).input).status).toBe("OPEN");

    const authorized = createKernelCase({
      closures: [], principal_digest: `sha256:${"7".repeat(64)}`
    });
    expect(evaluateAbstractProofKernel(authorized.input).proof_digest)
      .not.toBe(proof.proof_digest);
  });

  it("rejects unrelated proof/oracle transfer pairs", () => {
    const first = pairedMembership([true]);
    const second = pairedMembership([false, true]);
    expect(() => compareAbstractProofToOracle(
      first.proof, second.oracle, first.authority)).toThrow(/identity|transfer|fixture/u);
  });
});

function pairedMembership(values: readonly boolean[]) {
  const fixture: FiniteOracleFixture = {
    fixture_id: `membership-${values.join("-")}`,
    snapshot_digest: SNAPSHOT,
    k_max: 1,
    base_state: {},
    coordinates: [{
      coordinate_id: "membership",
      kind: "candidate_membership",
      choices: values.map((value) => ({ choice_id: String(value), value }))
    }]
  };
  const concrete: FiniteDecisionOperator = Object.freeze({
    operator_id: "fixture_membership_concrete_v1",
    decide: ({ refinement }) => trace(
      refinement.assignments[0]?.value === true ? ["candidate-a"] : [], "membership")
  });
  const states = values.map((value) => value ? "present" as const : "absent" as const);
  const abstract: AbstractDecisionOperator = Object.freeze({
    operator_id: "fixture_membership_abstract_v1",
    evaluate: () => ({
      status: "outcomes", handled_sensitivity_ids: ["membership"],
      outcomes: states.map((state) => trace(
        state === "present" ? ["candidate-a"] : [], "membership"))
    })
  });
  const testCase = createKernelCase({ fixture, concrete, operator: abstract,
    coordinates: [membershipCoordinate(states)], k_max: 1 });
  return Object.freeze({
    ...testCase,
    oracle: enumerateFiniteDecisionOracle(fixture, concrete, testCase.authority),
    proof: evaluateAbstractProofKernel(testCase.input)
  });
}

function pairedSimultaneous() {
  const fixture: FiniteOracleFixture = {
    fixture_id: "simultaneous",
    snapshot_digest: SNAPSHOT,
    k_max: 2,
    base_state: {},
    coordinates: [
      { coordinate_id: "membership", kind: "candidate_membership", choices: [
        { choice_id: "absent", value: "absent" },
        { choice_id: "present", value: "present" }
      ] },
      { coordinate_id: "feasibility", kind: "semantic_feasibility", choices: [
        { choice_id: "infeasible", value: "infeasible" },
        { choice_id: "feasible", value: "feasible" }
      ] }
    ]
  };
  const concrete: FiniteDecisionOperator = Object.freeze({
    operator_id: "fixture_simultaneous_concrete_v1",
    decide: ({ refinement }) => {
      const value = (id: string) => refinement.assignments.find(({ coordinate_id }) =>
        coordinate_id === id)?.value;
      return trace([
        ...(value("membership") === "present" ? ["candidate-a"] : []),
        ...(value("feasibility") === "feasible" ? ["candidate-b"] : [])
      ], "simultaneous");
    }
  });
  const abstract: AbstractDecisionOperator = Object.freeze({
    operator_id: "fixture_simultaneous_abstract_v1",
    evaluate: () => ({
      status: "outcomes", handled_sensitivity_ids: ["membership", "feasibility"],
      outcomes: [trace([], "simultaneous"), trace(["candidate-a"], "simultaneous"),
        trace(["candidate-b"], "simultaneous"),
        trace(["candidate-a", "candidate-b"], "simultaneous")]
    })
  });
  const testCase = createKernelCase({ fixture, concrete, operator: abstract,
    coordinates: [membershipCoordinate(["absent", "present"]),
      feasibilityCoordinate(["infeasible", "feasible"])] });
  return Object.freeze({
    ...testCase,
    oracle: enumerateFiniteDecisionOracle(fixture, concrete, testCase.authority),
    proof: evaluateAbstractProofKernel(testCase.input)
  });
}

function correlationCoordinate(): AbstractCoordinate {
  return Object.freeze({
    coordinate_id: "correlation", sensitivity_id: "correlation",
    owner_id: "test-channel", kind: "correlation",
    possible_relations: ["same_group", "unknown"]
  });
}

function numericCoordinate(): AbstractCoordinate {
  return Object.freeze({
    coordinate_id: "extremum", sensitivity_id: "extremum",
    owner_id: "test-channel", kind: "numeric_interval", role: "extremum",
    lower: 1, upper: 2, overlaps_decision_boundary: true
  });
}
