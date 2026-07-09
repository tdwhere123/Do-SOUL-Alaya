import { afterEach, describe, expect, it, vi } from "vitest";
import type { RecallFusionStream } from "../../recall/runtime/recall-service-types.js";
import { buildEmptyRecallFusionBreakdown } from "../../recall/delivery/fusion-delivery-scoring.js";
import {
  applyFeatureRerank,
  prioritizeStrongLexicalDeliveryWindowCandidates
} from "../../recall/delivery/fusion-delivery-lexical-rerank.js";
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
  options: {
    readonly content?: string;
    readonly fusedScore?: number;
    readonly perStreamRank?: Readonly<Partial<Record<RecallFusionStream, number | null>>>;
  } = {}
): FusedCandidate {
  const breakdown = buildEmptyRecallFusionBreakdown(objectId);
  return Object.freeze({
    entry: createMemoryEntry({
      object_id: objectId,
      content: options.content ?? `content for ${objectId}`
    }),
    originPlane: "workspace_local",
    objectKind: "memory_entry",
    effectiveScore: 0,
    effectiveFactors: { activation: 0, relevance: 0 },
    fusion: Object.freeze({
      ...breakdown,
      fused_score: options.fusedScore ?? 0.1,
      per_stream_rank: Object.freeze({
        ...breakdown.per_stream_rank,
        ...(options.perStreamRank ?? {})
      }) as RecallFusionBreakdown["per_stream_rank"]
    })
  });
}

function supplementaryData(
  query: string,
  ftsRanks: Readonly<Record<string, number>> = {}
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
      fusedCandidate(sourceOnlyId, { perStreamRank: { source_proximity: 1 } }),
      fusedCandidate(strongLexicalId, { perStreamRank: { lexical_fts: 1 } })
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

describe("applyFeatureRerank protected head", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const headIds = [
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
  ] as const;
  const exactId = "ffffffff-ffff-4fff-8fff-ffffffffffff";

  function protectedHeadCandidates(): readonly FusedCandidate[] {
    return [
      ...headIds.map((objectId) =>
        fusedCandidate(objectId, {
          content: `unrelated filler for ${objectId}`,
          fusedScore: 0.3
        })
      ),
      fusedCandidate(exactId, {
        content: "their favorite text editor is Helix",
        fusedScore: 0.29
      })
    ];
  }

  it("does not protect the fusion head when ALAYA_RECALL_FUSION_RANK_FLOOR is unset", () => {
    const result = applyFeatureRerank(
      protectedHeadCandidates(),
      supplementaryData("favorite text editor"),
      5
    );
    expect(result[0]?.entry.object_id).toBe(exactId);
  });

  it("protects the fusion head when ALAYA_RECALL_FUSION_RANK_FLOOR is enabled", () => {
    vi.stubEnv("ALAYA_RECALL_FUSION_RANK_FLOOR", "1");
    const result = applyFeatureRerank(
      protectedHeadCandidates(),
      supplementaryData("favorite text editor"),
      5
    );
    expect(result.slice(0, 5).map((c) => c.entry.object_id)).toEqual([...headIds]);
    expect(result[5]?.entry.object_id).toBe(exactId);
  });
});
