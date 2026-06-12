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
import { toErrorMessage } from "./recall-service-helpers.js";
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
    warn: params.warn
  });
  if (added >= params.dynamicRecallPlaneCap || params.drafts.size === 0) {
    return;
  }

  const seeds = selectExpansionSeedDrafts(params.drafts).slice(0, DYNAMIC_RECALL_SEED_CAP);
  if (seeds.length === 0) {
    return;
  }
  const seedIds = new Set(seeds.map((seed) => seed.entry.object_id));
  const anchors: PathAnchorRef[] = seeds.map((seed) => ({
    kind: "object",
    object_id: seed.entry.object_id
  }));
  let paths: readonly Readonly<PathRelation>[];
  try {
    paths = await pathExpansionPort.findByAnchors(params.workspaceId, anchors);
  } catch (error) {
    params.warn("path expansion lookup failed", {
      workspace_id: params.workspaceId,
      seed_count: seeds.length,
      error: toErrorMessage(error)
    });
    return;
  }

  for (const path of paths) {
    if (added >= params.dynamicRecallPlaneCap) {
      return;
    }
    if (isPathExcludedFromRecall(path)) {
      continue;
    }
    // Gold-blind: the discriminator reads the EARNED path's relation_kind, not
    // a gold label. Only the co_recalled fan-in carrier (minted past the R1
    // threshold-3 counter gate) grants the reserve exemption; every other
    // relation_kind admitted here stays relevance-gated downstream.
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
        {
          path_id: path.path_id,
          seed_id: target.seedId,
          seed_kind: "memory",
          target_object_id: target.targetId,
          source_channel: "path_expansion",
          relation_kind: path.constitution.relation_kind,
          facet_key: pathAnchorFacetKey(path)
        },
        undefined,
        reachedViaEarnedCoRecalledFanin
      );
      added += 1;
      if (added >= params.dynamicRecallPlaneCap) {
        return;
      }
    }
  }
}

export async function addTimeConcernPathExpansionCandidates(params: Readonly<{
  readonly workspaceId: string;
  readonly byId: ReadonlyMap<string, Readonly<MemoryEntry>>;
  readonly queryProbes: Readonly<RecallQueryProbes>;
  readonly addCandidate: CoarseCandidateAdder;
  readonly dynamicRecallPlaneCap: number;
  readonly pathExpansionPort?: RecallServiceDependencies["pathExpansionPort"];
  readonly warn: RecallServiceWarnPort;
}>): Promise<number> {
  const pathExpansionPort = params.pathExpansionPort;
  const findByTimeConcernWindowDigests = pathExpansionPort?.findByTimeConcernWindowDigests;
  if (findByTimeConcernWindowDigests === undefined || params.queryProbes.date_terms.length === 0) {
    return 0;
  }

  const windowDigests = uniqueStrings(
    params.queryProbes.date_terms
      .map((term) => normalizeTimeConcernWindowDigest(term))
      .filter((term) => term.length > 0)
  );
  if (windowDigests.length === 0) {
    return 0;
  }

  let paths: readonly Readonly<PathRelation>[];
  try {
    paths = await findByTimeConcernWindowDigests.call(
      pathExpansionPort,
      params.workspaceId,
      windowDigests
    );
  } catch (error) {
    params.warn("time concern path expansion lookup failed", {
      workspace_id: params.workspaceId,
      window_digest_count: windowDigests.length,
      error: toErrorMessage(error)
    });
    return 0;
  }

  let added = 0;
  for (const path of paths) {
    if (added >= params.dynamicRecallPlaneCap) {
      return added;
    }
    if (isPathExcludedFromRecall(path) || !pathMatchesTimeConcernWindowDigest(path, windowDigests)) {
      continue;
    }
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
        {
          path_id: path.path_id,
          seed_id: firstTimeConcernSeedId(path, windowDigests),
          seed_kind: "time_concern",
          target_object_id: targetId,
          source_channel: "time_concern",
          relation_kind: path.constitution.relation_kind,
          facet_key: pathAnchorFacetKey(path)
        }
      );
      added += 1;
      if (added >= params.dynamicRecallPlaneCap) {
        return added;
      }
    }
  }
  return added;
}

// anchor: active sign-aware suppression collector. Reuses the same expansion
// seeds and pathExpansionPort.findByAnchors lookup as path_expansion, but
// selects the negative (recall_bias < 0) active paths that the positive
// lanes deliberately exclude. Each such path demotes its direction-eligible
// target by a strength-gated delta (scorePathRelationSuppression). Deltas
// accumulate per target so multiple converging negatives compound. The
// collected map is applied to the fused score before sort. Fail-soft: a
// missing port or lookup failure leaves suppression empty and recall
// degrades to the no-suppression behavior.
// see also: packages/core/src/recall/fusion-delivery.ts:applyPathSuppressionToFusionScores,
// packages/core/src/recall/path-relations.ts:scorePathRelationSuppression.
export async function collectNegativePathSuppressions(params: Readonly<{
  readonly workspaceId: string;
  readonly byId: ReadonlyMap<string, Readonly<MemoryEntry>>;
  readonly drafts: ReadonlyMap<string, CoarseCandidateDraft>;
  readonly suppressionScores: Map<string, number>;
  readonly pathExpansionPort?: RecallServiceDependencies["pathExpansionPort"];
  readonly warn: RecallServiceWarnPort;
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
  const anchors: PathAnchorRef[] = seeds.map((seed) => ({
    kind: "object",
    object_id: seed.entry.object_id
  }));
  let paths: readonly Readonly<PathRelation>[];
  try {
    paths = await pathExpansionPort.findByAnchors(params.workspaceId, anchors);
  } catch (error) {
    params.warn("path suppression lookup failed", {
      workspace_id: params.workspaceId,
      seed_count: seeds.length,
      error: toErrorMessage(error)
    });
    return;
  }
  for (const path of paths) {
    // invariant: only active, strictly-negative, governance-trusted paths
    // suppress. Active lifecycle reuses isPathActiveForRecall (dormant/retired
    // never suppress). isPathGovernedForSuppression is the governance gate:
    // attention_only / hint_only negatives are agent-reachable through
    // co-occurrence seeding + strength reinforcement, so they may exclude (via
    // isPathRecallEligible) but never actively demote - strength alone cannot
    // license suppression. Only recall_allowed / strictly_governed negatives
    // reach the strength-scaled delta below.
    // see also: path-relation.ts isPathGovernedForSuppression.
    if (
      !isPathActiveForRecall(path.lifecycle.status) ||
      path.effect_vector.recall_bias >= 0 ||
      !isPathGovernedForSuppression(path)
    ) {
      continue;
    }
    const delta = scorePathRelationSuppression(path);
    if (delta <= 0) {
      continue;
    }
    for (const target of directionEligiblePathExpansionTargets(path, seedIds)) {
      if (!params.byId.has(target.targetId)) {
        continue;
      }
      // invariant: per-target accumulation is capped at
      // packages/core/src/recall/path-relations.ts:PATH_SUPPRESSION_MAX_PER_TARGET
      // so converging negatives compound up to one reinforced-supersession
      // delta but never gang into erasure.
      const accumulated =
        (params.suppressionScores.get(target.targetId) ?? 0) + delta;
      params.suppressionScores.set(
        target.targetId,
        Math.min(accumulated, PATH_SUPPRESSION_MAX_PER_TARGET)
      );
    }
  }
}
