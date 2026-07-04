import type { ProjectMappingAnchor } from "@do-soul/alaya-protocol";
import { classifyProjectMappingCandidate } from "../runtime/recall-service-helpers.js";
import type {
  CoarseRecallCandidate,
  RecallGraphExpansionDiagnostics,
  RecallResult,
  RecallServiceDependencies
} from "../runtime/recall-service-types.js";
import type { GraphExpansionCandidateSourceDiagnostic } from "../expansion/graph-expansion.js";
import {
  rankCoarseCandidateDrafts,
  type CoarseCandidateDraft
} from "./coarse-candidates.js";
import { uniqueStrings } from "../expansion/path-relations.js";

const DYNAMIC_RECALL_TOTAL_CANDIDATE_CAP = 1000;

export interface CoarseFilterRunResult {
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
}

export interface BuildCoarseFilterResultParams {
  readonly totalScanned: number;
  readonly drafts: ReadonlyMap<string, CoarseCandidateDraft>;
  readonly projectMappings: readonly Readonly<ProjectMappingAnchor>[];
  readonly dependencies: Pick<RecallServiceDependencies, "projectMappingPort">;
  readonly sourceChannel?: string;
  readonly scoreMultiplier?: number;
  readonly ftsRanks: ReadonlyMap<string, number>;
  readonly trigramFtsRanks: ReadonlyMap<string, number>;
  readonly evidenceFtsRanks: ReadonlyMap<string, number>;
  readonly evidenceFtsRanksPerRef: ReadonlyMap<string, number>;
  readonly sourceProximityScores: ReadonlyMap<string, number>;
  readonly sourceCohortKeys: Readonly<Record<string, string>>;
  readonly structuralScores: ReadonlyMap<string, number>;
  readonly graphExpansionScores: ReadonlyMap<string, number>;
  readonly graphExpansionDiagnostics: Readonly<RecallGraphExpansionDiagnostics>;
  readonly graphExpansionCandidateSources: ReadonlyMap<string, Readonly<GraphExpansionCandidateSourceDiagnostic>>;
  readonly entitySeedScores: ReadonlyMap<string, number>;
  readonly pathExpansionScores: ReadonlyMap<string, number>;
  readonly pathSuppressionScores: ReadonlyMap<string, number>;
}

export function buildCoarseFilterResult(
  params: BuildCoarseFilterResultParams
): CoarseFilterRunResult {
  return Object.freeze({
    total_scanned: params.totalScanned,
    candidates: buildSupplementedCandidates(params),
    ftsRanks: Object.freeze(Object.fromEntries(params.ftsRanks.entries())),
    trigramFtsRanks: Object.freeze(Object.fromEntries(params.trigramFtsRanks.entries())),
    synthesisFtsRanks: Object.freeze({}),
    evidenceFtsRanks: Object.freeze(Object.fromEntries(params.evidenceFtsRanks.entries())),
    evidenceFtsRanksPerRef: Object.freeze(Object.fromEntries(params.evidenceFtsRanksPerRef.entries())),
    sourceProximityScores: Object.freeze(Object.fromEntries(params.sourceProximityScores.entries())),
    sourceCohortKeys: params.sourceCohortKeys,
    structuralScores: Object.freeze(Object.fromEntries(params.structuralScores.entries())),
    graphExpansionScores: Object.freeze(Object.fromEntries(params.graphExpansionScores.entries())),
    graphExpansionDiagnostics: params.graphExpansionDiagnostics,
    graphExpansionCandidateSources: params.graphExpansionCandidateSources,
    entitySeedScores: Object.freeze(Object.fromEntries(params.entitySeedScores.entries())),
    pathExpansionScores: Object.freeze(Object.fromEntries(params.pathExpansionScores.entries())),
    pathSuppressionScores: Object.freeze(Object.fromEntries(params.pathSuppressionScores.entries())),
    degradation_reason: null
  });
}

function buildSupplementedCandidates(
  params: BuildCoarseFilterResultParams
): readonly Readonly<CoarseRecallCandidate>[] {
  const anchorMap = new Map(params.projectMappings.map((mapping) => [mapping.global_object_id, mapping]));
  const selectedDrafts = rankCoarseCandidateDrafts([...params.drafts.values()])
    .slice(0, DYNAMIC_RECALL_TOTAL_CANDIDATE_CAP);
  return Object.freeze(
    selectedDrafts.flatMap((draft) => {
      const classification = classifyProjectMappingCandidate(
        draft.entry,
        anchorMap,
        params.dependencies.projectMappingPort
      );
      if (!classification.include) {
        return [];
      }
      return [buildSupplementedCandidate(params, draft, classification.isAdvisory)];
    })
  );
}

function buildSupplementedCandidate(
  params: BuildCoarseFilterResultParams,
  draft: Readonly<CoarseCandidateDraft>,
  isAdvisory: boolean | undefined
): Readonly<CoarseRecallCandidate> {
  return Object.freeze({
    entry: draft.entry,
    isAdvisory,
    admissionPlanes: Object.freeze([...draft.admissionPlanes]),
    firstAdmissionPlane: draft.firstAdmissionPlane,
    sourceChannels: Object.freeze(uniqueStrings([
      ...draft.sourceChannels,
      ...(params.sourceChannel === undefined ? [] : [params.sourceChannel])
    ])),
    structuralScore: draft.structuralScore,
    pathExpansionSources: Object.freeze([...draft.pathExpansionSources]),
    ...(draft.reachedViaEarnedCoRecalledFanin ? { reachedViaEarnedCoRecalledFanin: true } : {}),
    ...(params.sourceChannel === undefined ? {} : { sourceChannel: params.sourceChannel }),
    ...(params.scoreMultiplier === undefined ? {} : { scoreMultiplier: params.scoreMultiplier })
  });
}
