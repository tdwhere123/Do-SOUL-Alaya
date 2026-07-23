import type { RecallScoreFactors } from "@do-soul/alaya-protocol";
import { describe, expect, it } from "vitest";
import type { DeliverySelectionCandidate } from
  "../../../recall/delivery/delivery-selection.js";
import { buildEmptyRecallFusionBreakdown } from
  "../../../recall/delivery/fusion-delivery-scoring.js";
import { compileRecallQueryProbes } from
  "../../../recall/query/recall-query-probes.js";
import { computeLightweightDeepHeadScores } from
  "../../../recall/rerank/deep-head.js";
import type {
  RecallFusionStreamContributions,
  RecallFusionStreamRanks
} from "../../../recall/runtime/recall-service-types.js";
import { createMemoryEntry } from "../recall-service-test-fixtures.js";

describe("deep-head query-evidence contract", () => {
  it("preserves a global candidate's own query evidence in an embedding-active pool", () => {
    const local = candidate("local", 0.4, { embedding_similarity: 0.02 }, 0.8);
    const globalSubject = candidate(
      "global-subject", 0.7, { subject_alignment: 0.02 }, undefined, "global"
    );
    const globalPrior = candidate(
      "global-prior", 0.9, { existing_score: 0.02 }, undefined, "global"
    );

    const scores = computeLightweightDeepHeadScores(
      [local, globalSubject, globalPrior],
      supplementary(null)
    );

    expect(scores.get(globalSubject.fusion.candidate_key)).toBeCloseTo(0.7);
    expect(scores.get(globalPrior.fusion.candidate_key)).toBe(0);
  });

  it("treats temporal contribution as query evidence only for a temporal query", () => {
    const local = candidate("local", 0.4, {}, 0.8);
    const temporal = candidate(
      "global-temporal", 0.6, { temporal_recency: 0.02 }, undefined, "global"
    );

    const ordinaryScores = computeLightweightDeepHeadScores(
      [local, temporal],
      supplementary(null)
    );
    const temporalScores = computeLightweightDeepHeadScores(
      [local, temporal],
      supplementary("what happened yesterday")
    );

    expect(ordinaryScores.get(temporal.fusion.candidate_key)).toBe(0);
    expect(temporalScores.get(temporal.fusion.candidate_key)).toBeCloseTo(0.6);
  });

  it("does not let subject alignment preserve fused mass in an embedding-cold pool", () => {
    const direct = candidate(
      "direct",
      0.4,
      { lexical_fts: 0.02 },
      undefined,
      "workspace_local",
      { lexical_fts: 1 }
    );
    const contextual = candidate(
      "contextual",
      0.9,
      { subject_alignment: 0.02 },
      undefined,
      "workspace_local",
      { subject_alignment: 1 }
    );

    const scores = computeLightweightDeepHeadScores(
      [direct, contextual],
      {
        ...supplementary(null),
        ftsRanks: { direct: 0.9 },
        trigramFtsRanks: { direct: 0.81 }
      }
    );

    expect(scores.get(direct.fusion.candidate_key)).toBeCloseTo(0.4);
    expect(scores.get(contextual.fusion.candidate_key)).toBe(0);
  });

  it("keeps embedding-cold fused mass inside the delivery head", () => {
    const head = candidate(
      "head",
      0.4,
      { lexical_fts: 0.02 },
      undefined,
      "workspace_local",
      { lexical_fts: 2 }
    );
    const tail = candidate(
      "tail",
      0.9,
      { evidence_fts: 0.02 },
      undefined,
      "workspace_local",
      { evidence_fts: 3 }
    );

    const scores = computeLightweightDeepHeadScores(
      [head, tail],
      supplementary(null),
      2
    );

    expect(scores.get(head.fusion.candidate_key)).toBeCloseTo(0.4);
    expect(scores.get(tail.fusion.candidate_key)).toBe(0);
  });
});

function candidate(
  objectId: string,
  fusedScore: number,
  contributions: Partial<RecallFusionStreamContributions>,
  embedding?: number,
  originPlane: "workspace_local" | "global" = "workspace_local",
  ranks: Partial<RecallFusionStreamRanks> = {}
): DeliverySelectionCandidate {
  const breakdown = buildEmptyRecallFusionBreakdown(objectId);
  return Object.freeze({
    entry: createMemoryEntry({ object_id: objectId }),
    originPlane,
    effectiveScore: fusedScore,
    effectiveFactors: Object.freeze({
      ...(embedding === undefined ? {} : { embedding_similarity: embedding })
    }) as RecallScoreFactors,
    fusion: Object.freeze({
      ...breakdown,
      candidate_key: `${originPlane}:memory_entry:${objectId}`,
      origin_plane: originPlane,
      fused_score: fusedScore,
      fused_rank_contribution_per_stream: Object.freeze({
        ...breakdown.fused_rank_contribution_per_stream,
        ...contributions
      }),
      per_stream_rank: Object.freeze({
        ...breakdown.per_stream_rank,
        ...ranks
      })
    })
  });
}

function supplementary(queryText: string | null) {
  return {
    queryProbes: compileRecallQueryProbes(queryText),
    embeddingSimilarityScores: {},
    ftsRanks: {},
    trigramFtsRanks: {},
    evidenceFtsRanks: {},
    structuralScores: {},
    sourceProximityScores: {}
  };
}
