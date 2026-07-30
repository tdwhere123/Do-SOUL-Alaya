import {
  type ManifestationState,
  type MemoryEntry,
  type RecallPolicy
} from "@do-soul/alaya-protocol";
import type { RecallQueryProbes } from "../query/recall-query-probes.js";
import {
  clamp01,
  errorNameOf,
  mapBudgetPenalty,
  normalizeGraphSupport,
  toErrorMessage
} from "../runtime/recall-service-helpers.js";
import type {
  EvidenceSupportVector,
  PathInflowEdge,
  RecallServiceDependencies,
  RecallServiceWarnPort,
  RecallSupplementaryData
} from "../runtime/recall-service-types.js";
import { readWithTemporalProjection } from "../runtime/recall-service-ports.js";
import { computeMaxWeightTransferAmount } from "../scoring/scoring.js";
import { uniqueStrings } from "../expansion/path-relations.js";
import { collectGovernancePathDerivations } from "./supplementary-data-governance-paths.js";
import { deriveQuerySoughtFacets } from "../query/query-facet-router.js";
import {
  collectRecallEvidenceContexts
} from "./evidence/evidence-contexts.js";
import type {
  RecallVerifiedUserAssertionContext
} from "../query/recall-user-assertion-context.js";

const RECALLS_EDGE_COLD_THRESHOLD = 50;
export const SUPPLEMENTARY_DB_LOOKUP_CONCURRENCY = 16;

interface CollectSupplementaryDataParams {
  readonly dependencies: Pick<
    RecallServiceDependencies,
    | "budgetPenaltyPort"
    | "evidenceSearchPort"
    | "graphSupportPort"
    | "pathExpansionPort"
    | "pathPlasticityPort"
  >;
  readonly warn: RecallServiceWarnPort;
  readonly candidates: readonly Readonly<MemoryEntry>[];
  readonly workspaceId: string;
  readonly pathProjectionAsOf?: string;
  readonly runId: string | null;
  readonly queryText: string | null;
  readonly queryProbes: Readonly<RecallQueryProbes>;
  readonly policy: Readonly<RecallPolicy>;
  readonly coarseFtsRanks: Readonly<Record<string, number>>;
  readonly coarseTrigramFtsRanks: Readonly<Record<string, number>>;
  readonly coarseSynthesisFtsRanks: Readonly<Record<string, number>>;
  readonly coarseEvidenceFtsRanks: Readonly<Record<string, number>>;
  readonly coarseEvidenceFtsRanksPerRef: Readonly<Record<string, number>>;
  readonly coarseSourceProximityScores: Readonly<Record<string, number>>;
  readonly coarseSourceCohortKeys: Readonly<Record<string, string>>;
  readonly coarseStructuralScores: Readonly<Record<string, number>>;
  readonly coarseGraphExpansionScores: Readonly<Record<string, number>>;
  readonly coarseEntitySeedScores: Readonly<Record<string, number>>;
  readonly coarsePathExpansionScores: Readonly<Record<string, number>>;
  readonly coarsePathSuppressionScores: Readonly<Record<string, number>>;
  readonly captureAnswerFeatures: boolean;
}

export async function collectSupplementaryData(
  params: CollectSupplementaryDataParams
): Promise<RecallSupplementaryData> {
  const candidates = params.candidates;
  // graphMetrics is independent of budget+plasticity; evidence needs candidates only.
  const [graphMetrics, budgetPenaltyFactor, plasticityFactors, evidenceAndGovernance] =
    await Promise.all([
      collectGraphMetrics(params),
      collectBudgetPenaltyFactor(params),
      collectPlasticityFactors(params),
      collectEvidenceAndGovernanceData(params, candidates)
    ]);
  const coldMetrics = computeColdGraphPathMetrics(
    params,
    graphMetrics.graphSupportCounts,
    graphMetrics.recallEdgeCounts,
    plasticityFactors
  );
  return freezeSupplementaryData(
    params,
    candidates,
    graphMetrics.graphSupportCounts,
    budgetPenaltyFactor,
    plasticityFactors,
    coldMetrics,
    evidenceAndGovernance
  );
}

function freezeSupplementaryData(
  params: CollectSupplementaryDataParams,
  candidates: readonly Readonly<MemoryEntry>[],
  graphSupportCounts: Readonly<Record<string, number>>,
  budgetPenaltyFactor: number,
  plasticityFactors: Readonly<Record<string, number>>,
  coldMetrics: Readonly<{
    readonly graphAndPathColdScore: number;
    readonly recallsEdgeCount: number;
    readonly weightTransferAmount: number;
  }>,
  evidenceAndGovernance: Readonly<{
    readonly evidenceGistsByMemoryId: Readonly<Record<string, string>>;
    readonly verifiedUserAssertionContextsByMemoryId: Readonly<
      Record<string, Readonly<RecallVerifiedUserAssertionContext>>
    >;
    readonly governanceCeilingByMemoryId: Readonly<Record<string, ManifestationState>>;
    readonly pathInflowByTarget: Readonly<Record<string, readonly PathInflowEdge[]>>;
  }>
): RecallSupplementaryData {
  return Object.freeze({
    queryProbes: params.queryProbes,
    ftsRanks: params.coarseFtsRanks,
    trigramFtsRanks: params.coarseTrigramFtsRanks,
    synthesisFtsRanks: params.coarseSynthesisFtsRanks,
    evidenceFtsRanks: params.coarseEvidenceFtsRanks,
    evidenceFtsRanksPerRef: params.coarseEvidenceFtsRanksPerRef,
    sourceProximityScores: params.coarseSourceProximityScores,
    sourceCohortKeys: params.coarseSourceCohortKeys,
    structuralScores: params.coarseStructuralScores,
    graphExpansionScores: params.coarseGraphExpansionScores,
    entitySeedScores: params.coarseEntitySeedScores,
    pathExpansionScores: params.coarsePathExpansionScores,
    pathSuppressionScores: params.coarsePathSuppressionScores,
    embeddingSimilarityScores: Object.freeze({}),
    evidenceSemanticScoresByCandidateKey: new Map(),
    graphSupportCounts: Object.freeze(graphSupportCounts),
    evidenceSupportVectorsByMemoryId: Object.freeze(buildEvidenceSupportVectors(candidates)),
    budgetPenaltyFactor,
    plasticityFactors,
    graphAndPathColdScore: coldMetrics.graphAndPathColdScore,
    recallsEdgeCount: coldMetrics.recallsEdgeCount,
    weightTransferAmount: coldMetrics.weightTransferAmount,
    evidenceGistsByMemoryId: evidenceAndGovernance.evidenceGistsByMemoryId,
    verifiedUserAssertionContextsByMemoryId:
      evidenceAndGovernance.verifiedUserAssertionContextsByMemoryId,
    governanceCeilingByMemoryId: evidenceAndGovernance.governanceCeilingByMemoryId,
    pathInflowByTarget: evidenceAndGovernance.pathInflowByTarget,
    querySoughtFacets: deriveQuerySoughtFacets(params.queryProbes)
  });
}

async function collectGraphMetrics(
  params: CollectSupplementaryDataParams
): Promise<Readonly<{
  readonly graphSupportCounts: Record<string, number>;
  readonly recallEdgeCounts: Record<string, number>;
}>> {
  const bulkReader = params.dependencies.graphSupportPort?.countInboundRecallMetricsByMemoryId;
  if (bulkReader === undefined) {
    return collectLegacyGraphMetrics(params);
  }
  try {
    const memoryIds = params.candidates.map((candidate) => candidate.object_id);
    const metrics = params.pathProjectionAsOf === undefined
      ? await bulkReader.call(params.dependencies.graphSupportPort, memoryIds, params.workspaceId)
      : await bulkReader.call(
        params.dependencies.graphSupportPort,
        memoryIds,
        params.workspaceId,
        { asOf: params.pathProjectionAsOf }
      );
    return Object.freeze({
      graphSupportCounts: Object.fromEntries(params.candidates.map((candidate) => [
        candidate.object_id,
        metrics.get(candidate.object_id)?.weightedEdgeCount ?? 0
      ])),
      recallEdgeCounts: Object.fromEntries(params.candidates.map((candidate) => [
        candidate.object_id,
        metrics.get(candidate.object_id)?.recallCount ?? 0
      ]))
    });
  } catch (error) {
    params.warn("bulk graph metrics lookup failed; using legacy lookups", {
      workspace_id: params.workspaceId,
      candidate_count: params.candidates.length,
      operation: "bulk_graph_metrics_lookup",
      errorName: errorNameOf(error),
      error: toErrorMessage(error)
    });
    return collectLegacyGraphMetrics(params);
  }
}

async function collectLegacyGraphMetrics(
  params: CollectSupplementaryDataParams
): Promise<Readonly<{
  readonly graphSupportCounts: Record<string, number>;
  readonly recallEdgeCounts: Record<string, number>;
}>> {
  const graphSupportCounts = await collectGraphSupportCounts(params);
  const recallEdgeCounts = await collectRecallEdgeCounts(params);
  return Object.freeze({ graphSupportCounts, recallEdgeCounts });
}

async function collectEvidenceAndGovernanceData(
  params: CollectSupplementaryDataParams,
  candidates: readonly Readonly<MemoryEntry>[]
): Promise<Readonly<{
  readonly evidenceGistsByMemoryId: Readonly<Record<string, string>>;
  readonly verifiedUserAssertionContextsByMemoryId: Readonly<
    Record<string, Readonly<RecallVerifiedUserAssertionContext>>
  >;
  readonly governanceCeilingByMemoryId: Readonly<Record<string, ManifestationState>>;
  readonly pathInflowByTarget: Readonly<Record<string, readonly PathInflowEdge[]>>;
}>> {
  const evidenceContexts = await collectRecallEvidenceContexts({
    dependencies: params.dependencies,
    warn: params.warn,
    workspaceId: params.workspaceId,
    candidates,
    coarseEvidenceFtsRanks: params.coarseEvidenceFtsRanks,
    coarseEvidenceFtsRanksPerRef: params.coarseEvidenceFtsRanksPerRef
  });
  const governanceDerivations = await collectGovernancePathDerivations({
    dependencies: params.dependencies,
    warn: params.warn,
    workspaceId: params.workspaceId,
    pathProjectionAsOf: params.pathProjectionAsOf,
    candidates
  });
  return Object.freeze({
    ...evidenceContexts,
    governanceCeilingByMemoryId: governanceDerivations.governanceCeilingByMemoryId,
    pathInflowByTarget: governanceDerivations.pathInflowByTarget
  });
}

async function collectGraphSupportCounts(
  params: CollectSupplementaryDataParams
): Promise<Record<string, number>> {
  return Object.fromEntries(
    await mapWithConcurrency(params.candidates, SUPPLEMENTARY_DB_LOOKUP_CONCURRENCY, async (candidate) => {
      if (params.dependencies.graphSupportPort === undefined) {
        return [candidate.object_id, 0] as const;
      }
      try {
        const count = await readInboundGraphWeight(params, candidate.object_id);
        return [candidate.object_id, count] as const;
      } catch (error) {
        params.warn("graph support lookup failed", { workspace_id: params.workspaceId, memory_id: candidate.object_id, operation: "graph_support_lookup", errorName: errorNameOf(error), error: toErrorMessage(error) });
        return [candidate.object_id, 0] as const;
      }
    })
  );
}

export function buildEvidenceSupportVectors(
  candidates: readonly Readonly<MemoryEntry>[]
): Record<string, readonly EvidenceSupportVector[]> {
  const vectorsByMemoryId: Record<string, readonly EvidenceSupportVector[]> = {};
  for (const candidate of candidates) {
    const evidenceRefs = uniqueStrings(candidate.evidence_refs ?? []);
    if (evidenceRefs.length > 0) {
      vectorsByMemoryId[candidate.object_id] = Object.freeze(
        evidenceRefs.map((source_id) => Object.freeze({
          source_kind: "evidence_ref" as const,
          source_id,
          support: normalizeGraphSupport(1)
        }))
      );
    }
  }
  return vectorsByMemoryId;
}

async function collectRecallEdgeCounts(
  params: CollectSupplementaryDataParams
): Promise<Record<string, number>> {
  return Object.fromEntries(
    await mapWithConcurrency(params.candidates, SUPPLEMENTARY_DB_LOOKUP_CONCURRENCY, async (candidate) => {
      if (params.dependencies.graphSupportPort?.countInboundRecalls === undefined) {
        return [candidate.object_id, 0] as const;
      }
      try {
        const count = await readInboundRecallCount(params, candidate.object_id);
        return [candidate.object_id, count] as const;
      } catch (error) {
        params.warn("recall edge count lookup failed", { workspace_id: params.workspaceId, memory_id: candidate.object_id, operation: "recall_edge_count_lookup", errorName: errorNameOf(error), error: toErrorMessage(error) });
        return [candidate.object_id, 0] as const;
      }
    })
  );
}

async function readInboundGraphWeight(
  params: CollectSupplementaryDataParams,
  memoryId: string
): Promise<number> {
  const port = params.dependencies.graphSupportPort;
  if (port === undefined) return 0;
  return params.pathProjectionAsOf === undefined
    ? await port.countInboundEdgesWeighted(memoryId, params.workspaceId)
    : await port.countInboundEdgesWeighted(memoryId, params.workspaceId, { asOf: params.pathProjectionAsOf });
}

async function readInboundRecallCount(
  params: CollectSupplementaryDataParams,
  memoryId: string
): Promise<number> {
  const port = params.dependencies.graphSupportPort;
  if (port?.countInboundRecalls === undefined) return 0;
  return params.pathProjectionAsOf === undefined
    ? await port.countInboundRecalls(memoryId, params.workspaceId)
    : await port.countInboundRecalls(memoryId, params.workspaceId, { asOf: params.pathProjectionAsOf });
}

async function collectBudgetPenaltyFactor(params: CollectSupplementaryDataParams): Promise<number> {
  if (params.runId === null || params.dependencies.budgetPenaltyPort === undefined) {
    return 0;
  }
  return mapBudgetPenalty(await params.dependencies.budgetPenaltyPort.getSnapshot(params.runId));
}

async function collectPlasticityFactors(
  params: CollectSupplementaryDataParams
): Promise<Readonly<Record<string, number>>> {
  if (params.dependencies.pathPlasticityPort === undefined || params.candidates.length === 0) {
    return Object.freeze({});
  }
  try {
    const port = params.dependencies.pathPlasticityPort;
    const memoryIds = params.candidates.map((candidate) => candidate.object_id);
    const strengthMap = await readWithTemporalProjection(
      params.pathProjectionAsOf,
      () => port.getStrengthByMemoryId(params.workspaceId, memoryIds),
      (options) => port.getStrengthByMemoryId(params.workspaceId, memoryIds, options)
    );
    return Object.freeze(Object.fromEntries([...strengthMap.entries()].map(([memoryId, strength]) => [memoryId, clamp01(strength)])));
  } catch (error) {
    params.warn("path plasticity port lookup failed", { workspace_id: params.workspaceId, candidate_count: params.candidates.length, operation: "path_plasticity_port_lookup", errorName: errorNameOf(error), error: toErrorMessage(error) });
    return Object.freeze({});
  }
}

function computeColdGraphPathMetrics(
  params: CollectSupplementaryDataParams,
  graphSupportCounts: Readonly<Record<string, number>>,
  recallEdgeCounts: Readonly<Record<string, number>>,
  plasticityFactors: Readonly<Record<string, number>>
): Readonly<{ readonly graphAndPathColdScore: number; readonly recallsEdgeCount: number; readonly weightTransferAmount: number }> {
  const graphAndPathCold = params.candidates.length > 0 && params.candidates.every(
    (candidate) => normalizeGraphSupport(graphSupportCounts[candidate.object_id] ?? 0) === 0 && clamp01(plasticityFactors[candidate.object_id] ?? 0) === 0
  );
  const recallsEdgeCount = Object.values(recallEdgeCounts).reduce((sum, count) => sum + count, 0);
  const recallsColdScore = params.dependencies.graphSupportPort?.countInboundRecalls === undefined
    ? (graphAndPathCold ? 1 : 0)
    : clamp01(1 - recallsEdgeCount / RECALLS_EDGE_COLD_THRESHOLD);
  const graphAndPathColdScore = graphAndPathCold ? recallsColdScore : 0;
  return Object.freeze({
    graphAndPathColdScore,
    recallsEdgeCount,
    weightTransferAmount: computeMaxWeightTransferAmount({ candidates: params.candidates, policy: params.policy, graphAndPathColdScore, warn: params.warn })
  });
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) {
    return [];
  }
  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  await Promise.all(
    Array.from({ length: limit }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await mapper(items[index]!, index);
      }
    })
  );

  return results;
}
