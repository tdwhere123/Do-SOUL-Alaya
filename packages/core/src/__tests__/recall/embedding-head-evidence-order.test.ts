import { describe, expect, it } from "vitest";
import {
  compareEmbeddingEvidenceStrength,
  selectEmbeddingHeadEvictions
} from "../../recall/delivery/admission/embedding-head-dominance.js";
import { buildEmptyRecallFusionBreakdown } from "../../recall/delivery/fusion-delivery-scoring.js";

describe("embedding-head evidence order", () => {
  it("reports semantic equality for equal positive scores and ranks", () => {
    const left = candidate("left", 3);
    const right = candidate("right", 3);
    const scores = { left: 0.5, right: 0.5 };

    expect(compareEmbeddingEvidenceStrength(left, right, scores)).toBe(0);
    expect(compareEmbeddingEvidenceStrength(right, left, scores)).toBe(0);
  });

  it("reports equality when both candidates have no score or embedding rank", () => {
    const left = candidate("left", Number.POSITIVE_INFINITY);
    const right = candidate("right", Number.POSITIVE_INFINITY);

    expect(compareEmbeddingEvidenceStrength(left, right, {})).toBe(0);
    expect(compareEmbeddingEvidenceStrength(right, left, {})).toBe(0);
  });

  it("uses rank after equal positive evidence scores", () => {
    const weakRank = candidate("weak-rank", 4);
    const strongRank = candidate("strong-rank", 3);
    const head = candidate("head", 2);

    expect(evictedKey([weakRank, strongRank, head], ["weak-rank", "strong-rank"], {
      "weak-rank": 0.5,
      "strong-rank": 0.5,
      head: 0.9
    })).toBe("weak-rank");
  });

  it("treats zero and negative scores as absent evidence", () => {
    const negative = candidate("negative", 3);
    const zero = candidate("zero", 4);
    const head = candidate("head", 2);

    expect(evictedKey([negative, zero, head], ["negative", "zero"], {
      negative: -1,
      zero: 0,
      head: 0.9
    })).toBe("zero");
  });

  it("does not project memory scores onto same-id synthesis or global candidates", () => {
    const local = candidate("local", 3, 0.4);
    const projectionBase = candidate("shared", 2, 0.2);
    const synthesis = { ...projectionBase, objectKind: "synthesis_capsule" as const };
    const global = { ...projectionBase, originPlane: "global" as const };
    const memoryScores = { shared: 0.9, local: 0.4 };

    expect(compareEmbeddingEvidenceStrength(synthesis, local, memoryScores)).toBe(-1);
    expect(compareEmbeddingEvidenceStrength(global, local, memoryScores)).toBe(-1);
  });

  it("does not evict a candidate with independent non-embedding query evidence", () => {
    const incumbentBase = candidate("incumbent", 2);
    const incumbent = {
      ...incumbentBase,
      fusion: {
        ...incumbentBase.fusion,
        per_stream_rank: {
          ...incumbentBase.fusion.per_stream_rank,
          subject_alignment: 1
        }
      }
    };
    const head = candidate("head", 1);
    const evictions = selectEmbeddingHeadEvictions({
      candidates: [incumbent, head],
      maxEntries: 1,
      embeddingScores: { incumbent: 0.2, head: 0.9 },
      selectDelivered: (excluded) => excluded.has("incumbent") ? [head] : [incumbent]
    });

    expect(evictions.size).toBe(0);
  });

  it.each([undefined, Number.NaN])(
    "keeps positive finite evidence over an invalid score (%s)",
    (invalidScore) => {
      const positive = candidate("positive", 4);
      const invalid = candidate("invalid", 3, invalidScore);
      const head = candidate("head", 2);

      expect(evictedKey([positive, invalid, head], ["positive", "invalid"], {
        positive: 0.2,
        head: 0.9
      })).toBe("invalid");
    }
  );

  it("is invariant across every permutation when evidence is identical", () => {
    const permutations = [
      ["a", "b", "head"], ["a", "head", "b"], ["b", "a", "head"],
      ["b", "head", "a"], ["head", "a", "b"], ["head", "b", "a"]
    ] as const;
    for (const permutation of permutations) {
      const candidates = permutation.map((key) => candidate(key, key === "head" ? 2 : 3));
      const incumbents = permutation.filter((key) => key !== "head");
      expect(evictedKey(candidates, incumbents, { a: 0.2, b: 0.2, head: 0.9 }))
        .toBe("b");
    }
  });

  it("keeps bytewise tie-breaking permutation-invariant for 2048 generated cases", () => {
    const failures: string[] = [];
    for (let index = 0; index < 2_048; index += 1) {
      const prefix = index.toString().padStart(4, "0");
      const keys = [`${prefix}-z`, `${prefix}-ä`] as const;
      const incumbents = index % 2 === 0 ? keys : [keys[1], keys[0]] as const;
      const candidates = [candidate(incumbents[0], 3), candidate(incumbents[1], 3), candidate("head", 2)];
      const expected = compareBytewise(keys[0], keys[1]) > 0 ? keys[0] : keys[1];
      const actual = evictedKey(candidates, incumbents, {
        [keys[0]]: 0.2,
        [keys[1]]: 0.2,
        head: 0.9
      });
      if (actual !== expected && failures.length < 5) failures.push(`${index}:${actual}`);
    }
    expect(failures).toEqual([]);
  });
});

function candidate(objectId: string, embeddingRank: number, score?: number) {
  const breakdown = buildEmptyRecallFusionBreakdown(objectId);
  return {
    entry: { object_id: objectId },
    effectiveFactors: score === undefined ? {} : { embedding_similarity: score },
    fusion: {
      candidate_key: objectId,
      per_stream_rank: {
        ...breakdown.per_stream_rank,
        embedding_similarity: embeddingRank
      }
    }
  };
}

type Candidate = ReturnType<typeof candidate>;

function evictedKey(
  candidates: readonly Candidate[],
  incumbentKeys: readonly string[],
  scores: Readonly<Record<string, number>>
): string | null {
  const byKey = new Map(candidates.map((item) => [item.fusion.candidate_key, item]));
  const head = byKey.get("head")!;
  const evictions = selectEmbeddingHeadEvictions({
    candidates,
    maxEntries: 2,
    embeddingScores: scores,
    selectDelivered: (excluded) => {
      const delivered = incumbentKeys
        .filter((key) => !excluded.has(key))
        .map((key) => byKey.get(key)!);
      if (delivered.length < 2) delivered.push(head);
      return delivered;
    }
  });
  return [...evictions][0] ?? null;
}

function compareBytewise(left: string, right: string): number {
  const encoder = new TextEncoder();
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const length = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    if (leftBytes[index] !== rightBytes[index]) return leftBytes[index]! - rightBytes[index]!;
  }
  return leftBytes.length - rightBytes.length;
}
