import { describe, expect, it } from "vitest";

import { selectFineAssessmentCandidates } from
  "../../../recall/delivery/fine-assessment-selection.js";
import { createBindingAwareWalkObjective } from
  "../../../recall/delivery/select-gamma/binding-cover/objective.js";
import {
  SELECT_GAMMA_CANDIDATE_BINDING_COVERAGE_OPERATOR_ID,
  type CandidateBindingCoverageReceipt
} from "../../../recall/delivery/select-gamma/binding-cover/types.js";
import type {
  SelectGammaFormulaCandidate,
  SelectGammaWalkObjective
} from "../../../recall/delivery/select-gamma/types.js";
import type { BindingValuesStatus } from
  "../../../recall/delivery/select-gamma/binding-cover/composition.js";
import type { BindingCoverState } from
  "../../../recall/delivery/select-gamma/binding-cover/types.js";
import {
  FIELD_PINS,
  createConfig,
  createRankedCandidate,
  createSupplementaryData,
  rankMap
} from "../fine-assessment-selection-fixtures.js";
import {
  compositionOf,
  productionParams,
  valueReceipt,
  withEvidence
} from "./select-gamma-binding-cover-fixtures.js";
import { formulaCandidate } from "./select-gamma-parity-pool.js";
import type { RecallSupplementaryData } from
  "../../../recall/runtime/recall-service-types.js";

const DIGEST = `sha256:${"e".repeat(64)}`;
const RANKING_PRESERVE_KEYS = [
  "fused-head",
  "distract-a",
  "distract-b",
  "distract-c",
  "overflow-0"
] as const;

describe("Select_Gamma cover availability", () => {
  it("does not silently collapse unavailable cover into known-zero", () => {
    const candidates = invertedRankingPool();
    const unavailable = selectFineAssessmentCandidates(
      rankingPreserveParams(candidates, createSupplementaryData())
    );
    const knownZero = selectFineAssessmentCandidates(
      rankingPreserveParams(candidates, createSupplementaryData({
        openSemanticFactorComposition: compositionOf([
          ["count", "unrelated", ["ev-unrelated"]]
        ])
      }))
    );

    const unavailableKeys = unavailable.candidates.map((candidate) =>
      candidate.object_id
    );
    expect(unavailableKeys).toEqual([...RANKING_PRESERVE_KEYS]);
    expect(unavailableKeys).toEqual(
      knownZero.candidates.map((candidate) => candidate.object_id)
    );
    expect(unavailableKeys).not.toContain("waist-emb");
    expect(unavailable.binding_set_receipt.values_status).toBe("unavailable");
    expect(unavailable.binding_set_receipt.cover_evidence).toBe("unavailable");
    expect(knownZero.binding_set_receipt.values_status).toBe("observed");
    expect(knownZero.binding_set_receipt.cover_evidence).toBe("available");
    expect(unavailable.diagnostics.find((candidate) => candidate.object_id === "waist-emb")
      ?.dropped_reason).toBe("rank_displaced");
    expect(knownZero.diagnostics.find((candidate) => candidate.object_id === "waist-emb")
      ?.dropped_reason).toBe("rank_displaced");

    const fusedHead = formulaCandidate("fused-head", {
      quality: 0.2, cover: {}, source: "head"
    });
    const unavailableParts = decomposeAt(fusedHead, {
      valuesStatus: "unavailable",
      obligationFacetCount: 0
    });
    const knownZeroParts = decomposeAt(fusedHead, {
      valuesStatus: "observed",
      obligationFacetCount: 0
    });
    expect(unavailableParts.cover_availability).toBe("unavailable");
    expect(knownZeroParts.cover_availability).toBe("known_zero");
    expect(unavailableParts.coverage).toBe(0);
    expect(knownZeroParts.coverage).toBe(0);
  });

  it("still admits a novel Values_v and reports positive cover", () => {
    const fusedHead = withEvidence(
      createRankedCandidate("fused-head-a", 1, 0.9),
      "ev-apple"
    );
    const novel = withEvidence(
      createRankedCandidate("novel-c", 6, 0.2),
      "ev-banana"
    );
    const sameValue = [0.8, 0.7, 0.6, 0.5].map((score, index) =>
      withEvidence(
        createRankedCandidate(`same-three-${index}`, index + 2, score),
        "ev-apple"
      )
    );
    const result = selectFineAssessmentCandidates(productionParams([
      fusedHead,
      ...sameValue,
      novel
    ]));
    expect(result.candidates.map((candidate) => candidate.object_id))
      .toEqual(expect.arrayContaining(["fused-head-a", "novel-c"]));
    expect(result.binding_set_receipt.values_status).toBe("observed");
    expect(result.binding_set_receipt.cover_evidence).toBe("available");

    const apple = formulaCandidate("fused-head-a", {
      quality: 0.9, cover: {}, source: "receipt"
    });
    const novelFormula = formulaCandidate("novel-c", {
      quality: 0.2, cover: {}, source: "note"
    });
    const objective = coverObjective({
      valuesStatus: "observed",
      obligationFacetCount: 0,
      receipts: new Map([
        ["fused-head-a", valueReceipt("fused-head-a", "count", "three")],
        ["novel-c", valueReceipt("novel-c", "count", "five")]
      ])
    });
    const state = objective.createState();
    objective.accept(apple, state);
    expect(requireDecompose(objective, novelFormula, state).cover_availability)
      .toBe("positive");
  });

  it("does not treat leftover empty receipts as known-zero when cover is unavailable", () => {
    const fusedHead = formulaCandidate("fused-head", {
      quality: 0.2, cover: {}, source: "head"
    });
    const emptyReceipt: CandidateBindingCoverageReceipt = Object.freeze({
      schema_version: 1 as const,
      operator_id: SELECT_GAMMA_CANDIDATE_BINDING_COVERAGE_OPERATOR_ID,
      candidate_key: "fused-head",
      values: Object.freeze([])
    });
    const facility = {
      operator_id: "test_facility",
      createState: () => null,
      marginalGain: () => 99,
      accept: () => undefined
    };
    const objective = createBindingAwareWalkObjective({
      receiptsByCandidateKey: new Map([["fused-head", emptyReceipt]]),
      rankingScoreByCandidateKey: new Map([["fused-head", 0.9]]),
      valuesStatus: "unavailable",
      obligationFacetCount: 0,
      configurationDigest: DIGEST,
      facility
    });
    const state = objective.createState();
    const parts = requireDecompose(objective, fusedHead, state);
    expect(parts.cover_availability).toBe("unavailable");
    expect(parts.coverage).toBe(0);
    expect(objective.marginalGain(fusedHead, state)).toBe(0.9);
  });

  it("does not treat leftover valued receipts as cover when composition is unavailable", () => {
    const fusedHead = formulaCandidate("fused-head", {
      quality: 0.2, cover: {}, source: "head"
    });
    const facility = {
      operator_id: "test_facility",
      createState: () => null,
      marginalGain: () => 99,
      accept: () => undefined
    };
    const objective = createBindingAwareWalkObjective({
      receiptsByCandidateKey: new Map([
        ["fused-head", valueReceipt("fused-head", "count", "three")]
      ]),
      rankingScoreByCandidateKey: new Map([["fused-head", 0.9]]),
      valuesStatus: "unavailable",
      obligationFacetCount: 0,
      configurationDigest: DIGEST,
      facility
    });
    const state = objective.createState();
    const parts = requireDecompose(objective, fusedHead, state);
    expect(parts.cover_availability).toBe("unavailable");
    expect(parts.coverage).toBe(0);
    expect(objective.marginalGain(fusedHead, state)).toBe(0.9);
  });

  it("treats truncated zero increment as unavailable, not known-zero", () => {
    const apple = withEvidence(createRankedCandidate("gold-a", 1, 0.8), "ev-apple");
    const composition = {
      ...compositionOf([["count", "three", ["ev-apple"]]]),
      truncated: true
    };
    const params = productionParams([
      apple,
      createRankedCandidate("noise-0", 2, 0.1)
    ]);
    const result = selectFineAssessmentCandidates({
      ...params,
      supplementaryData: createSupplementaryData({
        openSemanticFactorComposition: composition
      })
    });
    expect(result.binding_set_receipt.values_status).toBe("truncated");
    expect(result.binding_set_receipt.cover_evidence).toBe("available");

    const gold = formulaCandidate("gold-a", {
      quality: 0.8, cover: {}, source: "receipt"
    });
    expect(decomposeAt(gold, {
      valuesStatus: "truncated",
      obligationFacetCount: 0,
      receipts: new Map([["gold-a", valueReceipt("gold-a", "count", "three")]])
    }).cover_availability).toBe("positive");
    expect(decomposeAt(gold, {
      valuesStatus: "truncated",
      obligationFacetCount: 0
    }).cover_availability).toBe("unavailable");
  });

  it("pins known-zero gain to rankingScore minus rho", () => {
    const fusedHead = formulaCandidate("fused-head", {
      quality: 0.2, cover: {}, source: "head"
    });
    const facility = {
      operator_id: "test_facility",
      createState: () => null,
      marginalGain: () => 99,
      accept: () => undefined
    };
    const objective = createBindingAwareWalkObjective({
      receiptsByCandidateKey: new Map(),
      rankingScoreByCandidateKey: new Map([["fused-head", 0.9]]),
      valuesStatus: "observed",
      obligationFacetCount: 0,
      configurationDigest: DIGEST,
      facility
    });
    const state = objective.createState();
    const parts = requireDecompose(objective, fusedHead, state);
    expect(parts.cover_availability).toBe("known_zero");
    expect(parts.coverage).toBe(0);
    expect(objective.marginalGain(fusedHead, state)).toBe(0.9);
  });

  it("treats exhaustive no_match composition as observed known-zero", () => {
    const apple = withEvidence(createRankedCandidate("gold-a", 1, 0.8), "ev-apple");
    const result = selectFineAssessmentCandidates({
      ...productionParams([apple, createRankedCandidate("noise-0", 2, 0.1)]),
      supplementaryData: createSupplementaryData({
        openSemanticFactorComposition: {
          ...compositionOf([]),
          status: "no_match",
          solution_count: 0,
          observed_binding_count: 0,
          binding_observation_count: 0,
          result_variable_ids: Object.freeze([]),
          variable_collections: Object.freeze([])
        }
      })
    });
    expect(result.binding_set_receipt.values_status).toBe("observed");
    expect(result.binding_set_receipt.cover_evidence).toBe("available");
    const gold = formulaCandidate("gold-a", {
      quality: 0.8, cover: {}, source: "receipt"
    });
    expect(decomposeAt(gold, {
      valuesStatus: "observed",
      obligationFacetCount: 0
    }).cover_availability).toBe("known_zero");
  });
});

function invertedRankingPool() {
  const fusedHead = createRankedCandidate("fused-head", 1, 0.9);
  const waist = createRankedCandidate("waist-emb", 20, 0.25);
  const mid = [
    createRankedCandidate("distract-a", 2, 0.70),
    createRankedCandidate("distract-b", 3, 0.62),
    createRankedCandidate("distract-c", 4, 0.55)
  ] as const;
  const overflow = [5, 6, 7, 8].map((rank, index) =>
    createRankedCandidate(`overflow-${index}`, rank, 0.48 - index * 0.02)
  );
  return [fusedHead, ...mid, ...overflow, waist];
}

function rankingPreserveParams(
  candidates: ReturnType<typeof invertedRankingPool>,
  supplementaryData: RecallSupplementaryData
) {
  const fusedHead = candidates[0]!;
  const mid = candidates.slice(1, 4);
  const overflow = candidates.slice(4, 8);
  const waist = candidates[8]!;
  return {
    ...FIELD_PINS,
    orderedCandidates: candidates,
    config: {
      ...createConfig(),
      budgets: {
        ...createConfig().budgets,
        max_entries: 5,
        max_total_tokens: 1000
      }
    },
    supplementaryData,
    tokenEstimator: { estimate: () => 6 },
    rankByCandidateKey: rankMap(candidates),
    coverageRelevanceByCandidateKey: new Map([
      [fusedHead.fusion.candidate_key, 0.2],
      [waist.fusion.candidate_key, 0.99],
      [mid[0]!.fusion.candidate_key, 0.82],
      [mid[1]!.fusion.candidate_key, 0.80],
      [mid[2]!.fusion.candidate_key, 0.78],
      ...overflow.map((candidate, index) =>
        [candidate.fusion.candidate_key, 0.76 - index * 0.01] as const
      )
    ])
  };
}

function decomposeAt(
  candidate: SelectGammaFormulaCandidate,
  params: Readonly<{
    readonly valuesStatus: BindingValuesStatus;
    readonly obligationFacetCount: number;
    readonly receipts?: ReadonlyMap<string, CandidateBindingCoverageReceipt>;
  }>
) {
  const objective = coverObjective({
    valuesStatus: params.valuesStatus,
    obligationFacetCount: params.obligationFacetCount,
    receipts: params.receipts ?? new Map(),
    rankingScoreByCandidateKey: new Map([[candidate.candidate_key, 0.9]])
  });
  return requireDecompose(objective, candidate, objective.createState());
}

function coverObjective(params: Readonly<{
  readonly valuesStatus: BindingValuesStatus;
  readonly obligationFacetCount: number;
  readonly receipts: ReadonlyMap<string, CandidateBindingCoverageReceipt>;
  readonly rankingScoreByCandidateKey?: ReadonlyMap<string, number>;
}>) {
  return createBindingAwareWalkObjective({
    receiptsByCandidateKey: params.receipts,
    rankingScoreByCandidateKey: params.rankingScoreByCandidateKey,
    valuesStatus: params.valuesStatus,
    obligationFacetCount: params.obligationFacetCount,
    configurationDigest: DIGEST
  });
}

function requireDecompose(
  objective: SelectGammaWalkObjective<BindingCoverState>,
  candidate: SelectGammaFormulaCandidate,
  state: BindingCoverState
) {
  const parts = objective.decomposeGain?.(candidate, state);
  if (parts === undefined) {
    throw new Error("binding-aware objective must decompose gain");
  }
  return parts;
}
