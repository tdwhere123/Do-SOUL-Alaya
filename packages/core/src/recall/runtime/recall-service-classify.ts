import {
  MemoryDimension,
  ProjectMappingState,
  ScopeClass,
  type MemoryDimension as MemoryDimensionType,
  type MemoryEntry,
  type ProjectMappingAnchor,
  type RecallPolicy
} from "@do-soul/alaya-protocol";
import type { RecallServiceProjectMappingPort } from "./recall-service-ports.js";
import { normalizeActivationScore } from "./recall-service-compare.js";

const CLAIM_LIKE_DIMENSIONS = new Set<MemoryDimensionType>([
  MemoryDimension.CONSTRAINT,
  MemoryDimension.PREFERENCE,
  MemoryDimension.PROCEDURE
]);

export function isClaimLikeDimension(value: MemoryDimensionType): boolean {
  return CLAIM_LIKE_DIMENSIONS.has(value);
}

export function classifyGlobalCandidate(
  entry: { readonly global_object_id: string },
  anchorMap: ReadonlyMap<string, Readonly<ProjectMappingAnchor>>
): Readonly<{
  include: boolean;
  reason: "adopted" | "no_anchor" | `not_adopted:${ProjectMappingState}`;
  anchor_state: ProjectMappingState | null;
}> {
  const anchor = anchorMap.get(entry.global_object_id);

  if (anchor === undefined) {
    return Object.freeze({
      include: false,
      reason: "no_anchor",
      anchor_state: null
    });
  }

  if (
    anchor.mapping_state === ProjectMappingState.ACCEPTED ||
    anchor.mapping_state === ProjectMappingState.ADAPTED
  ) {
    return Object.freeze({
      include: true,
      reason: "adopted",
      anchor_state: anchor.mapping_state
    });
  }

  return Object.freeze({
    include: false,
    reason: `not_adopted:${anchor.mapping_state}`,
    anchor_state: anchor.mapping_state
  });
}

export function classifyProjectMappingCandidate(
  entry: Readonly<MemoryEntry>,
  anchorMap: ReadonlyMap<string, Readonly<ProjectMappingAnchor>>,
  projectMappingPort: RecallServiceProjectMappingPort | undefined
): Readonly<{ include: boolean; isAdvisory?: boolean }> {
  if (projectMappingPort === undefined || entry.scope_class === ScopeClass.PROJECT) {
    return Object.freeze({ include: true });
  }

  const anchor = anchorMap.get(entry.object_id);

  if (anchor === undefined) {
    return Object.freeze({ include: true, isAdvisory: true });
  }

  if (
    anchor.mapping_state === ProjectMappingState.REJECTED ||
    anchor.mapping_state === ProjectMappingState.NOT_APPLICABLE
  ) {
    return Object.freeze({ include: false });
  }

  if (
    anchor.mapping_state === ProjectMappingState.ACCEPTED ||
    anchor.mapping_state === ProjectMappingState.ADAPTED
  ) {
    return Object.freeze({ include: true, isAdvisory: false });
  }

  return Object.freeze({ include: true, isAdvisory: true });
}

function hasTagOverlap(source: readonly string[], filter: readonly string[]): boolean {
  const filterSet = new Set(filter);
  return source.some((tag) => filterSet.has(tag));
}

export function matchesConfiguredCoarseFilter(
  entry: Readonly<MemoryEntry>,
  config: Readonly<RecallPolicy>["coarse_filter"]
): boolean {
  return matchesDeterministicFilter(entry, config) && matchesPrecomputedRankFilter(entry, config);
}

export function matchesDeterministicFilter(
  entry: Readonly<MemoryEntry>,
  config: Readonly<RecallPolicy>["coarse_filter"]
): boolean {
  const scopePass =
    config.deterministic_match.scope_filter === null ||
    config.deterministic_match.scope_filter.includes(entry.scope_class);
  const dimensionPass =
    config.deterministic_match.dimension_filter === null ||
    config.deterministic_match.dimension_filter.includes(entry.dimension);
  const domainPass =
    config.deterministic_match.domain_tag_filter === null ||
    hasTagOverlap(entry.domain_tags, config.deterministic_match.domain_tag_filter);

  return scopePass && dimensionPass && domainPass;
}

export function matchesPrecomputedRankFilter(
  entry: Readonly<MemoryEntry>,
  config: Readonly<RecallPolicy>["coarse_filter"]
): boolean {
  return (
    config.precomputed_rank.min_activation_score === null ||
    normalizeActivationScore(entry.activation_score) >= config.precomputed_rank.min_activation_score
  );
}
