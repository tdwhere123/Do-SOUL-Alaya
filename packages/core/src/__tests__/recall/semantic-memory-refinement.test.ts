import { describe, expect, it } from "vitest";
import {
  selectSemanticMemoryRefinement,
  type AnswerHeadSelection
} from "../../recall/delivery/admission/semantic-memory-refinement.js";

type Candidate = Readonly<{
  readonly id: string;
  readonly fusion: Readonly<{ readonly fused_score: number }>;
}>;

function candidate(id: string, fusedScore: number): Candidate {
  return Object.freeze({
    id,
    fusion: Object.freeze({ fused_score: fusedScore })
  });
}

describe("semantic memory refinement", () => {
  it("exposes an atomically rejected leader to downstream planners", () => {
    const peer = candidate("peer", 0.8);
    const evidence = candidate("evidence", 0.7);
    const leader = candidate("semantic-leader", 0.2);
    const evidenceSelection: AnswerHeadSelection<Candidate> = Object.freeze({
      candidates: Object.freeze([peer, evidence, leader]),
      protections: Object.freeze([
        Object.freeze({ candidateKey: evidence.id, rankLimit: 2 })
      ]),
      rejectedCandidateKeys: Object.freeze([])
    });

    const result = selectSemanticMemoryRefinement({
      evidenceSelection,
      leader: Object.freeze({
        candidate: leader,
        candidateKey: leader.id,
        index: 2
      }),
      headLimit: 2,
      publicRelevanceByCandidateKey: new Map(),
      selectDelivered: (candidates) => candidates.slice(0, 2),
      keyOf: (item) => item.id,
      evidencePermitsVictim: () => true,
      protectionsAreFeasible: () => false,
      resolveSingleReplacement: () => evidence
    });

    expect(result.candidates).toBe(evidenceSelection.candidates);
    expect(result.protections).toBe(evidenceSelection.protections);
    expect(result.rejectedCandidateKeys).toEqual(["semantic-leader"]);
  });
});
