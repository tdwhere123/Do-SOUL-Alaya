import {
  type MemoryEntry
} from "@do-soul/alaya-protocol";
import {
  DYNAMIC_RECALL_SEED_CAP,
  selectExpansionSeedDrafts,
  type CoarseCandidateDraft
} from "../coarse-filter/coarse-candidates.js";
import {
  compareGraphExpansionCandidateDrafts,
  createMutableGraphExpansionDiagnostics,
  freezeGraphExpansionCandidatesResult,
  mergeGraphExpansionCandidate,
  type GraphExpansionCandidateDraft,
  type GraphExpansionCandidateSourceDiagnostic,
  type GraphExpansionCandidatesResult
} from "./graph-expansion.js";
import { clamp01, errorNameOf, toErrorMessage } from "../runtime/recall-service-helpers.js";
import type {
  RecallAdmissionPlane,
  RecallPathExpansionSourceDiagnostic,
  RecallServiceDependencies,
  RecallServiceWarnPort
} from "../runtime/recall-service-types.js";
import {
  expandGraphFrontier,
  expandGraphFrontiersBySeed
} from "./structural-expansion-graph-frontier.js";
import { loadEntitySeedHitBatches } from "./entity-seed-bulk-read.js";


type CoarseCandidateAdder = (
  entry: Readonly<MemoryEntry>,
  plane: RecallAdmissionPlane,
  structuralScore?: number,
  sourceChannel?: string,
  pathExpansionSource?: RecallPathExpansionSourceDiagnostic,
  entityConfidence?: number
) => boolean;

type EntitySeedDescriptor = Readonly<{
  readonly surface: string;
  readonly confidence: number;
}>;

type EntitySeedLookup = Readonly<{
  readonly entity: EntitySeedDescriptor;
  readonly surface: string;
  readonly limit: number;
}>;

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
  const lookups = buildEntitySeedLookups(params, entities);
  const hitBatches = await loadEntitySeedBatchesForCollection(params, lookups, candidateIds);
  let admittedTotal = 0;
  for (let index = 0; index < lookups.length; index += 1) {
    if (admittedTotal >= params.entitySeedTotalAdmitCap) {
      break;
    }
    const lookup = lookups[index];
    const hits = hitBatches[index] ?? [];
    if (lookup === undefined) break;
    admittedTotal = admitEntitySeedHits(
      params,
      lookup.entity.confidence,
      hits,
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
  readonly degradationReasons?: Set<import("../runtime/recall-service-types.js").RecallDegradationReason>;
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
    const perSeedCandidates = entitySeedEntries.map(
      (): Map<string, GraphExpansionCandidateDraft> => new Map()
    );
    await expandGraphFrontiersBySeed({
      workspaceId: params.workspaceId,
      byId: params.byId,
      pathExpansionPort,
      seedEntries: entitySeedEntries,
      maxGraphHops: params.maxGraphHops,
      dynamicRecallEdgeFanout: params.dynamicRecallEdgeFanout,
      warn: params.warn,
      degradationReasons: params.degradationReasons,
      onCandidate: (seedIndex, candidate) => {
        const seedMap = perSeedCandidates[seedIndex];
        if (seedMap === undefined) {
          throw new Error("Graph expansion seed index out of range.");
        }
        const objectId = candidate.entry.object_id;
        seedMap.set(objectId, mergeGraphExpansionCandidate(seedMap.get(objectId), candidate));
      }
    });
    for (const seedMap of perSeedCandidates) {
      diagnostics.multi_seed_fan_in_candidates_per_seed.push(seedMap.size);
    }
    mergeEntityFanInCandidates(perSeedCandidates, bestCandidates, diagnostics);
  }
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
    incrementGraphExpansionHopCount(diagnostics, candidate.hop);
    diagnostics.graph_expansion_plane_count_per_edge_type[candidate.edgeType] += 1;
    candidateSources.set(candidate.entry.object_id, Object.freeze({
      hop: candidate.hop,
      edgeType: candidate.edgeType
    }));
  }
}

function incrementGraphExpansionHopCount(
  diagnostics: ReturnType<typeof createMutableGraphExpansionDiagnostics>,
  hop: number
): void {
  const index = hop - 1;
  const current = diagnostics.graph_expansion_plane_count_per_hop[index];
  if (current === undefined) {
    throw new Error("Graph expansion diagnostic invariant violated: hop index out of range.");
  }
  diagnostics.graph_expansion_plane_count_per_hop[index] = current + 1;
}

function shouldSkipEntitySeedCollection(params: Readonly<{
  readonly entityExtractionPort?: RecallServiceDependencies["entityExtractionPort"];
  readonly queryText: string | null;
  readonly byId: ReadonlyMap<string, Readonly<MemoryEntry>>;
}>): boolean {
  return (
    params.entityExtractionPort === undefined ||
    params.queryText === null ||
    params.byId.size === 0
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
  const entityExtractionPort = params.entityExtractionPort;
  const queryText = params.queryText;
  if (entityExtractionPort === undefined || queryText === null) return [];
  try {
    return await entityExtractionPort.extract(queryText, {
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

function buildEntitySeedLookups(
  params: Parameters<typeof collectEntityDerivedSeeds>[0],
  entities: readonly EntitySeedDescriptor[]
): readonly EntitySeedLookup[] {
  return entities.flatMap((entity) => {
    const surface = entity.surface.trim();
    return surface.length < params.entitySeedMinSurfaceLength
      ? []
      : [{ entity, surface, limit: resolveEntitySeedLimit(params, entity.confidence) }];
  });
}

async function loadEntitySeedBatchesForCollection(
  params: Parameters<typeof collectEntityDerivedSeeds>[0],
  lookups: readonly EntitySeedLookup[],
  candidateIds: readonly string[]
): Promise<readonly (readonly Readonly<{ readonly object_id: string; readonly normalized_rank: number }>[])[]> {
  return loadEntitySeedHitBatches({
    workspaceId: params.workspaceId,
    lookups,
    candidateIds,
    memoryRepo: params.memoryRepo,
    warn: params.warn
  });
}

function resolveEntitySeedLimit(
  params: Parameters<typeof collectEntityDerivedSeeds>[0],
  confidence: number
): number {
  return confidence >= 0.85
    ? params.entitySeedPerEntityTopKStrong
    : params.entitySeedPerEntityTopKWeak;
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
