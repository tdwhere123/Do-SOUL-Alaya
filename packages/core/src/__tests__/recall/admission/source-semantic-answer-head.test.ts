import { describe, expect, it } from "vitest";
import {
  resolveSourceSemanticRanks,
  sourceSemanticConsensusIsActive
} from "../../../recall/delivery/admission/answer-head/source-semantic-answer-head.js";
import { compileRecallQueryProbes } from
  "../../../recall/query/recall-query-probes.js";
import {
  compileRecallAnswerShapePlan,
  recallAnswerShapeSupportsSingleSemanticLeader
} from "../../../recall/query/recall-answer-shape-plan.js";
import { evidenceSemanticActivation } from
  "../fixtures/evidence-semantic-activation.js";
import { createCandidate } from "../fine-assessment-selection-fixtures.js";

describe("source semantic answer-head", () => {
  it("combines entry and source-gist ranks from complete source receipts", () => {
    const entryFirst = withEntryScore(createCandidate("entry-first"), 0.9);
    const balanced = withEntryScore(createCandidate("balanced"), 0.8);
    const middle = withEntryScore(createCandidate("middle"), 0.7);
    const gistFirst = withEntryScore(createCandidate("gist-first"), 0.1);
    const activations = new Map([
      [entryFirst.fusion.candidate_key, gistActivation(0.1)],
      [balanced.fusion.candidate_key, gistActivation(0.8)],
      [middle.fusion.candidate_key, gistActivation(0.7)],
      [gistFirst.fusion.candidate_key, gistActivation(0.9)]
    ]);

    const ranks = resolveSourceSemanticRanks(
      [entryFirst, balanced, middle, gistFirst], activations, candidateKey
    );

    expect([...ranks.entries()].sort((left, right) => left[1] - right[1]))
      .toEqual([
        [balanced.fusion.candidate_key, 1],
        [entryFirst.fusion.candidate_key, 2],
        [gistFirst.fusion.candidate_key, 3],
        [middle.fusion.candidate_key, 4]
      ]);
  });

  it.each([
    "How many different cities did I visit?",
    "How much total money did I spend?",
    "How many dogs do I own?"
  ])("fails closed for aggregate answer shape: %s", (query) => {
    const activations = new Map([["candidate", gistActivation(0.9)]]);

    expect(sourceSemanticConsensusIsActive(
      recallAnswerShapeSupportsSingleSemanticLeader(
        compileRecallAnswerShapePlan(compileRecallQueryProbes(query))
      ),
      activations
    )).toBe(false);
  });

  it("requires complete owner-gist observations", () => {
    const activation = {
      ...gistActivation(0.9),
      observation_completeness: "winner_only_legacy" as const
    };
    expect(sourceSemanticConsensusIsActive(
      true,
      new Map([["candidate", activation]])
    )).toBe(false);
  });
});

function gistActivation(score: number) {
  return evidenceSemanticActivation(score, {
    documentIdentity: "owner_gist_600"
  });
}

function candidateKey(candidate: ReturnType<typeof createCandidate>): string {
  return candidate.fusion.candidate_key;
}

function withEntryScore(candidate: ReturnType<typeof createCandidate>, score: number) {
  return {
    ...candidate,
    effectiveFactors: { ...candidate.effectiveFactors, embedding_similarity: score }
  };
}
