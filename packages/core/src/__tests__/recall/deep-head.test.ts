import { describe, expect, it } from "vitest";
import {
  MemoryDimension,
  ScopeClass,
  type MemoryEntry,
  type RecallScoreFactors
} from "@do-soul/alaya-protocol";
import { applyDeliverySelection, type DeliverySelectionCandidate } from "../../recall/delivery/delivery-selection.js";
import { buildEmptyRecallFusionBreakdown } from "../../recall/delivery/fusion-delivery-scoring.js";
import type { RecallFusionBreakdown } from "../../recall/runtime/recall-service-types.js";
import {
  computeLightweightDeepHeadScores,
  DEEP_HEAD_CANDIDATE_LIMIT,
  resolveDeepHeadScores
} from "../../recall/rerank/deep-head.js";

function memory(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    object_id: "obj",
    object_kind: "memory_entry",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: "2026-03-20T00:00:00.000Z",
    updated_at: "2026-03-20T00:00:00.000Z",
    created_by: "system",
    dimension: MemoryDimension.FACT,
    source_kind: "user",
    formation_kind: "explicit",
    scope_class: ScopeClass.PROJECT,
    content: "memory content",
    domain_tags: [],
    evidence_refs: [],
    workspace_id: "workspace-1",
    run_id: "run-1",
    surface_id: null,
    storage_tier: "hot",
    activation_score: 0.5,
    retention_score: null,
    manifestation_state: null,
    retention_state: null,
    decay_profile: null,
    confidence: null,
    last_used_at: null,
    last_hit_at: null,
    reinforcement_count: null,
    contradiction_count: null,
    superseded_by: null,
    ...overrides
  };
}

function fusedCandidate(input: {
  readonly objectId: string;
  readonly fusedScore: number;
  readonly fusedRank?: number;
  readonly embedding?: number;
  readonly evidenceFts?: number;
  readonly contributions?: Partial<Record<string, number>>;
}): DeliverySelectionCandidate {
  const breakdown = buildEmptyRecallFusionBreakdown(input.objectId);
  const fusion: RecallFusionBreakdown = Object.freeze({
    ...breakdown,
    fused_rank: input.fusedRank ?? breakdown.fused_rank,
    fused_score: input.fusedScore,
    ...(input.contributions === undefined
      ? {}
      : {
          fused_rank_contribution_per_stream: Object.freeze({
            ...breakdown.fused_rank_contribution_per_stream,
            ...input.contributions
          })
        })
  });
  const factors = {
    ...(input.embedding === undefined ? {} : { embedding_similarity: input.embedding })
  } as RecallScoreFactors;
  return Object.freeze({
    entry: memory({ object_id: input.objectId }),
    effectiveScore: input.fusedScore,
    effectiveFactors: factors,
    fusion
  });
}

function emptySupplementary(overrides: {
  readonly embeddingSimilarityScores?: Record<string, number>;
  readonly evidenceFtsRanks?: Record<string, number>;
  readonly structuralScores?: Record<string, number>;
  readonly sourceProximityScores?: Record<string, number>;
} = {}) {
  return {
    embeddingSimilarityScores: overrides.embeddingSimilarityScores ?? {},
    evidenceFtsRanks: overrides.evidenceFtsRanks ?? {},
    structuralScores: overrides.structuralScores ?? {},
    sourceProximityScores: overrides.sourceProximityScores ?? {}
  };
}

describe("deep head", () => {
  it("windows lightweight scores to the fused top-30 only", () => {
    const candidates = Array.from({ length: DEEP_HEAD_CANDIDATE_LIMIT + 5 }, (_, index) =>
      fusedCandidate({
        objectId: `c-${index + 1}`,
        fusedScore: 1 - index * 0.01,
        fusedRank: index + 1,
        embedding: index === 0 ? 0.2 : 0.9 - index * 0.01
      })
    );

    const scores = computeLightweightDeepHeadScores(candidates, emptySupplementary());

    expect(scores.size).toBe(DEEP_HEAD_CANDIDATE_LIMIT);
    expect(scores.has(candidates[DEEP_HEAD_CANDIDATE_LIMIT]!.fusion.candidate_key)).toBe(false);
  });

  it("prefers cross-encoder scores when present and otherwise uses lightweight head", () => {
    const candidates = [
      fusedCandidate({ objectId: "a", fusedScore: 0.9, fusedRank: 1, embedding: 0.1 }),
      fusedCandidate({ objectId: "b", fusedScore: 0.8, fusedRank: 2, embedding: 0.9 })
    ];
    const ceScores = new Map([
      [candidates[0]!.fusion.candidate_key, 0.95],
      [candidates[1]!.fusion.candidate_key, 0.1]
    ]);

    const withCe = resolveDeepHeadScores({
      candidates,
      answerRelevanceScores: ceScores,
      supplementaryData: emptySupplementary()
    });
    const withoutCe = resolveDeepHeadScores({
      candidates,
      answerRelevanceScores: new Map(),
      supplementaryData: emptySupplementary({
        embeddingSimilarityScores: { a: 0.1, b: 0.9 }
      })
    });

    expect(withCe.get(candidates[0]!.fusion.candidate_key)).toBe(0.95);
    expect(withoutCe.get(candidates[1]!.fusion.candidate_key)!)
      .toBeGreaterThan(withoutCe.get(candidates[0]!.fusion.candidate_key)!);
  });

  it("keeps fusion order outside the deep-head window after delivery selection", () => {
    const head = Array.from({ length: DEEP_HEAD_CANDIDATE_LIMIT }, (_, index) =>
      fusedCandidate({
        objectId: `head-${index + 1}`,
        fusedScore: 1 - index * 0.001,
        fusedRank: index + 1,
        embedding: index === 5 ? 1 : 0.1
      })
    );
    const tail = [
      fusedCandidate({ objectId: "tail-a", fusedScore: 0.05, fusedRank: 31, embedding: 0 }),
      fusedCandidate({ objectId: "tail-b", fusedScore: 0.04, fusedRank: 32, embedding: 1 })
    ];
    const scores = computeLightweightDeepHeadScores([...head, ...tail], emptySupplementary());
    const result = applyDeliverySelection([...head, ...tail], scores, {
      replacePublicRelevance: false
    });
    const orderedIds = result.orderedCandidates.map((candidate) => candidate.entry.object_id);

    expect(orderedIds.slice(0, DEEP_HEAD_CANDIDATE_LIMIT)).toContain("head-6");
    expect(orderedIds[0]).toBe("head-6");
    expect(orderedIds.slice(DEEP_HEAD_CANDIDATE_LIMIT)).toEqual(["tail-a", "tail-b"]);
    // Lightweight head reorders; fused_score remains the public relevance scalar.
    expect(result.finalRelevanceByCandidateKey.get(head[5]!.fusion.candidate_key))
      .toBe(head[5]!.fusion.fused_score);
    expect(result.answerRelevanceRankByCandidateKey.size).toBe(0);
  });

  it("keeps query-supported fusion wins when emb is cold and agreement-gates conflict-only piles", () => {
    // Path rescue with a lexical foothold must keep fused mass; content-disjoint
    // path piles stay agreement-gated so they cannot lead over lexical hits.
    const pathGold = fusedCandidate({
      objectId: "path-gold",
      fusedScore: 0.08,
      fusedRank: 2,
      contributions: { path_expansion: 0.016, lexical_fts: 0.012 }
    });
    const conflictOnly = fusedCandidate({
      objectId: "conflict-only",
      fusedScore: 0.07,
      fusedRank: 3,
      contributions: { path_expansion: 0.016, existing_score: 0.014 }
    });
    const lexicalPeer = fusedCandidate({
      objectId: "lexical-peer",
      fusedScore: 0.04,
      fusedRank: 4,
      contributions: { lexical_fts: 0.013, existing_score: 0.015 }
    });
    const seed = fusedCandidate({
      objectId: "path-seed",
      fusedScore: 0.09,
      fusedRank: 1,
      contributions: { path_expansion: 0.015, lexical_fts: 0.014 }
    });
    const scores = computeLightweightDeepHeadScores(
      [seed, pathGold, conflictOnly, lexicalPeer],
      emptySupplementary({
        evidenceFtsRanks: {
          "lexical-peer": 1,
          "path-gold": 0.2,
          "path-seed": 0.3,
          "conflict-only": 0.01
        },
        structuralScores: {
          "lexical-peer": 1,
          "path-gold": 0.2,
          "path-seed": 0.3,
          "conflict-only": 0.01
        }
      })
    );
    expect(scores.get(pathGold.fusion.candidate_key)).toBeCloseTo(0.08);
    expect(scores.get(lexicalPeer.fusion.candidate_key)).toBeCloseTo(0.04);
    expect(scores.get(conflictOnly.fusion.candidate_key)!)
      .toBeLessThan(scores.get(lexicalPeer.fusion.candidate_key)!);

    const result = applyDeliverySelection(
      [seed, pathGold, conflictOnly, lexicalPeer],
      scores,
      { replacePublicRelevance: false }
    );
    expect(result.orderedCandidates.map((candidate) => candidate.entry.object_id))
      .toEqual(["path-seed", "path-gold", "lexical-peer", "conflict-only"]);
  });

  it("is a no-op when emb and agreement are both cold (fused order binds)", () => {
    // Without emb or corroboration the deep head has no signal orthogonal to
    // fusion; rescoring would demote path-only candidates that fusion admitted.
    const pathOnly = fusedCandidate({
      objectId: "path-only",
      fusedScore: 0.07,
      fusedRank: 2,
      contributions: { path_expansion: 0.016 }
    });
    const lexicalHead = fusedCandidate({
      objectId: "lexical-head",
      fusedScore: 0.09,
      fusedRank: 1,
      contributions: { lexical_fts: 0.014 }
    });
    const lexicalTail = fusedCandidate({
      objectId: "lexical-tail",
      fusedScore: 0.05,
      fusedRank: 3,
      contributions: { lexical_fts: 0.012 }
    });
    const scores = computeLightweightDeepHeadScores(
      [lexicalHead, pathOnly, lexicalTail],
      emptySupplementary()
    );
    expect(scores.size).toBe(0);

    const result = applyDeliverySelection([lexicalHead, pathOnly, lexicalTail], scores, {
      replacePublicRelevance: false
    });
    expect(result.orderedCandidates.map((candidate) => candidate.entry.object_id))
      .toEqual(["lexical-head", "path-only", "lexical-tail"]);
  });
});
