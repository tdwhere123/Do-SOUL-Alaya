import { describe, expect, it, vi } from "vitest";
import {
  selectFineAssessmentCandidates,
  type FineAssessmentCandidate
} from "../../recall/delivery/fine-assessment-selection.js";
import { compileRecallQueryProbes } from "../../recall/query/recall-query-probes.js";
import {
  projectVerifiedUserAssertionContext
} from "../../recall/query/recall-user-assertion-context.js";
import {
  createCandidate,
  createConfig,
  createSupplementaryData,
  rankMap
} from "./fine-assessment-selection-fixtures.js";

const QUERY = "Where did I buy my new bookshelf from?";

describe("verified answer fifth slot", () => {
  it("moves one verified answer from slots 6-10 into slot 5 with capture parity", () => {
    const candidates = buildPacket(["verified"]);
    const select = (captureAnswerFeatures: boolean) => runSelection(
      candidates,
      verifiedContexts(candidates),
      "public_relevance",
      captureAnswerFeatures
    );

    const withoutCapture = select(false);
    const withCapture = select(true);

    expect(withoutCapture.candidates.map((candidate) => candidate.object_id)).toEqual([
      "filler-1", "filler-2", "filler-3", "filler-4", "verified", "filler-5", "tail"
    ]);
    expect(withCapture.candidates).toEqual(withoutCapture.candidates);
    expect(withCapture.diagnostics.find((row) => row.object_id === "verified"))
      .toMatchObject({
        final_rank: 5,
        answer_features: {
          answer_support: {
            authority: { behavior_eligible: true }
          }
        }
      });
  });

  it("keeps the verified fifth-slot contract when coverage owns packet order", () => {
    const candidates = buildPacket(["verified"]);
    const result = runSelection(
      candidates,
      verifiedContexts(candidates),
      "coverage",
      false
    );

    expect(result.candidates.map((candidate) => candidate.object_id)).toEqual([
      "filler-1", "filler-2", "filler-3", "filler-4", "verified", "filler-5", "tail"
    ]);
  });

  it("keeps public order when multiple tail candidates are eligible", () => {
    const candidates = buildPacket(["verified", "also-verified"]);
    const result = runSelection(
      candidates,
      verifiedContexts(candidates),
      "public_relevance",
      false
    );

    expect(result.candidates.map((candidate) => candidate.object_id)).toEqual(
      candidates.map((candidate) => candidate.entry.object_id)
    );
  });

  it("keeps public order when the top five already contain a verified answer", () => {
    const candidates = buildPacket(["verified"], 3);
    const baseline = runSelection(candidates, {}, "public_relevance", false);
    const result = runSelection(
      candidates,
      verifiedContexts(candidates),
      "public_relevance",
      false
    );

    expect(baseline.candidates[3]?.object_id).toBe("verified");
    expect(result.candidates).toEqual(baseline.candidates);
  });

  it("keeps answer-support membership independent of verified provenance", () => {
    const candidates = buildPacket(["verified"], 10);
    const withoutContext = runSelection(
      candidates,
      {},
      "public_relevance",
      false
    );
    const withContext = runSelection(
      candidates,
      verifiedContexts(candidates),
      "public_relevance",
      false
    );

    const ids = (result: typeof withContext) =>
      new Set(result.candidates.map((candidate) => candidate.object_id));
    expect(ids(withoutContext)).toEqual(ids(withContext));
    expect(ids(withContext).has("verified")).toBe(true);
  });

  it("does not override delivery-rank final authority", () => {
    const candidates = buildPacket(["verified"]);
    const result = runSelection(
      candidates,
      verifiedContexts(candidates),
      "delivery_rank",
      false
    );

    expect(result.candidates.map((candidate) => candidate.object_id)).toEqual(
      candidates.map((candidate) => candidate.entry.object_id)
    );
  });
});

function runSelection(
  candidates: readonly FineAssessmentCandidate[],
  contexts: NonNullable<
    ReturnType<typeof createSupplementaryData>["verifiedUserAssertionContextsByMemoryId"]
  >,
  finalOrderAfterCoverage: "coverage" | "public_relevance" | "delivery_rank",
  captureAnswerFeatures: boolean
) {
  return selectFineAssessmentCandidates({
    orderedCandidates: candidates,
    config: createConfig(),
    supplementaryData: createSupplementaryData({
      queryProbes: compileRecallQueryProbes(QUERY),
      verifiedUserAssertionContextsByMemoryId: contexts
    }),
    tokenEstimator: { estimate: vi.fn(() => 1) },
    rankByCandidateKey: rankMap(candidates),
    finalOrderAfterCoverage,
    captureAnswerFeatures
  });
}

function buildPacket(
  answerIds: readonly string[],
  fillerCount = 5
): readonly FineAssessmentCandidate[] {
  const ids = [
    ...Array.from({ length: fillerCount }, (_, index) => `filler-${index + 1}`),
    ...answerIds,
    "tail"
  ];
  return ids.map((id, index) => {
    const answer = answerIds.includes(id);
        const candidate = createCandidate(id, answer
      ? {
          content: "I bought the new bookshelf from IKEA.",
          evidence_refs: [`evidence-${id}`]
        }
      : {});
    return {
      ...candidate,
      fusion: {
        ...candidate.fusion,
        fused_rank: index + 1,
        fused_score: 1 - index * 0.05
      }
    };
  });
}

function verifiedContexts(candidates: readonly FineAssessmentCandidate[]) {
  return Object.freeze(Object.fromEntries(candidates.flatMap((candidate) => {
    if (candidate.entry.evidence_refs.length === 0) return [];
    const evidenceRef = candidate.entry.evidence_refs[0]!;
    const context = projectVerifiedUserAssertionContext({
      evidenceRef,
      entryContent: candidate.entry.content,
      gist: `User: ${candidate.entry.content}`
    });
    if (context === null) throw new Error("test fixture must project a User assertion");
    return [[candidate.entry.object_id, context] as const];
  })));
}
