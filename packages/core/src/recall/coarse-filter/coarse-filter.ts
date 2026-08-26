import {
  StorageTier,
  type MemoryEntry,
  type ProjectMappingAnchor,
  type RecallPolicy
} from "@do-soul/alaya-protocol";
import { compileRecallQueryProbes, type RecallQueryProbes } from "../query/recall-query-probes.js";
import {
  filterMemoriesByTimeWindow,
  matchesDeterministicFilter,
  toErrorMessage,
  type RecallTimeFilter
} from "../runtime/recall-service-helpers.js";
import type {
  RecallDegradationReason,
  RecallServiceDependencies,
  RecallServiceWarnPort
} from "../runtime/recall-service-types.js";
import {
  type CoarseFilterRunResult
} from "./coarse-filter-result.js";
import { loadTierMemoriesForRecall } from
  "./pagination/recall-tier-memory-loader.js";
import {
  canUseSqlActivationAdmissionTopK,
  loadActivationAdmissionTopK
} from "./selection/activation-admission-top-k.js";
import {
  admitDynamicCoarseCandidates,
  admitInitialCoarseCandidates,
  buildCoarseFilterRunResult,
  createCoarseFilterState
} from "./coarse-filter-pipeline.js";
import {
  createTemporalWindowCandidateBudget,
  type TemporalWindowCandidateBudget
} from
  "./temporal/temporal-window-candidates.js";
import {
  captureRecallQueryEntities,
  type RecallQueryEntityExtractionCapture
} from "../field/query-entity-attribution-producer.js";
import {
  createRecallRetrievalFieldBundle,
  type RecallRetrievalFieldBundle
} from
  "../field/retrieval/retrieval-field-bundle.js";

export interface RunCoarseFilterContext {
  readonly dependencies: RecallServiceDependencies;
  readonly warn: RecallServiceWarnPort;
  readonly degradationReasons?: Set<RecallDegradationReason>;
}

export interface RunCoarseFilterOptions {
  readonly tier?: StorageTier;
  readonly projectMappings?: readonly Readonly<ProjectMappingAnchor>[];
  readonly sourceChannel?: string;
  readonly scoreMultiplier?: number;
  readonly timeFilter?: RecallTimeFilter;
  readonly queryProbes?: Readonly<RecallQueryProbes>;
  readonly winnerMemoryIds?: ReadonlySet<string>;
  readonly deliveryMaxEntries?: number;
  readonly temporalCandidateBudget?: TemporalWindowCandidateBudget;
  readonly referenceTime?: string;
  readonly pathProjectionAsOf?: string;
  readonly queryEntityExtraction?: Readonly<RecallQueryEntityExtractionCapture>;
  readonly retrievalFieldBundle?: Readonly<RecallRetrievalFieldBundle>;
}

interface CoarseFilterInput {
  readonly tier: StorageTier;
  readonly tierMemories: readonly Readonly<MemoryEntry>[];
  readonly tierScopedSearchEligible: boolean;
  readonly projectMappings: readonly Readonly<ProjectMappingAnchor>[];
  readonly byId: ReadonlyMap<string, Readonly<MemoryEntry>>;
  readonly queryProbes: Readonly<RecallQueryProbes>;
  readonly winnerMemoryIds: ReadonlySet<string>;
  readonly protectedCandidates: readonly Readonly<MemoryEntry>[];
  readonly rankedMatches: readonly Readonly<MemoryEntry>[];
}

export async function runCoarseFilter(
  context: RunCoarseFilterContext,
  workspaceId: string,
  config: Readonly<RecallPolicy>["coarse_filter"],
  queryText: string | null,
  options: Readonly<RunCoarseFilterOptions> = {}
): Promise<CoarseFilterRunResult> {
  const input = await loadCoarseFilterInput(context, workspaceId, config, queryText, options);
  const queryEntityExtraction = options.queryEntityExtraction ??
    await captureRecallQueryEntities({
      query_text: queryText,
      port: context.dependencies.entityExtractionPort,
      on_failure: (error) => context.warn("entity extraction failed", {
        workspace_id: workspaceId,
        operation: "entity_extraction",
        error: toErrorMessage(error)
      })
    });
  const queryProbes = input.queryProbes;
  const retrievalFieldBundle = options.retrievalFieldBundle ??
    createRecallRetrievalFieldBundle({
      workspaceId,
      queryText,
      memoryRepo: context.dependencies.memoryRepo,
      evidenceSearchPort: context.dependencies.evidenceSearchPort,
      synthesisSearchPort: context.dependencies.synthesisSearchPort,
      refinementMaxDepth:
        config.semantic_supplement.field_observation_max_depth,
      onFailure: (operation, error) => context.warn("retrieval field query failed", {
        workspace_id: workspaceId,
        operation,
        error: toErrorMessage(error)
      }),
      onBatchFailure: (operation, failure) => context.warn(
        "retrieval field batch query failed; using scalar field queries",
        {
          workspace_id: workspaceId,
          operation,
          ...failure
        }
      )
    });
  const state = createCoarseFilterState({ config, winnerMemoryIds: input.winnerMemoryIds });
  admitInitialCoarseCandidates({
    tierMemories: input.tierMemories,
    protectedCandidates: input.protectedCandidates,
    rankedMatches: input.rankedMatches,
    queryProbes,
    state
  });
  const dynamic = await admitDynamicCoarseCandidates({
    context,
    workspaceId,
    config,
    queryText,
    queryProbes,
    tier: input.tier,
    tierMemories: input.tierMemories,
    tierScopedSearchEligible: input.tierScopedSearchEligible,
    byId: input.byId,
    deliveryMaxEntries: options.deliveryMaxEntries,
    temporalCandidateBudget: options.temporalCandidateBudget ??
      createTemporalWindowCandidateBudget(options.deliveryMaxEntries),
    referenceTime: options.referenceTime,
    pathProjectionAsOf: options.pathProjectionAsOf,
    queryEntityExtraction,
    retrievalFieldBundle,
    state
  });
  return buildCoarseFilterRunResult({
    tierMemories: input.tierMemories,
    projectMappings: input.projectMappings,
    context,
    sourceChannel: options.sourceChannel,
    scoreMultiplier: options.scoreMultiplier,
    state,
    dynamic
  });
}

async function loadCoarseFilterInput(
  context: RunCoarseFilterContext,
  workspaceId: string,
  config: Readonly<RecallPolicy>["coarse_filter"],
  queryText: string | null,
  options: Readonly<RunCoarseFilterOptions>
): Promise<CoarseFilterInput> {
  const tier = options.tier ?? StorageTier.HOT;
  const [tierMemoryLoad, projectMappings] = await Promise.all([
    loadTierMemoriesForRecall(context, workspaceId, tier),
    options.projectMappings ?? context.dependencies.projectMappingPort?.findByWorkspace(workspaceId) ?? Promise.resolve([])
  ]);
  const tierMemories = filterMemoriesByTimeWindow(tierMemoryLoad.memories, options.timeFilter);
  const queryProbes = options.queryProbes ?? compileRecallQueryProbes(queryText);
  const winnerMemoryIds = options.winnerMemoryIds ?? new Set<string>();
  const protectedCandidates = tierMemories.filter((entry) => winnerMemoryIds.has(entry.object_id));
  const protectedIds = new Set(protectedCandidates.map((entry) => entry.object_id));
  const deterministicMatches = tierMemories.filter(
    (entry) => !protectedIds.has(entry.object_id) && matchesDeterministicFilter(entry, config)
  );
  const rankedMatches = await loadActivationAdmissionTopK({
    memoryRepo: context.dependencies.memoryRepo,
    workspaceId,
    tier,
    config,
    eligible: deterministicMatches,
    excludeObjectIds: protectedIds,
    allowSql: canUseSqlActivationAdmissionTopK(config, options.timeFilter),
    warn: context.warn
  });
  return Object.freeze({
    tier,
    tierMemories,
    tierScopedSearchEligible: tierMemoryLoad.complete && options.timeFilter === undefined,
    projectMappings,
    byId: new Map(tierMemories.map((memory) => [memory.object_id, memory])),
    queryProbes,
    winnerMemoryIds,
    protectedCandidates,
    rankedMatches
  });
}
