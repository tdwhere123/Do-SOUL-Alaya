import type { RecallPolicy } from "@do-soul/alaya-protocol";
import { describe, expect, it } from "vitest";

import { buildRecallFusionDetails } from "../../recall/delivery/fusion-delivery-scoring.js";
import type { RecallFusionCandidateInput } from "../../recall/delivery/fusion-delivery-scoring-candidate.js";
import { compileRecallQueryProbes } from "../../recall/query/recall-query-probes.js";
import { buildRecallCandidateDedupeKey } from "../../recall/runtime/recall-service-helpers.js";
import type { RecallSupplementaryData } from "../../recall/runtime/recall-service-types.js";
import { createMemoryEntry } from "./recall-service-test-fixtures.js";

function candidate(
  objectId: string,
  objectKind: "memory_entry" | "evidence_capsule"
): RecallFusionCandidateInput {
  return {
    entry: createMemoryEntry({
      object_id: objectId,
      content: "Deployment evidence for the semantic fusion ballot."
    }),
    objectKind,
    originPlane: "workspace_local",
    effectiveScore: 0,
    effectiveFactors: { activation: 0, relevance: 0 }
  };
}

function supplementaryData(
  evidenceSemanticScoresByCandidateKey: ReadonlyMap<string, number>
): RecallSupplementaryData {
  return {
    queryProbes: compileRecallQueryProbes("deployment evidence"),
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
    evidenceSemanticScoresByCandidateKey,
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

describe("evidence semantic fusion", () => {
  it("casts only the observed candidate-keyed evidence score into embedding fusion", () => {
    const sharedObjectId = "11111111-1111-4111-8111-111111111111";
    const observedEvidence = candidate(sharedObjectId, "evidence_capsule");
    const unobservedEvidence = candidate(
      "22222222-2222-4222-8222-222222222222",
      "evidence_capsule"
    );
    const collidingMemory = candidate(sharedObjectId, "memory_entry");
    const observedKey = buildRecallCandidateDedupeKey(observedEvidence);
    const unobservedKey = buildRecallCandidateDedupeKey(unobservedEvidence);
    const collidingMemoryKey = buildRecallCandidateDedupeKey(collidingMemory);

    const fusion = buildRecallFusionDetails({
      candidates: [observedEvidence, unobservedEvidence, collidingMemory],
      policy: {} as RecallPolicy,
      supplementaryData: supplementaryData(new Map([[observedKey, 0.8]])),
      nowIso: "2026-07-27T00:00:00.000Z"
    });

    expect(fusion.get(observedKey)?.per_stream_rank.embedding_similarity).toBe(1);
    expect(
      fusion.get(observedKey)?.fused_rank_contribution_per_stream.embedding_similarity
    ).toBeGreaterThan(0);
    expect(fusion.get(unobservedKey)?.per_stream_rank.embedding_similarity).toBeNull();
    expect(
      fusion.get(unobservedKey)?.fused_rank_contribution_per_stream.embedding_similarity
    ).toBe(0);
    expect(fusion.get(collidingMemoryKey)?.per_stream_rank.embedding_similarity).toBeNull();
    expect(
      fusion.get(collidingMemoryKey)?.fused_rank_contribution_per_stream.embedding_similarity
    ).toBe(0);
  });
});
