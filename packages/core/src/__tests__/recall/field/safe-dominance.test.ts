import { describe, expect, it } from "vitest";

import { assessSafeCandidateDominance } from
  "../../../recall/field/safe-dominance.js";

describe("safe candidate dominance", () => {
  it("accepts only a feasible challenger that dominates every coordinate", () => {
    const assessment = assessSafeCandidateDominance({
      demand_atom_ids: ["demand:a", "demand:b"],
      resource_ids: ["entries", "tokens"],
      governance_risk_ids: ["retention", "visibility"],
      challenger: candidate("a", [0.8, 0.9], [0.9, 0.8], [1, 20], [0, 1]),
      challenged: candidate("b", [0.4, 0.7], [0.7, 0.8], [1, 25], [1, 1])
    });

    expect(assessment.dominated).toBe(true);
    expect(assessment.conditions).toEqual({
      challenger_feasible: true,
      relevance_interval_separated: true,
      coverage_dominates: true,
      resource_cost_dominates: true,
      governance_risk_dominates: true,
      deterministic_identity_winner: true
    });
    expect(assessment.assessment_digest).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  it("forbids destructive pruning when relevance intervals overlap", () => {
    const assessment = assessSafeCandidateDominance(baseInput({
      challenger: candidate("a", [0.65, 0.9], [1], [1], [0]),
      challenged: candidate("b", [0.5, 0.7], [0.8], [1], [0])
    }));

    expect(assessment.dominated).toBe(false);
    expect(assessment.conditions.relevance_interval_separated).toBe(false);
  });

  it("rejects a challenger that loses coverage, cost, or governance", () => {
    const challenged = candidate("b", [0.4, 0.6], [0.8], [2], [1]);
    const cases = [
      candidate("a", [0.7, 0.9], [0.7], [1], [0]),
      candidate("a", [0.7, 0.9], [0.9], [3], [0]),
      candidate("a", [0.7, 0.9], [0.9], [1], [2])
    ];

    expect(cases.map((challenger) => assessSafeCandidateDominance(baseInput({
      challenger,
      challenged
    })).dominated)).toEqual([false, false, false]);
  });

  it("uses candidate identity to break exact-vector symmetry", () => {
    const a = candidate("a", [0.5, 0.5], [0.8], [1], [0]);
    const b = candidate("b", [0.5, 0.5], [0.8], [1], [0]);

    expect(assessSafeCandidateDominance(baseInput({
      challenger: a,
      challenged: b
    })).dominated).toBe(true);
    expect(assessSafeCandidateDominance(baseInput({
      challenger: b,
      challenged: a
    })).dominated).toBe(false);
  });

  it("canonicalizes catalog and coordinate-map permutations", () => {
    const challenger = candidate("a", [0.8, 0.9], [0.9, 0.8], [1, 20], [0, 1]);
    const challenged = candidate("b", [0.4, 0.7], [0.7, 0.8], [1, 25], [1, 1]);
    const forward = assessSafeCandidateDominance({
      demand_atom_ids: ["demand:a", "demand:b"],
      resource_ids: ["entries", "tokens"],
      governance_risk_ids: ["retention", "visibility"],
      challenger,
      challenged
    });
    const reverse = assessSafeCandidateDominance({
      demand_atom_ids: ["demand:b", "demand:a"],
      resource_ids: ["tokens", "entries"],
      governance_risk_ids: ["visibility", "retention"],
      challenger: reverseCoordinateOrder(challenger),
      challenged: reverseCoordinateOrder(challenged)
    });

    expect(reverse.assessment_digest).toBe(forward.assessment_digest);
    expect(reverse).toEqual(forward);
  });
});

function baseInput(overrides: Readonly<{
  readonly challenger: ReturnType<typeof candidate>;
  readonly challenged: ReturnType<typeof candidate>;
}>) {
  return {
    demand_atom_ids: ["demand:a"],
    resource_ids: ["entries"],
    governance_risk_ids: ["retention"],
    ...overrides
  } as const;
}

function candidate(
  candidateKey: string,
  relevance: readonly [number, number],
  coverage: readonly number[],
  resources: readonly number[],
  governance: readonly number[]
) {
  return {
    candidate_key: candidateKey,
    feasible: true,
    relevance_interval: { lower: relevance[0], upper: relevance[1] },
    coverage_by_demand_atom: new Map(coverage.map((value, index) => [
      index === 0 ? "demand:a" : "demand:b",
      value
    ])),
    resource_cost_by_id: new Map(resources.map((value, index) => [
      index === 0 ? "entries" : "tokens",
      value
    ])),
    governance_risk_by_id: new Map(governance.map((value, index) => [
      index === 0 ? "retention" : "visibility",
      value
    ]))
  } as const;
}

function reverseCoordinateOrder(value: ReturnType<typeof candidate>) {
  return {
    ...value,
    coverage_by_demand_atom: new Map([...value.coverage_by_demand_atom].reverse()),
    resource_cost_by_id: new Map([...value.resource_cost_by_id].reverse()),
    governance_risk_by_id: new Map([...value.governance_risk_by_id].reverse())
  } as const;
}
