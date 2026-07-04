import {
  isPathRecallEligible,
  type MemoryEntry,
  type PathRelation
} from "@do-soul/alaya-protocol";
import { deriveFacetsFromText } from "../expansion/facet-keywords.js";
import {
  anchorMemoryId,
  buildPathInflowByTarget,
  directionEligiblePathExpansionTargets,
  pathAnchorFacetKey,
  uniqueStrings
} from "../expansion/path-relations.js";
import { buildEvidenceSupportVectors } from "../supplements/supplementary-data.js";

const ANSWER_FLOOD_RELATION_KINDS: ReadonlySet<string> = new Set(["answers_with"]);

export interface SeedFuelInventory {
  readonly objects_total: number;
  readonly evidence_refs_total: number;
  readonly facet_anchors_total: number;
  readonly path_candidates_total: number;
  readonly support_bearing_candidates: number;
}

export function deriveSeedFuelInventory(input: {
  readonly entries: readonly Readonly<MemoryEntry>[];
  readonly paths?: readonly Readonly<PathRelation>[];
}): SeedFuelInventory {
  const entries = input.entries;
  const candidateIds = new Set(entries.map((entry) => entry.object_id));
  const evidenceRefs = collectEvidenceRefs(entries);
  const facetAnchors = collectFacetAnchors(entries, input.paths ?? []);
  const pathCandidates = countPathFuelCandidates(input.paths ?? [], candidateIds);
  const supportVectors = buildEvidenceSupportVectors(entries);
  const supportBearing = Object.keys(supportVectors).length;
  return Object.freeze({
    objects_total: entries.length,
    evidence_refs_total: evidenceRefs.size,
    facet_anchors_total: facetAnchors.size,
    path_candidates_total: pathCandidates,
    support_bearing_candidates: supportBearing
  });
}

export function mergeSeedFuelInventories(
  inventories: readonly SeedFuelInventory[]
): SeedFuelInventory {
  return inventories.reduce<SeedFuelInventory>(
    (merged, row) =>
      Object.freeze({
        objects_total: merged.objects_total + row.objects_total,
        evidence_refs_total: merged.evidence_refs_total + row.evidence_refs_total,
        facet_anchors_total: Math.max(
          merged.facet_anchors_total,
          row.facet_anchors_total
        ),
        path_candidates_total: merged.path_candidates_total + row.path_candidates_total,
        support_bearing_candidates:
          merged.support_bearing_candidates + row.support_bearing_candidates
      }),
    emptySeedFuelInventory()
  );
}

export function emptySeedFuelInventory(): SeedFuelInventory {
  return Object.freeze({
    objects_total: 0,
    evidence_refs_total: 0,
    facet_anchors_total: 0,
    path_candidates_total: 0,
    support_bearing_candidates: 0
  });
}

function collectEvidenceRefs(entries: readonly Readonly<MemoryEntry>[]): Set<string> {
  const refs = new Set<string>();
  for (const entry of entries) {
    for (const ref of entry.evidence_refs ?? []) {
      refs.add(ref);
    }
  }
  return refs;
}

function collectFacetAnchors(
  entries: readonly Readonly<MemoryEntry>[],
  paths: readonly Readonly<PathRelation>[]
): Set<string> {
  const facets = new Set<string>();
  for (const entry of entries) {
    for (const tag of entry.facet_tags ?? []) {
      facets.add(tag.facet);
    }
    for (const facet of deriveFacetsFromText(entry.content)) {
      facets.add(facet);
    }
    for (const domainTag of entry.domain_tags ?? []) {
      for (const facet of deriveFacetsFromText(domainTag)) {
        facets.add(facet);
      }
    }
  }
  for (const path of paths) {
    const facetKey = pathAnchorFacetKey(path);
    if (facetKey !== null) {
      facets.add(facetKey);
    }
  }
  return facets;
}

function countPathFuelCandidates(
  paths: readonly Readonly<PathRelation>[],
  candidateIds: ReadonlySet<string>
): number {
  if (candidateIds.size === 0 || paths.length === 0) {
    return 0;
  }
  let count = 0;
  for (const path of paths) {
    if (!isPathRecallEligible(path)) {
      continue;
    }
    if (!ANSWER_FLOOD_RELATION_KINDS.has(path.constitution.relation_kind)) {
      continue;
    }
    const sourceId = anchorMemoryId(path.anchors.source_anchor);
    const targetId = anchorMemoryId(path.anchors.target_anchor);
    if (
      sourceId === undefined ||
      targetId === undefined ||
      !candidateIds.has(sourceId) ||
      !candidateIds.has(targetId)
    ) {
      continue;
    }
    if (directionEligiblePathExpansionTargets(path, candidateIds).length === 0) {
      continue;
    }
    count += 1;
  }
  return count;
}

export function countActivePathInflowEdges(
  paths: readonly Readonly<PathRelation>[],
  candidateIds: ReadonlySet<string>
): number {
  const inflow = buildPathInflowByTarget(paths, candidateIds);
  return uniqueStrings(
    Object.values(inflow).flatMap((edges) =>
      edges.map((edge) => `${edge.seedObjectId}:${edge.weight}`)
    )
  ).length;
}
