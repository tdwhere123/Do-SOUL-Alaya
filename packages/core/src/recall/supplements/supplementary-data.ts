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
import { computeMaxWeightTransferAmount } from "../scoring/scoring.js";
import { uniqueStrings } from "../expansion/path-relations.js";
import { collectGovernancePathDerivations } from "./supplementary-data-governance-paths.js";
import { deriveQuerySoughtFacets } from "../query/query-facet-router.js";

const RECALLS_EDGE_COLD_THRESHOLD = 50;
export const SUPPLEMENTARY_DB_LOOKUP_CONCURRENCY = 16;
const MAX_REFS_PER_MEMORY = 8;

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
  const graphSupportCounts = await collectGraphSupportCounts(params);
  const recallEdgeCounts = await collectRecallEdgeCounts(params);
  const budgetPenaltyFactor = await collectBudgetPenaltyFactor(params);
  const plasticityFactors = await collectPlasticityFactors(params);
  const coldMetrics = computeColdGraphPathMetrics(params, graphSupportCounts, recallEdgeCounts, plasticityFactors);
  const evidenceAndGovernance = await collectEvidenceAndGovernanceData(params, candidates);

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
    graphSupportCounts: Object.freeze(graphSupportCounts),
    evidenceSupportVectorsByMemoryId: Object.freeze(buildEvidenceSupportVectors(candidates)),
    budgetPenaltyFactor,
    plasticityFactors,
    graphAndPathColdScore: coldMetrics.graphAndPathColdScore,
    recallsEdgeCount: coldMetrics.recallsEdgeCount,
    weightTransferAmount: coldMetrics.weightTransferAmount,
    evidenceGistsByMemoryId: evidenceAndGovernance.evidenceGistsByMemoryId,
    governanceCeilingByMemoryId: evidenceAndGovernance.governanceCeilingByMemoryId,
    pathInflowByTarget: evidenceAndGovernance.pathInflowByTarget,
    querySoughtFacets: deriveQuerySoughtFacets(params.queryProbes)
  });
}

async function collectEvidenceAndGovernanceData(
  params: CollectSupplementaryDataParams,
  candidates: readonly Readonly<MemoryEntry>[]
): Promise<Readonly<{
  readonly evidenceGistsByMemoryId: Readonly<Record<string, string>>;
  readonly governanceCeilingByMemoryId: Readonly<Record<string, ManifestationState>>;
  readonly pathInflowByTarget: Readonly<Record<string, readonly PathInflowEdge[]>>;
}>> {
  const evidenceGistsByMemoryId = params.captureAnswerFeatures
    ? await collectEvidenceGistsByMemoryId({
        dependencies: params.dependencies,
        warn: params.warn,
        workspaceId: params.workspaceId,
        candidates,
        coarseEvidenceFtsRanks: params.coarseEvidenceFtsRanks,
        coarseEvidenceFtsRanksPerRef: params.coarseEvidenceFtsRanksPerRef
      })
    : Object.freeze({});
  const governanceDerivations = await collectGovernancePathDerivations({
    dependencies: params.dependencies,
    warn: params.warn,
    workspaceId: params.workspaceId,
    candidates
  });
  return Object.freeze({
    evidenceGistsByMemoryId,
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
        const count = await params.dependencies.graphSupportPort.countInboundEdgesWeighted(candidate.object_id, params.workspaceId);
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
        const count = await params.dependencies.graphSupportPort.countInboundRecalls(candidate.object_id, params.workspaceId);
        return [candidate.object_id, count] as const;
      } catch (error) {
        params.warn("recall edge count lookup failed", { workspace_id: params.workspaceId, memory_id: candidate.object_id, operation: "recall_edge_count_lookup", errorName: errorNameOf(error), error: toErrorMessage(error) });
        return [candidate.object_id, 0] as const;
      }
    })
  );
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
    const strengthMap = await params.dependencies.pathPlasticityPort.getStrengthByMemoryId(
      params.workspaceId,
      params.candidates.map((candidate) => candidate.object_id)
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

async function collectEvidenceGistsByMemoryId(params: {
  readonly dependencies: Pick<RecallServiceDependencies, "evidenceSearchPort">;
  readonly warn: RecallServiceWarnPort;
  readonly workspaceId: string;
  readonly candidates: readonly Readonly<MemoryEntry>[];
  readonly coarseEvidenceFtsRanks: Readonly<Record<string, number>>;
  readonly coarseEvidenceFtsRanksPerRef: Readonly<Record<string, number>>;
}): Promise<Readonly<Record<string, string>>> {
  const evidenceSearchPort = params.dependencies.evidenceSearchPort;
  if (evidenceSearchPort?.findByIds === undefined) {
    return Object.freeze({});
  }
  const relevantCandidates = collectRelevantEvidenceCandidates(
    params.candidates,
    params.coarseEvidenceFtsRanks
  );
  if (relevantCandidates.length === 0) {
    return Object.freeze({});
  }
  const evidenceIds = collectRelevantEvidenceIds(
    relevantCandidates,
    params.coarseEvidenceFtsRanksPerRef
  );
  if (evidenceIds.length === 0) {
    return Object.freeze({});
  }
  try {
    const evidenceCapsules = await evidenceSearchPort.findByIds(params.workspaceId, evidenceIds);
    const gistById = buildEvidenceGistById(params.workspaceId, evidenceCapsules);
    return buildMemoryEvidenceGists(
      relevantCandidates,
      params.coarseEvidenceFtsRanksPerRef,
      gistById
    );
  } catch (error) {
    params.warn("evidence gist lookup for diagnostics failed", {
      workspace_id: params.workspaceId,
      operation: "evidence_gist_lookup_for_diagnostics",
      errorName: errorNameOf(error),
      error: toErrorMessage(error)
    });
    return Object.freeze({});
  }
}

function collectRelevantEvidenceCandidates(
  candidates: readonly Readonly<MemoryEntry>[],
  coarseEvidenceFtsRanks: Readonly<Record<string, number>>
): readonly Readonly<MemoryEntry>[] {
  // Only candidates that landed via an evidence FTS hit; bounds findByIds instead of scanning every memory's full evidence_refs.
  return candidates.filter(
    (entry) =>
      entry.evidence_refs.length > 0 &&
      (coarseEvidenceFtsRanks[entry.object_id] ?? 0) > 0
  );
}

function collectRelevantEvidenceIds(
  candidates: readonly Readonly<MemoryEntry>[],
  coarseEvidenceFtsRanksPerRef: Readonly<Record<string, number>>
): readonly string[] {
  // invariant: findByIds payload bounded by the evidence-FTS hit set, not the candidate's full evidence_refs cardinality.
  return uniqueStrings(
    candidates.flatMap((entry) =>
      selectRelevantEvidenceRefs(entry, coarseEvidenceFtsRanksPerRef)
    )
  );
}

function selectRelevantEvidenceRefs(
  entry: Readonly<MemoryEntry>,
  coarseEvidenceFtsRanksPerRef: Readonly<Record<string, number>>
): readonly string[] {
  // Bound diagnostic enrichment independently of a memory's evidence cardinality.
  const hitRefs = entry.evidence_refs.filter(
    (ref) => (coarseEvidenceFtsRanksPerRef[ref] ?? 0) > 0
  );
  if (hitRefs.length <= MAX_REFS_PER_MEMORY) {
    return hitRefs;
  }
  return [...hitRefs]
    .sort(
      (left, right) =>
        (coarseEvidenceFtsRanksPerRef[right] ?? 0) -
        (coarseEvidenceFtsRanksPerRef[left] ?? 0)
    )
    .slice(0, MAX_REFS_PER_MEMORY);
}

function buildEvidenceGistById(
  workspaceId: string,
  evidenceCapsules: readonly Readonly<{ readonly workspace_id: string; readonly object_id: string; readonly gist?: string | null }>[]
): ReadonlyMap<string, string> {
  const gistById = new Map<string, string>();
  for (const evidence of evidenceCapsules) {
    if (evidence.workspace_id !== workspaceId) {
      continue;
    }
    const gist = evidence.gist?.trim() ?? "";
    if (gist.length > 0) {
      gistById.set(evidence.object_id, gist);
    }
  }
  return gistById;
}

function buildMemoryEvidenceGists(
  candidates: readonly Readonly<MemoryEntry>[],
  coarseEvidenceFtsRanksPerRef: Readonly<Record<string, number>>,
  gistById: ReadonlyMap<string, string>
): Readonly<Record<string, string>> {
  const gistsByMemory: Record<string, string> = {};
  for (const entry of candidates) {
    const gist =
      pickRankedEvidenceGist(entry, coarseEvidenceFtsRanksPerRef, gistById) ??
      pickFallbackEvidenceGist(entry, gistById);
    if (gist !== undefined) {
      gistsByMemory[entry.object_id] = gist;
    }
  }
  return Object.freeze(gistsByMemory);
}

function pickRankedEvidenceGist(
  entry: Readonly<MemoryEntry>,
  coarseEvidenceFtsRanksPerRef: Readonly<Record<string, number>>,
  gistById: ReadonlyMap<string, string>
): string | undefined {
  // invariant: gist from the highest-ranked ref (per coarseEvidenceFtsRanksPerRef); stable by evidence_refs order on ties.
  const orderedRefs = [...entry.evidence_refs].sort(
    (left, right) =>
      (coarseEvidenceFtsRanksPerRef[right] ?? 0) -
      (coarseEvidenceFtsRanksPerRef[left] ?? 0)
  );
  return orderedRefs
    .map((ref) => gistById.get(ref))
    .find((gist) => gist !== undefined && gist.length > 0);
}

function pickFallbackEvidenceGist(
  entry: Readonly<MemoryEntry>,
  gistById: ReadonlyMap<string, string>
): string | undefined {
  // fallback: aggregate rank > 0 but no per-ref rank; first-non-empty-gist rule for producers that emit only the aggregate.
  return entry.evidence_refs
    .map((ref) => gistById.get(ref))
    .find((gist) => gist !== undefined && gist.length > 0);
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
