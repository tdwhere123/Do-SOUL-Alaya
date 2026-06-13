import {
  ControlPlaneObjectKind,
  RecallContextEventType,
  RetentionPolicy,
  SoulRecallWeightTransferPayloadSchema,
  StorageTier,
  type FineAssessmentConfig,
  type RecallCandidate,
  type ProjectMappingAnchor,
  type RecallPolicy,
  type TaskObjectSurface
} from "@do-soul/alaya-protocol";
import { STRATEGY_RECALL_DEFAULTS, type NodeStrategy } from "../conversation/task-surface-builder.js";
import { parseRecallPolicy } from "../shared/recall-policy.js";
import type { ManifestationBiasSidecarEntry } from "../manifestation/manifestation-resolver.js";
import { fineAssess } from "./fine-assessment.js";
import { collectSupplementaryData } from "./supplementary-data.js";
import {
  COLD_CASCADE_DECAY,
  MIN_RECALL_RESULTS,
  WARM_CASCADE_DECAY,
  buildRecallCandidateDedupeKey,
  clamp01,
  toErrorMessage,
  type RecallTimeFilter
} from "./recall-service-helpers.js";
import type { RecallQueryProbes } from "./recall-query-probes.js";
import type {
  CoarseRecallCandidate,
  RecallCandidateDiagnostic,
  RecallGraphExpansionDiagnostics,
  RecallResult,
  RecallServiceDependencies,
  RecallServiceWarnPort,
  RecallSupplementaryData,
  TokenEstimator
} from "./recall-service-types.js";
import {
  mergeGraphExpansionCandidateSources,
  mergeGraphExpansionDiagnosticsAcrossCascade,
  mergeGraphExpansionScores,
  type GraphExpansionCandidateSourceDiagnostic
} from "./graph-expansion.js";

type CoarseFilterResult = Readonly<{
  readonly total_scanned: number;
  readonly candidates: readonly Readonly<CoarseRecallCandidate>[];
  readonly ftsRanks: Readonly<Record<string, number>>;
  readonly trigramFtsRanks: Readonly<Record<string, number>>;
  readonly synthesisFtsRanks: Readonly<Record<string, number>>;
  readonly evidenceFtsRanks: Readonly<Record<string, number>>;
  readonly evidenceFtsRanksPerRef: Readonly<Record<string, number>>;
  readonly sourceProximityScores: Readonly<Record<string, number>>;
  readonly sourceCohortKeys: Readonly<Record<string, string>>;
  readonly structuralScores: Readonly<Record<string, number>>;
  readonly graphExpansionScores: Readonly<Record<string, number>>;
  readonly graphExpansionDiagnostics: Readonly<RecallGraphExpansionDiagnostics>;
  readonly graphExpansionCandidateSources: ReadonlyMap<string, Readonly<GraphExpansionCandidateSourceDiagnostic>>;
  readonly entitySeedScores: Readonly<Record<string, number>>;
  readonly pathExpansionScores: Readonly<Record<string, number>>;
  readonly pathSuppressionScores: Readonly<Record<string, number>>;
  readonly degradation_reason: RecallResult["degradation_reason"];
}>;

export function buildDefaultPolicy(params: Readonly<{
  readonly strategy: NodeStrategy;
  readonly taskSurfaceRef: string;
  readonly now: () => string;
  readonly generateRuntimeId: () => string;
  readonly defaultPolicyDecorator?: RecallServiceDependencies["defaultPolicyDecorator"];
}>): Readonly<RecallPolicy> {
  const defaults = STRATEGY_RECALL_DEFAULTS[params.strategy];
  const now = params.now();

  const base = parseRecallPolicy({
    runtime_id: params.generateRuntimeId(),
    object_kind: ControlPlaneObjectKind.RECALL_POLICY,
    task_surface_ref: params.taskSurfaceRef,
    expires_at: new Date(new Date(now).getTime() + 30 * 60 * 1000).toISOString(),
    derived_from: params.taskSurfaceRef,
    retention_policy: RetentionPolicy.SESSION_ONLY,
    coarse_filter: defaults.coarse,
    fine_assessment: defaults.fine
  });
  const decorator = params.defaultPolicyDecorator;
  return decorator === undefined ? base : parseRecallPolicy(decorator(base));
}

export function resolvePolicy(params: Readonly<{
  readonly strategy: NodeStrategy;
  readonly taskSurfaceRef: string;
  readonly policyOverride?: Readonly<RecallPolicy>;
  readonly buildDefaultPolicy: (strategy: NodeStrategy, taskSurfaceRef: string) => Readonly<RecallPolicy>;
}>): Readonly<RecallPolicy> {
  if (params.policyOverride === undefined) {
    return params.buildDefaultPolicy(params.strategy, params.taskSurfaceRef);
  }

  return parseRecallPolicy(params.policyOverride);
}

export async function loadActiveConstraints(params: Readonly<{
  readonly activeConstraintsPort?: RecallServiceDependencies["activeConstraintsPort"];
  readonly workspaceId: string;
  readonly cap: number | null;
}>): Promise<Readonly<{
  readonly constraints: RecallResult["active_constraints"];
  readonly total_count: number;
}>> {
  const port = params.activeConstraintsPort;
  if (port === undefined) {
    return Object.freeze({
      constraints: Object.freeze([]),
      total_count: 0
    });
  }
  return port.findActiveConstraints({ workspaceId: params.workspaceId, cap: params.cap });
}

export async function applyManifestationBiasSidecar(params: Readonly<{
  readonly manifestationSidecarPort?: RecallServiceDependencies["manifestationSidecarPort"];
  readonly warn: RecallServiceWarnPort;
  readonly workspaceId: string;
  readonly runId: string | null;
  readonly taskSurfaceRef: Readonly<TaskObjectSurface>;
  readonly candidates: readonly Readonly<RecallCandidate>[];
}>): Promise<readonly Readonly<RecallCandidate>[]> {
  const sidecarPort = params.manifestationSidecarPort;
  if (sidecarPort === undefined || params.candidates.length === 0 || params.runId === null) {
    return params.candidates;
  }

  const anchorMemoryObjectIds = Object.freeze(
    [...new Set(params.candidates.map((candidate) => candidate.object_id))]
  );

  let sidecarEntries: readonly Readonly<ManifestationBiasSidecarEntry>[];
  try {
    sidecarEntries = await sidecarPort.buildBiasSidecar({
      workspaceId: params.workspaceId,
      runId: params.runId,
      anchorMemoryObjectIds,
      taskSurfaceRef: params.taskSurfaceRef
    });
  } catch (error) {
    params.warn("manifestation bias sidecar build failed", {
      workspace_id: params.workspaceId,
      run_id: params.runId,
      error: toErrorMessage(error)
    });
    return params.candidates;
  }

  if (sidecarEntries.length === 0) {
    return params.candidates;
  }

  const byMemoryId = new Map<string, Readonly<ManifestationBiasSidecarEntry>>();
  const sortedEntries = [...sidecarEntries].sort((left, right) => {
    if (right.unfinishedness_bias !== left.unfinishedness_bias) {
      return right.unfinishedness_bias - left.unfinishedness_bias;
    }
    return left.candidate_id.localeCompare(right.candidate_id);
  });
  for (const entry of sortedEntries) {
    if (entry.target_memory_object_id === null) {
      continue;
    }
    if (!byMemoryId.has(entry.target_memory_object_id)) {
      byMemoryId.set(entry.target_memory_object_id, entry);
    }
  }

  if (byMemoryId.size === 0) {
    return params.candidates;
  }

  return Object.freeze(
    params.candidates.map((candidate) => {
      const sidecar = byMemoryId.get(candidate.object_id);
      if (sidecar === undefined) {
        return candidate;
      }
      return Object.freeze({
        ...candidate,
        pending_incomplete: sidecar.pending_incomplete,
        unfinishedness_bias: sidecar.unfinishedness_bias
      });
    })
  );
}

export async function recordGlobalRecallClassificationsSafely(params: Readonly<{
  readonly globalRecallCachePort?: RecallServiceDependencies["globalRecallCachePort"];
  readonly warn: RecallServiceWarnPort;
  readonly classifications: readonly Readonly<{
    readonly workspaceId: string;
    readonly globalObjectId: string;
    readonly classification: "included" | "excluded";
  }>[];
}>): Promise<void> {
  if (params.classifications.length === 0) {
    return;
  }

  try {
    await params.globalRecallCachePort?.recordClassifications(
      Object.freeze(params.classifications)
    );
  } catch (error) {
    params.warn("global recall cache record failed", {
      workspace_id: params.classifications[0]?.workspaceId ?? null,
      classification_count: params.classifications.length,
      error: toErrorMessage(error)
    });
  }
}

export async function expandTierCascade(params: Readonly<{
  readonly coarseFilter: (
    workspaceId: string,
    config: Readonly<RecallPolicy>["coarse_filter"],
    queryText: string | null,
    options: Readonly<{
      readonly tier?: StorageTier;
      readonly projectMappings?: readonly Readonly<ProjectMappingAnchor>[];
      readonly sourceChannel?: string;
      readonly scoreMultiplier?: number;
      readonly timeFilter?: RecallTimeFilter;
      readonly queryProbes?: Readonly<RecallQueryProbes>;
      readonly winnerMemoryIds?: ReadonlySet<string>;
      readonly deliveryMaxEntries?: number;
    }>
  ) => Promise<CoarseFilterResult>;
  readonly projectMappingPort?: RecallServiceDependencies["projectMappingPort"];
  readonly mergeCoarseFilters: (
    current: CoarseFilterResult,
    next: CoarseFilterResult,
    degradationReason: NonNullable<RecallResult["degradation_reason"]>
  ) => CoarseFilterResult;
  readonly workspaceId: string;
  readonly runId: string | null;
  readonly config: Readonly<RecallPolicy>["coarse_filter"];
  readonly fineAssessmentConfig: Readonly<FineAssessmentConfig>;
  readonly queryText: string | null;
  readonly queryProbes: Readonly<RecallQueryProbes>;
  readonly hotCoarseFilter: CoarseFilterResult;
  readonly hotFineAssessmentCount: number;
  readonly winnerMemoryIds: ReadonlySet<string>;
  readonly timeFilter?: RecallTimeFilter;
}>): Promise<CoarseFilterResult> {
  const targetCount = Math.min(MIN_RECALL_RESULTS, params.fineAssessmentConfig.budgets.max_entries);
  if (targetCount === 0) {
    return params.hotCoarseFilter;
  }

  if (params.hotFineAssessmentCount >= targetCount) {
    return params.hotCoarseFilter;
  }

  const projectMappings =
    params.projectMappingPort?.findByWorkspace === undefined
      ? []
      : await params.projectMappingPort.findByWorkspace(params.workspaceId);
  const warmFilter = await params.coarseFilter(params.workspaceId, params.config, params.queryText, {
    tier: StorageTier.WARM,
    projectMappings,
    sourceChannel: "warm_cascade",
    scoreMultiplier: WARM_CASCADE_DECAY,
    timeFilter: params.timeFilter,
    queryProbes: params.queryProbes,
    winnerMemoryIds: params.winnerMemoryIds,
    deliveryMaxEntries: params.fineAssessmentConfig.budgets.max_entries
  });
  const warmMerged = params.mergeCoarseFilters(params.hotCoarseFilter, warmFilter, "warm_cascade_engaged");
  if (warmMerged.candidates.length >= targetCount) {
    return warmMerged;
  }

  const coldFilter = await params.coarseFilter(params.workspaceId, params.config, params.queryText, {
    tier: StorageTier.COLD,
    projectMappings,
    sourceChannel: "cold_cascade",
    scoreMultiplier: COLD_CASCADE_DECAY,
    timeFilter: params.timeFilter,
    queryProbes: params.queryProbes,
    winnerMemoryIds: params.winnerMemoryIds,
    deliveryMaxEntries: params.fineAssessmentConfig.budgets.max_entries
  });
  return params.mergeCoarseFilters(warmMerged, coldFilter, "cold_cascade_engaged");
}

export async function assessCoarseFilter(params: Readonly<{
  readonly dependencies: RecallServiceDependencies;
  readonly warn: RecallServiceWarnPort;
  readonly now: () => string;
  readonly coarseFilter: CoarseFilterResult;
  readonly workspaceId: string;
  readonly runId: string | null;
  readonly queryText: string | null;
  readonly queryProbes: Readonly<RecallQueryProbes>;
  readonly policy: Readonly<RecallPolicy>;
  readonly winnerMemoryIds: ReadonlySet<string>;
  readonly tokenEstimator: TokenEstimator;
}>): Promise<Readonly<{
  readonly supplementaryData: RecallSupplementaryData;
  readonly candidates: readonly Readonly<RecallCandidate>[];
  readonly diagnostics: readonly Readonly<RecallCandidateDiagnostic>[];
}>> {
  const supplementaryData = await collectSupplementaryData({
    dependencies: params.dependencies,
    warn: params.warn,
    candidates: params.coarseFilter.candidates.map((candidate) => candidate.entry),
    workspaceId: params.workspaceId,
    runId: params.runId,
    queryText: params.queryText,
    queryProbes: params.queryProbes,
    policy: params.policy,
    coarseFtsRanks: params.coarseFilter.ftsRanks,
    coarseTrigramFtsRanks: params.coarseFilter.trigramFtsRanks,
    coarseSynthesisFtsRanks: params.coarseFilter.synthesisFtsRanks,
    coarseEvidenceFtsRanks: params.coarseFilter.evidenceFtsRanks,
    coarseEvidenceFtsRanksPerRef: params.coarseFilter.evidenceFtsRanksPerRef,
    coarseSourceProximityScores: params.coarseFilter.sourceProximityScores,
    coarseSourceCohortKeys: params.coarseFilter.sourceCohortKeys,
    coarseStructuralScores: params.coarseFilter.structuralScores,
    coarseGraphExpansionScores: params.coarseFilter.graphExpansionScores,
    coarseEntitySeedScores: params.coarseFilter.entitySeedScores,
    coarsePathExpansionScores: params.coarseFilter.pathExpansionScores,
    coarsePathSuppressionScores: params.coarseFilter.pathSuppressionScores
  });
  const assessment = fineAssess({
    candidates: params.coarseFilter.candidates,
    policy: params.policy,
    winnerMemoryIds: params.winnerMemoryIds,
    supplementaryData,
    tokenEstimator: params.tokenEstimator,
    now: params.now,
    warn: params.warn
  });

  return Object.freeze({
    supplementaryData,
    candidates: assessment.candidates,
    diagnostics: assessment.diagnostics
  });
}

export function mergeCoarseFilters(
  current: CoarseFilterResult,
  next: CoarseFilterResult,
  degradationReason: NonNullable<RecallResult["degradation_reason"]>
): CoarseFilterResult {
  const seen = new Set(current.candidates.map((candidate) => buildRecallCandidateDedupeKey(candidate)));
  const nextCandidates = next.candidates.filter((candidate) => {
    const key = buildRecallCandidateDedupeKey(candidate);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
  const nextCandidateIds = new Set(nextCandidates.map((candidate) => candidate.entry.object_id));
  const graphExpansionCandidateSources = mergeGraphExpansionCandidateSources(
    current.graphExpansionCandidateSources,
    next.graphExpansionCandidateSources,
    nextCandidateIds
  );

  return Object.freeze({
    total_scanned: current.total_scanned + next.total_scanned,
    candidates: Object.freeze([...current.candidates, ...nextCandidates]),
    ftsRanks: Object.freeze({
      ...current.ftsRanks,
      ...next.ftsRanks
    }),
    trigramFtsRanks: Object.freeze({
      ...current.trigramFtsRanks,
      ...next.trigramFtsRanks
    }),
    synthesisFtsRanks: Object.freeze({
      ...current.synthesisFtsRanks,
      ...next.synthesisFtsRanks
    }),
    evidenceFtsRanks: Object.freeze({
      ...current.evidenceFtsRanks,
      ...next.evidenceFtsRanks
    }),
    evidenceFtsRanksPerRef: Object.freeze({
      ...current.evidenceFtsRanksPerRef,
      ...next.evidenceFtsRanksPerRef
    }),
    sourceProximityScores: Object.freeze({
      ...current.sourceProximityScores,
      ...next.sourceProximityScores
    }),
    sourceCohortKeys: Object.freeze({
      ...current.sourceCohortKeys,
      ...next.sourceCohortKeys
    }),
    structuralScores: Object.freeze({
      ...current.structuralScores,
      ...next.structuralScores
    }),
    graphExpansionScores: mergeGraphExpansionScores(
      current.graphExpansionScores,
      next.graphExpansionScores,
      nextCandidateIds
    ),
    graphExpansionDiagnostics: mergeGraphExpansionDiagnosticsAcrossCascade({
      sources: graphExpansionCandidateSources,
      currentFanIn: current.graphExpansionDiagnostics.multi_seed_graph_fan_in,
      nextFanIn: next.graphExpansionDiagnostics.multi_seed_graph_fan_in
    }),
    graphExpansionCandidateSources,
    entitySeedScores: Object.freeze({
      ...current.entitySeedScores,
      ...next.entitySeedScores
    }),
    pathExpansionScores: Object.freeze({
      ...current.pathExpansionScores,
      ...next.pathExpansionScores
    }),
    pathSuppressionScores: Object.freeze({
      ...current.pathSuppressionScores,
      ...next.pathSuppressionScores
    }),
    degradation_reason: degradationReason
  });
}

export async function appendWeightTransferTelemetry(params: Readonly<{
  readonly eventLogRepo: RecallServiceDependencies["eventLogRepo"];
  readonly warn: RecallServiceWarnPort;
  readonly now: () => string;
  readonly recallsEdgeColdThreshold: number;
  readonly workspaceId: string;
  readonly runId: string | null;
  readonly graphAndPathColdScore: number;
  readonly recallsEdgeCount: number;
  readonly weightTransferAmount: number;
}>): Promise<void> {
  if (params.weightTransferAmount <= 0) {
    return;
  }
  try {
    await params.eventLogRepo.append({
      event_type: RecallContextEventType.SOUL_RECALL_WEIGHT_TRANSFER,
      entity_type: "recall_weight_transfer",
      entity_id: params.runId ?? params.workspaceId,
      workspace_id: params.workspaceId,
      run_id: params.runId,
      caused_by: "system",
      payload_json: SoulRecallWeightTransferPayloadSchema.parse({
        workspace_id: params.workspaceId,
        run_id: params.runId,
        cold_score: clamp01(params.graphAndPathColdScore),
        recalls_edge_count: Math.max(0, Math.trunc(params.recallsEdgeCount)),
        recalls_threshold: params.recallsEdgeColdThreshold,
        transferred_amount: clamp01(params.weightTransferAmount),
        occurred_at: params.now()
      })
    });
  } catch (error) {
    params.warn("recall weight transfer telemetry append failed", {
      workspace_id: params.workspaceId,
      run_id: params.runId,
      error: toErrorMessage(error)
    });
  }
}
