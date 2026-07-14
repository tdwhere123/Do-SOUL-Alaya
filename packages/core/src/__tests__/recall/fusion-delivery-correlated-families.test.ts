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
import {
  aggregateFamilyContributions,
  countFamiliesWithHits
} from "../../recall/delivery/fusion-delivery-families.js";
import { compileRecallQueryProbes } from "../../recall/query/recall-query-probes.js";
import type {
  RecallFusionStream,
  RecallSupplementaryData
} from "../../recall/runtime/recall-service-types.js";
import type { KeyedRecallFusionCandidate } from "../../recall/delivery/fusion-delivery-scoring-candidate.js";
import {
  buildConflictGateContext,
  resolveRrfFusionWeights,
  selectWouldOutrankSuppressedKeys,
  zeroConflictStreamContributions,
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

describe("conflict-gated fusion", () => {
  const goldId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const distractorIds = [
    "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    "ffffffff-ffff-4fff-8fff-ffffffffffff"
  ] as const;

  it("keeps emb-rank-1 gold in top-5 when correlated conflict lanes would otherwise bury it", () => {
    const gold = createMemoryEntry({
      object_id: goldId,
      content: "Gold answer with decisive embedding support."
    });
    const embNeighborIds = [
      "12121212-1212-4121-8121-121212121212",
      "13131313-1313-4131-8131-131313131313",
      "14141414-1414-4141-8141-141414141414",
      "15151515-1515-4151-8151-151515151515"
    ] as const;
    const distractors = distractorIds.map((objectId, index) => createMemoryEntry({
      object_id: objectId,
      content: `Topical distractor ${index} with path and structural pile-up.`
    }));
    const embNeighbors = embNeighborIds.map((objectId, index) => createMemoryEntry({
      object_id: objectId,
      content: `Weak embedding neighbor ${index}.`
    }));
    const all = [gold, ...embNeighbors, ...distractors];
    // Conflict distractors intentionally lack embedding scores so multi-lane path/ESA
    // would bury emb-top without the gate; emb neighbors occupy ranks 2–5.
    const embScores: Record<string, number> = {
      [goldId]: 0.92,
      ...Object.fromEntries(embNeighborIds.map((id, index) => [id, 0.55 - index * 0.02]))
    };
    const conflictSupplementary: RecallSupplementaryData = {
      queryProbes: compileRecallQueryProbes("decisive embedding gold"),
      ftsRanks: Object.fromEntries(distractorIds.map((id) => [id, 0.9])),
      trigramFtsRanks: {},
      synthesisFtsRanks: {},
      evidenceFtsRanks: Object.fromEntries(distractorIds.map((id) => [id, 1])),
      sourceProximityScores: {},
      sourceCohortKeys: {},
      structuralScores: Object.fromEntries(distractorIds.map((id) => [id, 1])),
      graphExpansionScores: Object.fromEntries(distractorIds.map((id) => [id, 1])),
      entitySeedScores: {},
      pathExpansionScores: Object.fromEntries(distractorIds.map((id) => [id, 1])),
      pathSuppressionScores: {},
      embeddingSimilarityScores: embScores,
      graphSupportCounts: {},
      budgetPenaltyFactor: 0,
      plasticityFactors: {},
      graphAndPathColdScore: 0,
      recallsEdgeCount: 0,
      weightTransferAmount: 0,
      evidenceGistsByMemoryId: {},
      governanceCeilingByMemoryId: {}
    };

    const fusion = buildRecallFusionDetails({
      candidates: all.map((entry) => ({
        entry,
        effectiveScore: distractorIds.includes(entry.object_id as typeof distractorIds[number]) ? 0.95 : 0.1,
        effectiveFactors: {
          activation: 0,
          relevance: 0,
          embedding_similarity: embScores[entry.object_id] ?? 0
        },
        structuralScore: distractorIds.includes(entry.object_id as typeof distractorIds[number]) ? 1 : 0
      })),
      policy: {} as RecallPolicy,
      supplementaryData: conflictSupplementary,
      nowIso: "2026-07-14T00:00:00.000Z"
    });

    const goldRank = fusion.get(`workspace_local:memory_entry:${goldId}`)?.fused_rank;
    expect(goldRank).toBeLessThanOrEqual(5);

    for (const distractorId of distractorIds) {
      const breakdown = fusion.get(`workspace_local:memory_entry:${distractorId}`)!;
      expect(breakdown.fused_rank_contribution_per_stream.path_expansion).toBe(0);
      expect(breakdown.fused_rank_contribution_per_stream.evidence_structural_agreement).toBe(0);
      expect(breakdown.fused_rank_contribution_per_stream.structural).toBe(0);
    }
  });

  it("still rescues gold at embedding rank ~9 via non-conflict lexical lanes", () => {
    const midGoldId = "99999999-9999-4999-8999-999999999999";
    const embHeadIds = [
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
      "33333333-3333-4333-8333-333333333333",
      "44444444-4444-4444-8444-444444444444",
      "55555555-5555-4555-8555-555555555555",
      "66666666-6666-4666-8666-666666666666",
      "77777777-7777-4777-8777-777777777777",
      "88888888-8888-4888-8888-888888888888"
    ] as const;
    const fillerId = "10101010-1010-4101-8101-101010101010";
    const gold = createMemoryEntry({
      object_id: midGoldId,
      content: "Lexical rescue gold that sits mid embedding rank."
    });
    const embHead = embHeadIds.map((objectId, index) => createMemoryEntry({
      object_id: objectId,
      content: `Embedding head distractor ${index}.`
    }));
    const filler = createMemoryEntry({
      object_id: fillerId,
      content: "Weak filler outside the emb head."
    });
    const all = [...embHead, gold, filler];
    const embScores: Record<string, number> = {
      ...Object.fromEntries(embHeadIds.map((id, index) => [id, 0.9 - index * 0.02])),
      [midGoldId]: 0.72,
      [fillerId]: 0.5
    };
    const rescueSupplementary: RecallSupplementaryData = {
      queryProbes: compileRecallQueryProbes("lexical rescue mid embedding"),
      ftsRanks: {
        [midGoldId]: 1
      },
      trigramFtsRanks: { [midGoldId]: 0.95 },
      synthesisFtsRanks: {},
      evidenceFtsRanks: {},
      sourceProximityScores: {},
      sourceCohortKeys: {},
      structuralScores: {},
      graphExpansionScores: {},
      entitySeedScores: {},
      pathExpansionScores: {},
      pathSuppressionScores: {},
      embeddingSimilarityScores: embScores,
      graphSupportCounts: {},
      budgetPenaltyFactor: 0,
      plasticityFactors: {},
      graphAndPathColdScore: 0,
      recallsEdgeCount: 0,
      weightTransferAmount: 0,
      evidenceGistsByMemoryId: {},
      governanceCeilingByMemoryId: {}
    };

    const fusion = buildRecallFusionDetails({
      candidates: all.map((entry) => ({
        entry,
        // Keep existing_score cold so the rescue is lexical-only (conflict gate zeros
        // existing_score for emb-unsupported piles that would clear the emb-head floor).
        effectiveScore: 0,
        effectiveFactors: {
          activation: 0,
          relevance: 0,
          embedding_similarity: embScores[entry.object_id] ?? 0
        },
        structuralScore: 0
      })),
      policy: {} as RecallPolicy,
      supplementaryData: rescueSupplementary,
      nowIso: "2026-07-14T00:00:00.000Z"
    });

    const goldBreakdown = fusion.get(`workspace_local:memory_entry:${midGoldId}`)!;

    expect(goldBreakdown.per_stream_rank.embedding_similarity).toBe(9);
    expect(goldBreakdown.fused_rank_contribution_per_stream.lexical_fts).toBeGreaterThan(0);
    expect(goldBreakdown.fused_rank).toBeLessThanOrEqual(5);
  });

  it("rescues emb-rank-~9 gold via structural/graph conflict lanes that membership zeroing would strip", () => {
    const midGoldId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa09";
    const embHeadIds = [
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa01",
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa02",
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa03",
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa04",
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa05",
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa06",
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa07",
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa08"
    ] as const;
    const fillerId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa10";
    const gold = createMemoryEntry({
      object_id: midGoldId,
      content: "Structural rescue gold mid embedding rank."
    });
    const embHead = embHeadIds.map((objectId, index) => createMemoryEntry({
      object_id: objectId,
      content: `Embedding-only head ${index}.`
    }));
    const filler = createMemoryEntry({
      object_id: fillerId,
      content: "Weak filler."
    });
    const all = [...embHead, gold, filler];
    const embScores: Record<string, number> = {
      ...Object.fromEntries(embHeadIds.map((id, index) => [id, 0.9 - index * 0.02])),
      [midGoldId]: 0.71,
      [fillerId]: 0.5
    };
    // Gold's fused lift is conflict-family only (structural + graph); no lexical rescue.
    const rescueSupplementary: RecallSupplementaryData = {
      queryProbes: compileRecallQueryProbes("structural conflict rescue mid embedding"),
      ftsRanks: {},
      trigramFtsRanks: {},
      synthesisFtsRanks: {},
      evidenceFtsRanks: {},
      sourceProximityScores: {},
      sourceCohortKeys: {},
      structuralScores: { [midGoldId]: 1 },
      graphExpansionScores: { [midGoldId]: 1 },
      entitySeedScores: {},
      pathExpansionScores: { [midGoldId]: 1 },
      pathSuppressionScores: {},
      embeddingSimilarityScores: embScores,
      graphSupportCounts: {},
      budgetPenaltyFactor: 0,
      plasticityFactors: {},
      graphAndPathColdScore: 0,
      recallsEdgeCount: 0,
      weightTransferAmount: 0,
      evidenceGistsByMemoryId: {},
      governanceCeilingByMemoryId: {}
    };

    const fusion = buildRecallFusionDetails({
      candidates: all.map((entry) => ({
        entry,
        effectiveScore: 0,
        effectiveFactors: {
          activation: 0,
          relevance: 0,
          embedding_similarity: embScores[entry.object_id] ?? 0
        },
        structuralScore: entry.object_id === midGoldId ? 1 : 0
      })),
      policy: {} as RecallPolicy,
      supplementaryData: rescueSupplementary,
      nowIso: "2026-07-14T00:00:00.000Z"
    });

    const goldKey = `workspace_local:memory_entry:${midGoldId}`;
    const goldBreakdown = fusion.get(goldKey)!;
    expect(goldBreakdown.per_stream_rank.embedding_similarity).toBe(9);
    expect(goldBreakdown.fused_rank_contribution_per_stream.structural).toBeGreaterThan(0);
    expect(goldBreakdown.fused_rank_contribution_per_stream.graph_expansion).toBeGreaterThan(0);
    expect(goldBreakdown.fused_rank_contribution_per_stream.path_expansion).toBeGreaterThan(0);
    expect(goldBreakdown.fused_rank).toBeLessThanOrEqual(5);

    // Membership blanket would zero every conflict lane outside emb top-5; that strips the
    // only rescue mass and drops gold out of top-5 under the same pool.
    const keyed = all.map((entry) => ({
      candidateKey: `workspace_local:memory_entry:${entry.object_id}`,
      candidate: {
        entry,
        effectiveScore: 0,
        effectiveFactors: {
          activation: 0,
          relevance: 0,
          embedding_similarity: embScores[entry.object_id] ?? 0
        },
        structuralScore: entry.object_id === midGoldId ? 1 : 0
      }
    }));
    const resolved = resolveRrfFusionWeights({
      policy: {} as RecallPolicy,
      queryProbes: rescueSupplementary.queryProbes,
      streams: activeFusionStreams(),
      baseWeights: RECALL_FUSION_DEFAULT_WEIGHTS
    });
    const ranksByStream = new Map(
      activeFusionStreams().map((stream) => {
        const ranks = new Map<string, number>();
        for (const [key, breakdown] of fusion) {
          const rank = breakdown.per_stream_rank[stream];
          if (rank !== null) {
            ranks.set(key, rank);
          }
        }
        return [stream, ranks] as const;
      })
    );
    const rawSnapshots = buildFusionCandidateStreamSnapshots({
      candidates: keyed,
      ranksByStream,
      resolved,
      supplementaryData: rescueSupplementary
    });
    const gate = buildConflictGateContext({
      candidateKeys: keyed.map((row) => row.candidateKey),
      embeddingRanks: ranksByStream.get("embedding_similarity"),
      embeddingScores: embScores
    });
    expect(gate.poolEmbeddingDecisive).toBe(true);
    expect(gate.decisiveCandidateKeys.has(goldKey)).toBe(false);
    expect(gate.embeddingRankByKey.has(goldKey)).toBe(true);
    const wouldOutrankSuppressed = selectWouldOutrankSuppressedKeys({
      gate,
      contributionsByKey: new Map(
        rawSnapshots.map((row) => [row.candidateKey, row.contributions] as const)
      )
    });
    expect(wouldOutrankSuppressed.has(goldKey)).toBe(false);

    const membershipBlanketBases = rawSnapshots.map((row) => {
      const outsideDecisive = !gate.decisiveCandidateKeys.has(row.candidateKey);
      const contribs = outsideDecisive
        ? zeroConflictStreamContributions({ ...row.contributions })
        : row.contributions;
      return {
        candidateKey: row.candidateKey,
        objectBase: aggregateFamilyContributions(contribs)
      };
    });
    membershipBlanketBases.sort((left, right) => right.objectBase - left.objectBase
      || left.candidateKey.localeCompare(right.candidateKey));
    const membershipGoldRank = membershipBlanketBases.findIndex((row) => row.candidateKey === goldKey) + 1;
    expect(membershipGoldRank).toBeGreaterThan(5);
  });

  it("blocks emb-unsupported conflict piles from entering top-5 past the decisive emb head", () => {
    const embHeadIds = [
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb01",
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb02",
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb03",
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb04",
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb05"
    ] as const;
    const pileId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const embHead = embHeadIds.map((objectId, index) => createMemoryEntry({
      object_id: objectId,
      content: `Decisive embedding head ${index}.`
    }));
    const pile = createMemoryEntry({
      object_id: pileId,
      content: "Huge conflict pile with no embedding support."
    });
    const all = [...embHead, pile];
    const embScores: Record<string, number> = Object.fromEntries(
      embHeadIds.map((id, index) => [id, 0.95 - index * 0.01])
    );
    const pileSupplementary: RecallSupplementaryData = {
      queryProbes: compileRecallQueryProbes("non displacement conflict pile"),
      ftsRanks: {},
      trigramFtsRanks: {},
      synthesisFtsRanks: {},
      evidenceFtsRanks: { [pileId]: 1 },
      sourceProximityScores: {},
      sourceCohortKeys: {},
      structuralScores: { [pileId]: 1 },
      graphExpansionScores: { [pileId]: 1 },
      entitySeedScores: {},
      pathExpansionScores: { [pileId]: 1 },
      pathSuppressionScores: {},
      embeddingSimilarityScores: embScores,
      graphSupportCounts: {},
      budgetPenaltyFactor: 0,
      plasticityFactors: {},
      graphAndPathColdScore: 0,
      recallsEdgeCount: 0,
      weightTransferAmount: 0,
      evidenceGistsByMemoryId: {},
      governanceCeilingByMemoryId: {}
    };

    const fusion = buildRecallFusionDetails({
      candidates: all.map((entry) => ({
        entry,
        effectiveScore: entry.object_id === pileId ? 1 : 0,
        effectiveFactors: {
          activation: 0,
          relevance: 0,
          embedding_similarity: embScores[entry.object_id] ?? 0
        },
        structuralScore: entry.object_id === pileId ? 1 : 0
      })),
      policy: {} as RecallPolicy,
      supplementaryData: pileSupplementary,
      nowIso: "2026-07-14T00:00:00.000Z"
    });

    const pileKey = `workspace_local:memory_entry:${pileId}`;
    const pileBreakdown = fusion.get(pileKey)!;
    expect(pileBreakdown.per_stream_rank.embedding_similarity).toBeNull();
    expect(pileBreakdown.fused_rank_contribution_per_stream.path_expansion).toBe(0);
    expect(pileBreakdown.fused_rank_contribution_per_stream.structural).toBe(0);
    expect(pileBreakdown.fused_rank_contribution_per_stream.graph_expansion).toBe(0);
    expect(pileBreakdown.fused_rank_contribution_per_stream.evidence_fts).toBe(0);
    expect(pileBreakdown.fused_rank_contribution_per_stream.existing_score).toBe(0);
    expect(pileBreakdown.fused_rank).toBeGreaterThan(5);

    for (const embId of embHeadIds) {
      expect(fusion.get(`workspace_local:memory_entry:${embId}`)!.fused_rank).toBeLessThanOrEqual(5);
    }
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
