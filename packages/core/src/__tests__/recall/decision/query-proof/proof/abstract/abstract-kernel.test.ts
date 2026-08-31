import { describe, expect, it } from "vitest";

import {
  bindClosureReceiptScope,
  createChannelClosureResult,
  type ChannelClosureScope,
  type ChannelRemainingEffect
} from "../../../../../../recall/decision/query-proof/closure/index.js";
import {
  enumerateFiniteDecisionOracle,
  type FiniteDecisionOperator,
  type FiniteOracleFixture
} from "../../../../../../recall/decision/query-proof/proof/oracle/index.js";
import {
  compareAbstractProofToOracle,
  evaluateAbstractProofKernel,
  type AbstractCoordinate,
  type AbstractDecisionOperator,
  type AbstractProofKernelInput
} from "../../../../../../recall/decision/query-proof/proof/abstract/index.js";

const SNAPSHOT = `sha256:${"a".repeat(64)}` as const;
const QUERY = `sha256:${"b".repeat(64)}` as const;

describe("sound-but-incomplete abstract proof kernel", () => {
  it("has zero false singleton proofs and over-approximates the finite corpus", () => {
    const cases = [
      corpusCase([false, true]),
      corpusCase([true]),
      simultaneousCorpusCase()
    ];
    const comparisons = cases.map(({ oracle, proof }) =>
      compareAbstractProofToOracle(proof, oracle));

    expect(comparisons.filter(({ false_singleton }) => false_singleton)).toEqual([]);
    expect(comparisons.flatMap(({ missing_concrete_outcome_digests }) =>
      missing_concrete_outcome_digests)).toEqual([]);
    expect(cases[0]!.proof.status).toBe("OPEN");
    expect(cases[1]!.proof.status).toBe("PROVED_SINGLETON");
  });

  it("assumes simultaneous effects unless a verified oracle fixture excludes them", () => {
    const { oracle, proof } = simultaneousCorpusCase();
    expect(oracle.outcomes).toHaveLength(4);
    expect(proof.status).toBe("OPEN");
    if (proof.status !== "OPEN") throw new Error("expected open proof");
    expect(proof.possible_outcomes).toHaveLength(4);
  });

  it.each([
    ["open identity tail", identityCoordinate("open")],
    ["unknown correlation", correlationCoordinate(["same_group", "unknown"])],
    ["unresolved feasibility", feasibilityCoordinate(["feasible", "unresolved"])],
    ["overlapping extremum", numericCoordinate(true)]
  ] as const)("keeps %s OPEN", (_name, coordinate) => {
    const result = evaluateAbstractProofKernel(kernelInput({
      coordinates: [coordinate],
      operator: singletonAbstractOperator()
    }));

    expect(result.status).toBe("OPEN");
    if (result.status !== "OPEN") throw new Error("expected open proof");
    expect(result.requested_refinements).toHaveLength(1);
    expect(result.requested_refinements[0]?.owner_id).toBe("test-channel");
  });

  it("keeps unavailable, truncated-without-bound, and open ANN/graph channels OPEN", () => {
    for (const reason of [
      "source_unavailable",
      "truncated_without_effect_bound",
      "open_ann_without_sound_bound",
      "open_graph_without_sound_bound",
      "osf_not_run"
    ]) {
      const result = evaluateAbstractProofKernel(kernelInput({
        closures: [createChannelClosureResult({
          scope: scope("test-channel"),
          status: "uncertified",
          reason
        })],
        coordinates: [],
        operator: singletonAbstractOperator()
      }));
      expect(result.status).toBe("OPEN");
    }
  });

  it("returns CONFLICT for a four-valued proposition conflict", () => {
    const result = evaluateAbstractProofKernel(kernelInput({
      coordinates: [{
        coordinate_id: "proposition",
        sensitivity_id: "proposition",
        owner_id: "test-channel",
        decision_changing: true,
        kind: "four_valued_proposition",
        possible_values: ["both"]
      }],
      operator: singletonAbstractOperator()
    }));

    expect(result.status).toBe("CONFLICT");
  });

  it("returns UNSUPPORTED rather than truncating coordinate/sensitivity/channel caps", () => {
    const coordinate = membershipCoordinate(["absent", "present"]);
    const coordinateOverflow = evaluateAbstractProofKernel(kernelInput({
      coordinates: [coordinate, { ...coordinate, coordinate_id: "second",
        sensitivity_id: "second" }],
      limits: { max_channels: 4, max_coordinates: 1, max_sensitivities: 4 },
      operator: singletonAbstractOperator()
    }));
    const channelOverflow = evaluateAbstractProofKernel(kernelInput({
      closures: [notApplicableClosure("a"), notApplicableClosure("b")],
      coordinates: [],
      limits: { max_channels: 1, max_coordinates: 4, max_sensitivities: 4 },
      operator: singletonAbstractOperator()
    }));
    const sensitivityOverflow = evaluateAbstractProofKernel(kernelInput({
      coordinates: [coordinate, { ...coordinate, coordinate_id: "second",
        sensitivity_id: "second" }],
      limits: { max_channels: 4, max_coordinates: 4, max_sensitivities: 1 },
      operator: singletonAbstractOperator()
    }));

    expect(coordinateOverflow.status).toBe("UNSUPPORTED");
    expect(channelOverflow.status).toBe("UNSUPPORTED");
    expect(sensitivityOverflow.status).toBe("UNSUPPORTED");
  });

  it("requests every decision-changing coordinate deterministically", () => {
    const coordinates = [
      membershipCoordinate(["absent", "present"]),
      { ...bindingCoordinate(["a", "b"]), coordinate_id: "binding-z",
        sensitivity_id: "binding-z" }
    ];
    const operator: AbstractDecisionOperator = {
      operator_id: "fixture_multi_outcome_abstract_v1",
      evaluate: () => ({
        status: "outcomes",
        handled_sensitivity_ids: ["membership", "binding-z"],
        outcomes: [trace([], "empty"), trace(["candidate-a"], "present")]
      })
    };

    const forward = evaluateAbstractProofKernel(kernelInput({ coordinates, operator }));
    const reversed = evaluateAbstractProofKernel(kernelInput({
      coordinates: [...coordinates].reverse(), operator
    }));

    expect(forward).toEqual(reversed);
    if (forward.status !== "OPEN") throw new Error("expected open proof");
    expect(forward.requested_refinements.map(({ sensitivity_id }) => sensitivity_id))
      .toEqual(["binding-z", "membership"]);
  });

  it("does not let hidden principal state affect authorized proof bytes", () => {
    const first = proofWithHiddenState(["hidden-a"]);
    const second = proofWithHiddenState(["hidden-a", "hidden-b"]);
    expect(first).toEqual(second);
  });

  it("requires a matching abstract coordinate for every bounded channel effect", () => {
    const effect: ChannelRemainingEffect = {
      effect_id: "answer:remaining",
      sensitivity_id: "answer",
      effect: "answer_binding",
      possible_bindings: ["a", "b"]
    };
    const closure = boundedClosure(effect);

    expect(evaluateAbstractProofKernel(kernelInput({
      closures: [closure],
      coordinates: [],
      operator: singletonAbstractOperator()
    })).status).toBe("OPEN");
  });
});

function corpusCase(values: readonly boolean[]) {
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
  const concrete = membershipConcreteOperator();
  const oracle = enumerateFiniteDecisionOracle(fixture, concrete);
  const possible = values.map((value) => value ? "present" as const : "absent" as const);
  const abstract: AbstractDecisionOperator = {
    operator_id: "fixture_membership_abstract_v1",
    evaluate: () => ({
      status: "outcomes",
      handled_sensitivity_ids: ["membership"],
      outcomes: possible.map((value) => value === "present"
        ? trace(["candidate-a"], "membership")
        : trace([], "membership"))
    })
  };
  const proof = evaluateAbstractProofKernel(kernelInput({
    coordinates: [membershipCoordinate(possible)],
    operator: abstract
  }));
  return { oracle, proof };
}

function simultaneousCorpusCase() {
  const fixture: FiniteOracleFixture = {
    fixture_id: "simultaneous-differential",
    snapshot_digest: SNAPSHOT,
    k_max: 2,
    base_state: {},
    coordinates: [
      { coordinate_id: "membership", kind: "candidate_membership", choices: [
        { choice_id: "absent", value: "absent" },
        { choice_id: "present", value: "present" }
      ]},
      { coordinate_id: "feasibility", kind: "semantic_feasibility", choices: [
        { choice_id: "infeasible", value: "infeasible" },
        { choice_id: "feasible", value: "feasible" }
      ]}
    ]
  };
  const concrete: FiniteDecisionOperator = {
    operator_id: "fixture_simultaneous_concrete_v1",
    decide: ({ refinement }) => {
      const value = (id: string) => refinement.assignments
        .find(({ coordinate_id }) => coordinate_id === id)?.value;
      return trace([
        ...(value("membership") === "present" ? ["candidate-a"] : []),
        ...(value("feasibility") === "feasible" ? ["candidate-b"] : [])
      ], "simultaneous");
    }
  };
  const oracle = enumerateFiniteDecisionOracle(fixture, concrete);
  const operator: AbstractDecisionOperator = {
    operator_id: "fixture_simultaneous_abstract_v1",
    evaluate: () => ({
      status: "outcomes",
      handled_sensitivity_ids: ["membership", "feasibility"],
      outcomes: [
        trace([], "simultaneous"),
        trace(["candidate-a"], "simultaneous"),
        trace(["candidate-b"], "simultaneous"),
        trace(["candidate-a", "candidate-b"], "simultaneous")
      ]
    })
  };
  const proof = evaluateAbstractProofKernel(kernelInput({
    coordinates: [
      membershipCoordinate(["absent", "present"]),
      feasibilityCoordinate(["infeasible", "feasible"])
    ],
    operator
  }));
  return { oracle, proof };
}

function kernelInput(overrides: Partial<AbstractProofKernelInput>): AbstractProofKernelInput {
  return {
    query_digest: QUERY,
    snapshot_digest: SNAPSHOT,
    principal_digest: `sha256:${"c".repeat(64)}`,
    k_max: 2,
    closures: [notApplicableClosure("test-channel")],
    coordinates: [],
    limits: { max_channels: 8, max_coordinates: 16, max_sensitivities: 16 },
    operator: singletonAbstractOperator(),
    ...overrides
  };
}

function scope(channelId: string): ChannelClosureScope {
  return {
    query_digest: QUERY,
    request_digest: `sha256:${"d".repeat(64)}`,
    snapshot_digest: SNAPSHOT,
    principal_digest: `sha256:${"c".repeat(64)}`,
    workspace_id: "workspace-1",
    observer_id: `${channelId}-observer`,
    channel_id: channelId,
    domain_id: "test-domain",
    universe_digest: `sha256:${"e".repeat(64)}`,
    sensitivities: [
      { sensitivity_id: "answer", effect: "answer_binding", target: "answer" },
      { sensitivity_id: "membership", effect: "tie_winner_membership", target: "candidate" },
      { sensitivity_id: "feasibility", effect: "feasibility_change", target: "candidate" }
    ]
  };
}

function notApplicableClosure(channelId: string) {
  return createChannelClosureResult({
    scope: scope(channelId),
    status: "not_applicable",
    reason: "test_not_applicable"
  });
}

function boundedClosure(effect: ChannelRemainingEffect) {
  const closureScope = scope("test-channel");
  bindClosureReceiptScope({
    scope: closureScope,
    source_receipt_digest: `sha256:${"f".repeat(64)}`,
    universe_digest: closureScope.universe_digest
  });
  return createChannelClosureResult({
    scope: closureScope,
    status: "bounded_open",
    remaining_effects: [effect],
    reason: "test_bounded"
  });
}

function membershipCoordinate(
  possible_states: readonly ("absent" | "present")[]
): AbstractCoordinate {
  return {
    coordinate_id: "membership",
    sensitivity_id: "membership",
    owner_id: "test-channel",
    decision_changing: true,
    kind: "membership",
    possible_states
  };
}

function feasibilityCoordinate(
  possible_states: readonly ("feasible" | "infeasible" | "unresolved")[]
): AbstractCoordinate {
  return {
    coordinate_id: "feasibility",
    sensitivity_id: "feasibility",
    owner_id: "test-channel",
    decision_changing: true,
    kind: "semantic_feasibility",
    possible_states
  };
}

function bindingCoordinate(possible_bindings: readonly string[]): AbstractCoordinate {
  return {
    coordinate_id: "binding",
    sensitivity_id: "answer",
    owner_id: "test-channel",
    decision_changing: true,
    kind: "binding",
    possible_bindings
  };
}

function correlationCoordinate(
  possible_relations: readonly ("same_group" | "different_group" | "unknown")[]
): AbstractCoordinate {
  return {
    coordinate_id: "correlation",
    sensitivity_id: "correlation",
    owner_id: "test-channel",
    decision_changing: true,
    kind: "correlation",
    possible_relations
  };
}

function identityCoordinate(universe: "finite" | "open"): AbstractCoordinate {
  return {
    coordinate_id: "identity-tail",
    sensitivity_id: "identity-tail",
    owner_id: "test-channel",
    decision_changing: true,
    kind: "identity_tie",
    universe,
    possible_winner_digests: [`sha256:${"1".repeat(64)}`]
  };
}

function numericCoordinate(overlaps_decision_boundary: boolean): AbstractCoordinate {
  return {
    coordinate_id: "extremum",
    sensitivity_id: "extremum",
    owner_id: "test-channel",
    decision_changing: true,
    kind: "numeric_interval",
    role: "extremum",
    lower: 1,
    upper: 2,
    overlaps_decision_boundary
  };
}

function membershipConcreteOperator(): FiniteDecisionOperator {
  return {
    operator_id: "fixture_membership_concrete_v1",
    decide: ({ refinement }) => trace(
      refinement.assignments[0]?.value === true ? ["candidate-a"] : [],
      "membership"
    )
  };
}

function singletonAbstractOperator(): AbstractDecisionOperator {
  return {
    operator_id: "fixture_singleton_abstract_v1",
    evaluate: () => ({
      status: "outcomes",
      handled_sensitivity_ids: [],
      outcomes: [trace(["candidate-a"], "singleton")]
    })
  };
}

function proofWithHiddenState(_hidden: readonly string[]) {
  return evaluateAbstractProofKernel(kernelInput({
    coordinates: [],
    operator: singletonAbstractOperator()
  }));
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
