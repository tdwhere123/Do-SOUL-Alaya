import { performance } from "node:perf_hooks";
import {
  type ProjectMappingAnchor,
  type RecallPolicy,
  type StorageTier
} from "@do-soul/alaya-protocol";
import { runCoarseFilter } from "../coarse-filter/coarse-filter.js";
import { loadGlobalRecallCandidates } from "./global-memory-recall-service.js";
import {
  expandTierCascade,
  mergeCoarseFilters,
  recordGlobalRecallClassificationsSafely
} from "./orchestration.js";
import { type RecallQueryProbes } from "../query/recall-query-probes.js";
import {
  classifyGlobalCandidate,
  buildRecallLogicalObjectKey,
  entryMatchesTimeFilter,
  getGlobalRecallLimit,
  isWorkspaceMemoryCandidate,
  matchesConfiguredCoarseFilter,
  type RecallTimeFilter
} from "./recall-service-helpers.js";
import type { CoarseRecallCandidate } from "./recall-service-types.js";
import { uniqueStrings } from "../expansion/path-relations.js";
import { uniquePlanes } from "../coarse-filter/coarse-candidates.js";
import type {
  PreparedRecallRequest,
  RecallExecutionContext,
  RecallExecutionParams
} from "./recall-service-runner.js";
import {
  collectEmbeddingCoarseInjection,
  collectSynthesisCoarseCandidates
} from "../supplements/supplements.js";
import {
  settle,
  throwFirstRejected,
  unwrapSettled
} from "./settle-parallel.js";

export type CoarseFilterResult = Awaited<ReturnType<typeof runCoarseFilter>>;
export type EmbeddingCoarseInjectionResult = Awaited<ReturnType<typeof collectEmbeddingCoarseInjection>>;
type SynthesisCoarseResult = Awaited<ReturnType<typeof collectSynthesisCoarseCandidates>>;
type CoarseFilterOptions = Readonly<{
  readonly tier?: StorageTier;
  readonly projectMappings?: readonly Readonly<ProjectMappingAnchor>[];
  readonly sourceChannel?: string;
  readonly scoreMultiplier?: number;
  readonly timeFilter?: RecallTimeFilter;
  readonly queryProbes?: Readonly<RecallQueryProbes>;
  readonly winnerMemoryIds?: ReadonlySet<string>;
  readonly deliveryMaxEntries?: number;
}>;

export interface CoarseStageResult {
  readonly recallPhaseStart: number;
  readonly recallAfterCoarse: number;
  readonly recallAfterSynthesis: number;
  readonly recallAfterEmbedding: number;
  readonly coarseFilter: CoarseFilterResult;
  readonly globalCoarseFilter: Awaited<ReturnType<typeof loadGlobalRecallCandidates>>;
  readonly globalRecallClassifications: Parameters<typeof recordGlobalRecallClassificationsSafely>[0]["classifications"];
  readonly combinedCoarseCandidates: readonly Readonly<CoarseRecallCandidate>[];
  readonly embeddingCoarseInjection: EmbeddingCoarseInjectionResult;
}

export async function collectCoarseStage(
  context: RecallExecutionContext,
  params: RecallExecutionParams,
  prepared: PreparedRecallRequest
): Promise<CoarseStageResult> {
  const recallPhaseStart = performance.now();
  const hotCoarseFilter = await collectHotCoarseFilter(context, params, prepared);
  const globalPromise = settle(collectGlobalCoarseFilter(context, params, prepared));
  const coarseFilterPromise = settle(collectExpandedCoarseFilter(context, params, prepared, hotCoarseFilter));
  const synthesisPromise = settle(collectSynthesisStage(context, params, prepared));
  const [globalResult, coarseFilterResult] = await Promise.all([globalPromise, coarseFilterPromise]);
  throwFirstRejected([globalResult, coarseFilterResult]);
  const global = unwrapSettled(globalResult);
  const coarseFilter = unwrapSettled(coarseFilterResult);
  const recallAfterCoarse = performance.now();
  const synthesisCoarseFilter = unwrapSettled(await synthesisPromise);
  const recallAfterSynthesis = performance.now();
  const lexicalCoarseCandidates = mergeLexicalCoarseCandidates(coarseFilter, global.filteredCandidates, synthesisCoarseFilter);
  const embeddingCoarseInjection = await collectEmbeddingInjection(context, params, prepared, lexicalCoarseCandidates);
  const recallAfterEmbedding = performance.now();
  return Object.freeze({
    recallPhaseStart,
    recallAfterCoarse,
    recallAfterSynthesis,
    recallAfterEmbedding,
    coarseFilter: Object.freeze({ ...coarseFilter, synthesisFtsRanks: synthesisCoarseFilter.synthesisFtsRanks }),
    globalCoarseFilter: global.raw,
    globalRecallClassifications: global.classifications,
    combinedCoarseCandidates: combineEmbeddingInjection(lexicalCoarseCandidates, embeddingCoarseInjection.candidates),
    embeddingCoarseInjection
  });
}


async function collectHotCoarseFilter(
  context: RecallExecutionContext,
  params: RecallExecutionParams,
  prepared: PreparedRecallRequest
): Promise<CoarseFilterResult> {
  return collectCoarseFilter(context, params.workspaceId, prepared.policy.coarse_filter, prepared.queryText, {
    timeFilter: params.timeFilter,
    queryProbes: prepared.queryProbes,
    winnerMemoryIds: prepared.winnerMemoryIds,
    deliveryMaxEntries: prepared.policy.fine_assessment.budgets.max_entries
  });
}

async function collectExpandedCoarseFilter(
  context: RecallExecutionContext,
  params: RecallExecutionParams,
  prepared: PreparedRecallRequest,
  hotCoarseFilter: CoarseFilterResult
): Promise<CoarseFilterResult> {
  return expandTierCascade({
    coarseFilter: (workspaceId, config, queryText, options) => collectCoarseFilter(context, workspaceId, config, queryText, options),
    projectMappingPort: context.dependencies.projectMappingPort,
    mergeCoarseFilters,
    workspaceId: params.workspaceId,
    runId: params.runId ?? null,
    config: prepared.policy.coarse_filter,
    fineAssessmentConfig: prepared.policy.fine_assessment,
    queryText: prepared.queryText,
    queryProbes: prepared.queryProbes,
    hotCoarseFilter,
    hotCoarseCandidateCount: hotCoarseFilter.candidates.length,
    winnerMemoryIds: prepared.winnerMemoryIds,
    timeFilter: params.timeFilter,
    warn: context.warn
  });
}

async function collectGlobalCoarseFilter(
  context: RecallExecutionContext,
  params: RecallExecutionParams,
  prepared: PreparedRecallRequest
): Promise<Readonly<{
  readonly raw: Awaited<ReturnType<typeof loadGlobalRecallCandidates>>;
  readonly filteredCandidates: readonly Readonly<CoarseRecallCandidate>[];
  readonly classifications: Parameters<typeof recordGlobalRecallClassificationsSafely>[0]["classifications"];
}>> {
  const raw = await loadGlobalRecallCandidates({
    workspaceId: params.workspaceId,
    queryText: prepared.queryText,
    limit: getGlobalRecallLimit(prepared.policy),
    createdBy: "system",
    globalRecallPort: context.dependencies.globalRecallPort,
    projectMappingPort: context.dependencies.projectMappingPort,
    classifyGlobalCandidate,
    timeFilter: params.timeFilter,
    entryMatchesTimeFilter
  });
  return Object.freeze({
    raw,
    filteredCandidates: filterGlobalCandidates(raw, prepared.policy),
    classifications: classifyGlobalRecords(raw, params.workspaceId, prepared.policy)
  });
}

function filterGlobalCandidates(
  raw: Awaited<ReturnType<typeof loadGlobalRecallCandidates>>,
  policy: Readonly<RecallPolicy>
): readonly Readonly<CoarseRecallCandidate>[] {
  return raw.records.flatMap((record) => {
    if (record.candidate === null) {
      return [];
    }
    return matchesConfiguredCoarseFilter(record.candidate.entry, policy.coarse_filter) ? [record.candidate] : [];
  });
}

function classifyGlobalRecords(
  raw: Awaited<ReturnType<typeof loadGlobalRecallCandidates>>,
  workspaceId: string,
  policy: Readonly<RecallPolicy>
): Parameters<typeof recordGlobalRecallClassificationsSafely>[0]["classifications"] {
  return raw.records.map((record) => Object.freeze({
    workspaceId,
    globalObjectId: record.globalObjectId,
    classification: record.candidate !== null && matchesConfiguredCoarseFilter(record.candidate.entry, policy.coarse_filter)
      ? "included" as const
      : "excluded" as const
  }));
}

async function collectSynthesisStage(
  context: RecallExecutionContext,
  params: RecallExecutionParams,
  prepared: PreparedRecallRequest
): Promise<SynthesisCoarseResult> {
  return collectSynthesisCoarseCandidates({
    dependencies: context.dependencies,
    warn: context.warn,
    workspaceId: params.workspaceId,
    queryText: prepared.queryText,
    queryProbes: prepared.queryProbes,
    policy: prepared.policy,
    degradationReasons: context.degradationReasons
  });
}

async function collectEmbeddingInjection(
  context: RecallExecutionContext,
  params: RecallExecutionParams,
  prepared: PreparedRecallRequest,
  lexicalCoarseCandidates: readonly Readonly<CoarseRecallCandidate>[]
): Promise<EmbeddingCoarseInjectionResult> {
  return collectEmbeddingCoarseInjection({
    dependencies: context.dependencies,
    warn: context.warn,
    policy: prepared.policy,
    workspaceId: params.workspaceId,
    runId: params.runId ?? null,
    queryText: prepared.queryText,
    poolCandidates: lexicalCoarseCandidates,
    degradationReasons: context.degradationReasons
  });
}

function mergeLexicalCoarseCandidates(
  coarseFilter: CoarseFilterResult,
  globalCandidates: readonly Readonly<CoarseRecallCandidate>[],
  synthesisCoarseFilter: SynthesisCoarseResult
): readonly Readonly<CoarseRecallCandidate>[] {
  return mergeCoarseCandidateMetadata([
    ...coarseFilter.candidates,
    ...globalCandidates,
    ...synthesisCoarseFilter.candidates
  ]);
}

function mergeCoarseCandidateMetadata(
  candidates: readonly Readonly<CoarseRecallCandidate>[]
): readonly Readonly<CoarseRecallCandidate>[] {
  const byKey = new Map<string, Readonly<CoarseRecallCandidate>>();
  for (const candidate of candidates) {
    const key = buildRecallLogicalObjectKey(candidate);
    byKey.set(key, mergeCoarseCandidatePair(byKey.get(key), candidate));
  }
  return Object.freeze([...byKey.values()]);
}

function mergeCoarseCandidatePair(
  current: Readonly<CoarseRecallCandidate> | undefined,
  next: Readonly<CoarseRecallCandidate>
): Readonly<CoarseRecallCandidate> {
  if (current === undefined) {
    return next;
  }
  const [representative, supplementary] = orderCoarseMergePair(current, next);
  const sourceChannel = representative.sourceChannel ??
    representative.sourceChannels?.[0] ?? supplementary.sourceChannel;
  const firstAdmissionPlane = representative.firstAdmissionPlane ??
    representative.admissionPlanes?.[0] ?? supplementary.firstAdmissionPlane;
  return Object.freeze({
    ...representative,
    sourceChannels: uniqueStrings([
      ...(representative.sourceChannels ?? []),
      ...(supplementary.sourceChannels ?? []),
      ...collectOriginProvenance(representative, supplementary)
    ]),
    admissionPlanes: uniquePlanes([
      ...(representative.admissionPlanes ?? []),
      ...(supplementary.admissionPlanes ?? [])
    ]),
    structuralScore: Math.max(
      representative.structuralScore ?? 0,
      supplementary.structuralScore ?? 0
    ),
    pathExpansionSources: Object.freeze([
      ...(representative.pathExpansionSources ?? []),
      ...(supplementary.pathExpansionSources ?? [])
    ]),
    ...(sourceChannel === undefined ? {} : { sourceChannel }),
    ...(firstAdmissionPlane === undefined ? {} : { firstAdmissionPlane })
  });
}

function orderCoarseMergePair(
  current: Readonly<CoarseRecallCandidate>,
  next: Readonly<CoarseRecallCandidate>
): readonly [Readonly<CoarseRecallCandidate>, Readonly<CoarseRecallCandidate>] {
  return isWorkspaceMemoryCandidate(next) && !isWorkspaceMemoryCandidate(current)
    ? [next, current]
    : [current, next];
}

function collectOriginProvenance(
  current: Readonly<CoarseRecallCandidate>,
  next: Readonly<CoarseRecallCandidate>
): readonly string[] {
  return [current.originPlane, next.originPlane].filter(
    (origin): origin is NonNullable<CoarseRecallCandidate["originPlane"]> => origin !== undefined
  );
}

function combineEmbeddingInjection(
  lexicalCandidates: readonly Readonly<CoarseRecallCandidate>[],
  injectedCandidates: readonly Readonly<CoarseRecallCandidate>[]
): readonly Readonly<CoarseRecallCandidate>[] {
  return injectedCandidates.length === 0
    ? lexicalCandidates
    : mergeCoarseCandidateMetadata([...lexicalCandidates, ...injectedCandidates]);
}

function collectCoarseFilter(
  context: RecallExecutionContext,
  workspaceId: string,
  config: Readonly<RecallPolicy>["coarse_filter"],
  queryText: string | null,
  options: CoarseFilterOptions = {}
): ReturnType<typeof runCoarseFilter> {
  return runCoarseFilter({ dependencies: context.dependencies, warn: context.warn }, workspaceId, config, queryText, options);
}
