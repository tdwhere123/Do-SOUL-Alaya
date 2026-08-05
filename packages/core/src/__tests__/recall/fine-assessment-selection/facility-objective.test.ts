import { describe, expect, it } from "vitest";

import {
  orderByCoverageMarginalGain,
  type CoverageSelectableCandidate
} from "../../../recall/delivery/coverage-selection.js";
import {
  resolveCandidateCoverageReceipt,
  type CandidateCoverageAtom,
  type CandidateCoverageReceipt
} from "../../../recall/delivery/fine-assessment-selection/coverage-atoms.js";
import { computeIndependentEvidenceCorroboration } from
  "../../../recall/field/independent-corroboration.js";
import { createAttributedFacilityCoverageObjective } from
  "../../../recall/field/facility-objective.js";
import { materializeAttributedQueryFacilityDemand } from
  "../../../recall/field/query-facility-demand.js";
import type { RecallQueryDemandAtom } from
  "../../../recall/query/recall-query-demand.js";

describe("independent Evidence corroboration", () => {
  it("collapses aliases inside one source before applying the cap", () => {
    const receipt = coverageReceipt("candidate-a", [
      evidenceAtom("source-a:weak", "evidence:source-a", 0.3),
      evidenceAtom("source-a:strong", "evidence:source-a", 0.8),
      evidenceAtom("source-b", "evidence:source-b", 0.7)
    ]);

    const corroboration = computeIndependentEvidenceCorroboration({
      coverage: receipt,
      support_cap: 0.9,
      source_weights: { "evidence:source-b": 0.5 }
    });

    expect(corroboration.support_score).toBeCloseTo(0.9, 12);
    expect(corroboration.configuration_digest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(corroboration.refutation).toEqual({
      state: "not_observed",
      score: null
    });
    expect(corroboration.sources).toEqual([
      expect.objectContaining({
        independence_key: "evidence:source-a",
        strength: 0.8,
        contribution: 0.8
      }),
      expect.objectContaining({
        independence_key: "evidence:source-b",
        strength: 0.7,
        contribution: 0.35
      })
    ]);
  });
});

describe("attributed facility coverage objective", () => {
  it("selects complementary demand coverage before redundant relevance", () => {
    const candidates = [candidate("a", 0.9), candidate("b", 0.8), candidate("c", 0.7)];
    const supplementaryData = coverageSupplementary();
    const receipts = new Map(candidates.map((value) => [
      value.fusion.candidate_key,
      resolveCandidateCoverageReceipt(value, supplementaryData)
    ]));
    const demand = facilityDemand({ objectIds: ["q1", "q2"] });
    const q1 = facilityDemandId("logical_object", "object_id", "q1");
    const q2 = facilityDemandId("logical_object", "object_id", "q2");
    const matches = new Map([
      [key("a"), [objectMatch(receipts.get(key("a"))!, q1)]],
      [key("b"), [objectMatch(receipts.get(key("b"))!, q1)]],
      [key("c"), [objectMatch(receipts.get(key("c"))!, q2)]]
    ]);
    const objective = createAttributedFacilityCoverageObjective({
      base_relevance_weight: 0.1,
      demand,
      matches_by_candidate_key: matches
    });

    expect(objective.configuration_digest).toMatch(/^sha256:[0-9a-f]{64}$/u);

    const ordered = orderByCoverageMarginalGain({
      candidates,
      relevanceByCandidateKey: new Map(candidates.map((value) => [
        value.fusion.candidate_key,
        value.fusion.fused_score
      ])),
      supplementaryData,
      objective
    });

    expect(ordered.map(({ entry }) => entry.object_id)).toEqual(["a", "c", "b"]);
  });

  it("uses a stable candidate identity tie break for the facility operator", () => {
    const forward = [candidate("b", 0.5), candidate("a", 0.5)];
    const reverse = [...forward].reverse();
    const objective = createAttributedFacilityCoverageObjective({
      base_relevance_weight: 1,
      demand: facilityDemand(),
      matches_by_candidate_key: new Map()
    });

    expect(order(forward, objective)).toEqual(["a", "b"]);
    expect(order(reverse, objective)).toEqual(["a", "b"]);
  });

  it("gives equivalent unordered attribution inputs one configuration identity", () => {
    const q1 = facilityDemandId("logical_object", "object_id", "q1");
    const q2 = facilityDemandId("logical_object", "object_id", "q2");
    const a1 = attributedMatch(q1, "object:a", 0.7);
    const a2 = attributedMatch(q2, "object:a", 0.5);
    const b1 = attributedMatch(q1, "object:b", 0.6);
    const forward = createAttributedFacilityCoverageObjective({
      base_relevance_weight: 0.25,
      demand: facilityDemand({ objectIds: ["q1", "q2"] }),
      matches_by_candidate_key: new Map([
        [key("a"), [a1, a2]],
        [key("b"), [b1]]
      ])
    });
    const reversed = createAttributedFacilityCoverageObjective({
      base_relevance_weight: 0.25,
      demand: facilityDemand({ objectIds: ["q2", "q1"] }),
      matches_by_candidate_key: new Map([
        [key("b"), [b1]],
        [key("a"), [a2, a1]]
      ])
    });

    expect(reversed.configuration_digest).toBe(forward.configuration_digest);
  });

  it("keeps attributed marginal gain non-negative and diminishing", () => {
    const stronger = candidate("a", 0.5);
    const weaker = candidate("b", 0.4);
    const timeDemand = facilityDemandId("time", "temporal", "requested");
    const objective = createAttributedFacilityCoverageObjective({
      base_relevance_weight: 0,
      demand: facilityDemand({ times: ["requested"] }),
      matches_by_candidate_key: new Map([
        [stronger.fusion.candidate_key, [factMatch(timeDemand, "complete")]],
        [weaker.fusion.candidate_key, [factMatch(timeDemand, "complete")]]
      ])
    });
    const state = objective.createState();
    const strongerCoverage = coverageReceipt(stronger.fusion.candidate_key, [factAtom()]);
    const weakerCoverage = coverageReceipt(weaker.fusion.candidate_key, [factAtom()]);
    const strongerParams = objectiveParams(stronger, strongerCoverage, state);

    expect(objective.marginalGain(strongerParams)).toBeCloseTo(0.4, 12);
    objective.accept(strongerParams);
    expect(objective.marginalGain(objectiveParams(
      weaker,
      weakerCoverage,
      state
    ))).toBe(0);
  });

  it("bounds an unseen candidate by residual facility demand", () => {
    const value = candidate("a", 1);
    const coverage = coverageReceipt(value.fusion.candidate_key, [objectAtom("a")]);
    const q1 = facilityDemandId("logical_object", "object_id", "q1");
    const objective = createAttributedFacilityCoverageObjective({
      base_relevance_weight: 0.2,
      demand: facilityDemand({ objectIds: ["q1", "q2"] }),
      matches_by_candidate_key: new Map([[
        value.fusion.candidate_key,
        [objectMatch(coverage, q1)]
      ]])
    });
    const state = objective.createState();

    expect(objective.unseenMarginalGainUpperBound?.({
      relevanceUpperBound: 1,
      state,
      supplementaryData: coverageSupplementary()
    })).toBeCloseTo(2.2, 12);
    objective.accept(objectiveParams(value, coverage, state));
    expect(objective.unseenMarginalGainUpperBound?.({
      relevanceUpperBound: 1,
      state,
      supplementaryData: coverageSupplementary()
    })).toBeCloseTo(1.2, 12);
  });

  it("rejects coverage attributed to a different candidate identity", () => {
    const value = candidate("a", 0.5);
    const objective = createAttributedFacilityCoverageObjective({
      base_relevance_weight: 1,
      demand: facilityDemand(),
      matches_by_candidate_key: new Map()
    });

    expect(() => objective.marginalGain(objectiveParams(
      value,
      coverageReceipt(key("b"), []),
      objective.createState()
    ))).toThrow(/identity mismatch/u);
  });

  it("satisfies diminishing returns over every three-item subset", () => {
    const values = [candidate("a", 0.9), candidate("b", 0.7), candidate("c", 0.6)];
    const receipts = new Map(values.map((value) => [
      value.fusion.candidate_key,
      coverageReceipt(value.fusion.candidate_key, [objectAtom(value.entry.object_id)])
    ]));
    const q1 = facilityDemandId("logical_object", "object_id", "q1");
    const q2 = facilityDemandId("logical_object", "object_id", "q2");
    const config = {
      base_relevance_weight: 0.2,
      demand: facilityDemand({ objectIds: ["q1", "q2"] }),
      matches_by_candidate_key: new Map([
        [key("a"), [objectMatch(receipts.get(key("a"))!, q1)]],
        [key("b"), [
          objectMatch(receipts.get(key("b"))!, q1),
          objectMatch(receipts.get(key("b"))!, q2)
        ]],
        [key("c"), [objectMatch(receipts.get(key("c"))!, q2)]]
      ])
    } as const;

    for (let smaller = 0; smaller < 1 << values.length; smaller += 1) {
      for (let larger = 0; larger < 1 << values.length; larger += 1) {
        if ((smaller & larger) !== smaller) continue;
        for (let index = 0; index < values.length; index += 1) {
          if ((larger & 1 << index) !== 0) continue;
          const smallGain = marginalAfter(config, values, receipts, smaller, index);
          const largeGain = marginalAfter(config, values, receipts, larger, index);
          expect(smallGain).toBeGreaterThanOrEqual(0);
          expect(largeGain).toBeGreaterThanOrEqual(0);
          expect(smallGain + Number.EPSILON).toBeGreaterThanOrEqual(largeGain);
        }
      }
    }
  });

  it("rejects a projection match that does not cite a captured form", () => {
    const value = candidate("a", 0.5);
    const coverage = coverageReceipt(value.fusion.candidate_key, [factAtom()]);
    const timeDemand = facilityDemandId("time", "temporal", "requested");
    const objective = createAttributedFacilityCoverageObjective({
      base_relevance_weight: 0,
      demand: facilityDemand({ times: ["requested"] }),
      matches_by_candidate_key: new Map([[value.fusion.candidate_key, [{
        demand_atom_id: timeDemand,
        coverage_atom_id: "fact:evidence-a:7",
        independence_key: "evidence:evidence-a",
        projection_form_keys: ["leave_one_slot_out:4:time"],
        alignment_operator_id: "exact_token_sequence_v1",
        match_strength: 0.8
      }]]])
    });

    expect(() => objective.marginalGain({
      candidate: value,
      identity: { objectKey: "object:a", gistKey: "gist:a" },
      relevance: 0.5,
      coverage,
      state: objective.createState(),
      supplementaryData: coverageSupplementary()
    })).toThrow(/projection form/u);
  });
});

function order(
  candidates: readonly CoverageSelectableCandidate[],
  objective: ReturnType<typeof createAttributedFacilityCoverageObjective>
): readonly string[] {
  return orderByCoverageMarginalGain({
    candidates,
    relevanceByCandidateKey: new Map(candidates.map((value) => [
      value.fusion.candidate_key,
      value.fusion.fused_score
    ])),
    supplementaryData: coverageSupplementary(),
    objective
  }).map(({ entry }) => entry.object_id);
}

function objectMatch(coverage: CandidateCoverageReceipt, demandAtomId: string) {
  const atom = coverage.atoms.find(({ kind }) => kind === "logical_object")!;
  return {
    demand_atom_id: demandAtomId,
    coverage_atom_id: atom.atom_id,
    independence_key: atom.independence_key,
    projection_form_keys: [],
    alignment_operator_id: "identity_v1",
    match_strength: 1
  } as const;
}

function factMatch(demandAtomId: string, form: string) {
  return {
    demand_atom_id: demandAtomId,
    coverage_atom_id: "fact:evidence-a:7",
    independence_key: "evidence:evidence-a",
    projection_form_keys: [form],
    alignment_operator_id: "exact_token_sequence_v1",
    match_strength: 0.8
  } as const;
}

function attributedMatch(
  demandAtomId: string,
  objectId: string,
  strength: number
) {
  return {
    demand_atom_id: demandAtomId,
    coverage_atom_id: `object:${objectId}`,
    independence_key: `object:${objectId}`,
    projection_form_keys: [],
    alignment_operator_id: "identity_v1",
    match_strength: strength
  } as const;
}

function facilityDemand(params: Readonly<{
  readonly objectIds?: readonly string[];
  readonly times?: readonly string[];
}> = {}) {
  const atoms: Readonly<RecallQueryDemandAtom>[] = [
    ...(params.objectIds ?? []).map((value) => queryDemandAtom("object_id", value)),
    ...(params.times ?? []).map((value) => queryDemandAtom("temporal", value))
  ];
  return materializeAttributedQueryFacilityDemand({
    query_demand: Object.freeze({ schema_version: 1, atoms: Object.freeze(atoms) }),
    weights: {
      entity: 1,
      relation: 1,
      time: 1,
      logical_object: 1,
      independent_evidence: 1
    }
  });
}

function queryDemandAtom(
  kind: "object_id" | "temporal",
  value: string
): Readonly<RecallQueryDemandAtom> {
  return Object.freeze({
    id: `${kind}:${value}`,
    kind,
    value,
    priority: "core"
  });
}

function facilityDemandId(
  kind: "logical_object" | "time",
  queryKind: "object_id" | "temporal",
  value: string
): string {
  return `facility:${kind}:${queryKind}:${value}`;
}

function objectiveParams(
  value: CoverageSelectableCandidate,
  coverage: CandidateCoverageReceipt,
  state: ReturnType<ReturnType<typeof createAttributedFacilityCoverageObjective>["createState"]>
) {
  return {
    candidate: value,
    identity: { objectKey: `object:${value.entry.object_id}`, gistKey: "gist" },
    relevance: value.fusion.fused_score,
    coverage,
    state,
    supplementaryData: coverageSupplementary()
  } as const;
}

function candidate(objectId: string, fusedScore: number): CoverageSelectableCandidate {
  return Object.freeze({
    entry: Object.freeze({
      object_id: objectId,
      object_kind: "memory_entry" as const,
      evidence_refs: Object.freeze([])
    }),
    effectiveFactors: Object.freeze({
      activation: 0.5,
      relevance: fusedScore,
      graph_support: 0,
      path_plasticity: 0,
      budget_penalty: 0,
      conflict_penalty: 0
    }),
    fusion: Object.freeze({ candidate_key: key(objectId), fused_score: fusedScore })
  });
}

function key(objectId: string): string {
  return `workspace_local:memory_entry:${objectId}`;
}

function coverageSupplementary() {
  return {
    evidenceGistsByMemoryId: {},
    embeddingSimilarityScores: {},
    evidenceSemanticActivationsByCandidateKey: new Map(),
    evidenceProjectionMatchesByRef: {}
  } as const;
}

function coverageReceipt(
  candidateKey: string,
  atoms: readonly CandidateCoverageAtom[]
): CandidateCoverageReceipt {
  return Object.freeze({
    schema_version: 1,
    operator_id: "attributed_coverage_atoms_v1",
    candidate_key: candidateKey,
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
    atoms: Object.freeze(atoms)
  });
}

function evidenceAtom(
  atomId: string,
  independenceKey: string,
  strength: number
): CandidateCoverageAtom {
  return Object.freeze({
    atom_id: atomId,
    kind: "independent_evidence",
    strength,
    independence_key: independenceKey,
    evidence_object_id: independenceKey.slice("evidence:".length),
    document_identity: null,
    projection: null,
    demand_roles: Object.freeze([]),
    observation_channels: Object.freeze(["evidence_semantic"])
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

function marginalAfter(
  config: Parameters<typeof createAttributedFacilityCoverageObjective>[0],
  values: readonly CoverageSelectableCandidate[],
  receipts: ReadonlyMap<string, CandidateCoverageReceipt>,
  selectedMask: number,
  probeIndex: number
): number {
  const objective = createAttributedFacilityCoverageObjective(config);
  const state = objective.createState();
  values.forEach((value, index) => {
    if ((selectedMask & 1 << index) === 0) return;
    objective.accept(objectiveParams(
      value,
      receipts.get(value.fusion.candidate_key)!,
      state
    ));
  });
  const probe = values[probeIndex]!;
  return objective.marginalGain(objectiveParams(
    probe,
    receipts.get(probe.fusion.candidate_key)!,
    state
  ));
}

function factAtom(): CandidateCoverageAtom {
  return Object.freeze({
    atom_id: "fact:evidence-a:7",
    kind: "fact_projection",
    strength: 0.8,
    independence_key: "evidence:evidence-a",
    evidence_object_id: "evidence-a",
    document_identity: "fact_key:7",
    projection: Object.freeze({
      projection_id: 7,
      projection_kind: "fact_key",
      matched_fact_key_forms: Object.freeze([Object.freeze({ kind: "complete" as const })])
    }),
    demand_roles: Object.freeze(["complete"]),
    observation_channels: Object.freeze(["evidence_semantic"])
  });
}
