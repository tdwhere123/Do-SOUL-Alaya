import {
  isPathRecallEligible,
  type MemoryEntry,
  type PathAnchorRef,
  type PathRelation
} from "@do-soul/alaya-protocol";
import {
  DYNAMIC_RECALL_SEED_CAP,
  selectExpansionSeedDrafts,
  type CoarseCandidateDraft
} from "./coarse-candidates.js";
import {
  EDGE_TYPE_HOP_DECAY,
  compareGraphExpansionCandidateDrafts,
  createMutableGraphExpansionDiagnostics,
  freezeGraphExpansionCandidatesResult,
  graphTraversalScoreFromPath,
  shouldReplaceGraphExpansionCandidate,
  type GraphExpansionCandidateDraft,
  type GraphExpansionCandidateSourceDiagnostic,
  type GraphExpansionCandidatesResult,
  type GraphExpansionFrontierNode
} from "./graph-expansion.js";
import { collectPathGraphNeighbors } from "./path-relations.js";
import { recallFusionRetuneEnabled } from "./recall-retune-flags.js";
import { clamp01, toErrorMessage } from "./recall-service-helpers.js";

// Entity-seed score retained at this fraction per unit of lexical overlap under
// the retune flag, instead of a hard zero.
const ENTITY_LEXICAL_OVERLAP_DECAY = 0.5;
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
  const port = params.entityExtractionPort;
  const memoryRepo = params.memoryRepo;
  if (
    port === undefined ||
    params.queryText === null ||
    params.byId.size === 0 ||
    (memoryRepo.searchByKeyword === undefined && memoryRepo.searchByKeywordWithinObjectIds === undefined)
  ) {
    return [];
  }

  let entities: readonly Readonly<{
    readonly surface: string;
    readonly normalized: string;
    readonly confidence: number;
  }>[];
  try {
    entities = await port.extract(params.queryText, { maxEntities: params.entityExtractionMaxEntities });
  } catch (error) {
    params.warn("entity extraction failed", {
      workspace_id: params.workspaceId,
      error: toErrorMessage(error)
    });
    return [];
  }
  if (entities.length === 0) {
    return [];
  }

  const seedConfidenceById = new Map<string, number>();
  let admittedTotal = 0;
  const candidateIds = [...params.byId.keys()];
  for (const entity of entities) {
    if (admittedTotal >= params.entitySeedTotalAdmitCap) {
      break;
    }
    const surface = entity.surface.trim();
    if (surface.length < params.entitySeedMinSurfaceLength) {
      continue;
    }
    const perEntityLimit = entity.confidence >= 0.85
      ? params.entitySeedPerEntityTopKStrong
      : params.entitySeedPerEntityTopKWeak;
    let hits: readonly Readonly<{ readonly object_id: string; readonly normalized_rank: number }>[];
    try {
      hits =
        memoryRepo.searchByKeywordWithinObjectIds !== undefined
          ? await memoryRepo.searchByKeywordWithinObjectIds(
              params.workspaceId,
              surface,
              perEntityLimit,
              candidateIds
            )
          : await memoryRepo.searchByKeyword!(params.workspaceId, surface, perEntityLimit);
    } catch (error) {
      params.warn("entity seed lookup failed", {
        workspace_id: params.workspaceId,
        entity_surface: surface,
        error: toErrorMessage(error)
      });
      continue;
    }
    for (const hit of hits) {
      const entry = params.byId.get(hit.object_id);
      if (entry === undefined) {
        continue;
      }
      const rawScore = clamp01(hit.normalized_rank * entity.confidence);
      if (rawScore <= 0) {
        continue;
      }
      // Default zeros entity-seed on any lexical overlap so one surface term
      // cannot claim two fusion-stream slots; retune decays it additively instead.
      const lexicalWeight = clamp01(params.lexicalFtsRanks.get(hit.object_id) ?? 0);
      const score = recallFusionRetuneEnabled()
        ? rawScore * (1 - lexicalWeight * ENTITY_LEXICAL_OVERLAP_DECAY)
        : (lexicalWeight > 0 ? 0 : rawScore);
      params.addCandidate(entry, "entity_seed", score, "entity_seed", undefined, entity.confidence);
      const previous = seedConfidenceById.get(entry.object_id) ?? 0;
      if (entity.confidence > previous) {
        seedConfidenceById.set(entry.object_id, entity.confidence);
      }
      admittedTotal += 1;
      if (admittedTotal >= params.entitySeedTotalAdmitCap) {
        break;
      }
    }
  }
  return [...seedConfidenceById.entries()].map(([memoryId, entityConfidence]) =>
    Object.freeze({ memoryId, entityConfidence })
  );
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
}>): Promise<Readonly<GraphExpansionCandidatesResult>> {
  const diagnostics = createMutableGraphExpansionDiagnostics();
  const candidateSources = new Map<string, Readonly<GraphExpansionCandidateSourceDiagnostic>>();
  const pathExpansionPort = params.pathExpansionPort;
  if (pathExpansionPort === undefined) {
    return freezeGraphExpansionCandidatesResult(diagnostics, candidateSources);
  }

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
  const draftSeedIdAllowList = params.draftSeedIds === undefined ? null : new Set(params.draftSeedIds);
  const draftSeedsAll = selectExpansionSeedDrafts(params.drafts).slice(0, DYNAMIC_RECALL_SEED_CAP);
  const draftSeeds = draftSeedsAll.filter(
    (seed) =>
      !entitySeedIdSet.has(seed.entry.object_id) &&
      (draftSeedIdAllowList === null || draftSeedIdAllowList.has(seed.entry.object_id))
  );

  if (draftSeeds.length === 0 && entitySeedEntries.length === 0) {
    return freezeGraphExpansionCandidatesResult(diagnostics, candidateSources);
  }

  const bestCandidates = new Map<string, GraphExpansionCandidateDraft>();

  if (draftSeeds.length > 0) {
    const draftSeedEntries = draftSeeds.map((seed) => seed.entry);
    await expandGraphFrontier({
      workspaceId: params.workspaceId,
      byId: params.byId,
      pathExpansionPort,
      seedEntries: draftSeedEntries,
      maxGraphHops: params.maxGraphHops,
      dynamicRecallEdgeFanout: params.dynamicRecallEdgeFanout,
      warn: params.warn,
      onCandidate: (candidate) => {
        const current = bestCandidates.get(candidate.entry.object_id);
        if (current === undefined || shouldReplaceGraphExpansionCandidate(candidate, current)) {
          bestCandidates.set(candidate.entry.object_id, candidate);
        }
      }
    });
  }

  if (entitySeedEntries.length > 0) {
    diagnostics.multi_seed_fan_in_distinct_seeds = entitySeedEntries.length;
    const perSeedCandidates: Map<string, GraphExpansionCandidateDraft>[] = [];
    for (const seedEntry of entitySeedEntries) {
      const seedMap = new Map<string, GraphExpansionCandidateDraft>();
      await expandGraphFrontier({
        workspaceId: params.workspaceId,
        byId: params.byId,
        pathExpansionPort,
        seedEntries: [seedEntry],
        maxGraphHops: params.maxGraphHops,
        dynamicRecallEdgeFanout: params.dynamicRecallEdgeFanout,
        warn: params.warn,
        onCandidate: (candidate) => {
          const current = seedMap.get(candidate.entry.object_id);
          if (current === undefined || shouldReplaceGraphExpansionCandidate(candidate, current)) {
            seedMap.set(candidate.entry.object_id, candidate);
          }
        }
      });
      diagnostics.multi_seed_fan_in_candidates_per_seed.push(seedMap.size);
      perSeedCandidates.push(seedMap);
    }
    const fanInSeen = new Set<string>();
    for (const seedMap of perSeedCandidates) {
      for (const [neighborId, candidate] of seedMap) {
        if (fanInSeen.has(neighborId)) {
          diagnostics.multi_seed_fan_in_dedup_collisions += 1;
        }
        fanInSeen.add(neighborId);
        const current = bestCandidates.get(neighborId);
        if (current === undefined || shouldReplaceGraphExpansionCandidate(candidate, current)) {
          bestCandidates.set(neighborId, candidate);
        }
      }
    }
  }

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

  return freezeGraphExpansionCandidatesResult(diagnostics, candidateSources);
}

async function expandGraphFrontier(params: Readonly<{
  readonly workspaceId: string;
  readonly byId: ReadonlyMap<string, Readonly<MemoryEntry>>;
  readonly pathExpansionPort: NonNullable<RecallServiceDependencies["pathExpansionPort"]>;
  readonly seedEntries: readonly Readonly<MemoryEntry>[];
  readonly maxGraphHops: number;
  readonly dynamicRecallEdgeFanout: number;
  readonly warn: RecallServiceWarnPort;
  readonly onCandidate: (candidate: Readonly<GraphExpansionCandidateDraft>) => void;
}>): Promise<void> {
  if (params.seedEntries.length === 0) {
    return;
  }
  const expandedIds = new Set<string>();
  let frontier: readonly GraphExpansionFrontierNode[] = params.seedEntries.map((entry) => ({
    memoryId: entry.object_id,
    pathScore: 1,
    arrivalRelationKind: null
  }));

  for (let hop = 1; hop <= params.maxGraphHops && frontier.length > 0; hop += 1) {
    const nextFrontier = new Map<string, GraphExpansionFrontierNode>();
    const frontierIds = frontier
      .map((node) => node.memoryId)
      .filter((memoryId) => !expandedIds.has(memoryId));
    if (frontierIds.length === 0) {
      break;
    }
    const anchorRefs: PathAnchorRef[] = frontierIds.map((memoryId) => ({
      kind: "object",
      object_id: memoryId
    }));
    let paths: readonly Readonly<PathRelation>[];
    try {
      paths = await params.pathExpansionPort.findByAnchors(params.workspaceId, anchorRefs);
    } catch (error) {
      params.warn("graph expansion path lookup failed", {
        workspace_id: params.workspaceId,
        seed_count: frontierIds.length,
        error: toErrorMessage(error)
      });
      break;
    }
    const eligiblePaths = paths.filter((path) => isPathRecallEligible(path));
    const frontierIdSet = new Set(frontierIds);
    for (const node of frontier) {
      if (expandedIds.has(node.memoryId)) {
        continue;
      }
      expandedIds.add(node.memoryId);
      const nodeNeighbors = collectPathGraphNeighbors(eligiblePaths, node.memoryId)
        .slice(0, params.dynamicRecallEdgeFanout);
      for (const neighbor of nodeNeighbors) {
        const edgeScore = graphTraversalScoreFromPath(neighbor.edgeType);
        if (edgeScore <= 0) {
          continue;
        }
        const neighborId = neighbor.neighborId;
        if (expandedIds.has(neighborId)) {
          continue;
        }
        const entry = params.byId.get(neighborId);
        if (entry === undefined) {
          continue;
        }
        if (
          hop > 1 &&
          node.arrivalRelationKind !== null &&
          neighbor.relationKind === node.arrivalRelationKind
        ) {
          continue;
        }
        const candidateScore = hop === 1
          ? edgeScore
          : clamp01(node.pathScore * EDGE_TYPE_HOP_DECAY[neighbor.edgeType] * edgeScore);
        if (candidateScore <= 0) {
          continue;
        }
        params.onCandidate({
          entry,
          score: candidateScore,
          hop: hop as 1 | 2,
          edgeType: neighbor.edgeType
        });
        if (hop < params.maxGraphHops && !expandedIds.has(neighborId) && !frontierIdSet.has(neighborId)) {
          const queued = nextFrontier.get(neighborId);
          if (queued === undefined || candidateScore > queued.pathScore) {
            nextFrontier.set(neighborId, {
              memoryId: neighborId,
              pathScore: candidateScore,
              arrivalRelationKind: neighbor.relationKind
            });
          }
        }
      }
    }
    frontier = [...nextFrontier.values()].sort((a, b) => a.memoryId.localeCompare(b.memoryId));
  }
}
