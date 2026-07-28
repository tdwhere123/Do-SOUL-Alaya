import { describe, expect, it, vi } from "vitest";
import { selectFineAssessmentCandidates } from
  "../../recall/delivery/fine-assessment-selection.js";
import { compileRecallQueryProbes } from
  "../../recall/query/recall-query-probes.js";
import {
  createCandidate,
  createConfig,
  createSupplementaryData,
  rankMap
} from "./fine-assessment-selection-fixtures.js";

describe("semantic-head consensus invariant", () => {
  it("does not revive a semantic-head rejection during later selection", () => {
    const incumbentContent =
      "I waited over a year for the decision on my asylum application.";
    const evidenceBase = createCandidate("protected-evidence", {
      content: incumbentContent,
      evidence_refs: ["evidence-protected"]
    }, "evidence_capsule");
    const protectedEvidence = ranked({
      ...evidenceBase,
      fusion: {
        ...evidenceBase.fusion,
        candidate_key: "workspace_local:evidence_capsule:protected-evidence",
        per_stream_rank: {
          ...evidenceBase.fusion.per_stream_rank,
          evidence_fts: 1
        }
      }
    }, 1, 1);
    const ordinary = ranked(createCandidate("ordinary", {
      content: incumbentContent
    }), 2, 0.9);
    const rejectedSupport = withEmbeddingSimilarity(ranked(
      createCandidate("rejected-support", {
        content: "I waited six months for the decision on my asylum application.",
        evidence_refs: ["evidence-support"]
      }),
      3,
      0.8
    ), 0.99);
    const candidates = [protectedEvidence, ordinary, rejectedSupport];

    const result = runSelection(candidates);

    expect(result.candidates.map((candidate) => candidate.object_id))
      .toEqual(["protected-evidence", "ordinary"]);
  });

  it("retains semantic answer support that was already admitted", () => {
    const baselineSupport = withEmbeddingSimilarity(ranked(
      createCandidate("baseline-support", {
        content: "Six months passed before the reply.",
        evidence_refs: ["evidence-support"]
      }),
      2,
      0.9
    ), 0.99);
    const candidates = [
      ranked(createCandidate("ordinary"), 1, 1),
      baselineSupport,
      ranked(createCandidate("tail"), 3, 0.8)
    ];

    const result = runSelection(candidates);

    expect(result.candidates.map((candidate) => candidate.object_id))
      .toContain("baseline-support");
  });
});

function runSelection(
  candidates: Parameters<typeof selectFineAssessmentCandidates>[0]["orderedCandidates"]
) {
  return selectFineAssessmentCandidates({
    orderedCandidates: candidates,
    config: {
      ...createConfig(),
      budgets: { ...createConfig().budgets, max_entries: 2 }
    },
    supplementaryData: createSupplementaryData({
      queryProbes: compileRecallQueryProbes(
        "How long did I wait for the decision on my asylum application?"
      )
    }),
    tokenEstimator: { estimate: vi.fn(() => 6) },
    rankByCandidateKey: rankMap(candidates)
  });
}

function ranked(
  candidate: ReturnType<typeof createCandidate>,
  fusedRank: number,
  fusedScore: number
) {
  return {
    ...candidate,
    fusion: { ...candidate.fusion, fused_rank: fusedRank, fused_score: fusedScore }
  };
}

function withEmbeddingSimilarity(
  candidate: ReturnType<typeof ranked>,
  embeddingSimilarity: number
) {
  return {
    ...candidate,
    effectiveFactors: {
      ...candidate.effectiveFactors,
      embedding_similarity: embeddingSimilarity
    }
  };
}
