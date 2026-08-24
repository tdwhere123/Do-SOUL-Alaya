import { describe, expect, it } from "vitest";
import { selectFineAssessmentCandidates } from
  "../../../recall/delivery/fine-assessment-selection.js";
import { createSelectionContext } from
  "../../../recall/delivery/fine-assessment-selection/coverage-order.js";
import {
  buildFineAssessmentSelectGammaBinding,
  buildSelectGammaRequest
} from "../../../recall/delivery/select-gamma/bind-fine-assessment.js";
import { attributeCandidateBindingCoverage } from
  "../../../recall/delivery/select-gamma/binding-cover/candidate-receipt.js";
import { createBindingAwareWalkObjective } from
  "../../../recall/delivery/select-gamma/binding-cover/objective.js";
import { PRODUCTION_SELECT_GAMMA_SOURCE_HARD_DEDUPE } from
  "../../../recall/delivery/select-gamma/admission/identity.js";
import { bindFineAssessmentBindingCover } from
  "../../../recall/delivery/select-gamma/binding-cover/production.js";
import {
  SELECT_GAMMA_BINDING_COVERAGE_OPERATOR_ID,
  type CandidateBindingCoverageReceipt
} from "../../../recall/delivery/select-gamma/binding-cover/types.js";
import {
  compositionOf,
  productionParams,
  valueReceipt,
  withEvidence
} from "./select-gamma-binding-cover-fixtures.js";
import { prepareSelectGammaProof } from
  "../../../recall/delivery/select-gamma/proof-objective.js";
import { selectGammaWalk } from
  "../../../recall/delivery/select-gamma/select-gamma.js";
import type { SelectGammaBinding, SelectGammaRequest } from
  "../../../recall/delivery/select-gamma/types.js";
import {
  createCandidate,
  createConfig,
  createRankedCandidate,
  createSupplementaryData,
  FIELD_PINS,
  rankMap
} from "../fine-assessment-selection-fixtures.js";
import { formulaCandidate } from "./select-gamma-parity-pool.js";

describe("Select_Gamma binding-value coverage", () => {
  it("admits two same-source golds with distinct values under budget 5", () => {
    const walk = bindingWalk({
      selected: 5,
      receipts: [
        valueReceipt("gold-apple", "count", "three"),
        valueReceipt("gold-banana", "count", "five")
      ],
      extras: distractors(4, 0.72)
    });

    expect(walk.selected_candidate_keys).toEqual(expect.arrayContaining([
      "gold-apple",
      "gold-banana"
    ]));
    expect(walk.selected_candidate_keys).toHaveLength(5);
    expect(walk.selection_receipt.source_hard_dedupe).toBe(false);
    expect(walk.selection_receipt.objective_semantic_id)
      .toBe(SELECT_GAMMA_BINDING_COVERAGE_OPERATOR_ID);
  });

  it("lets a new value beat a same-value same-lineage repeat", () => {
    const apple = formulaCandidate("gold-apple", {
      quality: 0.8, cover: {}, source: "receipt"
    });
    const repeat = {
      ...formulaCandidate("gold-repeat", {
        quality: 0.79, cover: {}, source: "receipt"
      }),
      lineage: { status: "available" as const, key: "session-1" }
    };
    const appleWithLineage = {
      ...apple,
      lineage: { status: "available" as const, key: "session-1" }
    };
    const novel = formulaCandidate("gold-orange", {
      quality: 0.5, cover: {}, source: "note"
    });
    const walk = selectGammaWalk(requestOf([
      appleWithLineage.candidate_key, repeat.candidate_key, novel.candidate_key
    ]), bindingOf([appleWithLineage, repeat, novel], 2), bindingObjective(new Map([
      ["gold-apple", valueReceipt("gold-apple", "count", "three")],
      ["gold-repeat", valueReceipt("gold-repeat", "count", "three")],
      ["gold-orange", valueReceipt("gold-orange", "count", "five")]
    ])));

    expect(walk.selected_candidate_keys).toEqual(["gold-apple", "gold-orange"]);
    const repeatGain = walk.decisions.find((decision) =>
      decision.candidate_key === "gold-repeat"
    )?.marginal_gain;
    const novelGain = walk.decisions.find((decision) =>
      decision.candidate_key === "gold-orange"
    )?.marginal_gain;
    expect(novelGain).toBeGreaterThan(repeatGain ?? Number.POSITIVE_INFINITY);
  });

  it("keeps live walk keys on the proof path with the same objective", () => {
    const golds = enumerativeGolds();
    const params = productionParams(golds);
    const context = createSelectionContext(params);
    const binding = buildFineAssessmentSelectGammaBinding(params, context);
    const cover = bindFineAssessmentBindingCover(params, context, binding);
    const live = selectGammaWalk(
      buildSelectGammaRequest(params, context, params.orderedCandidates),
      binding,
      cover.objective
    );
    const proof = prepareSelectGammaProof(
      params.orderedCandidates, context, binding, cover.objective
    );
    const result = selectFineAssessmentCandidates(params);
    const proofState = proof.preparedSelection.objective.createState();
    const firstProof = proof.preparedSelection.candidateStates.reduce((best, state) => {
      const gain = proof.preparedSelection.objective.marginalGain({
        ...state,
        state: proofState,
        supplementaryData: context.supplementaryData
      });
      return gain > best.gain ? { key: state.candidate.fusion.candidate_key, gain } : best;
    }, { key: "", gain: Number.NEGATIVE_INFINITY });

    expect(firstProof.key).toBe(live.selected_candidate_keys[0]);
    expect(result.candidates.map((candidate) => candidate.object_id)).toEqual(
      live.selected_candidate_keys.map((key) =>
        params.orderedCandidates.find((candidate) =>
          candidate.fusion.candidate_key === key
        )?.entry.object_id
      )
    );
    expect(proof.objective.operator_id)
      .toBe(live.selection_receipt.objective_semantic_id);
    expect(result.coverageSelectionObjective.operator_id)
      .toBe(SELECT_GAMMA_BINDING_COVERAGE_OPERATOR_ID);
    expect(result.binding_set_receipt.variables[0]?.gained_values.map(
      (value) => value.semantic_identity
    ).sort()).toEqual(["five", "three"]);
  });

  it("pins production source hard-dedupe off", () => {
    expect(PRODUCTION_SELECT_GAMMA_SOURCE_HARD_DEDUPE).toBe(false);
    const candidate = createCandidate("bound");
    const params = {
      ...FIELD_PINS,
      orderedCandidates: [candidate],
      config: createConfig(),
      supplementaryData: createSupplementaryData(),
      tokenEstimator: { estimate: () => 6 },
      rankByCandidateKey: new Map([[candidate.fusion.candidate_key, 1]])
    };
    const binding = buildFineAssessmentSelectGammaBinding(
      params,
      createSelectionContext(params)
    );
    expect(binding.source_hard_dedupe).toBe(false);
  });

  it("still hard-rejects a duplicate object when source hard-dedupe is on", () => {
    const shared = formulaCandidate("dup-a", {
      quality: 3, cover: {}, source: "shared"
    });
    const duplicate = {
      ...formulaCandidate("dup-b", { quality: 2, cover: {}, source: "shared" }),
      object_key: shared.object_key
    };
    const novel = formulaCandidate("novel", {
      quality: 1, cover: {}, source: "other"
    });
    const walk = selectGammaWalk(
      requestOf(["dup-a", "dup-b", "novel"]),
      {
        ...bindingOf([shared, duplicate, novel], 2),
        source_hard_dedupe: true
      },
      bindingObjective(new Map())
    );
    expect(walk.selected_candidate_keys).toEqual(["dup-a", "novel"]);
    expect(walk.decisions.find((decision) =>
      decision.candidate_key === "dup-b")?.receipt).toMatchObject({
      kind: "duplicate",
      identity_channel: "object"
    });
  });

  it("reports duplicate identity before last-slot displacement", () => {
    const novel = formulaCandidate("novel", {
      quality: 4, cover: {}, source: "other"
    });
    const shared = formulaCandidate("dup-a", {
      quality: 3, cover: {}, source: "shared"
    });
    const duplicate = {
      ...formulaCandidate("dup-b", { quality: 2, cover: {}, source: "shared" }),
      object_key: shared.object_key
    };
    const walk = selectGammaWalk(
      requestOf(["novel", "dup-a", "dup-b"]),
      bindingOf([novel, shared, duplicate], 2),
      bindingObjective(new Map())
    );

    expect(walk.selected_candidate_keys).toEqual(["novel", "dup-a"]);
    expect(walk.decisions.find((decision) => decision.candidate_key === "dup-b"))
      .toMatchObject({
        selection_order: 3,
        selected_rank: null,
        receipt: { kind: "duplicate", identity_channel: "object", retained_candidate_key: "dup-a" }
      });
  });

  it("decomposes facility gain as quality for displacement receipts", () => {
    const facilityWinner = formulaCandidate("facility-hit", {
      quality: 0.1, cover: {}, source: "facility"
    });
    const qualityLoser = formulaCandidate("quality-loser", {
      quality: 0.9, cover: {}, source: "quality"
    });
    const facility = {
      operator_id: "test_facility",
      createState: () => null,
      marginalGain: (candidate: ReturnType<typeof formulaCandidate>) =>
        candidate.candidate_key === "facility-hit" ? 2 : 0,
      accept: () => undefined
    };
    const walk = selectGammaWalk(
      requestOf(["facility-hit", "quality-loser"]),
      bindingOf([facilityWinner, qualityLoser], 1),
      createBindingAwareWalkObjective({
        receiptsByCandidateKey: new Map(),
        configurationDigest: `sha256:${"c".repeat(64)}`,
        facility
      })
    );

    expect(walk.selected_candidate_keys).toEqual(["quality-loser"]);
    expect(walk.decisions.find((decision) => decision.candidate_key === "facility-hit")
      ?.receipt.kind).toBe("quality_displaced");
  });

  it("lets facility-hit with a new Values_v still win under budget 1", () => {
    const facilityWinner = formulaCandidate("facility-hit", {
      quality: 0.1, cover: {}, source: "facility"
    });
    const qualityLoser = formulaCandidate("quality-loser", {
      quality: 0.9, cover: {}, source: "quality"
    });
    const facility = {
      operator_id: "test_facility",
      createState: () => null,
      marginalGain: (candidate: ReturnType<typeof formulaCandidate>) =>
        candidate.candidate_key === "facility-hit" ? 2 : 0,
      accept: () => undefined
    };
    const walk = selectGammaWalk(
      requestOf(["facility-hit", "quality-loser"]),
      bindingOf([facilityWinner, qualityLoser], 1),
      createBindingAwareWalkObjective({
        receiptsByCandidateKey: new Map([
          ["facility-hit", valueReceipt("facility-hit", "count", "three")]
        ]),
        configurationDigest: `sha256:${"c".repeat(64)}`,
        facility
      })
    );

    expect(walk.selected_candidate_keys).toEqual(["facility-hit"]);
    expect(walk.decisions.find((decision) => decision.candidate_key === "quality-loser")
      ?.receipt.kind).toBe("quality_displaced");
  });

  it("attributes OSF result bindings onto candidate coverage receipts", () => {
    const apple = withEvidence(createCandidate("gold-a"), "ev-apple");
    const banana = withEvidence(createCandidate("gold-b"), "ev-banana");
    const receipts = attributeCandidateBindingCoverage({
      candidates: [apple, banana],
      composition: compositionOf([
        ["count", "three", ["ev-apple"]],
        ["count", "five", ["ev-banana"]]
      ]),
      answerVariableIds: ["count"]
    });
    expect(receipts.get(apple.fusion.candidate_key)?.values).toEqual([
      expect.objectContaining({
        variable_id: "count",
        semantic_identity: "three"
      })
    ]);
    expect(receipts.get(banana.fusion.candidate_key)?.values).toEqual([
      expect.objectContaining({
        variable_id: "count",
        semantic_identity: "five"
      })
    ]);
  });

  it("keeps truncated OSF values and stamps truncated standing", () => {
    const apple = withEvidence(createCandidate("gold-a"), "ev-apple");
    const composition = {
      ...compositionOf([["count", "three", ["ev-apple"]]]),
      truncated: true
    };
    const receipts = attributeCandidateBindingCoverage({
      candidates: [apple],
      composition,
      answerVariableIds: ["count"]
    });
    const params = productionParams([
      withSource(apple, "turn-1"),
      createRankedCandidate("noise-0", 2, 0.1)
    ]);
    const truncatedParams = {
      ...params,
      supplementaryData: createSupplementaryData({
        openSemanticFactorComposition: composition
      })
    };
    const result = selectFineAssessmentCandidates(truncatedParams);
    expect(receipts.get(apple.fusion.candidate_key)?.values[0]?.semantic_identity)
      .toBe("three");
    expect(result.binding_set_receipt.values_status).toBe("truncated");
  });

  it("does not let an active-slice distractor beat higher relevance", () => {
    const relevant = createRankedCandidate("relevant", 1, 1);
    const weakSlice = withFlood(createRankedCandidate("weak-slice", 2, 0.4), {
      slice: true
    });
    const params = {
      ...FIELD_PINS,
      orderedCandidates: [relevant, weakSlice],
      config: tightBudget(1),
      supplementaryData: createSupplementaryData(),
      tokenEstimator: { estimate: () => 6 },
      rankByCandidateKey: rankMap([relevant, weakSlice])
    };
    const binding = buildFineAssessmentSelectGammaBinding(
      params,
      createSelectionContext(params)
    );
    expect(binding.feature_weights).not.toHaveProperty("slice");
    expect(binding.feature_weights).not.toHaveProperty("f3");
    const result = selectFineAssessmentCandidates(params);
    expect(result.candidates.map((candidate) => candidate.object_id))
      .toEqual(["relevant"]);
  });

  it("does not grant obligation cover from facet-id content substrings", () => {
    const mentioned = {
      ...createRankedCandidate("mentioned", 1, 0.4),
      entry: {
        ...createRankedCandidate("mentioned", 1, 0.4).entry,
        content: "I talked about location_place in passing."
      }
    };
    const tagged = {
      ...createRankedCandidate("tagged", 2, 0.3),
      entry: {
        ...createRankedCandidate("tagged", 2, 0.3).entry,
        domain_tags: ["location_place"]
      }
    };
    const params = {
      ...FIELD_PINS,
      orderedCandidates: [mentioned, tagged],
      config: createConfig(),
      supplementaryData: createSupplementaryData({
        querySoughtFacets: ["location_place"]
      }),
      tokenEstimator: { estimate: () => 6 },
      rankByCandidateKey: rankMap([mentioned, tagged])
    };
    const coverById = new Map(buildFineAssessmentSelectGammaBinding(
      params,
      createSelectionContext(params)
    ).candidates.map((candidate) => [candidate.object_key, candidate.cover]));
    expect(coverById.get("memory_entry:mentioned")).not.toHaveProperty(
      "obligation:location_place"
    );
    expect(coverById.get("memory_entry:tagged")).toMatchObject({
      "obligation:location_place": 1
    });
  });

  it("records obligation facet standing instead of always-unmet", () => {
    const covered = {
      ...createRankedCandidate("place-gold", 1, 0.4),
      entry: {
        ...createRankedCandidate("place-gold", 1, 0.4).entry,
        domain_tags: ["location_place"]
      }
    };
    const other = createRankedCandidate("other", 2, 0.9);
    const params = {
      ...FIELD_PINS,
      orderedCandidates: [covered, other],
      config: tightBudget(1),
      supplementaryData: createSupplementaryData({
        querySoughtFacets: ["location_place"]
      }),
      tokenEstimator: { estimate: () => 6 },
      rankByCandidateKey: rankMap([covered, other])
    };
    const binding = buildFineAssessmentSelectGammaBinding(
      params,
      createSelectionContext(params)
    );
    expect(binding.candidates.find((candidate) =>
      candidate.candidate_key === covered.fusion.candidate_key
    )?.cover).toMatchObject({ "obligation:location_place": 1 });
    const result = selectFineAssessmentCandidates(params);
    expect(result.candidates.map((candidate) => candidate.object_id))
      .toEqual(["place-gold"]);
    expect(result.binding_set_receipt.obligation_facets).toEqual([
      { facet_id: "location_place", standing: "covered" }
    ]);
  });
});

function tightBudget(maxEntries: number) {
  return {
    ...createConfig(),
    budgets: {
      ...createConfig().budgets,
      max_entries: maxEntries
    }
  };
}

function withFlood(
  candidate: ReturnType<typeof createCandidate>,
  axes: Readonly<{ readonly slice?: boolean }>
) {
  return {
    ...candidate,
    fusion: {
      ...candidate.fusion,
      flood_potential: {
        R_obj: 0,
        Slice: axes.slice === true ? 1 : 0,
        A_path: 0,
        B_evidence: 0,
        E_direct: 0,
        omega: 1,
        Flood: 0,
        lambda: 0.6,
        beta: 1,
        final_score: 0,
        slice_status: axes.slice === true ? "active" as const : "inactive:no_slice_match" as const,
        path_status: "inactive:pass_through" as const,
        evidence_status: "inactive:no_evidence" as const,
        e_direct_status: "inactive:not_applicable" as const,
        fuel_verified: axes.slice === true
      }
    }
  };
}

function enumerativeGolds() {
  return [
    withSource(withEvidence(createRankedCandidate("gold-a", 1, 0.8), "ev-apple"), "turn-1"),
    withSource(withEvidence(createRankedCandidate("gold-b", 2, 0.55), "ev-banana"), "turn-1"),
    ...[0, 1, 2, 3].map((index) =>
      createRankedCandidate(`noise-${index}`, index + 3, 0.72)
    )
  ];
}

function bindingWalk(params: Readonly<{
  readonly selected: number;
  readonly receipts: readonly CandidateBindingCoverageReceipt[];
  readonly extras: ReturnType<typeof formulaCandidate>[];
}>) {
  const golds = [
    formulaCandidate("gold-apple", { quality: 0.8, cover: {}, source: "receipt" }),
    formulaCandidate("gold-banana", { quality: 0.7, cover: {}, source: "receipt" })
  ];
  const candidates = [...golds, ...params.extras];
  return selectGammaWalk(
    requestOf(candidates.map((candidate) => candidate.candidate_key)),
    bindingOf(candidates, params.selected),
    bindingObjective(new Map(params.receipts.map((receipt) => [
      receipt.candidate_key,
      receipt
    ])))
  );
}

function bindingObjective(
  receiptsByCandidateKey: ReadonlyMap<string, CandidateBindingCoverageReceipt>
) {
  return createBindingAwareWalkObjective({
    receiptsByCandidateKey,
    configurationDigest: `sha256:${"b".repeat(64)}`
  });
}

function distractors(count: number, quality: number) {
  return Array.from({ length: count }, (_, index) => formulaCandidate(
    `noise-${index}`,
    { quality, cover: {}, source: `blog-${index}` }
  ));
}

function withSource(
  candidate: ReturnType<typeof createCandidate>,
  source: string
) {
  return { ...candidate, evidenceSourceIdentity: source };
}

function requestOf(keys: readonly string[]): SelectGammaRequest {
  return Object.freeze({
    workspace_id: "workspace-1",
    generation_id: `sha256:${"a".repeat(64)}`,
    condition_digest: `sha256:${"b".repeat(64)}`,
    eligible_candidate_keys: Object.freeze([...keys]),
    token_budget: 100
  });
}

function bindingOf(
  candidates: readonly ReturnType<typeof formulaCandidate>[],
  maxSelected: number
): SelectGammaBinding {
  const request = requestOf(candidates.map((candidate) => candidate.candidate_key));
  return Object.freeze({
    workspace_id: request.workspace_id,
    generation_id: request.generation_id,
    condition_digest: request.condition_digest,
    candidates,
    feature_weights: Object.freeze({}),
    max_selected: maxSelected,
    per_dimension_limits: null,
    source_hard_dedupe: false
  });
}
