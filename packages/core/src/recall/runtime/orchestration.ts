import {
  ControlPlaneObjectKind,
  RecallContextEventType,
  RetentionPolicy,
  SoulRecallWeightTransferPayloadSchema,
  StorageTier,
  type RecallCandidate,
  type RecallPolicy,
  type TaskObjectSurface
} from "@do-soul/alaya-protocol";
import { STRATEGY_RECALL_DEFAULTS, type NodeStrategy } from "../../conversation/task-surface-builder.js";
import { parseRecallPolicy } from "../../shared/recall-policy.js";
import {
  applyManifestationBiasEntries,
  collectCoarseFilterSupplementaryData,
  collectManifestationAnchorMemoryObjectIds,
  collectManifestationBiasEntriesByMemoryId,
  collectUniqueCoarseCandidates,
  loadManifestationBiasSidecar,
  loadTierCascadeProjectMappings,
  mergeCascadeGraphExpansion,
  mergeReadonlyRecords,
  mergeTierCascadeStage,
  runCoarseFineAssessment,
  type AssessCoarseFilterParams,
  type AssessCoarseFilterResult,
  type CoarseFilterResult,
  type ExpandTierCascadeParams
} from "./orchestration-helpers.js";
import {
  COLD_CASCADE_DECAY,
  MIN_RECALL_RESULTS,
  WARM_CASCADE_DECAY,
  clamp01,
  errorNameOf,
  toErrorMessage
} from "./recall-service-helpers.js";
import type {
  RecallResult,
  RecallServiceDependencies,
  RecallServiceWarnPort
} from "./recall-service-types.js";

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
  readonly defaultPolicyDecorator?: RecallServiceDependencies["defaultPolicyDecorator"];
}>): Readonly<RecallPolicy> {
  const base =
    params.policyOverride === undefined
      ? params.buildDefaultPolicy(params.strategy, params.taskSurfaceRef)
      : parseRecallPolicy(params.policyOverride);
  const decorator = params.defaultPolicyDecorator;
  return decorator === undefined ? base : parseRecallPolicy(decorator(base));
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

  const sidecarEntries = await loadManifestationBiasSidecar({
    sidecarPort,
    warn: params.warn,
    workspaceId: params.workspaceId,
    runId: params.runId,
    taskSurfaceRef: params.taskSurfaceRef,
    anchorMemoryObjectIds: collectManifestationAnchorMemoryObjectIds(params.candidates)
  });
  if (sidecarEntries === null || sidecarEntries.length === 0) {
    return params.candidates;
  }

  const byMemoryId = collectManifestationBiasEntriesByMemoryId(sidecarEntries);
  if (byMemoryId.size === 0) {
    return params.candidates;
  }

  return applyManifestationBiasEntries(params.candidates, byMemoryId);
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
      operation: "global_recall_cache_record",
      errorName: errorNameOf(error),
      error: toErrorMessage(error)
    });
  }
}

export async function expandTierCascade(params: ExpandTierCascadeParams): Promise<CoarseFilterResult> {
  const targetCount = Math.min(MIN_RECALL_RESULTS, params.fineAssessmentConfig.budgets.max_entries);
  if (targetCount === 0) {
    return params.hotCoarseFilter;
  }

  if (params.hotCoarseCandidateCount >= targetCount) {
    params.warn("tier cascade skipped", {
      reason: "hot_coarse_candidates_sufficient",
      hot_coarse_candidate_count: params.hotCoarseCandidateCount,
      target_count: targetCount
    });
    return params.hotCoarseFilter;
  }

  const projectMappings = await loadTierCascadeProjectMappings(
    params.projectMappingPort,
    params.workspaceId
  );
  const warmMerged = await mergeTierCascadeStage({
    current: params.hotCoarseFilter,
    params,
    projectMappings,
    tier: StorageTier.WARM,
    sourceChannel: "warm_cascade",
    scoreMultiplier: WARM_CASCADE_DECAY,
    degradationReason: "warm_cascade_engaged"
  });
  if (warmMerged.candidates.length >= targetCount) {
    return warmMerged;
  }

  return mergeTierCascadeStage({
    current: warmMerged,
    params,
    projectMappings,
    tier: StorageTier.COLD,
    sourceChannel: "cold_cascade",
    scoreMultiplier: COLD_CASCADE_DECAY,
    degradationReason: "cold_cascade_engaged"
  });
}

export async function assessCoarseFilter(
  params: AssessCoarseFilterParams
): Promise<AssessCoarseFilterResult> {
  const supplementaryData = await collectCoarseFilterSupplementaryData(params);
  const assessment = runCoarseFineAssessment(params, supplementaryData);

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
  const nextCandidates = collectUniqueCoarseCandidates(current.candidates, next.candidates);
  const nextCandidateIds = new Set(nextCandidates.map((candidate) => candidate.entry.object_id));
  const graphExpansion = mergeCascadeGraphExpansion({ current, next, nextCandidateIds });

  return Object.freeze({
    total_scanned: current.total_scanned + next.total_scanned,
    candidates: Object.freeze([...current.candidates, ...nextCandidates]),
    ftsRanks: mergeReadonlyRecords(current.ftsRanks, next.ftsRanks),
    trigramFtsRanks: mergeReadonlyRecords(current.trigramFtsRanks, next.trigramFtsRanks),
    synthesisFtsRanks: mergeReadonlyRecords(current.synthesisFtsRanks, next.synthesisFtsRanks),
    evidenceFtsRanks: mergeReadonlyRecords(current.evidenceFtsRanks, next.evidenceFtsRanks),
    evidenceFtsRanksPerRef: mergeReadonlyRecords(
      current.evidenceFtsRanksPerRef,
      next.evidenceFtsRanksPerRef
    ),
    sourceProximityScores: mergeReadonlyRecords(
      current.sourceProximityScores,
      next.sourceProximityScores
    ),
    sourceCohortKeys: mergeReadonlyRecords(current.sourceCohortKeys, next.sourceCohortKeys),
    structuralScores: mergeReadonlyRecords(current.structuralScores, next.structuralScores),
    graphExpansionScores: graphExpansion.graphExpansionScores,
    graphExpansionDiagnostics: graphExpansion.graphExpansionDiagnostics,
    graphExpansionCandidateSources: graphExpansion.graphExpansionCandidateSources,
    entitySeedScores: mergeReadonlyRecords(current.entitySeedScores, next.entitySeedScores),
    pathExpansionScores: mergeReadonlyRecords(
      current.pathExpansionScores,
      next.pathExpansionScores
    ),
    pathSuppressionScores: mergeReadonlyRecords(
      current.pathSuppressionScores,
      next.pathSuppressionScores
    ),
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
      operation: "recall_weight_transfer_telemetry_append",
      errorName: errorNameOf(error),
      error: toErrorMessage(error)
    });
  }
}
