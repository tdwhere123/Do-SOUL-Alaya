import {
  type MemoryEntry
} from "@do-soul/alaya-protocol";
import {
  DYNAMIC_RECALL_SEED_CAP,
  selectExpansionSeedDrafts,
  type CoarseCandidateDraft
} from "./coarse-candidates.js";
import {
  compareGraphExpansionCandidateDrafts,
  createMutableGraphExpansionDiagnostics,
  freezeGraphExpansionCandidatesResult,
  mergeGraphExpansionCandidate,
  type GraphExpansionCandidateDraft,
  type GraphExpansionCandidateSourceDiagnostic,
  type GraphExpansionCandidatesResult
} from "./graph-expansion.js";
import { clamp01, errorNameOf, toErrorMessage } from "./recall-service-helpers.js";
import type {
  RecallAdmissionPlane,
  RecallPathExpansionSourceDiagnostic,
  RecallServiceDependencies,
  RecallServiceWarnPort
} from "./recall-service-types.js";
import { expandGraphFrontier } from "./structural-expansion-graph-frontier.js";


type CoarseCandidateAdder = (
  entry: Readonly<MemoryEntry>,
  plane: RecallAdmissionPlane,
  structuralScore?: number,
  sourceChannel?: string,
  pathExpansionSource?: RecallPathExpansionSourceDiagnostic,
  entityConfidence?: number,
  reachedViaEarnedCoRecalledFanin?: boolean
) => boolean;

export async function collectEntityDerivedSeeds(params: Readonly<{
  readonly workspaceId: string;
  readonly queryText: string | null;
  readonly byId: ReadonlyMap<string, Readonly<MemoryEntry>>;
  readonly addCandidate: CoarseCandidateAdder;
  readonly lexicalFtsRanks: ReadonlyMap<string, number>;
  readonly entityExtractionPort?: RecallServiceDependencies["entityExtractionPort"];
  readonly memoryRepo: RecallServiceDependencies["memoryRepo"];
  readonly warn: RecallServiceWarnPort;
  readonly entityExtractionMaxEntities: number;
  readonly entitySeedPerEntityTopKStrong: number;
  readonly entitySeedPerEntityTopKWeak: number;
  readonly entitySeedTotalAdmitCap: number;
  readonly entitySeedMinSurfaceLength: number;
}>): Promise<readonly Readonly<{ memoryId: string; entityConfidence: number }>[]> {
  if (shouldSkipEntitySeedCollection(params)) {
    return [];
  }
  const entities = await extractSeedEntities(params);
  if (entities.length === 0) {
    return [];
  }
  const seedConfidenceById = new Map<string, number>();
  const candidateIds = [...params.byId.keys()];
  let admittedTotal = 0;
  for (const entity of entities) {
    if (admittedTotal >= params.entitySeedTotalAdmitCap) {
      break;
    }
    admittedTotal = await admitEntitySeedsForEntity(
      params,
      entity,
      candidateIds,
      seedConfidenceById,
      admittedTotal
    );
  }
  return buildEntitySeedResults(seedConfidenceById);
}

export async function addGraphExpansionCandidates(params: Readonly<{
  readonly workspaceId: string;
  readonly byId: ReadonlyMap<string, Readonly<MemoryEntry>>;
  readonly drafts: ReadonlyMap<string, CoarseCandidateDraft>;
  readonly addCandidate: CoarseCandidateAdder;
  readonly pathExpansionPort?: RecallServiceDependencies["pathExpansionPort"];
  readonly extraSeedMemoryIds?: readonly string[];
  readonly draftSeedIds?: readonly string[];
  readonly maxGraphHops: number;
  readonly dynamicRecallEdgeFanout: number;
  readonly multiSeedGraphFanOutCap: number;
  readonly warn: RecallServiceWarnPort;
  readonly degradationReasons?: Set<import("./recall-service-types.js").RecallDegradationReason>;
}>): Promise<Readonly<GraphExpansionCandidatesResult>> {
  const diagnostics = createMutableGraphExpansionDiagnostics();
  const candidateSources = new Map<string, Readonly<GraphExpansionCandidateSourceDiagnostic>>();
  const pathExpansionPort = params.pathExpansionPort;
  if (pathExpansionPort === undefined) {
    return freezeGraphExpansionCandidatesResult(diagnostics, candidateSources);
  }

  const { entitySeedEntries, entitySeedIdSet } = collectEntityGraphExpansionSeeds(params);
  const draftSeedEntries = collectDraftGraphExpansionSeedEntries(params, entitySeedIdSet);
  if (draftSeedEntries.length === 0 && entitySeedEntries.length === 0) {
    return freezeGraphExpansionCandidatesResult(diagnostics, candidateSources);
  }

  const bestCandidates = new Map<string, GraphExpansionCandidateDraft>();
  await collectDraftGraphExpansionCandidates(params, pathExpansionPort, draftSeedEntries, bestCandidates);
  await collectEntityGraphExpansionCandidates(params, pathExpansionPort, entitySeedEntries, bestCandidates, diagnostics);
  admitGraphExpansionCandidates(params, bestCandidates, diagnostics, candidateSources);
  return freezeGraphExpansionCandidatesResult(diagnostics, candidateSources);
}

type AddGraphExpansionCandidatesParams = Parameters<typeof addGraphExpansionCandidates>[0];
type MutableGraphExpansionDiagnostics = ReturnType<typeof createMutableGraphExpansionDiagnostics>;
type PathExpansionPort = NonNullable<RecallServiceDependencies["pathExpansionPort"]>;

function collectEntityGraphExpansionSeeds(
  params: AddGraphExpansionCandidatesParams
): Readonly<{
  readonly entitySeedEntries: readonly Readonly<MemoryEntry>[];
  readonly entitySeedIdSet: ReadonlySet<string>;
}> {
  const entitySeedIdSet = new Set<string>();
  const entitySeedEntries: Readonly<MemoryEntry>[] = [];
  for (const id of params.extraSeedMemoryIds ?? []) {
    if (entitySeedIdSet.has(id)) {
      continue;
    }
    const entry = params.byId.get(id);
    if (entry === undefined) {
      continue;
    }
    entitySeedEntries.push(entry);
    entitySeedIdSet.add(id);
    if (entitySeedEntries.length >= DYNAMIC_RECALL_SEED_CAP) {
      break;
    }
  }
  return Object.freeze({ entitySeedEntries, entitySeedIdSet });
}

function collectDraftGraphExpansionSeedEntries(
  params: AddGraphExpansionCandidatesParams,
  entitySeedIdSet: ReadonlySet<string>
): readonly Readonly<MemoryEntry>[] {
  const draftSeedIdAllowList = params.draftSeedIds === undefined ? null : new Set(params.draftSeedIds);
  const draftSeedsAll = selectExpansionSeedDrafts(params.drafts).slice(0, DYNAMIC_RECALL_SEED_CAP);
  return draftSeedsAll
    .filter(
      (seed) =>
        !entitySeedIdSet.has(seed.entry.object_id) &&
        (draftSeedIdAllowList === null || draftSeedIdAllowList.has(seed.entry.object_id))
    )
    .map((seed) => seed.entry);
}

async function collectDraftGraphExpansionCandidates(
  params: AddGraphExpansionCandidatesParams,
  pathExpansionPort: PathExpansionPort,
  draftSeedEntries: readonly Readonly<MemoryEntry>[],
  bestCandidates: Map<string, GraphExpansionCandidateDraft>
): Promise<void> {
  if (draftSeedEntries.length > 0) {
    await expandGraphFrontier({
      workspaceId: params.workspaceId,
      byId: params.byId,
      pathExpansionPort,
      seedEntries: draftSeedEntries,
      maxGraphHops: params.maxGraphHops,
      dynamicRecallEdgeFanout: params.dynamicRecallEdgeFanout,
      warn: params.warn,
      degradationReasons: params.degradationReasons,
      onCandidate: (candidate) => {
        const objectId = candidate.entry.object_id;
        bestCandidates.set(objectId, mergeGraphExpansionCandidate(bestCandidates.get(objectId), candidate));
      }
    });
  }
}

async function collectEntityGraphExpansionCandidates(
  params: AddGraphExpansionCandidatesParams,
  pathExpansionPort: PathExpansionPort,
  entitySeedEntries: readonly Readonly<MemoryEntry>[],
  bestCandidates: Map<string, GraphExpansionCandidateDraft>,
  diagnostics: MutableGraphExpansionDiagnostics
): Promise<void> {
  if (entitySeedEntries.length > 0) {
    diagnostics.multi_seed_fan_in_distinct_seeds = entitySeedEntries.length;
    const perSeedCandidates: Map<string, GraphExpansionCandidateDraft>[] = [];
    for (const seedEntry of entitySeedEntries) {
      const seedMap = await collectSingleEntitySeedGraphCandidates(params, pathExpansionPort, seedEntry);
      diagnostics.multi_seed_fan_in_candidates_per_seed.push(seedMap.size);
      perSeedCandidates.push(seedMap);
    }
    mergeEntityFanInCandidates(perSeedCandidates, bestCandidates, diagnostics);
  }
}

async function collectSingleEntitySeedGraphCandidates(
  params: AddGraphExpansionCandidatesParams,
  pathExpansionPort: PathExpansionPort,
  seedEntry: Readonly<MemoryEntry>
): Promise<Map<string, GraphExpansionCandidateDraft>> {
  const seedMap = new Map<string, GraphExpansionCandidateDraft>();
  await expandGraphFrontier({
    workspaceId: params.workspaceId,
    byId: params.byId,
    pathExpansionPort,
    seedEntries: [seedEntry],
    maxGraphHops: params.maxGraphHops,
    dynamicRecallEdgeFanout: params.dynamicRecallEdgeFanout,
    warn: params.warn,
    degradationReasons: params.degradationReasons,
    onCandidate: (candidate) => {
      const objectId = candidate.entry.object_id;
      seedMap.set(objectId, mergeGraphExpansionCandidate(seedMap.get(objectId), candidate));
    }
  });
  return seedMap;
}

function mergeEntityFanInCandidates(
  perSeedCandidates: readonly ReadonlyMap<string, GraphExpansionCandidateDraft>[],
  bestCandidates: Map<string, GraphExpansionCandidateDraft>,
  diagnostics: MutableGraphExpansionDiagnostics
): void {
  const fanInSeen = new Set<string>();
  for (const seedMap of perSeedCandidates) {
    for (const [neighborId, candidate] of seedMap) {
      if (fanInSeen.has(neighborId)) {
        diagnostics.multi_seed_fan_in_dedup_collisions += 1;
      }
      fanInSeen.add(neighborId);
      const current = bestCandidates.get(neighborId);
      bestCandidates.set(neighborId, mergeGraphExpansionCandidate(current, candidate));
    }
  }
}

function admitGraphExpansionCandidates(
  params: AddGraphExpansionCandidatesParams,
  bestCandidates: ReadonlyMap<string, GraphExpansionCandidateDraft>,
  diagnostics: MutableGraphExpansionDiagnostics,
  candidateSources: Map<string, Readonly<GraphExpansionCandidateSourceDiagnostic>>
): void {
  const admitted = [...bestCandidates.values()]
    .sort(compareGraphExpansionCandidateDrafts)
    .slice(0, params.multiSeedGraphFanOutCap);
  for (const candidate of admitted) {
    if (params.drafts.get(candidate.entry.object_id)?.admissionPlanes.includes("path_expansion") === true) {
      continue;
    }
    const admittedByGraphExpansion = params.addCandidate(
      candidate.entry,
      "graph_expansion",
      candidate.score,
      "graph_expansion"
    );
    if (!admittedByGraphExpansion) {
      continue;
    }
    diagnostics.graph_expansion_plane_count_per_hop[candidate.hop - 1] += 1;
    diagnostics.graph_expansion_plane_count_per_edge_type[candidate.edgeType] += 1;
    candidateSources.set(candidate.entry.object_id, Object.freeze({
      hop: candidate.hop,
      edgeType: candidate.edgeType
    }));
  }
}

function shouldSkipEntitySeedCollection(params: Readonly<{
  readonly entityExtractionPort?: RecallServiceDependencies["entityExtractionPort"];
  readonly queryText: string | null;
  readonly byId: ReadonlyMap<string, Readonly<MemoryEntry>>;
  readonly memoryRepo: RecallServiceDependencies["memoryRepo"];
}>): boolean {
  return (
    params.entityExtractionPort === undefined ||
    params.queryText === null ||
    params.byId.size === 0 ||
    (params.memoryRepo.searchByKeyword === undefined &&
      params.memoryRepo.searchByKeywordWithinObjectIds === undefined)
  );
}

async function extractSeedEntities(params: Readonly<{
  readonly workspaceId: string;
  readonly queryText: string | null;
  readonly entityExtractionPort?: RecallServiceDependencies["entityExtractionPort"];
  readonly warn: RecallServiceWarnPort;
  readonly entityExtractionMaxEntities: number;
}>): Promise<readonly Readonly<{
  readonly surface: string;
  readonly normalized: string;
  readonly confidence: number;
}>[]> {
  try {
    return await params.entityExtractionPort!.extract(params.queryText!, {
      maxEntities: params.entityExtractionMaxEntities
    });
  } catch (error) {
    params.warn("entity extraction failed", {
      workspace_id: params.workspaceId,
      operation: "entity_extraction",
      errorName: errorNameOf(error),
      error: toErrorMessage(error)
    });
    return [];
  }
}

async function admitEntitySeedsForEntity(
  params: Parameters<typeof collectEntityDerivedSeeds>[0],
  entity: Readonly<{ readonly surface: string; readonly confidence: number }>,
  candidateIds: readonly string[],
  seedConfidenceById: Map<string, number>,
  admittedTotal: number
): Promise<number> {
  const surface = entity.surface.trim();
  if (surface.length < params.entitySeedMinSurfaceLength) {
    return admittedTotal;
  }
  const hits = await searchEntitySeedHits(params, surface, entity.confidence, candidateIds);
  return admitEntitySeedHits(params, entity.confidence, hits, seedConfidenceById, admittedTotal);
}

async function searchEntitySeedHits(
  params: Parameters<typeof collectEntityDerivedSeeds>[0],
  surface: string,
  confidence: number,
  candidateIds: readonly string[]
): Promise<readonly Readonly<{ readonly object_id: string; readonly normalized_rank: number }>[]> {
  const perEntityLimit = confidence >= 0.85
    ? params.entitySeedPerEntityTopKStrong
    : params.entitySeedPerEntityTopKWeak;
  try {
    return params.memoryRepo.searchByKeywordWithinObjectIds !== undefined
      ? await params.memoryRepo.searchByKeywordWithinObjectIds(
          params.workspaceId,
          surface,
          perEntityLimit,
          candidateIds
        )
      : await params.memoryRepo.searchByKeyword!(params.workspaceId, surface, perEntityLimit);
  } catch (error) {
    params.warn("entity seed lookup failed", {
      workspace_id: params.workspaceId,
      entity_surface: surface,
      operation: "entity_seed_lookup",
      errorName: errorNameOf(error),
      error: toErrorMessage(error)
    });
    return [];
  }
}

function admitEntitySeedHits(
  params: Parameters<typeof collectEntityDerivedSeeds>[0],
  entityConfidence: number,
  hits: readonly Readonly<{ readonly object_id: string; readonly normalized_rank: number }>[],
  seedConfidenceById: Map<string, number>,
  admittedTotal: number
): number {
  let nextAdmittedTotal = admittedTotal;
  for (const hit of hits) {
    const entry = params.byId.get(hit.object_id);
    if (entry === undefined) {
      continue;
    }
    const rawScore = clamp01(hit.normalized_rank * entityConfidence);
    if (rawScore <= 0) {
      continue;
    }
    const lexicalWeight = clamp01(params.lexicalFtsRanks.get(hit.object_id) ?? 0);
    const score = lexicalWeight > 0 ? 0 : rawScore;
    params.addCandidate(entry, "entity_seed", score, "entity_seed", undefined, entityConfidence);
    seedConfidenceById.set(
      entry.object_id,
      Math.max(seedConfidenceById.get(entry.object_id) ?? 0, entityConfidence)
    );
    nextAdmittedTotal += 1;
    if (nextAdmittedTotal >= params.entitySeedTotalAdmitCap) {
      break;
    }
  }
  return nextAdmittedTotal;
}

function buildEntitySeedResults(
  seedConfidenceById: ReadonlyMap<string, number>
): readonly Readonly<{ memoryId: string; entityConfidence: number }>[] {
  return [...seedConfidenceById.entries()].map(([memoryId, entityConfidence]) =>
    Object.freeze({ memoryId, entityConfidence })
  );
}
