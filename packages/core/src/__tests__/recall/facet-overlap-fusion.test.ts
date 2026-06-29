import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RecallPolicy } from "@do-soul/alaya-protocol";
import { buildRecallFusionDetails } from "../../recall/fusion-delivery-scoring.js";
import { compileRecallQueryProbes } from "../../recall/recall-query-probes.js";
import type { RecallSupplementaryData } from "../../recall/recall-service-types.js";
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

// The additive facet_overlap stream lives in the flat path, reachable only under the kill-switch (four-axis folds facet into R_O).
beforeEach(() => {
  process.env.ALAYA_RECALL_FLAT_BASELINE = "1";
});

afterEach(() => {
  delete process.env.ALAYA_RECALL_FACET_OVERLAP;
  delete process.env.ALAYA_RECALL_FLAT_BASELINE;
});

describe("facet_overlap fusion stream", () => {
  it("is byte-identical to the no-facet baseline when the flag is off", () => {
    delete process.env.ALAYA_RECALL_FACET_OVERLAP;
    const withFacets = buildFusion(supplementaryData({ querySoughtFacets: ["occupation_work", "location_place"] }));
    const baseline = buildFusion(supplementaryData());

    expect([...withFacets.entries()]).toEqual([...baseline.entries()]);
    for (const breakdown of withFacets.values()) {
      expect(breakdown.per_stream_rank).not.toHaveProperty("facet_overlap");
      expect(breakdown.fused_rank_contribution_per_stream).not.toHaveProperty("facet_overlap");
    }
  });

  it("promotes the facet-bearing candidate above the lexical-lead distractor when the flag is on", () => {
    const goldKey = `workspace_local:memory_entry:${GOLD_ID}`;
    const distractorKey = `workspace_local:memory_entry:${DISTRACTOR_ID}`;

    delete process.env.ALAYA_RECALL_FACET_OVERLAP;
    const off = buildFusion(supplementaryData({ querySoughtFacets: ["occupation_work", "location_place"] }));

    process.env.ALAYA_RECALL_FACET_OVERLAP = "on";
    const on = buildFusion(supplementaryData({ querySoughtFacets: ["occupation_work", "location_place"] }));

    const goldContribution = on.get(goldKey)?.fused_rank_contribution_per_stream.facet_overlap ?? 0;
    expect(goldContribution).toBeGreaterThan(0);
    expect(on.get(goldKey)?.fused_score ?? 0).toBeGreaterThan(off.get(goldKey)?.fused_score ?? 0);
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
