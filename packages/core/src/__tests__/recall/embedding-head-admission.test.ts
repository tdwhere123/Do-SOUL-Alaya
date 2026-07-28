import { describe, expect, it } from "vitest";
import { MemoryDimension } from "@do-soul/alaya-protocol";
import {
  createCandidate,
  runSelection,
  withCandidateKey,
  withDimension,
  withEntry,
  withFusionRanks
} from "./embedding-head/embedding-head-admission-fixtures.js";

describe("embedding-head dominance at the admission boundary", () => {
  it("preserves a CE winner's order while replacing an admitted conflict", () => {
    const conflict = withFusionRanks(createCandidate("conflict", 0.99), 3);
    const ceWinner = withFusionRanks(createCandidate("ce-winner", 0.9), 4);
    const embeddingHead = withFusionRanks(createCandidate("embedding-head", 0.8), 2);

    const result = runSelection([conflict, ceWinner, embeddingHead], {
      answerRerankedCandidateKeys: [ceWinner.fusion.candidate_key],
      embeddingSimilarityScores: {
        conflict: 0.2,
        "ce-winner": 0.1,
        "embedding-head": 0.9
      }
    });

    expect(result.candidates.map((candidate) => candidate.object_id)).toEqual([
      "ce-winner",
      "embedding-head"
    ]);
    const evicted = result.diagnostics.find((candidate) => candidate.object_id === "conflict");
    expect(evicted?.dropped_reason).toBe("embedding_head_dominance");
    expect(evicted?.eviction_reason).toBe("embedding_head_dominance");
  });

  it("evicts the weakest feasible conflict instead of the first one", () => {
    const strong = withFusionRanks(createCandidate("strong", 0.99), 3);
    const weak = withFusionRanks(createCandidate("weak", 0.98), 4);
    const embeddingHead = withFusionRanks(createCandidate("embedding-head", 0.97), 2);

    const result = runSelection([strong, weak, embeddingHead], {
      embeddingSimilarityScores: {
        strong: 0.8,
        weak: 0.2,
        "embedding-head": 0.9
      }
    });

    expect(result.candidates.map((candidate) => candidate.object_id)).toEqual([
      "strong",
      "embedding-head"
    ]);
  });

  it.each([
    ["worse rank when scores are absent", 3, 4, {}, "left"],
    ["worse rank when positive scores tie", 4, 3, {
      left: 0.2,
      right: 0.2,
      "embedding-head": 0.9
    }, "right"]
  ] as const)("evicts by %s", (_case, leftRank, rightRank, scores, retained) => {
    const left = withFusionRanks(createCandidate("left", 0.99), leftRank);
    const right = withFusionRanks(createCandidate("right", 0.98), rightRank);
    const embeddingHead = withFusionRanks(createCandidate("embedding-head", 0.97), 2);

    const result = runSelection([left, right, embeddingHead], {
      embeddingSimilarityScores: scores
    });

    expect(result.candidates.map((candidate) => candidate.object_id)).toEqual([
      retained,
      "embedding-head"
    ]);
  });

  it("does not treat a token-rejected prefix candidate as a delivered slot", () => {
    const rejectedConflict = withFusionRanks(
      createCandidate("token-rejected-conflict", 0.99),
      3
    );
    const ceWinner = withFusionRanks(createCandidate("ce-winner", 0.9), 4);
    const embeddingHead = withFusionRanks(createCandidate("embedding-head", 0.8), 2);

    const result = runSelection([rejectedConflict, ceWinner, embeddingHead], {
      answerRerankedCandidateKeys: [ceWinner.fusion.candidate_key],
      embeddingSimilarityScores: {
        "token-rejected-conflict": 0.2,
        "ce-winner": 0.1,
        "embedding-head": 0.9
      },
      tokenEstimate: (content) => content.includes("token-rejected-conflict") ? 11 : 5,
      maxTotalTokens: 10
    });

    expect(result.candidates.map((candidate) => candidate.object_id)).toEqual([
      "ce-winner",
      "embedding-head"
    ]);
    expect(result.diagnostics.find(
      (candidate) => candidate.object_id === "token-rejected-conflict"
    )?.dropped_reason).toBe("max_total_tokens");
  });

  it("does not admit a token-heavy head by dropping a later CE peer", () => {
    const conflict = withFusionRanks(createCandidate("conflict", 0.99), 4);
    const embeddingHead = withFusionRanks(createCandidate("embedding-head", 0.9), 1);
    const ceWinner = withFusionRanks(createCandidate("ce-winner", 0.8), 5);

    const result = runSelection([conflict, embeddingHead, ceWinner], {
      answerRerankedCandidateKeys: [ceWinner.fusion.candidate_key],
      embeddingSimilarityScores: {
        conflict: 0.2,
        "embedding-head": 0.9,
        "ce-winner": 0.1
      },
      maxEntries: 3,
      maxTotalTokens: 10,
      tokenEstimate: (content) => {
        if (content.includes("conflict")) return 6;
        if (content.includes("embedding-head")) return 8;
        return 4;
      }
    });

    expect(result.candidates.map((candidate) => candidate.object_id)).toEqual([
      "conflict",
      "ce-winner"
    ]);
  });

  it("does not let a dimension-rejected prefix displace a query winner", () => {
    const anchor = withFusionRanks(createCandidate("anchor", 1), 1);
    const rejectedConflict = withFusionRanks(createCandidate("dimension-conflict", 0.99), 3);
    const queryWinner = withFusionRanks(
      withDimension(createCandidate("query-winner", 0.9), MemoryDimension.FACT),
      4,
      { lexical_fts: 1 }
    );
    const embeddingHead = withFusionRanks(
      withDimension(createCandidate("embedding-head", 0.8), MemoryDimension.PREFERENCE),
      2
    );

    const result = runSelection([anchor, rejectedConflict, queryWinner, embeddingHead], {
      embeddingSimilarityScores: {
        anchor: 0.95,
        "dimension-conflict": 0.2,
        "query-winner": 0.1,
        "embedding-head": 0.9
      },
      perDimensionLimits: { [MemoryDimension.PROCEDURE]: 1 }
    });

    expect(result.candidates.map((candidate) => candidate.object_id)).toEqual([
      "anchor",
      "query-winner"
    ]);
    expect(result.diagnostics.find(
      (candidate) => candidate.object_id === "dimension-conflict"
    )?.dropped_reason).toBe("dimension_limit");
  });

  it("does not treat a duplicate prefix projection as a delivered slot", () => {
    const anchor = withFusionRanks(createCandidate("shared", 1), 1);
    const duplicate = withCandidateKey(
      withFusionRanks(createCandidate("shared", 0.99), 3),
      "global:memory_entry:shared"
    );
    const queryWinner = withFusionRanks(
      createCandidate("query-winner", 0.4),
      4,
      { lexical_fts: 1 }
    );
    const embeddingHead = withFusionRanks(createCandidate("embedding-head", 0.3), 2);

    const result = runSelection([anchor, duplicate, queryWinner, embeddingHead], {
      embeddingSimilarityScores: {
        shared: 0.2,
        "query-winner": 0.1,
        "embedding-head": 0.9
      }
    });

    expect(result.candidates.map((candidate) => candidate.object_id)).toEqual([
      "shared",
      "query-winner"
    ]);
    expect(result.diagnostics.find(
      (candidate) => candidate.candidate_key === duplicate.fusion.candidate_key
    )?.dropped_reason).toBe("duplicate");
  });

  it("uses rank to break a boundary cosine tie", () => {
    const anchor = withFusionRanks(createCandidate("anchor", 0.9), 1);
    const conflict = withFusionRanks(createCandidate("tied-conflict", 0.8), 3);
    const embeddingHead = withFusionRanks(createCandidate("tied-head", 0.7), 2);

    const result = runSelection([anchor, conflict, embeddingHead], {
      embeddingSimilarityScores: {
        anchor: 0.9,
        "tied-conflict": 0.8,
        "tied-head": 0.8
      }
    });

    expect(result.candidates.map((candidate) => candidate.object_id)).toEqual([
      "anchor",
      "tied-head"
    ]);
  });

  it("repairs a conflict flood without reordering surviving heads", () => {
    const structuralOnly = {
      evidence_structural_agreement: 1,
      source_proximity: 1,
      source_evidence_agreement: 1
    };
    const conflictA = withFusionRanks(createCandidate("conflict-a", 0.99), 5, structuralOnly);
    const headA = withFusionRanks(createCandidate("head-a", 0.98), 1);
    const conflictB = withFusionRanks(createCandidate("conflict-b", 0.97), 4, structuralOnly);
    const headB = withFusionRanks(createCandidate("head-b", 0.96), 2);
    const headC = withFusionRanks(createCandidate("head-c", 0.95), 3);

    const result = runSelection([conflictA, headA, conflictB, headB, headC], {
      maxEntries: 3,
      embeddingSimilarityScores: {
        "conflict-a": 0.2,
        "head-a": 0.95,
        "conflict-b": 0.1,
        "head-b": 0.9,
        "head-c": 0.85
      }
    });

    expect(result.candidates.map((candidate) => candidate.object_id)).toEqual([
      "head-a",
      "head-b",
      "head-c"
    ]);
  });

  it("keeps a committed embedding replacement through answer-support membership", () => {
    const conflict = withFusionRanks(createCandidate("conflict", 0.99), 3);
    const peer = withFusionRanks(createCandidate("peer", 0.9), 4);
    const embeddingHead = withFusionRanks(createCandidate("embedding-head", 0.8), 1);
    const support = withFusionRanks(withEntry(
      createCandidate("support", 0.7),
      {
        content: "Six months passed before the reply.",
        evidence_refs: ["evidence-support"]
      }
    ), 5);

    const result = runSelection([conflict, peer, embeddingHead, support], {
      embeddingSimilarityScores: {
        conflict: 0.1,
        peer: 0.2,
        "embedding-head": 0.9,
        support: 0.1
      },
      queryText: "How long did I wait for the reply?"
    });

    expect(result.candidates.map((candidate) => candidate.object_id)).toEqual([
      "embedding-head",
      "support"
    ]);
    expect(result.diagnostics.find(
      (candidate) => candidate.object_id === "conflict"
    )?.dropped_reason).toBe("embedding_head_dominance");
  });

  it("keeps every head admitted by a token-underfilled replacement", () => {
    const conflict = withFusionRanks(createCandidate("conflict", 0.99), 4);
    const peer = withFusionRanks(createCandidate("peer", 0.9), 5);
    const headA = withFusionRanks(createCandidate("head-a", 0.8), 1);
    const headB = withFusionRanks(createCandidate("head-b", 0.7), 2);
    const support = withFusionRanks(withEntry(createCandidate("support", 0.6), {
      content: "Six months passed before the reply.",
      evidence_refs: ["evidence-support"]
    }), 6);
    const result = runSelection([conflict, peer, headA, headB, support], {
      maxEntries: 3,
      maxTotalTokens: 10,
      embeddingSimilarityScores: {
        conflict: 0.1, peer: 0.2, "head-a": 0.9, "head-b": 0.8, support: 0.1
      },
      queryText: "How long did I wait for the reply?",
      tokenEstimate: (content) => {
        if (content.includes("conflict")) return 8;
        if (content.includes("peer")) return 2;
        if (content.includes("head-")) return 4;
        return 1;
      }
    });

    expect(result.candidates.map((candidate) => candidate.object_id)).toEqual([
      "head-a",
      "head-b",
      "support"
    ]);
    expect(result.diagnostics.find(
      (candidate) => candidate.object_id === "conflict"
    )?.dropped_reason).toBe("embedding_head_dominance");
  });

  it("keeps sequential dimension replacements ahead of H8 support", () => {
    const conflictProcedure = withFusionRanks(
      createCandidate("conflict-procedure", 0.99), 3
    );
    const conflictFact = withFusionRanks(withDimension(
      createCandidate("conflict-fact", 0.9), MemoryDimension.FACT
    ), 4);
    const headProcedure = withFusionRanks(createCandidate("head-procedure", 0.8), 1);
    const headFact = withFusionRanks(withDimension(
      createCandidate("head-fact", 0.7), MemoryDimension.FACT
    ), 2);
    const support = withFusionRanks(withDimension(withEntry(
      createCandidate("support", 0.6),
      {
        content: "Six months passed before the reply.",
        evidence_refs: ["evidence-support"]
      }
    ), MemoryDimension.PREFERENCE), 5);
    const result = runSelection(
      [conflictProcedure, conflictFact, headProcedure, headFact, support],
      {
        maxEntries: 2,
        perDimensionLimits: {
          [MemoryDimension.PROCEDURE]: 1,
          [MemoryDimension.FACT]: 1
        },
        embeddingSimilarityScores: {
          "conflict-procedure": 0.1,
          "conflict-fact": 0.2,
          "head-procedure": 0.9,
          "head-fact": 0.8,
          support: 0.1
        },
        queryText: "How long did I wait for the reply?"
      }
    );

    expect(result.candidates.map((candidate) => candidate.object_id)).toEqual([
      "head-procedure",
      "head-fact"
    ]);
    for (const objectId of ["conflict-procedure", "conflict-fact"]) {
      expect(result.diagnostics.find(
        (candidate) => candidate.object_id === objectId
      )?.dropped_reason).toBe("embedding_head_dominance");
    }
  });

  it.each(["lexical_fts", "evidence_fts"] as const)(
    "lets a %s-supported challenger keep its delivery win",
    (queryStream) => {
      const anchor = withFusionRanks(createCandidate("anchor", 0.9), 1);
      const queryWinner = withFusionRanks(
        createCandidate("query-winner", 0.85),
        3,
        { [queryStream]: 1 }
      );
      const embeddingHead = withFusionRanks(createCandidate("embedding-head", 0.8), 2);

      const result = runSelection([anchor, queryWinner, embeddingHead], {
        embeddingSimilarityScores: {
          anchor: 0.95,
          "query-winner": 0.2,
          "embedding-head": 0.9
        }
      });

      expect(result.candidates.map((candidate) => candidate.object_id)).toEqual([
        "anchor",
        "query-winner"
      ]);
    }
  );

  it("keeps a delivery-head evidence winner ahead of a stronger embedding head", () => {
    const anchor = withFusionRanks(createCandidate("anchor", 0.9), 1);
    const queryWinner = withFusionRanks(
      createCandidate("query-winner", 0.85),
      3,
      { evidence_fts: 2 }
    );
    const embeddingHead = withFusionRanks(createCandidate("embedding-head", 0.8), 2);

    const result = runSelection([anchor, queryWinner, embeddingHead], {
      embeddingSimilarityScores: {
        anchor: 0.95,
        "query-winner": 0.2,
        "embedding-head": 0.9
      }
    });

    expect(result.candidates.map((candidate) => candidate.object_id)).toEqual([
      "anchor",
      "query-winner"
    ]);
  });

  it("lets tail evidence yield to a stronger embedding head", () => {
    const anchor = withFusionRanks(createCandidate("anchor", 0.9), 1);
    const queryWinner = withFusionRanks(
      createCandidate("query-winner", 0.85),
      3,
      { evidence_fts: 3 }
    );
    const embeddingHead = withFusionRanks(createCandidate("embedding-head", 0.8), 2);

    const result = runSelection([anchor, queryWinner, embeddingHead], {
      embeddingSimilarityScores: {
        anchor: 0.95,
        "query-winner": 0.2,
        "embedding-head": 0.9
      }
    });

    expect(result.candidates.map((candidate) => candidate.object_id)).toEqual([
      "anchor",
      "embedding-head"
    ]);
  });

  it("does not treat subject alignment alone as direct query evidence", () => {
    const anchor = withFusionRanks(createCandidate("anchor", 0.9), 1);
    const contextualWinner = withFusionRanks(
      createCandidate("contextual-winner", 0.85),
      3,
      { subject_alignment: 1 }
    );
    const embeddingHead = withFusionRanks(createCandidate("embedding-head", 0.8), 2);

    const result = runSelection([anchor, contextualWinner, embeddingHead], {
      embeddingSimilarityScores: {
        anchor: 0.95,
        "contextual-winner": 0.2,
        "embedding-head": 0.9
      }
    });

    expect(result.candidates.map((candidate) => candidate.object_id)).toEqual([
      "anchor",
      "embedding-head"
    ]);
  });

  it("lets a temporal-query challenger keep its delivery win", () => {
    const anchor = withFusionRanks(createCandidate("anchor", 0.9), 1);
    const temporalWinner = withFusionRanks(
      createCandidate("temporal-winner", 0.85),
      3,
      { temporal_recency: 1 }
    );
    const embeddingHead = withFusionRanks(createCandidate("embedding-head", 0.8), 2);

    const result = runSelection([anchor, temporalWinner, embeddingHead], {
      embeddingSimilarityScores: {
        anchor: 0.95,
        "temporal-winner": 0.2,
        "embedding-head": 0.9
      },
      queryText: "What happened in March 2026?"
    });

    expect(result.candidates.map((candidate) => candidate.object_id)).toEqual([
      "anchor",
      "temporal-winner"
    ]);
  });
});
