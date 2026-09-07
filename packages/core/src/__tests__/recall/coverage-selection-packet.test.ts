import { describe, expect, it } from "vitest";
import {
  orderByCoverageMarginalGain
} from "../../recall/delivery/coverage-selection.js";
import {
  createCandidate,
  createSupplementaryData
} from "./coverage-selection-test-support.js";

describe("coverage-aware delivery packet", () => {
  it("does not treat distinct facts from one source session as duplicates", () => {
    const anchor = createCandidate("cohort-anchor", 0.9);
    const sameCohort = createCandidate("same-cohort", 0.8);
    const otherCohort = createCandidate("other-cohort", 0.5);
    const ordered = orderByCoverageMarginalGain({
      candidates: [anchor, sameCohort, otherCohort],
      relevanceByCandidateKey: new Map([
        [anchor.fusion.candidate_key, 0.9],
        [sameCohort.fusion.candidate_key, 0.8],
        [otherCohort.fusion.candidate_key, 0.5]
      ]),
      supplementaryData: createSupplementaryData({
        evidenceGistsByMemoryId: {
          "cohort-anchor": "gist-a",
          "same-cohort": "gist-b",
          "other-cohort": "gist-c"
        },
        sourceCohortKeys: {
          "cohort-anchor": "cohort-1",
          "same-cohort": "cohort-1",
          "other-cohort": "cohort-2"
        }
      })
    });
    expect(ordered.map((candidate) => candidate.entry.object_id)).toEqual([
      "cohort-anchor",
      "same-cohort",
      "other-cohort"
    ]);
  });

});
