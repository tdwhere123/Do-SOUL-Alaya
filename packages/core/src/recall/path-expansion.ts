import {
  isPathActiveForRecall,
  isPathGovernedForSuppression,
  type MemoryEntry,
  type PathAnchorRef,
  type PathRelation
} from "@do-soul/alaya-protocol";
import {
  DYNAMIC_RECALL_SEED_CAP,
  selectExpansionSeedDrafts,
  type CoarseCandidateDraft
} from "./coarse-candidates.js";
import { EARNED_CO_RECALLED_FANIN_RELATION_KIND } from "./graph-expansion.js";
import {
  PATH_SUPPRESSION_MAX_PER_TARGET,
  directionEligiblePathExpansionTargets,
  firstTimeConcernSeedId,
  isPathExcludedFromRecall,
  normalizeTimeConcernWindowDigest,
  pathAnchorFacetKey,
  pathMatchesTimeConcernWindowDigest,
  pathRelationMemoryIds,
  scorePathRelationExpansion,
  scorePathRelationSuppression,
  uniqueStrings
} from "./path-relations.js";
import type { RecallQueryProbes } from "./recall-query-probes.js";
import { errorNameOf, toErrorMessage } from "./recall-service-helpers.js";
import { recordRecallDegradation } from "./diagnostics.js";
import type {
  RecallAdmissionPlane,
  RecallPathExpansionSourceDiagnostic,
  RecallServiceDependencies,
  RecallServiceWarnPort
} from "./recall-service-types.js";

type CoarseCandidateAdder = (
  entry: Readonly<MemoryEntry>,
  plane: RecallAdmissionPlane,
  structuralScore?: number,
  sourceChannel?: string,
  pathExpansionSource?: RecallPathExpansionSourceDiagnostic,
  entityConfidence?: number,
  reachedViaEarnedCoRecalledFanin?: boolean
) => boolean;

export async function addPathExpansionCandidates(params: Readonly<{
  readonly workspaceId: string;
  readonly byId: ReadonlyMap<string, Readonly<MemoryEntry>>;
  readonly drafts: ReadonlyMap<string, CoarseCandidateDraft>;
  readonly queryProbes: Readonly<RecallQueryProbes>;
  readonly addCandidate: CoarseCandidateAdder;
  readonly dynamicRecallPlaneCap: number;
  readonly pathExpansionPort?: RecallServiceDependencies["pathExpansionPort"];
  readonly warn: RecallServiceWarnPort;
  readonly degradationReasons?: Set<import("./recall-service-types.js").RecallDegradationReason>;
}>): Promise<void> {
  const pathExpansionPort = params.pathExpansionPort;
  if (pathExpansionPort === undefined) {
    return;
  }
  let added = await addTimeConcernPathExpansionCandidates({
    workspaceId: params.workspaceId,
    byId: params.byId,
    queryProbes: params.queryProbes,
    addCandidate: params.addCandidate,
    dynamicRecallPlaneCap: params.dynamicRecallPlaneCap,
    pathExpansionPort,
    warn: params.warn,
    degradationReasons: params.degradationReasons
  });
  if (added >= params.dynamicRecallPlaneCap || params.drafts.size === 0) {
    return;
  }

  const seeds = selectExpansionSeedDrafts(params.drafts).slice(0, DYNAMIC_RECALL_SEED_CAP);
  if (seeds.length === 0) {
    return;
  }
  const seedIds = new Set(seeds.map((seed) => seed.entry.object_id));
  const paths = await loadSeededPathExpansionPaths(
    params.workspaceId,
    seeds,
    pathExpansionPort,
    params.warn,
    "path expansion lookup failed",
    params.degradationReasons
  );
  added = admitSeededPathExpansionCandidates(params, paths, seedIds, added);
}

export async function addTimeConcernPathExpansionCandidates(params: Readonly<{
  readonly workspaceId: string;
  readonly byId: ReadonlyMap<string, Readonly<MemoryEntry>>;
  readonly queryProbes: Readonly<RecallQueryProbes>;
  readonly addCandidate: CoarseCandidateAdder;
  readonly dynamicRecallPlaneCap: number;
  readonly pathExpansionPort?: RecallServiceDependencies["pathExpansionPort"];
  readonly warn: RecallServiceWarnPort;
  readonly degradationReasons?: Set<import("./recall-service-types.js").RecallDegradationReason>;
}>): Promise<number> {
  const pathExpansionPort = params.pathExpansionPort;
  const findByTimeConcernWindowDigests = pathExpansionPort?.findByTimeConcernWindowDigests;
  if (findByTimeConcernWindowDigests === undefined || params.queryProbes.date_terms.length === 0) {
    return 0;
  }
  const windowDigests = collectTimeConcernWindowDigests(params.queryProbes);
  if (windowDigests.length === 0) {
    return 0;
  }
  const paths = await loadTimeConcernPathExpansionPaths(params, windowDigests);
  return admitTimeConcernPathExpansionCandidates(params, paths, windowDigests);
}

// anchor: active sign-aware suppression collector. Reuses path_expansion's seeds and findByAnchors but selects the negative (recall_bias < 0) paths the positive lanes exclude; each demotes its direction-eligible target by a strength-gated delta, accumulated per target. Fail-soft: missing port / lookup failure leaves suppression empty.
// see also: fusion-delivery.ts applyPathSuppressionToFusionScores, path-relations.ts scorePathRelationSuppression.
export async function collectNegativePathSuppressions(params: Readonly<{
  readonly workspaceId: string;
  readonly byId: ReadonlyMap<string, Readonly<MemoryEntry>>;
  readonly drafts: ReadonlyMap<string, CoarseCandidateDraft>;
  readonly suppressionScores: Map<string, number>;
  readonly pathExpansionPort?: RecallServiceDependencies["pathExpansionPort"];
  readonly warn: RecallServiceWarnPort;
  readonly degradationReasons?: Set<import("./recall-service-types.js").RecallDegradationReason>;
}>): Promise<void> {
  const pathExpansionPort = params.pathExpansionPort;
  if (pathExpansionPort === undefined || params.drafts.size === 0) {
    return;
  }
  const seeds = selectExpansionSeedDrafts(params.drafts).slice(0, DYNAMIC_RECALL_SEED_CAP);
  if (seeds.length === 0) {
    return;
  }
  const seedIds = new Set(seeds.map((seed) => seed.entry.object_id));
  const paths = await loadSeededPathExpansionPaths(
    params.workspaceId,
    seeds,
    pathExpansionPort,
    params.warn,
    "path suppression lookup failed",
    params.degradationReasons
  );
  applyNegativePathSuppressions(params, paths, seedIds);
}

function buildSeedPathAnchors(
  seeds: readonly Readonly<{ readonly entry: Readonly<MemoryEntry> }>[]
): readonly PathAnchorRef[] {
  return seeds.map((seed) => ({ kind: "object", object_id: seed.entry.object_id }));
}

async function loadSeededPathExpansionPaths(
  workspaceId: string,
  seeds: readonly Readonly<{ readonly entry: Readonly<MemoryEntry> }>[],
  pathExpansionPort: NonNullable<RecallServiceDependencies["pathExpansionPort"]>,
  warn: RecallServiceWarnPort,
  warningMessage: string,
  degradationReasons?: Set<import("./recall-service-types.js").RecallDegradationReason>
): Promise<readonly Readonly<PathRelation>[]> {
  try {
    return await pathExpansionPort.findByAnchors(workspaceId, buildSeedPathAnchors(seeds));
  } catch (error) {
    recordRecallDegradation({ degradationReasons }, "path_expansion_failed");
    warn(warningMessage, {
      workspace_id: workspaceId,
      seed_count: seeds.length,
      operation: "path_expansion_seed_lookup",
      errorName: errorNameOf(error),
      error: toErrorMessage(error)
    });
    return [];
  }
}

function admitSeededPathExpansionCandidates(
  params: Parameters<typeof addPathExpansionCandidates>[0],
  paths: readonly Readonly<PathRelation>[],
  seedIds: ReadonlySet<string>,
  initialAdded: number
): number {
  let added = initialAdded;
  for (const path of paths) {
    if (added >= params.dynamicRecallPlaneCap || isPathExcludedFromRecall(path)) {
      continue;
    }
    added = admitPathExpansionTargets(params, path, seedIds, added);
  }
  return added;
}

function admitPathExpansionTargets(
  params: Pick<Parameters<typeof addPathExpansionCandidates>[0], "byId" | "addCandidate" | "dynamicRecallPlaneCap">,
  path: Readonly<PathRelation>,
  seedIds: ReadonlySet<string>,
  initialAdded: number
): number {
  let added = initialAdded;
  const reachedViaEarnedCoRecalledFanin =
    path.constitution.relation_kind === EARNED_CO_RECALLED_FANIN_RELATION_KIND;
  for (const target of directionEligiblePathExpansionTargets(path, seedIds)) {
    const entry = params.byId.get(target.targetId);
    if (entry === undefined) {
      continue;
    }
    params.addCandidate(
      entry,
      "path_expansion",
      scorePathRelationExpansion(path),
      "path_expansion",
      buildMemoryPathExpansionSource(path, target.seedId, target.targetId),
      undefined,
      reachedViaEarnedCoRecalledFanin
    );
    added += 1;
    if (added >= params.dynamicRecallPlaneCap) {
      break;
    }
  }
  return added;
}

function buildMemoryPathExpansionSource(
  path: Readonly<PathRelation>,
  seedId: string,
  targetId: string
): Readonly<RecallPathExpansionSourceDiagnostic> {
  return Object.freeze({
    path_id: path.path_id,
    seed_id: seedId,
    seed_kind: "memory",
    target_object_id: targetId,
    source_channel: "path_expansion",
    relation_kind: path.constitution.relation_kind,
    facet_key: pathAnchorFacetKey(path)
  });
}

function collectTimeConcernWindowDigests(
  queryProbes: Readonly<RecallQueryProbes>
): readonly string[] {
  return uniqueStrings(
    queryProbes.date_terms
      .map((term) => normalizeTimeConcernWindowDigest(term))
      .filter((term) => term.length > 0)
  );
}

async function loadTimeConcernPathExpansionPaths(
  params: Parameters<typeof addTimeConcernPathExpansionCandidates>[0],
  windowDigests: readonly string[]
): Promise<readonly Readonly<PathRelation>[]> {
  try {
    return await params.pathExpansionPort!.findByTimeConcernWindowDigests!(
      params.workspaceId,
      windowDigests
    );
  } catch (error) {
    params.warn("time concern path expansion lookup failed", {
      workspace_id: params.workspaceId,
      window_digest_count: windowDigests.length,
      operation: "time_concern_path_expansion_lookup",
      errorName: errorNameOf(error),
      error: toErrorMessage(error)
    });
    recordRecallDegradation(params, "path_expansion_failed");
    return [];
  }
}

function admitTimeConcernPathExpansionCandidates(
  params: Parameters<typeof addTimeConcernPathExpansionCandidates>[0],
  paths: readonly Readonly<PathRelation>[],
  windowDigests: readonly string[]
): number {
  let added = 0;
  for (const path of paths) {
    if (added >= params.dynamicRecallPlaneCap) {
      break;
    }
    if (isPathExcludedFromRecall(path) || !pathMatchesTimeConcernWindowDigest(path, windowDigests)) {
      continue;
    }
    added = admitTimeConcernPathTargets(params, path, windowDigests, added);
  }
  return added;
}

function admitTimeConcernPathTargets(
  params: Pick<Parameters<typeof addTimeConcernPathExpansionCandidates>[0], "byId" | "addCandidate" | "dynamicRecallPlaneCap">,
  path: Readonly<PathRelation>,
  windowDigests: readonly string[],
  initialAdded: number
): number {
  let added = initialAdded;
  for (const targetId of pathRelationMemoryIds(path)) {
    const entry = params.byId.get(targetId);
    if (entry === undefined) {
      continue;
    }
    params.addCandidate(
      entry,
      "path_expansion",
      scorePathRelationExpansion(path),
      "time_concern",
      Object.freeze({
        path_id: path.path_id,
        seed_id: firstTimeConcernSeedId(path, windowDigests),
        seed_kind: "time_concern",
        target_object_id: targetId,
        source_channel: "time_concern",
        relation_kind: path.constitution.relation_kind,
        facet_key: pathAnchorFacetKey(path)
      })
    );
    added += 1;
    if (added >= params.dynamicRecallPlaneCap) {
      break;
    }
  }
  return added;
}

function applyNegativePathSuppressions(
  params: Parameters<typeof collectNegativePathSuppressions>[0],
  paths: readonly Readonly<PathRelation>[],
  seedIds: ReadonlySet<string>
): void {
  for (const path of paths) {
    const delta = resolveNegativePathSuppressionDelta(path);
    if (delta <= 0) {
      continue;
    }
    for (const target of directionEligiblePathExpansionTargets(path, seedIds)) {
      if (!params.byId.has(target.targetId)) {
        continue;
      }
      const accumulated = (params.suppressionScores.get(target.targetId) ?? 0) + delta;
      params.suppressionScores.set(
        target.targetId,
        Math.min(accumulated, PATH_SUPPRESSION_MAX_PER_TARGET)
      );
    }
  }
}

function resolveNegativePathSuppressionDelta(path: Readonly<PathRelation>): number {
  if (
    !isPathActiveForRecall(path.lifecycle.status) ||
    path.effect_vector.recall_bias >= 0 ||
    !isPathGovernedForSuppression(path)
  ) {
    return 0;
  }
  return scorePathRelationSuppression(path);
}
