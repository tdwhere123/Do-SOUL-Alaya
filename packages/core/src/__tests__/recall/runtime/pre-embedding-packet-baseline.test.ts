import { describe, expect, it, vi } from "vitest";
import {
  collectPreEmbeddingPacketBaseline
} from "../../../recall/runtime/orchestration/recall-fine-assessment.js";
import type { CoarseStageResult } from
  "../../../recall/runtime/recall-service-runner-coarse.js";
import type {
  PreparedRecallRequest,
  RecallExecutionContext,
  RecallExecutionParams
} from "../../../recall/runtime/recall-service-runner-types.js";

const mocks = vi.hoisted(() => ({
  prepareWaist: vi.fn(),
  collectSupplementary: vi.fn(),
  prepare: vi.fn(),
  deliver: vi.fn()
}));

vi.mock("../../../recall/delivery/fine-assessment.js", () => ({
  prepareFineAssessmentWaist: mocks.prepareWaist,
  prepareFineAssessment: mocks.prepare,
  deliverFineAssessment: mocks.deliver
}));

vi.mock("../../../recall/runtime/orchestration/coarse.js", () => ({
  collectCoarseFilterSupplementaryData: mocks.collectSupplementary
}));

describe("collectPreEmbeddingPacketBaseline", () => {
  it("replays the packet path from the pre-embedding waist without embedding candidates or scores", async () => {
    const lexicalCandidate = candidate("lexical");
    const embeddingOnlyCandidate = candidate("embedding-only");
    const supplementaryData = Object.freeze({
      embeddingSimilarityScores: Object.freeze({})
    });
    const waist = Object.freeze({
      survivors: Object.freeze([lexicalCandidate]),
      prunedCandidates: Object.freeze([]),
      coarsePoolSize: 1,
      fineEvaluated: 1,
      finePrunedCount: 0,
      priorityCandidateCount: 0,
      priorityOverflowCount: 0,
      hardBudget: 1
    });
    const preparation = Object.freeze({
      candidates: Object.freeze([{ ...lexicalCandidate, fusion: Object.freeze({}) }]),
      prunedCandidates: Object.freeze([]),
      coarsePoolSize: 1,
      fineEvaluated: 1,
      finePrunedCount: 0,
      finePriorityOverflowCount: 0
    });
    const packet = Object.freeze({
      candidates: Object.freeze([{ object_id: "lexical" }]),
      diagnostics: Object.freeze([])
    });
    mocks.prepareWaist.mockReturnValue(waist);
    mocks.collectSupplementary.mockResolvedValue(supplementaryData);
    mocks.prepare.mockReturnValue(preparation);
    mocks.deliver.mockReturnValue(packet);

    const context = {
      dependencies: {},
      warn: vi.fn()
    } as unknown as RecallExecutionContext;
    const params = {
      workspaceId: "workspace-1",
      runId: "run-1",
      diagnosticCapture: "packet_trace"
    } as unknown as RecallExecutionParams;
    const prepared = {
      policy: {},
      queryText: "lexical query",
      queryProbes: {},
      winnerMemoryIds: new Set<string>(),
      referenceTime: "2026-07-28T00:00:00.000Z",
      tokenEstimator: () => 1
    } as unknown as PreparedRecallRequest;
    const coarse = {
      coarseFilter: {
        candidates: Object.freeze([lexicalCandidate, embeddingOnlyCandidate]),
        ftsRanks: Object.freeze({ lexical: 1 }),
        trigramFtsRanks: Object.freeze({}),
        synthesisFtsRanks: Object.freeze({}),
        evidenceFtsRanks: Object.freeze({}),
        evidenceFtsRanksPerRef: Object.freeze({}),
        sourceProximityScores: Object.freeze({}),
        sourceCohortKeys: Object.freeze({}),
        structuralScores: Object.freeze({}),
        graphExpansionScores: Object.freeze({}),
        graphExpansionDiagnostics: Object.freeze({}),
        graphExpansionCandidateSources: new Map(),
        entitySeedScores: Object.freeze({}),
        pathExpansionScores: Object.freeze({}),
        pathSuppressionScores: Object.freeze({}),
        total_scanned: 2,
        degradation_reason: null
      },
      preEmbeddingCoarseCandidates: Object.freeze([lexicalCandidate]),
      combinedCoarseCandidates: Object.freeze([lexicalCandidate, embeddingOnlyCandidate]),
      embeddingCoarseInjection: {
        candidates: Object.freeze([embeddingOnlyCandidate]),
        similarityScores: Object.freeze({ lexical: 0.99, "embedding-only": 1 }),
        requestScoreSnapshot: {
          poolScoresByObjectId: Object.freeze({ lexical: 0.98 })
        }
      }
    } as unknown as CoarseStageResult;

    const result = await collectPreEmbeddingPacketBaseline(
      context,
      params,
      prepared,
      coarse
    );

    expect(mocks.prepareWaist).toHaveBeenCalledWith(expect.objectContaining({
      candidates: [lexicalCandidate],
      supplementaryData: expect.objectContaining({
        embeddingSimilarityScores: {}
      })
    }));
    expect(mocks.collectSupplementary).toHaveBeenCalledWith(expect.objectContaining({
      coarseFilter: expect.objectContaining({ candidates: [lexicalCandidate] }),
      captureAnswerFeatures: true
    }));
    expect(mocks.prepare).toHaveBeenCalledWith(expect.objectContaining({
      candidates: [lexicalCandidate],
      supplementaryData
    }), waist);
    expect(mocks.deliver).toHaveBeenCalledWith(expect.objectContaining({
      candidates: [lexicalCandidate],
      supplementaryData,
      captureAnswerFeatures: true
    }), preparation);
    expect(mocks.prepareWaist.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.collectSupplementary.mock.invocationCallOrder[0]!);
    expect(mocks.collectSupplementary.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.prepare.mock.invocationCallOrder[0]!);
    expect(mocks.prepare.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.deliver.mock.invocationCallOrder[0]!);
    expect(result).toBe(packet);
  });
});

function candidate(objectId: string) {
  return Object.freeze({
    entry: Object.freeze({ object_id: objectId }),
    objectKind: "memory_entry" as const,
    originPlane: "workspace_local" as const
  });
}
