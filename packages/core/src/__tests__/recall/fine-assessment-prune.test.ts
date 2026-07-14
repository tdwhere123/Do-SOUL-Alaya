import { describe, expect, it } from "vitest";
import {
  FINE_ASSESSMENT_COARSE_PRUNE_CAP,
  pruneCoarseCandidatesForFineAssessment
} from "../../recall/delivery/fine-assessment-prune.js";
import { prepareFineAssessment } from "../../recall/delivery/fine-assessment.js";
import type { CoarseRecallCandidate, RecallSupplementaryData } from "../../recall/runtime/recall-service-types.js";
import { compileRecallQueryProbes } from "../../recall/query/recall-query-probes.js";
import { buildDefaultPolicy } from "../../recall/runtime/orchestration.js";
import { createMemoryEntry, createTaskSurface } from "./recall-service-test-fixtures.js";

describe("pruneCoarseCandidatesForFineAssessment", () => {
  it("enforces the latency-budget cap on competitive candidates", () => {
    const candidates = Array.from({ length: FINE_ASSESSMENT_COARSE_PRUNE_CAP + 40 }, (_, index) =>
      coarseCandidate(`memory-${index}`, { structuralScore: index / 1000 })
    );
    const result = pruneCoarseCandidatesForFineAssessment({
      candidates,
      supplementaryData: emptySupplementaryScores(),
      winnerMemoryIds: new Set()
    });

    expect(result.coarsePoolSize).toBe(FINE_ASSESSMENT_COARSE_PRUNE_CAP + 40);
    expect(result.fineEvaluated).toBe(FINE_ASSESSMENT_COARSE_PRUNE_CAP);
    expect(result.finePrunedCount).toBe(40);
    expect(result.survivors).toHaveLength(FINE_ASSESSMENT_COARSE_PRUNE_CAP);
  });

  it("always retains protected winners even when they would miss the competitive cut", () => {
    const protectedWinner = coarseCandidate("winner-1", {
      admissionPlanes: ["protected_winner"],
      structuralScore: 0
    });
    const filler = Array.from({ length: FINE_ASSESSMENT_COARSE_PRUNE_CAP }, (_, index) =>
      coarseCandidate(`filler-${index}`, { structuralScore: 1 })
    );
    const result = pruneCoarseCandidatesForFineAssessment({
      candidates: [...filler, protectedWinner],
      supplementaryData: emptySupplementaryScores(),
      winnerMemoryIds: new Set(["winner-1"])
    });

    expect(result.survivors.some((candidate) => candidate.entry.object_id === "winner-1")).toBe(true);
    expect(result.fineEvaluated).toBe(FINE_ASSESSMENT_COARSE_PRUNE_CAP);
    expect(result.finePrunedCount).toBe(1);
  });

  it("always retains embedding-injected semantic_supplement neighbors", () => {
    const injected = coarseCandidate("emb-neighbor", {
      admissionPlanes: ["semantic_supplement"],
      sourceChannel: "semantic_supplement",
      structuralScore: 0
    });
    const filler = Array.from({ length: FINE_ASSESSMENT_COARSE_PRUNE_CAP }, (_, index) =>
      coarseCandidate(`filler-${index}`, { structuralScore: 1 })
    );
    const result = pruneCoarseCandidatesForFineAssessment({
      candidates: [...filler, injected],
      supplementaryData: emptySupplementaryScores({
        embeddingSimilarityScores: { "emb-neighbor": 0.91 }
      }),
      winnerMemoryIds: new Set()
    });

    expect(result.survivors.some((candidate) => candidate.entry.object_id === "emb-neighbor")).toBe(true);
    expect(result.fineEvaluated).toBe(FINE_ASSESSMENT_COARSE_PRUNE_CAP);
    expect(result.finePrunedCount).toBe(1);
  });

  it("bounds injected supplements under the waist when winners leave little room", () => {
    const winners = Array.from({ length: FINE_ASSESSMENT_COARSE_PRUNE_CAP - 2 }, (_, index) =>
      coarseCandidate(`winner-${index}`, {
        admissionPlanes: ["protected_winner"],
        structuralScore: 0
      })
    );
    const injected = Array.from({ length: 40 }, (_, index) =>
      coarseCandidate(`injected-${index}`, {
        admissionPlanes: ["semantic_supplement"],
        sourceChannel: "semantic_supplement",
        structuralScore: 0
      })
    );
    const filler = Array.from({ length: 30 }, (_, index) =>
      coarseCandidate(`filler-${index}`, { structuralScore: 1 })
    );
    const result = pruneCoarseCandidatesForFineAssessment({
      candidates: [...winners, ...injected, ...filler],
      supplementaryData: emptySupplementaryScores(),
      winnerMemoryIds: new Set(winners.map((candidate) => candidate.entry.object_id))
    });

    expect(result.fineEvaluated).toBe(FINE_ASSESSMENT_COARSE_PRUNE_CAP);
    expect(
      result.survivors.filter((candidate) =>
        (candidate.admissionPlanes ?? []).includes("semantic_supplement")
      )
    ).toHaveLength(2);
    expect(
      result.survivors.filter((candidate) => candidate.entry.object_id.startsWith("filler-"))
    ).toHaveLength(0);
  });

  it("lets winners alone exceed the waist without pulling injected/competitive past them", () => {
    const winners = Array.from({ length: FINE_ASSESSMENT_COARSE_PRUNE_CAP + 15 }, (_, index) =>
      coarseCandidate(`winner-${index}`, {
        admissionPlanes: ["protected_winner"],
        structuralScore: 0
      })
    );
    const injected = coarseCandidate("injected-overflow", {
      admissionPlanes: ["semantic_supplement"],
      sourceChannel: "semantic_supplement"
    });
    const result = pruneCoarseCandidatesForFineAssessment({
      candidates: [...winners, injected, coarseCandidate("filler", { structuralScore: 1 })],
      supplementaryData: emptySupplementaryScores(),
      winnerMemoryIds: new Set(winners.map((candidate) => candidate.entry.object_id))
    });

    expect(result.fineEvaluated).toBe(winners.length);
    expect(result.survivors.every((candidate) => candidate.entry.object_id.startsWith("winner-"))).toBe(true);
  });

  it("ranks competitive survivors by embedding + FTS + structural signals", () => {
    const low = coarseCandidate("low");
    const highEmb = coarseCandidate("high-emb");
    const highFts = coarseCandidate("high-fts");
    const highStructural = coarseCandidate("high-structural", { structuralScore: 0.9 });
    const result = pruneCoarseCandidatesForFineAssessment({
      candidates: [low, highEmb, highFts, highStructural],
      supplementaryData: emptySupplementaryScores({
        embeddingSimilarityScores: { "high-emb": 0.95 },
        ftsRanks: { "high-fts": 0.9 },
        structuralScores: { "high-structural": 0.2 }
      }),
      winnerMemoryIds: new Set(),
      cap: 3
    });

    expect(result.survivors.map((candidate) => candidate.entry.object_id)).toEqual([
      "high-emb",
      "high-fts",
      "high-structural"
    ]);
    expect(result.finePrunedCount).toBe(1);
  });
});

describe("prepareFineAssessment prune diagnostics", () => {
  it("exposes fine_evaluated and fine_pruned_count after the coarse→fine waist", () => {
    const candidates = Array.from({ length: FINE_ASSESSMENT_COARSE_PRUNE_CAP + 25 }, (_, index) =>
      coarseCandidate(`memory-${index}`, { structuralScore: (index + 1) / 1000 })
    );
    const preparation = prepareFineAssessment({
      candidates,
      policy: buildDefaultPolicy({
        strategy: "analyze",
        taskSurfaceRef: createTaskSurface().runtime_id,
        now: () => "2026-07-14T00:00:00.000Z",
        generateRuntimeId: () => "33333333-3333-4333-8333-333333333333"
      }),
      winnerMemoryIds: new Set(),
      supplementaryData: emptySupplementaryData(),
      tokenEstimator: { estimate: () => 4 },
      now: () => "2026-07-14T00:00:00.000Z",
      warn: () => undefined
    });

    expect(preparation.coarsePoolSize).toBe(FINE_ASSESSMENT_COARSE_PRUNE_CAP + 25);
    expect(preparation.fineEvaluated).toBe(FINE_ASSESSMENT_COARSE_PRUNE_CAP);
    expect(preparation.finePrunedCount).toBe(25);
    expect(preparation.candidates).toHaveLength(FINE_ASSESSMENT_COARSE_PRUNE_CAP);
  });
});

function coarseCandidate(
  objectId: string,
  overrides: Partial<CoarseRecallCandidate> = {}
): Readonly<CoarseRecallCandidate> {
  return Object.freeze({
    entry: createMemoryEntry({ object_id: objectId, content: `Recall content for ${objectId}.` }),
    admissionPlanes: Object.freeze(["activation" as const]),
    firstAdmissionPlane: "activation" as const,
    ...overrides
  });
}

function emptySupplementaryScores(
  overrides: Partial<{
    embeddingSimilarityScores: Record<string, number>;
    ftsRanks: Record<string, number>;
    trigramFtsRanks: Record<string, number>;
    evidenceFtsRanks: Record<string, number>;
    structuralScores: Record<string, number>;
  }> = {}
) {
  return {
    embeddingSimilarityScores: Object.freeze(overrides.embeddingSimilarityScores ?? {}),
    ftsRanks: Object.freeze(overrides.ftsRanks ?? {}),
    trigramFtsRanks: Object.freeze(overrides.trigramFtsRanks ?? {}),
    evidenceFtsRanks: Object.freeze(overrides.evidenceFtsRanks ?? {}),
    structuralScores: Object.freeze(overrides.structuralScores ?? {})
  };
}

function emptySupplementaryData(): RecallSupplementaryData {
  return Object.freeze({
    queryProbes: compileRecallQueryProbes("prune diagnostics"),
    ftsRanks: Object.freeze({}),
    trigramFtsRanks: Object.freeze({}),
    synthesisFtsRanks: Object.freeze({}),
    evidenceFtsRanks: Object.freeze({}),
    sourceProximityScores: Object.freeze({}),
    sourceCohortKeys: Object.freeze({}),
    structuralScores: Object.freeze({}),
    graphExpansionScores: Object.freeze({}),
    entitySeedScores: Object.freeze({}),
    pathExpansionScores: Object.freeze({}),
    pathSuppressionScores: Object.freeze({}),
    embeddingSimilarityScores: Object.freeze({}),
    graphSupportCounts: Object.freeze({}),
    budgetPenaltyFactor: 1,
    plasticityFactors: Object.freeze({}),
    graphAndPathColdScore: 0,
    recallsEdgeCount: 0,
    weightTransferAmount: 0,
    evidenceGistsByMemoryId: Object.freeze({}),
    governanceCeilingByMemoryId: Object.freeze({})
  });
}
