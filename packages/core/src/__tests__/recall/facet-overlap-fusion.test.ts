import { afterEach, describe, expect, it } from "vitest";
import type { RecallPolicy } from "@do-soul/alaya-protocol";
import { buildRecallFusionDetails, buildEmptyRecallFusionBreakdown, compareFusedRecallCandidates } from "../../recall/delivery/fusion-delivery-scoring.js";
import { compileRecallQueryProbes } from "../../recall/query/recall-query-probes.js";
import type { RecallSupplementaryData } from "../../recall/runtime/recall-service-types.js";
import { createMemoryEntry } from "./recall-service-test-fixtures.js";

const POLICY = {} as RecallPolicy;
const QUERY = "where does the operator work and what is their job?";
const GOLD_ID = "11111111-1111-4111-8111-111111111111";
const DISTRACTOR_ID = "22222222-2222-4222-8222-222222222222";

function supplementaryData(
  overrides: Partial<RecallSupplementaryData> = {}
): RecallSupplementaryData {
  return {
    queryProbes: compileRecallQueryProbes(QUERY),
    ftsRanks: {},
    trigramFtsRanks: {},
    synthesisFtsRanks: {},
    evidenceFtsRanks: {},
    sourceProximityScores: {},
    sourceCohortKeys: {},
    structuralScores: {},
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
    governanceCeilingByMemoryId: {},
    ...overrides
  };
}

function buildFusion(supplementary: RecallSupplementaryData) {
  const gold = createMemoryEntry({
    object_id: GOLD_ID,
    content: "Operator memory carrying answer-relevant facets.",
    facet_tags: [{ facet: "occupation_work" }, { facet: "location_place" }]
  });
  const distractor = createMemoryEntry({
    object_id: DISTRACTOR_ID,
    content: "Same-topic distractor with a lexical lead.",
    facet_tags: [{ facet: "preference_like" }]
  });
  return buildRecallFusionDetails({
    candidates: [
      { entry: gold, effectiveScore: 0.4, effectiveFactors: { activation: 0, relevance: 0 } },
      { entry: distractor, effectiveScore: 0.6, effectiveFactors: { activation: 0, relevance: 0 } }
    ],
    policy: POLICY,
    supplementaryData: supplementary,
    nowIso: "2026-03-20T10:20:30.000Z"
  });
}

afterEach(() => {
  delete process.env.ALAYA_RECALL_FACET_OVERLAP;
});

describe("facet_overlap fusion stream", () => {
  it("clamps facet overlap count before stream ranking", () => {
    const twoFacetRaw = createMemoryEntry({
      object_id: GOLD_ID,
      content: "Two matching facets but later tie-break.",
      created_at: "2026-03-21T00:00:00.000Z",
      facet_tags: [{ facet: "occupation_work" }, { facet: "location_place" }]
    });
    const oneFacetEarlier = createMemoryEntry({
      object_id: DISTRACTOR_ID,
      content: "One matching facet but earlier tie-break.",
      created_at: "2026-03-20T00:00:00.000Z",
      facet_tags: [{ facet: "occupation_work" }]
    });

    const fusion = buildRecallFusionDetails({
      candidates: [
        { entry: twoFacetRaw, effectiveScore: 0, effectiveFactors: { activation: 0, relevance: 0 } },
        { entry: oneFacetEarlier, effectiveScore: 0, effectiveFactors: { activation: 0, relevance: 0 } }
      ],
      policy: POLICY,
      supplementaryData: supplementaryData({ querySoughtFacets: ["occupation_work", "location_place"] }),
      nowIso: "2026-03-20T10:20:30.000Z"
    });

    expect(fusion.get(`workspace_local:memory_entry:${DISTRACTOR_ID}`)?.per_stream_rank.facet_overlap).toBe(1);
    expect(fusion.get(`workspace_local:memory_entry:${GOLD_ID}`)?.per_stream_rank.facet_overlap).toBe(2);
  });

  it("is active whenever query-sought facets are present", () => {
    delete process.env.ALAYA_RECALL_FACET_OVERLAP;
    const withFacets = buildFusion(supplementaryData({ querySoughtFacets: ["occupation_work", "location_place"] }));
    const baseline = buildFusion(supplementaryData());

    const goldKey = `workspace_local:memory_entry:${GOLD_ID}`;
    expect(withFacets.get(goldKey)?.fused_rank_contribution_per_stream.facet_overlap ?? 0)
      .toBeGreaterThan(0);
    expect(withFacets.get(goldKey)?.fused_score ?? 0)
      .toBeGreaterThan(baseline.get(goldKey)?.fused_score ?? 0);
  });

  it("uses facet overlap only as a fused-score tie-break, not the primary rank key", () => {
    const createdAt = "2026-03-20T00:00:00.000Z";
    const highOverlap = createMemoryEntry({
      object_id: GOLD_ID,
      content: "Memory with two answer facets.",
      created_at: createdAt,
      facet_tags: [{ facet: "occupation_work" }, { facet: "location_place" }]
    });
    const lowOverlap = createMemoryEntry({
      object_id: DISTRACTOR_ID,
      content: "Memory with one answer facet.",
      created_at: createdAt,
      facet_tags: [{ facet: "occupation_work" }]
    });

    const fusion = buildRecallFusionDetails({
      candidates: [
        { entry: highOverlap, effectiveScore: 0, effectiveFactors: { activation: 0, relevance: 0 } },
        { entry: lowOverlap, effectiveScore: 0, effectiveFactors: { activation: 0, relevance: 0 } }
      ],
      policy: POLICY,
      supplementaryData: supplementaryData({ querySoughtFacets: ["occupation_work", "location_place"] }),
      nowIso: "2026-03-20T10:20:30.000Z"
    });

    const gold = fusion.get(`workspace_local:memory_entry:${GOLD_ID}`);
    const distractor = fusion.get(`workspace_local:memory_entry:${DISTRACTOR_ID}`);
    // Facet stream contributes into fused_score; rank follows score, not raw overlap count.
    expect(gold?.facet_overlap).toBe(2);
    expect(distractor?.facet_overlap).toBe(1);
    expect(gold?.fused_score ?? 0).toBeGreaterThan(distractor?.fused_score ?? 0);
    expect(gold?.fused_rank).toBe(1);
    expect(distractor?.fused_rank).toBe(2);
  });

  it("lets fused_score outrank a higher facet-overlap count across tiers", () => {
    const highOverlapWeak = createMemoryEntry({
      object_id: GOLD_ID,
      content: "Two facets but weak lexical lead.",
      created_at: "2026-03-21T00:00:00.000Z",
      facet_tags: [{ facet: "occupation_work" }, { facet: "location_place" }]
    });
    const lowOverlapStrong = createMemoryEntry({
      object_id: DISTRACTOR_ID,
      content: "One facet but strong embedding lead.",
      created_at: "2026-03-20T00:00:00.000Z",
      facet_tags: [{ facet: "occupation_work" }]
    });

    const fusion = buildRecallFusionDetails({
      candidates: [
        {
          entry: highOverlapWeak,
          effectiveScore: 0.01,
          effectiveFactors: { activation: 0, relevance: 0, embedding_similarity: 0.01 }
        },
        {
          entry: lowOverlapStrong,
          effectiveScore: 0.99,
          effectiveFactors: { activation: 0, relevance: 0, embedding_similarity: 0.99 }
        }
      ],
      policy: POLICY,
      supplementaryData: supplementaryData({
        querySoughtFacets: ["occupation_work", "location_place"],
        embeddingSimilarityScores: {
          [GOLD_ID]: 0.01,
          [DISTRACTOR_ID]: 0.99
        }
      }),
      nowIso: "2026-03-20T10:20:30.000Z"
    });

    const strongKey = `workspace_local:memory_entry:${DISTRACTOR_ID}`;
    const weakKey = `workspace_local:memory_entry:${GOLD_ID}`;
    expect(fusion.get(strongKey)?.fused_score ?? 0).toBeGreaterThan(fusion.get(weakKey)?.fused_score ?? 0);
    expect(fusion.get(strongKey)?.facet_overlap).toBe(1);
    expect(fusion.get(weakKey)?.facet_overlap).toBe(2);
    expect(fusion.get(strongKey)?.fused_rank).toBe(1);
    expect(fusion.get(weakKey)?.fused_rank).toBe(2);
  });

  it("uses fused_rank as the delivery tie-break when fused_score ties", () => {
    const highOverlap = createMemoryEntry({
      object_id: GOLD_ID,
      content: "Later memory with two answer facets.",
      created_at: "2026-03-21T00:00:00.000Z",
      facet_tags: [{ facet: "occupation_work" }, { facet: "location_place" }]
    });
    const lowOverlap = createMemoryEntry({
      object_id: DISTRACTOR_ID,
      content: "Earlier memory with one answer facet.",
      created_at: "2026-03-20T00:00:00.000Z",
      facet_tags: [{ facet: "occupation_work" }]
    });
    const tiedScore = 0.42;
    const goldFusion = { ...buildEmptyRecallFusionBreakdown(GOLD_ID), fused_score: tiedScore, fused_rank: 1 };
    const distractorFusion = { ...buildEmptyRecallFusionBreakdown(DISTRACTOR_ID), fused_score: tiedScore, fused_rank: 2 };
    expect(compareFusedRecallCandidates(
      { entry: highOverlap, effectiveScore: 0, effectiveFactors: { activation: 0, relevance: 0 }, fusion: goldFusion },
      { entry: lowOverlap, effectiveScore: 0, effectiveFactors: { activation: 0, relevance: 0 }, fusion: distractorFusion }
    )).toBeLessThan(0);
  });

  it("facet flag is not part of the unified kernel contract", () => {
    const goldKey = `workspace_local:memory_entry:${GOLD_ID}`;
    const distractorKey = `workspace_local:memory_entry:${DISTRACTOR_ID}`;

    delete process.env.ALAYA_RECALL_FACET_OVERLAP;
    const off = buildFusion(supplementaryData({ querySoughtFacets: ["occupation_work", "location_place"] }));

    process.env.ALAYA_RECALL_FACET_OVERLAP = "on";
    const on = buildFusion(supplementaryData({ querySoughtFacets: ["occupation_work", "location_place"] }));

    const goldContribution = on.get(goldKey)?.fused_rank_contribution_per_stream.facet_overlap ?? 0;
    expect(goldContribution).toBeGreaterThan(0);
    expect(on.get(goldKey)?.fused_score ?? 0).toBeCloseTo(off.get(goldKey)?.fused_score ?? 0, 12);
    expect((on.get(goldKey)?.fused_rank ?? Number.MAX_SAFE_INTEGER)).toBeLessThan(
      on.get(distractorKey)?.fused_rank ?? Number.MAX_SAFE_INTEGER
    );
  });

  it("contributes nothing when the flag is on but querySoughtFacets is empty", () => {
    process.env.ALAYA_RECALL_FACET_OVERLAP = "on";
    const goldKey = `workspace_local:memory_entry:${GOLD_ID}`;
    const fusion = buildFusion(supplementaryData({ querySoughtFacets: [] }));
    expect(fusion.get(goldKey)?.fused_rank_contribution_per_stream.facet_overlap ?? 0).toBe(0);
  });
});
