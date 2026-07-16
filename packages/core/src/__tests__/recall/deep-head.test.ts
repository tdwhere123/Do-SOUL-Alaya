import { describe, expect, it } from "vitest";
import {
  MemoryDimension,
  ScopeClass,
  type MemoryEntry,
  type RecallScoreFactors
} from "@do-soul/alaya-protocol";
import { applyDeliverySelection, type DeliverySelectionCandidate } from "../../recall/delivery/delivery-selection.js";
import { orderByCoverageMarginalGain } from "../../recall/delivery/coverage-selection.js";
import { buildEmptyRecallFusionBreakdown } from "../../recall/delivery/fusion-delivery-scoring.js";
import type { RecallFusionBreakdown } from "../../recall/runtime/recall-service-types.js";
import {
  computeLightweightDeepHeadScores,
  resolveDeepHeadScores
} from "../../recall/rerank/deep-head.js";
import { compileRecallQueryProbes } from "../../recall/query/recall-query-probes.js";

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
    queryProbes: compileRecallQueryProbes(null),
    embeddingSimilarityScores: overrides.embeddingSimilarityScores ?? {},
    evidenceFtsRanks: overrides.evidenceFtsRanks ?? {},
    structuralScores: overrides.structuralScores ?? {},
    sourceProximityScores: overrides.sourceProximityScores ?? {}
  };
}

describe("deep head", () => {
  it("scores every candidate in the already-pruned waist", () => {
    const candidates = Array.from({ length: 37 }, (_, index) =>
      fusedCandidate({
        objectId: `c-${index + 1}`,
        fusedScore: 1 - index * 0.01,
        fusedRank: index + 1,
        embedding: index === 0 ? 0.2 : 0.9 - index * 0.01
      })
    );

    const scores = computeLightweightDeepHeadScores(candidates, emptySupplementary());

    expect(scores.size).toBe(candidates.length);
    expect(scores.has(candidates.at(-1)!.fusion.candidate_key)).toBe(true);
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

  it("lets independent semantic support promote a candidate from a distant fused rank", () => {
    const candidates = Array.from({ length: 40 }, (_, index) =>
      fusedCandidate({
        objectId: `candidate-${index + 1}`,
        fusedScore: 1 - index * 0.001,
        fusedRank: index + 1,
        embedding: index === 39 ? 1 : 0.1
      })
    );
    const scores = computeLightweightDeepHeadScores(candidates, emptySupplementary());
    const result = applyDeliverySelection(candidates, scores, {
      replacePublicRelevance: false
    });
    const orderedIds = result.orderedCandidates.map((candidate) => candidate.entry.object_id);

    expect(orderedIds[0]).toBe("candidate-40");
    expect(result.finalRelevanceByCandidateKey.get(candidates[39]!.fusion.candidate_key))
      .toBe(candidates[39]!.fusion.fused_score);
    expect(result.answerRelevanceRankByCandidateKey.size).toBe(0);
  });

  it("combines semantic support and evidence agreement monotonically", () => {
    const semanticOnly = fusedCandidate({
      objectId: "semantic-only",
      fusedScore: 0.3,
      embedding: 0.6
    });
    const corroborated = fusedCandidate({
      objectId: "corroborated",
      fusedScore: 0.2,
      embedding: 0.6
    });
    const scores = computeLightweightDeepHeadScores(
      [semanticOnly, corroborated],
      emptySupplementary({
        evidenceFtsRanks: { corroborated: 1 },
        structuralScores: { corroborated: 0.36 }
      })
    );

    expect(scores.get(semanticOnly.fusion.candidate_key)).toBeCloseTo(0.6);
    expect(scores.get(corroborated.fusion.candidate_key)).toBeCloseTo(0.84);
  });

  it("preserves query-supported relevance without a usable embedding in a mixed pool", () => {
    const exactLexical = fusedCandidate({
      objectId: "exact-lexical",
      fusedScore: 0.08,
      fusedRank: 1,
      contributions: { lexical_fts: 0.016 }
    });
    const invalidVectorLexical = fusedCandidate({
      objectId: "invalid-vector-lexical",
      fusedScore: 0.07,
      fusedRank: 2,
      embedding: Number.NaN,
      contributions: { lexical_fts: 0.015 }
    });
    const weakSemantic = fusedCandidate({
      objectId: "weak-semantic",
      fusedScore: 0.03,
      fusedRank: 3,
      embedding: 0.04,
      contributions: { embedding_similarity: 0.016 }
    });
    const zeroSimilarityLexical = fusedCandidate({
      objectId: "zero-similarity-lexical",
      fusedScore: 0.09,
      fusedRank: 4,
      embedding: 0,
      contributions: { lexical_fts: 0.014 }
    });
    const candidates = [
      exactLexical,
      invalidVectorLexical,
      weakSemantic,
      zeroSimilarityLexical
    ];

    const scores = computeLightweightDeepHeadScores(candidates, emptySupplementary());
    const packed = orderByCoverageMarginalGain({
      candidates,
      relevanceByCandidateKey: scores,
      supplementaryData: {
        evidenceGistsByMemoryId: {},
        sourceCohortKeys: {}
      }
    });

    expect(scores.get(exactLexical.fusion.candidate_key)).toBeCloseTo(0.08);
    expect(scores.get(invalidVectorLexical.fusion.candidate_key)).toBeCloseTo(0.07);
    expect(scores.get(zeroSimilarityLexical.fusion.candidate_key)).toBe(0);
    expect(packed.map((candidate) => candidate.entry.object_id))
      .toEqual([
        "exact-lexical",
        "invalid-vector-lexical",
        "weak-semantic",
        "zero-similarity-lexical"
      ]);
  });

  it("treats an all-zero finite embedding pool as observed", () => {
    const candidates = [
      fusedCandidate({
        objectId: "zero-a",
        fusedScore: 0.09,
        embedding: 0,
        contributions: { lexical_fts: 0.016 }
      }),
      fusedCandidate({
        objectId: "zero-b",
        fusedScore: 0.08,
        embedding: 0,
        contributions: { lexical_fts: 0.015 }
      })
    ];

    const scores = computeLightweightDeepHeadScores(candidates, emptySupplementary());

    expect(scores.size).toBe(2);
    expect([...scores.values()]).toEqual([0, 0]);
  });

  it("keeps missing and invalid embeddings cold beside an observed supplementary zero", () => {
    const observedZero = fusedCandidate({
      objectId: "observed-zero",
      fusedScore: 0.9,
      contributions: { lexical_fts: 0.016 }
    });
    const missing = fusedCandidate({
      objectId: "missing",
      fusedScore: 0.08,
      contributions: { lexical_fts: 0.015 }
    });
    const invalid = fusedCandidate({
      objectId: "invalid",
      fusedScore: 0.07,
      embedding: Number.NaN,
      contributions: { lexical_fts: 0.014 }
    });
    const candidates = [observedZero, missing, invalid];
    const scores = computeLightweightDeepHeadScores(
      candidates,
      emptySupplementary({ embeddingSimilarityScores: { "observed-zero": 0 } })
    );
    const packed = orderByCoverageMarginalGain({
      candidates,
      relevanceByCandidateKey: scores,
      supplementaryData: { evidenceGistsByMemoryId: {}, sourceCohortKeys: {} }
    });

    expect(scores.get(observedZero.fusion.candidate_key)).toBe(0);
    expect(scores.get(missing.fusion.candidate_key)).toBeCloseTo(0.08);
    expect(scores.get(invalid.fusion.candidate_key)).toBeCloseTo(0.07);
    expect(packed.map((candidate) => candidate.entry.object_id))
      .toEqual(["missing", "invalid", "observed-zero"]);
  });

  it("falls back from a non-finite factor to a finite supplementary embedding", () => {
    const candidate = fusedCandidate({
      objectId: "supplementary-fallback",
      fusedScore: 0.09,
      embedding: Number.NaN,
      contributions: { lexical_fts: 0.016 }
    });

    const scores = computeLightweightDeepHeadScores(
      [candidate],
      emptySupplementary({
        embeddingSimilarityScores: { "supplementary-fallback": 0.42 }
      })
    );

    expect(scores.get(candidate.fusion.candidate_key)).toBeCloseTo(0.42);
  });

  it("does not leak memory-keyed signals into same-id synthesis or global candidates", () => {
    const local = fusedCandidate({ objectId: "shared", fusedScore: 0.3 });
    const synthesisBase = fusedCandidate({ objectId: "shared", fusedScore: 0.2 });
    const globalBase = fusedCandidate({ objectId: "shared", fusedScore: 0.1 });
    const synthesis: DeliverySelectionCandidate = Object.freeze({
      ...synthesisBase,
      objectKind: "synthesis_capsule",
      fusion: Object.freeze({
        ...synthesisBase.fusion,
        candidate_key: "workspace_local:synthesis_capsule:shared"
      })
    });
    const global: DeliverySelectionCandidate = Object.freeze({
      ...globalBase,
      originPlane: "global",
      fusion: Object.freeze({
        ...globalBase.fusion,
        candidate_key: "global:memory_entry:shared"
      })
    });
    const scores = computeLightweightDeepHeadScores(
      [synthesis, global, local],
      emptySupplementary({
        embeddingSimilarityScores: { shared: 0.8 },
        evidenceFtsRanks: { shared: 1 },
        structuralScores: { shared: 1 },
        sourceProximityScores: { shared: 1 }
      })
    );

    expect(scores.get(local.fusion.candidate_key)).toBe(1);
    expect(scores.get(synthesis.fusion.candidate_key)).toBe(0);
    expect(scores.get(global.fusion.candidate_key)).toBe(0);
  });

  it("keeps query-supported fusion wins when emb is cold and agreement-gates conflict-only piles", () => {
    // Path rescue with a lexical foothold must keep fused mass; content-disjoint
    // path piles stay agreement-gated so they cannot lead over lexical hits.
    const lexicalRescue = fusedCandidate({
      objectId: "lexical-rescue",
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
      [seed, lexicalRescue, conflictOnly, lexicalPeer],
      emptySupplementary({
        evidenceFtsRanks: {
          "lexical-peer": 1,
          "lexical-rescue": 0.2,
          "path-seed": 0.3,
          "conflict-only": 0.01
        },
        structuralScores: {
          "lexical-peer": 1,
          "lexical-rescue": 0.2,
          "path-seed": 0.3,
          "conflict-only": 0.01
        }
      })
    );
    expect(scores.get(lexicalRescue.fusion.candidate_key)).toBeCloseTo(0.08);
    expect(scores.get(lexicalPeer.fusion.candidate_key)).toBeCloseTo(0.04);
    expect(scores.get(conflictOnly.fusion.candidate_key)!)
      .toBeLessThan(scores.get(lexicalPeer.fusion.candidate_key)!);

    const result = applyDeliverySelection(
      [seed, lexicalRescue, conflictOnly, lexicalPeer],
      scores,
      { replacePublicRelevance: false }
    );
    expect(result.orderedCandidates.map((candidate) => candidate.entry.object_id))
      .toEqual(["path-seed", "lexical-rescue", "lexical-peer", "conflict-only"]);
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
