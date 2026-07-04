import { describe, expect, it } from "vitest";
import type { RecallFusionStream } from "../../recall/runtime/recall-service-types.js";
import { buildEmptyRecallFusionBreakdown } from "../../recall/delivery/fusion-delivery-scoring.js";
import { prioritizeStrongLexicalDeliveryWindowCandidates } from "../../recall/delivery/fusion-delivery-lexical-rerank.js";
import { compileRecallQueryProbes } from "../../recall/query/recall-query-probes.js";
import type { RecallFusionBreakdown, RecallSupplementaryData } from "../../recall/runtime/recall-service-types.js";
import { createMemoryEntry } from "./recall-service-test-fixtures.js";

type FusedCandidate = Readonly<{
  readonly entry: ReturnType<typeof createMemoryEntry>;
  readonly originPlane: "workspace_local";
  readonly objectKind: "memory_entry";
  readonly effectiveScore: number;
  readonly effectiveFactors: { readonly activation: number; readonly relevance: number };
  readonly fusion: Readonly<RecallFusionBreakdown>;
}>;

function fusedCandidate(
  objectId: string,
  perStreamRank: Readonly<Partial<Record<RecallFusionStream, number | null>>>
): FusedCandidate {
  const breakdown = buildEmptyRecallFusionBreakdown(objectId);
  return Object.freeze({
    entry: createMemoryEntry({ object_id: objectId }),
    originPlane: "workspace_local",
    objectKind: "memory_entry",
    effectiveScore: 0,
    effectiveFactors: { activation: 0, relevance: 0 },
    fusion: Object.freeze({
      ...breakdown,
      per_stream_rank: Object.freeze({
        ...breakdown.per_stream_rank,
        ...perStreamRank
      }) as RecallFusionBreakdown["per_stream_rank"]
    })
  });
}

function supplementaryData(
  query: string,
  ftsRanks: Readonly<Record<string, number>>
): RecallSupplementaryData {
  return {
    queryProbes: compileRecallQueryProbes(query),
    ftsRanks,
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
    governanceCeilingByMemoryId: {}
  };
}

describe("prioritizeStrongLexicalDeliveryWindowCandidates", () => {
  it("reorders a source-proximity-only candidate behind a strong lexical hit in the window", () => {
    const sourceOnlyId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const strongLexicalId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const ordered = [
      fusedCandidate(sourceOnlyId, { source_proximity: 1 }),
      fusedCandidate(strongLexicalId, { lexical_fts: 1 })
    ];

    const result = prioritizeStrongLexicalDeliveryWindowCandidates(
      ordered,
      supplementaryData("materialization router writes", { [strongLexicalId]: 0.95 }),
      5
    );

    expect(result.map((candidate) => candidate.entry.object_id)).toEqual([
      strongLexicalId,
      sourceOnlyId
    ]);
  });
});
