import { describe, expect, it } from "vitest";

import {
  counterfactualDeliveredCandidateKeys,
  reconstructIndependentEmbeddingEvidenceComposition
} from
  "../../recall/delivery/selection-boundary/selection-boundary-counterfactual.js";
import { reconstructFineAssessmentComposition } from
  "../../recall/delivery/selection-boundary/selection-boundary-composition.js";
import {
  combineIndependentEmbeddingEvidence,
  resolveIndependentEmbeddingEvidenceAssessment
} from "../../recall/rerank/deep-head.js";
import {
  SELECTION_BOUNDARY_FIDELITY_MISMATCH
} from
  "../../recall/delivery/selection-boundary/selection-boundary-restore.js";
import type { FineAssessmentSelectionBoundaryCase } from
  "../../recall/delivery/selection-boundary/selection-boundary-types.js";
import { captureFineAssessmentSelectionBoundary } from
  "./selection-boundary-live-capture-fixture.js";
import {
  MemoryDimension,
  ScopeClass,
  type MemoryEntry,
  type RecallScoreFactors
} from "@do-soul/alaya-protocol";
import { buildEmptyRecallFusionBreakdown } from
  "../../recall/delivery/fusion-delivery-scoring.js";
import type { DeliverySelectionCandidate } from
  "../../recall/delivery/delivery-selection.js";
import type { RecallFusionBreakdown } from
  "../../recall/runtime/recall-service-types.js";
import { compileRecallQueryProbes } from
  "../../recall/query/recall-query-probes.js";

describe("independent embedding evidence operator", () => {
  it("uses probabilisticOr when embedding is observed and evidence alone when absent", () => {
    expect(combineIndependentEmbeddingEvidence(0.4, 0.5)).toBeCloseTo(0.7);
    expect(combineIndependentEmbeddingEvidence(null, 0.5)).toBe(0.5);
    expect(combineIndependentEmbeddingEvidence(0, 0.5)).toBe(0.5);
  });

  it("drops fusion cold-path fallback while matching embedding-observed current scores", () => {
    const cold = fusedCandidate({
      objectId: "cold",
      fusedScore: 0.4,
      contributions: { lexical_fts: 0.02 }
    });
    const embedded = fusedCandidate({
      objectId: "embedded",
      fusedScore: 0.2,
      embedding: 0.4
    });
    const assessment = resolveIndependentEmbeddingEvidenceAssessment({
      candidates: [cold, embedded],
      answerRelevanceScores: new Map(),
      supplementaryData: emptySupplementary({
        ftsRanks: { cold: 0.9, embedded: 0.81 },
        trigramFtsRanks: { cold: 0.81, embedded: 1 },
        evidenceFtsRanks: { embedded: 0.25 },
        structuralScores: { embedded: 1 }
      })
    });

    expect(assessment.traceByCandidateKey.get(cold.fusion.candidate_key))
      .toMatchObject({
        score_source: "evidence_only",
        fusion_baseline_used: false,
        resolved_score: expect.closeTo(Math.sqrt(0.9 * 0.81), 5)
      });
    expect(assessment.traceByCandidateKey.get(embedded.fusion.candidate_key))
      .toMatchObject({
        score_source: "embedding_evidence",
        fusion_baseline_used: false
      });
    expect(assessment.scores.get(embedded.fusion.candidate_key))
      .toBeCloseTo(0.97);
  });
});

describe("independent embedding evidence counterfactual composition", () => {
  it("runs without asserting CURRENT-path packet identity", () => {
    const boundary = captureFineAssessmentSelectionBoundary(
      "surface-selection-counterfactual"
    );
    const baseline = reconstructFineAssessmentComposition(boundary);
    const counterfactual =
      reconstructIndependentEmbeddingEvidenceComposition(boundary);

    expect(counterfactualDeliveredCandidateKeys(baseline.result))
      .toEqual(boundary.expected.candidate_keys);
    expect(
      [...counterfactual.deepHead.traceByCandidateKey.values()].every(
        (trace) => !trace.fusion_baseline_used
      )
    ).toBe(true);
  });

  it("fails loud when a token estimate was never captured live", () => {
    const boundary = captureFineAssessmentSelectionBoundary(
      "surface-selection-counterfactual-tokens"
    );
    const stripped: FineAssessmentSelectionBoundaryCase = {
      ...boundary,
      input: {
        ...boundary.input,
        token_estimates_by_content: []
      }
    };

    expect(() => reconstructIndependentEmbeddingEvidenceComposition(stripped))
      .toThrow(SELECTION_BOUNDARY_FIDELITY_MISMATCH);
  });
});

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
    ...(input.embedding === undefined
      ? {}
      : { embedding_similarity: input.embedding })
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
  readonly ftsRanks?: Record<string, number>;
  readonly trigramFtsRanks?: Record<string, number>;
  readonly evidenceFtsRanks?: Record<string, number>;
  readonly structuralScores?: Record<string, number>;
  readonly sourceProximityScores?: Record<string, number>;
} = {}) {
  return {
    queryProbes: compileRecallQueryProbes(null),
    embeddingSimilarityScores: overrides.embeddingSimilarityScores ?? {},
    evidenceSemanticScoresByCandidateKey: new Map<string, number>(),
    ftsRanks: overrides.ftsRanks ?? {},
    trigramFtsRanks: overrides.trigramFtsRanks ?? {},
    evidenceFtsRanks: overrides.evidenceFtsRanks ?? {},
    structuralScores: overrides.structuralScores ?? {},
    sourceProximityScores: overrides.sourceProximityScores ?? {}
  };
}
