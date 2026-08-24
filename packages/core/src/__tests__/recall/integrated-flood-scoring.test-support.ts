import { compileRecallQueryProbes } from "../../recall/query/recall-query-probes.js";
import { createSelectedSliceKeyV2 } from "../../recall/flood/slice-key-contract.js";
import type { RecallSupplementaryData } from "../../recall/runtime/recall-service-types.js";
import { createMemoryEntry } from "./recall-service-test-fixtures.js";

export function supplementary(overrides: Partial<RecallSupplementaryData> = {}): RecallSupplementaryData {
  return {
    queryProbes: compileRecallQueryProbes("how does staging rotate credentials"),
    ftsRanks: {},
    trigramFtsRanks: {},
    synthesisFtsRanks: {},
    evidenceFtsRanks: {},
    evidenceProjectionMatchesByRef: {},
    sourceProximityScores: {},
    sourceCohortKeys: {},
    structuralScores: {},
    graphExpansionScores: {},
    entitySeedScores: {},
    pathExpansionScores: {},
    pathSuppressionScores: {},
    embeddingSimilarityScores: {},
    evidenceSemanticActivationsByCandidateKey: new Map(),
    graphSupportCounts: {},
    budgetPenaltyFactor: 0,
    plasticityFactors: {},
    graphAndPathColdScore: 0,
    recallsEdgeCount: 0,
    weightTransferAmount: 0,
    evidenceGistsByMemoryId: {},
    governanceCeilingByMemoryId: {},
    ...overrides
  } as RecallSupplementaryData;
}

export function entityQueryKey(workspaceId: string, value: string) {
  return createSelectedSliceKeyV2({
    workspace_id: workspaceId,
    owner_id: null,
    dimension: "entity",
    value,
    authority: "derived_query",
    reliability: 1,
    independence_group: `query:${workspaceId}`,
    provenance: { kind: "query_probe", source_ref: `query:entity:${value}` },
    source_version: "v1",
    freshness: { state: "fresh", as_of_ms: 1 }
  });
}

export { createMemoryEntry };
