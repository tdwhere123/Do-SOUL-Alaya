import { describe, expect, it } from "vitest";
import { pruneCoarseCandidatesForFineAssessment } from
  "../../recall/delivery/fine-assessment-prune.js";
import { buildRecallCandidateDedupeKey } from
  "../../recall/runtime/recall-service-helpers.js";
import type { CoarseRecallCandidate } from
  "../../recall/runtime/recall-service-types.js";
import { createMemoryEntry } from "./recall-service-test-fixtures.js";

describe("fine-assessment pruned closure", () => {
  it("preserves the exact ordered coarse closure across survivors and pruned candidates", () => {
    const localShared = coarseCandidate("shared");
    const firstSurvivor = coarseCandidate("survivor-a", { structuralScore: 1 });
    const synthesisShared = coarseCandidate("shared", {
      objectKind: "synthesis_capsule"
    });
    const ordinary = coarseCandidate("ordinary");
    const secondSurvivor = coarseCandidate("survivor-b", { structuralScore: 0.9 });
    const globalShared = coarseCandidate("shared", { originPlane: "global" });
    const coarse = [
      localShared,
      firstSurvivor,
      synthesisShared,
      ordinary,
      secondSurvivor,
      globalShared
    ];

    const result = pruneCoarseCandidatesForFineAssessment({
      candidates: coarse,
      supplementaryData: emptySupplementaryScores(),
      winnerMemoryIds: new Set(),
      cap: 2
    });

    expect(result.survivors).toEqual([firstSurvivor, secondSurvivor]);
    expect(result.prunedCandidates).toEqual([
      localShared,
      synthesisShared,
      ordinary,
      globalShared
    ]);
    expect(result.prunedCandidates[0]).toBe(localShared);
    const survivorKeys = new Set(result.survivors.map(buildRecallCandidateDedupeKey));
    const prunedKeys = new Set(result.prunedCandidates.map(buildRecallCandidateDedupeKey));
    expect([...survivorKeys].some((key) => prunedKeys.has(key))).toBe(false);
    expect(new Set([...survivorKeys, ...prunedKeys])).toHaveLength(coarse.length);
    expect([...prunedKeys]).toEqual([
      "workspace_local:memory_entry:shared",
      "workspace_local:synthesis_capsule:shared",
      "workspace_local:memory_entry:ordinary",
      "global:memory_entry:shared"
    ]);
    expect(result.fineEvaluated + result.finePrunedCount).toBe(result.coarsePoolSize);
  });
});

function coarseCandidate(
  objectId: string,
  overrides: Partial<CoarseRecallCandidate> = {}
): Readonly<CoarseRecallCandidate> {
  return Object.freeze({
    entry: createMemoryEntry({
      object_id: objectId,
      content: `Recall content for ${objectId}.`
    }),
    admissionPlanes: Object.freeze(["activation" as const]),
    firstAdmissionPlane: "activation" as const,
    ...overrides
  });
}

function emptySupplementaryScores() {
  return {
    embeddingSimilarityScores: Object.freeze({}),
    ftsRanks: Object.freeze({}),
    trigramFtsRanks: Object.freeze({}),
    synthesisFtsRanks: Object.freeze({}),
    evidenceFtsRanks: Object.freeze({}),
    structuralScores: Object.freeze({})
  };
}
