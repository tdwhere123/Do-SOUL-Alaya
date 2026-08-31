import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deliverFineAssessment,
  fineAssess,
  prepareFineAssessment
} from "../../../recall/delivery/fine-assessment.js";
import * as deliverySelection from "../../../recall/delivery/delivery-selection.js";
import * as deepHead from "../../../recall/delivery/fine-assessment-deep-head.js";
import * as selection from "../../../recall/delivery/fine-assessment-selection.js";
import * as gamma from "../../../recall/delivery/select-gamma/select-gamma.js";
import { compileRecallQueryProbes } from "../../../recall/query/recall-query-probes.js";
import { buildDefaultPolicy } from "../../../recall/runtime/orchestration.js";
import { captureFineAssessmentMembership } from "../../../recall/runtime/orchestration/recall-fine-assessment.js";
import type {
  CoarseRecallCandidate,
  KeywordSearchLaneReceipt,
  RecallSupplementaryData
} from "../../../recall/runtime/recall-service-types.js";
import * as scoring from "../../../recall/scoring/scoring.js";
import {
  CANONICAL_CAPTURE_IDENTITY,
  resolveFineAssessmentDeliveryPath
} from "../../../recall/delivery/canonical-delivery.js";
import {
  CAPTURE_IDENTITY_DIGEST,
  SHADOW_ALGORITHM_ID,
  SHADOW_ALGORITHM_VERSION
} from "../../../recall/decision/prefix-capture/identity.js";
import {
  isFailClosedShadowTrace,
  prefixSK,
  type ShadowCapturedTrace
} from "../../../recall/integration/shadow/integrate.js";
import * as walk from "../../../recall/decision/prefix-capture/walk.js";
import { FIELD_PINS } from "../fine-assessment-selection-fixtures.js";
import { withFineDeliveryPath } from "../recall-service-test-fixtures.js";
import {
  compositionForValues,
  evidenceCandidate,
  extraCandidate,
  fieldCandidates as createFieldCandidates,
  rawRankCaptures
} from "./canonical-delivery-fixtures.js";
import {
  embeddingObserved,
  field,
  temporalObserved,
  view
} from "../decision/query-proof/psi-test-support.js";

const NOW = "2026-07-12T00:00:00.000Z";
const IDS = ["cand-a", "cand-b", "cand-c"] as const;
const CANONICAL_SRC = readFileSync(
  path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../recall/delivery/canonical-delivery.ts"
  ),
  "utf8"
);

describe("reversible delivery cutover", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.ALAYA_RECALL_ALLOW_LEGACY_DELIVERY;
  });

  it("rejects legacy delivery unless the experiment flag is set", () => {
    delete process.env.ALAYA_RECALL_ALLOW_LEGACY_DELIVERY;
    const config = { ...policyOf().fine_assessment, delivery_path: "legacy" as const };
    expect(() => resolveFineAssessmentDeliveryPath(config))
      .toThrow(/ALAYA_RECALL_ALLOW_LEGACY_DELIVERY/u);
    process.env.ALAYA_RECALL_ALLOW_LEGACY_DELIVERY = "1";
    expect(resolveFineAssessmentDeliveryPath(config)).toBe("legacy");
  });

  it("defaults omitted delivery_path to canonical", () => {
    const policy = policyOf();
    expect(policy.fine_assessment.delivery_path).toBeUndefined();
    expect(resolveFineAssessmentDeliveryPath(policy.fine_assessment)).toBe("canonical");
    const result = fineAssess(assessParams(fieldCandidates()));
    expect(result.delivery_path).toBe("canonical");
    expect(result.ranking_authority).toBe("prefix_sk");
    expect(result.capture_identity).toEqual(CANONICAL_CAPTURE_IDENTITY);
    expect(result.candidates.every((candidate) => candidate.relevance_score === 0)).toBe(true);
    expect(result.diagnostics).toHaveLength(result.candidates.length);
    expect(result.diagnostics[0]).toMatchObject({
      ranking_authority: "prefix_sk",
      legacy_selection: {
        fusion: "not_applicable",
        deep_head: "not_applicable",
        coverage: "not_applicable"
      }
    });
    expect(result.diagnostics[0]).not.toHaveProperty("fused_score");
    expect(result.diagnostics[0]).not.toHaveProperty("per_stream_rank");
    expect(result.diagnostics[0]).not.toHaveProperty("rank_after_coverage_selector");
    expect(result.diagnostics.every((diagnostic) =>
      "legacy_selection" in diagnostic)).toBe(true);
  });

  it("publishes embedding_similarity as a diagnostic factor without ranking", () => {
    const result = fineAssess(lexicalAssess(fieldCandidates(), {
      embedding_enabled: true,
      lanes: porterLanes({
        "cand-c": 0.9,
        "cand-b": 0.6,
        "cand-a": 0.3
      }),
      embeddingSimilarityScores: {
        "cand-c": 0.1,
        "cand-b": 0.2,
        "cand-a": 0.99
      }
    }));
    expect(result.ranking_authority).toBe("prefix_sk");
    const scores = {
      "cand-c": 0.1,
      "cand-b": 0.2,
      "cand-a": 0.99
    };
    expect(result.candidates.map((candidate) => candidate.score_factors?.embedding_similarity))
      .toEqual(result.candidates.map((candidate) => scores[candidate.object_id as keyof typeof scores]));
    expect(result.diagnostics.every((diagnostic) =>
      !("score_factors" in diagnostic))).toBe(true);
  });

  it("does not import legacy stages into canonical delivery", () => {
    expect(CANONICAL_SRC).not.toMatch(/prepareFineAssessment/u);
    expect(CANONICAL_SRC).not.toMatch(/selectGammaWalk/u);
    expect(CANONICAL_SRC).not.toMatch(/computeEffectiveScoreDetails/u);
    expect(CANONICAL_SRC).not.toMatch(/applyDeliverySelection/u);
    expect(CANONICAL_SRC).not.toMatch(/selectFineAssessmentCandidates/u);
    expect(CANONICAL_SRC).not.toMatch(/fine-assessment-deep-head/u);
    expect(CANONICAL_SRC).not.toMatch(/fusion-delivery/u);
  });

  it("does not invoke legacy stages on the canonical path", () => {
    const score = vi.spyOn(scoring, "computeEffectiveScoreDetails");
    const select = vi.spyOn(selection, "selectFineAssessmentCandidates");
    const gammaWalk = vi.spyOn(gamma, "selectGammaWalk");
    const deep = vi.spyOn(deepHead, "resolveFineAssessmentDeepHead");
    const delivery = vi.spyOn(deliverySelection, "applyDeliverySelection");
    const shadowWalk = vi.spyOn(walk, "walkShadowCapture");
    const result = fineAssess(assessParams(fieldCandidates(), "canonical"));
    expect(result.delivery_path).toBe("canonical");
    expect(score).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
    expect(gammaWalk).not.toHaveBeenCalled();
    expect(deep).not.toHaveBeenCalled();
    expect(delivery).not.toHaveBeenCalled();
    expect(shadowWalk).toHaveBeenCalled();
  });

  it("does not call walkShadowCapture for legacy delivery order", () => {
    const shadowWalk = vi.spyOn(walk, "walkShadowCapture");
    const gammaWalk = vi.spyOn(gamma, "selectGammaWalk");
    const result = fineAssess(assessParams(fieldCandidates(), "legacy"));
    expect(result.delivery_path).toBe("legacy");
    expect(shadowWalk).not.toHaveBeenCalled();
    expect(gammaWalk).toHaveBeenCalled();
  });

  it("restores previous fineAssess order when delivery_path is legacy", () => {
    const params = assessParams(fieldCandidates(), "legacy");
    const rollback = fineAssess(params);
    const previous = deliverFineAssessment(params, prepareFineAssessment(params));
    expect(rollback.candidates.map((candidate) => candidate.object_id))
      .toEqual(previous.candidates.map((candidate) => candidate.object_id));
    expect(rollback.delivery_path).toBe("legacy");
  });

  it("uses prefixSK(S_infty, K) as canonical delivery order", () => {
    const params = {
      ...assessParams(fieldCandidates(), "canonical"),
      policy: withFineDeliveryPath(policyOf({ max_entries: 2 }), "canonical"),
      shadowObservationField: plantedTransitivity()
    };
    const result = fineAssess(params);
    const captured = asCaptured(result.shadowTrace);
    expect(result.delivery_path).toBe("canonical");
    expect(captured.prefix_proposal).toEqual(prefixSK(captured.S_infty, 2));
    expect(result.candidates.map((candidate) => candidate.object_id))
      .toEqual(captured.prefix_proposal.map((key) => key.split(":").at(-1)));
    expect(result.candidates.map((candidate) => candidate.object_id))
      .toEqual(["cand-a", "cand-b"]);
  });

  it("uses production Values and evidence correlation to change the second choice", () => {
    const candidates = [
      evidenceCandidate("cand-a", "evidence-a"),
      evidenceCandidate("cand-b", "evidence-a"),
      evidenceCandidate("cand-c", "evidence-c")
    ];
    const params = assessParams(candidates, "canonical");
    const result = fineAssess({
      ...params,
      policy: withFineDeliveryPath(policyOf({ max_entries: 3 }), "canonical"),
      supplementaryData: {
        ...params.supplementaryData,
        openSemanticFactorComposition: compositionForValues()
      }
    });
    expect(result.candidates.map((candidate) => candidate.object_id))
      .toEqual(["cand-a", "cand-c", "cand-b"]);
    expect(result.capture_receipt?.gamma.set_utilities.map((utility) => ({
      key: utility.candidate_key,
      values: utility.values,
      cid: utility.cid
    }))).toMatchObject([
      { values: { status: "composed" }, cid: { status: "available", grounding: "content" } },
      { values: { status: "composed" }, cid: { status: "available", grounding: "content" } },
      { values: { status: "composed" }, cid: { status: "available", grounding: "content" } }
    ]);
  });

  it("keeps H_E0 a subset of H_E1 and recovers the E0 prefix after masking embedding", () => {
    const shared = fieldCandidates();
    const extra = extraCandidate("cand-d");
    const inverted = porterLanes({
      "cand-c": 0.9,
      "cand-b": 0.6,
      "cand-a": 0.3
    });
    const e0Keys = shared.map((candidate) => keyOf(candidate.entry.object_id));
    const e1KeyList = [...shared, extra].map((candidate) => keyOf(candidate.entry.object_id));
    const e0 = fineAssess(lexicalAssess(shared, {
      embedding_enabled: false,
      max_entries: 4,
      lanes: inverted,
      embeddingSimilarityScores: { "cand-a": 0.2, "cand-b": 0.3, "cand-c": 0.4 },
      e0Keys,
      e1Keys: e0Keys
    }));
    const e1 = fineAssess(lexicalAssess([...shared, extra], {
      embedding_enabled: true,
      max_entries: 4,
      lanes: inverted,
      embeddingSimilarityScores: {
        "cand-a": 0.2,
        "cand-b": 0.3,
        "cand-c": 0.4,
        "cand-d": 0.99
      },
      e0Keys,
      e1Keys: e1KeyList
    }));
    const masked = fineAssess(lexicalAssess([...shared, extra], {
      embedding_enabled: true,
      max_entries: 4,
      lanes: inverted,
      embeddingSimilarityScores: {},
      e0Keys,
      e1Keys: e1KeyList
    }));
    const e0Eligible = asCaptured(e0.shadowTrace).eligible_keys;
    const e1Eligible = asCaptured(e1.shadowTrace).eligible_keys;
    expect(e0Eligible.every((key) => e1Eligible.includes(key))).toBe(true);
    expect(e1Eligible).toContain(keyOf("cand-d"));
    const e0Ids = e0.candidates.map((candidate) => candidate.object_id);
    expect(e0Ids).toEqual(["cand-c", "cand-b", "cand-a"]);
    expect(e0Ids.every((objectId) =>
      e1.candidates.some((candidate) => candidate.object_id === objectId)
    )).toBe(true);
    expect(masked.candidates.map((candidate) => candidate.object_id)
      .filter((objectId) => objectId !== "cand-d"))
      .toEqual(e0Ids);
    expect(e0.preparedCandidates).toEqual([]);
    expect(e0.prunedCandidates).toEqual([]);
    expect(e0.diagnostics).toHaveLength(e0.candidates.length);
  });

  it("orders canonical prefix from the merge-chosen raw-rank capture", () => {
    const result = fineAssess(lexicalAssess(fieldCandidates(), {
      embedding_enabled: false,
      lanes: porterLanes({
        "cand-c": 0.9,
        "cand-b": 0.6,
        "cand-a": 0.3
      })
    }));
    expect(asCaptured(result.shadowTrace).lexical_mapping).toBe("raw_rank_capture");
    expect(result.candidates.map((candidate) => candidate.object_id))
      .toEqual(["cand-c", "cand-b", "cand-a"]);
    expect(result.ranking_authority).toBe("prefix_sk");
  });

  it("binds the frozen capture identity triple on canonical result and trace", () => {
    const result = fineAssess(assessParams(fieldCandidates(), "canonical"));
    const captured = asCaptured(result.shadowTrace);
    expect(result.capture_identity).toEqual(CANONICAL_CAPTURE_IDENTITY);
    expect(result.capture_execution).toEqual({ status: "captured", reason: null });
    expect(result.capture_receipt?.delivery).toEqual(
      captured.prefix_proposal.map((candidate_key, index) => ({
        candidate_key,
        delivery_rank: index + 1
      }))
    );
    expect(captured.algorithm_id).toBe(SHADOW_ALGORITHM_ID);
    expect(captured.version).toBe(SHADOW_ALGORITHM_VERSION);
    expect(captured.digest).toBe(CAPTURE_IDENTITY_DIGEST);
    expect(captured.cutover_seam.activation).toBe("active");
  });

  it("fail-closes canonical delivery instead of falling back to legacy", () => {
    const params = assessParams(fieldCandidates(), "canonical");
    const keys = IDS.map(keyOf);
    const cyclic = (dominator: string, dominated: string) =>
      (dominator === keys[0] && dominated === keys[1]) ||
      (dominator === keys[1] && dominated === keys[2]) ||
      (dominator === keys[2] && dominated === keys[0]);
    const legacy = fineAssess({ ...params, policy: withFineDeliveryPath(params.policy, "legacy") });
    const closed = fineAssess({ ...params, shadowPsi: cyclic });
    expect(isFailClosedShadowTrace(closed.shadowTrace)).toBe(true);
    expect(closed.capture_execution).toEqual({
      status: "fail_closed",
      reason: "psi_cycle_contract_failure"
    });
    expect(closed.capture_receipt?.execution).toEqual(closed.capture_execution);
    expect(closed.candidates).toEqual([]);
    expect(closed.delivery_path).toBe("canonical");
    expect(legacy.candidates.length).toBeGreaterThan(0);
    expect(closed.candidates.map((candidate) => candidate.object_id))
      .not.toEqual(legacy.candidates.map((candidate) => candidate.object_id));
  });

  it("fail-closes a runner-captured E0 shrink before canonical delivery", () => {
    const candidates = fieldCandidates().slice(0, 1);
    const membership = captureFineAssessmentMembership(
      [keyOf("cand-a"), keyOf("planted-missing")],
      candidates
    );
    const result = fineAssess({ ...assessParams(candidates), ...membership });

    expect(result.candidates).toEqual([]);
    expect(result.capture_execution).toEqual({ status: "fail_closed", reason: "membership_shrink" });
  });
});

function asCaptured(trace: ReturnType<typeof fineAssess>["shadowTrace"]): ShadowCapturedTrace {
  expect(trace).toBeDefined();
  expect(isFailClosedShadowTrace(trace!)).toBe(false);
  if (trace === undefined || isFailClosedShadowTrace(trace)) {
    throw new Error("expected captured shadow trace");
  }
  return trace;
}

function plantedTransitivity() {
  return field({
    [keyOf("cand-a")]: view({
      temporal: temporalObserved(0.9),
      embedding: embeddingObserved(0.8)
    }),
    [keyOf("cand-b")]: view({
      temporal: temporalObserved(0.6),
      embedding: embeddingObserved(0.7)
    }),
    [keyOf("cand-c")]: view({
      temporal: temporalObserved(0.3),
      embedding: embeddingObserved(0.2)
    })
  });
}

function keyOf(objectId: string): string {
  return `workspace_local:memory_entry:${objectId}`;
}

function assessParams(
  candidates: readonly CoarseRecallCandidate[],
  path: "legacy" | "canonical" = "canonical"
) {
  return {
    ...FIELD_PINS,
    candidates,
    policy: withFineDeliveryPath(policyOf(), path),
    winnerMemoryIds: new Set<string>(),
    supplementaryData: supplementaryWithInflow(candidates),
    tokenEstimator: { estimate: () => 4 },
    now: () => NOW,
    warn: vi.fn()
  };
}

function policyOf(overrides: {
  readonly max_entries?: number;
  readonly embedding_enabled?: boolean;
} = {}) {
  const base = buildDefaultPolicy({
    strategy: "build",
    taskSurfaceRef: "task-surface-1",
    now: () => NOW,
    generateRuntimeId: () => "33333333-3333-4333-8333-333333333333"
  });
  return {
    ...base,
    coarse_filter: {
      ...base.coarse_filter,
      semantic_supplement: {
        ...base.coarse_filter.semantic_supplement,
        embedding_enabled: overrides.embedding_enabled
          ?? base.coarse_filter.semantic_supplement.embedding_enabled
      }
    },
    fine_assessment: {
      ...base.fine_assessment,
      budgets: {
        ...base.fine_assessment.budgets,
        max_entries: overrides.max_entries ?? base.fine_assessment.budgets.max_entries
      }
    }
  };
}

function fieldCandidates(): readonly CoarseRecallCandidate[] { return createFieldCandidates(IDS); }

function lexicalAssess(
  candidates: readonly CoarseRecallCandidate[],
  options: {
    readonly embedding_enabled: boolean;
    readonly max_entries?: number;
    readonly lanes: readonly Readonly<KeywordSearchLaneReceipt>[];
    readonly embeddingSimilarityScores?: Readonly<Record<string, number>>;
    readonly e0Keys?: readonly string[];
    readonly e1Keys?: readonly string[];
  }
) {
  return {
    ...assessParams(candidates, "canonical"),
    policy: withFineDeliveryPath(policyOf({
      embedding_enabled: options.embedding_enabled,
      max_entries: options.max_entries
    }), "canonical"),
    memoryKeywordLanes: options.lanes,
    memoryLexicalCaptures: rawRankCaptures(options.lanes),
    e0Keys: options.e0Keys,
    e1Keys: options.e1Keys,
    supplementaryData: supplementaryWithInflow(candidates, {
      query: "operator workspace",
      embeddingSimilarityScores: options.embeddingSimilarityScores
    })
  };
}

function porterLanes(
  ranks: Readonly<Record<string, number>>
): readonly Readonly<KeywordSearchLaneReceipt>[] {
  const observations = Object.entries(ranks).map(([objectId, normalized_rank], index) =>
    Object.freeze({ object_id: objectId, rank: index + 1, normalized_rank })
  );
  return Object.freeze([
    Object.freeze({
      lane: "porter" as const,
      status: "complete" as const,
      depth: observations.length,
      observations: Object.freeze(observations),
      unseen_upper_bound: 0
    })
  ]);
}

function supplementaryWithInflow(
  candidates: readonly CoarseRecallCandidate[],
  overrides: {
    readonly query?: string;
    readonly embeddingSimilarityScores?: Readonly<Record<string, number>>;
  } = {}
): RecallSupplementaryData {
  const ftsRanks: Record<string, number> = {};
  const embeddingSimilarityScores: Record<string, number> = {
    ...(overrides.embeddingSimilarityScores ?? {})
  };
  for (const [index, candidate] of candidates.entries()) {
    ftsRanks[candidate.entry.object_id] = Math.max(0, 1 - index * 0.07);
    if (overrides.embeddingSimilarityScores === undefined) {
      embeddingSimilarityScores[candidate.entry.object_id] = 0.2 + index * 0.1;
    }
  }
  return {
    queryProbes: compileRecallQueryProbes(
      overrides.query ?? "where does the operator work on 2026-03-19?"
    ),
    ftsRanks,
    trigramFtsRanks: {},
    synthesisFtsRanks: {},
    evidenceFtsRanks: {},
    evidenceProjectionMatchesByRef: {},
    sourceProximityScores: {},
    sourceCohortKeys: {},
    structuralScores: {},
    graphExpansionScores: {},
    entitySeedScores: {},
    pathExpansionScores: {},
    pathSuppressionScores: {},
    embeddingSimilarityScores,
    evidenceSemanticActivationsByCandidateKey: new Map(),
    graphSupportCounts: {},
    budgetPenaltyFactor: 0,
    plasticityFactors: {},
    graphAndPathColdScore: 0,
    recallsEdgeCount: 0,
    weightTransferAmount: 0,
    evidenceGistsByMemoryId: {},
    governanceCeilingByMemoryId: {}
  };
}
