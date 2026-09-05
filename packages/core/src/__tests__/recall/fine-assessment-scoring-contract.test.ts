import { describe, expect, it, vi } from "vitest";
import { fineAssess, prepareFineAssessment } from
  "../../recall/delivery/fine-assessment.js";
import { buildRecallFusionDetails } from
  "../../recall/delivery/fusion-delivery-scoring.js";
import { compileRecallQueryProbes } from "../../recall/query/recall-query-probes.js";
import { buildDefaultPolicy } from "../../recall/runtime/orchestration.js";
import type {
  CoarseRecallCandidate,
  PathInflowEdge,
  RecallSupplementaryData
} from "../../recall/runtime/recall-service-types.js";
import { FIELD_PINS } from "./fine-assessment-selection-fixtures.js";
import { createMemoryEntry, withFineDeliveryPath } from "./recall-service-test-fixtures.js";

const NOW = "2026-07-12T00:00:00.000Z";

describe("fine assessment scoring contract", () => {
  it("scores the complete coarse field and does not prune before Select_Gamma", () => {
    const candidates = fieldCandidates(12);
    const prepared = prepareFineAssessment(assessParams(candidates));

    expect(prepared.coarsePoolSize).toBe(12);
    expect(prepared.fineEvaluated).toBe(12);
    expect(prepared.finePrunedCount).toBe(0);
    expect(prepared.prunedCandidates).toEqual([]);
    expect(prepared.candidates).toHaveLength(12);
  });

  it("keeps fused scores, ranks, and delivered ids when answer-feature capture is off", () => {
    const candidates = fieldCandidates(8);
    const withoutCapture = fineAssess(assessParams(candidates, { captureAnswerFeatures: false }));
    const withCapture = fineAssess(assessParams(candidates, { captureAnswerFeatures: true }));

    expect(fusionContract(withoutCapture)).toEqual(fusionContract(withCapture));
    expect(withoutCapture.candidates.map((candidate) => candidate.object_id))
      .toEqual(withCapture.candidates.map((candidate) => candidate.object_id));
    expect(withoutCapture.diagnostics.some((row) => "answer_features" in row)).toBe(false);
    expect(withCapture.diagnostics.some((row) => "answer_features" in row)).toBe(true);
    expect(withoutCapture.preparedCandidates.some((candidate) =>
      candidate.fusion.flood_potential?.edge_traces !== undefined
    )).toBe(false);
  });

  it("does not change fused scores when flood edge traces are omitted", () => {
    const fusionCandidates = fieldCandidates(6).map((candidate, index) => ({
      ...candidate,
      effectiveScore: 0.4 + index * 0.05,
      effectiveFactors: { activation: 0.4 + index * 0.05, relevance: 0.4 }
    }));
    const supplementaryData = supplementaryWithInflow(fusionCandidates);
    const withTraces = buildRecallFusionDetails({
      candidates: fusionCandidates,
      policy: policy(),
      supplementaryData,
      nowIso: NOW
    });
    const withoutTraces = buildRecallFusionDetails({
      candidates: fusionCandidates,
      policy: policy(),
      supplementaryData,
      nowIso: NOW,
      includeFloodEdgeTraces: false
    });

    for (const [key, traced] of withTraces) {
      const stripped = withoutTraces.get(key);
      expect(stripped?.fused_score).toBe(traced.fused_score);
      expect(stripped?.fused_rank).toBe(traced.fused_rank);
      expect(stripped?.flood_potential?.edge_traces).toBeUndefined();
    }
  });

  it("isolates diagnostic observer failures from delivery", () => {
    const candidates = fieldCandidates(4);
    const baseline = fineAssess(assessParams(candidates));
    const observed = fineAssess({
      ...assessParams(candidates),
      diagnosticObserver: () => { throw new Error("diagnostic sink unavailable"); }
    });

    expect(observed.candidates).toEqual(baseline.candidates);
    expect(observed.diagnostics).toEqual(baseline.diagnostics);
    expect(observed.ranking_authority).toBe(baseline.ranking_authority);
  });
});

function fusionContract(assessed: ReturnType<typeof fineAssess>) {
  return assessed.preparedCandidates.map((candidate) => ({
    key: candidate.fusion.candidate_key,
    fused_score: candidate.fusion.fused_score,
    fused_rank: candidate.fusion.fused_rank
  }));
}

function assessParams(
  candidates: readonly CoarseRecallCandidate[],
  overrides: { readonly captureAnswerFeatures?: boolean } = {}
) {
  return {
    ...FIELD_PINS,
    candidates,
    policy: policy(),
    winnerMemoryIds: new Set<string>(),
    supplementaryData: supplementaryWithInflow(candidates),
    tokenEstimator: { estimate: () => 4 },
    now: () => NOW,
    warn: vi.fn(),
    ...overrides
  };
}

function policy() {
  return withFineDeliveryPath(buildDefaultPolicy({
    strategy: "build",
    taskSurfaceRef: "task-surface-1",
    now: () => NOW,
    generateRuntimeId: () => "33333333-3333-4333-8333-333333333333"
  }), "legacy");
}

function fieldCandidates(count: number): readonly CoarseRecallCandidate[] {
  return Array.from({ length: count }, (_, index) => {
    const objectId = `aaaaaaaa-aaaa-4aaa-8aaa-${index.toString(16).padStart(12, "0")}`;
    return {
      entry: createMemoryEntry({
        object_id: objectId,
        content: `Operator workspace fact ${index}`,
        activation_score: 0.2 + (index % 5) * 0.1,
        event_time_start: "2026-03-19T00:00:00.000Z",
        event_time_end: "2026-03-19T00:00:00.000Z"
      }),
      admissionPlanes: ["activation"],
      firstAdmissionPlane: "activation",
      structuralScore: index % 3 === 0 ? 0.4 : 0
    };
  });
}

function supplementaryWithInflow(
  candidates: readonly CoarseRecallCandidate[]
): RecallSupplementaryData {
  const ftsRanks: Record<string, number> = {};
  const embeddingSimilarityScores: Record<string, number> = {};
  const pathInflowByTarget: Record<string, PathInflowEdge[]> = {};
  for (const [index, candidate] of candidates.entries()) {
    const objectId = candidate.entry.object_id;
    ftsRanks[objectId] = Math.max(0, 1 - index * 0.07);
    embeddingSimilarityScores[objectId] = 0.15 + (index % 4) * 0.1;
    if (index > 0) {
      const seed = candidates[index - 1]!.entry.object_id;
      pathInflowByTarget[objectId] = [{
        pathId: `path-${index}`,
        relationKind: "answers_with",
        seedObjectId: seed,
        targetObjectId: objectId,
        seedAnchor: { kind: "object", object_id: seed },
        targetAnchor: { kind: "object", object_id: objectId },
        pathSourceVersion: NOW,
        weight: 0.4
      }];
    }
  }
  return {
    queryProbes: compileRecallQueryProbes("where does the operator work on 2026-03-19?"),
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
    governanceCeilingByMemoryId: {},
    pathInflowByTarget
  };
}
