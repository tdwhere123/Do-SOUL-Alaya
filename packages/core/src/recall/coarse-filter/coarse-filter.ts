import {
  StorageTier,
  type MemoryEntry,
  type ProjectMappingAnchor,
  type RecallPolicy
} from "@do-soul/alaya-protocol";
import { compileRecallQueryProbes, type RecallQueryProbes } from "../query/recall-query-probes.js";
import {
  compareMemoryEntries,
  filterMemoriesByTimeWindow,
  matchesDeterministicFilter,
  matchesPrecomputedRankFilter,
  toErrorMessage,
  type RecallTimeFilter
} from "../runtime/recall-service-helpers.js";
import type {
  RecallMemoryListPageOptions,
  RecallDegradationReason,
  RecallServiceDependencies,
  RecallServiceWarnPort
} from "../runtime/recall-service-types.js";
import {
  type CoarseFilterRunResult
} from "./coarse-filter-result.js";
import {
  admitDynamicCoarseCandidates,
  admitInitialCoarseCandidates,
  buildCoarseFilterRunResult,
  createCoarseFilterState
} from "./coarse-filter-pipeline.js";
import {
  resolveRoutedSurfaceIds,
  sessionRouteEnabled,
  withRoutedSurfaceIds
} from "./session-route.js";

const RECALL_TIER_MEMORY_PAGE_SIZE = 512;
const STORAGE_RECALL_TIER_MEMORY_PAGE_SIZE = 500;
const MAX_RECALL_TIER_MEMORY_PAGES = 200;

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
}

interface CoarseFilterInput {
  readonly tierMemories: readonly Readonly<MemoryEntry>[];
  readonly projectMappings: readonly Readonly<ProjectMappingAnchor>[];
  readonly byId: ReadonlyMap<string, Readonly<MemoryEntry>>;
  readonly queryProbes: Readonly<RecallQueryProbes>;
  readonly winnerMemoryIds: ReadonlySet<string>;
  readonly protectedCandidates: readonly Readonly<MemoryEntry>[];
  readonly rankedMatches: readonly Readonly<MemoryEntry>[];
}

function buildMemoryPageSignature(
  page: readonly Readonly<MemoryEntry>[]
): string | null {
  if (page.length === 0) {
    return null;
  }
  return [
    page.length,
    page[0]?.object_id ?? "",
    page[page.length - 1]?.object_id ?? ""
  ].join(":");
}

async function loadTierMemoriesForRecall(
  context: RunCoarseFilterContext,
  workspaceId: string,
  tier: StorageTier
): Promise<readonly Readonly<MemoryEntry>[]> {
  const memories: Readonly<MemoryEntry>[] = [];
  let offset = 0;
  let pageLimit = RECALL_TIER_MEMORY_PAGE_SIZE;
  let previousPageSignature: string | null = null;
  let pagesLoaded = 0;

  for (;;) {
    const { pageMemories, effectiveLimit } = await loadTierMemoryPage(context, workspaceId, tier, {
      limit: pageLimit,
      offset
    });
    pageLimit = effectiveLimit;
    pagesLoaded += 1;
    if (hasOversizedRecallMemoryPage(pageMemories, pageLimit)) {
      warnOversizedRecallMemoryPage(context, workspaceId, tier, pageLimit, pageMemories.length);
      memories.push(...pageMemories);
      break;
    }

    const pageSignature = buildMemoryPageSignature(pageMemories);
    if (isDuplicateRecallMemoryPage(offset, pageSignature, previousPageSignature)) {
      warnDuplicateRecallMemoryPage(context, workspaceId, tier, pageLimit, offset);
      break;
    }

    memories.push(...pageMemories);
    if (pageMemories.length < pageLimit) {
      break;
    }
    if (pagesLoaded >= MAX_RECALL_TIER_MEMORY_PAGES) {
      warnMaxRecallMemoryPagesReached(context, workspaceId, tier, pageLimit, pagesLoaded, memories.length);
      break;
    }
    offset += pageMemories.length;
    previousPageSignature = pageSignature;
  }

  return Object.freeze(memories);
}

function hasOversizedRecallMemoryPage(
  pageMemories: readonly Readonly<MemoryEntry>[],
  pageLimit: number
): boolean {
  return pageMemories.length > pageLimit;
}

function warnOversizedRecallMemoryPage(
  context: RunCoarseFilterContext,
  workspaceId: string,
  tier: StorageTier,
  pageLimit: number,
  returnedCount: number
): void {
  context.warn("recall memory repo returned an oversized page", {
    workspace_id: workspaceId,
    tier,
    limit: pageLimit,
    returned_count: returnedCount
  });
}

function isDuplicateRecallMemoryPage(
  offset: number,
  pageSignature: string | null,
  previousPageSignature: string | null
): boolean {
  return offset > 0 && pageSignature !== null && pageSignature === previousPageSignature;
}

function warnDuplicateRecallMemoryPage(
  context: RunCoarseFilterContext,
  workspaceId: string,
  tier: StorageTier,
  pageLimit: number,
  offset: number
): void {
  context.warn("recall memory repo returned a duplicate page", {
    workspace_id: workspaceId,
    tier,
    limit: pageLimit,
    offset
  });
}

function warnMaxRecallMemoryPagesReached(
  context: RunCoarseFilterContext,
  workspaceId: string,
  tier: StorageTier,
  pageLimit: number,
  pagesLoaded: number,
  returnedCount: number
): void {
  context.warn("recall memory repo page scan reached the maximum page count", {
    workspace_id: workspaceId,
    tier,
    limit: pageLimit,
    pages_loaded: pagesLoaded,
    returned_count: returnedCount
  });
}

async function loadTierMemoryPage(
  context: RunCoarseFilterContext,
  workspaceId: string,
  tier: StorageTier,
  page: RecallMemoryListPageOptions
): Promise<{
  readonly pageMemories: readonly Readonly<MemoryEntry>[];
  readonly effectiveLimit: number;
}> {
  try {
    return {
      pageMemories: await context.dependencies.memoryRepo.findByWorkspaceId(workspaceId, tier, page),
      effectiveLimit: page.limit
    };
  } catch (error) {
    if (
      page.limit !== RECALL_TIER_MEMORY_PAGE_SIZE ||
      !isRepoPageLimitValidationError(error)
    ) {
      throw error;
    }
    const cappedPage = {
      limit: STORAGE_RECALL_TIER_MEMORY_PAGE_SIZE,
      offset: page.offset
    };
    context.warn("recall memory repo rejected recall page size; retrying with storage page cap", {
      workspace_id: workspaceId,
      tier,
      requested_limit: page.limit,
      retry_limit: cappedPage.limit
    });
    return {
      pageMemories: await context.dependencies.memoryRepo.findByWorkspaceId(workspaceId, tier, cappedPage),
      effectiveLimit: cappedPage.limit
    };
  }
}

function isRepoPageLimitValidationError(error: unknown): boolean {
  const code = typeof error === "object" && error !== null
    ? (error as { readonly code?: unknown }).code
    : undefined;
  return code === "VALIDATION_FAILED" && toErrorMessage(error).includes("page limit");
}


export async function runCoarseFilter(
  context: RunCoarseFilterContext,
  workspaceId: string,
  config: Readonly<RecallPolicy>["coarse_filter"],
  queryText: string | null,
  options: Readonly<RunCoarseFilterOptions> = {}
): Promise<CoarseFilterRunResult> {
  const input = await loadCoarseFilterInput(context, workspaceId, config, queryText, options);
  const queryProbes = routeQueryToSession(input.tierMemories, input.queryProbes);
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
    tierMemories: input.tierMemories,
    byId: input.byId,
    deliveryMaxEntries: options.deliveryMaxEntries,
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

function routeQueryToSession(
  tierMemories: readonly Readonly<MemoryEntry>[],
  queryProbes: Readonly<RecallQueryProbes>
): Readonly<RecallQueryProbes> {
  if (!sessionRouteEnabled()) {
    return queryProbes;
  }
  return withRoutedSurfaceIds(queryProbes, resolveRoutedSurfaceIds(tierMemories, queryProbes));
}

async function loadCoarseFilterInput(
  context: RunCoarseFilterContext,
  workspaceId: string,
  config: Readonly<RecallPolicy>["coarse_filter"],
  queryText: string | null,
  options: Readonly<RunCoarseFilterOptions>
): Promise<CoarseFilterInput> {
  const tier = options.tier ?? StorageTier.HOT;
  const [rawTierMemories, projectMappings] = await Promise.all([
    loadTierMemoriesForRecall(context, workspaceId, tier),
    options.projectMappings ?? context.dependencies.projectMappingPort?.findByWorkspace(workspaceId) ?? Promise.resolve([])
  ]);
  const tierMemories = filterMemoriesByTimeWindow(rawTierMemories, options.timeFilter);
  const queryProbes = options.queryProbes ?? compileRecallQueryProbes(queryText);
  const winnerMemoryIds = options.winnerMemoryIds ?? new Set<string>();
  const protectedCandidates = tierMemories.filter((entry) => winnerMemoryIds.has(entry.object_id));
  const protectedIds = new Set(protectedCandidates.map((entry) => entry.object_id));
  const deterministicMatches = tierMemories.filter(
    (entry) => !protectedIds.has(entry.object_id) && matchesDeterministicFilter(entry, config)
  );
  return Object.freeze({
    tierMemories,
    projectMappings,
    byId: new Map(tierMemories.map((memory) => [memory.object_id, memory])),
    queryProbes,
    winnerMemoryIds,
    protectedCandidates,
    rankedMatches: deterministicMatches
      .filter((entry) => matchesPrecomputedRankFilter(entry, config))
      .sort(compareMemoryEntries)
      .slice(0, config.precomputed_rank.max_candidates)
  });
}
