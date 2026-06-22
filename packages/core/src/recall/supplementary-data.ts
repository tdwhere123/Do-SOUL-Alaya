import {
  isPathRecallEligible,
  type ManifestationState,
  type MemoryEntry,
  type PathAnchorRef,
  type PathRelation,
  type RecallPolicy
} from "@do-soul/alaya-protocol";
import type { RecallQueryProbes } from "./recall-query-probes.js";
import {
  clamp01,
  errorNameOf,
  mapBudgetPenalty,
  normalizeGraphSupport,
  toErrorMessage
} from "./recall-service-helpers.js";
import type {
  RecallServiceDependencies,
  RecallServiceWarnPort,
  RecallSupplementaryData
} from "./recall-service-types.js";
import {
  GOVERNANCE_CEILING_FAILSAFE_BAND,
  memoryGovernanceCeiling,
  type PathGovernanceContribution
} from "../path-graph/path-manifestation-policy.js";
import { computeMaxWeightTransferAmount } from "./scoring.js";
import { anchorMemoryId, uniqueStrings } from "./path-relations.js";

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
    sourceProximityScores: params.coarseSourceProximityScores,
    sourceCohortKeys: params.coarseSourceCohortKeys,
    structuralScores: params.coarseStructuralScores,
    graphExpansionScores: params.coarseGraphExpansionScores,
    entitySeedScores: params.coarseEntitySeedScores,
    pathExpansionScores: params.coarsePathExpansionScores,
    pathSuppressionScores: params.coarsePathSuppressionScores,
    embeddingSimilarityScores: Object.freeze({}),
    graphSupportCounts: Object.freeze(graphSupportCounts),
    budgetPenaltyFactor,
    plasticityFactors,
    graphAndPathColdScore: coldMetrics.graphAndPathColdScore,
    recallsEdgeCount: coldMetrics.recallsEdgeCount,
    weightTransferAmount: coldMetrics.weightTransferAmount,
    evidenceGistsByMemoryId: evidenceAndGovernance.evidenceGistsByMemoryId,
    governanceCeilingByMemoryId: evidenceAndGovernance.governanceCeilingByMemoryId
  });
}

async function collectEvidenceAndGovernanceData(
  params: CollectSupplementaryDataParams,
  candidates: readonly Readonly<MemoryEntry>[]
): Promise<Readonly<{
  readonly evidenceGistsByMemoryId: Readonly<Record<string, string>>;
  readonly governanceCeilingByMemoryId: Readonly<Record<string, ManifestationState>>;
}>> {
  const evidenceGistsByMemoryId = await collectEvidenceGistsByMemoryId({
    dependencies: params.dependencies,
    warn: params.warn,
    workspaceId: params.workspaceId,
    candidates,
    coarseEvidenceFtsRanks: params.coarseEvidenceFtsRanks,
    coarseEvidenceFtsRanksPerRef: params.coarseEvidenceFtsRanksPerRef
  });
  const governanceCeilingByMemoryId = await collectGovernanceCeilings({
    dependencies: params.dependencies,
    warn: params.warn,
    workspaceId: params.workspaceId,
    candidates
  });
  return Object.freeze({ evidenceGistsByMemoryId, governanceCeilingByMemoryId });
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
    params.warn("evidence gist lookup for rerank failed", {
      workspace_id: params.workspaceId,
      operation: "evidence_gist_lookup_for_rerank",
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
  // Restrict to candidates that already landed in the pool through an
  // evidence FTS hit — their gists are the ones whose paraphrase carries
  // recall-relevant semantics. Avoids an unbounded findByIds over every
  // memory's full evidence_refs set.
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
  // invariant: findByIds payload bounded by evidence-FTS hit set, not the
  // candidate's full evidence_refs cardinality. see also: P2-R2-E.
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
  // invariant: per-memory evidence_refs cardinality is capped before the
  // findByIds payload is built so a pathological memory cannot dominate the
  // rerank loop's tokenizer / Set fan-out.
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
  // invariant: pick gist from the highest-ranked ref in evidence_refs
  // (per coarseEvidenceFtsRanksPerRef); stable by evidence_refs order on ties.
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
  // fallback: aggregated rank > 0 but no per-ref rank populated; mirrors the
  // legacy first-non-empty-gist rule for future producers that only emit the
  // aggregate rank.
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

// invariant: governance_class is a HARD CEILING on recall manifestation.
// Absent path expansion is fail-open; path read failure is fail-closed to the
// safe hint band for every candidate.
async function collectGovernanceCeilings(params: {
  readonly dependencies: Pick<RecallServiceDependencies, "pathExpansionPort">;
  readonly warn: RecallServiceWarnPort;
  readonly workspaceId: string;
  readonly candidates: readonly Readonly<MemoryEntry>[];
}): Promise<Readonly<Record<string, ManifestationState>>> {
  const pathExpansionPort = params.dependencies.pathExpansionPort;
  if (pathExpansionPort === undefined || params.candidates.length === 0) {
    return Object.freeze({});
  }
  const candidateIds = new Set(params.candidates.map((candidate) => candidate.object_id));
  const anchors = buildGovernanceCandidateAnchors(candidateIds);
  let paths: readonly Readonly<PathRelation>[];
  try {
    paths = await pathExpansionPort.findByAnchors(params.workspaceId, anchors);
  } catch (error) {
    params.warn("governance ceiling path lookup failed", {
      workspace_id: params.workspaceId,
      candidate_count: params.candidates.length,
      operation: "governance_ceiling_path_lookup",
      errorName: errorNameOf(error),
      error: toErrorMessage(error)
    });
    return buildGovernanceFailsafeCeilings(candidateIds);
  }
  const contributionsByMemoryId = collectGovernanceContributions(paths, candidateIds);
  return buildGovernanceCeilingByMemoryId(contributionsByMemoryId);
}

function buildGovernanceCandidateAnchors(
  candidateIds: ReadonlySet<string>
): readonly PathAnchorRef[] {
  return [...candidateIds].map((object_id) => ({ kind: "object", object_id }));
}

function buildGovernanceFailsafeCeilings(
  candidateIds: ReadonlySet<string>
): Readonly<Record<string, ManifestationState>> {
  // fail-CLOSED: cap every candidate to the safe band so a transient read
  // error cannot lift a governed memory to its full strength tier.
  const failsafeCeilings: Record<string, ManifestationState> = {};
  for (const object_id of candidateIds) {
    failsafeCeilings[object_id] = GOVERNANCE_CEILING_FAILSAFE_BAND;
  }
  return Object.freeze(failsafeCeilings);
}

function collectGovernanceContributions(
  paths: readonly Readonly<PathRelation>[],
  candidateIds: ReadonlySet<string>
): ReadonlyMap<string, PathGovernanceContribution[]> {
  const contributionsByMemoryId = new Map<string, PathGovernanceContribution[]>();
  for (const path of paths) {
    const targetMemoryId = resolveGovernedTargetMemoryId(path, candidateIds);
    if (targetMemoryId === undefined) {
      continue;
    }
    const contribution: PathGovernanceContribution = {
      governance_class: path.legitimacy.governance_class,
      evidence_basis: path.legitimacy.evidence_basis
    };
    const contributions = contributionsByMemoryId.get(targetMemoryId);
    if (contributions === undefined) {
      contributionsByMemoryId.set(targetMemoryId, [contribution]);
    } else {
      contributions.push(contribution);
    }
  }
  return contributionsByMemoryId;
}

function resolveGovernedTargetMemoryId(
  path: Readonly<PathRelation>,
  candidateIds: ReadonlySet<string>
): string | undefined {
  if (!isPathRecallEligible(path)) {
    return undefined;
  }
  // invariant: the ceiling is INBOUND — keyed on the path's target memory.
  // findByAnchors also returns paths where the candidate is the SOURCE anchor;
  // those govern the path's target, not the source.
  const targetMemoryId = anchorMemoryId(path.anchors.target_anchor);
  if (targetMemoryId === undefined || !candidateIds.has(targetMemoryId)) {
    return undefined;
  }
  return targetMemoryId;
}

function buildGovernanceCeilingByMemoryId(
  contributionsByMemoryId: ReadonlyMap<string, readonly PathGovernanceContribution[]>
): Readonly<Record<string, ManifestationState>> {
  const ceilingByMemoryId: Record<string, ManifestationState> = {};
  for (const [memoryId, contributions] of contributionsByMemoryId) {
    ceilingByMemoryId[memoryId] = memoryGovernanceCeiling(contributions);
  }
  return Object.freeze(ceilingByMemoryId);
}
