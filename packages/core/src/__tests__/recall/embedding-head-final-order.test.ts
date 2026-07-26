import { describe, expect, it } from "vitest";
import type { RecallFusionStream } from "../../recall/runtime/recall-service-types.js";
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
  createSupplementaryData
} from "./fine-assessment-selection-fixtures.js";

const QUERY = "Where did I buy my new bookshelf from?";
describe("embedding evidence dominance final order", () => {
  it("moves a unique semantic leader only across weaker query evidence", () => {
    const leader = memory("semantic-leader", 6, 0.1, {
      embedding_similarity: 1,
      lexical_fts: 5
    });
    const candidates = [...publicPeers(), leader];

    const result = select(candidates);

    expect(result.candidates.map((candidate) => candidate.object_id)).toEqual([
      "semantic-leader",
      "peer-1",
      "peer-2",
      "peer-3",
      "peer-4",
      "peer-5"
    ]);
    expect(result.candidates.map((candidate) => candidate.relevance_score)).toEqual([
      0.1,
      0.9,
      0.8,
      0.7,
      0.6,
      0.5
    ]);
  });

  it.each([
    {
      name: "embedding is absent",
      leaderRanks: { lexical_fts: 5 },
      peerOneRanks: {}
    },
    {
      name: "the semantic lead is tied",
      leaderRanks: { embedding_similarity: 1, lexical_fts: 5 },
      peerOneRanks: { embedding_similarity: 1 }
    },
    {
      name: "direct query support is absent",
      leaderRanks: { embedding_similarity: 1 },
      peerOneRanks: {}
    }
  ])("keeps the public packet unchanged when $name", ({ leaderRanks, peerOneRanks }) => {
    const peers = publicPeers();
    peers[0] = withStreamRanks(peers[0]!, peerOneRanks);
    const leader = memory("semantic-leader", 6, 0.1, leaderRanks);

    const result = select([...peers, leader]);

    expect(result.candidates.map((candidate) => candidate.object_id)).toEqual([
      "peer-1",
      "peer-2",
      "peer-3",
      "peer-4",
      "peer-5",
      "semantic-leader"
    ]);
  });

  it("stops behind a candidate with stronger direct query evidence", () => {
    const blocker = memory("query-leader", 3, 0.7, {
      lexical_fts: 4
    });
    const leader = memory("semantic-leader", 6, 0.1, {
      embedding_similarity: 1,
      lexical_fts: 5
    });

    const result = select([
      ...publicPeers().slice(0, 2),
      blocker,
      ...publicPeers().slice(3),
      leader
    ]);

    expect(result.candidates.map((candidate) => candidate.object_id)).toEqual([
      "peer-1",
      "peer-2",
      "query-leader",
      "semantic-leader",
      "peer-4",
      "peer-5"
    ]);
  });

  it("moves only when the same direct evidence stream is strictly stronger", () => {
    const blocker = memory("query-peer", 3, 0.7, {
      lexical_fts: 6
    });
    const leader = memory("semantic-leader", 6, 0.1, {
      embedding_similarity: 1,
      lexical_fts: 5
    });

    const result = select([
      ...publicPeers().slice(0, 2),
      blocker,
      ...publicPeers().slice(3),
      leader
    ]);

    expect(result.candidates.map((candidate) => candidate.object_id)).toEqual([
      "semantic-leader",
      "peer-1",
      "peer-2",
      "query-peer",
      "peer-4",
      "peer-5"
    ]);
  });

  it("uses an additional direct evidence stream as a strict improvement", () => {
    const blocker = memory("query-peer", 3, 0.7, {
      lexical_fts: 5
    });
    const leader = memory("semantic-leader", 6, 0.1, {
      embedding_similarity: 1,
      lexical_fts: 5,
      entity_seed: 1
    });

    const result = select([
      ...publicPeers().slice(0, 2),
      blocker,
      ...publicPeers().slice(3),
      leader
    ]);

    expect(result.candidates.map((candidate) => candidate.object_id)).toEqual([
      "semantic-leader",
      "peer-1",
      "peer-2",
      "query-peer",
      "peer-4",
      "peer-5"
    ]);
  });

  it("stops when every observed direct evidence stream ties", () => {
    const blocker = memory("query-peer", 3, 0.7, {
      lexical_fts: 5
    });
    const leader = memory("semantic-leader", 6, 0.1, {
      embedding_similarity: 1,
      lexical_fts: 5
    });

    const result = select([
      ...publicPeers().slice(0, 2),
      blocker,
      ...publicPeers().slice(3),
      leader
    ]);

    expect(result.candidates.map((candidate) => candidate.object_id)).toEqual([
      "peer-1",
      "peer-2",
      "query-peer",
      "semantic-leader",
      "peer-4",
      "peer-5"
    ]);
  });

  it.each(["facet_overlap", "entity_seed"] as const)(
    "does not compare lexical rank against %s rank",
    (stream) => {
      const blocker = memory("incomparable-peer", 3, 0.7, {
        [stream]: 6
      });
      const leader = memory("semantic-leader", 6, 0.1, {
        embedding_similarity: 1,
        lexical_fts: 5
      });

      const result = select([
        ...publicPeers().slice(0, 2),
        blocker,
        ...publicPeers().slice(3),
        leader
      ]);

      expect(result.candidates.map((candidate) => candidate.object_id)).toEqual([
        "peer-1",
        "peer-2",
        "incomparable-peer",
        "semantic-leader",
        "peer-4",
        "peer-5"
      ]);
    }
  );

  it("does not displace a behavior-eligible fifth candidate", () => {
    const behavior = memory("behavior", 5, 0.5, {}, {
      content: "I bought my new bookshelf from IKEA.",
      evidence_refs: ["evidence-behavior"]
    });
    const verifiedContext = projectVerifiedUserAssertionContext({
      evidenceRef: "evidence-behavior",
      entryContent: behavior.entry.content,
      gist: `User: ${behavior.entry.content}`
    });
    if (verifiedContext === null) throw new Error("fixture must produce verified behavior support");
    const leader = memory("semantic-leader", 6, 0.1, {
      embedding_similarity: 1,
      lexical_fts: 5
    });

    const result = select([...publicPeers().slice(0, 4), behavior, leader], {
      verifiedContexts: { behavior: verifiedContext },
      captureAnswerFeatures: true
    });

    expect(result.candidates.map((candidate) => candidate.object_id)).toEqual([
      "peer-1",
      "peer-2",
      "peer-3",
      "peer-4",
      "behavior",
      "semantic-leader"
    ]);
    expect(result.diagnostics.find((row) => row.object_id === "behavior")
      ?.answer_features?.answer_support?.authority?.behavior_eligible).toBe(true);
  });

  it("does not displace an already protected direct-evidence fifth candidate", () => {
    const evidence = directEvidence("protected-evidence", 5, 0.5);
    const leader = memory("semantic-leader", 6, 0.1, {
      embedding_similarity: 1,
      lexical_fts: 5
    });

    const result = select([...publicPeers().slice(0, 4), evidence, leader]);

    expect(result.candidates.map((candidate) => candidate.object_id)).toEqual([
      "peer-1",
      "peer-2",
      "peer-3",
      "peer-4",
      "protected-evidence",
      "semantic-leader"
    ]);
  });

  it("does not override delivery-rank final authority", () => {
    const leader = memory("semantic-leader", 6, 0.1, {
      embedding_similarity: 1,
      lexical_fts: 1
    });

    const result = select([...publicPeers(), leader], {
      finalOrder: "delivery_rank"
    });

    expect(result.candidates.map((candidate) => candidate.object_id)).toEqual([
      "peer-1",
      "peer-2",
      "peer-3",
      "peer-4",
      "peer-5",
      "semantic-leader"
    ]);
  });

  it.each([0, 1])(
    "does not override bounded final authority with max head drop %s",
    (maxHeadDropAfterCoverage) => {
      const leader = memory("semantic-leader", 6, 0.1, {
        embedding_similarity: 1,
        lexical_fts: 1
      });

      const result = select([...publicPeers(), leader], {
        maxHeadDropAfterCoverage
      });

      expect(result.candidates.map((candidate) => candidate.object_id)).toEqual([
        "peer-1",
        "peer-2",
        "peer-3",
        "peer-4",
        "peer-5",
        "semantic-leader"
      ]);
    }
  );
});

function publicPeers(): FineAssessmentCandidate[] {
  return [
    memory("peer-1", 1, 0.9),
    memory("peer-2", 2, 0.8),
    memory("peer-3", 3, 0.7),
    memory("peer-4", 4, 0.6),
    memory("peer-5", 5, 0.5)
  ];
}

function memory(
  objectId: string,
  fusedRank: number,
  fusedScore: number,
  streamRanks: Partial<Record<RecallFusionStream, number | null>> = {},
  entryOverrides: Partial<FineAssessmentCandidate["entry"]> = {}
): FineAssessmentCandidate {
  const candidate = createCandidate(objectId, entryOverrides);
  return withStreamRanks({
    ...candidate,
    effectiveScore: fusedScore,
    fusion: {
      ...candidate.fusion,
      fused_rank: fusedRank,
      fused_score: fusedScore
    }
  }, streamRanks);
}

function directEvidence(
  objectId: string,
  fusedRank: number,
  fusedScore: number
): FineAssessmentCandidate {
  const candidate = createCandidate(
    objectId,
    {
      content: "I bought my new bookshelf from IKEA after comparing several stores.",
      evidence_refs: [objectId]
    },
    "evidence_capsule"
  );
  return withStreamRanks({
    ...candidate,
    effectiveScore: fusedScore,
    fusion: {
      ...candidate.fusion,
      fused_rank: fusedRank,
      fused_score: fusedScore
    }
  }, { evidence_fts: 1 });
}

function withStreamRanks(
  candidate: FineAssessmentCandidate,
  streamRanks: Partial<Record<RecallFusionStream, number | null>>
): FineAssessmentCandidate {
  return {
    ...candidate,
    fusion: {
      ...candidate.fusion,
      per_stream_rank: {
        ...candidate.fusion.per_stream_rank,
        ...streamRanks
      }
    }
  };
}

function select(
  candidates: readonly FineAssessmentCandidate[],
  options: Readonly<{
    readonly verifiedContexts?: NonNullable<
      ReturnType<typeof createSupplementaryData>["verifiedUserAssertionContextsByMemoryId"]
    >;
    readonly captureAnswerFeatures?: boolean;
    readonly finalOrder?: "public_relevance" | "delivery_rank";
    readonly maxHeadDropAfterCoverage?: number;
  }> = {}
) {
  const relevanceByCandidateKey = new Map(
    candidates.map((candidate) => [candidate.fusion.candidate_key, candidate.fusion.fused_score])
  );
  return selectFineAssessmentCandidates({
    orderedCandidates: candidates,
    config: {
      ...createConfig(),
      budgets: {
        ...createConfig().budgets,
        max_entries: 6,
        max_total_tokens: 100
      }
    },
    supplementaryData: createSupplementaryData({
      queryProbes: compileRecallQueryProbes(QUERY),
      verifiedUserAssertionContextsByMemoryId: options.verifiedContexts
    }),
    tokenEstimator: { estimate: () => 4 },
    rankByCandidateKey: new Map(
      candidates.map((candidate) => [candidate.fusion.candidate_key, candidate.fusion.fused_rank])
    ),
    finalRelevanceByCandidateKey: relevanceByCandidateKey,
    coverageRelevanceByCandidateKey: relevanceByCandidateKey,
    finalOrderAfterCoverage: options.finalOrder ?? "public_relevance",
    maxHeadDropAfterCoverage: options.maxHeadDropAfterCoverage,
    captureAnswerFeatures: options.captureAnswerFeatures
  });
}
