import { describe, expect, it, vi } from "vitest";
import { selectFineAssessmentCandidates } from
  "../../../recall/delivery/fine-assessment-selection.js";
import { compileRecallQueryProbes } from
  "../../../recall/query/recall-query-probes.js";
import { projectVerifiedUserAssertionContext } from
  "../../../recall/query/recall-user-assertion-context.js";
import {
  createCandidate,
  createConfig,
  createSupplementaryData,
  rankMap
} from "../fine-assessment-selection-fixtures.js";

describe("answer-support packet membership", () => {
  it("admits eligible scalar support without displacing a baseline behavior guard", () => {
    const ranked = (
      candidate: ReturnType<typeof createCandidate>,
      fusedRank: number,
      fusedScore: number
    ) => ({
      ...candidate,
      fusion: { ...candidate.fusion, fused_rank: fusedRank, fused_score: fusedScore }
    });
    const behaviorContent = "Over a year of uncertainty was really tough.";
    const behavior = ranked(createCandidate("behavior", {
      content: behaviorContent,
      evidence_refs: ["evidence-behavior"]
    }), 1, 1);
    const ordinary = ranked(createCandidate("ordinary", {
      content: "I checked the mailbox every morning.",
      evidence_refs: ["evidence-ordinary"]
    }), 2, 0.9);
    const valueOnly = ranked(createCandidate("value-only", {
      content: "Six months passed before the reply.",
      evidence_refs: ["evidence-value"]
    }), 3, 0.8);
    const ineligible = ranked(createCandidate("ineligible", {
      content: "Five weeks passed before the reply.",
      evidence_refs: []
    }), 4, 0.7);
    const candidates = [behavior, ordinary, valueOnly, ineligible];
    const verified = projectVerifiedUserAssertionContext({
      evidenceRef: "evidence-behavior",
      entryContent: behaviorContent,
      gist: `User: Speaking of waiting, my asylum application was finally approved. ${behaviorContent}`
    });
    if (verified === null) throw new Error("test fixture must project");
    const select = (
      captureAnswerFeatures: boolean,
      tokenEstimator = { estimate: vi.fn(() => 6) }
    ) => selectFineAssessmentCandidates({
      orderedCandidates: candidates,
      config: {
        ...createConfig(),
        budgets: { ...createConfig().budgets, max_entries: 2 }
      },
      supplementaryData: createSupplementaryData({
        queryProbes: compileRecallQueryProbes(
          "How long did I wait for the decision on my asylum application?"
        ),
        verifiedUserAssertionContextsByMemoryId: { behavior: verified }
      }),
      tokenEstimator,
      rankByCandidateKey: rankMap(candidates),
      coverageRelevanceByCandidateKey: new Map(candidates.map((candidate) => [
        candidate.fusion.candidate_key,
        candidate.fusion.fused_score
      ])),
      captureAnswerFeatures
    });

    const withoutCapture = select(false);
    const withCapture = select(true);
    const ids = (result: typeof withCapture) =>
      result.candidates.map((candidate) => candidate.object_id);
    const diagnostics = new Map(
      withCapture.diagnostics.map((row) => [row.object_id, row])
    );

    expect(ids(withoutCapture)).toEqual(["behavior", "value-only"]);
    expect(ids(withCapture)).toEqual(ids(withoutCapture));
    expect(diagnostics.get("behavior")?.answer_features?.answer_support)
      .toMatchObject({ status: "value_only", authority: { behavior_eligible: true } });
    expect(diagnostics.get("value-only")?.answer_features?.answer_support)
      .toMatchObject({ status: "value_only", eligible: true });
    expect(diagnostics.get("ordinary")?.answer_features?.answer_support)
      .toMatchObject({ status: "unsupported" });
    expect(diagnostics.get("ineligible")?.answer_features?.answer_support)
      .toMatchObject({ status: "ineligible", eligible: false });

    const tokenBound = select(false, {
      estimate: vi.fn((content: string) => content === valueOnly.entry.content ? 101 : 6)
    });
    expect(ids(tokenBound)).toEqual(["behavior", "ordinary"]);
  });

  it("does not promote aggregate observations into packet membership", () => {
    const candidates = ["first", "second", "third"].map((objectId, index) => {
      const candidate = createCandidate(objectId, {
        content: `I paid $${index + 1} for item ${index + 1}.`,
        evidence_refs: [`evidence-${index + 1}`]
      });
      return {
        ...candidate,
        fusion: {
          ...candidate.fusion,
          fused_rank: index + 1,
          fused_score: 1 - index / 10
        }
      };
    });
    const result = selectFineAssessmentCandidates({
      orderedCandidates: candidates,
      config: {
        ...createConfig(),
        budgets: { ...createConfig().budgets, max_entries: 2 }
      },
      supplementaryData: createSupplementaryData({
        queryProbes: compileRecallQueryProbes(
          "How much total money have I spent on these items?"
        )
      }),
      tokenEstimator: { estimate: vi.fn(() => 6) },
      rankByCandidateKey: rankMap(candidates),
      captureAnswerFeatures: true
    });

    expect(result.candidates.map((candidate) => candidate.object_id))
      .toEqual(["first", "second"]);
    expect(result.diagnostics.map((row) =>
      row.answer_features?.answer_support?.status
    )).toEqual(["observation_only", "observation_only", "observation_only"]);
  });
});
