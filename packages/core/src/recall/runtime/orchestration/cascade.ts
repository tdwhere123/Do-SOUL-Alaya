import {
  StorageTier,
  type FineAssessmentConfig,
  type ProjectMappingAnchor,
  type RecallPolicy
} from "@do-soul/alaya-protocol";
import {
  mergeGraphExpansionCandidateSources,
  mergeGraphExpansionDiagnosticsAcrossCascade,
  mergeGraphExpansionScores,
  type GraphExpansionCandidateSourceDiagnostic
} from "../../expansion/graph-expansion.js";
import type { RecallQueryProbes } from "../../query/recall-query-probes.js";
import { buildRecallCandidateDedupeKey, type RecallTimeFilter } from "../recall-service-helpers.js";
import type {
  CoarseRecallCandidate,
  RecallGraphExpansionDiagnostics,
  RecallResult,
  RecallServiceDependencies,
  RecallServiceWarnPort
} from "../recall-service-types.js";
import type {
  CoarseFilterResult,
  CoarseFilterRunner,
  MergeCoarseFiltersFn
} from "./coarse.js";

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

type MergeTierCascadeStageParams = Readonly<{
  readonly current: CoarseFilterResult;
  readonly params: ExpandTierCascadeParams;
  readonly projectMappings: readonly Readonly<ProjectMappingAnchor>[];
  readonly tier: StorageTier;
  readonly sourceChannel: string;
  readonly scoreMultiplier: number;
  readonly degradationReason: NonNullable<RecallResult["degradation_reason"]>;
}>;

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
