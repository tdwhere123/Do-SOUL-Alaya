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
  readonly effectiveScore?: number;
  readonly surfaceId?: string | null;
}): DeliverySelectionCandidate {
  const breakdown = buildEmptyRecallFusionBreakdown(input.objectId);
  const fusion: RecallFusionBreakdown = Object.freeze({
    ...breakdown,
    fused_score: input.fusedScore
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
  });
});
