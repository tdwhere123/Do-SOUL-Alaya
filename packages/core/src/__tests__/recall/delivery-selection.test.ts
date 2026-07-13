import { describe, expect, it } from "vitest";
import {
  MemoryDimension,
  ScopeClass,
  type MemoryEntry,
  type RecallScoreFactors
} from "@do-soul/alaya-protocol";
import { applyDeliverySelection, type DeliverySelectionCandidate } from "../../recall/delivery/delivery-selection.js";
import { buildEmptyRecallFusionBreakdown } from "../../recall/delivery/fusion-delivery-scoring.js";
import type {
  RecallFusionBreakdown,
  RecallFusionStream
} from "../../recall/runtime/recall-service-types.js";

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

const EMPTY_FACTORS = {} as RecallScoreFactors;

function fusedCandidate(input: {
  readonly objectId: string;
  readonly fusedScore: number;
  readonly fusedRank?: number;
  readonly effectiveScore?: number;
  readonly surfaceId?: string | null;
  readonly streamRanks?: Partial<Record<RecallFusionStream, number | null>>;
}): DeliverySelectionCandidate {
  const breakdown = buildEmptyRecallFusionBreakdown(input.objectId);
  const fusion: RecallFusionBreakdown = Object.freeze({
    ...breakdown,
    fused_rank: input.fusedRank ?? breakdown.fused_rank,
    fused_score: input.fusedScore,
    per_stream_rank: Object.freeze({
      ...breakdown.per_stream_rank,
      ...(input.streamRanks ?? {})
    })
  });
  return Object.freeze({
    entry: memory({
      object_id: input.objectId,
      surface_id: input.surfaceId ?? null
    }),
    effectiveScore: input.effectiveScore ?? input.fusedScore,
    effectiveFactors: EMPTY_FACTORS,
    fusion
  });
}

describe("applyDeliverySelection", () => {
  it("keeps fused relevance order across repeated sessions", () => {
    const sameSession = Array.from({ length: 5 }, (_, index) =>
      fusedCandidate({
        objectId: `same-${index + 1}`,
        fusedScore: 1 - index * 0.01,
        surfaceId: "repeated-session"
      })
    );
    const independent = fusedCandidate({
      objectId: "independent",
      fusedScore: 0.95,
      surfaceId: "independent-session"
    });

    const result = applyDeliverySelection([...sameSession, independent]);

    expect(result.orderedCandidates.map((candidate) => candidate.entry.object_id))
      .toEqual([...sameSession, independent].map((candidate) => candidate.entry.object_id));
    expect(result.rankByCandidateKey.get("workspace_local:memory_entry:independent")).toBe(6);
  });

  it("retains fusion order when the top-K sessions are distinct", () => {
    const candidates = [
      fusedCandidate({ objectId: "third", fusedScore: 0.7, surfaceId: "sC" }),
      fusedCandidate({ objectId: "first", fusedScore: 1, surfaceId: "sA" }),
      fusedCandidate({ objectId: "second", fusedScore: 0.8, surfaceId: "sB" })
    ];

    const result = applyDeliverySelection(candidates);

    expect(result.orderedCandidates.map((candidate) => candidate.entry.object_id))
      .toEqual(["first", "second", "third"]);
  });

  it("preserves core relevance scores", () => {
    const ordered = [
      fusedCandidate({ objectId: "a1", fusedScore: 1, effectiveScore: 0.91, surfaceId: "sA" }),
      ...Array.from({ length: 6 }, (_, index) =>
        fusedCandidate({
          objectId: `a${index + 2}`,
          fusedScore: 0.5,
          effectiveScore: 0.5,
          surfaceId: "sA"
        })
      ),
      fusedCandidate({ objectId: "b8", fusedScore: 0.7, effectiveScore: 0.7, surfaceId: "sB" })
    ];
    const beforeScores = new Map(
      ordered.map((candidate) => [candidate.entry.object_id, {
        effective: candidate.effectiveScore,
        fused: candidate.fusion.fused_score
      }] as const)
    );
    const result = applyDeliverySelection(ordered);
    for (const candidate of result.orderedCandidates) {
      expect(candidate.effectiveScore).toBe(beforeScores.get(candidate.entry.object_id)?.effective);
      expect(candidate.fusion.fused_score).toBe(beforeScores.get(candidate.entry.object_id)?.fused);
    }
    expect(result.orderedCandidates.slice(0, 2).map((c) => c.entry.object_id)).toEqual(["a1", "b8"]);
  });

  it("orders only by the fused scalar when a stale alias disagrees", () => {
    const fusedWinner = fusedCandidate({ objectId: "fused-winner", fusedScore: 0.9 });
    const staleAliasWinner = {
      ...fusedCandidate({ objectId: "alias-winner", fusedScore: 0.4 }),
      finalRelevanceScore: 1
    };

    const result = applyDeliverySelection([staleAliasWinner, fusedWinner]);

    expect(result.orderedCandidates[0]?.entry.object_id)
      .toBe("fused-winner");
  });

  it("is permutation-stable", () => {
    const candidates = [
      fusedCandidate({ objectId: "a", fusedScore: 1, surfaceId: "same" }),
      fusedCandidate({ objectId: "b", fusedScore: 0.99, surfaceId: "same" }),
      fusedCandidate({ objectId: "c", fusedScore: 0.98, surfaceId: "same" }),
      fusedCandidate({ objectId: "d", fusedScore: 0.97, surfaceId: "other" })
    ];
    const expected = applyDeliverySelection(candidates).orderedCandidates
      .map((candidate) => candidate.entry.object_id);

    const actual = applyDeliverySelection([candidates[2]!, candidates[0]!, candidates[3]!, candidates[1]!])
      .orderedCandidates.map((candidate) => candidate.entry.object_id);

    expect(actual).toEqual(expected);
  });

  it("uses candidate identity as the deterministic tie break", () => {
    const candidates = [
      fusedCandidate({ objectId: "b", fusedScore: 0.9, surfaceId: "same" }),
      fusedCandidate({ objectId: "c", fusedScore: 0.9, surfaceId: "other" }),
      fusedCandidate({ objectId: "a", fusedScore: 0.9, surfaceId: "same" })
    ];
    const first = applyDeliverySelection(candidates).orderedCandidates
      .map((candidate) => candidate.entry.object_id);
    const second = applyDeliverySelection([candidates[2]!, candidates[0]!, candidates[1]!])
      .orderedCandidates.map((candidate) => candidate.entry.object_id);

    expect(first).toEqual(["a", "b", "c"]);
    expect(second).toEqual(first);
  });

  it("keeps fused rank-1 first while exposing stage rank diagnostics", () => {
    const ordered = [
      fusedCandidate({ objectId: "a1", fusedScore: 1, surfaceId: "sA" }),
      fusedCandidate({ objectId: "b2", fusedScore: 0.8, surfaceId: "sB" })
    ];
    const result = applyDeliverySelection(ordered);
    expect(result.orderedCandidates[0]?.entry.object_id).toBe("a1");
    expect(result.rankByCandidateKey.get("workspace_local:memory_entry:a1")).toBe(1);
  });

  it("does not let auxiliary stream ranks override fusion order", () => {
    const ordered = [
      fusedCandidate({ objectId: "a1", fusedRank: 1, fusedScore: 1 }),
      fusedCandidate({ objectId: "a2", fusedRank: 2, fusedScore: 0.9 }),
      fusedCandidate({ objectId: "a3", fusedRank: 3, fusedScore: 0.8 }),
      fusedCandidate({ objectId: "a4", fusedRank: 4, fusedScore: 0.7 }),
      fusedCandidate({
        objectId: "weak-rank-5",
        fusedRank: 5,
        fusedScore: 0.6,
        streamRanks: {
          lexical_fts: 12,
          embedding_similarity: 12,
          evidence_fts: 12
        }
      }),
      fusedCandidate({
        objectId: "likelihood-rank-6",
        fusedRank: 6,
        fusedScore: 0.5,
        streamRanks: {
          lexical_fts: 3,
          embedding_similarity: 1,
          evidence_fts: 30
        }
      })
    ];

    const result = applyDeliverySelection(ordered);

    expect(result.orderedCandidates.slice(0, 6).map((c) => c.entry.object_id)).toEqual([
      "a1",
      "a2",
      "a3",
      "a4",
      "weak-rank-5",
      "likelihood-rank-6"
    ]);
    expect(result.rankByCandidateKey.get("workspace_local:memory_entry:likelihood-rank-6")).toBe(6);
    expect(result.rankByCandidateKey.get("workspace_local:memory_entry:weak-rank-5")).toBe(5);
  });

  it("preserves provenance representations and their fusion ranks for admission", () => {
    const preferred = fusedCandidate({ objectId: "shared", fusedScore: 0.9 });
    const alternateBase = fusedCandidate({ objectId: "shared", fusedScore: 0.8 });
    const alternate = Object.freeze({
      ...alternateBase,
      originPlane: "evidence" as const,
      fusion: Object.freeze({
        ...alternateBase.fusion,
        candidate_key: "evidence:memory_entry:shared"
      })
    });
    const nextUnique = fusedCandidate({ objectId: "next", fusedScore: 0.7 });

    const result = applyDeliverySelection([nextUnique, alternate, preferred]);

    expect(result.orderedCandidates.map((candidate) => candidate.entry.object_id))
      .toEqual(["shared", "shared", "next"]);
    expect(result.rankByCandidateKey.get("workspace_local:memory_entry:shared")).toBe(1);
    expect(result.rankByCandidateKey.get("evidence:memory_entry:shared")).toBe(2);
  });

  it("lets a complete query-conditioned score own order and final relevance", () => {
    const fusedFirst = fusedCandidate({ objectId: "fused-first", fusedScore: 0.9 });
    const answerFirst = fusedCandidate({ objectId: "answer-first", fusedScore: 0.4 });
    const answerScores = new Map([
      [fusedFirst.fusion.candidate_key, 0.2],
      [answerFirst.fusion.candidate_key, 0.8]
    ]);

    const result = applyDeliverySelection([fusedFirst, answerFirst], answerScores);

    expect(result.orderedCandidates.map((candidate) => candidate.entry.object_id))
      .toEqual(["answer-first", "fused-first"]);
    expect(result.finalRelevanceByCandidateKey.get(answerFirst.fusion.candidate_key)).toBe(0.8);
    expect(result.answerRelevanceRankByCandidateKey.get(answerFirst.fusion.candidate_key)).toBe(1);
  });

  it("falls back byte-for-byte to fusion order when answer scores are absent", () => {
    const candidates = [
      fusedCandidate({ objectId: "second", fusedScore: 0.4 }),
      fusedCandidate({ objectId: "first", fusedScore: 0.9 })
    ];

    const result = applyDeliverySelection(candidates, new Map());

    expect(result.orderedCandidates.map((candidate) => candidate.entry.object_id))
      .toEqual(["first", "second"]);
    expect(result.finalRelevanceByCandidateKey.get(candidates[1]!.fusion.candidate_key)).toBe(0.9);
    expect(result.answerRelevanceRankByCandidateKey).toEqual(new Map());
  });

});
