import type { MemoryEntry, ProjectMappingAnchor, RecallPolicy } from "@do-soul/alaya-protocol";
import { compareMemoryEntries } from "../runtime/recall-service-helpers.js";
import { selectBoundedTopK } from "./selection/bounded-top-k.js";
import type { RecallQueryProbes } from "../query/recall-query-probes.js";
import type { RunCoarseFilterContext } from "./coarse-filter.js";
import type { CoarseFilterRunResult } from "./coarse-filter-result.js";
import { buildCoarseFilterResult } from "./coarse-filter-result.js";
import type { AddCoarseCandidate } from "./coarse-filter-admission.js";
import { createCoarseCandidateAdder } from "./coarse-filter-admission.js";
import { addContentDerivedExpansionCandidates } from "../expansion/content-expansion.js";
import { addSourceProximityCandidates } from "../expansion/source-proximity-expansion.js";
import {
  addGraphExpansionCandidates,
  collectEntityDerivedSeeds
} from "../expansion/structural-expansion.js";
import {
  addPathExpansionCandidates,
  collectNegativePathSuppressions
} from "../expansion/path-expansion.js";
import {
  addSemanticSupplementCandidates
} from "./coarse-filter-semantic.js";
import { classifyRecallIntent, extractRecallAnchors } from "../query/recall-query-plan.js";
import {
  ENTITY_GRAPH_EXPANSION_CONFIDENCE_FLOOR,
  resolveSourceProximityAdmissionLimit,
  scoreObjectProbeMatch,
  selectExpansionSeedDrafts,
  type CoarseCandidateDraft
} from "./coarse-candidates.js";
import {
  createEmptyGraphExpansionDiagnostics,
  type GraphExpansionCandidateSourceDiagnostic
} from "../expansion/graph-expansion.js";
import type { RecallGraphExpansionDiagnostics } from "../runtime/recall-service-types.js";

const DYNAMIC_RECALL_PLANE_CAP = 240;
const ENTITY_EXTRACTION_MAX_ENTITIES = 8;
const ENTITY_SEED_PER_ENTITY_TOP_K_STRONG = 8;
const ENTITY_SEED_PER_ENTITY_TOP_K_WEAK = 5;
const ENTITY_SEED_TOTAL_ADMIT_CAP = 60;
const ENTITY_SEED_MIN_SURFACE_LENGTH = 2;
const DYNAMIC_RECALL_COHORT_RADIUS = 8;
const DYNAMIC_RECALL_EDGE_FANOUT = 12;
const MAX_GRAPH_HOPS = 2;
const MULTI_SEED_GRAPH_FAN_OUT_CAP = DYNAMIC_RECALL_PLANE_CAP;

export interface CoarseFilterState {
  readonly drafts: Map<string, CoarseCandidateDraft>;
  readonly ftsRanks: Map<string, number>;
  readonly trigramFtsRanks: Map<string, number>;
  readonly evidenceFtsRanks: Map<string, number>;
  readonly evidenceFtsRanksPerRef: Map<string, number>;
  readonly sourceProximityScores: Map<string, number>;
  readonly structuralScores: Map<string, number>;
  readonly graphExpansionScores: Map<string, number>;
  readonly entitySeedScores: Map<string, number>;
  readonly pathExpansionScores: Map<string, number>;
  readonly pathSuppressionScores: Map<string, number>;
  readonly addCandidate: AddCoarseCandidate;
}

export interface DynamicCoarseFilterResult {
  readonly sourceCohortKeys: Readonly<Record<string, string>>;
  readonly graphExpansionDiagnostics: Readonly<RecallGraphExpansionDiagnostics>;
  readonly graphExpansionCandidateSources: ReadonlyMap<string, Readonly<GraphExpansionCandidateSourceDiagnostic>>;
}

export function createCoarseFilterState(params: Readonly<{
  readonly config: Readonly<RecallPolicy>["coarse_filter"];
  readonly winnerMemoryIds: ReadonlySet<string>;
}>): CoarseFilterState {
  const state = {
    drafts: new Map<string, CoarseCandidateDraft>(),
    ftsRanks: new Map<string, number>(),
    trigramFtsRanks: new Map<string, number>(),
    evidenceFtsRanks: new Map<string, number>(),
    evidenceFtsRanksPerRef: new Map<string, number>(),
    sourceProximityScores: new Map<string, number>(),
    structuralScores: new Map<string, number>(),
    graphExpansionScores: new Map<string, number>(),
    entitySeedScores: new Map<string, number>(),
    pathExpansionScores: new Map<string, number>(),
    pathSuppressionScores: new Map<string, number>()
  };
  return Object.freeze({
    ...state,
    addCandidate: createCoarseCandidateAdder({
      ...state,
      winnerMemoryIds: params.winnerMemoryIds,
      config: params.config
    })
  });
}

export function admitInitialCoarseCandidates(params: Readonly<{
  readonly tierMemories: readonly Readonly<MemoryEntry>[];
  readonly protectedCandidates: readonly Readonly<MemoryEntry>[];
  readonly rankedMatches: readonly Readonly<MemoryEntry>[];
  readonly queryProbes: Readonly<RecallQueryProbes>;
  readonly state: CoarseFilterState;
}>): void {
  for (const entry of params.protectedCandidates.slice().sort(compareMemoryEntries)) {
    params.state.addCandidate(entry, "protected_winner", 1, "protected_winner");
  }
  for (const entry of params.rankedMatches) {
    params.state.addCandidate(entry, "activation", 0, "activation");
  }
  addObjectProbeCandidates(params.tierMemories, params.queryProbes, params.state.addCandidate);
}

export async function admitDynamicCoarseCandidates(params: Readonly<{
  readonly context: RunCoarseFilterContext;
  readonly workspaceId: string;
  readonly config: Readonly<RecallPolicy>["coarse_filter"];
  readonly queryText: string | null;
  readonly queryProbes: Readonly<RecallQueryProbes>;
  readonly tier: MemoryEntry["storage_tier"];
  readonly tierMemories: readonly Readonly<MemoryEntry>[];
  readonly tierScopedSearchEligible: boolean;
  readonly byId: ReadonlyMap<string, Readonly<MemoryEntry>>;
  readonly deliveryMaxEntries?: number;
  readonly pathProjectionAsOf?: string;
  readonly state: CoarseFilterState;
}>): Promise<DynamicCoarseFilterResult> {
  await admitSemanticAndContentCandidates(params);
  const sourceCohortKeys = await admitSourceProximityCandidates(params);
  const graphExpansionSeedIds = await collectGraphExpansionSeedIds(params);
  const graphResult = await admitPathAndGraphExpansionCandidates(params, graphExpansionSeedIds);
  await collectNegativePathSuppressions({
    workspaceId: params.workspaceId,
    byId: params.byId,
    drafts: params.state.drafts,
    suppressionScores: params.state.pathSuppressionScores,
    pathExpansionPort: params.context.dependencies.pathExpansionPort,
    pathProjectionAsOf: params.pathProjectionAsOf,
    warn: params.context.warn,
    degradationReasons: params.context.degradationReasons
  });
  return Object.freeze({
    sourceCohortKeys,
    graphExpansionDiagnostics: graphResult.diagnostics,
    graphExpansionCandidateSources: graphResult.candidateSources
  });
}

export function buildCoarseFilterRunResult(params: Readonly<{
  readonly tierMemories: readonly Readonly<MemoryEntry>[];
  readonly projectMappings: readonly Readonly<ProjectMappingAnchor>[];
  readonly context: RunCoarseFilterContext;
  readonly sourceChannel?: string;
  readonly scoreMultiplier?: number;
  readonly state: CoarseFilterState;
  readonly dynamic: DynamicCoarseFilterResult;
}>): CoarseFilterRunResult {
  return buildCoarseFilterResult({
    totalScanned: params.tierMemories.length,
    drafts: params.state.drafts,
    projectMappings: params.projectMappings,
    dependencies: params.context.dependencies,
    sourceChannel: params.sourceChannel,
    scoreMultiplier: params.scoreMultiplier,
    ftsRanks: params.state.ftsRanks,
    trigramFtsRanks: params.state.trigramFtsRanks,
    evidenceFtsRanks: params.state.evidenceFtsRanks,
    evidenceFtsRanksPerRef: params.state.evidenceFtsRanksPerRef,
    sourceProximityScores: params.state.sourceProximityScores,
    sourceCohortKeys: params.dynamic.sourceCohortKeys,
    structuralScores: params.state.structuralScores,
    graphExpansionScores: params.state.graphExpansionScores,
    graphExpansionDiagnostics: params.dynamic.graphExpansionDiagnostics,
    graphExpansionCandidateSources: params.dynamic.graphExpansionCandidateSources,
    entitySeedScores: params.state.entitySeedScores,
    pathExpansionScores: params.state.pathExpansionScores,
    pathSuppressionScores: params.state.pathSuppressionScores
  });
}

function addObjectProbeCandidates(
  tierMemories: readonly Readonly<MemoryEntry>[],
  queryProbes: Readonly<RecallQueryProbes>,
  addCandidate: AddCoarseCandidate
): void {
  const scoredCandidates = tierMemories
    .map((entry) => Object.freeze({ entry, score: scoreObjectProbeMatch(entry, queryProbes) }))
    .filter((candidate) => candidate.score > 0);
  const objectProbeCandidates = selectBoundedTopK(
    scoredCandidates,
    DYNAMIC_RECALL_PLANE_CAP,
    (left, right) =>
      right.score === left.score
        ? compareMemoryEntries(left.entry, right.entry)
      : right.score - left.score
  );
  for (const candidate of objectProbeCandidates) {
    addCandidate(candidate.entry, "object_probe", candidate.score, "object_probe");
  }
}

async function admitSemanticAndContentCandidates(
  params: Parameters<typeof admitDynamicCoarseCandidates>[0]
): Promise<void> {
  await addSemanticSupplementCandidates({
    context: params.context,
    workspaceId: params.workspaceId,
    config: params.config,
    queryText: params.queryText,
    queryProbes: params.queryProbes,
    tier: params.tier,
    tierScopedSearchEligible: params.tierScopedSearchEligible,
    anchors: extractRecallAnchors(params.queryProbes),
    intent: classifyRecallIntent(params.queryProbes),
    byId: params.byId,
    addCandidate: params.state.addCandidate,
    ftsRanks: params.state.ftsRanks,
    trigramFtsRanks: params.state.trigramFtsRanks,
    evidenceFtsRanks: params.state.evidenceFtsRanks,
    evidenceFtsRanksPerRef: params.state.evidenceFtsRanksPerRef
  });
  addContentDerivedExpansionCandidates({
    tierMemories: params.tierMemories,
    drafts: params.state.drafts,
    queryProbes: params.queryProbes,
    addCandidate: params.state.addCandidate,
    dynamicRecallPlaneCap: DYNAMIC_RECALL_PLANE_CAP,
    dynamicRecallCohortRadius: DYNAMIC_RECALL_COHORT_RADIUS
  });
}

async function admitSourceProximityCandidates(
  params: Parameters<typeof admitDynamicCoarseCandidates>[0]
): Promise<Readonly<Record<string, string>>> {
  return addSourceProximityCandidates({
    workspaceId: params.workspaceId,
    tierMemories: params.tierMemories,
    drafts: params.state.drafts,
    addCandidate: params.state.addCandidate,
    admissionLimit: resolveSourceProximityAdmissionLimit(params.deliveryMaxEntries),
    evidenceSearchPort: params.context.dependencies.evidenceSearchPort,
    robustSourceRefParsing: params.context.dependencies.robustSourceRefParsing ?? false,
    warn: params.context.warn
  });
}

async function collectGraphExpansionSeedIds(
  params: Parameters<typeof admitDynamicCoarseCandidates>[0]
): Promise<readonly string[]> {
  const entityDerivedSeeds = await collectEntityDerivedSeeds({
    workspaceId: params.workspaceId,
    queryText: params.queryText,
    byId: params.byId,
    addCandidate: params.state.addCandidate,
    lexicalFtsRanks: params.state.ftsRanks,
    entityExtractionPort: params.context.dependencies.entityExtractionPort,
    memoryRepo: params.context.dependencies.memoryRepo,
    warn: params.context.warn,
    entityExtractionMaxEntities: ENTITY_EXTRACTION_MAX_ENTITIES,
    entitySeedPerEntityTopKStrong: ENTITY_SEED_PER_ENTITY_TOP_K_STRONG,
    entitySeedPerEntityTopKWeak: ENTITY_SEED_PER_ENTITY_TOP_K_WEAK,
    entitySeedTotalAdmitCap: ENTITY_SEED_TOTAL_ADMIT_CAP,
    entitySeedMinSurfaceLength: ENTITY_SEED_MIN_SURFACE_LENGTH
  });
  return entityDerivedSeeds
    .filter((seed) => seed.entityConfidence >= ENTITY_GRAPH_EXPANSION_CONFIDENCE_FLOOR)
    .map((seed) => seed.memoryId);
}

async function admitPathAndGraphExpansionCandidates(
  params: Parameters<typeof admitDynamicCoarseCandidates>[0],
  graphExpansionSeedIds: readonly string[]
): Promise<Readonly<{
  readonly diagnostics: Readonly<RecallGraphExpansionDiagnostics>;
  readonly candidateSources: ReadonlyMap<string, Readonly<GraphExpansionCandidateSourceDiagnostic>>;
}>> {
  const prePathGraphSeedIds = selectExpansionSeedDrafts(params.state.drafts)
    .map((draft) => draft.entry.object_id);
  await addPathExpansionCandidates({
    workspaceId: params.workspaceId,
    byId: params.byId,
    drafts: params.state.drafts,
    queryProbes: params.queryProbes,
    addCandidate: params.state.addCandidate,
    dynamicRecallPlaneCap: DYNAMIC_RECALL_PLANE_CAP,
    pathExpansionPort: params.context.dependencies.pathExpansionPort,
    pathProjectionAsOf: params.pathProjectionAsOf,
    warn: params.context.warn,
    degradationReasons: params.context.degradationReasons
  });
  if (params.context.dependencies.pathExpansionPort === undefined) {
    return Object.freeze({
      diagnostics: createEmptyGraphExpansionDiagnostics(),
      candidateSources: new Map()
    });
  }
  return addGraphExpansionCandidates({
    workspaceId: params.workspaceId,
    byId: params.byId,
    drafts: params.state.drafts,
    addCandidate: params.state.addCandidate,
    pathExpansionPort: params.context.dependencies.pathExpansionPort,
    pathProjectionAsOf: params.pathProjectionAsOf,
    extraSeedMemoryIds: graphExpansionSeedIds,
    draftSeedIds: prePathGraphSeedIds,
    maxGraphHops: MAX_GRAPH_HOPS,
    dynamicRecallEdgeFanout: DYNAMIC_RECALL_EDGE_FANOUT,
    multiSeedGraphFanOutCap: MULTI_SEED_GRAPH_FAN_OUT_CAP,
    warn: params.context.warn,
    degradationReasons: params.context.degradationReasons
  });
}
