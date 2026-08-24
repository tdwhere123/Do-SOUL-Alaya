import { describe, expect, it } from "vitest";
import {
  orderByCoverageMarginalGain,
  resolveCoverageIdentity,
  type CoverageSelectionObjective
} from "../../recall/delivery/coverage-selection.js";
import {
  type FineAssessmentCandidate
} from "../../recall/delivery/fine-assessment-selection.js";
import {
  createCandidate,
  createSupplementaryData,
  relevanceMap
} from "./coverage-selection-test-support.js";

describe("coverage-aware delivery order", () => {
  it("orders a new-gist item ahead of a higher-rank duplicate-gist item", () => {
    const sharedGistFirst = createCandidate("dup-1", 0.99);
    const sharedGistSecond = createCandidate("dup-2", 0.98);
    const novel = createCandidate("novel", 0.5);
    const ordered = orderByCoverageMarginalGain({
      candidates: [sharedGistFirst, sharedGistSecond, novel],
      relevanceByCandidateKey: new Map([
        [sharedGistFirst.fusion.candidate_key, 0.99],
        [sharedGistSecond.fusion.candidate_key, 0.98],
        [novel.fusion.candidate_key, 0.5]
      ]),
      supplementaryData: createSupplementaryData({
        evidenceGistsByMemoryId: {
          "dup-1": "same-gist",
          "dup-2": "same-gist",
          novel: "fresh-gist"
        }
      })
    });

    expect(ordered.map((candidate) => candidate.entry.object_id)).toEqual([
      "dup-1",
      "novel",
      "dup-2"
    ]);
  });

  it("uses source-bound identity for direct evidence coverage", () => {
    const createEvidence = (objectId: string): FineAssessmentCandidate => ({
      ...createCandidate(objectId, 0.2),
      objectKind: "evidence_capsule",
      evidenceSourceIdentity: "sha256:source-turn",
      evidenceDocumentIdentity: "owner"
    });

    expect(resolveCoverageIdentity(
      createEvidence("materialized-a"),
      createSupplementaryData()
    )).toEqual(resolveCoverageIdentity(
      createEvidence("materialized-b"),
      createSupplementaryData()
    ));
  });

  it("observes the live marginal gain without changing coverage order", () => {
    const sharedGistFirst = createCandidate("dup-1", 0.99);
    const sharedGistSecond = createCandidate("dup-2", 0.98);
    const novel = createCandidate("novel", 0.5);
    const candidates = [sharedGistFirst, sharedGistSecond, novel];
    const relevanceByCandidateKey = relevanceMap(candidates);
    const supplementaryData = createSupplementaryData({
      evidenceGistsByMemoryId: {
        "dup-1": "same-gist",
        "dup-2": "same-gist",
        novel: "fresh-gist"
      }
    });
    const observations: Array<Readonly<{
      candidate_key: string;
      marginal_gain: number;
      selection_order: number;
    }>> = [];
    const withoutTrace = orderByCoverageMarginalGain({
      candidates,
      relevanceByCandidateKey,
      supplementaryData
    });
    const withTrace = orderByCoverageMarginalGain({
      candidates,
      relevanceByCandidateKey,
      supplementaryData,
      onSelection: (observation) => observations.push(observation)
    });

    expect(withTrace).toEqual(withoutTrace);
    expect(observations).toEqual([
      {
        candidate_key: sharedGistFirst.fusion.candidate_key,
        marginal_gain: 0.99,
        selection_order: 1
      },
      {
        candidate_key: novel.fusion.candidate_key,
        marginal_gain: 0.5,
        selection_order: 2
      },
      {
        candidate_key: sharedGistSecond.fusion.candidate_key,
        marginal_gain: 0.49,
        selection_order: 3
      }
    ]);
  });

  it("accepts a replaceable objective operator without adding a second selector", () => {
    const first = createCandidate("first", 0.99);
    const second = createCandidate("second", 0.98);
    const third = createCandidate("third", 0.5);
    const objective: CoverageSelectionObjective<
      FineAssessmentCandidate,
      { selected: number }
    > = Object.freeze({
      operator_id: "offline_reverse_relevance_v1",
      createState: () => ({ selected: 0 }),
      marginalGain: ({ relevance }) => 1 - relevance,
      accept: ({ state }) => { state.selected += 1; }
    });

    const ordered = orderByCoverageMarginalGain({
      candidates: [first, second, third],
      relevanceByCandidateKey: relevanceMap([first, second, third]),
      supplementaryData: createSupplementaryData(),
      objective
    });

    expect(ordered.map((candidate) => candidate.entry.object_id)).toEqual([
      "third",
      "second",
      "first"
    ]);
  });

});
