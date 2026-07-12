import type { MemoryEntry } from "@do-soul/alaya-protocol";
import {
  DYNAMIC_RECALL_SEED_CAP,
  countDomainTags,
  scoreDomainTagCluster,
  selectExpansionSeedEntries,
  selectPreferredExpansionSeedEntries,
  type CoarseCandidateDraft
} from "../coarse-filter/coarse-candidates.js";
import { compareMemoryEntries } from "../runtime/recall-service-helpers.js";
import type { RecallQueryProbes } from "../query/recall-query-probes.js";
import { deriveQuerySoughtFacets } from "../query/query-facet-router.js";
import type { RecallAdmissionPlane } from "../runtime/recall-service-types.js";
import {
  scoreEvidenceAnchorMatch,
  scoreQueryEvidenceMatch
} from "../scoring/query-evidence-scoring.js";

export type CoarseCandidateAdder = (
  entry: Readonly<MemoryEntry>,
  plane: RecallAdmissionPlane,
  structuralScore?: number,
  sourceChannel?: string
) => boolean;

export function addContentDerivedExpansionCandidates(params: Readonly<{
  readonly tierMemories: readonly Readonly<MemoryEntry>[];
  readonly drafts: ReadonlyMap<string, CoarseCandidateDraft>;
  readonly queryProbes: Readonly<RecallQueryProbes>;
  readonly addCandidate: CoarseCandidateAdder;
  readonly dynamicRecallPlaneCap: number;
  readonly dynamicRecallCohortRadius: number;
}>): void {
  addQueryEvidenceCandidates(params);
  addFacetConceptCandidates(params);
  const seedContext = collectExpansionSeedContext(params);
  addEvidenceAnchorCandidates(params, seedContext.structuralSeeds);
  addDomainTagClusterCandidates(params, seedContext.structuralSeeds);
  addSessionSurfaceCohortCandidates(params, seedContext);
}

function addFacetConceptCandidates(params: Readonly<{
  readonly tierMemories: readonly Readonly<MemoryEntry>[];
  readonly queryProbes: Readonly<RecallQueryProbes>;
  readonly addCandidate: CoarseCandidateAdder;
  readonly dynamicRecallPlaneCap: number;
}>): void {
  const sought = new Set(deriveQuerySoughtFacets(params.queryProbes));
  if (sought.size === 0) return;
  const matches = params.tierMemories
    .map((entry) => ({ entry, overlap: countFacetOverlap(entry, sought) }))
    .filter(({ overlap }) => overlap > 0)
    .sort((left, right) => right.overlap - left.overlap || compareMemoryEntries(left.entry, right.entry))
    .slice(0, params.dynamicRecallPlaneCap);
  for (const { entry } of matches) {
    params.addCandidate(entry, "facet_concept", undefined, "facet_concept");
  }
}

function countFacetOverlap(entry: Readonly<MemoryEntry>, sought: ReadonlySet<string>): number {
  return new Set((entry.facet_tags ?? []).map(({ facet }) => facet).filter((facet) => sought.has(facet))).size;
}

function addQueryEvidenceCandidates(params: Readonly<{
  readonly tierMemories: readonly Readonly<MemoryEntry>[];
  readonly queryProbes: Readonly<RecallQueryProbes>;
  readonly addCandidate: CoarseCandidateAdder;
  readonly dynamicRecallPlaneCap: number;
}>): void {
  const queryEvidenceEntries = params.tierMemories
    .map((entry) => Object.freeze({
      entry,
      score: scoreQueryEvidenceMatch(entry, params.queryProbes)
    }))
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) =>
      right.score === left.score
        ? compareMemoryEntries(left.entry, right.entry)
        : right.score - left.score
    )
    .slice(0, params.dynamicRecallPlaneCap);
  for (const candidate of queryEvidenceEntries) {
    params.addCandidate(candidate.entry, "lexical", candidate.score, "query_probe_lexical");
  }
}

function collectExpansionSeedContext(params: Readonly<{
  readonly tierMemories: readonly Readonly<MemoryEntry>[];
  readonly drafts: ReadonlyMap<string, CoarseCandidateDraft>;
}>): Readonly<{
  readonly seeds: readonly Readonly<MemoryEntry>[];
  readonly structuralSeeds: readonly Readonly<MemoryEntry>[];
}> {
  const seeds = selectExpansionSeedEntries(params.drafts, params.tierMemories)
    .slice(0, DYNAMIC_RECALL_SEED_CAP);
  const structuralSeeds = selectPreferredExpansionSeedEntries(params.drafts)
    .slice(0, DYNAMIC_RECALL_SEED_CAP);
  return Object.freeze({ seeds, structuralSeeds });
}

function addEvidenceAnchorCandidates(
  params: Readonly<{
    readonly tierMemories: readonly Readonly<MemoryEntry>[];
    readonly queryProbes: Readonly<RecallQueryProbes>;
    readonly addCandidate: CoarseCandidateAdder;
    readonly dynamicRecallPlaneCap: number;
  }>,
  structuralSeeds: readonly Readonly<MemoryEntry>[]
): void {
  const evidenceRefs = new Set<string>([
    ...params.queryProbes.evidence_refs,
    ...structuralSeeds.flatMap((entry) => entry.evidence_refs)
  ]);
  if (evidenceRefs.size > 0) {
    const entries = params.tierMemories
      .map((entry) => Object.freeze({
        entry,
        score: scoreEvidenceAnchorMatch(entry, evidenceRefs)
      }))
      .filter((candidate) => candidate.score > 0)
      .sort((left, right) =>
        right.score === left.score
          ? compareMemoryEntries(left.entry, right.entry)
          : right.score - left.score
      )
      .slice(0, params.dynamicRecallPlaneCap);
    for (const candidate of entries) {
      params.addCandidate(candidate.entry, "evidence_anchor", candidate.score, "evidence_anchor");
    }
  }
}

function addDomainTagClusterCandidates(
  params: Readonly<{
    readonly tierMemories: readonly Readonly<MemoryEntry>[];
    readonly queryProbes: Readonly<RecallQueryProbes>;
    readonly addCandidate: CoarseCandidateAdder;
    readonly dynamicRecallPlaneCap: number;
  }>,
  structuralSeeds: readonly Readonly<MemoryEntry>[]
): void {
  const tagFrequency = countDomainTags(params.tierMemories);
  const queryTags = new Set(params.queryProbes.domain_tags);
  const seedTags = new Set(structuralSeeds.flatMap((entry) => entry.domain_tags));
  const domainTags = new Set([...queryTags, ...seedTags]);
  const commonTagLimit = Math.max(25, Math.floor(params.tierMemories.length * 0.2));
  if (domainTags.size > 0) {
    const entries = params.tierMemories
      .map((entry) => Object.freeze({
        entry,
        score: scoreDomainTagCluster(entry, domainTags, queryTags, tagFrequency, commonTagLimit)
      }))
      .filter((candidate) => candidate.score > 0)
      .sort((left, right) =>
        right.score === left.score
          ? compareMemoryEntries(left.entry, right.entry)
          : right.score - left.score
      )
      .slice(0, params.dynamicRecallPlaneCap);
    for (const candidate of entries) {
      params.addCandidate(candidate.entry, "domain_tag_cluster", candidate.score, "domain_tag_cluster");
    }
  }
}

// invariant: cohort dominance guard runs per-branch; exact and seed-proximity cohorts are each skipped only when their own match set covers >50% of tierMemories.
function addSessionSurfaceCohortCandidates(
  params: Readonly<{
    readonly tierMemories: readonly Readonly<MemoryEntry>[];
    readonly queryProbes: Readonly<RecallQueryProbes>;
    readonly addCandidate: CoarseCandidateAdder;
    readonly dynamicRecallPlaneCap: number;
    readonly dynamicRecallCohortRadius: number;
  }>,
  seedContext: Readonly<{
    readonly seeds: readonly Readonly<MemoryEntry>[];
    readonly structuralSeeds: readonly Readonly<MemoryEntry>[];
  }>
): void {
  addExactSessionSurfaceCohortCandidates(params);
  if (seedContext.structuralSeeds.length > 0) {
    addSeedSessionSurfaceCohortCandidates(params, seedContext.seeds);
  }
}

function addExactSessionSurfaceCohortCandidates(params: Readonly<{
  readonly tierMemories: readonly Readonly<MemoryEntry>[];
  readonly queryProbes: Readonly<RecallQueryProbes>;
  readonly addCandidate: CoarseCandidateAdder;
  readonly dynamicRecallPlaneCap: number;
}>): void {
  const querySurfaceIds = new Set(params.queryProbes.surface_ids);
  const queryRunIds = new Set(params.queryProbes.run_ids);
  const exactCohortMatches = params.tierMemories
    .filter((entry) =>
      (entry.surface_id !== null && querySurfaceIds.has(entry.surface_id)) ||
      (entry.run_id !== null && queryRunIds.has(entry.run_id))
    )
    .sort(compareMemoryEntries)
    .slice(0, params.dynamicRecallPlaneCap);
  const exactCohortRatio =
    params.tierMemories.length === 0
      ? 0
      : exactCohortMatches.length / params.tierMemories.length;
  if (exactCohortRatio <= 0.5) {
    for (const entry of exactCohortMatches) {
      params.addCandidate(entry, "session_surface_cohort", 0.8, "session_surface_cohort");
    }
  }
}

function addSeedSessionSurfaceCohortCandidates(
  params: Readonly<{
    readonly tierMemories: readonly Readonly<MemoryEntry>[];
    readonly addCandidate: CoarseCandidateAdder;
    readonly dynamicRecallCohortRadius: number;
  }>,
  seeds: readonly Readonly<MemoryEntry>[]
): void {
  const cohortContext = collectSeedCohortContext(params, seeds);
  const seedCohortRatio =
    params.tierMemories.length === 0
      ? 0
      : cohortContext.seedCohortIds.size / params.tierMemories.length;
  if (seedCohortRatio > 0.5) {
    return;
  }
  for (const seed of seeds.slice(0, DYNAMIC_RECALL_SEED_CAP)) {
    for (const entry of sliceSeedCohortNeighbors(params, cohortContext.seedCohortByMemoryId, seed)) {
      params.addCandidate(entry, "session_surface_cohort", 0.55, "session_surface_cohort");
    }
  }
}

function collectSeedCohortContext(
  params: Readonly<{
    readonly tierMemories: readonly Readonly<MemoryEntry>[];
    readonly dynamicRecallCohortRadius: number;
  }>,
  seeds: readonly Readonly<MemoryEntry>[]
): Readonly<{
  readonly seedCohortByMemoryId: ReadonlyMap<string, readonly Readonly<MemoryEntry>[]>;
  readonly seedCohortIds: ReadonlySet<string>;
}> {
  const seedCohortByMemoryId = new Map<string, readonly Readonly<MemoryEntry>[]>();
  const seedCohortIds = new Set<string>();
  const cohortIndex = buildSessionSurfaceCohortIndex(params.tierMemories);
  for (const seed of seeds.slice(0, DYNAMIC_RECALL_SEED_CAP)) {
    const cohort = collectSessionSurfaceCohort(cohortIndex, seed);
    seedCohortByMemoryId.set(seed.object_id, cohort);
    for (const entry of sliceSeedCohortNeighbors(params, seedCohortByMemoryId, seed)) {
      seedCohortIds.add(entry.object_id);
    }
  }
  return Object.freeze({ seedCohortByMemoryId, seedCohortIds });
}

interface SessionSurfaceCohortIndex {
  readonly bySurfaceId: ReadonlyMap<string, readonly Readonly<MemoryEntry>[]>;
  readonly byRunId: ReadonlyMap<string, readonly Readonly<MemoryEntry>[]>;
  readonly rankByEntry: ReadonlyMap<Readonly<MemoryEntry>, number>;
  readonly bySeedKey: Map<string, readonly Readonly<MemoryEntry>[]>;
}

function buildSessionSurfaceCohortIndex(
  tierMemories: readonly Readonly<MemoryEntry>[]
): SessionSurfaceCohortIndex {
  const ordered = [...tierMemories].sort(compareSessionSurfaceEntries);
  const bySurfaceId = new Map<string, Readonly<MemoryEntry>[]>();
  const byRunId = new Map<string, Readonly<MemoryEntry>[]>();
  const rankByEntry = new Map<Readonly<MemoryEntry>, number>();
  ordered.forEach((entry, rank) => {
    rankByEntry.set(entry, rank);
    appendCohortEntry(bySurfaceId, entry.surface_id, entry);
    appendCohortEntry(byRunId, entry.run_id, entry);
  });
  return { bySurfaceId, byRunId, rankByEntry, bySeedKey: new Map() };
}

function appendCohortEntry(
  index: Map<string, Readonly<MemoryEntry>[]>,
  key: string | null,
  entry: Readonly<MemoryEntry>
): void {
  if (key === null) {
    return;
  }
  const cohort = index.get(key) ?? [];
  cohort.push(entry);
  index.set(key, cohort);
}

function collectSessionSurfaceCohort(
  index: SessionSurfaceCohortIndex,
  seed: Readonly<MemoryEntry>
): readonly Readonly<MemoryEntry>[] {
  const { surface_id: surfaceId, run_id: runId } = seed;
  const seedKey = JSON.stringify([surfaceId, runId]);
  const cached = index.bySeedKey.get(seedKey);
  if (cached !== undefined) {
    return cached;
  }
  const surfaceCohort = surfaceId === null ? [] : index.bySurfaceId.get(surfaceId) ?? [];
  const runCohort = runId === null ? [] : index.byRunId.get(runId) ?? [];
  const cohort = mergeSessionSurfaceCohorts(index.rankByEntry, surfaceCohort, runCohort);
  index.bySeedKey.set(seedKey, cohort);
  return cohort;
}

function mergeSessionSurfaceCohorts(
  rankByEntry: ReadonlyMap<Readonly<MemoryEntry>, number>,
  surfaceCohort: readonly Readonly<MemoryEntry>[],
  runCohort: readonly Readonly<MemoryEntry>[]
): readonly Readonly<MemoryEntry>[] {
  return [...new Set([...surfaceCohort, ...runCohort])]
    .sort((left, right) => (rankByEntry.get(left) ?? 0) - (rankByEntry.get(right) ?? 0));
}

function compareSessionSurfaceEntries(
  left: Readonly<MemoryEntry>,
  right: Readonly<MemoryEntry>
): number {
  const createdAtComparison = left.created_at.localeCompare(right.created_at);
  return createdAtComparison === 0
    ? left.object_id.localeCompare(right.object_id)
    : createdAtComparison;
}

function sliceSeedCohortNeighbors(
  params: Readonly<{ readonly dynamicRecallCohortRadius: number }>,
  seedCohortByMemoryId: ReadonlyMap<string, readonly Readonly<MemoryEntry>[]>,
  seed: Readonly<MemoryEntry>
): readonly Readonly<MemoryEntry>[] {
  const cohort = seedCohortByMemoryId.get(seed.object_id) ?? [];
  const center = cohort.findIndex((entry) => entry.object_id === seed.object_id);
  if (center < 0) {
    return [];
  }
  const start = Math.max(0, center - params.dynamicRecallCohortRadius);
  const end = Math.min(cohort.length, center + params.dynamicRecallCohortRadius + 1);
  return cohort.slice(start, end).filter((entry) => entry.object_id !== seed.object_id);
}
