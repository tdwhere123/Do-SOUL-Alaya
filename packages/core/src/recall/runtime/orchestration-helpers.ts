import {
  StorageTier,
  type FineAssessmentConfig,
  type ProjectMappingAnchor,
  type RecallCandidate,
  type RecallPolicy,
  type TaskObjectSurface
} from "@do-soul/alaya-protocol";
import type { ManifestationBiasSidecarEntry } from "../../manifestation/manifestation-resolver.js";
import { fineAssess } from "../delivery/fine-assessment.js";
import {
  mergeGraphExpansionCandidateSources,
  mergeGraphExpansionDiagnosticsAcrossCascade,
  mergeGraphExpansionScores,
  type GraphExpansionCandidateSourceDiagnostic
} from "../expansion/graph-expansion.js";
import type { RecallQueryProbes } from "../query/recall-query-probes.js";
import { buildRecallCandidateDedupeKey, errorNameOf, toErrorMessage, type RecallTimeFilter } from "./recall-service-helpers.js";
import { collectSupplementaryData } from "../supplements/supplementary-data.js";
import type {
  CoarseRecallCandidate,
  RecallCandidateDiagnostic,
  RecallGraphExpansionDiagnostics,
  RecallResult,
  RecallServiceDependencies,
  RecallServiceWarnPort,
  RecallSupplementaryData,
  TokenEstimator
} from "./recall-service-types.js";

export type CoarseFilterResult = Readonly<{
  readonly total_scanned: number;
  readonly candidates: readonly Readonly<CoarseRecallCandidate>[];
  readonly ftsRanks: Readonly<Record<string, number>>;
  readonly trigramFtsRanks: Readonly<Record<string, number>>;
  readonly synthesisFtsRanks: Readonly<Record<string, number>>;
  readonly evidenceFtsRanks: Readonly<Record<string, number>>;
  readonly evidenceFtsRanksPerRef: Readonly<Record<string, number>>;
  readonly sourceProximityScores: Readonly<Record<string, number>>;
  readonly sourceCohortKeys: Readonly<Record<string, string>>;
  readonly structuralScores: Readonly<Record<string, number>>;
  readonly graphExpansionScores: Readonly<Record<string, number>>;
  readonly graphExpansionDiagnostics: Readonly<RecallGraphExpansionDiagnostics>;
  readonly graphExpansionCandidateSources: ReadonlyMap<string, Readonly<GraphExpansionCandidateSourceDiagnostic>>;
  readonly entitySeedScores: Readonly<Record<string, number>>;
  readonly pathExpansionScores: Readonly<Record<string, number>>;
  readonly pathSuppressionScores: Readonly<Record<string, number>>;
  readonly degradation_reason: RecallResult["degradation_reason"];
}>;

type CoarseFilterOptions = Readonly<{
  readonly tier?: StorageTier;
  readonly projectMappings?: readonly Readonly<ProjectMappingAnchor>[];
  readonly sourceChannel?: string;
  readonly scoreMultiplier?: number;
  readonly timeFilter?: RecallTimeFilter;
  readonly queryProbes?: Readonly<RecallQueryProbes>;
  readonly winnerMemoryIds?: ReadonlySet<string>;
  readonly deliveryMaxEntries?: number;
}>;

type CoarseFilterRunner = (
  workspaceId: string,
  config: Readonly<RecallPolicy>["coarse_filter"],
  queryText: string | null,
  options: CoarseFilterOptions
) => Promise<CoarseFilterResult>;

type MergeCoarseFiltersFn = (
  current: CoarseFilterResult,
  next: CoarseFilterResult,
  degradationReason: NonNullable<RecallResult["degradation_reason"]>
) => CoarseFilterResult;

export type ExpandTierCascadeParams = Readonly<{
  readonly coarseFilter: CoarseFilterRunner;
  readonly projectMappingPort?: RecallServiceDependencies["projectMappingPort"];
  readonly mergeCoarseFilters: MergeCoarseFiltersFn;
  readonly workspaceId: string;
  readonly runId: string | null;
  readonly config: Readonly<RecallPolicy>["coarse_filter"];
  readonly fineAssessmentConfig: Readonly<FineAssessmentConfig>;
  readonly queryText: string | null;
  readonly queryProbes: Readonly<RecallQueryProbes>;
  readonly hotCoarseFilter: CoarseFilterResult;
  readonly hotCoarseCandidateCount: number;
  readonly winnerMemoryIds: ReadonlySet<string>;
  readonly timeFilter?: RecallTimeFilter;
  readonly warn: RecallServiceWarnPort;
}>;

export type AssessCoarseFilterParams = Readonly<{
  readonly dependencies: RecallServiceDependencies;
  readonly warn: RecallServiceWarnPort;
  readonly now: () => string;
  readonly coarseFilter: CoarseFilterResult;
  readonly workspaceId: string;
  readonly runId: string | null;
  readonly queryText: string | null;
  readonly queryProbes: Readonly<RecallQueryProbes>;
  readonly policy: Readonly<RecallPolicy>;
  readonly winnerMemoryIds: ReadonlySet<string>;
  readonly tokenEstimator: TokenEstimator;
}>;

export type AssessCoarseFilterResult = Readonly<{
  readonly supplementaryData: RecallSupplementaryData;
  readonly candidates: readonly Readonly<RecallCandidate>[];
  readonly diagnostics: readonly Readonly<RecallCandidateDiagnostic>[];
}>;

type ManifestationBiasSidecarLoadParams = Readonly<{
  readonly sidecarPort: NonNullable<RecallServiceDependencies["manifestationSidecarPort"]>;
  readonly warn: RecallServiceWarnPort;
  readonly workspaceId: string;
  readonly runId: string;
  readonly taskSurfaceRef: Readonly<TaskObjectSurface>;
  readonly anchorMemoryObjectIds: readonly string[];
}>;

type MergeTierCascadeStageParams = Readonly<{
  readonly current: CoarseFilterResult;
  readonly params: ExpandTierCascadeParams;
  readonly projectMappings: readonly Readonly<ProjectMappingAnchor>[];
  readonly tier: StorageTier;
  readonly sourceChannel: string;
  readonly scoreMultiplier: number;
  readonly degradationReason: NonNullable<RecallResult["degradation_reason"]>;
}>;

export function collectManifestationAnchorMemoryObjectIds(
  candidates: readonly Readonly<RecallCandidate>[]
): readonly string[] {
  return Object.freeze([...new Set(candidates.map((candidate) => candidate.object_id))]);
}

export async function loadManifestationBiasSidecar(
  params: ManifestationBiasSidecarLoadParams
): Promise<readonly Readonly<ManifestationBiasSidecarEntry>[] | null> {
  try {
    return await params.sidecarPort.buildBiasSidecar({
      workspaceId: params.workspaceId,
      runId: params.runId,
      anchorMemoryObjectIds: params.anchorMemoryObjectIds,
      taskSurfaceRef: params.taskSurfaceRef
    });
  } catch (error) {
    params.warn("manifestation bias sidecar build failed", {
      workspace_id: params.workspaceId,
      run_id: params.runId,
      operation: "manifestation_bias_sidecar_build",
      errorName: errorNameOf(error),
      error: toErrorMessage(error)
    });
    return null;
  }
}

export function collectManifestationBiasEntriesByMemoryId(
  sidecarEntries: readonly Readonly<ManifestationBiasSidecarEntry>[]
): ReadonlyMap<string, Readonly<ManifestationBiasSidecarEntry>> {
  const byMemoryId = new Map<string, Readonly<ManifestationBiasSidecarEntry>>();
  const sortedEntries = [...sidecarEntries].sort((left, right) => {
    if (right.unfinishedness_bias !== left.unfinishedness_bias) {
      return right.unfinishedness_bias - left.unfinishedness_bias;
    }
    return left.candidate_id.localeCompare(right.candidate_id);
  });

  for (const entry of sortedEntries) {
    if (entry.target_memory_object_id !== null && !byMemoryId.has(entry.target_memory_object_id)) {
      byMemoryId.set(entry.target_memory_object_id, entry);
    }
  }

  return byMemoryId;
}

export function applyManifestationBiasEntries(
  candidates: readonly Readonly<RecallCandidate>[],
  byMemoryId: ReadonlyMap<string, Readonly<ManifestationBiasSidecarEntry>>
): readonly Readonly<RecallCandidate>[] {
  return Object.freeze(
    candidates.map((candidate) => {
      const sidecar = byMemoryId.get(candidate.object_id);
      if (sidecar === undefined) {
        return candidate;
      }
      return Object.freeze({
        ...candidate,
        pending_incomplete: sidecar.pending_incomplete,
        unfinishedness_bias: sidecar.unfinishedness_bias
      });
    })
  );
}

export async function loadTierCascadeProjectMappings(
  projectMappingPort: RecallServiceDependencies["projectMappingPort"],
  workspaceId: string
): Promise<readonly Readonly<ProjectMappingAnchor>[]> {
  if (projectMappingPort?.findByWorkspace === undefined) {
    return [];
  }
  return projectMappingPort.findByWorkspace(workspaceId);
}

export async function mergeTierCascadeStage(
  params: MergeTierCascadeStageParams
): Promise<CoarseFilterResult> {
  const next = await params.params.coarseFilter(
    params.params.workspaceId,
    params.params.config,
    params.params.queryText,
    {
      tier: params.tier,
      projectMappings: params.projectMappings,
      sourceChannel: params.sourceChannel,
      scoreMultiplier: params.scoreMultiplier,
      timeFilter: params.params.timeFilter,
      queryProbes: params.params.queryProbes,
      winnerMemoryIds: params.params.winnerMemoryIds,
      deliveryMaxEntries: params.params.fineAssessmentConfig.budgets.max_entries
    }
  );
  return params.params.mergeCoarseFilters(params.current, next, params.degradationReason);
}

export async function collectCoarseFilterSupplementaryData(
  params: AssessCoarseFilterParams
): Promise<RecallSupplementaryData> {
  return collectSupplementaryData({
    dependencies: params.dependencies,
    warn: params.warn,
    candidates: params.coarseFilter.candidates.map((candidate) => candidate.entry),
    workspaceId: params.workspaceId,
    runId: params.runId,
    queryText: params.queryText,
    queryProbes: params.queryProbes,
    policy: params.policy,
    coarseFtsRanks: params.coarseFilter.ftsRanks,
    coarseTrigramFtsRanks: params.coarseFilter.trigramFtsRanks,
    coarseSynthesisFtsRanks: params.coarseFilter.synthesisFtsRanks,
    coarseEvidenceFtsRanks: params.coarseFilter.evidenceFtsRanks,
    coarseEvidenceFtsRanksPerRef: params.coarseFilter.evidenceFtsRanksPerRef,
    coarseSourceProximityScores: params.coarseFilter.sourceProximityScores,
    coarseSourceCohortKeys: params.coarseFilter.sourceCohortKeys,
    coarseStructuralScores: params.coarseFilter.structuralScores,
    coarseGraphExpansionScores: params.coarseFilter.graphExpansionScores,
    coarseEntitySeedScores: params.coarseFilter.entitySeedScores,
    coarsePathExpansionScores: params.coarseFilter.pathExpansionScores,
    coarsePathSuppressionScores: params.coarseFilter.pathSuppressionScores
  });
}

export function runCoarseFineAssessment(
  params: AssessCoarseFilterParams,
  supplementaryData: RecallSupplementaryData
): ReturnType<typeof fineAssess> {
  return fineAssess({
    candidates: params.coarseFilter.candidates,
    policy: params.policy,
    winnerMemoryIds: params.winnerMemoryIds,
    supplementaryData,
    tokenEstimator: params.tokenEstimator,
    now: params.now,
    warn: params.warn
  });
}

export function collectUniqueCoarseCandidates(
  currentCandidates: readonly Readonly<CoarseRecallCandidate>[],
  nextCandidates: readonly Readonly<CoarseRecallCandidate>[]
): readonly Readonly<CoarseRecallCandidate>[] {
  const seen = new Set(currentCandidates.map((candidate) => buildRecallCandidateDedupeKey(candidate)));
  return nextCandidates.filter((candidate) => {
    const key = buildRecallCandidateDedupeKey(candidate);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

export function mergeReadonlyRecords<T>(
  current: Readonly<Record<string, T>>,
  next: Readonly<Record<string, T>>
): Readonly<Record<string, T>> {
  return Object.freeze({
    ...current,
    ...next
  });
}

export function mergeCascadeGraphExpansion(params: Readonly<{
  readonly current: CoarseFilterResult;
  readonly next: CoarseFilterResult;
  readonly nextCandidateIds: ReadonlySet<string>;
}>): Readonly<{
  readonly graphExpansionCandidateSources: ReadonlyMap<string, Readonly<GraphExpansionCandidateSourceDiagnostic>>;
  readonly graphExpansionScores: Readonly<Record<string, number>>;
  readonly graphExpansionDiagnostics: Readonly<RecallGraphExpansionDiagnostics>;
}> {
  const graphExpansionCandidateSources = mergeGraphExpansionCandidateSources(
    params.current.graphExpansionCandidateSources,
    params.next.graphExpansionCandidateSources,
    params.nextCandidateIds
  );
  return Object.freeze({
    graphExpansionCandidateSources,
    graphExpansionScores: mergeGraphExpansionScores(
      params.current.graphExpansionScores,
      params.next.graphExpansionScores,
      params.nextCandidateIds
    ),
    graphExpansionDiagnostics: mergeGraphExpansionDiagnosticsAcrossCascade({
      sources: graphExpansionCandidateSources,
      currentFanIn: params.current.graphExpansionDiagnostics.multi_seed_graph_fan_in,
      nextFanIn: params.next.graphExpansionDiagnostics.multi_seed_graph_fan_in
    })
  });
}
