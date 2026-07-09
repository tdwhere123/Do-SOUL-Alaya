import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MemoryDimension,
  ScopeClass,
  type MemoryEntry,
  type RecallScoreFactors
} from "@do-soul/alaya-protocol";
import { applyDeliverySelection, type DeliverySelectionCandidate } from "../../recall/delivery/delivery-selection.js";
import { buildEmptyRecallFusionBreakdown } from "../../recall/delivery/fusion-delivery-scoring.js";
import { compileRecallQueryProbes } from "../../recall/query/recall-query-probes.js";
import type {
  RecallFusionBreakdown,
  RecallFusionStream,
  RecallSupplementaryData
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

function supplementary(): RecallSupplementaryData {
  return {
    queryProbes: compileRecallQueryProbes(null),
    ftsRanks: {},
    trigramFtsRanks: {},
    synthesisFtsRanks: {},
    evidenceFtsRanks: {},
    evidenceGistsByMemoryId: {},
    sourceProximityScores: {},
    sourceCohortKeys: {},
    structuralScores: {},
    graphExpansionScores: {},
    entitySeedScores: {},
    pathExpansionScores: {},
    pathSuppressionScores: {},
    embeddingSimilarityScores: {},
    graphSupportCounts: {}
  } as unknown as RecallSupplementaryData;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("applyDeliverySelection", () => {
  it("reorders within the delivery window without mutating core relevance scores", () => {
    vi.stubEnv("ALAYA_RECALL_COVERAGE_SELECTOR", "1");
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
      ordered.map((candidate) => [candidate.entry.object_id, candidate.effectiveScore] as const)
    );
    const result = applyDeliverySelection(ordered, supplementary(), 10);
    for (const candidate of result.ordering.deliveryOrderedCandidates) {
      expect(candidate.effectiveScore).toBe(beforeScores.get(candidate.entry.object_id));
    }
    expect(result.ordering.deliveryOrderedCandidates.slice(0, 5).map((c) => c.entry.object_id)).toContain("b8");
    expect(result.ranks.coverageSelectorNoop).toBe(false);
  });

  it("keeps fused rank-1 first while exposing stage rank diagnostics", () => {
    vi.stubEnv("ALAYA_RECALL_COVERAGE_SELECTOR", "1");
    const ordered = [
      fusedCandidate({ objectId: "a1", fusedScore: 1, surfaceId: "sA" }),
      fusedCandidate({ objectId: "b2", fusedScore: 0.8, surfaceId: "sB" })
    ];
    const result = applyDeliverySelection(ordered, supplementary(), 10);
    expect(result.ordering.deliveryOrderedCandidates[0]?.entry.object_id).toBe("a1");
    expect(result.ranks.rankAfterFusion.get("workspace_local:memory_entry:a1")).toBe(1);
    // session_coverage remains an identity diagnostic slot (noop), not a reorder stage.
    expect(result.ranks.sessionCoverageNoop).toBe(true);
    expect(result.ordering.coverageOrderedCandidates).toBe(result.ordering.coverageSelectedCandidates);
  });

  it("rescues a rank-6 candidate with two strong likelihood streams over a weak rank-5", () => {
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

    const result = applyDeliverySelection(ordered, supplementary(), 10);

    expect(result.ordering.deliveryOrderedCandidates.slice(0, 6).map((c) => c.entry.object_id)).toEqual([
      "a1",
      "a2",
      "a3",
      "a4",
      "likelihood-rank-6",
      "weak-rank-5"
    ]);
    expect(result.ranks.rankAfterStructuralReserve.get("workspace_local:memory_entry:likelihood-rank-6")).toBe(5);
    expect(result.ranks.rankAfterStructuralReserve.get("workspace_local:memory_entry:weak-rank-5")).toBe(6);
  });

  it("I1 fusion-rank floor blocks likelihood rescue from displacing fused_rank≤5", () => {
    vi.stubEnv("ALAYA_RECALL_FUSION_RANK_FLOOR", "1");
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

    const result = applyDeliverySelection(ordered, supplementary(), 10);

    expect(result.ordering.deliveryOrderedCandidates.slice(0, 6).map((c) => c.entry.object_id)).toEqual([
      "a1",
      "a2",
      "a3",
      "a4",
      "weak-rank-5",
      "likelihood-rank-6"
    ]);
  });

  it("does not rescue a tail candidate with only one strong likelihood stream", () => {
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
        objectId: "single-stream-rank-6",
        fusedRank: 6,
        fusedScore: 0.5,
        streamRanks: {
          lexical_fts: 1,
          embedding_similarity: 20,
          evidence_fts: 20
        }
      })
    ];

    const result = applyDeliverySelection(ordered, supplementary(), 10);

    expect(result.ordering.deliveryOrderedCandidates.slice(0, 6).map((c) => c.entry.object_id)).toEqual([
      "a1",
      "a2",
      "a3",
      "a4",
      "weak-rank-5",
      "single-stream-rank-6"
    ]);
  });
});
