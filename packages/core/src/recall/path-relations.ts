import {
  isPathRecallEligible,
  type PathAnchorRef,
  type PathRelation
} from "@do-soul/alaya-protocol";
import { clamp01 } from "../recall-service-helpers.js";
import type {
  RecallGraphExpansionTrackedEdgeType,
  RecallPathExpansionSourceDiagnostic
} from "../recall-service-types.js";
import { pathRelationKindToTrackedEdgeType } from "./graph-expansion.js";

// Active sign-aware suppression scale. A negative path (recall_bias < 0)
// demotes its target's fused recall score by
//   delta = |recall_bias| * f(strength) * PATH_SUPPRESSION_SCALE
// where f(strength) is the path's plasticity strength in [0, 1] (an
// attention_only co-occurrence sits near 0.5; a plasticity-reinforced
// contradiction climbs toward 0.9-1.0). PATH_SUPPRESSION_SCALE is the only
// magnitude tuned by intent here, and it is set so the gate is strength-aware
// rather than benchmark-fitted (no-benchmark-specific-patch):
//   - fused_score contributions are RRF terms ~weight/(k+rank), so a single
//     mid-table stream contributes on the order of 0.01-0.05 and a strong
//     multi-stream memory totals ~0.1-0.3.
//   - a weak attention_only negative (|bias|~0.4, strength~0.5) yields
//     delta ~ 0.4 * 0.5 * 0.5 = 0.10 ... too aggressive, so the strength gate
//     below floors weak/forming paths out of suppression entirely and only
//     stable/pinned high-strength negatives apply the full delta.
// The strength gate (PATH_SUPPRESSION_STRENGTH_FLOOR) makes "weak attention_only
// barely suppresses" literal: below the floor delta collapses to 0; at/above it
// scales linearly so a reinforced contradiction (strength ~0.9) lands
// delta ~ 0.4 * 0.9 * 0.6 = 0.216, enough to push a target out of a tight
// top-K, while a freshly-seeded weak negative does not move rankings.
const PATH_SUPPRESSION_SCALE = 0.6;
// invariant: strength below this floor contributes no suppression. Matches the
// attention_only seed band (initial strength 0.3-0.5 for co-occurrence-class
// paths) so a barely-formed negative association cannot demote a memory until
// plasticity has reinforced it past the floor. see also:
// packages/core/src/path-graph/path-relation-proposal-service.ts seed catalog (initialStrength per family).
const PATH_SUPPRESSION_STRENGTH_FLOOR = 0.6;
// invariant: hard ceiling on the total suppression delta any single target may
// accumulate, across all converging negative paths. Sized to one supersedes-class
// negative at full reinforcement: |recall_bias 0.5| * strength 0.9 *
// PATH_SUPPRESSION_SCALE 0.6 = 0.27, so a lone reinforced supersession can
// demote a target out of a tight top-K but stacked negatives can never exceed
// the worst single legitimate suppression. This bounds the accumulated delta
// (rank loss). The per-target cap limits the DELTA, not the residual score: a
// single full-strength negative whose target had a low base fused_score
// (< 0.27) could still drive that target's fused_score to 0 via one subtraction
// and drop it out of the candidate set. PATH_SUPPRESSION_RESIDUAL_FLOOR (below)
// is the residual-side guard that demotes, never erases.
// see also: packages/core/src/recall-service.ts:collectNegativePathSuppressions,
// packages/core/src/recall/path-relations.ts:scorePathRelationSuppression,
// packages/core/src/recall/fusion-delivery.ts:PATH_SUPPRESSION_RESIDUAL_FLOOR.
export const PATH_SUPPRESSION_MAX_PER_TARGET = 0.27;

export function scorePathRelationExpansion(path: Readonly<PathRelation>): number {
  const governanceBoost =
    path.legitimacy.governance_class === "recall_allowed" ||
    path.legitimacy.governance_class === "strictly_governed"
      ? 0.15
      : 0;
  const stabilityBoost =
    path.plasticity_state.stability_class === "stable" ||
    path.plasticity_state.stability_class === "pinned"
      ? 0.1
      : 0;
  return clamp01(
    path.plasticity_state.strength * 0.55 +
      path.effect_vector.recall_bias * 0.25 +
      governanceBoost +
      stabilityBoost
  );
}

// Strength-gated active suppression delta for one negative path. recall_bias
// is negative for the suppressing families (contradicts / supersedes /
// incompatible_with), so |recall_bias| is the suppression magnitude. The
// plasticity strength gate keeps weak / forming negatives inert: below
// PATH_SUPPRESSION_STRENGTH_FLOOR the delta is exactly 0, so an attention_only
// co-occurrence cannot demote a memory. At or above the floor the strength
// scales the delta linearly, so a plasticity-reinforced contradiction applies
// real demotion. Returns 0 for non-negative paths defensively (callers pass
// only recall_bias < 0 paths). see also: packages/core/src/recall/path-relations.ts:PATH_SUPPRESSION_SCALE rationale.
export function scorePathRelationSuppression(path: Readonly<PathRelation>): number {
  const recallBias = path.effect_vector.recall_bias;
  if (recallBias >= 0) {
    return 0;
  }
  const strength = clamp01(path.plasticity_state.strength);
  if (strength < PATH_SUPPRESSION_STRENGTH_FLOOR) {
    return 0;
  }
  return Math.abs(recallBias) * strength * PATH_SUPPRESSION_SCALE;
}

export function directionEligiblePathExpansionTargets(
  path: Readonly<PathRelation>,
  seedIds: ReadonlySet<string>
): readonly DirectionEligiblePathExpansionTarget[] {
  const sourceId = anchorMemoryId(path.anchors.source_anchor);
  const targetId = anchorMemoryId(path.anchors.target_anchor);
  if (sourceId === undefined || targetId === undefined || sourceId === targetId) {
    return [];
  }

  const targets = new Map<string, DirectionEligiblePathExpansionTarget>();
  if (
    seedIds.has(sourceId) &&
    (path.plasticity_state.direction_bias === "source_to_target" ||
      path.plasticity_state.direction_bias === "bidirectional_asymmetric")
  ) {
    targets.set(`${sourceId}->${targetId}`, { seedId: sourceId, targetId });
  }
  if (
    seedIds.has(targetId) &&
    (path.plasticity_state.direction_bias === "target_to_source" ||
      path.plasticity_state.direction_bias === "bidirectional_asymmetric")
  ) {
    targets.set(`${targetId}->${sourceId}`, { seedId: targetId, targetId: sourceId });
  }
  return [...targets.values()];
}

export interface DirectionEligiblePathExpansionTarget {
  readonly seedId: string;
  readonly targetId: string;
}

export interface PathGraphNeighbor {
  readonly neighborId: string;
  readonly edgeType: RecallGraphExpansionTrackedEdgeType;
  // The raw path relation_kind (pre-fold), kept alongside the tracked edgeType so
  // the hop>=2 chain gate can key on the true relation rather than the folded type.
  readonly relationKind: string;
}

// anchor: path-graph traversal neighbor extraction shared by expandGraphFrontier.
// Given a frontier node id, returns the direction-eligible object neighbors
// reachable through the supplied recall-eligible paths, each tagged with the
// tracked edge type its relation_kind maps onto. Reuses the same
// direction_bias semantics as directionEligiblePathExpansionTargets so the
// graph-traversal plane and the direct path_expansion plane agree on which
// way a path may be followed. Self-loops and non-object anchors yield nothing.
export function collectPathGraphNeighbors(
  paths: readonly Readonly<PathRelation>[],
  nodeId: string
): readonly PathGraphNeighbor[] {
  const neighbors: PathGraphNeighbor[] = [];
  const seen = new Set<string>();
  for (const path of paths) {
    const sourceId = anchorMemoryId(path.anchors.source_anchor);
    const targetId = anchorMemoryId(path.anchors.target_anchor);
    if (sourceId === undefined || targetId === undefined || sourceId === targetId) {
      continue;
    }
    const relationKind = path.constitution.relation_kind;
    const edgeType = pathRelationKindToTrackedEdgeType(relationKind);
    if (
      sourceId === nodeId &&
      (path.plasticity_state.direction_bias === "source_to_target" ||
        path.plasticity_state.direction_bias === "bidirectional_asymmetric")
    ) {
      const key = `${targetId}:${edgeType}`;
      if (!seen.has(key)) {
        seen.add(key);
        neighbors.push({ neighborId: targetId, edgeType, relationKind });
      }
    }
    if (
      targetId === nodeId &&
      (path.plasticity_state.direction_bias === "target_to_source" ||
        path.plasticity_state.direction_bias === "bidirectional_asymmetric")
    ) {
      const key = `${sourceId}:${edgeType}`;
      if (!seen.has(key)) {
        seen.add(key);
        neighbors.push({ neighborId: sourceId, edgeType, relationKind });
      }
    }
  }
  return neighbors;
}

export function pathRelationMemoryIds(path: Readonly<PathRelation>): readonly string[] {
  return uniqueStrings([
    anchorMemoryId(path.anchors.source_anchor),
    anchorMemoryId(path.anchors.target_anchor)
  ].filter((value): value is string => value !== undefined));
}

// Provenance helper: the facet_key the path is anchored on, if either endpoint
// is an object_facet anchor (source preferred — it is the matched side). null
// for plain object/obligation/risk/time anchors.
export function pathAnchorFacetKey(path: Readonly<PathRelation>): string | null {
  const { source_anchor, target_anchor } = path.anchors;
  if (source_anchor.kind === "object_facet") return source_anchor.facet_key;
  if (target_anchor.kind === "object_facet") return target_anchor.facet_key;
  return null;
}

export function pathMatchesTimeConcernWindowDigest(
  path: Readonly<PathRelation>,
  windowDigests: readonly string[]
): boolean {
  const queryDigests = new Set(windowDigests);
  return [
    path.anchors.source_anchor,
    path.anchors.target_anchor
  ].some((anchor) =>
    anchor.kind === "time_concern" &&
    queryDigests.has(normalizeTimeConcernWindowDigest(anchor.window_digest))
  );
}

export function firstTimeConcernSeedId(
  path: Readonly<PathRelation>,
  windowDigests: readonly string[]
): string {
  const queryDigests = new Set(windowDigests);
  const anchor = [
    path.anchors.source_anchor,
    path.anchors.target_anchor
  ].find((candidate) =>
    candidate.kind === "time_concern" &&
    queryDigests.has(normalizeTimeConcernWindowDigest(candidate.window_digest))
  );
  return anchor?.kind === "time_concern"
    ? `time_concern:${normalizeTimeConcernWindowDigest(anchor.window_digest)}`
    : "time_concern:unknown";
}

export function normalizeTimeConcernWindowDigest(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/gu, "_");
}

export function anchorMemoryId(anchor: PathAnchorRef): string | undefined {
  switch (anchor.kind) {
    case "object":
    case "object_facet":
      return anchor.object_id;
    case "obligation":
    case "risk_concern":
    case "time_concern":
      return anchor.source_object_id;
  }
}

// invariant: recall path_expansion only consumes recall-eligible paths —
// active lifecycle AND recall_bias > 0 (the shared isPathRecallEligible
// predicate). This is the negation of recall-eligible, so it excludes in
// one gate:
//   - lifecycle: retired (terminal) and dormant (reversible cold storage)
//     never leak back into recall scoring;
//   - negative families (contradicts / supersedes / incompatible_with,
//     recall_bias < 0): suppression, not association — adding the target as
//     a positive path_expansion candidate would AMPLIFY the suppressed
//     memory instead of demoting it;
//   - the recall-neutral exception_to marker (recall_bias == 0): a topology
//     marker that must not enter positive expansion either.
// Using the shared predicate keeps the < 0 / <= 0 family boundary aligned
// with PathPlasticityService (which retires the negative + neutral family)
// rather than re-deriving the sign test here.
// Active sign-aware suppression is handled by collectNegativePathSuppressions;
// this guard only stops positive path_expansion from amplifying suppressing
// relations before that demotion pass runs.
// see also: packages/core/src/path-graph/path-relation-proposal-service.ts — recall_bias is
// recallBiasSign * recallBiasMagnitude, so a negative family is < 0 and the
// exception_to marker is exactly 0.
// see also: packages/protocol/src/soul/path-relation.ts:isPathRecallEligible.
export function isPathExcludedFromRecall(path: Readonly<PathRelation>): boolean {
  return !isPathRecallEligible(path);
}

export function uniqueStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

export function uniquePathExpansionSources(
  values: readonly RecallPathExpansionSourceDiagnostic[]
): readonly RecallPathExpansionSourceDiagnostic[] {
  const seen = new Set<string>();
  const result: RecallPathExpansionSourceDiagnostic[] = [];
  for (const value of values) {
    const key = `${value.source_channel}:${value.path_id}:${value.seed_kind}:${value.seed_id}:${value.target_object_id}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(value);
  }
  return result;
}
