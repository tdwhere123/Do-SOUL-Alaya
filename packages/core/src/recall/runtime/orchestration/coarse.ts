import {
  StorageTier,
  type RecallCandidate,
  type ProjectMappingAnchor,
  type RecallPolicy
} from "@do-soul/alaya-protocol";
import { fineAssess } from "../../delivery/fine-assessment.js";
import type { RecallQueryProbes } from "../../query/recall-query-probes.js";
import type { RecallTimeFilter } from "../recall-service-helpers.js";
import { collectSupplementaryData } from "../../supplements/supplementary-data.js";
import type {
  CoarseRecallCandidate,
  RecallCandidateDiagnostic,
  RecallGraphExpansionDiagnostics,
  RecallResult,
  RecallServiceDependencies,
  RecallServiceWarnPort,
  RecallSupplementaryData,
  TokenEstimator
} from "../recall-service-types.js";
import type { GraphExpansionCandidateSourceDiagnostic } from "../../expansion/graph-expansion.js";

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

export type CoarseFilterOptions = Readonly<{
  readonly tier?: StorageTier;
  readonly projectMappings?: readonly Readonly<ProjectMappingAnchor>[];
  readonly sourceChannel?: string;
  readonly scoreMultiplier?: number;
  readonly timeFilter?: RecallTimeFilter;
  readonly queryProbes?: Readonly<RecallQueryProbes>;
  readonly winnerMemoryIds?: ReadonlySet<string>;
  readonly deliveryMaxEntries?: number;
}>;

export type CoarseFilterRunner = (
  workspaceId: string,
  config: Readonly<RecallPolicy>["coarse_filter"],
  queryText: string | null,
  options: CoarseFilterOptions
) => Promise<CoarseFilterResult>;

export type MergeCoarseFiltersFn = (
  current: CoarseFilterResult,
  next: CoarseFilterResult,
  degradationReason: NonNullable<RecallResult["degradation_reason"]>
) => CoarseFilterResult;

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
