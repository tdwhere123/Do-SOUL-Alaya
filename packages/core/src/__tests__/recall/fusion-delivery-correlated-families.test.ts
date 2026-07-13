import { describe, expect, it } from "vitest";
import type { RecallPolicy } from "@do-soul/alaya-protocol";

import {
  buildFusionCandidateStreamSnapshots
} from "../../recall/delivery/fusion-delivery-scoring-snapshot.js";
import {
  activeFusionStreams,
  RECALL_FUSION_DEFAULT_WEIGHTS
} from "../../recall/delivery/fusion-delivery-streams.js";
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
  weights.trigram_fts = 1 / 0.85;
  weights.evidence_structural_agreement = 1 / 0.9;
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

describe("fusion complementary content projection accounting", () => {
  it("retains lexical and trigram evidence as complementary retrieval views", () => {
    const lexicalOnly = snapshots([candidate()], {
      lexical_fts: { [CANDIDATE_KEY]: 1 }
    })[0]!;
    const duplicated = snapshots([candidate()], {
      lexical_fts: { [CANDIDATE_KEY]: 1 },
      trigram_fts: { [CANDIDATE_KEY]: 1 }
    })[0]!;

    expect(duplicated.perStreamRank.lexical_fts).toBe(1);
    expect(duplicated.perStreamRank.trigram_fts).toBe(1);
    expect(duplicated.contributions.lexical_fts).toBeCloseTo(0.5, 12);
    expect(duplicated.contributions.trigram_fts).toBeCloseTo(0.5, 12);
    expect(duplicated.objectBase).toBeCloseTo(lexicalOnly.objectBase * 2, 12);
    expect(contributionTotal(duplicated.contributions)).toBeCloseTo(duplicated.objectBase, 12);
  });

  it("preserves evidence agreement lanes as distinct query-conditioned support", () => {
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

    expect(value.contributions.evidence_fts).toBeCloseTo(0.5, 12);
    expect(value.contributions.evidence_structural_agreement).toBeCloseTo(0.5, 12);
    expect(value.contributions.source_evidence_agreement).toBeCloseTo(0.5, 12);
    for (const stream of [
      "source_proximity", "path_expansion", "graph_expansion",
      "structural", "subject_alignment", "existing_score"
    ] as const) {
      expect(value.contributions[stream]).toBeCloseTo(0.5, 12);
    }
    expect(value.objectBase).toBeCloseTo(4.5, 12);
    expect(contributionTotal(value.contributions)).toBeCloseTo(value.objectBase, 12);
  });

  it("retains weak lexical corroboration when trigram contribution is stronger", () => {
    const resolved = equalizedWeights();
    const weights = { ...resolved.weights, trigram_fts: 2 / 0.85 };
    const value = snapshots([candidate()], {
      lexical_fts: { [CANDIDATE_KEY]: 1 },
      trigram_fts: { [CANDIDATE_KEY]: 1 }
    }, { ...resolved, weights })[0]!;

    expect(value.contributions.lexical_fts).toBeCloseTo(0.5, 12);
    expect(value.contributions.trigram_fts).toBeCloseTo(1, 12);
  });

  it("retains both projections when their contributions tie", () => {
    const value = snapshots([candidate()], {
      lexical_fts: { [CANDIDATE_KEY]: 1 },
      trigram_fts: { [CANDIDATE_KEY]: 1 }
    })[0]!;

    expect(value.contributions.lexical_fts).toBeCloseTo(0.5, 12);
    expect(value.contributions.trigram_fts).toBeCloseTo(0.5, 12);
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
    expect(overrideValue.contributions.lexical_fts).toBe(0);
    expect(overrideValue.contributions.trigram_fts).toBeGreaterThan(0);
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
