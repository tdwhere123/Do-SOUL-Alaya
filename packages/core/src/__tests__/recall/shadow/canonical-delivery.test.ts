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
import type {
  CoarseRecallCandidate,
  KeywordSearchLaneReceipt,
  RecallSupplementaryData
} from "../../../recall/runtime/recall-service-types.js";
import * as scoring from "../../../recall/scoring/scoring.js";
import {
  CANONICAL_D0_IDENTITY,
  resolveFineAssessmentDeliveryPath
} from "../../../recall/shadow/canonical-delivery.js";
import {
  D0_IDENTITY_DIGEST,
  SHADOW_ALGORITHM_ID,
  SHADOW_ALGORITHM_VERSION
} from "../../../recall/shadow/index.js";
import {
  isFailClosedShadowTrace,
  prefixSK,
  type ShadowCapturedTrace
} from "../../../recall/shadow/integrate.js";
import * as walk from "../../../recall/shadow/walk.js";
import { FIELD_PINS } from "../fine-assessment-selection-fixtures.js";
import { createMemoryEntry, withFineDeliveryPath } from "../recall-service-test-fixtures.js";
import {
  embeddingObserved,
  field,
  temporalObserved,
  view
} from "./psi-test-support.js";

const NOW = "2026-07-12T00:00:00.000Z";
const IDS = ["cand-a", "cand-b", "cand-c"] as const;
const CANONICAL_SRC = readFileSync(
  path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../recall/shadow/canonical-delivery.ts"
  ),
  "utf8"
);

describe("C0 reversible delivery cutover", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("defaults omitted delivery_path to canonical", () => {
    const policy = policyOf();
    expect(policy.fine_assessment.delivery_path).toBeUndefined();
    expect(resolveFineAssessmentDeliveryPath(policy.fine_assessment)).toBe("canonical");
    const result = fineAssess(assessParams(fieldCandidates()));
    expect(result.delivery_path).toBe("canonical");
    expect(result.ranking_authority).toBe("d0_prefix");
    expect(result.d0_identity).toEqual(CANONICAL_D0_IDENTITY);
    expect(result.candidates.every((candidate) => candidate.relevance_score === 0)).toBe(true);
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

  it("keeps H_E0 a subset of H_E1 and recovers the E0 prefix after masking embedding", () => {
    const shared = fieldCandidates();
    const extra = extraCandidate("cand-d");
    const lanes = porterLanes({
      "cand-a": 0.9,
      "cand-b": 0.6,
      "cand-c": 0.3
    });
    const e0 = fineAssess(lexicalAssess(shared, {
      embedding_enabled: false,
      lanes,
      embeddingSimilarityScores: { "cand-a": 0.2, "cand-b": 0.3, "cand-c": 0.4 },
      e0Keys: shared.map((candidate) => keyOf(candidate.entry.object_id)),
      e1Keys: shared.map((candidate) => keyOf(candidate.entry.object_id))
    }));
    const e1 = fineAssess(lexicalAssess([...shared, extra], {
      embedding_enabled: true,
      lanes,
      embeddingSimilarityScores: {
        "cand-a": 0.2,
        "cand-b": 0.3,
        "cand-c": 0.4,
        "cand-d": 0.99
      },
      e0Keys: shared.map((candidate) => keyOf(candidate.entry.object_id)),
      e1Keys: [...shared, extra].map((candidate) => keyOf(candidate.entry.object_id))
    }));
    const masked = fineAssess(lexicalAssess([...shared, extra], {
      embedding_enabled: false,
      lanes,
      embeddingSimilarityScores: {}
    }));
    const e0Keys = asCaptured(e0.shadowTrace).eligible_keys;
    const e1Keys = asCaptured(e1.shadowTrace).eligible_keys;
    expect(e0Keys.every((key) => e1Keys.includes(key))).toBe(true);
    expect(e1Keys).toContain(keyOf("cand-d"));
    expect(e0.candidates.map((candidate) => candidate.object_id))
      .toEqual(["cand-a", "cand-b", "cand-c"]);
    expect(masked.candidates.map((candidate) => candidate.object_id)
      .filter((objectId) => objectId !== "cand-d"))
      .toEqual(e0.candidates.map((candidate) => candidate.object_id));
  });

  it("orders canonical prefix from live lane receipts instead of candidate_key", () => {
    const result = fineAssess(lexicalAssess(fieldCandidates(), {
      embedding_enabled: false,
      lanes: porterLanes({
        "cand-c": 0.9,
        "cand-b": 0.6,
        "cand-a": 0.3
      })
    }));
    expect(asCaptured(result.shadowTrace).lexical_mapping).toBe("lane_receipts");
    expect(result.candidates.map((candidate) => candidate.object_id))
      .toEqual(["cand-c", "cand-b", "cand-a"]);
    expect(result.ranking_authority).toBe("d0_prefix");
  });

  it("binds the frozen D0 identity triple on canonical result and trace", () => {
    const result = fineAssess(assessParams(fieldCandidates(), "canonical"));
    const captured = asCaptured(result.shadowTrace);
    expect(result.d0_identity).toEqual(CANONICAL_D0_IDENTITY);
    expect(captured.algorithm_id).toBe(SHADOW_ALGORITHM_ID);
    expect(captured.version).toBe(SHADOW_ALGORITHM_VERSION);
    expect(captured.digest).toBe(D0_IDENTITY_DIGEST);
    expect(captured.c0_seam.activation).toBe("active");
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
    expect(closed.candidates).toEqual([]);
    expect(closed.delivery_path).toBe("canonical");
    expect(legacy.candidates.length).toBeGreaterThan(0);
    expect(closed.candidates.map((candidate) => candidate.object_id))
      .not.toEqual(legacy.candidates.map((candidate) => candidate.object_id));
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

function fieldCandidates(): readonly CoarseRecallCandidate[] {
  return IDS.map((objectId, index) => extraCandidate(objectId, index));
}

function extraCandidate(objectId: string, index = 0): CoarseRecallCandidate {
  return {
    entry: createMemoryEntry({
      object_id: objectId,
      content: `Operator workspace fact ${index}`,
      activation_score: 0.4 + index * 0.1
    }),
    admissionPlanes: ["activation"],
    firstAdmissionPlane: "activation"
  };
}

function lexicalAssess(
  candidates: readonly CoarseRecallCandidate[],
  options: {
    readonly embedding_enabled: boolean;
    readonly lanes: readonly Readonly<KeywordSearchLaneReceipt>[];
    readonly embeddingSimilarityScores?: Readonly<Record<string, number>>;
    readonly e0Keys?: readonly string[];
    readonly e1Keys?: readonly string[];
  }
) {
  return {
    ...assessParams(candidates, "canonical"),
    policy: withFineDeliveryPath(policyOf({
      embedding_enabled: options.embedding_enabled
    }), "canonical"),
    memoryKeywordLanes: options.lanes,
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
