import {
  isPathRecallEligible,
  type PathAnchorRef,
  type PathRelation
} from "@do-soul/alaya-protocol";
import { clamp01 } from "./recall-service-helpers.js";
import type {
  PathInflowEdge,
  RecallGraphExpansionTrackedEdgeType,
  RecallPathExpansionSourceDiagnostic
} from "./recall-service-types.js";
import { pathRelationKindToTrackedEdgeType } from "./graph-expansion.js";

// Active sign-aware suppression scale: a negative path demotes its target by delta = |recall_bias| * strength * SCALE. Strength-aware, not benchmark-fitted — the strength floor zeros weak/forming negatives, so only reinforced high-strength negatives apply the full delta.
const PATH_SUPPRESSION_SCALE = 0.6;
// invariant: strength below this floor contributes no suppression — above the attention_only seed band, so a barely-formed negative cannot demote until reinforced. see also: path-graph/path-relation-proposal-service.ts seed catalog (initialStrength per family).
const PATH_SUPPRESSION_STRENGTH_FLOOR = 0.6;
// invariant: ceiling on total suppression delta one target may accumulate across converging negatives; sized to one full-strength supersession (0.5*0.9*0.6=0.27) so stacked negatives never exceed the worst single legitimate one. Caps the delta, not the residual — a low-base target can still hit 0; the residual-floor guard handles that.
// see also: recall-service.ts collectNegativePathSuppressions, path-relations.ts scorePathRelationSuppression, fusion-delivery.ts PATH_SUPPRESSION_RESIDUAL_FLOOR.
export const PATH_SUPPRESSION_MAX_PER_TARGET = 0.27;

// Additive bonus for the answer-relation edge (S2): at equal strength/governance an
// answers_with edge outranks a co-occurrence edge (coheres_with/co_recalled). Keyed on
// relation_kind so it lifts both planes (flat admitPathExpansionTargets + conformant
// buildPathInflowByTarget) in one place. Modest; bench-tunable.
const ANSWERS_WITH_EXPANSION_BONUS = 0.1;

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
  const answerhoodBoost =
    path.constitution.relation_kind === "answers_with" ? ANSWERS_WITH_EXPANSION_BONUS : 0;
  return clamp01(
    path.plasticity_state.strength * 0.55 +
      path.effect_vector.recall_bias * 0.25 +
      governanceBoost +
      stabilityBoost +
      answerhoodBoost
  );
}

// Strength-gated suppression delta for one negative path (|recall_bias| is the magnitude). Below PATH_SUPPRESSION_STRENGTH_FLOOR the delta is 0; at/above it scales linearly. Returns 0 for non-negative paths defensively. see also: path-relations.ts PATH_SUPPRESSION_SCALE.
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

// P2: only the verified answer relation carries π-flood. Co-occurrence kinds (coheres_with /
// co_recalled / shares_entity / signal_graph_ref) are topic neighbors, not answer relations, so they
// stay π=0 and cannot demote an in-pool single_fact gold via free inflow votes.
const ANSWER_FLOOD_RELATION_KINDS: ReadonlySet<string> = new Set(["answers_with"]);

export function answersWithPathFuelEnabled(): boolean {
  return (
    process.env.ALAYA_RECALL_ANSWERS_WITH === "1" ||
    process.env.ALAYA_EXP_ANSWERS_WITH === "1"
  );
}

function isAnswerFloodRelationKind(relationKind: string): boolean {
  return ANSWER_FLOOD_RELATION_KINDS.has(relationKind);
}

// Compositional inflow adjacency for the conformant flood: target ← {seed, π} over recall-eligible
// answer-relation edges whose seed AND target are both in the candidate pool. Mirrors path-expansion's
// admitPathExpansionTargets edge math (scorePathRelationExpansion · direction-eligible targets).
export function buildPathInflowByTarget(
  paths: readonly Readonly<PathRelation>[],
  candidateIds: ReadonlySet<string>
): Readonly<Record<string, PathInflowEdge[]>> {
  if (!answersWithPathFuelEnabled()) {
    return Object.freeze({});
  }
  const inflow: Record<string, PathInflowEdge[]> = {};
  for (const path of paths) {
    if (isPathExcludedFromRecall(path) || !isAnswerFloodRelationKind(path.constitution.relation_kind)) {
      continue;
    }
    const weight = scorePathRelationExpansion(path);
    if (weight <= 0) {
      continue;
    }
    for (const target of directionEligiblePathExpansionTargets(path, candidateIds)) {
      if (!candidateIds.has(target.targetId)) {
        continue;
      }
      (inflow[target.targetId] ??= []).push({ seedObjectId: target.seedId, weight });
    }
  }
  return inflow;
}

export interface PathGraphNeighbor {
  readonly neighborId: string;
  readonly edgeType: RecallGraphExpansionTrackedEdgeType;
  // Raw pre-fold relation_kind kept alongside edgeType so the hop>=2 chain gate keys on the true relation, not the folded type.
  readonly relationKind: string;
}

// anchor: path-graph traversal neighbor extraction shared by expandGraphFrontier.
// Direction-eligible object neighbors of a frontier node, tagged with the tracked edge type; reuses directionEligiblePathExpansionTargets's direction_bias so both planes agree. Self-loops and non-object anchors yield nothing.
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

// Provenance helper: the object_facet anchor's facet_key (source preferred as the matched side); null for non-facet anchors.
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

// invariant: positive path_expansion consumes only recall-eligible paths (active lifecycle AND recall_bias > 0). This negation excludes in one gate: retired/dormant lifecycle, negative families (would amplify the suppressed memory), and the neutral exception_to marker. Uses the shared predicate to keep the family boundary aligned with PathPlasticityService; active suppression is handled separately by collectNegativePathSuppressions.
// see also: path-graph/path-relation-proposal-service.ts (recall_bias = sign*magnitude), protocol/soul/path-relation.ts isPathRecallEligible.
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
