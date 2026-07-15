import { describe, expect, it } from "vitest";
import type { RecallPolicy } from "@do-soul/alaya-protocol";

import {
  buildFusionCandidateStreamSnapshots
} from "../../recall/delivery/fusion-delivery-scoring-snapshot.js";
import { buildRecallFusionDetails } from "../../recall/delivery/fusion-delivery-scoring.js";
import {
  activeFusionStreams,
  RECALL_FUSION_DEFAULT_WEIGHTS
} from "../../recall/delivery/fusion-delivery-streams.js";
import { countFamiliesWithHits } from "../../recall/delivery/fusion-delivery-families.js";
import { compileRecallQueryProbes } from "../../recall/query/recall-query-probes.js";
import type {
  RecallFusionStream,
  RecallSupplementaryData
} from "../../recall/runtime/recall-service-types.js";
import type { KeyedRecallFusionCandidate } from "../../recall/delivery/fusion-delivery-scoring-candidate.js";
import {
  resolveRrfFusionWeights,
  type ResolvedRecallFusionWeights
} from "../../recall/delivery/fusion-delivery-adaptive-scoring.js";
import { createMemoryEntry } from "./recall-service-test-fixtures.js";

const CANDIDATE_ID = "11111111-1111-4111-8111-111111111111";
const CANDIDATE_KEY = `workspace_local:memory_entry:${CANDIDATE_ID}`;

function candidate(objectId = CANDIDATE_ID): KeyedRecallFusionCandidate {
  return {
    candidateKey: `workspace_local:memory_entry:${objectId}`,
    candidate: {
      entry: createMemoryEntry({
        object_id: objectId,
        content: "Materializationrouter evidence for the same deployment topic."
      }),
      effectiveScore: 0,
      effectiveFactors: { activation: 0, relevance: 0, embedding_similarity: 1 },
      structuralScore: 1
    }
  };
}

function supplementaryData(objectIds: readonly string[]): RecallSupplementaryData {
  return {
    queryProbes: compileRecallQueryProbes("materializationrouter deployment evidence"),
    ftsRanks: Object.fromEntries(objectIds.map((id) => [id, 1])),
    trigramFtsRanks: Object.fromEntries(objectIds.map((id) => [id, 1])),
    synthesisFtsRanks: {},
    evidenceFtsRanks: Object.fromEntries(objectIds.map((id) => [id, 1])),
    sourceProximityScores: {},
    sourceCohortKeys: {},
    structuralScores: Object.fromEntries(objectIds.map((id) => [id, 1])),
    graphExpansionScores: {},
    entitySeedScores: {},
    pathExpansionScores: {},
    pathSuppressionScores: {},
    embeddingSimilarityScores: {},
    graphSupportCounts: {},
    budgetPenaltyFactor: 0,
    plasticityFactors: {},
    graphAndPathColdScore: 0,
    recallsEdgeCount: 0,
    weightTransferAmount: 0,
    evidenceGistsByMemoryId: {},
    governanceCeilingByMemoryId: {}
  };
}

function equalizedWeights(): ResolvedRecallFusionWeights {
  const weights = Object.fromEntries(activeFusionStreams().map((stream) => [stream, 1])) as Record<RecallFusionStream, number>;
  const kByStream = Object.fromEntries(activeFusionStreams().map((stream) => [stream, 1])) as Record<RecallFusionStream, number>;
  return { weights, kByStream };
}

function snapshots(
  candidates: readonly KeyedRecallFusionCandidate[],
  ranks: Readonly<Partial<Record<RecallFusionStream, Readonly<Record<string, number>>>>>,
  resolved: ResolvedRecallFusionWeights = equalizedWeights()
) {
  const ranksByStream = new Map(
    activeFusionStreams().map((stream) => [
      stream,
      new Map(Object.entries(ranks[stream] ?? {}))
    ] as const)
  );
  return buildFusionCandidateStreamSnapshots({
    candidates,
    ranksByStream,
    resolved,
    supplementaryData: supplementaryData(candidates.map(({ candidate: value }) => value.entry.object_id))
  });
}

function contributionTotal(contributions: Readonly<Record<RecallFusionStream, number>>): number {
  return Object.values(contributions).reduce((sum, contribution) => sum + contribution, 0);
}

describe("fusion family decorrelation", () => {
  it("collapses correlated lexical duplicates into one family vote", () => {
    const lexicalOnly = snapshots([candidate()], {
      lexical_fts: { [CANDIDATE_KEY]: 1 }
    })[0]!;
    const fourLexicalLanes = snapshots([candidate()], {
      lexical_fts: { [CANDIDATE_KEY]: 1 },
      trigram_fts: { [CANDIDATE_KEY]: 1 },
      synthesis_fts: { [CANDIDATE_KEY]: 1 },
      evidence_fts: { [CANDIDATE_KEY]: 1 }
    })[0]!;

    expect(fourLexicalLanes.contributions.lexical_fts).toBeCloseTo(0.5, 12);
    expect(fourLexicalLanes.contributions.trigram_fts).toBeCloseTo(0.5, 12);
    expect(fourLexicalLanes.contributions.synthesis_fts).toBeCloseTo(0.5, 12);
    expect(fourLexicalLanes.contributions.evidence_fts).toBeCloseTo(0.5, 12);
    // Raw lane sum would be 2.0; family max yields one lexical vote matching a single lane.
    expect(contributionTotal(fourLexicalLanes.contributions)).toBeCloseTo(2, 12);
    expect(fourLexicalLanes.objectBase).toBeCloseTo(lexicalOnly.objectBase, 12);
    expect(fourLexicalLanes.objectBase).toBeCloseTo(0.5, 12);
  });

  it("counts at most one vote per orthogonal family across structural and graph piles", () => {
    const value = snapshots([candidate()], {
      evidence_fts: { [CANDIDATE_KEY]: 1 },
      evidence_structural_agreement: { [CANDIDATE_KEY]: 1 },
      source_evidence_agreement: { [CANDIDATE_KEY]: 1 },
      source_proximity: { [CANDIDATE_KEY]: 1 },
      path_expansion: { [CANDIDATE_KEY]: 1 },
      graph_expansion: { [CANDIDATE_KEY]: 1 },
      structural: { [CANDIDATE_KEY]: 1 },
      subject_alignment: { [CANDIDATE_KEY]: 1 },
      existing_score: { [CANDIDATE_KEY]: 1 }
    })[0]!;

    // lexical + structural + graph_path + temporal_facet(subject_alignment) → 4 family votes.
    expect(value.objectBase).toBeCloseTo(2, 12);
    expect(contributionTotal(value.contributions)).toBeCloseTo(4.5, 12);
  });

  it("retains weak lexical corroboration when trigram contribution is stronger", () => {
    const resolved = equalizedWeights();
    const weights = { ...resolved.weights, trigram_fts: 2 };
    const value = snapshots([candidate()], {
      lexical_fts: { [CANDIDATE_KEY]: 1 },
      trigram_fts: { [CANDIDATE_KEY]: 1 }
    }, { ...resolved, weights })[0]!;

    expect(value.contributions.lexical_fts).toBeCloseTo(0.5, 12);
    expect(value.contributions.trigram_fts).toBeCloseTo(1, 12);
    // Family vote takes the stronger member, not the sum.
    expect(value.objectBase).toBeCloseTo(1, 12);
  });

  it("retains both projections when their contributions tie", () => {
    const value = snapshots([candidate()], {
      lexical_fts: { [CANDIDATE_KEY]: 1 },
      trigram_fts: { [CANDIDATE_KEY]: 1 }
    })[0]!;

    expect(value.contributions.lexical_fts).toBeCloseTo(0.5, 12);
    expect(value.contributions.trigram_fts).toBeCloseTo(0.5, 12);
    expect(value.objectBase).toBeCloseTo(0.5, 12);
  });

  it("is invariant to candidate permutation", () => {
    const secondId = "22222222-2222-4222-8222-222222222222";
    const secondKey = `workspace_local:memory_entry:${secondId}`;
    const ranks = {
      lexical_fts: { [CANDIDATE_KEY]: 1, [secondKey]: 2 },
      trigram_fts: { [CANDIDATE_KEY]: 2, [secondKey]: 1 }
    } as const;
    const forward = byCandidateKey(snapshots([candidate(), candidate(secondId)], ranks));
    const reversed = byCandidateKey(snapshots([candidate(secondId), candidate()], ranks));

    expect(reversed).toEqual(forward);
  });

  it("does not change a candidate when an unrelated pool member has no family rank", () => {
    const unrelatedId = "33333333-3333-4333-8333-333333333333";
    const ranks = {
      lexical_fts: { [CANDIDATE_KEY]: 1 },
      trigram_fts: { [CANDIDATE_KEY]: 1 }
    } as const;
    const baseline = snapshots([candidate()], ranks)[0]!;
    const withUnrelated = snapshots([candidate(), candidate(unrelatedId)], ranks)
      .find(({ candidateKey }) => candidateKey === CANDIDATE_KEY)!;

    expect(streamView(withUnrelated)).toEqual(streamView(baseline));
  });

  it("honors default and explicit fusion weight semantics for both views", () => {
    const queryProbes = supplementaryData([CANDIDATE_ID]).queryProbes;
    const defaults = resolveRrfFusionWeights({
      policy: {} as RecallPolicy,
      queryProbes,
      streams: activeFusionStreams(),
      baseWeights: RECALL_FUSION_DEFAULT_WEIGHTS
    });
    const overridden = resolveRrfFusionWeights({
      policy: {
        scoring_weight_overrides: {
          fusion_weights: { lexical_fts: 0, trigram_fts: 9 }
        }
      } as unknown as RecallPolicy,
      queryProbes,
      streams: activeFusionStreams(),
      baseWeights: RECALL_FUSION_DEFAULT_WEIGHTS
    });
    const ranks = {
      lexical_fts: { [CANDIDATE_KEY]: 1 },
      trigram_fts: { [CANDIDATE_KEY]: 1 }
    } as const;
    const defaultValue = snapshots([candidate()], ranks, defaults)[0]!;
    const overrideValue = snapshots([candidate()], ranks, overridden)[0]!;

    expect(defaultValue.contributions.lexical_fts).toBeGreaterThan(0);
    expect(defaultValue.contributions.trigram_fts).toBeGreaterThan(0);
    expect(defaultValue.objectBase).toBeCloseTo(
      Math.max(defaultValue.contributions.lexical_fts, defaultValue.contributions.trigram_fts),
      12
    );
    expect(overrideValue.contributions.lexical_fts).toBe(0);
    expect(overrideValue.contributions.trigram_fts).toBeGreaterThan(0);
    expect(overrideValue.objectBase).toBeCloseTo(overrideValue.contributions.trigram_fts, 12);
  });

  it("reports fusion_families_with_hits as family count (~5), not raw lane count", () => {
    const value = snapshots([candidate()], {
      lexical_fts: { [CANDIDATE_KEY]: 1 },
      trigram_fts: { [CANDIDATE_KEY]: 1 },
      evidence_fts: { [CANDIDATE_KEY]: 1 },
      synthesis_fts: { [CANDIDATE_KEY]: 1 },
      structural: { [CANDIDATE_KEY]: 1 },
      evidence_structural_agreement: { [CANDIDATE_KEY]: 1 },
      embedding_similarity: { [CANDIDATE_KEY]: 1 },
      path_expansion: { [CANDIDATE_KEY]: 1 },
      graph_expansion: { [CANDIDATE_KEY]: 1 },
      facet_overlap: { [CANDIDATE_KEY]: 1 }
    })[0]!;

    const familyHits = countFamiliesWithHits([{ per_stream_rank: value.perStreamRank }]);
    expect(familyHits).toBe(5);
    expect(familyHits).toBeLessThanOrEqual(5);
  });
});

function policyWithDeliveryHead(maxEntries: number): RecallPolicy {
  return {
    fine_assessment: {
      conflict_awareness: false,
      budgets: {
        max_entries: maxEntries,
        max_total_tokens: 1_000,
        per_dimension_limits: null
      }
    }
  } as unknown as RecallPolicy;
}

describe("delivery-budget-independent fusion", () => {
  it("keeps all fusion contributions independent of the later delivery budget", () => {
    const semanticIds = [
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa01",
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa02",
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa03"
    ] as const;
    const conflictId = semanticIds[2];
    const embeddingSimilarityScores = Object.fromEntries(
      semanticIds.map((id, index) => [id, 0.9 - index * 0.1])
    );
    const support: RecallSupplementaryData = {
      ...supplementaryData(semanticIds),
      ftsRanks: {},
      trigramFtsRanks: {},
      evidenceFtsRanks: { [conflictId]: 1 },
      structuralScores: { [conflictId]: 1 },
      graphExpansionScores: { [conflictId]: 1 },
      pathExpansionScores: { [conflictId]: 1 },
      embeddingSimilarityScores
    };
    const candidates = semanticIds.map((objectId) => ({
      entry: createMemoryEntry({ object_id: objectId }),
      effectiveScore: objectId === conflictId ? 1 : 0,
      effectiveFactors: {
        activation: 0,
        relevance: 0,
        embedding_similarity: embeddingSimilarityScores[objectId] ?? 0
      },
      structuralScore: objectId === conflictId ? 1 : 0
    }));
    const run = (maxEntries: number) => buildRecallFusionDetails({
      candidates,
      policy: policyWithDeliveryHead(maxEntries),
      supplementaryData: support,
      nowIso: "2026-07-14T00:00:00.000Z"
    });

    const narrow = run(1).get(`workspace_local:memory_entry:${conflictId}`)!;
    const wide = run(3).get(`workspace_local:memory_entry:${conflictId}`)!;

    expect(narrow.per_stream_rank.embedding_similarity).toBe(3);
    expect(narrow.fused_rank_contribution_per_stream.path_expansion).toBeGreaterThan(0);
    expect(narrow.fused_rank_contribution_per_stream.structural).toBeGreaterThan(0);
    expect(narrow.fused_rank_contribution_per_stream).toEqual(
      wide.fused_rank_contribution_per_stream
    );
  });
});
function byCandidateKey(
  values: ReturnType<typeof snapshots>
): Readonly<Record<string, ReturnType<typeof streamView>>> {
  return Object.fromEntries(values.map((value) => [value.candidateKey, streamView(value)]));
}

function streamView(value: ReturnType<typeof snapshots>[number]) {
  return {
    perStreamRank: value.perStreamRank,
    contributions: value.contributions,
    objectBase: value.objectBase
  };
}
