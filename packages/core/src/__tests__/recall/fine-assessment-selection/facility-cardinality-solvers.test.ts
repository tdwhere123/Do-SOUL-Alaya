import { describe, expect, it } from "vitest";

import type {
  CoverageIdentity,
  CoverageSelectableCandidate,
  CoverageSelectionCandidateState
} from "../../../recall/delivery/coverage-selection.js";
import type {
  CandidateCoverageAtom,
  CandidateCoverageReceipt
} from "../../../recall/delivery/fine-assessment-selection/coverage-atoms.js";
import {
  improveCoverageCardinalityByOneSwap,
  solveCoverageCardinalityExactly
} from "../../../recall/field/facility/cardinality-solvers.js";
import { createAttributedFacilityCoverageObjective } from
  "../../../recall/field/facility-objective.js";
import { materializeAttributedQueryFacilityDemand } from
  "../../../recall/field/query-facility-demand.js";

describe("facility cardinality solvers", () => {
  it("closes a greedy coverage trap with one swap and proves the exact optimum", () => {
    const fixture = coverageTrapFixture();
    const local = improveCoverageCardinalityByOneSwap({
      candidates: fixture.states,
      initial_candidate_keys: [key("broad"), key("left")],
      objective: fixture.objective
    });
    const exact = solveCoverageCardinalityExactly({
      candidates: fixture.states,
      cardinality: 2,
      objective: fixture.objective,
      time_limit_ms: 1_000
    });

    expect(local.initial_score).toBeCloseTo(1.6, 12);
    expect(local.final_score).toBeCloseTo(2, 12);
    expect(local.selected_candidate_keys).toEqual([key("left"), key("right")]);
    expect(local.swap_count).toBe(1);
    expect(local.objective).toEqual({
      schema_version: 1,
      operator_id: "attributed_facility_location_v1",
      mathematical_class: "monotone_submodular",
      configuration_digest: fixture.objective.configuration_digest
    });
    expect(exact.status).toBe("exact");
    expect(exact.objective).toEqual(local.objective);
    expect(exact.selected_candidate_keys).toEqual([key("left"), key("right")]);
    expect(exact.lower_bound).toBeCloseTo(2, 12);
    expect(exact.upper_bound).toBeCloseTo(2, 12);
    expect(exact.absolute_gap).toBeCloseTo(0, 12);
    expect(fixture.objective.mathematical_class).toBe("monotone_submodular");
  });

  it("returns an honest bound instead of claiming exactness on timeout", () => {
    const fixture = coverageTrapFixture();
    let tick = 0;
    const result = solveCoverageCardinalityExactly({
      candidates: fixture.states,
      cardinality: 2,
      objective: fixture.objective,
      time_limit_ms: 1,
      now: () => tick++
    });

    expect(result.status).toBe("time_limit");
    expect(result.upper_bound).toBeGreaterThanOrEqual(result.lower_bound);
    expect(result.absolute_gap).toBeCloseTo(
      result.upper_bound - result.lower_bound,
      12
    );
  });

  it("matches exhaustive enumeration across small attributed facility objectives", () => {
    for (const matrix of facilityMatrices()) {
      const fixture = matrixFixture(matrix);
      const exact = solveCoverageCardinalityExactly({
        candidates: fixture.states,
        cardinality: 3,
        objective: fixture.objective,
        time_limit_ms: 1_000
      });

      expect(exact.status).toBe("exact");
      expect(exact.lower_bound).toBeCloseTo(
        exhaustiveFacilityScore(matrix, 3, 0.25),
        12
      );
      expect(exact.absolute_gap).toBeCloseTo(0, 12);
    }
  });
});

function matrixFixture(matrix: readonly (readonly number[])[]) {
  const values = matrix.map((_, index) => candidate(`c${index}`));
  const demandValues = matrix[0]!.map((_, index) => `d${index}`);
  const demand = materializeAttributedQueryFacilityDemand({
    query_demand: {
      schema_version: 1,
      atoms: demandValues.map((value) => ({
        id: `object_id:${value}`,
        kind: "object_id" as const,
        value,
        priority: "core" as const
      }))
    },
    weights: {
      entity: 1,
      relation: 1,
      time: 1,
      logical_object: 1,
      independent_evidence: 1
    }
  });
  const receipts = new Map(values.map((value) => [
    value.fusion.candidate_key,
    coverageReceipt(value)
  ]));
  const matches = new Map(values.map((value, candidateIndex) => [
    value.fusion.candidate_key,
    matrix[candidateIndex]!.flatMap((strength, demandIndex) =>
      strength === 0 ? [] : [objectMatch(
        receipts.get(value.fusion.candidate_key)!,
        demandValues[demandIndex]!,
        strength
      )]
    )
  ]));
  return {
    objective: createAttributedFacilityCoverageObjective({
      base_relevance_weight: 0.25,
      demand,
      matches_by_candidate_key: matches
    }),
    states: values.map((value) => candidateState(
      value,
      receipts.get(value.fusion.candidate_key)!
    ))
  };
}

function facilityMatrices(): readonly (readonly (readonly number[])[])[] {
  return [
    [[1, 0, 0], [0, 1, 0], [0, 0, 1], [0.6, 0.6, 0], [0, 0.6, 0.6]],
    [[0.8, 0.2, 0], [0.1, 0.9, 0], [0, 0.2, 1], [0.7, 0.7, 0.7], [1, 0, 0.4]],
    [[0, 0, 0], [0.4, 0.4, 0.4], [0.9, 0, 0], [0, 0.9, 0], [0, 0, 0.9]],
    [[1, 1, 0], [1, 0, 1], [0, 1, 1], [0.75, 0.75, 0.75], [0.5, 0.5, 0.5]]
  ];
}

function exhaustiveFacilityScore(
  matrix: readonly (readonly number[])[],
  cardinality: number,
  baseWeight: number
): number {
  let best = Number.NEGATIVE_INFINITY;
  for (const selection of combinations(matrix.length, cardinality)) {
    const coverage = matrix[0]!.map((_, demandIndex) =>
      Math.max(...selection.map((candidateIndex) => matrix[candidateIndex]![demandIndex]!))
    );
    best = Math.max(best, cardinality * baseWeight + coverage.reduce((sum, value) => sum + value, 0));
  }
  return best;
}

function combinations(size: number, cardinality: number): readonly (readonly number[])[] {
  const output: number[][] = [];
  const visit = (start: number, selected: number[]): void => {
    if (selected.length === cardinality) {
      output.push([...selected]);
      return;
    }
    for (let index = start; index < size; index += 1) {
      selected.push(index);
      visit(index + 1, selected);
      selected.pop();
    }
  };
  visit(0, []);
  return output;
}

function coverageTrapFixture() {
  const candidates = [
    candidate("broad"),
    candidate("left"),
    candidate("right")
  ];
  const demand = materializeAttributedQueryFacilityDemand({
    query_demand: {
      schema_version: 1,
      atoms: [
        { id: "object_id:left", kind: "object_id", value: "left", priority: "core" },
        { id: "object_id:right", kind: "object_id", value: "right", priority: "core" }
      ]
    },
    weights: {
      entity: 1,
      relation: 1,
      time: 1,
      logical_object: 1,
      independent_evidence: 1
    }
  });
  const receipts = new Map(candidates.map((value) => [
    value.fusion.candidate_key,
    coverageReceipt(value)
  ]));
  const objective = createAttributedFacilityCoverageObjective({
    base_relevance_weight: 0,
    demand,
    matches_by_candidate_key: new Map([
      [key("broad"), [
        objectMatch(receipts.get(key("broad"))!, "left", 0.6),
        objectMatch(receipts.get(key("broad"))!, "right", 0.6)
      ]],
      [key("left"), [objectMatch(receipts.get(key("left"))!, "left", 1)]],
      [key("right"), [objectMatch(receipts.get(key("right"))!, "right", 1)]]
    ])
  });
  return {
    objective,
    states: candidates.map((value) => candidateState(
      value,
      receipts.get(value.fusion.candidate_key)!
    ))
  };
}

function candidateState(
  value: CoverageSelectableCandidate,
  coverage: CandidateCoverageReceipt
): CoverageSelectionCandidateState<CoverageSelectableCandidate> {
  return Object.freeze({
    candidate: value,
    identity: Object.freeze({
      objectKey: `object:${value.entry.object_id}`,
      gistKey: `gist:${value.entry.object_id}`
    } satisfies CoverageIdentity),
    relevance: 1,
    coverage
  });
}

function objectMatch(
  coverage: CandidateCoverageReceipt,
  demandValue: string,
  strength: number
) {
  const atom = coverage.atoms[0]!;
  return Object.freeze({
    demand_atom_id: `facility:logical_object:object_id:${demandValue}`,
    coverage_atom_id: atom.atom_id,
    independence_key: atom.independence_key,
    projection_form_keys: Object.freeze([]),
    alignment_operator_id: "identity_v1" as const,
    match_strength: strength
  });
}

function coverageReceipt(
  value: CoverageSelectableCandidate
): CandidateCoverageReceipt {
  return Object.freeze({
    schema_version: 1,
    operator_id: "attributed_coverage_atoms_v1",
    candidate_key: value.fusion.candidate_key,
    activation: Object.freeze({
      schema_version: 1,
      operator_id: "candidate_semantic_max_v1",
      state: "absent",
      score: null,
      winner: null,
      observations: Object.freeze([]),
      missing_channel_policy: "no_op"
    }),
    evidence_semantic_completeness: "not_observed",
    projection_match_count: 0,
    atoms: Object.freeze([objectAtom(value.entry.object_id)])
  });
}

function objectAtom(objectId: string): CandidateCoverageAtom {
  return Object.freeze({
    atom_id: `object:${key(objectId)}`,
    kind: "logical_object",
    strength: 1,
    independence_key: `object:${key(objectId)}`,
    evidence_object_id: null,
    document_identity: null,
    projection: null,
    demand_roles: Object.freeze([]),
    observation_channels: Object.freeze([])
  });
}

function candidate(objectId: string): CoverageSelectableCandidate {
  return Object.freeze({
    entry: Object.freeze({
      object_id: objectId,
      object_kind: "memory_entry" as const,
      evidence_refs: Object.freeze([])
    }),
    effectiveFactors: Object.freeze({
      activation: 1,
      relevance: 1,
      graph_support: 0,
      path_plasticity: 0,
      budget_penalty: 0,
      conflict_penalty: 0
    }),
    fusion: Object.freeze({ candidate_key: key(objectId), fused_score: 1 })
  });
}

function key(objectId: string): string {
  return `workspace_local:memory_entry:${objectId}`;
}
