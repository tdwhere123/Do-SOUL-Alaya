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

function qualifiedDirectEvidence(
  objectId = "direct-evidence",
  fusedRank = 6,
  content = "I bought my new bookshelf from IKEA after comparing several stores."
): FineAssessmentCandidate {
  const evidence = createCandidate(
    objectId,
    {
      content,
      evidence_refs: [objectId]
    },
    "evidence_capsule"
  );
  return {
    ...evidence,
    fusion: {
      ...evidence.fusion,
      candidate_key: `workspace_local:evidence_capsule:${objectId}`,
      fused_rank: fusedRank,
      fused_score: 0.2,
      per_stream_rank: {
        ...evidence.fusion.per_stream_rank,
        evidence_fts: 25
      }
    }
  };
}

function select(
  candidates: readonly FineAssessmentCandidate[],
  maxEntries = 5,
  evidenceSemanticScoresByCandidateKey: ReadonlyMap<string, number> = new Map(),
  coverageRelevanceByCandidateKey?: ReadonlyMap<string, number>
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
    coverageRelevanceByCandidateKey,
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

  it("composes semantic-leader admission with qualified direct-evidence protection", () => {
    const peers = peerCandidates();
    const evidence = qualifiedDirectEvidence();
    const evidenceBaseline = select([...peers, evidence]);

    expect(evidenceBaseline.candidates.map((candidate) => candidate.object_id)).toEqual([
      "peer-1", "peer-2", "peer-3", "peer-4", "direct-evidence"
    ]);

    const result = select([...peers, evidence, semanticLeader()]);

    expect(result.candidates.map((candidate) => candidate.object_id)).toEqual([
      "semantic-memory-leader", "peer-1", "peer-2", "peer-3", "direct-evidence"
    ]);
  });

  it("keeps an admitted semantic evidence leader while admitting a distinct memory leader", () => {
    const evidence = withSemanticSignals(
      qualifiedDirectEvidence("semantic-evidence", 6, "opaque receipt zxq-8842"),
      1,
      0
    );
    const evidenceKey = "workspace_local:evidence_capsule:semantic-evidence";
    const memory = withSemanticSignals(semanticLeader(), 2, 0.98);
    const peers = peerCandidates();
    const coverageRelevance = new Map([
      [evidenceKey, 10],
      ...peers.map((candidate, index) => [
        candidate.fusion.candidate_key,
        5 - index
      ] as const),
      [memory.fusion.candidate_key, 0]
    ]);
    const result = select(
      [...peers, evidence, memory],
      5,
      new Map([[evidenceKey, 0.99]]),
      coverageRelevance
    );

    expect(result.candidates[0]?.object_id).toBe("semantic-memory-leader");
    expect(result.candidates.map((candidate) => candidate.object_id))
      .toContain("semantic-evidence");
  });

  it("does not let a non-delivered semantic evidence leader veto a memory leader", () => {
    const evidence = withSemanticSignals(
      qualifiedDirectEvidence("semantic-evidence", 6, "opaque receipt zxq-8842"),
      1,
      0
    );
    const evidenceKey = "workspace_local:evidence_capsule:semantic-evidence";
    const memory = withSemanticSignals(semanticLeader(), 2, 0.98);
    const result = select(
      [...peerCandidates(), evidence, memory],
      5,
      new Map([[evidenceKey, 0.99]])
    );

    expect(result.candidates[0]?.object_id).toBe("semantic-memory-leader");
  });

  it("does not replace a public top-four peer from the coverage-order tail", () => {
    const publicPeers = [1, 2, 3, 4, 5].map((rank) =>
      createRankedCandidate(`public-peer-${rank}`, rank, 1 - rank / 10)
    );
    const outside = createRankedCandidate("semantic-challenger", 6, 0.2);
    const coverageRelevance = new Map([
      [publicPeers[0]!.fusion.candidate_key, 1],
      [publicPeers[1]!.fusion.candidate_key, 6],
      [publicPeers[2]!.fusion.candidate_key, 5],
      [publicPeers[3]!.fusion.candidate_key, 4],
      [publicPeers[4]!.fusion.candidate_key, 3],
      [outside.fusion.candidate_key, 0]
    ]);
    const baseline = select(
      [...publicPeers, outside],
      5,
      new Map(),
      coverageRelevance
    );

    expect(baseline.diagnostics.find((row) => row.object_id === "public-peer-1"))
      .toMatchObject({ selection_order: 5, final_rank: 1 });
    expect(baseline.candidates.map((candidate) => candidate.object_id)).toEqual([
      "public-peer-1", "public-peer-2", "public-peer-3", "public-peer-4", "public-peer-5"
    ]);

    const challenger = withSemanticSignals(outside, Number.POSITIVE_INFINITY, 0.99);
    const result = select(
      [...publicPeers, challenger],
      5,
      new Map(),
      coverageRelevance
    );

    expect(result.candidates.map((candidate) => candidate.object_id))
      .toEqual([
        "semantic-challenger",
        "public-peer-1",
        "public-peer-2",
        "public-peer-3",
        "public-peer-4"
      ]);
    expect(result.diagnostics.find((row) => row.object_id === "public-peer-5"))
      .toMatchObject({ dropped_reason: "max_entries", final_rank: null });
  });

  it("fails the semantic refinement atomically when evidence misses the new boundary margin", () => {
    const peers = [...peerCandidates()];
    const evidence = qualifiedDirectEvidence("atomic-evidence");
    peers[3] = {
      ...peers[3]!,
      entry: { ...peers[3]!.entry, content: evidence.entry.content }
    };
    const evidenceOnly = select([...peers, evidence]);

    expect(evidenceOnly.candidates.map((candidate) => candidate.object_id)).toEqual([
      "peer-1", "peer-2", "peer-3", "peer-4", "atomic-evidence"
    ]);

    const result = select([...peers, evidence, semanticLeader()]);

    expect(result.candidates.map((candidate) => candidate.object_id)).toEqual(
      evidenceOnly.candidates.map((candidate) => candidate.object_id)
    );
  });

  it("keeps evidence ahead of an admitted semantic leader when composition is infeasible", () => {
    const peers = [1, 2, 3, 4].map((rank) =>
      createRankedCandidate(`admitted-peer-${rank}`, rank, 1 - rank / 10)
    );
    const evidence = qualifiedDirectEvidence("admitted-evidence", 6);
    peers[3] = {
      ...peers[3]!,
      entry: { ...peers[3]!.entry, content: evidence.entry.content }
    };
    const leaderBase = createRankedCandidate("admitted-semantic-leader", 5, 0.3);
    const leader = withSemanticSignals(
      {
        ...leaderBase,
        fusion: { ...leaderBase.fusion, fused_score: 0.3 }
      },
      1,
      0.99,
      1
    );

    const evidenceOnly = select([...peers, evidence], 6);
    expect(evidenceOnly.candidates.map((candidate) => candidate.object_id)).toEqual([
      "admitted-peer-1",
      "admitted-peer-2",
      "admitted-peer-3",
      "admitted-peer-4",
      "admitted-evidence"
    ]);

    const result = select([...peers, leader, evidence], 6);

    expect(result.diagnostics.find(
      (row) => row.object_id === "admitted-semantic-leader"
    )).toMatchObject({ selection_order: 5, dropped_reason: null });
    expect(result.diagnostics.find(
      (row) => row.object_id === "admitted-evidence"
    )).toMatchObject({ selection_order: 6, dropped_reason: null });
    expect(result.candidates.map((candidate) => candidate.object_id)).toEqual([
      ...evidenceOnly.candidates.map((candidate) => candidate.object_id),
      "admitted-semantic-leader"
    ]);
  });

  it("uses one explicit victim when the packet limit is below five", () => {
    const peers = [1, 2, 3].map((rank) =>
      createRankedCandidate(`compact-peer-${rank}`, rank, 1 - rank / 10)
    );
    const evidence = qualifiedDirectEvidence("compact-evidence", 4);
    const evidenceOnly = select([...peers, evidence], 3);

    expect(evidenceOnly.candidates.map((candidate) => candidate.object_id)).toEqual([
      "compact-peer-1", "compact-peer-2", "compact-evidence"
    ]);

    const challenger = withSemanticSignals(
      createRankedCandidate("compact-semantic-leader", 5, 0.2),
      Number.POSITIVE_INFINITY,
      0.99
    );
    const result = select([...peers, evidence, challenger], 3);

    expect(result.candidates.map((candidate) => candidate.object_id)).toEqual([
      "compact-semantic-leader", "compact-peer-1", "compact-evidence"
    ]);
    expect(result.diagnostics.find((row) => row.object_id === "compact-peer-2"))
      .toMatchObject({ dropped_reason: "max_entries", final_rank: null });
  });

  it("uses one public-tail victim when evidence protection overlaps the public prefix", () => {
    const evidenceBase = qualifiedDirectEvidence("prefix-evidence", 3);
    const evidence = {
      ...evidenceBase,
      fusion: { ...evidenceBase.fusion, fused_score: 0.7 }
    };
    const publicCandidates = [
      createRankedCandidate("prefix-peer-1", 1, 0.9),
      createRankedCandidate("prefix-peer-2", 2, 0.8),
      evidence,
      createRankedCandidate("prefix-peer-4", 4, 0.6),
      createRankedCandidate("prefix-peer-5", 5, 0.5)
    ];
    const challenger = withSemanticSignals(
      createRankedCandidate("prefix-semantic-leader", 6, 0.2),
      Number.POSITIVE_INFINITY,
      0.99
    );
    const baseline = select(publicCandidates);

    expect(baseline.candidates.map((candidate) => candidate.object_id)).toEqual([
      "prefix-peer-1",
      "prefix-peer-2",
      "prefix-evidence",
      "prefix-peer-4",
      "prefix-peer-5"
    ]);

    const result = select([...publicCandidates, challenger]);

    expect(result.candidates.map((candidate) => candidate.object_id)).toEqual([
      "prefix-semantic-leader",
      "prefix-peer-1",
      "prefix-peer-2",
      "prefix-evidence",
      "prefix-peer-4"
    ]);
    expect(result.diagnostics.find((row) => row.object_id === "prefix-peer-5"))
      .toMatchObject({ dropped_reason: "max_entries", final_rank: null });
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

  it("does not let evidence outside bounded discovery veto a memory semantic leader", () => {
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

    expect(result.candidates[0]?.object_id).toBe("semantic-memory-leader");
    expect(result.diagnostics.find(
      (row) => row.object_id === "semantic-memory-leader"
    )).toMatchObject({ dropped_reason: null, final_rank: 1 });
  });
});
