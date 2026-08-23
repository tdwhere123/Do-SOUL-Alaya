import {
  MemoryDimension,
  ScopeClass,
  type MemoryEntry,
  type RecallScoreFactors
} from "@do-soul/alaya-protocol";
import type { DeliverySelectionCandidate } from
  "../../../recall/delivery/delivery-selection.js";
import { buildEmptyRecallFusionBreakdown } from
  "../../../recall/delivery/fusion-delivery-scoring.js";
import { compileRecallQueryProbes } from
  "../../../recall/query/recall-query-probes.js";
import type { RecallFusionBreakdown } from
  "../../../recall/runtime/recall-service-types.js";

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

export function fusedCandidate(input: {
  readonly objectId: string;
  readonly fusedScore: number;
  readonly fusedRank?: number;
  readonly embedding?: number;
  readonly evidenceFts?: number;
  readonly objectKind?: "memory_entry" | "evidence_capsule";
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
  const objectKind = input.objectKind ?? "memory_entry";
  return Object.freeze({
    entry: memory({ object_id: input.objectId }),
    objectKind,
    effectiveScore: input.fusedScore,
    effectiveFactors: factors,
    fusion
  });
}

export function emptySupplementary(overrides: {
  readonly embeddingSimilarityScores?: Record<string, number>;
  readonly ftsRanks?: Record<string, number>;
  readonly trigramFtsRanks?: Record<string, number>;
  readonly evidenceFtsRanks?: Record<string, number>;
  readonly structuralScores?: Record<string, number>;
  readonly sourceProximityScores?: Record<string, number>;
} = {}) {
  return {
    queryProbes: compileRecallQueryProbes(null),
    embeddingSimilarityScores: overrides.embeddingSimilarityScores ?? {},
    evidenceSemanticActivationsByCandidateKey: new Map(),
    ftsRanks: overrides.ftsRanks ?? {},
    trigramFtsRanks: overrides.trigramFtsRanks ?? {},
    evidenceFtsRanks: overrides.evidenceFtsRanks ?? {},
    structuralScores: overrides.structuralScores ?? {},
    sourceProximityScores: overrides.sourceProximityScores ?? {}
  };
}
