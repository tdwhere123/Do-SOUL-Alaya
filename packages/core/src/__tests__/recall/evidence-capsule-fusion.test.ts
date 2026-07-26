import type { RecallPolicy } from "@do-soul/alaya-protocol";
import { describe, expect, it } from "vitest";
import { buildRecallFusionDetails } from "../../recall/delivery/fusion-delivery-scoring.js";
import type { RecallFusionCandidateInput } from "../../recall/delivery/fusion-delivery-scoring-candidate.js";
import { compileRecallQueryProbes } from "../../recall/query/recall-query-probes.js";
import type { RecallSupplementaryData } from "../../recall/runtime/recall-service-types.js";
import { createMemoryEntry } from "./recall-service-test-fixtures.js";

const OBJECT_ID = "11111111-1111-4111-8111-111111111111";
const CAPSULE_KEY = `workspace_local:evidence_capsule:${OBJECT_ID}`;

describe("evidence capsule fusion", () => {
  it("uses its candidate-keyed semantic score without leaking it to same-id memories", () => {
    const capsule = fusionCandidate("evidence_capsule");
    const workspaceMemory = fusionCandidate("memory_entry");
    const globalMemory = fusionCandidate("memory_entry", "global");
    const fusion = buildRecallFusionDetails({
      candidates: [capsule, workspaceMemory, globalMemory],
      policy: {} as RecallPolicy,
      supplementaryData: supplementaryData({
        evidenceFtsRanks: { [OBJECT_ID]: 1 },
        evidenceSemanticScoresByCandidateKey: new Map([[CAPSULE_KEY, 0.91]])
      }),
      nowIso: "2026-07-26T00:00:00.000Z"
    });

    expect(fusion.get(CAPSULE_KEY)?.per_stream_rank.embedding_similarity).toBe(1);
    expect(
      fusion.get(CAPSULE_KEY)?.fused_rank_contribution_per_stream.embedding_similarity
    ).toBeCloseTo(1 / 61, 6);
    expect(
      fusion.get(`workspace_local:memory_entry:${OBJECT_ID}`)?.per_stream_rank.embedding_similarity
    ).toBeNull();
    expect(fusion.get(`global:memory_entry:${OBJECT_ID}`)?.per_stream_rank.embedding_similarity)
      .toBeNull();
  });

  it("keeps an unscored capsule on its existing evidence-FTS-only path", () => {
    const fusion = buildRecallFusionDetails({
      candidates: [fusionCandidate("evidence_capsule")],
      policy: {} as RecallPolicy,
      supplementaryData: supplementaryData({ evidenceFtsRanks: { [OBJECT_ID]: 1 } }),
      nowIso: "2026-07-26T00:00:00.000Z"
    });
    const capsule = fusion.get(CAPSULE_KEY);

    expect(capsule?.per_stream_rank.evidence_fts).toBe(1);
    expect(capsule?.fused_rank_contribution_per_stream.evidence_fts).toBeCloseTo(1 / 61, 6);
    expect(capsule?.per_stream_rank.embedding_similarity).toBeNull();
    expect(capsule?.fused_rank_contribution_per_stream.embedding_similarity).toBe(0);
  });
});

function fusionCandidate(
  objectKind: "memory_entry" | "evidence_capsule",
  originPlane?: "global"
): RecallFusionCandidateInput {
  return {
    entry: createMemoryEntry({ object_id: OBJECT_ID, activation_score: 0 }),
    objectKind,
    originPlane,
    effectiveScore: 0,
    effectiveFactors: { activation: 0, relevance: 0 }
  };
}

function supplementaryData(overrides: Partial<RecallSupplementaryData>): RecallSupplementaryData {
  return {
    queryProbes: compileRecallQueryProbes("What did the user say about the project?"),
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
    evidenceSemanticScoresByCandidateKey: new Map(),
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
