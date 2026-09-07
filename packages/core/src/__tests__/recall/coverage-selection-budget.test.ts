import { describe, expect, it } from "vitest";
import {
  orderByCoverageMarginalGain,
  type CoverageMarginalObservation
} from "../../recall/delivery/coverage-selection.js";
import type { DeliverySelectionCandidate } from "../../recall/delivery/delivery-selection.js";
import {
  createCandidate,
  createSupplementaryData,
  legacyCoveragePass,
  relevanceMap
} from "./coverage-selection-test-support.js";

describe("coverage-aware delivery budget", () => {
  it("keeps coverage order and observations at a fixed point", () => {
    const rejected = createCandidate("rejected", 1);
    const sharedFirst = createCandidate("shared-first", 1);
    const sharedSecond = createCandidate("shared-second", 1);
    const novel = createCandidate("novel", 1);
    const candidates = [rejected, sharedFirst, sharedSecond, novel];
    const relevanceByCandidateKey = relevanceMap(candidates);
    const supplementaryData = createSupplementaryData({
      evidenceGistsByMemoryId: {
        rejected: "shared-gist",
        "shared-first": "shared-gist",
        "shared-second": "shared-gist",
        novel: "novel-gist"
      }
    });
    const runPass = (input: readonly DeliverySelectionCandidate[]) => {
      const observations: Array<Readonly<{
        candidate_key: string;
        marginal_gain: number;
        selection_order: number;
      }>> = [];
      const ordered = orderByCoverageMarginalGain({
        candidates: input,
        relevanceByCandidateKey,
        supplementaryData,
        advancesCoverage: (candidate) => candidate !== rejected,
        onSelection: (observation) => observations.push(observation)
      });
      return { ordered, observations };
    };

    const first = runPass(candidates);
    const second = runPass(first.ordered);

    expect(first.ordered.map((candidate) => candidate.entry.object_id)).toEqual([
      "rejected",
      "shared-first",
      "novel",
      "shared-second"
    ]);
    expect(second.ordered).toEqual(first.ordered);
    expect(second.observations).toEqual(first.observations);
  });

  it("resolves each candidate coverage identity only once per pass", () => {
    let objectIdReads = 0;
    const candidates = Array.from({ length: 200 }, (_, index) => {
      const objectId = `memory-${index}`;
      const candidate = createCandidate(objectId, 1 - index / 100);
      return {
        ...candidate,
        entry: {
          ...candidate.entry,
          get object_id() {
            objectIdReads += 1;
            return objectId;
          }
        }
      };
    });

    orderByCoverageMarginalGain({
      candidates,
      relevanceByCandidateKey: relevanceMap(candidates),
      supplementaryData: createSupplementaryData()
    });

    expect(objectIdReads).toBeLessThanOrEqual(candidates.length * 2);
  });

  it("matches the legacy pass across generated permutations and rejections", () => {
    for (let seed = 0; seed < 128; seed += 1) {
      const generated = Array.from({ length: 9 }, (_, index) =>
        createCandidate(`memory-${seed}-${index}`, ((index * 7 + seed) % 4 + 1) / 10)
      );
      const pivot = seed % generated.length;
      const candidates = [
        ...generated.slice(pivot),
        ...generated.slice(0, pivot)
      ];
      if (seed % 2 === 1) candidates.reverse();
      const supplementaryData = createSupplementaryData({
        evidenceGistsByMemoryId: Object.fromEntries(candidates.map((candidate, index) => [
          candidate.entry.object_id,
          `gist-${(index + seed) % 3}`
        ]))
      });
      const relevanceByCandidateKey = relevanceMap(candidates);
      const rejected = new Set(candidates
        .filter((_candidate, index) => (index + seed) % 5 === 0)
        .map((candidate) => candidate.fusion.candidate_key));
      const expected = legacyCoveragePass(
        candidates,
        relevanceByCandidateKey,
        supplementaryData,
        rejected
      );
      const observations: CoverageMarginalObservation[] = [];
      const actual = orderByCoverageMarginalGain({
        candidates,
        relevanceByCandidateKey,
        supplementaryData,
        advancesCoverage: (candidate) => !rejected.has(candidate.fusion.candidate_key),
        onSelection: (observation) => observations.push(observation)
      });

      expect(actual).toEqual(expected.ordered);
      expect(observations).toEqual(expected.observations);
    }
  });

});
