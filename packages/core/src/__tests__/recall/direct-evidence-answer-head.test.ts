import { describe, expect, it, vi } from "vitest";
import { MemoryDimension } from "@do-soul/alaya-protocol";
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
  createRankedCandidate,
  createSupplementaryData,
  rankMap
} from "./fine-assessment-selection-fixtures.js";

const QUERY = "Where did I buy my new bookshelf from?";
const STRONG_EVIDENCE = "I bought my new bookshelf from IKEA after comparing several stores.";

function directEvidence(
  objectId: string,
  content: string,
  fusedRank: number,
  fusedScore: number,
  evidenceFtsRank = 25
): FineAssessmentCandidate {
  const candidate = createCandidate(
    objectId,
    { content, domain_tags: [], evidence_refs: [objectId] },
    "evidence_capsule"
  );
  return {
    ...candidate,
    fusion: {
      ...candidate.fusion,
      candidate_key: `workspace_local:evidence_capsule:${objectId}`,
      fused_rank: fusedRank,
      fused_score: fusedScore,
      per_stream_rank: {
        ...candidate.fusion.per_stream_rank,
        evidence_fts: evidenceFtsRank
      }
    }
  };
}

function peerCandidates(): readonly FineAssessmentCandidate[] {
  return [
    createRankedCandidate("peer-1", 1, 0.9),
    createRankedCandidate("peer-2", 2, 0.8),
    createRankedCandidate("peer-3", 3, 0.7),
    createRankedCandidate("peer-4", 4, 0.6),
    createRankedCandidate("peer-5", 5, 0.5)
  ];
}

function withEmbeddingScore(
  candidate: FineAssessmentCandidate,
  embeddingSimilarity: number
): FineAssessmentCandidate {
  return {
    ...candidate,
    effectiveFactors: {
      ...candidate.effectiveFactors,
      embedding_similarity: embeddingSimilarity
    }
  };
}

function select(
  candidates: readonly FineAssessmentCandidate[],
  options: Readonly<{
    readonly query?: string | null;
    readonly maxEntries?: number;
    readonly maxTotalTokens?: number;
    readonly estimate?: (content: string) => number;
    readonly coverageRelevanceByCandidateKey?: ReadonlyMap<string, number>;
    readonly perDimensionLimits?: Readonly<{ readonly procedure: number }>;
    readonly verifiedContexts?: NonNullable<
      ReturnType<typeof createSupplementaryData>["verifiedUserAssertionContextsByMemoryId"]
    >;
    readonly evidenceSemanticScoresByCandidateKey?: ReadonlyMap<string, number>;
    readonly captureAnswerFeatures?: boolean;
  }> = {}
) {
  return selectFineAssessmentCandidates({
    orderedCandidates: candidates,
    config: {
      ...createConfig(),
      budgets: {
        ...createConfig().budgets,
        max_entries: options.maxEntries ?? 5,
        max_total_tokens: options.maxTotalTokens ?? 100,
        per_dimension_limits: options.perDimensionLimits ?? null
      }
    },
    supplementaryData: createSupplementaryData({
      queryProbes: compileRecallQueryProbes(options.query === undefined ? QUERY : options.query),
      verifiedUserAssertionContextsByMemoryId: options.verifiedContexts,
      evidenceSemanticScoresByCandidateKey:
        options.evidenceSemanticScoresByCandidateKey ?? new Map()
    }),
    tokenEstimator: { estimate: vi.fn(options.estimate ?? (() => 4)) },
    rankByCandidateKey: rankMap(candidates),
    coverageRelevanceByCandidateKey: options.coverageRelevanceByCandidateKey,
    finalOrderAfterCoverage: "public_relevance",
    captureAnswerFeatures: options.captureAnswerFeatures
  });
}

describe("bounded direct-evidence answer head", () => {
  it("admits one strong capsule that coverage would leave outside the packet", () => {
    const peers = peerCandidates();
    const strongest = directEvidence("evidence-strong", STRONG_EVIDENCE, 6, 0.2);
    const second = directEvidence(
      "evidence-second",
      "I bought the bookshelf after a trip to the furniture district.",
      7,
      0.19
    );

    const result = select([...peers, strongest, second]);

    expect(result.candidates.map((candidate) => candidate.object_id)).toEqual([
      "peer-1",
      "peer-2",
      "peer-3",
      "peer-4",
      "evidence-strong"
    ]);
    expect(result.diagnostics.find((row) => row.object_id === "evidence-strong"))
      .toMatchObject({
        candidate_key: "workspace_local:evidence_capsule:evidence-strong",
        dropped_reason: null,
        final_rank: 5
      });
    expect(result.diagnostics.find((row) => row.object_id === "peer-5")?.dropped_reason)
      .toBe("max_entries");
  });

  it("keeps the admitted evidence slot in the public top five", () => {
    const peers = peerCandidates();
    const evidence = directEvidence("evidence", STRONG_EVIDENCE, 6, 0.2);

    const result = select([...peers, evidence], { maxEntries: 6 });

    expect(result.candidates.map((candidate) => candidate.object_id)).toEqual([
      "peer-1",
      "peer-2",
      "peer-3",
      "peer-4",
      "evidence",
      "peer-5"
    ]);
    expect(result.candidates[4]).toMatchObject({
      object_id: "evidence",
      object_kind: "evidence_capsule",
      relevance_score: 0.2,
      token_estimate: 4,
      budget_state: {
        within_budget: true,
        remaining_entries: 1,
        remaining_tokens: 80
      }
    });
  });

  it("uses one semantic-leading capsule for one protected head admission", () => {
    const peers = peerCandidates().map((candidate) => withEmbeddingScore(candidate, 0.4));
    peers[4] = {
      ...peers[4]!,
      entry: { ...peers[4]!.entry, content: STRONG_EVIDENCE }
    };
    const evidence = directEvidence("semantic-head", STRONG_EVIDENCE, 6, 0.2);
    const result = select([...peers, evidence], {
      evidenceSemanticScoresByCandidateKey: new Map([[evidence.fusion.candidate_key, 0.99]])
    });

    expect(result.candidates.map((candidate) => candidate.object_id)).toEqual([
      "semantic-head",
      "peer-1",
      "peer-2",
      "peer-3",
      "peer-4"
    ]);
    expect(result.candidates[0]).toMatchObject({
      object_id: "semantic-head",
      relevance_score: 0.2
    });
  });

  it.each([
    {
      name: "has no semantic score",
      evidenceSemanticScore: undefined,
      memoryLeaderScore: 0.4
    },
    {
      name: "ties the memory semantic leader",
      evidenceSemanticScore: 0.91,
      memoryLeaderScore: 0.91
    },
    {
      name: "trails the memory semantic leader",
      evidenceSemanticScore: 0.9,
      memoryLeaderScore: 0.91
    }
  ])("keeps the lexical path for a capsule that $name", ({
    evidenceSemanticScore,
    memoryLeaderScore
  }) => {
    const peers = peerCandidates().map((candidate, index) => withEmbeddingScore(
      candidate,
      index === 0 ? memoryLeaderScore : 0.4
    ));
    peers[4] = {
      ...peers[4]!,
      entry: { ...peers[4]!.entry, content: STRONG_EVIDENCE }
    };
    const evidence = directEvidence("semantic-fallback", STRONG_EVIDENCE, 6, 0.2);
    const semanticScores = evidenceSemanticScore === undefined
      ? new Map<string, number>()
      : new Map([[evidence.fusion.candidate_key, evidenceSemanticScore]]);

    const result = select([...peers, evidence], {
      evidenceSemanticScoresByCandidateKey: semanticScores
    });

    expect(result.candidates.map((candidate) => candidate.object_id)).toEqual([
      "peer-1",
      "peer-2",
      "peer-3",
      "peer-4",
      "peer-5"
    ]);
  });

  it("does not restore a coverage-head capsule over an equally strong public fifth", () => {
    const peers = [...peerCandidates()];
    peers[4] = {
      ...peers[4]!,
      entry: { ...peers[4]!.entry, content: STRONG_EVIDENCE }
    };
    const evidence = directEvidence("coverage-head", STRONG_EVIDENCE, 6, 0.2);
    const candidates = [...peers, evidence];
    const coverageRelevance = new Map(rankMap(candidates));
    coverageRelevance.set(evidence.fusion.candidate_key, 10);

    const result = select(candidates, {
      maxEntries: 6,
      coverageRelevanceByCandidateKey: coverageRelevance
    });

    expect(result.candidates.map((candidate) => candidate.object_id)).toEqual([
      "peer-1",
      "peer-2",
      "peer-3",
      "peer-4",
      "peer-5",
      "coverage-head"
    ]);
  });

  it("restores a coverage-head capsule when the public fifth has a strong margin deficit", () => {
    const peers = peerCandidates();
    const evidence = directEvidence("coverage-head", STRONG_EVIDENCE, 6, 0.2);
    const candidates = [...peers, evidence];
    const coverageRelevance = new Map(rankMap(candidates));
    coverageRelevance.set(evidence.fusion.candidate_key, 10);

    const result = select(candidates, {
      maxEntries: 6,
      coverageRelevanceByCandidateKey: coverageRelevance
    });

    expect(result.candidates.map((candidate) => candidate.object_id)).toEqual([
      "peer-1",
      "peer-2",
      "peer-3",
      "peer-4",
      "coverage-head",
      "peer-5"
    ]);
  });

  it("compares admission margin with the real survivor, not a token-rejected position", () => {
    const peers = peerCandidates().slice(0, 4);
    const rejectedBase = createCandidate("token-rejected", {
      content: "Oversized positional reject."
    });
    const rejected = {
      ...rejectedBase,
      fusion: { ...rejectedBase.fusion, fused_rank: 5, fused_score: 0.5 }
    };
    const survivorBase = createCandidate("real-survivor", {
      content: STRONG_EVIDENCE,
      dimension: MemoryDimension.FACT
    });
    const survivor = {
      ...survivorBase,
      fusion: { ...survivorBase.fusion, fused_rank: 6, fused_score: 0.4 }
    };
    const evidence = directEvidence("evidence", STRONG_EVIDENCE, 7, 0.2);

    const result = select([...peers, rejected, survivor, evidence], {
      maxTotalTokens: 20,
      estimate: (content) => content === rejected.entry.content ? 10 : 4
    });

    expect(result.candidates.map((candidate) => candidate.object_id)).toEqual([
      "peer-1",
      "peer-2",
      "peer-3",
      "peer-4",
      "real-survivor"
    ]);
    expect(result.diagnostics.find((row) => row.object_id === "token-rejected")
      ?.dropped_reason).toBe("max_total_tokens");
  });

  it("preserves verified-slot authority when baseline admission has behavior support", () => {
    const peers = peerCandidates().slice(0, 4).map((candidate) =>
      withEmbeddingScore(candidate, 0.4)
    );
    const verifiedBase = createCandidate("verified", {
      content: "I bought the bookshelf from IKEA.",
      evidence_refs: ["evidence-verified"]
    });
    const verified = withEmbeddingScore({
      ...verifiedBase,
      fusion: { ...verifiedBase.fusion, fused_rank: 5, fused_score: 0.5 }
    }, 0.4);
    const context = projectVerifiedUserAssertionContext({
      evidenceRef: "evidence-verified",
      entryContent: verified.entry.content,
      gist: `User: ${verified.entry.content}`
    });
    if (context === null) throw new Error("fixture must project verified context");
    const evidence = directEvidence("evidence", STRONG_EVIDENCE, 6, 0.2);

    const result = select([...peers, verified, evidence], {
      verifiedContexts: { verified: context },
      captureAnswerFeatures: true,
      evidenceSemanticScoresByCandidateKey: new Map([[evidence.fusion.candidate_key, 0.99]])
    });

    expect(result.candidates.map((candidate) => candidate.object_id)).toEqual([
      "peer-1",
      "peer-2",
      "peer-3",
      "peer-4",
      "verified"
    ]);
    expect(result.diagnostics.find((row) => row.object_id === "verified")
      ?.answer_features?.answer_support?.authority?.behavior_eligible).toBe(true);
  });

  it.each([
    {
      name: "weak query match",
      candidate: directEvidence("weak", "The receipt was filed in a cabinet.", 6, 0.2),
      query: QUERY
    },
    {
      name: "insufficient margin over the fifth candidate",
      candidate: directEvidence("no-margin", STRONG_EVIDENCE, 6, 0.2),
      query: QUERY,
      fifthContent: STRONG_EVIDENCE
    },
    {
      name: "non-evidence candidate",
      candidate: createRankedCandidate("ordinary", 6, 0.2),
      query: QUERY,
      candidateContent: STRONG_EVIDENCE
    },
    {
      name: "missing query",
      candidate: directEvidence("no-query", STRONG_EVIDENCE, 6, 0.2),
      query: null
    },
    {
      name: "evidence rank outside the bounded stream head",
      candidate: directEvidence("rank-26", STRONG_EVIDENCE, 6, 0.2, 26),
      query: QUERY
    }
  ])("does not change the packet for $name", ({
    candidate,
    query,
    fifthContent,
    candidateContent
  }) => {
    const peers = [...peerCandidates()];
    if (fifthContent !== undefined) {
      peers[4] = {
        ...peers[4]!,
        entry: { ...peers[4]!.entry, content: fifthContent }
      };
    }
    const adjustedCandidate = candidateContent === undefined
      ? candidate
      : {
          ...candidate,
          entry: { ...candidate.entry, content: candidateContent }
        };

    const result = select([...peers, adjustedCandidate], { query });

    expect(result.candidates.map((row) => row.object_id))
      .toEqual(["peer-1", "peer-2", "peer-3", "peer-4", "peer-5"]);
  });

  it("fails open to the original packet when the capsule cannot fit the token budget", () => {
    const peers = peerCandidates();
    const evidence = directEvidence("oversized", STRONG_EVIDENCE, 6, 0.2);

    const result = select([...peers, evidence], {
      maxTotalTokens: 20,
      estimate: (content) => content === STRONG_EVIDENCE ? 10 : 4
    });

    expect(result.candidates.map((candidate) => candidate.object_id))
      .toEqual(["peer-1", "peer-2", "peer-3", "peer-4", "peer-5"]);
    expect(result.diagnostics.find((row) => row.object_id === "oversized")?.dropped_reason)
      .toBe("max_entries");
    expect(result.candidates.at(-1)?.budget_state).toMatchObject({
      within_budget: true,
      remaining_entries: 0,
      remaining_tokens: 0
    });
  });
});
