import { describe, expect, it } from "vitest";

import {
  selectFineAssessmentCandidates,
  type FineAssessmentCandidate,
  type FineAssessmentSelectionResult
} from "../../../recall/delivery/fine-assessment-selection.js";
import {
  FIELD_PINS,
  createConfig,
  createRankedCandidate,
  createSupplementaryData
} from "../fine-assessment-selection-fixtures.js";

describe("post-Select_Gamma order is final", () => {
  it("keeps delivery order as Gamma admission without post reorder or head-drop", () => {
    const plant = plantDivergentOrders();
    const result = selectFineAssessmentCandidates({
      ...FIELD_PINS,
      orderedCandidates: plant.candidates,
      config: createConfig(),
      supplementaryData: createSupplementaryData(),
      tokenEstimator: plant.tokenEstimator,
      rankByCandidateKey: plant.headDropRanks,
      coverageRelevanceByCandidateKey: plant.coverage
    });

    const delivered = result.candidates.map((candidate) => candidate.object_id);
    expect(delivered).toEqual(["coverage-head", "fused-head", "cheap-gamma"]);
    expect(delivered).toEqual(gammaAdmittedIds(result, plant.candidates));
    expect(orderBy(plant.candidates, (candidate) => candidate.fusion.fused_score))
      .not.toEqual(delivered);
    expect(orderBy(plant.candidates, (candidate) =>
      -(plant.headDropRanks.get(candidate.fusion.candidate_key) ?? 0)
    )).not.toEqual(delivered);
  });
});

function plantDivergentOrders() {
  const cheap = createRankedCandidate("cheap-gamma", 3, 0.3);
  const fusedHead = createRankedCandidate("fused-head", 1, 0.99);
  const coverageHead = createRankedCandidate("coverage-head", 2, 0.4);
  return Object.freeze({
    candidates: Object.freeze([fusedHead, coverageHead, cheap]),
    coverage: new Map([
      [cheap.fusion.candidate_key, 0.2],
      [fusedHead.fusion.candidate_key, 0.4],
      [coverageHead.fusion.candidate_key, 0.99]
    ]),
    headDropRanks: new Map([
      [fusedHead.fusion.candidate_key, 1],
      [coverageHead.fusion.candidate_key, 2],
      [cheap.fusion.candidate_key, 3]
    ]),
    tokenEstimator: {
      estimate: (content: string) => content.includes("cheap-gamma") ? 1 : 20
    }
  });
}

function gammaAdmittedIds(
  result: FineAssessmentSelectionResult,
  candidates: readonly FineAssessmentCandidate[]
): readonly string[] {
  const transition = result.orderSequence.transitions.find((entry) =>
    entry.owner === "select_gamma"
  );
  if (transition === undefined) throw new Error("select_gamma transition is missing");
  const objectIdByKey = new Map(candidates.map((candidate) => [
    candidate.fusion.candidate_key,
    candidate.entry.object_id
  ]));
  return transition.memberKeys.map((key) => {
    const objectId = objectIdByKey.get(key);
    if (objectId === undefined) throw new Error("select_gamma member is unknown");
    return objectId;
  });
}

function orderBy(
  candidates: readonly FineAssessmentCandidate[],
  scoreOf: (candidate: FineAssessmentCandidate) => number
): readonly string[] {
  return [...candidates]
    .sort((left, right) => scoreOf(right) - scoreOf(left))
    .map((candidate) => candidate.entry.object_id);
}
