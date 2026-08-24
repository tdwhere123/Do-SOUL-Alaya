import { describe, expect, it } from "vitest";

import { selectFineAssessmentCandidates } from
  "../../../recall/delivery/fine-assessment-selection.js";
import {
  FIELD_PINS,
  createConfig,
  createRankedCandidate,
  createSupplementaryData,
  rankMap
} from "../fine-assessment-selection-fixtures.js";
import {
  productionParams,
  withEvidence
} from "./select-gamma-binding-cover-fixtures.js";

describe("Select_Gamma ranking-preserving gain", () => {
  it("admits fused-head when embedding inverts ranking with no cover increment", () => {
    const fusedHead = createRankedCandidate("fused-head", 1, 0.9);
    const waist = createRankedCandidate("waist-emb", 20, 0.25);
    const mid = [
      createRankedCandidate("distract-a", 2, 0.70),
      createRankedCandidate("distract-b", 3, 0.62),
      createRankedCandidate("distract-c", 4, 0.55)
    ] as const;
    // Extra occupiers so embedding can fill budget 5 before fused-head.
    const overflow = [5, 6, 7, 8].map((rank, index) =>
      createRankedCandidate(`overflow-${index}`, rank, 0.48 - index * 0.02)
    );
    const candidates = [fusedHead, ...mid, ...overflow, waist];
    const result = selectFineAssessmentCandidates({
      ...FIELD_PINS,
      orderedCandidates: candidates,
      config: {
        ...createConfig(),
        budgets: {
          ...createConfig().budgets,
          max_entries: 5,
          max_total_tokens: 1000
        }
      },
      supplementaryData: createSupplementaryData(),
      tokenEstimator: { estimate: () => 6 },
      rankByCandidateKey: rankMap(candidates),
      coverageRelevanceByCandidateKey: new Map([
        [fusedHead.fusion.candidate_key, 0.2],
        [waist.fusion.candidate_key, 0.99],
        [mid[0].fusion.candidate_key, 0.82],
        [mid[1].fusion.candidate_key, 0.80],
        [mid[2].fusion.candidate_key, 0.78],
        ...overflow.map((candidate, index) =>
          [candidate.fusion.candidate_key, 0.76 - index * 0.01] as const
        )
      ])
    });

    const delivered = result.candidates.map((candidate) => candidate.object_id);
    expect(delivered).toEqual([
      "fused-head",
      "distract-a",
      "distract-b",
      "distract-c",
      "overflow-0"
    ]);
    expect(delivered).not.toContain("waist-emb");
  });

  it("still admits a novel Values_v under ranking when cover increments", () => {
    const fusedHead = withEvidence(
      createRankedCandidate("fused-head-a", 1, 0.9),
      "ev-apple"
    );
    const novel = withEvidence(
      createRankedCandidate("novel-c", 6, 0.2),
      "ev-banana"
    );
    const sameValue = [0.8, 0.7, 0.6, 0.5].map((score, index) =>
      withEvidence(
        createRankedCandidate(`same-three-${index}`, index + 2, score),
        "ev-apple"
      )
    );
    const result = selectFineAssessmentCandidates(productionParams([
      fusedHead,
      ...sameValue,
      novel
    ]));
    expect(result.candidates.map((candidate) => candidate.object_id))
      .toEqual(expect.arrayContaining(["fused-head-a", "novel-c"]));
  });
});
