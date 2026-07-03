import { type MemoryEntry, type RecallPolicy } from "@do-soul/alaya-protocol";
import { clamp01, matchesDeterministicFilter } from "./recall-service-helpers.js";
import type {
  RecallAdmissionPlane,
  RecallPathExpansionSourceDiagnostic
} from "./recall-service-types.js";
import { uniquePathExpansionSources, uniqueStrings } from "./path-relations.js";
import {
  SOURCE_PROXIMITY_STRUCTURAL_CARRY_MAX,
  uniquePlanes,
  type CoarseCandidateDraft
} from "./coarse-candidates.js";

export type AddCoarseCandidate = (
  entry: Readonly<MemoryEntry>,
  plane: RecallAdmissionPlane,
  structuralScore?: number,
  sourceChannel?: string,
  pathExpansionSource?: RecallPathExpansionSourceDiagnostic,
  entityConfidence?: number,
  reachedViaEarnedCoRecalledFanin?: boolean,
  pathFlowScore?: number
) => boolean;

export interface CoarseCandidateAdderParams {
  readonly drafts: Map<string, CoarseCandidateDraft>;
  readonly structuralScores: Map<string, number>;
  readonly graphExpansionScores: Map<string, number>;
  readonly entitySeedScores: Map<string, number>;
  readonly pathExpansionScores: Map<string, number>;
  readonly sourceProximityScores: Map<string, number>;
  readonly winnerMemoryIds: ReadonlySet<string>;
  readonly config: Readonly<RecallPolicy>["coarse_filter"];
}

export function createCoarseCandidateAdder(params: CoarseCandidateAdderParams): AddCoarseCandidate {
  return function addCoarseCandidate(
    entry,
    plane,
    structuralScore = 0,
    sourceChannel,
    pathExpansionSource,
    entityConfidence,
    reachedViaEarnedCoRecalledFanin,
    pathFlowScore
  ) {
    if (!shouldAdmitCoarseCandidate(params, entry, plane)) {
      return false;
    }
    const current = params.drafts.get(entry.object_id);
    const hadPlane = current?.admissionPlanes.includes(plane) ?? false;
    const planeScore = clamp01(structuralScore);
    const evidenceStructuralScore = resolveEvidenceStructuralScore(plane, planeScore);
    params.drafts.set(
      entry.object_id,
      buildNextCoarseCandidateDraft(
        entry,
        plane,
        current,
        evidenceStructuralScore,
        sourceChannel,
        pathExpansionSource,
        entityConfidence,
        reachedViaEarnedCoRecalledFanin
      )
    );
    updateCoarseCandidateScores(
      params,
      entry.object_id,
      plane,
      planeScore,
      evidenceStructuralScore,
      pathFlowScore
    );
    return !hadPlane;
  };
}

function shouldAdmitCoarseCandidate(
  params: CoarseCandidateAdderParams,
  entry: Readonly<MemoryEntry>,
  plane: RecallAdmissionPlane
): boolean {
  return (
    plane === "protected_winner" ||
    plane === "lexical" ||
    plane === "lexical_anchor" ||
    plane === "semantic_supplement" ||
    params.winnerMemoryIds.has(entry.object_id) ||
    matchesDeterministicFilter(entry, params.config)
  );
}

function resolveEvidenceStructuralScore(
  plane: RecallAdmissionPlane,
  planeScore: number
): number {
  return plane === "source_proximity"
    ? Math.min(planeScore, SOURCE_PROXIMITY_STRUCTURAL_CARRY_MAX)
    : planeScore;
}

function buildNextCoarseCandidateDraft(
  entry: Readonly<MemoryEntry>,
  plane: RecallAdmissionPlane,
  current: CoarseCandidateDraft | undefined,
  evidenceStructuralScore: number,
  sourceChannel: string | undefined,
  pathExpansionSource: RecallPathExpansionSourceDiagnostic | undefined,
  entityConfidence: number | undefined,
  reachedViaEarnedCoRecalledFanin: boolean | undefined
): CoarseCandidateDraft {
  const nextEntityConfidence =
    plane === "entity_seed" && entityConfidence !== undefined
      ? Math.max(current?.entityConfidence ?? 0, entityConfidence)
      : current?.entityConfidence;
  const nextReachedViaEarnedCoRecalledFanin =
    (current?.reachedViaEarnedCoRecalledFanin ?? false) ||
    reachedViaEarnedCoRecalledFanin === true;
  return {
    entry,
    admissionPlanes: uniquePlanes([...(current?.admissionPlanes ?? []), plane]),
    firstAdmissionPlane: current?.firstAdmissionPlane ?? plane,
    sourceChannels: uniqueStrings([
      ...(current?.sourceChannels ?? []),
      ...(sourceChannel === undefined ? [] : [sourceChannel])
    ]),
    structuralScore: Math.max(current?.structuralScore ?? 0, evidenceStructuralScore),
    pathExpansionSources: uniquePathExpansionSources([
      ...(current?.pathExpansionSources ?? []),
      ...(pathExpansionSource === undefined ? [] : [pathExpansionSource])
    ]),
    ...(nextEntityConfidence === undefined ? {} : { entityConfidence: nextEntityConfidence }),
    ...(nextReachedViaEarnedCoRecalledFanin
      ? { reachedViaEarnedCoRecalledFanin: true }
      : {})
  };
}

function updateCoarseCandidateScores(
  params: CoarseCandidateAdderParams,
  objectId: string,
  plane: RecallAdmissionPlane,
  planeScore: number,
  evidenceStructuralScore: number,
  pathFlowScore: number | undefined
): void {
  setMaxScore(params.structuralScores, objectId, evidenceStructuralScore);
  if (plane === "graph_expansion") {
    setMaxScore(params.graphExpansionScores, objectId, evidenceStructuralScore);
  }
  if (plane === "entity_seed") {
    setMaxScore(params.entitySeedScores, objectId, evidenceStructuralScore);
  }
  if (plane === "path_expansion") {
    updatePathExpansionScore(params, objectId, evidenceStructuralScore, pathFlowScore);
  }
  if (plane === "source_proximity") {
    setMaxScore(params.sourceProximityScores, objectId, planeScore);
  }
}

function updatePathExpansionScore(
  params: CoarseCandidateAdderParams,
  objectId: string,
  evidenceStructuralScore: number,
  pathFlowScore: number | undefined
): void {
  if (pathFlowScore !== undefined) {
    addScore(params.pathExpansionScores, objectId, pathFlowScore);
    return;
  }
  setMaxScore(params.pathExpansionScores, objectId, evidenceStructuralScore);
}

function setMaxScore(
  scores: Map<string, number>,
  objectId: string,
  score: number
): void {
  scores.set(objectId, Math.max(scores.get(objectId) ?? 0, score));
}

function addScore(
  scores: Map<string, number>,
  objectId: string,
  delta: number
): void {
  scores.set(objectId, clamp01((scores.get(objectId) ?? 0) + delta));
}
