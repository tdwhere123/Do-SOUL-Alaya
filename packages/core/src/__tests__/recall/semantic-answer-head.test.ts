import { describe, expect, it } from "vitest";
import {
  selectFineAssessmentCandidates,
  type FineAssessmentCandidate
} from "../../recall/delivery/fine-assessment-selection.js";
import { compileRecallQueryProbes } from "../../recall/query/recall-query-probes.js";
import {
  createCandidate,
  createConfig,
  createRankedCandidate,
  createSupplementaryData,
  rankMap
} from "./fine-assessment-selection-fixtures.js";

const QUERY = "Where did I buy my new bookshelf from?";

function withSemanticSignals(
  candidate: FineAssessmentCandidate,
  embeddingRank: number,
  embeddingSimilarity: number,
  lexicalRank: number | null = null
): FineAssessmentCandidate {
  return {
    ...candidate,
    effectiveFactors: {
      ...candidate.effectiveFactors,
      embedding_similarity: embeddingSimilarity
    },
    fusion: {
      ...candidate.fusion,
      per_stream_rank: {
        ...candidate.fusion.per_stream_rank,
        embedding_similarity: embeddingRank,
        lexical_fts: lexicalRank
      }
    }
  };
}

function peerCandidates(withLexicalEvidence = false): readonly FineAssessmentCandidate[] {
  return [1, 2, 3, 4, 5].map((rank) =>
    withSemanticSignals(
      createRankedCandidate(`peer-${rank}`, rank, 1 - rank / 10),
      rank + 1,
      0.4,
      withLexicalEvidence ? rank : null
    )
  );
}

function semanticLeader(): FineAssessmentCandidate {
  return withSemanticSignals(
    createRankedCandidate("semantic-memory-leader", 6, 0.2),
    1,
    0.99
  );
}

function select(
  candidates: readonly FineAssessmentCandidate[],
  maxEntries = 5,
  evidenceSemanticScoresByCandidateKey: ReadonlyMap<string, number> = new Map()
) {
  return selectFineAssessmentCandidates({
    orderedCandidates: candidates,
    config: {
      ...createConfig(),
      budgets: {
        ...createConfig().budgets,
        max_entries: maxEntries,
        max_total_tokens: 100
      }
    },
    supplementaryData: createSupplementaryData({
      queryProbes: compileRecallQueryProbes(QUERY),
      evidenceSemanticScoresByCandidateKey
    }),
    tokenEstimator: { estimate: () => 4 },
    rankByCandidateKey: rankMap(candidates),
    finalOrderAfterCoverage: "public_relevance"
  });
}

function expectLeaderFirst(result: ReturnType<typeof select>): void {
  expect(result.candidates.map((candidate) => candidate.object_id)).toEqual([
    "semantic-memory-leader",
    "peer-1",
    "peer-2",
    "peer-3",
    "peer-4"
  ]);
  expect(result.diagnostics.find(
    (row) => row.object_id === "semantic-memory-leader"
  )).toMatchObject({
    dropped_reason: null,
    final_rank: 1
  });
}

describe("semantic answer head", () => {
  it("keeps an admitted unique workspace-memory leader first after public ordering", () => {
    const result = select([...peerCandidates(), semanticLeader()]);

    expectLeaderFirst(result);
    expect(result.diagnostics.find((row) => row.object_id === "peer-5"))
      .toMatchObject({
        dropped_reason: "embedding_head_dominance",
        eviction_reason: "embedding_head_dominance"
      });
  });

  it("admits the leader when every baseline peer has direct query evidence", () => {
    const result = select([...peerCandidates(true), semanticLeader()]);

    expectLeaderFirst(result);
    expect(result.diagnostics.find((row) => row.object_id === "peer-5"))
      .toMatchObject({ dropped_reason: "max_entries" });
  });

  it("keeps the public order when embedding evidence is absent", () => {
    const result = select([
      ...peerCandidates(),
      createRankedCandidate("semantic-memory-candidate", 6, 0.2)
    ]);

    expect(result.candidates.map((candidate) => candidate.object_id)).toEqual([
      "peer-1", "peer-2", "peer-3", "peer-4", "peer-5"
    ]);
  });

  it("keeps the public order when the semantic lead is tied", () => {
    const peers = [...peerCandidates()];
    peers[0] = withSemanticSignals(peers[0]!, 1, 0.99);
    const tied = withSemanticSignals(
      createRankedCandidate("semantic-memory-candidate", 6, 0.2),
      1,
      0.99
    );

    const result = select([...peers, tied], 6);

    expect(result.candidates.map((candidate) => candidate.object_id)).toEqual([
      "peer-1", "peer-2", "peer-3", "peer-4", "peer-5",
      "semantic-memory-candidate"
    ]);
  });

  it("does not promote a memory behind an unqualified evidence leader", () => {
    const evidence = withSemanticSignals(
      createCandidate(
        "unqualified-evidence",
        { content: "unqualified", evidence_refs: ["unqualified-evidence"] },
        "evidence_capsule"
      ),
      1,
      0
    );
    const evidenceKey = "workspace_local:evidence_capsule:unqualified-evidence";
    const memory = withSemanticSignals(semanticLeader(), 2, 0.98);
    const result = select(
      [...peerCandidates(), evidence, memory],
      5,
      new Map([[evidenceKey, 0.99]])
    );

    expect(result.candidates[0]?.object_id).toBe("peer-1");
  });
});
