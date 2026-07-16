import { describe, expect, it, vi } from "vitest";
import type { RecallPolicy } from "@do-soul/alaya-protocol";
import {
  pruneCoarseCandidatesForFineAssessment,
  resolveFineAssessmentCandidateBudget
} from "../../recall/delivery/fine-assessment-prune.js";
import { prepareFineAssessment } from "../../recall/delivery/fine-assessment.js";
import type { CoarseRecallCandidate, RecallSupplementaryData } from "../../recall/runtime/recall-service-types.js";
import { compileRecallQueryProbes } from "../../recall/query/recall-query-probes.js";
import { buildDefaultPolicy } from "../../recall/runtime/orchestration.js";
import { RECALL_TOTAL_CANDIDATE_CAP } from "../../shared/recall-policy.js";
import { createMemoryEntry, createTaskSurface } from "./recall-service-test-fixtures.js";

const TEST_FINE_BUDGET = 20;

describe("pruneCoarseCandidatesForFineAssessment", () => {
  it("enforces the latency-budget cap on competitive candidates", () => {
    const candidates = Array.from({ length: TEST_FINE_BUDGET + 40 }, (_, index) =>
      coarseCandidate(`memory-${index}`, { structuralScore: index / 1000 })
    );
    const result = pruneCoarseCandidatesForFineAssessment({
      candidates,
      supplementaryData: emptySupplementaryScores(),
      winnerMemoryIds: new Set(),
      cap: TEST_FINE_BUDGET
    });

    expect(result.coarsePoolSize).toBe(TEST_FINE_BUDGET + 40);
    expect(result.fineEvaluated).toBe(TEST_FINE_BUDGET);
    expect(result.finePrunedCount).toBe(40);
    expect(result.survivors).toHaveLength(TEST_FINE_BUDGET);
  });

  it("always retains protected winners even when they would miss the competitive cut", () => {
    const protectedWinner = coarseCandidate("winner-1", {
      admissionPlanes: ["protected_winner"],
      structuralScore: 0
    });
    const filler = Array.from({ length: TEST_FINE_BUDGET }, (_, index) =>
      coarseCandidate(`filler-${index}`, { structuralScore: 1 })
    );
    const result = pruneCoarseCandidatesForFineAssessment({
      candidates: [...filler, protectedWinner],
      supplementaryData: emptySupplementaryScores(),
      winnerMemoryIds: new Set(["winner-1"]),
      cap: TEST_FINE_BUDGET
    });

    expect(result.survivors.some((candidate) => candidate.entry.object_id === "winner-1")).toBe(true);
    expect(result.fineEvaluated).toBe(TEST_FINE_BUDGET);
    expect(result.finePrunedCount).toBe(1);
  });

  it("always retains embedding-injected semantic_supplement neighbors", () => {
    const injected = coarseCandidate("emb-neighbor", {
      admissionPlanes: ["semantic_supplement"],
      sourceChannel: "semantic_supplement",
      structuralScore: 0
    });
    const filler = Array.from({ length: TEST_FINE_BUDGET }, (_, index) =>
      coarseCandidate(`filler-${index}`, { structuralScore: 1 })
    );
    const result = pruneCoarseCandidatesForFineAssessment({
      candidates: [...filler, injected],
      supplementaryData: emptySupplementaryScores({
        embeddingSimilarityScores: { "emb-neighbor": 0.91 }
      }),
      winnerMemoryIds: new Set(),
      cap: TEST_FINE_BUDGET
    });

    expect(result.survivors.some((candidate) => candidate.entry.object_id === "emb-neighbor")).toBe(true);
    expect(result.fineEvaluated).toBe(TEST_FINE_BUDGET);
    expect(result.finePrunedCount).toBe(1);
  });

  it("bounds injected supplements under the waist when winners leave little room", () => {
    const winners = Array.from({ length: TEST_FINE_BUDGET - 2 }, (_, index) =>
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
      winnerMemoryIds: new Set(winners.map((candidate) => candidate.entry.object_id)),
      cap: TEST_FINE_BUDGET
    });

    expect(result.fineEvaluated).toBe(TEST_FINE_BUDGET);
    expect(
      result.survivors.filter((candidate) =>
        (candidate.admissionPlanes ?? []).includes("semantic_supplement")
      )
    ).toHaveLength(2);
    expect(
      result.survivors.filter((candidate) => candidate.entry.object_id.startsWith("filler-"))
    ).toHaveLength(0);
  });

  it("truncates winner overflow before injected and competitive candidates", () => {
    const winners = Array.from({ length: TEST_FINE_BUDGET + 15 }, (_, index) =>
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
      winnerMemoryIds: new Set(winners.map((candidate) => candidate.entry.object_id)),
      cap: TEST_FINE_BUDGET
    });

    expect(result.fineEvaluated).toBe(TEST_FINE_BUDGET);
    expect(result.survivors.every((candidate) => candidate.entry.object_id.startsWith("winner-"))).toBe(true);
  });

  it("keeps protected and injected candidates inside the same hard budget", () => {
    const candidates = [
      coarseCandidate("winner-b", { admissionPlanes: ["protected_winner"] }),
      coarseCandidate("winner-a", { admissionPlanes: ["protected_winner"] }),
      coarseCandidate("injected-a", {
        admissionPlanes: ["semantic_supplement"],
        sourceChannel: "semantic_supplement"
      }),
      coarseCandidate("competitive-a", { structuralScore: 1 })
    ];

    const result = pruneCoarseCandidatesForFineAssessment({
      candidates,
      supplementaryData: emptySupplementaryScores(),
      winnerMemoryIds: new Set(["winner-a", "winner-b"]),
      cap: 2
    });

    expect(result.fineEvaluated).toBe(2);
    expect(result.finePrunedCount).toBe(2);
    expect(result.survivors.map((candidate) => candidate.entry.object_id)).toEqual([
      "winner-a",
      "winner-b"
    ]);
  });

  it("selects the same bounded survivors regardless of coarse input order", () => {
    const candidates = [
      coarseCandidate("winner-b", { admissionPlanes: ["protected_winner"] }),
      coarseCandidate("winner-a", { admissionPlanes: ["protected_winner"] }),
      coarseCandidate("injected-b", {
        admissionPlanes: ["semantic_supplement"],
        sourceChannel: "semantic_supplement"
      }),
      coarseCandidate("injected-a", {
        admissionPlanes: ["semantic_supplement"],
        sourceChannel: "semantic_supplement"
      })
    ];
    const run = (input: readonly Readonly<CoarseRecallCandidate>[]) =>
      pruneCoarseCandidatesForFineAssessment({
        candidates: input,
        supplementaryData: emptySupplementaryScores(),
        winnerMemoryIds: new Set(["winner-a", "winner-b"]),
        cap: 3
      }).survivors.map((candidate) => candidate.entry.object_id);

    expect(run(candidates)).toEqual(run([...candidates].reverse()));
    expect(run(candidates)).toEqual(["winner-a", "winner-b", "injected-a"]);
  });

  it("keeps memory-only signals scoped to logical candidate identity", () => {
    const local = coarseCandidate("shared", { structuralScore: 0.4 });
    const synthesis = coarseCandidate("shared", {
      objectKind: "synthesis_capsule",
      structuralScore: 0
    });
    const global = coarseCandidate("shared", {
      originPlane: "global",
      structuralScore: 0
    });
    const other = coarseCandidate("other", { structuralScore: 0.5 });
    const run = (candidates: readonly Readonly<CoarseRecallCandidate>[]) =>
      pruneCoarseCandidatesForFineAssessment({
        candidates,
        supplementaryData: emptySupplementaryScores({
          structuralScores: { shared: 1 }
        }),
        winnerMemoryIds: new Set(),
        cap: 2
      }).survivors.map((candidate) => candidate.entry.object_id === "shared"
        ? `${candidate.originPlane ?? "workspace_local"}:${candidate.objectKind ?? "memory_entry"}`
        : candidate.entry.object_id
      );
    const candidates = [synthesis, global, other, local];

    expect(run(candidates)).toEqual(["workspace_local:memory_entry", "other"]);
    expect(run([...candidates].reverse())).toEqual(run(candidates));
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

  it("keeps a production-shape synthesis child visible through the cheap waist", () => {
    const synthesisChild = coarseCandidate("z-synthesis-child", {
      sourceChannel: "synthesis_child",
      sourceChannels: ["synthesis_child", "synthesis_fts"],
      admissionPlanes: ["synthesis_child"]
    });
    const filler = coarseCandidate("a-filler");
    const supplementaryData = emptySupplementaryScores({
      ftsRanks: { "a-filler": 0.4 },
      synthesisFtsRanks: { "z-synthesis-child": 0.9 }
    });
    const run = (candidates: readonly Readonly<CoarseRecallCandidate>[]) =>
      pruneCoarseCandidatesForFineAssessment({
        candidates,
        supplementaryData,
        winnerMemoryIds: new Set(),
        cap: 1
      }).survivors.map((candidate) => candidate.entry.object_id);

    expect(run([synthesisChild, filler])).toEqual(["z-synthesis-child"]);
    expect(run([filler, synthesisChild])).toEqual(["z-synthesis-child"]);
  });

  it.each([
    ["missing", {}],
    ["invalid", { "z-cold": Number.NaN }]
  ])("keeps an embedding-%s candidate ahead of observed zero at a tight waist", (
    _label,
    coldScores
  ) => {
    const observedZero = coarseCandidate("a-observed-zero");
    const cold = coarseCandidate("z-cold");
    const supplementaryData = emptySupplementaryScores({
      embeddingSimilarityScores: { "a-observed-zero": 0, ...coldScores },
      ftsRanks: { "a-observed-zero": 0.5, "z-cold": 0.5 }
    });
    const run = (candidates: readonly Readonly<CoarseRecallCandidate>[]) =>
      pruneCoarseCandidatesForFineAssessment({
        candidates,
        supplementaryData,
        winnerMemoryIds: new Set(),
        cap: 1
      }).survivors.map((candidate) => candidate.entry.object_id);

    expect(run([observedZero, cold])).toEqual(["z-cold"]);
    expect(run([cold, observedZero])).toEqual(["z-cold"]);
  });
});

describe("prepareFineAssessment prune diagnostics", () => {
  it("derives a bounded fallback from old policy resource budgets", () => {
    const current = buildDefaultPolicy({
      strategy: "analyze",
      taskSurfaceRef: createTaskSurface().runtime_id,
      now: () => "2026-07-14T00:00:00.000Z",
      generateRuntimeId: () => "33333333-3333-4333-8333-333333333333"
    });
    const { max_candidates: _omitted, ...legacyFineAssessment } = current.fine_assessment;
    const legacyPolicy = {
      ...current,
      fine_assessment: legacyFineAssessment
    } as RecallPolicy;

    expect(resolveFineAssessmentCandidateBudget(legacyPolicy)).toBe(
      current.coarse_filter.precomputed_rank.max_candidates +
      current.coarse_filter.semantic_supplement.max_supplement
    );
  });

  it("bounds explicit and derived budgets by the product candidate ceiling", () => {
    const current = buildDefaultPolicy({
      strategy: "analyze",
      taskSurfaceRef: createTaskSurface().runtime_id,
      now: () => "2026-07-14T00:00:00.000Z",
      generateRuntimeId: () => "33333333-3333-4333-8333-333333333333"
    });
    const explicit = {
      ...current,
      fine_assessment: {
        ...current.fine_assessment,
        max_candidates: RECALL_TOTAL_CANDIDATE_CAP + 1
      }
    } as RecallPolicy;
    const derived = {
      ...current,
      coarse_filter: {
        ...current.coarse_filter,
        precomputed_rank: {
          ...current.coarse_filter.precomputed_rank,
          max_candidates: RECALL_TOTAL_CANDIDATE_CAP
        }
      },
      fine_assessment: {
        ...current.fine_assessment,
        max_candidates: undefined
      }
    } as RecallPolicy;

    expect(resolveFineAssessmentCandidateBudget(explicit)).toBe(
      RECALL_TOTAL_CANDIDATE_CAP
    );
    expect(resolveFineAssessmentCandidateBudget(derived)).toBe(
      RECALL_TOTAL_CANDIDATE_CAP
    );
  });

  it("exposes fine_evaluated and fine_pruned_count after the coarse→fine waist", () => {
    const policy = buildDefaultPolicy({
      strategy: "analyze",
      taskSurfaceRef: createTaskSurface().runtime_id,
      now: () => "2026-07-14T00:00:00.000Z",
      generateRuntimeId: () => "33333333-3333-4333-8333-333333333333"
    });
    const hardBudget = policy.fine_assessment.max_candidates!;
    const candidates = Array.from({ length: hardBudget + 25 }, (_, index) =>
      coarseCandidate(`memory-${index}`, { structuralScore: (index + 1) / 1000 })
    );
    const preparation = prepareFineAssessment({
      candidates,
      policy,
      winnerMemoryIds: new Set(),
      supplementaryData: emptySupplementaryData(),
      tokenEstimator: { estimate: () => 4 },
      now: () => "2026-07-14T00:00:00.000Z",
      warn: () => undefined
    });

    expect(preparation.coarsePoolSize).toBe(hardBudget + 25);
    expect(preparation.fineEvaluated).toBe(hardBudget);
    expect(preparation.finePrunedCount).toBe(25);
    expect(preparation.candidates).toHaveLength(hardBudget);
  });

  it("uses an explicit policy hard budget and reports priority overflow", () => {
    const warn = vi.fn();
    const policy = buildDefaultPolicy({
      strategy: "analyze",
      taskSurfaceRef: createTaskSurface().runtime_id,
      now: () => "2026-07-14T00:00:00.000Z",
      generateRuntimeId: () => "33333333-3333-4333-8333-333333333333"
    });
    const candidates = Array.from({ length: 5 }, (_, index) =>
      coarseCandidate(`winner-${index}`, { admissionPlanes: ["protected_winner"] })
    );
    const preparation = prepareFineAssessment({
      candidates,
      policy: {
        ...policy,
        fine_assessment: { ...policy.fine_assessment, max_candidates: 3 }
      } as RecallPolicy,
      winnerMemoryIds: new Set(candidates.map((candidate) => candidate.entry.object_id)),
      supplementaryData: emptySupplementaryData(),
      tokenEstimator: { estimate: () => 4 },
      now: () => "2026-07-14T00:00:00.000Z",
      warn
    });

    expect(preparation.fineEvaluated).toBe(3);
    expect(preparation.finePrunedCount).toBe(2);
    expect(preparation.finePriorityOverflowCount).toBe(2);
    expect(warn).toHaveBeenCalledWith(
      "Fine-assessment priority candidates exceeded the hard evaluation budget.",
      expect.objectContaining({
        hard_budget: 3,
        priority_candidate_count: 5,
        priority_overflow_count: 2
      })
    );
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
    synthesisFtsRanks: Record<string, number>;
    evidenceFtsRanks: Record<string, number>;
    structuralScores: Record<string, number>;
  }> = {}
) {
  return {
    embeddingSimilarityScores: Object.freeze(overrides.embeddingSimilarityScores ?? {}),
    ftsRanks: Object.freeze(overrides.ftsRanks ?? {}),
    trigramFtsRanks: Object.freeze(overrides.trigramFtsRanks ?? {}),
    synthesisFtsRanks: Object.freeze(overrides.synthesisFtsRanks ?? {}),
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
