import { randomUUID } from "node:crypto";
import {
  ControlPlaneObjectKind,
  DYNAMICS_CONSTANTS,
  MEMORY_GRAPH_EDGE_RECALL_WEIGHTS,
  RecallContextEventType,
  RetentionPolicy,
  SoulRecallCompletedPayloadSchema,
  SoulRecallWeightTransferPayloadSchema,
  StorageTier,
  type FineAssessmentConfig,
  type ActivationWeights,
  type MemoryDimension as MemoryDimensionType,
  type MemoryGraphEdge,
  type MemoryEntry,
  type PathAnchorRef,
  type PathRelation,
  type ProjectMappingAnchor,
  type RecallAdditiveScoringWeights,
  type RecallCandidate,
  type RecallOriginPlane,
  type RecallScoreFactors,
  type RecallPolicy,
  type SoulRecallHostContext,
  type TaskObjectSurface
} from "@do-soul/alaya-protocol";
import type {
  EmbeddingRecallSupplementResult,
  PreparedEmbeddingSupplement,
  PreparedEmbeddingQueryHandle
} from "./embedding-recall-service.js";
import { loadGlobalRecallCandidates } from "./global-memory-recall-service.js";
import { compileRecallQueryProbes, type RecallQueryProbes } from "./recall-query-probes.js";
import { rerankTopN, type RerankCandidate } from "./recall-feature-rerank.js";
import {
  buildRecallCandidate,
  buildSynthesisCoarseRecallCandidate
} from "./recall-candidate-builder.js";
import { STRATEGY_RECALL_DEFAULTS, type NodeStrategy } from "./task-surface-builder.js";
import {
  EMBEDDING_SIMILARITY_WEIGHT,
  COLD_CASCADE_DECAY,
  MIN_RECALL_RESULTS,
  PATH_PLASTICITY_WEIGHT,
  WARM_CASCADE_DECAY,
  assertActivationWeightsSumToOne,
  buildRecallCandidateDedupeKey,
  classifyGlobalCandidate,
  classifyProjectMappingCandidate,
  clamp01,
  compareMemoryEntries,
  entryMatchesTimeFilter,
  filterMemoriesByTimeWindow,
  getGlobalRecallLimit,
  isClaimLikeDimension,
  mapBudgetPenalty,
  matchesConfiguredCoarseFilter,
  matchesDeterministicFilter,
  matchesPrecomputedRankFilter,
  normalizeActivationScore,
  normalizeGraphSupport,
  normalizeQueryText,
  parseEmbeddingPrecheckReason,
  resolveActivationWeights,
  toErrorMessage,
  type RecallTimeFilter
} from "./recall-service-helpers.js";
import type {
  CoarseRecallCandidate,
  RecallAdmissionPlane,
  RecallCandidateDiagnostic,
  RecallCandidateDropReason,
  RecallFusionBreakdown,
  RecallFusionStream,
  RecallFusionStreamContributions,
  RecallFusionStreamRanks,
  RecallDiagnostics,
  RecallEmbeddingProviderStatus,
  RecallPathExpansionSourceDiagnostic,
  RecallResult,
  RecallServiceDependencies,
  RecallServiceWarnPort,
  RecallSupplementaryData,
  TokenEstimator
} from "./recall-service-types.js";
import { makeTokenEstimator } from "./recall-service-types.js";
import { parseRecallPolicy } from "./shared/recall-policy.js";

export { classifyGlobalCandidate } from "./recall-service-helpers.js";
export type {
  KeywordSearchResult,
  RecallCandidate,
  RecallResult,
  RecallServiceBudgetPenaltyPort,
  RecallServiceActiveConstraintsPort,
  RecallServiceClaimResolverPort,
  RecallServiceDependencies,
  RecallServiceEmbeddingRecallPort,
  RecallServiceEventLogRepoPort,
  RecallServiceGraphExpansionPort,
  RecallServiceGraphSupportPort,
  RecallServiceMemoryRepoPort,
  RecallServicePathExpansionPort,
  RecallServiceProjectMappingPort,
  RecallServiceSlotRepoPort,
  RecallServiceWarnPort,
  TokenEstimator
} from "./recall-service-types.js";
export { makeTokenEstimator } from "./recall-service-types.js";

const DYNAMIC_RECALL_PLANE_CAP = 240;
const DYNAMIC_RECALL_TOTAL_CANDIDATE_CAP = 1000;
const DYNAMIC_RECALL_SEED_CAP = 50;
const DYNAMIC_RECALL_COHORT_RADIUS = 8;
const DYNAMIC_RECALL_SOURCE_PROXIMITY_RADIUS = 6;
const DYNAMIC_RECALL_SOURCE_PROXIMITY_SEED_CAP = 12;
const DYNAMIC_RECALL_SOURCE_PROXIMITY_ADMISSION_CAP = 120;
const DYNAMIC_RECALL_SOURCE_PROXIMITY_ADMISSION_BUDGET_MULTIPLIER = 4;
const DYNAMIC_RECALL_SOURCE_PROXIMITY_NEIGHBORS_PER_SEED = 8;
const SOURCE_PROXIMITY_STRUCTURAL_CARRY_MAX = 0.25;
const STRONG_LEXICAL_DELIVERY_RANK = 0.85;
const DYNAMIC_RECALL_EDGE_FANOUT = 12;
const RECALLS_EDGE_COLD_THRESHOLD = 50;
const NO_EMBEDDING_RELEVANCE_DIRECT_WEIGHT = 0.24;
const QUERY_EVIDENCE_BASE_TRANSFER_MAX = 0.25;
const QUERY_EVIDENCE_BASE_WEIGHT_FLOOR = 0.35;
const RECALL_RRF_DEFAULT_K = 60;
const RECALL_FUSION_STREAMS: readonly RecallFusionStream[] = [
  "lexical_fts",
  "synthesis_fts",
  "evidence_fts",
  "evidence_structural_agreement",
  "source_proximity",
  "source_evidence_agreement",
  "subject_alignment",
  "structural",
  "existing_score",
  "embedding_similarity",
  "graph_expansion",
  "path_expansion",
  "temporal_recency",
  "workspace_activation"
];
const RECALL_FUSION_DEFAULT_WEIGHTS: Readonly<Record<RecallFusionStream, number>> = Object.freeze({
  lexical_fts: 1,
  // synthesis_fts no longer drives cross-kind fusion: a synthesis candidate
  // cannot out-RRF a multi-stream memory_entry, so delivery is handled by
  // reserveSynthesisDeliverySlots, not this weight. The weight is retained
  // only to rank synthesis rows among themselves; its value is inert for
  // delivery. see also: reserveSynthesisDeliverySlots.
  synthesis_fts: 8,
  evidence_fts: 3,
  evidence_structural_agreement: 6,
  source_proximity: 1,
  source_evidence_agreement: 1,
  subject_alignment: 1,
  structural: 1,
  existing_score: 8,
  embedding_similarity: 1,
  graph_expansion: 1,
  path_expansion: 3,
  temporal_recency: 0,
  workspace_activation: 0
});
// invariant: confidence sub-weight is additive (outside sum-to-1
// activation_weights). MemoryEntry.confidence is propose/accept-updated
// epistemic certainty; reading it directly here keeps later confidence
// edits visible to recall ordering without waiting for retention decay
// or activation rescore. Final score stays clamp01.
const CONFIDENCE_DIRECT_WEIGHT = 0.08;

interface CoarseCandidateDraft {
  readonly entry: Readonly<MemoryEntry>;
  readonly admissionPlanes: readonly RecallAdmissionPlane[];
  readonly firstAdmissionPlane: RecallAdmissionPlane;
  readonly sourceChannels: readonly string[];
  readonly structuralScore: number;
  readonly pathExpansionSources: readonly RecallPathExpansionSourceDiagnostic[];
}

interface SourceProximitySeedDraft {
  readonly draft: Readonly<CoarseCandidateDraft>;
  readonly strength: number;
}

type CoarseCandidateAdder = (
  entry: Readonly<MemoryEntry>,
  plane: RecallAdmissionPlane,
  structuralScore?: number,
  sourceChannel?: string,
  pathExpansionSource?: RecallPathExpansionSourceDiagnostic
) => void;

export class RecallService {
  private readonly generateRuntimeId: () => string;
  private readonly now: () => string;
  private readonly warn: RecallServiceWarnPort;

  public constructor(private readonly dependencies: RecallServiceDependencies) {
    assertActivationWeightsSumToOne(DYNAMICS_CONSTANTS.activation_weights_phase4b);
    this.generateRuntimeId = dependencies.generateRuntimeId ?? (() => randomUUID());
    this.now = dependencies.now ?? (() => new Date().toISOString());
    this.warn = dependencies.warn ?? (() => undefined);
  }

  public async recall(params: {
    readonly taskSurface: Readonly<TaskObjectSurface>;
    readonly workspaceId: string;
    readonly strategy: NodeStrategy;
    readonly runId?: string | null;
    readonly policyOverride?: Readonly<RecallPolicy>;
    readonly timeFilter?: RecallTimeFilter;
    readonly hostContext?: Readonly<SoulRecallHostContext>;
    readonly activeConstraintsCap?: number | null;
  }): Promise<RecallResult> {
    const policy = this.resolvePolicy(params.strategy, params.taskSurface.runtime_id, params.policyOverride);
    const tokenEstimator = makeTokenEstimator({ hint: params.hostContext?.tokenizer_hint });
    const queryText = normalizeQueryText(params.taskSurface.display_name);
    const queryProbes = compileRecallQueryProbes(queryText);
    const [slots, activeConstraints] = await Promise.all([
      this.dependencies.slotRepo.findByWorkspace(params.workspaceId),
      this.loadActiveConstraints(params.workspaceId, params.activeConstraintsCap ?? null)
    ]);
    const winnerClaimIds = new Set(slots.flatMap((slot) => (slot.winner_claim_id === null ? [] : [slot.winner_claim_id])));
    // Resolve claim IDs to their backing memory entry IDs.
    // winner_claim_id is a ClaimForm.object_id; the conflict-penalty check needs
    // to compare against MemoryEntry.object_id via ClaimForm.source_object_refs.
    let winnerMemoryIds: ReadonlySet<string> = new Set();
    if (winnerClaimIds.size > 0 && this.dependencies.claimResolverPort !== undefined) {
      const claims = await this.dependencies.claimResolverPort.findByIds([...winnerClaimIds]);
      // Collect all source_object_refs from every winning claim so that every
      // memory entry referenced by a winner is exempt from conflict_penalty.
      // Using only [0] would drop additional backing memory IDs for multi-source
      // claims and incorrectly penalise those legitimate winner-backed entries.
      winnerMemoryIds = new Set(
        claims.flatMap((claim) => claim.source_object_refs).filter((ref): ref is string => ref !== undefined)
      );
    }

    const hotCoarseFilter = await this.coarseFilter(params.workspaceId, policy.coarse_filter, queryText, {
      timeFilter: params.timeFilter,
      queryProbes,
      winnerMemoryIds,
      deliveryMaxEntries: policy.fine_assessment.budgets.max_entries
    });
    const globalCoarseFilter = await loadGlobalRecallCandidates({
      workspaceId: params.workspaceId,
      queryText,
      limit: getGlobalRecallLimit(policy),
      createdBy: "system",
      globalRecallPort: this.dependencies.globalRecallPort,
      projectMappingPort: this.dependencies.projectMappingPort,
      classifyGlobalCandidate,
      timeFilter: params.timeFilter,
      entryMatchesTimeFilter
    });
    const filteredGlobalCandidates = globalCoarseFilter.records.flatMap((record) => {
      if (record.candidate === null) {
        return [];
      }

      return matchesConfiguredCoarseFilter(record.candidate.entry, policy.coarse_filter)
        ? [record.candidate]
        : [];
    });
    const globalRecallClassifications = globalCoarseFilter.records.map((record) =>
      Object.freeze({
        workspaceId: params.workspaceId,
        globalObjectId: record.globalObjectId,
        classification:
          record.candidate !== null &&
          matchesConfiguredCoarseFilter(record.candidate.entry, policy.coarse_filter)
            ? ("included" as const)
            : ("excluded" as const)
      })
    );
    // Keep supplementary scoring data on the final merged candidate set only;
    // the HOT pass drives tier expansion but must not double-read graph/path
    // signals when the cascade widens.
    const coarseFilter = await this.expandTierCascade({
      workspaceId: params.workspaceId,
      runId: params.runId ?? null,
      config: policy.coarse_filter,
      fineAssessmentConfig: policy.fine_assessment,
      queryText,
      queryProbes,
      hotCoarseFilter,
      hotFineAssessmentCount: hotCoarseFilter.candidates.length,
      winnerMemoryIds,
      timeFilter: params.timeFilter
    });
    const synthesisCoarseFilter = await this.collectSynthesisCoarseCandidates({
      workspaceId: params.workspaceId,
      queryText,
      queryProbes,
      policy
    });
    const combinedCoarseCandidates = Object.freeze([
      ...coarseFilter.candidates,
      ...filteredGlobalCandidates,
      ...synthesisCoarseFilter.candidates
    ]) as readonly Readonly<CoarseRecallCandidate>[];
    const preparedEmbeddingQueryPromise = this.prepareEmbeddingSupplementQuery({
      config: policy,
      workspaceId: params.workspaceId,
      runId: params.runId ?? null,
      queryText,
      localEligibleCandidates: coarseFilter.candidates,
      lexicalFallbackCount: Math.min(
        combinedCoarseCandidates.length,
        policy.fine_assessment.budgets.max_entries
      )
    }).then(
      (value) => ({ status: "fulfilled" as const, value }),
      (reason: unknown) => ({ status: "rejected" as const, reason })
    );

    const initialAssessment = await this.assessCoarseFilter({
      coarseFilter: Object.freeze({
        ...coarseFilter,
        candidates: combinedCoarseCandidates,
        synthesisFtsRanks: synthesisCoarseFilter.synthesisFtsRanks
      }),
      workspaceId: params.workspaceId,
      runId: params.runId ?? null,
      queryText,
      policy,
      queryProbes,
      winnerMemoryIds,
      tokenEstimator
    });
    const lexicalCandidates = initialAssessment.candidates;
    const preparedEmbeddingQueryResult = await preparedEmbeddingQueryPromise;
    if (preparedEmbeddingQueryResult.status === "rejected") {
      throw preparedEmbeddingQueryResult.reason;
    }
    const preparedEmbeddingQuery = preparedEmbeddingQueryResult.value;
    const embeddingSupplement = await this.collectEmbeddingSupplement({
      baseCandidateIds: lexicalCandidates.map((candidate) => candidate.object_id),
      localEligibleCandidates: coarseFilter.candidates,
      config: policy,
      workspaceId: params.workspaceId,
      runId: params.runId ?? null,
      queryText,
      preparedEmbeddingQuery: preparedEmbeddingQuery.handle,
      preparedStoredVectors: preparedEmbeddingQuery.storedVectors
    });
    const supplementaryData = withEmbeddingSimilarityScores(
      initialAssessment.supplementaryData,
      embeddingSupplement.similarityHintsByObjectId
    );
    const finalAssessment =
      Object.keys(embeddingSupplement.similarityHintsByObjectId).length === 0
        ? initialAssessment
        : this.fineAssess(
            combinedCoarseCandidates,
            policy,
            winnerMemoryIds,
            supplementaryData,
            tokenEstimator
          );
    const embeddingProviderStatus = resolveEmbeddingProviderStatus(
      policy,
      preparedEmbeddingQuery.handle,
      preparedEmbeddingQuery.degradedReason
    );
    const providerDegradationReason = resolveEmbeddingProviderDegradationReason(
      policy,
      preparedEmbeddingQuery.handle,
      preparedEmbeddingQuery.degradedReason
    );
    const candidates = await this.applyManifestationBiasSidecar({
      workspaceId: params.workspaceId,
      runId: params.runId ?? null,
      taskSurfaceRef: params.taskSurface,
      candidates: finalAssessment.candidates
    });
    const candidateDiagnostics = finalizeRecallCandidateDiagnostics(
      finalAssessment.diagnostics,
      candidates
    );
    const occurredAt = this.now();

    await this.dependencies.eventLogRepo.append({
      event_type: RecallContextEventType.SOUL_RECALL_COMPLETED,
      entity_type: "task_object_surface",
      entity_id: params.taskSurface.runtime_id,
      workspace_id: params.workspaceId,
      run_id: params.runId ?? null,
      caused_by: "system",
      payload_json: SoulRecallCompletedPayloadSchema.parse({
        task_surface_ref: params.taskSurface.runtime_id,
        node_strategy: params.strategy,
        total_scanned: coarseFilter.total_scanned + globalCoarseFilter.total_scanned,
        coarse_filter_count: combinedCoarseCandidates.length,
        fine_assessment_count: candidates.length,
        workspace_id: params.workspaceId,
        occurred_at: occurredAt
      })
    });
    await this.appendWeightTransferTelemetry({
      workspaceId: params.workspaceId,
      runId: params.runId ?? null,
      graphAndPathColdScore: supplementaryData.graphAndPathColdScore,
      recallsEdgeCount: supplementaryData.recallsEdgeCount,
      weightTransferAmount: supplementaryData.weightTransferAmount
    });
    await this.recordGlobalRecallClassificationsSafely(globalRecallClassifications);

    return Object.freeze({
      candidates,
      active_constraints: activeConstraints.constraints,
      active_constraints_count: activeConstraints.total_count,
      total_scanned: coarseFilter.total_scanned + globalCoarseFilter.total_scanned,
      coarse_filter_count: combinedCoarseCandidates.length,
      fine_assessment_count: candidates.length,
      degradation_reason: coarseFilter.degradation_reason,
      working_projection: null,
      diagnostics: buildRecallDiagnostics({
        queryProbes,
        totalScanned: coarseFilter.total_scanned + globalCoarseFilter.total_scanned,
        candidatePoolCount: combinedCoarseCandidates.length,
        preBudgetCount: candidateDiagnostics.length,
        deliveredCount: candidates.length,
        embeddingProviderStatus,
        providerDegradationReason,
        candidates: candidateDiagnostics
      })
    });
  }

  private async loadActiveConstraints(
    workspaceId: string,
    cap: number | null
  ): Promise<Readonly<{
    readonly constraints: RecallResult["active_constraints"];
    readonly total_count: number;
  }>> {
    const port = this.dependencies.activeConstraintsPort;
    if (port === undefined) {
      return Object.freeze({
        constraints: Object.freeze([]),
        total_count: 0
      });
    }
    return port.findActiveConstraints({ workspaceId, cap });
  }

  private async applyManifestationBiasSidecar(params: Readonly<{
    readonly workspaceId: string;
    readonly runId: string | null;
    readonly taskSurfaceRef: Readonly<TaskObjectSurface>;
    readonly candidates: readonly Readonly<RecallCandidate>[];
  }>): Promise<readonly Readonly<RecallCandidate>[]> {
    const sidecarPort = this.dependencies.manifestationSidecarPort;
    if (sidecarPort === undefined || params.candidates.length === 0 || params.runId === null) {
      return params.candidates;
    }

    const anchorMemoryObjectIds = Object.freeze(
      [...new Set(params.candidates.map((candidate) => candidate.object_id))]
    );

    let sidecarEntries: readonly Readonly<import("./manifestation-resolver.js").ManifestationBiasSidecarEntry>[];
    try {
      sidecarEntries = await sidecarPort.buildBiasSidecar({
        workspaceId: params.workspaceId,
        runId: params.runId,
        anchorMemoryObjectIds,
        taskSurfaceRef: params.taskSurfaceRef
      });
    } catch (error) {
      this.warn("manifestation bias sidecar build failed", {
        workspace_id: params.workspaceId,
        run_id: params.runId,
        error: toErrorMessage(error)
      });
      return params.candidates;
    }

    if (sidecarEntries.length === 0) {
      return params.candidates;
    }

    // Highest unfinishedness_bias wins per target memory; ties resolve
    // deterministically by candidate_id so repeated runs are stable.
    const byMemoryId = new Map<string, Readonly<import("./manifestation-resolver.js").ManifestationBiasSidecarEntry>>();
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

  private async recordGlobalRecallClassificationsSafely(
    classifications: readonly Readonly<{
      readonly workspaceId: string;
      readonly globalObjectId: string;
      readonly classification: "included" | "excluded";
    }>[]
  ): Promise<void> {
    if (classifications.length === 0) {
      return;
    }

    try {
      await this.dependencies.globalRecallCachePort?.recordClassifications(
        Object.freeze(classifications)
      );
    } catch (error) {
      this.warn("global recall cache record failed", {
        workspace_id: classifications[0]?.workspaceId ?? null,
        classification_count: classifications.length,
        error: toErrorMessage(error)
      });
      return;
    }
  }

  public buildDefaultPolicy(strategy: NodeStrategy, taskSurfaceRef: string): Readonly<RecallPolicy> {
    const defaults = STRATEGY_RECALL_DEFAULTS[strategy];
    const now = this.now();

    return parseRecallPolicy({
      runtime_id: this.generateRuntimeId(),
      object_kind: ControlPlaneObjectKind.RECALL_POLICY,
      task_surface_ref: taskSurfaceRef,
      expires_at: new Date(new Date(now).getTime() + 30 * 60 * 1000).toISOString(),
      derived_from: taskSurfaceRef,
      retention_policy: RetentionPolicy.SESSION_ONLY,
      coarse_filter: defaults.coarse,
      fine_assessment: defaults.fine
    });
  }

  private resolvePolicy(
    strategy: NodeStrategy,
    taskSurfaceRef: string,
    policyOverride?: Readonly<RecallPolicy>
  ): Readonly<RecallPolicy> {
    if (policyOverride === undefined) {
      return this.buildDefaultPolicy(strategy, taskSurfaceRef);
    }

    return parseRecallPolicy(policyOverride);
  }

  private async coarseFilter(
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
    }> = {}
  ): Promise<{
    readonly total_scanned: number;
    readonly candidates: readonly Readonly<CoarseRecallCandidate>[];
    readonly ftsRanks: Readonly<Record<string, number>>;
    readonly synthesisFtsRanks: Readonly<Record<string, number>>;
    readonly evidenceFtsRanks: Readonly<Record<string, number>>;
    readonly sourceProximityScores: Readonly<Record<string, number>>;
    readonly sourceCohortKeys: Readonly<Record<string, string>>;
    readonly structuralScores: Readonly<Record<string, number>>;
    readonly graphExpansionScores: Readonly<Record<string, number>>;
    readonly pathExpansionScores: Readonly<Record<string, number>>;
    readonly degradation_reason: RecallResult["degradation_reason"];
  }> {
    const tier = options.tier ?? StorageTier.HOT;
    const [rawTierMemories, projectMappings] = await Promise.all([
      this.dependencies.memoryRepo.findByWorkspaceId(workspaceId, tier),
      options.projectMappings ?? this.dependencies.projectMappingPort?.findByWorkspace(workspaceId) ?? Promise.resolve([])
    ]);
    // Apply optional time-window filter as a pre-filter so the score function
    // is unaffected. Empty/absent bounds keep behavior backward-compatible.
    const tierMemories = filterMemoriesByTimeWindow(rawTierMemories, options.timeFilter);
    const byId = new Map(tierMemories.map((memory) => [memory.object_id, memory]));
    const queryProbes = options.queryProbes ?? compileRecallQueryProbes(queryText);
    const winnerMemoryIds = options.winnerMemoryIds ?? new Set<string>();
    const protectedCandidates = tierMemories.filter((entry) => winnerMemoryIds.has(entry.object_id));
    const protectedIds = new Set(protectedCandidates.map((entry) => entry.object_id));
    const deterministicMatches = tierMemories.filter(
      (entry) => !protectedIds.has(entry.object_id) && matchesDeterministicFilter(entry, config)
    );

    const rankedMatches = deterministicMatches
      .filter((entry) => matchesPrecomputedRankFilter(entry, config))
      .sort(compareMemoryEntries)
      .slice(0, config.precomputed_rank.max_candidates);

    const drafts = new Map<string, CoarseCandidateDraft>();
    const ftsRanks = new Map<string, number>();
    const evidenceFtsRanks = new Map<string, number>();
    const sourceProximityScores = new Map<string, number>();
    let sourceCohortKeys: Readonly<Record<string, string>> = Object.freeze({});
    const structuralScores = new Map<string, number>();
    const graphExpansionScores = new Map<string, number>();
    const pathExpansionScores = new Map<string, number>();
    const addCandidate = (
      entry: Readonly<MemoryEntry>,
      plane: RecallAdmissionPlane,
      structuralScore = 0,
      sourceChannel?: string,
      pathExpansionSource?: RecallPathExpansionSourceDiagnostic
    ): void => {
      if (
        plane !== "protected_winner" &&
        plane !== "lexical" &&
        !winnerMemoryIds.has(entry.object_id) &&
        !matchesDeterministicFilter(entry, config)
      ) {
        return;
      }
      const current = drafts.get(entry.object_id);
      const planeScore = clamp01(structuralScore);
      const evidenceStructuralScore =
        plane === "source_proximity"
          ? Math.min(planeScore, SOURCE_PROXIMITY_STRUCTURAL_CARRY_MAX)
          : planeScore;
      const nextStructuralScore = Math.max(current?.structuralScore ?? 0, evidenceStructuralScore);
      drafts.set(entry.object_id, {
        entry,
        admissionPlanes: uniquePlanes([...(current?.admissionPlanes ?? []), plane]),
        firstAdmissionPlane: current?.firstAdmissionPlane ?? plane,
        sourceChannels: uniqueStrings([
          ...(current?.sourceChannels ?? []),
          ...(sourceChannel === undefined ? [] : [sourceChannel])
        ]),
        structuralScore: nextStructuralScore,
        pathExpansionSources: uniquePathExpansionSources([
          ...(current?.pathExpansionSources ?? []),
          ...(pathExpansionSource === undefined ? [] : [pathExpansionSource])
        ])
      });
      structuralScores.set(
        entry.object_id,
        Math.max(structuralScores.get(entry.object_id) ?? 0, evidenceStructuralScore)
      );
      if (plane === "graph_expansion") {
        graphExpansionScores.set(
          entry.object_id,
          Math.max(graphExpansionScores.get(entry.object_id) ?? 0, evidenceStructuralScore)
        );
      }
      if (plane === "path_expansion") {
        pathExpansionScores.set(
          entry.object_id,
          Math.max(pathExpansionScores.get(entry.object_id) ?? 0, evidenceStructuralScore)
        );
      }
      if (plane === "source_proximity") {
        sourceProximityScores.set(
          entry.object_id,
          Math.max(sourceProximityScores.get(entry.object_id) ?? 0, planeScore)
        );
      }
    };

    for (const entry of protectedCandidates.sort(compareMemoryEntries)) {
      addCandidate(entry, "protected_winner", 1, "protected_winner");
    }
    for (const entry of rankedMatches) {
      addCandidate(entry, "activation", 0, "activation");
    }

    const objectProbeCandidates = tierMemories
      .map((entry) => Object.freeze({
        entry,
        score: scoreObjectProbeMatch(entry, queryProbes)
      }))
      .filter((candidate) => candidate.score > 0)
      .sort((left, right) =>
        right.score === left.score
          ? compareMemoryEntries(left.entry, right.entry)
          : right.score - left.score
      )
      .slice(0, DYNAMIC_RECALL_PLANE_CAP);
    for (const candidate of objectProbeCandidates) {
      addCandidate(candidate.entry, "object_probe", candidate.score, "object_probe");
    }

    if (
      config.semantic_supplement.enabled &&
      config.semantic_supplement.max_supplement > 0 &&
      queryText !== null &&
      (this.dependencies.memoryRepo.searchByKeywordWithinObjectIds !== undefined ||
        this.dependencies.memoryRepo.searchByKeyword !== undefined)
    ) {
      const byId = new Map(tierMemories.map((memory) => [memory.object_id, memory]));
      const supplement =
        this.dependencies.memoryRepo.searchByKeywordWithinObjectIds !== undefined
          ? await this.dependencies.memoryRepo.searchByKeywordWithinObjectIds(
              workspaceId,
              queryText,
              config.semantic_supplement.max_supplement,
              [...byId.keys()]
            )
          : await this.dependencies.memoryRepo.searchByKeyword!(
              workspaceId,
              queryText,
              config.semantic_supplement.max_supplement
            );
      for (const match of supplement) {
        ftsRanks.set(match.object_id, clamp01(match.normalized_rank));
        const entry = byId.get(match.object_id);
        if (entry !== undefined) {
          addCandidate(entry, "lexical", clamp01(match.normalized_rank), "lexical");
        }
      }

      // Evidence FTS: when distillation drops keywords from MemoryEntry.content,
      // the raw turn still lives in EvidenceCapsule.gist / .excerpt. Searching
      // there and resolving back via evidence_refs admits memories that would
      // otherwise miss lexical entirely. see: 068-evidence-capsule-fts.sql.
      if (
        this.dependencies.evidenceSearchPort !== undefined &&
        this.dependencies.memoryRepo.findByEvidenceRefs !== undefined
      ) {
        try {
          const evidenceMatchById = new Map<string, number>();
          for (const evidenceQuery of buildEvidenceSearchQueries(queryText, queryProbes)) {
            const evidenceMatches = await this.dependencies.evidenceSearchPort.searchByKeyword(
              workspaceId,
              evidenceQuery,
              config.semantic_supplement.max_supplement
            );
            for (const match of evidenceMatches) {
              evidenceMatchById.set(
                match.object_id,
                Math.max(evidenceMatchById.get(match.object_id) ?? 0, clamp01(match.normalized_rank))
              );
            }
          }
          const evidenceMatches = [...evidenceMatchById.entries()].map(([object_id, normalized_rank]) =>
            Object.freeze({ object_id, normalized_rank })
          );
          if (evidenceMatches.length > 0) {
            const evidenceRankById = new Map<string, number>();
            for (const match of evidenceMatches) {
              evidenceRankById.set(match.object_id, clamp01(match.normalized_rank));
            }
            const memoriesByEvidence = await this.dependencies.memoryRepo.findByEvidenceRefs(
              workspaceId,
              [...evidenceRankById.keys()]
            );
            for (const memory of memoriesByEvidence) {
              if (!byId.has(memory.object_id)) {
                continue;
              }
              let bestRank = 0;
              for (const ref of memory.evidence_refs) {
                const evidenceRank = evidenceRankById.get(ref);
                if (evidenceRank !== undefined && evidenceRank > bestRank) {
                  bestRank = evidenceRank;
                }
              }
              if (bestRank <= 0) {
                continue;
              }
              evidenceFtsRanks.set(
                memory.object_id,
                Math.max(evidenceFtsRanks.get(memory.object_id) ?? 0, bestRank)
              );
              addCandidate(memory, "lexical", bestRank, "evidence_fts");
            }
          }
        } catch (error) {
          this.warn("evidence FTS lookup failed", {
            workspace_id: workspaceId,
            error: toErrorMessage(error)
          });
        }
      }
    }

    this.addContentDerivedExpansionCandidates({
      tierMemories,
      drafts,
      queryProbes,
      addCandidate
    });
    sourceCohortKeys = await this.addSourceProximityCandidates({
      workspaceId,
      tierMemories,
      drafts,
      addCandidate,
      admissionLimit: resolveSourceProximityAdmissionLimit(options.deliveryMaxEntries)
    });
    await this.addGraphExpansionCandidates({
      workspaceId,
      byId,
      drafts,
      addCandidate
    });
    await this.addPathExpansionCandidates({
      workspaceId,
      byId,
      drafts,
      queryProbes,
      addCandidate
    });

    const anchorMap = new Map(projectMappings.map((mapping) => [mapping.global_object_id, mapping]));
    const selectedDrafts = rankCoarseCandidateDrafts([...drafts.values()]).slice(0, DYNAMIC_RECALL_TOTAL_CANDIDATE_CAP);
    const supplementedCandidates = Object.freeze(
      selectedDrafts.flatMap((draft) => {
        const entry = draft.entry;
        const classification = classifyProjectMappingCandidate(
          entry,
          anchorMap,
          this.dependencies.projectMappingPort
        );

        if (!classification.include) {
          return [];
        }

        return [
          Object.freeze({
            entry,
            isAdvisory: classification.isAdvisory,
            admissionPlanes: Object.freeze([...draft.admissionPlanes]),
            firstAdmissionPlane: draft.firstAdmissionPlane,
            sourceChannels: Object.freeze(uniqueStrings([
              ...draft.sourceChannels,
              ...(options.sourceChannel === undefined ? [] : [options.sourceChannel])
            ])),
            structuralScore: draft.structuralScore,
            pathExpansionSources: Object.freeze([...draft.pathExpansionSources]),
            ...(options.sourceChannel === undefined ? {} : { sourceChannel: options.sourceChannel }),
            ...(options.scoreMultiplier === undefined ? {} : { scoreMultiplier: options.scoreMultiplier })
          })
        ];
      })
    ) as readonly Readonly<CoarseRecallCandidate>[];

    return Object.freeze({
      total_scanned: tierMemories.length,
      candidates: supplementedCandidates,
      ftsRanks: Object.freeze(Object.fromEntries(ftsRanks.entries())),
      synthesisFtsRanks: Object.freeze({}),
      evidenceFtsRanks: Object.freeze(Object.fromEntries(evidenceFtsRanks.entries())),
      sourceProximityScores: Object.freeze(Object.fromEntries(sourceProximityScores.entries())),
      sourceCohortKeys,
      structuralScores: Object.freeze(Object.fromEntries(structuralScores.entries())),
      graphExpansionScores: Object.freeze(Object.fromEntries(graphExpansionScores.entries())),
      pathExpansionScores: Object.freeze(Object.fromEntries(pathExpansionScores.entries())),
      degradation_reason: null
    });
  }

  private addContentDerivedExpansionCandidates(params: Readonly<{
    readonly tierMemories: readonly Readonly<MemoryEntry>[];
    readonly drafts: ReadonlyMap<string, CoarseCandidateDraft>;
    readonly queryProbes: Readonly<RecallQueryProbes>;
    readonly addCandidate: CoarseCandidateAdder;
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
      .slice(0, DYNAMIC_RECALL_PLANE_CAP);
    for (const candidate of queryEvidenceEntries) {
      params.addCandidate(candidate.entry, "lexical", candidate.score, "query_probe_lexical");
    }

    const seeds = selectExpansionSeedEntries(params.drafts, params.tierMemories).slice(0, DYNAMIC_RECALL_SEED_CAP);
    const structuralSeeds = selectPreferredExpansionSeedEntries(params.drafts).slice(0, DYNAMIC_RECALL_SEED_CAP);
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
        .slice(0, DYNAMIC_RECALL_PLANE_CAP);
      for (const candidate of entries) {
        params.addCandidate(candidate.entry, "evidence_anchor", candidate.score, "evidence_anchor");
      }
    }

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
        .slice(0, DYNAMIC_RECALL_PLANE_CAP);
      for (const candidate of entries) {
        params.addCandidate(candidate.entry, "domain_tag_cluster", candidate.score, "domain_tag_cluster");
      }
    }

    // invariant: cohort dominance guard runs per-branch. Each branch's
    // would-be admissions are compared against tier pool size; a branch
    // is skipped when its own coverage exceeds 50% of tierMemories. The
    // exact branch (query-attested surface_id/run_id) is admitted even
    // on saturated workspaces unless its own match-set alone exceeds
    // 50%; query attestation is stronger evidence than seed proximity.
    const querySurfaceIds = new Set(params.queryProbes.surface_ids);
    const queryRunIds = new Set(params.queryProbes.run_ids);
    const exactCohortMatches = params.tierMemories
      .filter((entry) =>
        (entry.surface_id !== null && querySurfaceIds.has(entry.surface_id)) ||
        (entry.run_id !== null && queryRunIds.has(entry.run_id))
      )
      .sort(compareMemoryEntries)
      .slice(0, DYNAMIC_RECALL_PLANE_CAP);
    const exactCohortRatio =
      params.tierMemories.length === 0
        ? 0
        : exactCohortMatches.length / params.tierMemories.length;
    if (exactCohortRatio <= 0.5) {
      for (const entry of exactCohortMatches) {
        params.addCandidate(entry, "session_surface_cohort", 0.8, "session_surface_cohort");
      }
    }

    if (structuralSeeds.length > 0) {
      const seedCohortByMemoryId = new Map<string, readonly Readonly<MemoryEntry>[]>();
      const seedCohortIds = new Set<string>();
      for (const seed of seeds.slice(0, DYNAMIC_RECALL_SEED_CAP)) {
        const cohort = params.tierMemories
          .filter((entry) =>
            (seed.surface_id !== null && entry.surface_id === seed.surface_id) ||
            (seed.run_id !== null && entry.run_id === seed.run_id)
          )
          .sort((left, right) => {
            const createdAtComparison = left.created_at.localeCompare(right.created_at);
            return createdAtComparison === 0 ? left.object_id.localeCompare(right.object_id) : createdAtComparison;
          });
        seedCohortByMemoryId.set(seed.object_id, cohort);
        const center = cohort.findIndex((entry) => entry.object_id === seed.object_id);
        if (center < 0) {
          continue;
        }
        const start = Math.max(0, center - DYNAMIC_RECALL_COHORT_RADIUS);
        const end = Math.min(cohort.length, center + DYNAMIC_RECALL_COHORT_RADIUS + 1);
        for (const entry of cohort.slice(start, end)) {
          if (entry.object_id !== seed.object_id) {
            seedCohortIds.add(entry.object_id);
          }
        }
      }
      const seedCohortRatio =
        params.tierMemories.length === 0
          ? 0
          : seedCohortIds.size / params.tierMemories.length;
      if (seedCohortRatio <= 0.5) {
        for (const seed of seeds.slice(0, DYNAMIC_RECALL_SEED_CAP)) {
          const cohort = seedCohortByMemoryId.get(seed.object_id) ?? [];
          const center = cohort.findIndex((entry) => entry.object_id === seed.object_id);
          if (center < 0) {
            continue;
          }
          const start = Math.max(0, center - DYNAMIC_RECALL_COHORT_RADIUS);
          const end = Math.min(cohort.length, center + DYNAMIC_RECALL_COHORT_RADIUS + 1);
          for (const entry of cohort.slice(start, end)) {
            if (entry.object_id !== seed.object_id) {
              params.addCandidate(entry, "session_surface_cohort", 0.55, "session_surface_cohort");
            }
          }
        }
      }
    }
  }

  private async addSourceProximityCandidates(params: Readonly<{
    readonly workspaceId: string;
    readonly tierMemories: readonly Readonly<MemoryEntry>[];
    readonly drafts: ReadonlyMap<string, CoarseCandidateDraft>;
    readonly addCandidate: CoarseCandidateAdder;
    readonly admissionLimit: number;
  }>): Promise<Readonly<Record<string, string>>> {
    if (params.drafts.size === 0 || params.admissionLimit <= 0) {
      return Object.freeze({});
    }

    const seedDrafts = selectSourceProximitySeedDrafts(params.drafts);
    if (seedDrafts.length === 0) {
      return Object.freeze({});
    }

    const sourceRefsByMemoryId = await this.loadEvidenceSourceRefsByMemoryId(
      params.workspaceId,
      params.tierMemories
    );
    const sourceCohortKeys = buildEvidenceSourceCohortKeys(params.tierMemories, sourceRefsByMemoryId);
    const bySource = buildEvidenceSourceChunkIndex(params.tierMemories, sourceRefsByMemoryId);
    if (bySource.size === 0) {
      return sourceCohortKeys;
    }

    const newlyAdmitted = new Set<string>();
    for (const seed of seedDrafts) {
      const neighborById = new Map<string, {
        readonly entry: Readonly<MemoryEntry>;
        readonly score: number;
      }>();
      for (const ref of sourceRefsByMemoryId.get(seed.draft.entry.object_id) ?? seed.draft.entry.evidence_refs) {
        const parsed = parseEvidenceSourceChunkRef(ref);
        if (parsed === null) {
          continue;
        }
        const neighbors = bySource.get(parsed.sourceKey) ?? [];
        for (const neighbor of neighbors) {
          if (neighbor.entry.object_id === seed.draft.entry.object_id) {
            continue;
          }
          const distance = Math.abs(neighbor.chunkIndex - parsed.chunkIndex);
          if (distance > DYNAMIC_RECALL_SOURCE_PROXIMITY_RADIUS) {
            continue;
          }
          const score = clamp01(seed.strength * (1 - distance / (DYNAMIC_RECALL_SOURCE_PROXIMITY_RADIUS + 1)));
          if (score <= 0) {
            continue;
          }
          const current = neighborById.get(neighbor.entry.object_id);
          if (current === undefined || score > current.score) {
            neighborById.set(neighbor.entry.object_id, { entry: neighbor.entry, score });
          }
        }
      }

      const candidates = [...neighborById.values()]
        .sort((left, right) =>
          right.score === left.score
            ? compareMemoryEntries(left.entry, right.entry)
            : right.score - left.score
        )
        .slice(0, DYNAMIC_RECALL_SOURCE_PROXIMITY_NEIGHBORS_PER_SEED);
      for (const candidate of candidates) {
        const wasDrafted = params.drafts.has(candidate.entry.object_id);
        params.addCandidate(candidate.entry, "source_proximity", candidate.score, "source_proximity");
        if (!wasDrafted) {
          newlyAdmitted.add(candidate.entry.object_id);
          if (newlyAdmitted.size >= params.admissionLimit) {
            return sourceCohortKeys;
          }
        }
      }
    }
    return sourceCohortKeys;
  }

  private async loadEvidenceSourceRefsByMemoryId(
    workspaceId: string,
    entries: readonly Readonly<MemoryEntry>[]
  ): Promise<ReadonlyMap<string, readonly string[]>> {
    const sourceRefsByMemoryId = new Map<string, readonly string[]>();
    for (const entry of entries) {
      sourceRefsByMemoryId.set(entry.object_id, uniqueStrings(entry.evidence_refs));
    }

    const evidenceSearchPort = this.dependencies.evidenceSearchPort;
    if (evidenceSearchPort?.findByIds === undefined) {
      return sourceRefsByMemoryId;
    }

    const evidenceObjectIds = uniqueStrings(entries.flatMap((entry) => entry.evidence_refs));
    if (evidenceObjectIds.length === 0) {
      return sourceRefsByMemoryId;
    }

    try {
      const evidenceCapsules = await evidenceSearchPort.findByIds(workspaceId, evidenceObjectIds);
      const sourceRefByEvidenceId = new Map<string, string>();
      for (const evidence of evidenceCapsules) {
        if (evidence.workspace_id !== workspaceId) {
          continue;
        }
        const artifactRef = evidence.physical_anchor?.artifact_ref?.trim() ?? "";
        if (artifactRef.length > 0) {
          sourceRefByEvidenceId.set(evidence.object_id, artifactRef);
        }
      }
      for (const entry of entries) {
        sourceRefsByMemoryId.set(
          entry.object_id,
          uniqueStrings([
            ...entry.evidence_refs,
            ...entry.evidence_refs
              .map((ref) => sourceRefByEvidenceId.get(ref))
              .filter((ref): ref is string => ref !== undefined)
          ])
        );
      }
    } catch (error) {
      this.warn("evidence source-anchor lookup failed", {
        workspace_id: workspaceId,
        error: toErrorMessage(error)
      });
    }

    return sourceRefsByMemoryId;
  }

  private async addGraphExpansionCandidates(params: Readonly<{
    readonly workspaceId: string;
    readonly byId: ReadonlyMap<string, Readonly<MemoryEntry>>;
    readonly drafts: ReadonlyMap<string, CoarseCandidateDraft>;
    readonly addCandidate: CoarseCandidateAdder;
  }>): Promise<void> {
    const graphExpansionPort = this.dependencies.graphExpansionPort;
    if (graphExpansionPort === undefined || params.drafts.size === 0) {
      return;
    }

    const seeds = selectExpansionSeedDrafts(params.drafts).slice(0, DYNAMIC_RECALL_SEED_CAP);
    let added = 0;
    for (const seed of seeds) {
      if (added >= DYNAMIC_RECALL_PLANE_CAP) {
        return;
      }
      let edges: readonly Readonly<MemoryGraphEdge>[];
      try {
        edges = await graphExpansionPort.findByMemoryId(seed.entry.object_id, params.workspaceId);
      } catch (error) {
        this.warn("graph expansion lookup failed", {
          workspace_id: params.workspaceId,
          seed_memory_id: seed.entry.object_id,
          error: toErrorMessage(error)
        });
        continue;
      }
      for (const edge of edges.slice(0, DYNAMIC_RECALL_EDGE_FANOUT)) {
        const neighborId = edge.source_memory_id === seed.entry.object_id
          ? edge.target_memory_id
          : edge.source_memory_id;
        const entry = params.byId.get(neighborId);
        if (entry === undefined) {
          continue;
        }
        params.addCandidate(entry, "graph_expansion", scoreGraphExpansionEdge(edge), "graph_expansion");
        added += 1;
        if (added >= DYNAMIC_RECALL_PLANE_CAP) {
          return;
        }
      }
    }
  }

  private async addPathExpansionCandidates(params: Readonly<{
    readonly workspaceId: string;
    readonly byId: ReadonlyMap<string, Readonly<MemoryEntry>>;
    readonly drafts: ReadonlyMap<string, CoarseCandidateDraft>;
    readonly queryProbes: Readonly<RecallQueryProbes>;
    readonly addCandidate: CoarseCandidateAdder;
  }>): Promise<void> {
    const pathExpansionPort = this.dependencies.pathExpansionPort;
    if (pathExpansionPort === undefined) {
      return;
    }

    let added = await this.addTimeConcernPathExpansionCandidates(params);
    if (added >= DYNAMIC_RECALL_PLANE_CAP || params.drafts.size === 0) {
      return;
    }

    const seeds = selectExpansionSeedDrafts(params.drafts).slice(0, DYNAMIC_RECALL_SEED_CAP);
    if (seeds.length === 0) {
      return;
    }
    const seedIds = new Set(seeds.map((seed) => seed.entry.object_id));
    const anchors: PathAnchorRef[] = seeds.map((seed) => ({
      kind: "object",
      object_id: seed.entry.object_id
    }));
    let paths: readonly Readonly<PathRelation>[];
    try {
      paths = await pathExpansionPort.findByAnchors(params.workspaceId, anchors);
    } catch (error) {
      this.warn("path expansion lookup failed", {
        workspace_id: params.workspaceId,
        seed_count: seeds.length,
        error: toErrorMessage(error)
      });
      return;
    }

    for (const path of paths) {
      if (added >= DYNAMIC_RECALL_PLANE_CAP) {
        return;
      }
      if (isRetiredPathRelation(path)) {
        continue;
      }
      for (const target of directionEligiblePathExpansionTargets(path, seedIds)) {
        const entry = params.byId.get(target.targetId);
        if (entry === undefined) {
          continue;
        }
        params.addCandidate(
          entry,
          "path_expansion",
          scorePathRelationExpansion(path),
          "path_expansion",
          {
            path_id: path.path_id,
            seed_id: target.seedId,
            seed_kind: "memory",
            target_object_id: target.targetId,
            source_channel: "path_expansion"
          }
        );
        added += 1;
        if (added >= DYNAMIC_RECALL_PLANE_CAP) {
          return;
        }
      }
    }
  }

  private async addTimeConcernPathExpansionCandidates(params: Readonly<{
    readonly workspaceId: string;
    readonly byId: ReadonlyMap<string, Readonly<MemoryEntry>>;
    readonly queryProbes: Readonly<RecallQueryProbes>;
    readonly addCandidate: CoarseCandidateAdder;
  }>): Promise<number> {
    const pathExpansionPort = this.dependencies.pathExpansionPort;
    const findByTimeConcernWindowDigests = pathExpansionPort?.findByTimeConcernWindowDigests;
    if (findByTimeConcernWindowDigests === undefined || params.queryProbes.date_terms.length === 0) {
      return 0;
    }

    const windowDigests = uniqueStrings(
      params.queryProbes.date_terms
        .map((term) => normalizeTimeConcernWindowDigest(term))
        .filter((term) => term.length > 0)
    );
    if (windowDigests.length === 0) {
      return 0;
    }

    let paths: readonly Readonly<PathRelation>[];
    try {
      paths = await findByTimeConcernWindowDigests.call(
        pathExpansionPort,
        params.workspaceId,
        windowDigests
      );
    } catch (error) {
      this.warn("time concern path expansion lookup failed", {
        workspace_id: params.workspaceId,
        window_digest_count: windowDigests.length,
        error: toErrorMessage(error)
      });
      return 0;
    }

    let added = 0;
    for (const path of paths) {
      if (added >= DYNAMIC_RECALL_PLANE_CAP) {
        return added;
      }
      if (isRetiredPathRelation(path) || !pathMatchesTimeConcernWindowDigest(path, windowDigests)) {
        continue;
      }
      for (const targetId of pathRelationMemoryIds(path)) {
        const entry = params.byId.get(targetId);
        if (entry === undefined) {
          continue;
        }
        params.addCandidate(
          entry,
          "path_expansion",
          scorePathRelationExpansion(path),
          "time_concern",
          {
            path_id: path.path_id,
            seed_id: firstTimeConcernSeedId(path, windowDigests),
            seed_kind: "time_concern",
            target_object_id: targetId,
            source_channel: "time_concern"
          }
        );
        added += 1;
        if (added >= DYNAMIC_RECALL_PLANE_CAP) {
          return added;
        }
      }
    }
    return added;
  }

  private async expandTierCascade(params: {
    readonly workspaceId: string;
    readonly runId: string | null;
    readonly config: Readonly<RecallPolicy>["coarse_filter"];
    readonly fineAssessmentConfig: Readonly<FineAssessmentConfig>;
    readonly queryText: string | null;
    readonly queryProbes: Readonly<RecallQueryProbes>;
    readonly hotCoarseFilter: Awaited<ReturnType<RecallService["coarseFilter"]>>;
    readonly hotFineAssessmentCount: number;
    readonly winnerMemoryIds: ReadonlySet<string>;
    readonly timeFilter?: RecallTimeFilter;
  }): Promise<Awaited<ReturnType<RecallService["coarseFilter"]>>> {
    const targetCount = Math.min(MIN_RECALL_RESULTS, params.fineAssessmentConfig.budgets.max_entries);
    if (targetCount === 0) {
      return params.hotCoarseFilter;
    }

    if (params.hotFineAssessmentCount >= targetCount) {
      return params.hotCoarseFilter;
    }

    const projectMappings =
      this.dependencies.projectMappingPort?.findByWorkspace === undefined
        ? []
        : await this.dependencies.projectMappingPort.findByWorkspace(params.workspaceId);
    const warmFilter = await this.coarseFilter(params.workspaceId, params.config, params.queryText, {
      tier: StorageTier.WARM,
      projectMappings,
      sourceChannel: "warm_cascade",
      scoreMultiplier: WARM_CASCADE_DECAY,
      timeFilter: params.timeFilter,
      queryProbes: params.queryProbes,
      winnerMemoryIds: params.winnerMemoryIds,
      deliveryMaxEntries: params.fineAssessmentConfig.budgets.max_entries
    });
    const warmMerged = this.mergeCoarseFilters(params.hotCoarseFilter, warmFilter, "warm_cascade_engaged");
    // Use coarse-filter candidate counts for cascade gates; supplementary
    // graph/plasticity/embedding lookups run once on the final merged filter.
    if (warmMerged.candidates.length >= targetCount) {
      return warmMerged;
    }

    const coldFilter = await this.coarseFilter(params.workspaceId, params.config, params.queryText, {
      tier: StorageTier.COLD,
      projectMappings,
      sourceChannel: "cold_cascade",
      scoreMultiplier: COLD_CASCADE_DECAY,
      timeFilter: params.timeFilter,
      queryProbes: params.queryProbes,
      winnerMemoryIds: params.winnerMemoryIds,
      deliveryMaxEntries: params.fineAssessmentConfig.budgets.max_entries
    });
    return this.mergeCoarseFilters(warmMerged, coldFilter, "cold_cascade_engaged");
  }

  private async assessCoarseFilter(params: {
    readonly coarseFilter: Awaited<ReturnType<RecallService["coarseFilter"]>>;
    readonly workspaceId: string;
    readonly runId: string | null;
    readonly queryText: string | null;
    readonly queryProbes: Readonly<RecallQueryProbes>;
    readonly policy: Readonly<RecallPolicy>;
    readonly winnerMemoryIds: ReadonlySet<string>;
    readonly tokenEstimator: TokenEstimator;
  }): Promise<Readonly<{
    readonly supplementaryData: RecallSupplementaryData;
    readonly candidates: readonly Readonly<RecallCandidate>[];
    readonly diagnostics: readonly Readonly<RecallCandidateDiagnostic>[];
  }>> {
    const supplementaryData = await this.collectSupplementaryData({
      candidates: params.coarseFilter.candidates.map((candidate) => candidate.entry),
      workspaceId: params.workspaceId,
      runId: params.runId,
      queryText: params.queryText,
      queryProbes: params.queryProbes,
      policy: params.policy,
      coarseFtsRanks: params.coarseFilter.ftsRanks,
      coarseSynthesisFtsRanks: params.coarseFilter.synthesisFtsRanks,
      coarseEvidenceFtsRanks: params.coarseFilter.evidenceFtsRanks,
      coarseSourceProximityScores: params.coarseFilter.sourceProximityScores,
      coarseSourceCohortKeys: params.coarseFilter.sourceCohortKeys,
      coarseStructuralScores: params.coarseFilter.structuralScores,
      coarseGraphExpansionScores: params.coarseFilter.graphExpansionScores,
      coarsePathExpansionScores: params.coarseFilter.pathExpansionScores
    });
    const assessment = this.fineAssess(
      params.coarseFilter.candidates,
      params.policy,
      params.winnerMemoryIds,
      supplementaryData,
      params.tokenEstimator
    );

    return Object.freeze({
      supplementaryData,
      candidates: assessment.candidates,
      diagnostics: assessment.diagnostics
    });
  }

  private mergeCoarseFilters(
    current: Awaited<ReturnType<RecallService["coarseFilter"]>>,
    next: Awaited<ReturnType<RecallService["coarseFilter"]>>,
    degradationReason: NonNullable<RecallResult["degradation_reason"]>
  ): Awaited<ReturnType<RecallService["coarseFilter"]>> {
    const seen = new Set(current.candidates.map((candidate) => buildRecallCandidateDedupeKey(candidate)));
    const nextCandidates = next.candidates.filter((candidate) => {
      const key = buildRecallCandidateDedupeKey(candidate);
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });

    return Object.freeze({
      total_scanned: current.total_scanned + next.total_scanned,
      candidates: Object.freeze([...current.candidates, ...nextCandidates]),
      ftsRanks: Object.freeze({
        ...current.ftsRanks,
        ...next.ftsRanks
      }),
      synthesisFtsRanks: Object.freeze({
        ...current.synthesisFtsRanks,
        ...next.synthesisFtsRanks
      }),
      evidenceFtsRanks: Object.freeze({
        ...current.evidenceFtsRanks,
        ...next.evidenceFtsRanks
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
      graphExpansionScores: Object.freeze({
        ...current.graphExpansionScores,
        ...next.graphExpansionScores
      }),
      pathExpansionScores: Object.freeze({
        ...current.pathExpansionScores,
        ...next.pathExpansionScores
      }),
      degradation_reason: degradationReason
    });
  }

  private async collectSupplementaryData(params: {
    readonly candidates: readonly Readonly<MemoryEntry>[];
    readonly workspaceId: string;
    readonly runId: string | null;
    readonly queryText: string | null;
    readonly queryProbes: Readonly<RecallQueryProbes>;
    readonly policy: Readonly<RecallPolicy>;
    readonly coarseFtsRanks: Readonly<Record<string, number>>;
    readonly coarseSynthesisFtsRanks: Readonly<Record<string, number>>;
    readonly coarseEvidenceFtsRanks: Readonly<Record<string, number>>;
    readonly coarseSourceProximityScores: Readonly<Record<string, number>>;
    readonly coarseSourceCohortKeys: Readonly<Record<string, string>>;
    readonly coarseStructuralScores: Readonly<Record<string, number>>;
    readonly coarseGraphExpansionScores: Readonly<Record<string, number>>;
    readonly coarsePathExpansionScores: Readonly<Record<string, number>>;
  }): Promise<RecallSupplementaryData> {
    // graph_support is a weighted inbound aggregate across edge types; the
    // storage repo owns the concrete edge_type weight map.
    const graphSupportCounts: Record<string, number> = Object.fromEntries(
      await Promise.all(
        params.candidates.map(async (candidate): Promise<readonly [string, number]> => {
          const count =
            this.dependencies.graphSupportPort === undefined
              ? 0
              : await this.dependencies.graphSupportPort.countInboundEdgesWeighted(
                  candidate.object_id,
                  params.workspaceId
                );
          return [
            candidate.object_id,
            count
          ];
        })
      )
    );
    const recallEdgeCounts: Record<string, number> = Object.fromEntries(
      await Promise.all(
        params.candidates.map(async (candidate): Promise<readonly [string, number]> => {
          const count =
            this.dependencies.graphSupportPort?.countInboundRecalls === undefined
              ? 0
              : await this.dependencies.graphSupportPort.countInboundRecalls(
                  candidate.object_id,
                  params.workspaceId
                );
          return [
            candidate.object_id,
            count
          ];
        })
      )
    );

    let budgetPenaltyFactor = 0;
    if (params.runId !== null && this.dependencies.budgetPenaltyPort !== undefined) {
      const snapshot = await this.dependencies.budgetPenaltyPort.getSnapshot(params.runId);
      budgetPenaltyFactor = mapBudgetPenalty(snapshot);
    }

    let plasticityFactors: Readonly<Record<string, number>> = Object.freeze({});
    if (this.dependencies.pathPlasticityPort !== undefined && params.candidates.length > 0) {
      try {
        const strengthMap = await this.dependencies.pathPlasticityPort.getStrengthByMemoryId(
          params.workspaceId,
          params.candidates.map((candidate) => candidate.object_id)
        );
        plasticityFactors = Object.freeze(
          Object.fromEntries(
            [...strengthMap.entries()].map(([memoryId, strength]) => [memoryId, clamp01(strength)])
          )
        );
      } catch (error) {
        // Plasticity is a recall supplement; a port failure must not block
        // the recall request. Fall back to no plasticity boost.
        this.warn("path plasticity port lookup failed", {
          workspace_id: params.workspaceId,
          candidate_count: params.candidates.length,
          error: toErrorMessage(error)
        });
      }
    }

    const graphAndPathCold =
      params.candidates.length > 0 &&
      params.candidates.every(
        (candidate) =>
          normalizeGraphSupport(graphSupportCounts[candidate.object_id] ?? 0) === 0 &&
          clamp01(plasticityFactors[candidate.object_id] ?? 0) === 0
      );
    const recallsEdgeCount = Object.values(recallEdgeCounts).reduce((sum, count) => sum + count, 0);
    const recallsColdScore =
      this.dependencies.graphSupportPort?.countInboundRecalls === undefined
        ? (graphAndPathCold ? 1 : 0)
        : clamp01(1 - recallsEdgeCount / RECALLS_EDGE_COLD_THRESHOLD);
    const graphAndPathColdScore = graphAndPathCold ? recallsColdScore : 0;
    const weightTransferAmount = this.computeMaxWeightTransferAmount(
      params.candidates,
      params.policy,
      graphAndPathColdScore
    );

    return Object.freeze({
      queryProbes: params.queryProbes,
      ftsRanks: params.coarseFtsRanks,
      synthesisFtsRanks: params.coarseSynthesisFtsRanks,
      evidenceFtsRanks: params.coarseEvidenceFtsRanks,
      sourceProximityScores: params.coarseSourceProximityScores,
      sourceCohortKeys: params.coarseSourceCohortKeys,
      structuralScores: params.coarseStructuralScores,
      graphExpansionScores: params.coarseGraphExpansionScores,
      pathExpansionScores: params.coarsePathExpansionScores,
      embeddingSimilarityScores: Object.freeze({}),
      graphSupportCounts: Object.freeze(graphSupportCounts),
      budgetPenaltyFactor,
      plasticityFactors,
      graphAndPathColdScore,
      recallsEdgeCount,
      weightTransferAmount
    });
  }

  private computeMaxWeightTransferAmount(
    candidates: readonly Readonly<MemoryEntry>[],
    policy: Readonly<RecallPolicy>,
    graphAndPathColdScore: number
  ): number {
    if (candidates.length === 0 || graphAndPathColdScore <= 0) {
      return 0;
    }
    const additiveWeights = resolveAdditiveScoringWeights(policy);
    return clamp01(
      Math.max(
        ...candidates.map((candidate) => {
          const weights = this.resolveEffectiveActivationWeights(candidate, policy);
          return (weights.graph_support + additiveWeights.PATH_PLASTICITY_WEIGHT) * graphAndPathColdScore;
        })
      )
    );
  }

  private async appendWeightTransferTelemetry(input: Readonly<{
    readonly workspaceId: string;
    readonly runId: string | null;
    readonly graphAndPathColdScore: number;
    readonly recallsEdgeCount: number;
    readonly weightTransferAmount: number;
  }>): Promise<void> {
    if (input.weightTransferAmount <= 0) {
      return;
    }
    try {
      await this.dependencies.eventLogRepo.append({
        event_type: RecallContextEventType.SOUL_RECALL_WEIGHT_TRANSFER,
        entity_type: "recall_weight_transfer",
        entity_id: input.runId ?? input.workspaceId,
        workspace_id: input.workspaceId,
        run_id: input.runId,
        caused_by: "system",
        payload_json: SoulRecallWeightTransferPayloadSchema.parse({
          workspace_id: input.workspaceId,
          run_id: input.runId,
          cold_score: clamp01(input.graphAndPathColdScore),
          recalls_edge_count: Math.max(0, Math.trunc(input.recallsEdgeCount)),
          recalls_threshold: RECALLS_EDGE_COLD_THRESHOLD,
          transferred_amount: clamp01(input.weightTransferAmount),
          occurred_at: this.now()
        })
      });
    } catch (error) {
      this.warn("recall weight transfer telemetry append failed", {
        workspace_id: input.workspaceId,
        run_id: input.runId,
        error: toErrorMessage(error)
      });
    }
  }

  private async collectEmbeddingSupplement(params: {
    readonly baseCandidateIds: readonly string[];
    readonly localEligibleCandidates: readonly Readonly<CoarseRecallCandidate>[];
    readonly config: Readonly<RecallPolicy>;
    readonly workspaceId: string;
    readonly runId: string | null;
    readonly queryText: string | null;
    readonly preparedEmbeddingQuery: PreparedEmbeddingQueryHandle | null;
    readonly preparedStoredVectors: PreparedEmbeddingSupplement["storedVectors"] | null;
  }): Promise<EmbeddingRecallSupplementResult> {
    const embeddingRecallService = this.dependencies.embeddingRecallService;
    if (
      embeddingRecallService === undefined ||
      params.queryText === null ||
      params.config.coarse_filter.semantic_supplement.embedding_enabled !== true ||
      params.config.coarse_filter.semantic_supplement.max_supplement <= 0 ||
      params.localEligibleCandidates.length === 0
    ) {
      return emptyEmbeddingSupplementResult();
    }

    if (
      params.preparedEmbeddingQuery === null ||
      typeof embeddingRecallService.querySupplementIfReady !== "function"
    ) {
      return emptyEmbeddingSupplementResult();
    }

    const supplement = await embeddingRecallService.querySupplementIfReady({
      workspaceId: params.workspaceId,
      runId: params.runId,
      eligibleMemories: params.localEligibleCandidates.map((candidate) => candidate.entry),
      baseCandidateIds: params.baseCandidateIds,
      maxSupplement: params.config.coarse_filter.semantic_supplement.max_supplement,
      preparedQuery: params.preparedEmbeddingQuery,
      ...(params.preparedStoredVectors === null
        ? {}
        : { storedVectors: params.preparedStoredVectors })
    });

    return supplement;
  }

  private async collectSynthesisCoarseCandidates(params: {
    readonly workspaceId: string;
    readonly queryText: string | null;
    readonly queryProbes: Readonly<RecallQueryProbes>;
    readonly policy: Readonly<RecallPolicy>;
  }): Promise<Readonly<{
    readonly candidates: readonly Readonly<CoarseRecallCandidate>[];
    readonly synthesisFtsRanks: Readonly<Record<string, number>>;
  }>> {
    const synthesisSearchPort = this.dependencies.synthesisSearchPort;
    if (synthesisSearchPort === undefined || params.queryText === null) {
      return emptySynthesisCoarseFilter();
    }
    const limit = params.policy.coarse_filter.semantic_supplement.max_supplement;
    if (limit <= 0) {
      return emptySynthesisCoarseFilter();
    }
    try {
      const rankById = new Map<string, number>();
      for (const synthesisQuery of buildEvidenceSearchQueries(
        params.queryText,
        params.queryProbes
      )) {
        const matches = await synthesisSearchPort.searchByKeyword(
          params.workspaceId,
          synthesisQuery,
          limit
        );
        for (const match of matches) {
          rankById.set(
            match.object_id,
            Math.max(rankById.get(match.object_id) ?? 0, clamp01(match.normalized_rank))
          );
        }
      }
      if (rankById.size === 0) {
        return emptySynthesisCoarseFilter();
      }
      const synthesisRows = await synthesisSearchPort.findByIds([...rankById.keys()]);
      const candidates = synthesisRows
        .filter((synthesis) => synthesis.workspace_id === params.workspaceId)
        .map((synthesis) =>
          buildSynthesisCoarseRecallCandidate({
            synthesis,
            normalizedRank: rankById.get(synthesis.object_id) ?? 0
          })
        )
        .sort((left, right) => {
          const leftRank = rankById.get(left.entry.object_id) ?? 0;
          const rightRank = rankById.get(right.entry.object_id) ?? 0;
          const delta = rightRank - leftRank;
          return delta !== 0 ? delta : compareMemoryEntries(left.entry, right.entry);
        });
      return Object.freeze({
        candidates: Object.freeze(candidates),
        synthesisFtsRanks: Object.freeze(
          Object.fromEntries(
            candidates.map((candidate) => [
              candidate.entry.object_id,
              rankById.get(candidate.entry.object_id) ?? 0
            ] as const)
          )
        )
      });
    } catch (error) {
      this.warn("synthesis FTS lookup failed", {
        workspace_id: params.workspaceId,
        error: toErrorMessage(error)
      });
      return emptySynthesisCoarseFilter();
    }
  }

  private async prepareEmbeddingSupplementQuery(params: {
    readonly config: Readonly<RecallPolicy>;
    readonly workspaceId: string;
    readonly runId: string | null;
    readonly queryText: string | null;
    readonly localEligibleCandidates: readonly Readonly<CoarseRecallCandidate>[];
    readonly lexicalFallbackCount: number;
  }): Promise<Readonly<{
    readonly handle: PreparedEmbeddingQueryHandle | null;
    readonly storedVectors: PreparedEmbeddingSupplement["storedVectors"] | null;
    readonly degradedReason: string | null;
  }>> {
    const embeddingRecallService = this.dependencies.embeddingRecallService;
    const hasSupplementPreparation =
      typeof embeddingRecallService?.prepareQuerySupplement === "function" ||
      typeof embeddingRecallService?.prepareQueryEmbedding === "function";
    if (
      embeddingRecallService === undefined ||
      !hasSupplementPreparation ||
      params.queryText === null ||
      params.config.coarse_filter.semantic_supplement.embedding_enabled !== true ||
      params.config.coarse_filter.semantic_supplement.max_supplement <= 0 ||
      params.localEligibleCandidates.length === 0
    ) {
      return Object.freeze({ handle: null, storedVectors: null, degradedReason: null });
    }

    if (typeof embeddingRecallService.prepareQuerySupplement === "function") {
      const prepared = await embeddingRecallService.prepareQuerySupplement({
        workspaceId: params.workspaceId,
        runId: params.runId,
        queryText: params.queryText,
        eligibleMemories: params.localEligibleCandidates.map((candidate) => candidate.entry),
        baseCandidateCount: params.lexicalFallbackCount
      });
      return Object.freeze({
        handle: prepared.preparedQuery,
        storedVectors: prepared.storedVectors,
        degradedReason:
          prepared.degradedReason === null
            ? null
            : normalizeEmbeddingProviderDegradationReason(prepared.degradedReason)
      });
    }

    const prepareQueryEmbedding = embeddingRecallService.prepareQueryEmbedding;
    if (typeof prepareQueryEmbedding !== "function") {
      return Object.freeze({ handle: null, storedVectors: null, degradedReason: null });
    }

    if (typeof embeddingRecallService.hasStoredVectors === "function") {
      let hasStoredVectors: boolean;
      try {
        hasStoredVectors = await embeddingRecallService.hasStoredVectors({
          workspaceId: params.workspaceId,
          eligibleMemories: params.localEligibleCandidates.map((candidate) => candidate.entry)
        });
      } catch (error) {
        const reason = parseEmbeddingPrecheckReason(error);

        if (reason === null) {
          throw error;
        }

        await embeddingRecallService.recordPrecheckDegraded?.({
          workspaceId: params.workspaceId,
          runId: params.runId,
          reason,
          baseCandidateCount: params.lexicalFallbackCount,
          fallbackCandidateCount: params.lexicalFallbackCount
        });
        return Object.freeze({
          handle: null,
          storedVectors: null,
          degradedReason: normalizeEmbeddingProviderDegradationReason(reason)
        });
      }

      if (!hasStoredVectors) {
        return Object.freeze({ handle: null, storedVectors: null, degradedReason: null });
      }
    }

    return Object.freeze({
      handle: prepareQueryEmbedding({
        workspaceId: params.workspaceId,
        runId: params.runId,
        queryText: params.queryText
      }),
      storedVectors: null,
      degradedReason: null
    });
  }

  private fineAssess(
    candidates: readonly Readonly<CoarseRecallCandidate>[],
    policy: Readonly<RecallPolicy>,
    winnerMemoryIds: ReadonlySet<string>,
    supplementaryData: RecallSupplementaryData,
    tokenEstimator: TokenEstimator
  ): Readonly<{
    readonly candidates: readonly Readonly<RecallCandidate>[];
    readonly diagnostics: readonly Readonly<RecallCandidateDiagnostic>[];
  }> {
    if (candidates.length === 0) {
      return Object.freeze({
        candidates: Object.freeze([]),
        diagnostics: Object.freeze([])
      });
    }
    const config = policy.fine_assessment;

    const additiveScoredCandidates = candidates.map((candidate) => {
      const scored = this.computeEffectiveScoreDetails(
        candidate.entry,
        policy,
        winnerMemoryIds,
        supplementaryData,
        candidate.originPlane ?? "workspace_local",
        candidate.isAdvisory ?? false,
        candidate.scoreMultiplier ?? 1,
        candidate.objectKind ?? "memory_entry"
      );
      return Object.freeze({
        ...candidate,
        effectiveScore: scored.score,
        effectiveFactors: scored.factors
      });
    });
    const fusionByCandidateKey = buildRecallFusionDetails({
      candidates: additiveScoredCandidates,
      policy,
      supplementaryData,
      nowIso: this.now()
    });
    const scoredCandidates = additiveScoredCandidates.map((candidate) => Object.freeze({
      ...candidate,
      fusion: fusionByCandidateKey.get(buildRecallCandidateDedupeKey(candidate)) ?? buildEmptyRecallFusionBreakdown(candidate.entry.object_id)
    }));
    const rankedCandidates = scoredCandidates
      .sort(compareFusedRecallCandidates);
    const featureRerankedCandidates = applyFeatureRerank(rankedCandidates, supplementaryData);
    const deliveryOrderedCandidates = reserveSynthesisDeliverySlots(
      prioritizeStrongLexicalDeliveryWindowCandidates(
        featureRerankedCandidates,
        supplementaryData,
        config.budgets.max_entries
      ),
      supplementaryData,
      config.budgets.max_entries
    );

    type FineAssessmentAccumulator = {
      readonly selected: readonly Readonly<RecallCandidate>[];
      readonly diagnostics: readonly Readonly<RecallCandidateDiagnostic>[];
      readonly seen: ReadonlySet<string>;
      readonly perDimensionCounts: ReadonlyMap<MemoryDimensionType, number>;
      readonly totalTokens: number;
    };

    const initialAccumulator: FineAssessmentAccumulator = {
      selected: Object.freeze([]),
      diagnostics: Object.freeze([]),
      seen: new Set<string>(),
      perDimensionCounts: new Map<MemoryDimensionType, number>(),
      totalTokens: 0
    };

    const appendCandidate = (
      accumulator: FineAssessmentAccumulator,
      candidate: Readonly<CoarseRecallCandidate & {
        readonly effectiveScore: number;
        readonly effectiveFactors: RecallScoreFactors;
        readonly fusion: RecallFusionBreakdown;
      }>,
      selectionOrder: number
    ): FineAssessmentAccumulator => {
      const entry = candidate.entry;
      const objectKind = candidate.objectKind ?? "memory_entry";
      const candidateKey = buildRecallCandidateDedupeKey(candidate);
      const originPlane = candidate.originPlane ?? "workspace_local";
      const scoreFactors = candidate.effectiveFactors;
      const createDiagnostic = (
        droppedReason: RecallCandidateDropReason | null,
        finalRank: number | null
      ): Readonly<RecallCandidateDiagnostic> => {
        const admissionPlanes = Object.freeze([...(candidate.admissionPlanes ?? ["activation"])]);
        const attributionPlane = selectRecallAdmissionAttributionPlane(
          admissionPlanes,
          candidate.firstAdmissionPlane
        );
        return Object.freeze({
          candidate_key: candidateKey,
          object_id: entry.object_id,
          object_kind: objectKind,
          origin_plane: originPlane,
          admission_planes: admissionPlanes,
          plane_first_admitted: candidate.firstAdmissionPlane ?? admissionPlanes[0] ?? "activation",
          plane_winning_admission: attributionPlane,
          pre_budget_rank: candidate.fusion.fused_rank,
          selection_order: selectionOrder,
          fused_rank: candidate.fusion.fused_rank,
          fused_score: candidate.fusion.fused_score,
          per_stream_rank: candidate.fusion.per_stream_rank,
          fused_rank_contribution_per_stream: candidate.fusion.fused_rank_contribution_per_stream,
          final_rank: finalRank,
          dropped_reason: droppedReason,
          within_budget: droppedReason === null,
          relevance_score: candidate.effectiveScore,
          lexical_rank: candidate.objectKind === "synthesis_capsule"
            ? supplementaryData.synthesisFtsRanks[entry.object_id] ?? null
            : supplementaryData.ftsRanks[entry.object_id] ?? null,
          structural_score: clamp01(candidate.structuralScore ?? supplementaryData.structuralScores[entry.object_id] ?? 0),
          score_factors: scoreFactors,
          source_channels: Object.freeze(uniqueStrings([
            candidate.originPlane ?? "workspace_local",
            candidate.sourceChannel ?? "",
            ...(candidate.sourceChannels ?? []),
            ...((scoreFactors.embedding_similarity ?? 0) > 0 ? ["semantic_supplement"] : []),
            ...(admissionPlanes).map((plane) => `plane:${plane}`)
          ].filter((channel) => channel.length > 0))),
          path_expansion_sources: Object.freeze([...(candidate.pathExpansionSources ?? [])])
        });
      };

      if (accumulator.seen.has(candidateKey)) {
        return {
          ...accumulator,
          diagnostics: Object.freeze([
            ...accumulator.diagnostics,
            createDiagnostic("duplicate", null)
          ])
        };
      }

      const tokenEstimate = tokenEstimator.estimate(entry.content);
      const dimensionCount = accumulator.perDimensionCounts.get(entry.dimension) ?? 0;
      const dimensionLimit = config.budgets.per_dimension_limits?.[entry.dimension] ?? null;
      const nextEntryCount = accumulator.selected.length + 1;
      const nextTokenCount = accumulator.totalTokens + tokenEstimate;

      if (dimensionLimit !== null && dimensionCount >= dimensionLimit) {
        return {
          ...accumulator,
          diagnostics: Object.freeze([
            ...accumulator.diagnostics,
            createDiagnostic("dimension_limit", null)
          ])
        };
      }

      if (nextEntryCount > config.budgets.max_entries) {
        return {
          ...accumulator,
          diagnostics: Object.freeze([
            ...accumulator.diagnostics,
            createDiagnostic("max_entries", null)
          ])
        };
      }

      if (nextTokenCount > config.budgets.max_total_tokens) {
        return {
          ...accumulator,
          diagnostics: Object.freeze([
            ...accumulator.diagnostics,
            createDiagnostic("max_total_tokens", null)
          ])
        };
      }

      const nextCandidate = buildRecallCandidate({
        candidate,
        relevanceScore: candidate.effectiveScore,
        scoreFactors,
        tokenEstimator,
        tokenEstimate,
        budgets: config.budgets,
        index: accumulator.selected.length,
        usedTokensBeforeCandidate: accumulator.totalTokens
      });

      return {
        selected: Object.freeze([...accumulator.selected, nextCandidate]),
        diagnostics: Object.freeze([
          ...accumulator.diagnostics,
          createDiagnostic(null, accumulator.selected.length + 1)
        ]),
        seen: new Set([...accumulator.seen, candidateKey]),
        perDimensionCounts: new Map([
          ...accumulator.perDimensionCounts,
          [entry.dimension, dimensionCount + 1]
        ]),
        totalTokens: nextTokenCount
      };
    };

    const finalAccumulator = deliveryOrderedCandidates.reduce(
      (accumulator, candidate, index) => appendCandidate(accumulator, candidate, index + 1),
      initialAccumulator
    );

    return Object.freeze({
      candidates: Object.freeze([...finalAccumulator.selected]),
      diagnostics: Object.freeze([...finalAccumulator.diagnostics])
    });
  }

  private computeEffectiveScoreDetails(
    entry: Readonly<MemoryEntry>,
    policy: Readonly<RecallPolicy>,
    winnerMemoryIds: ReadonlySet<string>,
    supplementaryData: RecallSupplementaryData,
    originPlane: RecallOriginPlane,
    isAdvisory: boolean,
    scoreMultiplier = 1,
    objectKind: RecallCandidate["object_kind"] = "memory_entry"
  ): Readonly<{ readonly score: number; readonly factors: RecallScoreFactors }> {
    const config = policy.fine_assessment;
    const additiveWeights = resolveAdditiveScoringWeights(policy);
    const weights = resolveDynamicActivationWeights(
      this.resolveEffectiveActivationWeights(entry, policy),
      supplementaryData.graphAndPathColdScore,
      additiveWeights.PATH_PLASTICITY_WEIGHT
    );
    const isGlobalCandidate = originPlane === "global";
    const isSynthesisCandidate = objectKind === "synthesis_capsule";
    const canUseMemorySupplement = !isGlobalCandidate && !isSynthesisCandidate;
    const activationScore = normalizeActivationScore(entry.activation_score);
    const ftsFactor = canUseMemorySupplement ? supplementaryData.ftsRanks[entry.object_id] ?? 0 : 0;
    const synthesisFtsFactor =
      isGlobalCandidate || !isSynthesisCandidate
        ? 0
        : supplementaryData.synthesisFtsRanks[entry.object_id] ?? 0;
    const structuralFactor = canUseMemorySupplement ? supplementaryData.structuralScores[entry.object_id] ?? 0 : 0;
    const queryFtsFactor = Math.max(ftsFactor, synthesisFtsFactor);
    const relevanceFactor =
      queryFtsFactor > 0 && structuralFactor > 0
        ? clamp01(queryFtsFactor * 0.24 + structuralFactor * 0.76)
        : Math.max(queryFtsFactor * 0.62, structuralFactor);
    const graphSupportFactor = canUseMemorySupplement
      ? normalizeGraphSupport(supplementaryData.graphSupportCounts[entry.object_id] ?? 0)
      : 0;
    const embeddingSimilarityFactor = canUseMemorySupplement
      ? clamp01(supplementaryData.embeddingSimilarityScores[entry.object_id] ?? 0)
      : 0;
    const budgetPenalty = supplementaryData.budgetPenaltyFactor;
    // PathPlasticity is supplementary, like the embedding similarity hint:
    // it boosts the score additively but the final value is still clamp01,
    // so a small plasticity boost cannot override a large lexical-rank gap.
    const plasticityFactor = canUseMemorySupplement
      ? clamp01(supplementaryData.plasticityFactors[entry.object_id] ?? 0)
      : 0;
    const conflictPenalty =
      config.conflict_awareness &&
      isClaimLikeDimension(entry.dimension) &&
      !winnerMemoryIds.has(entry.object_id)
        ? 1
        : 0;
    // invariant: contradiction-history degradation. ConflictDetectionService
    // increments MemoryEntry.contradiction_count each time a new memory
    // supersedes or contradicts this one. Recall scoring subtracts a small
    // bounded factor so memories that keep losing arbitration drift down
    // without being tombstoned. Cap at 5 to keep the penalty bounded.
    const contradictionCount = entry.contradiction_count ?? 0;
    const contradictionPenalty = clamp01(0.05 * Math.min(contradictionCount, 5));
    const confidenceFactor = clamp01(entry.confidence ?? 0);

    const baseWeight =
      (isAdvisory ? 0 : weights.scope_match) +
      weights.domain_match +
      weights.retention +
      weights.freshness;
    const pathPlasticityWeight =
      additiveWeights.PATH_PLASTICITY_WEIGHT * (1 - supplementaryData.graphAndPathColdScore);
    const fusionWeights = resolveFusionScoringWeights(policy);
    const queryEvidenceTransfer = computeQueryEvidenceBaseTransfer(
      baseWeight,
      relevanceFactor,
      fusionWeights
    );
    const adjustedBaseWeight = Math.max(0, baseWeight - queryEvidenceTransfer);
    const weightedActivation = activationScore * adjustedBaseWeight;
    const weightedRelevance = relevanceFactor * weights.relevance;
    const weightedRelevanceDirect =
      relevanceFactor * additiveWeights.NO_EMBEDDING_RELEVANCE_DIRECT_WEIGHT;
    const weightedQueryEvidenceTransfer = relevanceFactor * queryEvidenceTransfer;
    const weightedGraphSupport = graphSupportFactor * weights.graph_support;
    const weightedEmbeddingSimilarity = embeddingSimilarityFactor * EMBEDDING_SIMILARITY_WEIGHT;
    const weightedPathPlasticity = plasticityFactor * pathPlasticityWeight;
    const weightedConfidence = confidenceFactor * additiveWeights.CONFIDENCE_DIRECT_WEIGHT;
    const weightedBudgetPenalty = budgetPenalty * weights.budget_penalty;
    const weightedConflictPenalty = conflictPenalty * weights.conflict_penalty;

    const rawScore = clamp01(
      weightedActivation +
        weightedRelevance +
        weightedRelevanceDirect +
        weightedQueryEvidenceTransfer +
        weightedGraphSupport +
        weightedEmbeddingSimilarity +
        weightedPathPlasticity +
        weightedConfidence -
        weightedBudgetPenalty -
        weightedConflictPenalty -
        contradictionPenalty
    );
    const score = clamp01(rawScore * scoreMultiplier);

    return Object.freeze({
      score,
      factors: Object.freeze({
        activation: activationScore,
        relevance: score,
        graph_support: graphSupportFactor,
        ...(embeddingSimilarityFactor > 0 ? { embedding_similarity: embeddingSimilarityFactor } : {}),
        path_plasticity: plasticityFactor,
        budget_penalty: budgetPenalty,
        content_relevance: relevanceFactor,
        base_weight: baseWeight,
        weighted_activation: weightedActivation,
        weighted_relevance: weightedRelevance,
        weighted_relevance_direct: weightedRelevanceDirect,
        weighted_query_evidence_transfer: weightedQueryEvidenceTransfer,
        weighted_graph_support: weightedGraphSupport,
        weighted_path_plasticity: weightedPathPlasticity,
        weighted_confidence: weightedConfidence,
        weighted_budget_penalty: weightedBudgetPenalty,
        weighted_conflict_penalty: weightedConflictPenalty,
        weighted_contradiction_penalty: contradictionPenalty,
        query_evidence_transfer: queryEvidenceTransfer,
        adjusted_base_weight: adjustedBaseWeight,
        effective_relevance_weight:
          weights.relevance +
          additiveWeights.NO_EMBEDDING_RELEVANCE_DIRECT_WEIGHT +
          queryEvidenceTransfer,
        conflict_penalty: conflictPenalty,
        contradiction_penalty: contradictionPenalty,
        confidence: confidenceFactor,
        graph_path_cold_score: supplementaryData.graphAndPathColdScore,
        recalls_edge_count: supplementaryData.recallsEdgeCount,
        weight_transfer_amount: supplementaryData.weightTransferAmount,
        resolved_activation_weights: weights
      })
    });
  }

  private resolveEffectiveActivationWeights(
    entry: Readonly<MemoryEntry>,
    policy: Readonly<RecallPolicy>
  ): ActivationWeights {
    const overrides = policy.domain_weight_overrides;
    if (overrides === undefined) {
      return resolveActivationWeights();
    }

    const matchedDomainTag = entry.domain_tags
      .filter((tag) => overrides[tag] !== undefined)
      .sort((left, right) => left.localeCompare(right))[0];

    if (matchedDomainTag === undefined) {
      return resolveActivationWeights();
    }

    const resolved = resolveActivationWeights(overrides[matchedDomainTag]);
    try {
      assertActivationWeightsSumToOne(resolved);
      return resolved;
    } catch (error) {
      this.warn("ERROR: recall domain weight override invalid; falling back to base activation weights", {
        policy_id: policy.runtime_id,
        domain_tag: matchedDomainTag,
        error: toErrorMessage(error)
      });
      return resolveActivationWeights();
    }
  }
}

type RecallFusionCandidateInput = Readonly<CoarseRecallCandidate & {
  readonly effectiveScore: number;
  readonly effectiveFactors: RecallScoreFactors;
}>;
type FusedRecallCandidateInput = Readonly<RecallFusionCandidateInput & {
  readonly fusion: RecallFusionBreakdown;
}>;

type ResolvedRecallFusionWeights = Readonly<{
  readonly k: number;
  readonly weights: Readonly<Record<RecallFusionStream, number>>;
}>;

function buildRecallFusionDetails(params: Readonly<{
  readonly candidates: readonly RecallFusionCandidateInput[];
  readonly policy: Readonly<RecallPolicy>;
  readonly supplementaryData: RecallSupplementaryData;
  readonly nowIso: string;
}>): ReadonlyMap<string, RecallFusionBreakdown> {
  const resolved = resolveRrfFusionWeights(params.policy);
  const ranksByStream = new Map<RecallFusionStream, ReadonlyMap<string, number>>();

  for (const stream of RECALL_FUSION_STREAMS) {
    const scored = params.candidates
      .map((candidate) => Object.freeze({
        candidateKey: buildRecallCandidateDedupeKey(candidate),
        objectId: candidate.entry.object_id,
        entry: candidate.entry,
        score: scoreRecallFusionStream(candidate, stream, params.supplementaryData, params.nowIso)
      }))
      .filter((candidate) => candidate.score > 0)
      .sort((left, right) =>
        right.score === left.score
          ? compareMemoryEntries(left.entry, right.entry)
          : right.score - left.score
      );
    ranksByStream.set(
      stream,
      Object.freeze(new Map(scored.map((candidate, index) => [candidate.candidateKey, index + 1] as const)))
    );
  }

  const prelim = params.candidates.map((candidate) => {
    const candidateKey = buildRecallCandidateDedupeKey(candidate);
    const perStreamRank = buildEmptyFusionStreamRanks();
    const contributions = buildEmptyFusionStreamContributions();
    let fusedScore = 0;
    for (const stream of RECALL_FUSION_STREAMS) {
      const rank = ranksByStream.get(stream)?.get(candidateKey) ?? null;
      perStreamRank[stream] = rank;
      if (rank !== null) {
        const contribution = resolved.weights[stream] / (resolved.k + rank);
        contributions[stream] = contribution;
        fusedScore += contribution;
      }
    }
    return Object.freeze({
      candidateKey,
      objectId: candidate.entry.object_id,
      objectKind: candidate.objectKind ?? "memory_entry",
      originPlane: candidate.originPlane ?? "workspace_local",
      entry: candidate.entry,
      effectiveScore: candidate.effectiveScore,
      perStreamRank: Object.freeze(perStreamRank) as RecallFusionStreamRanks,
      contributions: Object.freeze(contributions) as RecallFusionStreamContributions,
      fusedScore
    });
  });

  const ranked = [...prelim].sort((left, right) => {
    const fusionDelta = right.fusedScore - left.fusedScore;
    if (fusionDelta !== 0) {
      return fusionDelta;
    }
    const effectiveDelta = right.effectiveScore - left.effectiveScore;
    if (effectiveDelta !== 0) {
      return effectiveDelta;
    }
    return compareMemoryEntries(left.entry, right.entry);
  });
  const fusedRankByCandidateKey = new Map(ranked.map((candidate, index) => [candidate.candidateKey, index + 1] as const));

  return Object.freeze(
    new Map(
      prelim.map((candidate) => [
        candidate.candidateKey,
        Object.freeze({
          candidate_key: candidate.candidateKey,
          object_id: candidate.objectId,
          object_kind: candidate.objectKind,
          origin_plane: candidate.originPlane,
          per_stream_rank: candidate.perStreamRank,
          fused_rank: fusedRankByCandidateKey.get(candidate.candidateKey) ?? Number.MAX_SAFE_INTEGER,
          fused_score: candidate.fusedScore,
          fused_rank_contribution_per_stream: candidate.contributions
        })
      ] as const)
    )
  );
}

function scoreRecallFusionStream(
  candidate: RecallFusionCandidateInput,
  stream: RecallFusionStream,
  supplementaryData: RecallSupplementaryData,
  nowIso: string
): number {
  const objectId = candidate.entry.object_id;
  const isGlobalCandidate = candidate.originPlane === "global";
  // invariant: synthesis_capsule candidates score ONLY on synthesis_fts —
  // their dimension/source_kind/created_at are faked pseudo-memory_entry
  // fields, so any other stream is fail-closed for them here.
  // see also: recall-candidate-builder.ts buildSynthesisCoarseRecallCandidate
  if (candidate.objectKind === "synthesis_capsule") {
    return stream === "synthesis_fts"
      ? clamp01(supplementaryData.synthesisFtsRanks[objectId] ?? 0)
      : 0;
  }
  switch (stream) {
    case "lexical_fts":
      if (isGlobalCandidate) {
        return 0;
      }
      return clamp01(supplementaryData.ftsRanks[objectId] ?? 0);
    case "synthesis_fts":
      return 0;
    case "evidence_fts":
      if (isGlobalCandidate) {
        return 0;
      }
      return clamp01(supplementaryData.evidenceFtsRanks[objectId] ?? 0);
    case "evidence_structural_agreement":
      if (isGlobalCandidate) {
        return 0;
      }
      return scoreEvidenceStructuralAgreement(candidate, supplementaryData);
    case "source_proximity":
      if (isGlobalCandidate) {
        return 0;
      }
      return clamp01(supplementaryData.sourceProximityScores[objectId] ?? 0);
    case "source_evidence_agreement":
      if (isGlobalCandidate) {
        return 0;
      }
      return scoreSourceEvidenceAgreement(candidate, supplementaryData);
    case "subject_alignment":
      return scoreSubjectAlignment(candidate.entry, supplementaryData.queryProbes);
    case "structural":
      return clamp01(
        candidate.structuralScore ?? (isGlobalCandidate ? 0 : supplementaryData.structuralScores[objectId] ?? 0)
      );
    case "existing_score":
      return clamp01(candidate.effectiveScore);
    case "embedding_similarity":
      return clamp01(candidate.effectiveFactors.embedding_similarity ?? 0);
    case "graph_expansion":
      if (isGlobalCandidate) {
        return 0;
      }
      return clamp01(Math.max(
        supplementaryData.graphExpansionScores[objectId] ?? 0,
        normalizeGraphSupport(supplementaryData.graphSupportCounts[objectId] ?? 0)
      ));
    case "path_expansion":
      if (isGlobalCandidate) {
        return 0;
      }
      return clamp01(supplementaryData.pathExpansionScores[objectId] ?? 0);
    case "temporal_recency":
      return scoreTemporalRecency(candidate.entry, nowIso);
    case "workspace_activation":
      return normalizeActivationScore(candidate.entry.activation_score);
  }
}

function scoreEvidenceStructuralAgreement(
  candidate: RecallFusionCandidateInput,
  supplementaryData: RecallSupplementaryData
): number {
  const objectId = candidate.entry.object_id;
  const evidenceScore = clamp01(supplementaryData.evidenceFtsRanks[objectId] ?? 0);
  const structuralScore = clamp01(candidate.structuralScore ?? supplementaryData.structuralScores[objectId] ?? 0);
  if (evidenceScore <= 0 || structuralScore <= 0) {
    return 0;
  }
  return Math.sqrt(evidenceScore * structuralScore) + Math.min(evidenceScore, structuralScore) * 0.1;
}

function scoreSourceEvidenceAgreement(
  candidate: RecallFusionCandidateInput,
  supplementaryData: RecallSupplementaryData
): number {
  const objectId = candidate.entry.object_id;
  const evidenceScore = clamp01(supplementaryData.evidenceFtsRanks[objectId] ?? 0);
  const sourceScore = clamp01(supplementaryData.sourceProximityScores[objectId] ?? 0);
  if (evidenceScore <= 0 || sourceScore <= 0) {
    return 0;
  }
  return clamp01(Math.sqrt(evidenceScore * sourceScore) + Math.min(evidenceScore, sourceScore) * 0.1);
}

function scoreSubjectAlignment(
  entry: Readonly<MemoryEntry>,
  queryProbes: Readonly<RecallQueryProbes>
): number {
  if (!queryProbes.subject_hints.includes("self_reference")) {
    return 0;
  }

  const content = normalizeEvidenceText(entry.content);
  if (content.length === 0) {
    return 0;
  }

  const explicitSelf = /\b(?:i|i'm|i've|i'd|i'll|me|my|mine|we|we're|we've|our|ours)\b|(?:我|我的|我们|咱们|咱)/iu.test(content);
  const userFramed = /\b(?:the user|user|operator|principal)\b/iu.test(content);
  if (!explicitSelf && !userFramed) {
    return 0;
  }

  const genericAssistant =
    /\b(?:as an ai|i (?:do not|don't) have|i can help|here are|you can|you could|you should|there are many|some suggestions|popular (?:ones|options))\b/iu.test(content);
  const baseScore = explicitSelf ? 1 : 0.55;
  return clamp01(genericAssistant ? baseScore * 0.25 : baseScore);
}

function compareFusedRecallCandidates(
  left: FusedRecallCandidateInput,
  right: FusedRecallCandidateInput
): number {
  const fusionDelta = right.fusion.fused_score - left.fusion.fused_score;
  if (fusionDelta !== 0) {
    return fusionDelta;
  }
  const effectiveDelta = right.effectiveScore - left.effectiveScore;
  if (effectiveDelta !== 0) {
    return effectiveDelta;
  }
  return compareMemoryEntries(left.entry, right.entry);
}

function prioritizeStrongLexicalDeliveryWindowCandidates<T extends FusedRecallCandidateInput>(
  rankedCandidates: readonly T[],
  supplementaryData: RecallSupplementaryData,
  maxEntries: number
): readonly T[] {
  const deliveryWindowSize = Math.min(Math.max(0, maxEntries), rankedCandidates.length);
  if (deliveryWindowSize <= 1) {
    return rankedCandidates;
  }

  const deliveryWindow = rankedCandidates.slice(0, deliveryWindowSize);
  if (!deliveryWindow.some((candidate) => isStrongLexicalCandidate(candidate, supplementaryData))) {
    return rankedCandidates;
  }

  if (!deliveryWindow.some((candidate) => isSourceProximityLocalOnlyCandidate(candidate))) {
    return rankedCandidates;
  }

  const reorderedWindow: T[] = [];
  const deferredSourceLocalOnly: T[] = [];
  for (const candidate of deliveryWindow) {
    if (isSourceProximityLocalOnlyCandidate(candidate)) {
      deferredSourceLocalOnly.push(candidate);
      continue;
    }
    reorderedWindow.push(candidate);
    if (isStrongLexicalCandidate(candidate, supplementaryData) && deferredSourceLocalOnly.length > 0) {
      reorderedWindow.push(...deferredSourceLocalOnly);
      deferredSourceLocalOnly.length = 0;
      continue;
    }
  }
  reorderedWindow.push(...deferredSourceLocalOnly);

  return Object.freeze([
    ...reorderedWindow,
    ...rankedCandidates.slice(deliveryWindowSize)
  ]);
}

function applyFeatureRerank<T extends FusedRecallCandidateInput>(
  rankedCandidates: readonly T[],
  supplementaryData: RecallSupplementaryData
): readonly T[] {
  const rerankInputs: readonly RerankCandidate<T>[] = rankedCandidates.map((candidate) =>
    Object.freeze({
      item: candidate,
      fusionScore: candidate.fusion.fused_score,
      text: Object.freeze({
        content: candidate.entry.content,
        hasEvidenceLexicalHit:
          (supplementaryData.evidenceFtsRanks[candidate.entry.object_id] ?? 0) > 0 ||
          (candidate.objectKind === "synthesis_capsule" &&
            (supplementaryData.synthesisFtsRanks[candidate.entry.object_id] ?? 0) > 0)
      })
    })
  );
  return rerankTopN(supplementaryData.queryProbes, rerankInputs);
}

/**
 * Delivery slots reserved for L2 synthesis_capsule candidates.
 *
 * A synthesis candidate fires on exactly one fusion stream (synthesis_fts).
 * RRF rewards multi-stream presence, so a synthesis row's fused score is
 * capped near `weight/(k+1)` while a multi-stream memory_entry accumulates
 * well past it — synthesis never reaches the delivery budget on fused rank
 * alone. The reserve guarantees the top synthesis rows (by synthesis FTS
 * relevance) a bounded presence so the L2 layer is reachable through recall.
 */
const SYNTHESIS_DELIVERY_RESERVE = 2;

/**
 * Reserve the tail of the delivery budget window for the strongest synthesis
 * candidates. Tail placement keeps high-rank memory_entry results at the head
 * undisplaced; only the lowest in-budget memory rows yield their slot. Returns
 * the input unchanged when no synthesis candidate is present, so memory-only
 * recall is a guaranteed no-op.
 *
 * The reserve is against the ENTRY-COUNT budget only. The downstream
 * `appendCandidate` reduce still enforces `max_total_tokens`, so a
 * tail-placed reserved synthesis can still be evicted under a tight token
 * budget — the reserve is a best-effort entry-count guarantee, not a hard
 * delivery guarantee. Because placement is tail-only, a synthesis row is
 * reachable by a consumer that reads the whole delivery window but not by
 * one that reads only the top few. A scored, fusion-comparable synthesis
 * signal that would let synthesis place by merit is a v0.3.11 concern.
 */
function reserveSynthesisDeliverySlots<T extends FusedRecallCandidateInput>(
  deliveryOrdered: readonly T[],
  supplementaryData: RecallSupplementaryData,
  maxEntries: number
): readonly T[] {
  const synthesisCandidates = deliveryOrdered.filter(
    (candidate) => candidate.objectKind === "synthesis_capsule"
  );
  if (synthesisCandidates.length === 0 || maxEntries <= 1) {
    return deliveryOrdered;
  }
  const reserveCount = Math.min(
    SYNTHESIS_DELIVERY_RESERVE,
    synthesisCandidates.length,
    maxEntries - 1
  );
  if (reserveCount <= 0) {
    return deliveryOrdered;
  }
  const reservedSynthesis = [...synthesisCandidates]
    .sort((left, right) => {
      const leftRank = supplementaryData.synthesisFtsRanks[left.entry.object_id] ?? 0;
      const rightRank = supplementaryData.synthesisFtsRanks[right.entry.object_id] ?? 0;
      return rightRank - leftRank !== 0
        ? rightRank - leftRank
        : compareMemoryEntries(left.entry, right.entry);
    })
    .slice(0, reserveCount);
  const reservedKeys = new Set(
    reservedSynthesis.map((candidate) => buildRecallCandidateDedupeKey(candidate))
  );
  const rest = deliveryOrdered.filter(
    (candidate) => !reservedKeys.has(buildRecallCandidateDedupeKey(candidate))
  );
  const headCount = Math.max(0, maxEntries - reserveCount);
  return Object.freeze([
    ...rest.slice(0, headCount),
    ...reservedSynthesis,
    ...rest.slice(headCount)
  ]);
}

function isStrongLexicalCandidate(
  candidate: FusedRecallCandidateInput,
  supplementaryData: RecallSupplementaryData
): boolean {
  const rank = candidate.objectKind === "synthesis_capsule"
    ? supplementaryData.synthesisFtsRanks[candidate.entry.object_id] ?? 0
    : supplementaryData.ftsRanks[candidate.entry.object_id] ?? 0;
  return clamp01(rank) >= STRONG_LEXICAL_DELIVERY_RANK;
}

function isSourceProximityLocalOnlyCandidate(candidate: FusedRecallCandidateInput): boolean {
  const ranks = candidate.fusion.per_stream_rank;
  return (
    ranks.source_proximity !== null &&
    ranks.lexical_fts === null &&
    ranks.synthesis_fts === null &&
    ranks.evidence_fts === null &&
    ranks.evidence_structural_agreement === null &&
    ranks.source_evidence_agreement === null &&
    ranks.embedding_similarity === null &&
    ranks.graph_expansion === null &&
    ranks.path_expansion === null
  );
}

function buildEmptyRecallFusionBreakdown(objectId: string): Readonly<RecallFusionBreakdown> {
  return Object.freeze({
    candidate_key: `workspace_local:memory_entry:${objectId}`,
    object_id: objectId,
    object_kind: "memory_entry",
    origin_plane: "workspace_local",
    per_stream_rank: Object.freeze(buildEmptyFusionStreamRanks()) as RecallFusionStreamRanks,
    fused_rank: Number.MAX_SAFE_INTEGER,
    fused_score: 0,
    fused_rank_contribution_per_stream: Object.freeze(buildEmptyFusionStreamContributions()) as RecallFusionStreamContributions
  });
}

function buildEmptyFusionStreamRanks(): Record<RecallFusionStream, number | null> {
  return Object.fromEntries(RECALL_FUSION_STREAMS.map((stream) => [stream, null])) as Record<RecallFusionStream, number | null>;
}

function buildEmptyFusionStreamContributions(): Record<RecallFusionStream, number> {
  return Object.fromEntries(RECALL_FUSION_STREAMS.map((stream) => [stream, 0])) as Record<RecallFusionStream, number>;
}

function resolveRrfFusionWeights(policy: Readonly<RecallPolicy>): ResolvedRecallFusionWeights {
  const overrides = policy.scoring_weight_overrides?.fusion_weights;
  const kOverride = overrides?.RRF_K ?? overrides?.rrf_k;
  const k = typeof kOverride === "number" && Number.isFinite(kOverride) && kOverride > 0
    ? Math.trunc(kOverride)
    : RECALL_RRF_DEFAULT_K;
  const weights = Object.fromEntries(
    RECALL_FUSION_STREAMS.map((stream) => [
      stream,
      Math.max(0, overrides?.[stream] ?? RECALL_FUSION_DEFAULT_WEIGHTS[stream])
    ])
  ) as Record<RecallFusionStream, number>;
  return Object.freeze({
    k: Math.max(1, k),
    weights: Object.freeze(weights)
  });
}

function scoreTemporalRecency(entry: Readonly<MemoryEntry>, nowIso: string): number {
  const createdAtMs = Date.parse(entry.created_at);
  const nowMs = Date.parse(nowIso);
  if (!Number.isFinite(createdAtMs) || !Number.isFinite(nowMs)) {
    return 0;
  }
  const ageDays = Math.max(0, (nowMs - createdAtMs) / 86_400_000);
  return clamp01(1 - ageDays / 30);
}

function buildRecallDiagnostics(params: Readonly<{
  readonly queryProbes: Readonly<RecallQueryProbes>;
  readonly totalScanned: number;
  readonly candidatePoolCount: number;
  readonly preBudgetCount: number;
  readonly deliveredCount: number;
  readonly embeddingProviderStatus: RecallEmbeddingProviderStatus;
  readonly providerDegradationReason: string | null;
  readonly candidates: readonly Readonly<RecallCandidateDiagnostic>[];
}>): Readonly<RecallDiagnostics> {
  return Object.freeze({
    query_probes: Object.freeze({
      object_ids: Object.freeze([...params.queryProbes.object_ids]),
      subject_hints: Object.freeze([...params.queryProbes.subject_hints]),
      evidence_refs: Object.freeze([...params.queryProbes.evidence_refs]),
      run_ids: Object.freeze([...params.queryProbes.run_ids]),
      surface_ids: Object.freeze([...params.queryProbes.surface_ids]),
      file_paths: Object.freeze([...params.queryProbes.file_paths]),
      command_names: Object.freeze([...params.queryProbes.command_names]),
      package_names: Object.freeze([...params.queryProbes.package_names]),
      task_refs: Object.freeze([...params.queryProbes.task_refs]),
      dimensions: Object.freeze([...params.queryProbes.dimensions]),
      scope_classes: Object.freeze([...params.queryProbes.scope_classes]),
      domain_tags: Object.freeze([...params.queryProbes.domain_tags]),
      lexical_terms: Object.freeze([...params.queryProbes.lexical_terms]),
      phrases: Object.freeze([...params.queryProbes.phrases]),
      char_ngrams: Object.freeze([...params.queryProbes.char_ngrams]),
      date_terms: Object.freeze([...params.queryProbes.date_terms])
    }),
    total_scanned: params.totalScanned,
    candidate_pool_count: params.candidatePoolCount,
    pre_budget_count: params.preBudgetCount,
    delivered_count: params.deliveredCount,
    embedding_provider_status: params.embeddingProviderStatus,
    provider_degradation_reason: params.providerDegradationReason,
    fusion_breakdown: Object.freeze(
      params.candidates.map((candidate) => Object.freeze({
        candidate_key: candidate.candidate_key,
        object_id: candidate.object_id,
        object_kind: candidate.object_kind,
        origin_plane: candidate.origin_plane,
        per_stream_rank: candidate.per_stream_rank,
        fused_rank: candidate.fused_rank,
        fused_score: candidate.fused_score,
        fused_rank_contribution_per_stream: candidate.fused_rank_contribution_per_stream
      }))
    ),
    candidates: Object.freeze([...params.candidates])
  });
}

function finalizeRecallCandidateDiagnostics(
  diagnostics: readonly Readonly<RecallCandidateDiagnostic>[],
  deliveredCandidates: readonly Readonly<RecallCandidate>[]
): readonly Readonly<RecallCandidateDiagnostic>[] {
  const deliveredRankByCandidateKey = new Map<string, number>(
    deliveredCandidates.map((candidate, index) => [
      `${candidate.origin_plane ?? "workspace_local"}:${candidate.object_kind}:${candidate.object_id}`,
      index + 1
    ] as const)
  );
  return Object.freeze(
    diagnostics.map((diagnostic) => {
      const deliveredRank = deliveredRankByCandidateKey.get(diagnostic.candidate_key) ?? null;
      if (deliveredRank !== null) {
        return Object.freeze({
          ...diagnostic,
          final_rank: deliveredRank,
          dropped_reason: null,
          within_budget: true
        });
      }
      if (diagnostic.dropped_reason !== null) {
        return diagnostic;
      }
      return Object.freeze({
        ...diagnostic,
        final_rank: null,
        dropped_reason: "max_entries" as const,
        within_budget: false
      });
    })
  );
}

function resolveEmbeddingProviderStatus(
  policy: Readonly<RecallPolicy>,
  preparedEmbeddingQuery: PreparedEmbeddingQueryHandle | null,
  degradedReason: string | null
): RecallEmbeddingProviderStatus {
  if (degradedReason !== null) {
    return "provider_failed";
  }
  if (
    policy.coarse_filter.semantic_supplement.embedding_enabled !== true ||
    preparedEmbeddingQuery === null
  ) {
    return "provider_not_requested";
  }
  const snapshot = preparedEmbeddingQuery.getSnapshot();
  switch (snapshot.status) {
    case "ready":
      return "provider_returned";
    case "pending":
      return "provider_pending";
    case "failed":
      return "provider_failed";
  }
}

function resolveEmbeddingProviderDegradationReason(
  policy: Readonly<RecallPolicy>,
  preparedEmbeddingQuery: PreparedEmbeddingQueryHandle | null,
  degradedReason: string | null
): string | null {
  if (degradedReason !== null) {
    return degradedReason;
  }
  if (
    policy.coarse_filter.semantic_supplement.embedding_enabled !== true ||
    preparedEmbeddingQuery === null
  ) {
    return null;
  }
  const snapshot = preparedEmbeddingQuery.getSnapshot();
  if (snapshot.status === "failed") {
    return normalizeEmbeddingProviderDegradationReason(snapshot.reason);
  }
  if (snapshot.status === "pending") {
    return "query_embedding_pending";
  }
  return null;
}

function normalizeEmbeddingProviderDegradationReason(reason: string): string | null {
  const normalized = reason.trim().toLowerCase();
  if (
    normalized === "query_embedding_failed" ||
    normalized === "provider_unavailable" ||
    normalized === "local_vector_lookup_failed" ||
    normalized === "query_embedding_pending"
  ) {
    return normalized;
  }
  return "provider_unavailable";
}

function emptyEmbeddingSupplementResult(): EmbeddingRecallSupplementResult {
  return Object.freeze({
    supplementaryEntries: Object.freeze([]),
    similarityHintsByObjectId: Object.freeze({})
  });
}

function emptySynthesisCoarseFilter(): Readonly<{
  readonly candidates: readonly Readonly<CoarseRecallCandidate>[];
  readonly synthesisFtsRanks: Readonly<Record<string, number>>;
}> {
  return Object.freeze({
    candidates: Object.freeze([]),
    synthesisFtsRanks: Object.freeze({})
  });
}

function withEmbeddingSimilarityScores(
  supplementaryData: RecallSupplementaryData,
  hintsByObjectId: EmbeddingRecallSupplementResult["similarityHintsByObjectId"]
): RecallSupplementaryData {
  const entries = Object.entries(hintsByObjectId)
    .map(([objectId, hint]) => [objectId, clamp01(hint.normalized_similarity)] as const)
    .filter(([, score]) => score > 0);
  if (entries.length === 0) {
    return supplementaryData;
  }

  return Object.freeze({
    ...supplementaryData,
    embeddingSimilarityScores: Object.freeze(Object.fromEntries(entries))
  });
}

function buildEvidenceSearchQueries(
  queryText: string,
  queryProbes: Readonly<RecallQueryProbes>
): readonly string[] {
  const phraseQueries = queryProbes.phrases
    .filter((phrase) => phrase.length >= 3)
    .slice(0, 8);
  const multiKeyQuery = queryProbes.lexical_terms.slice(0, 8).join(" ");
  const dateQueries = queryProbes.date_terms.slice(0, 6);
  return uniqueStrings([
    queryText,
    ...phraseQueries,
    ...(multiKeyQuery.length === 0 ? [] : [multiKeyQuery]),
    ...dateQueries
  ].map((value) => value.trim()).filter((value) => value.length > 0));
}

function scoreQueryEvidenceMatch(
  entry: Readonly<MemoryEntry>,
  queryProbes: Readonly<RecallQueryProbes>
): number {
  if (queryProbes.normalized_query === null || queryProbes.lexical_terms.length === 0) {
    return 0;
  }

  const content = normalizeEvidenceText(entry.content);
  const metadata = normalizeEvidenceText([...entry.domain_tags, ...entry.evidence_refs].join(" "));
  const terms = queryProbes.lexical_terms.slice(0, 32);
  let hitWeight = 0;
  let contentHits = 0;

  for (const term of terms) {
    const needle = normalizeEvidenceText(term);
    if (needle.length === 0) {
      continue;
    }
    const hitInContent = containsEvidenceNeedle(content, needle);
    const hitInMetadata = !hitInContent && containsEvidenceNeedle(metadata, needle);
    if (hitInContent) {
      hitWeight += 1;
      contentHits += 1;
    } else if (hitInMetadata) {
      hitWeight += 0.65;
    }
  }

  if (hitWeight === 0) {
    return 0;
  }

  const phraseHits = queryProbes.phrases
    .slice(0, 12)
    .filter((phrase) => containsEvidenceNeedle(content, normalizeEvidenceText(phrase)))
    .length;
  const termCoverage = clamp01(hitWeight / Math.max(1, terms.length));
  const phraseScore = clamp01(phraseHits / 3);
  const tokenCount = Math.max(8, splitEvidenceTokens(content).length);
  const densityScore = clamp01(contentHits / Math.sqrt(tokenCount));
  const conciseScore =
    contentHits > 0
      ? content.length <= 420
        ? 0.04
        : content.length <= 1_200
          ? 0.02
          : 0
      : 0;

  return clamp01(
    termCoverage * 0.48 +
      phraseScore * 0.12 +
      densityScore * 0.08 +
      conciseScore
  );
}

function scoreObjectProbeMatch(
  entry: Readonly<MemoryEntry>,
  queryProbes: Readonly<RecallQueryProbes>
): number {
  let score = 0;
  if (queryProbes.object_ids.includes(entry.object_id)) {
    score += 1;
  }
  if (entry.evidence_refs.some((ref) => queryProbes.evidence_refs.includes(ref))) {
    score += 0.9;
  }
  if (entry.run_id !== null && queryProbes.run_ids.includes(entry.run_id)) {
    score += 0.8;
  }
  if (entry.surface_id !== null && queryProbes.surface_ids.includes(entry.surface_id)) {
    score += 0.8;
  }
  if (queryProbes.dimensions.includes(entry.dimension)) {
    score += 0.55;
  }
  if (queryProbes.scope_classes.includes(entry.scope_class)) {
    score += 0.45;
  }
  if (entry.domain_tags.some((tag) => queryProbes.domain_tags.includes(tag))) {
    score += 0.45;
  }
  const structuralNeedles = [
    ...queryProbes.file_paths,
    ...queryProbes.package_names,
    ...queryProbes.command_names,
    ...queryProbes.task_refs
  ].map((value) => value.toLocaleLowerCase());
  if (structuralNeedles.length > 0) {
    const haystack = [
      entry.content,
      ...entry.domain_tags,
      ...entry.evidence_refs
    ].join("\n").toLocaleLowerCase();
    if (structuralNeedles.some((needle) => haystack.includes(needle))) {
      score += 0.5;
    }
  }
  return clamp01(score);
}

function normalizeEvidenceText(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[’‘]/gu, "'")
    .toLocaleLowerCase();
}

function splitEvidenceTokens(value: string): readonly string[] {
  return value
    .split(/[^\p{L}\p{N}_-]+/u)
    .filter((token) => token.length > 0);
}

function containsEvidenceNeedle(haystack: string, rawNeedle: string): boolean {
  const needle = normalizeEvidenceText(rawNeedle).trim();
  if (needle.length === 0) {
    return false;
  }
  if (needle.includes(" ") || /[^\p{Script=Latin}\p{N}_-]/u.test(needle)) {
    return haystack.includes(needle);
  }
  const pattern = new RegExp(`(^|[^\\p{L}\\p{N}_-])${escapeRegExp(needle)}($|[^\\p{L}\\p{N}_-])`, "u");
  return pattern.test(haystack);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function scoreEvidenceAnchorMatch(
  entry: Readonly<MemoryEntry>,
  evidenceRefs: ReadonlySet<string>
): number {
  const overlapCount = entry.evidence_refs.reduce(
    (count, ref) => evidenceRefs.has(ref) ? count + 1 : count,
    0
  );
  if (overlapCount === 0) {
    return 0;
  }
  return clamp01(0.55 + overlapCount * 0.1);
}

function scoreDomainTagCluster(
  entry: Readonly<MemoryEntry>,
  domainTags: ReadonlySet<string>,
  queryTags: ReadonlySet<string>,
  tagFrequency: ReadonlyMap<string, number>,
  commonTagLimit: number
): number {
  const matchingTags = entry.domain_tags.filter((tag) => domainTags.has(tag));
  if (matchingTags.length === 0) {
    return 0;
  }
  const usableTags = matchingTags.filter((tag) => queryTags.has(tag) || (tagFrequency.get(tag) ?? 0) <= commonTagLimit);
  if (usableTags.length === 0) {
    return 0;
  }
  const queryOverlap = usableTags.some((tag) => queryTags.has(tag)) ? 0.2 : 0;
  return clamp01(0.35 + usableTags.length * 0.12 + queryOverlap);
}

function countDomainTags(entries: readonly Readonly<MemoryEntry>[]): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    for (const tag of entry.domain_tags) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }
  return counts;
}

function selectExpansionSeedEntries(
  drafts: ReadonlyMap<string, CoarseCandidateDraft>,
  fallbackEntries: readonly Readonly<MemoryEntry>[]
): readonly Readonly<MemoryEntry>[] {
  const draftSeeds = selectExpansionSeedDrafts(drafts).map((draft) => draft.entry);
  if (draftSeeds.length > 0) {
    return draftSeeds;
  }
  return [...fallbackEntries].sort(compareMemoryEntries).slice(0, DYNAMIC_RECALL_SEED_CAP);
}

interface EvidenceSourceChunkRef {
  readonly sourceKey: string;
  readonly chunkIndex: number;
}

interface EvidenceSourceChunkEntry {
  readonly entry: Readonly<MemoryEntry>;
  readonly chunkIndex: number;
}

function buildEvidenceSourceChunkIndex(
  entries: readonly Readonly<MemoryEntry>[],
  sourceRefsByMemoryId?: ReadonlyMap<string, readonly string[]>
): ReadonlyMap<string, readonly EvidenceSourceChunkEntry[]> {
  const bySource = new Map<string, EvidenceSourceChunkEntry[]>();
  for (const entry of entries) {
    for (const ref of sourceRefsByMemoryId?.get(entry.object_id) ?? entry.evidence_refs) {
      const parsed = parseEvidenceSourceChunkRef(ref);
      if (parsed === null) {
        continue;
      }
      const current = bySource.get(parsed.sourceKey) ?? [];
      current.push({ entry, chunkIndex: parsed.chunkIndex });
      bySource.set(parsed.sourceKey, current);
    }
  }
  return new Map(
    [...bySource.entries()].map(([sourceKey, values]) => [
      sourceKey,
      Object.freeze(
        values.sort((left, right) => {
          const chunkDelta = left.chunkIndex - right.chunkIndex;
          return chunkDelta === 0 ? compareMemoryEntries(left.entry, right.entry) : chunkDelta;
        })
      )
    ] as const)
  );
}

function buildEvidenceSourceCohortKeys(
  entries: readonly Readonly<MemoryEntry>[],
  sourceRefsByMemoryId: ReadonlyMap<string, readonly string[]>
): Readonly<Record<string, string>> {
  const keys: Record<string, string> = {};
  for (const entry of entries) {
    const cohortKey = selectEvidenceSourceCohortKey(sourceRefsByMemoryId.get(entry.object_id) ?? entry.evidence_refs);
    if (cohortKey !== null) {
      keys[entry.object_id] = cohortKey;
    }
  }
  return Object.freeze(keys);
}

function selectEvidenceSourceCohortKey(refs: readonly string[]): string | null {
  for (const ref of refs) {
    const parsed = parseEvidenceSourceChunkRef(ref);
    if (parsed !== null && parsed.sourceKey.length > 0) {
      return parsed.sourceKey;
    }
  }
  return null;
}

function parseEvidenceSourceChunkRef(ref: string): EvidenceSourceChunkRef | null {
  const normalized = ref.trim().toLowerCase();
  const sessionTurn = /^(.*?)(?:[-_./#:])s(?:ession)?[-_]?(\d+)(?:[-_./#:])t(?:urn)?[-_]?(\d+)$/.exec(normalized);
  if (sessionTurn !== null) {
    const [, prefix, session, turn] = sessionTurn;
    return {
      sourceKey: `${prefix ?? ""}|session:${session ?? ""}`,
      chunkIndex: Number.parseInt(turn ?? "", 10)
    };
  }

  const chunk = /^(.*?)(?:[-_./#:])(?:chunk|turn|t)[-_]?(\d+)$/.exec(normalized);
  if (chunk !== null) {
    const [, prefix, index] = chunk;
    return {
      sourceKey: prefix ?? "",
      chunkIndex: Number.parseInt(index ?? "", 10)
    };
  }

  return null;
}

function selectPreferredExpansionSeedEntries(
  drafts: ReadonlyMap<string, CoarseCandidateDraft>
): readonly Readonly<MemoryEntry>[] {
  return rankCoarseCandidateDrafts([...drafts.values()])
    .filter((draft) => draft.admissionPlanes.some((plane) => plane !== "activation") || draft.structuralScore > 0)
    .slice(0, DYNAMIC_RECALL_SEED_CAP)
    .map((draft) => draft.entry);
}

function selectExpansionSeedDrafts(
  drafts: ReadonlyMap<string, CoarseCandidateDraft>
): readonly Readonly<CoarseCandidateDraft>[] {
  const ranked = rankCoarseCandidateDrafts([...drafts.values()]);
  const preferred = ranked
    .filter((draft) => draft.admissionPlanes.some((plane) => plane !== "activation") || draft.structuralScore > 0)
    .slice(0, DYNAMIC_RECALL_SEED_CAP);
  const preferredIds = new Set(preferred.map((draft) => draft.entry.object_id));
  return [
    ...preferred,
    ...ranked.filter((draft) => !preferredIds.has(draft.entry.object_id))
  ].slice(0, DYNAMIC_RECALL_SEED_CAP);
}

function selectSourceProximitySeedDrafts(
  drafts: ReadonlyMap<string, CoarseCandidateDraft>
): readonly SourceProximitySeedDraft[] {
  return rankCoarseCandidateDrafts([...drafts.values()])
    .map((draft) => Object.freeze({
      draft,
      strength: scoreSourceProximitySeedDraft(draft)
    }))
    .filter((seed) => seed.strength > 0)
    .sort((left, right) => {
      const strengthDelta = right.strength - left.strength;
      if (strengthDelta !== 0) {
        return strengthDelta;
      }
      return compareMemoryEntries(left.draft.entry, right.draft.entry);
    })
    .slice(0, DYNAMIC_RECALL_SOURCE_PROXIMITY_SEED_CAP);
}

function scoreSourceProximitySeedDraft(draft: Readonly<CoarseCandidateDraft>): number {
  let strength = 0;
  if (draft.admissionPlanes.includes("protected_winner")) {
    strength = 1;
  }
  if (draft.admissionPlanes.includes("evidence_anchor")) {
    strength = Math.max(strength, 0.95);
  }
  if (draft.admissionPlanes.includes("object_probe")) {
    strength = Math.max(strength, 0.9);
  }
  if (draft.admissionPlanes.includes("session_surface_cohort")) {
    strength = Math.max(strength, 0.75);
  }
  if (draft.admissionPlanes.includes("lexical")) {
    strength = Math.max(strength, draft.structuralScore);
  }
  return strength >= 0.35 ? clamp01(strength) : 0;
}

function resolveSourceProximityAdmissionLimit(maxDeliveryEntries: number | undefined): number {
  if (maxDeliveryEntries !== undefined && maxDeliveryEntries <= 0) {
    return 0;
  }
  const budgetBound =
    maxDeliveryEntries === undefined
      ? DYNAMIC_RECALL_SOURCE_PROXIMITY_ADMISSION_CAP
      : Math.max(
          DYNAMIC_RECALL_SOURCE_PROXIMITY_NEIGHBORS_PER_SEED,
          maxDeliveryEntries * DYNAMIC_RECALL_SOURCE_PROXIMITY_ADMISSION_BUDGET_MULTIPLIER
        );
  return Math.min(DYNAMIC_RECALL_SOURCE_PROXIMITY_ADMISSION_CAP, budgetBound);
}

function rankCoarseCandidateDrafts(
  drafts: readonly Readonly<CoarseCandidateDraft>[]
): readonly Readonly<CoarseCandidateDraft>[] {
  return [...drafts].sort((left, right) => {
    const priorityDelta = draftPriority(right) - draftPriority(left);
    if (priorityDelta !== 0) {
      return priorityDelta;
    }
    const structuralDelta = right.structuralScore - left.structuralScore;
    if (structuralDelta !== 0) {
      return structuralDelta;
    }
    return compareMemoryEntries(left.entry, right.entry);
  });
}

function draftPriority(draft: Readonly<CoarseCandidateDraft>): number {
  if (draft.admissionPlanes.includes("protected_winner")) {
    return 5;
  }
  if (draft.admissionPlanes.includes("object_probe")) {
    return 4;
  }
  if (draft.admissionPlanes.some((plane) =>
    plane === "evidence_anchor" ||
    plane === "domain_tag_cluster" ||
    plane === "session_surface_cohort" ||
    plane === "source_proximity" ||
    plane === "graph_expansion" ||
    plane === "path_expansion"
  )) {
    return 3;
  }
  if (draft.admissionPlanes.includes("lexical")) {
    return 3;
  }
  return 1;
}

function scoreGraphExpansionEdge(edge: Readonly<MemoryGraphEdge>): number {
  return clamp01(Math.max(0, MEMORY_GRAPH_EDGE_RECALL_WEIGHTS[edge.edge_type] ?? 0));
}

function scorePathRelationExpansion(path: Readonly<PathRelation>): number {
  const governanceBoost =
    path.legitimacy.governance_class === "recall_allowed" ||
    path.legitimacy.governance_class === "strictly_governed"
      ? 0.15
      : 0;
  const stabilityBoost =
    path.plasticity_state.stability_class === "stable" ||
    path.plasticity_state.stability_class === "pinned"
      ? 0.1
      : 0;
  return clamp01(
    path.plasticity_state.strength * 0.55 +
      path.effect_vector.recall_bias * 0.25 +
      governanceBoost +
      stabilityBoost
  );
}

function directionEligiblePathExpansionTargets(
  path: Readonly<PathRelation>,
  seedIds: ReadonlySet<string>
): readonly DirectionEligiblePathExpansionTarget[] {
  const sourceId = anchorMemoryId(path.anchors.source_anchor);
  const targetId = anchorMemoryId(path.anchors.target_anchor);
  if (sourceId === undefined || targetId === undefined || sourceId === targetId) {
    return [];
  }

  const targets = new Map<string, DirectionEligiblePathExpansionTarget>();
  if (
    seedIds.has(sourceId) &&
    (path.plasticity_state.direction_bias === "source_to_target" ||
      path.plasticity_state.direction_bias === "bidirectional_asymmetric")
  ) {
    targets.set(`${sourceId}->${targetId}`, { seedId: sourceId, targetId });
  }
  if (
    seedIds.has(targetId) &&
    (path.plasticity_state.direction_bias === "target_to_source" ||
      path.plasticity_state.direction_bias === "bidirectional_asymmetric")
  ) {
    targets.set(`${targetId}->${sourceId}`, { seedId: targetId, targetId: sourceId });
  }
  return [...targets.values()];
}

interface DirectionEligiblePathExpansionTarget {
  readonly seedId: string;
  readonly targetId: string;
}

function pathRelationMemoryIds(path: Readonly<PathRelation>): readonly string[] {
  return uniqueStrings([
    anchorMemoryId(path.anchors.source_anchor),
    anchorMemoryId(path.anchors.target_anchor)
  ].filter((value): value is string => value !== undefined));
}

function pathMatchesTimeConcernWindowDigest(
  path: Readonly<PathRelation>,
  windowDigests: readonly string[]
): boolean {
  const queryDigests = new Set(windowDigests);
  return [
    path.anchors.source_anchor,
    path.anchors.target_anchor
  ].some((anchor) =>
    anchor.kind === "time_concern" &&
    queryDigests.has(normalizeTimeConcernWindowDigest(anchor.window_digest))
  );
}

function firstTimeConcernSeedId(
  path: Readonly<PathRelation>,
  windowDigests: readonly string[]
): string {
  const queryDigests = new Set(windowDigests);
  const anchor = [
    path.anchors.source_anchor,
    path.anchors.target_anchor
  ].find((candidate) =>
    candidate.kind === "time_concern" &&
    queryDigests.has(normalizeTimeConcernWindowDigest(candidate.window_digest))
  );
  return anchor?.kind === "time_concern"
    ? `time_concern:${normalizeTimeConcernWindowDigest(anchor.window_digest)}`
    : "time_concern:unknown";
}

function normalizeTimeConcernWindowDigest(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/gu, "_");
}

function anchorMemoryId(anchor: PathAnchorRef): string | undefined {
  switch (anchor.kind) {
    case "object":
    case "object_facet":
      return anchor.object_id;
    case "obligation":
    case "risk_concern":
    case "time_concern":
      return anchor.source_object_id;
  }
}

function isRetiredPathRelation(path: Readonly<PathRelation>): boolean {
  return (path.lifecycle as { readonly status?: string }).status === "retired";
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function uniquePathExpansionSources(
  values: readonly RecallPathExpansionSourceDiagnostic[]
): readonly RecallPathExpansionSourceDiagnostic[] {
  const seen = new Set<string>();
  const result: RecallPathExpansionSourceDiagnostic[] = [];
  for (const value of values) {
    const key = `${value.source_channel}:${value.path_id}:${value.seed_kind}:${value.seed_id}:${value.target_object_id}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(value);
  }
  return result;
}

function uniquePlanes(values: readonly RecallAdmissionPlane[]): readonly RecallAdmissionPlane[] {
  return [...new Set(values)];
}

const RECALL_ADMISSION_ATTRIBUTION_ORDER: readonly RecallAdmissionPlane[] = [
  "lexical",
  "source_proximity",
  "path_expansion",
  "graph_expansion",
  "evidence_anchor",
  "object_probe",
  "protected_winner",
  "domain_tag_cluster",
  "session_surface_cohort",
  "activation"
];

function selectRecallAdmissionAttributionPlane(
  admissionPlanes: readonly RecallAdmissionPlane[],
  fallback: RecallAdmissionPlane | undefined
): RecallAdmissionPlane {
  for (const plane of RECALL_ADMISSION_ATTRIBUTION_ORDER) {
    if (admissionPlanes.includes(plane)) {
      return plane;
    }
  }
  return fallback ?? admissionPlanes[0] ?? "activation";
}

function isWorkspaceLocalRecallCandidate(candidate: Readonly<RecallCandidate>): boolean {
  return (candidate.origin_plane ?? "workspace_local") === "workspace_local";
}

function resolveDynamicActivationWeights(
  weights: ActivationWeights,
  graphAndPathColdScore: number,
  pathPlasticityWeight: number
): ActivationWeights {
  const coldScore = clamp01(graphAndPathColdScore);
  if (coldScore === 0) {
    return weights;
  }

  return Object.freeze({
    ...weights,
    relevance: weights.relevance + (weights.graph_support + pathPlasticityWeight) * coldScore,
    graph_support: weights.graph_support * (1 - coldScore)
  });
}

type ResolvedAdditiveScoringWeights = Required<RecallAdditiveScoringWeights>;
type ResolvedFusionScoringWeights = Readonly<{
  readonly QUERY_EVIDENCE_BASE_TRANSFER_MAX: number;
  readonly QUERY_EVIDENCE_BASE_WEIGHT_FLOOR: number;
}>;

function resolveAdditiveScoringWeights(
  policy: Readonly<RecallPolicy>
): Readonly<ResolvedAdditiveScoringWeights> {
  const overrides = policy.scoring_weight_overrides?.additive;
  return Object.freeze({
    NO_EMBEDDING_RELEVANCE_DIRECT_WEIGHT:
      overrides?.NO_EMBEDDING_RELEVANCE_DIRECT_WEIGHT ?? NO_EMBEDDING_RELEVANCE_DIRECT_WEIGHT,
    CONFIDENCE_DIRECT_WEIGHT:
      overrides?.CONFIDENCE_DIRECT_WEIGHT ?? CONFIDENCE_DIRECT_WEIGHT,
    PATH_PLASTICITY_WEIGHT:
      overrides?.PATH_PLASTICITY_WEIGHT ?? PATH_PLASTICITY_WEIGHT
  });
}

function resolveFusionScoringWeights(
  policy: Readonly<RecallPolicy>
): ResolvedFusionScoringWeights {
  const overrides = policy.scoring_weight_overrides?.fusion_weights;
  return Object.freeze({
    QUERY_EVIDENCE_BASE_TRANSFER_MAX: clamp01(
      overrides?.QUERY_EVIDENCE_BASE_TRANSFER_MAX ?? QUERY_EVIDENCE_BASE_TRANSFER_MAX
    ),
    QUERY_EVIDENCE_BASE_WEIGHT_FLOOR: clamp01(
      overrides?.QUERY_EVIDENCE_BASE_WEIGHT_FLOOR ?? QUERY_EVIDENCE_BASE_WEIGHT_FLOOR
    )
  });
}

function computeQueryEvidenceBaseTransfer(
  baseWeight: number,
  relevanceFactor: number,
  fusionWeights: ResolvedFusionScoringWeights
): number {
  const transferableBase = Math.max(
    0,
    baseWeight - fusionWeights.QUERY_EVIDENCE_BASE_WEIGHT_FLOOR
  );
  const maxTransfer = Math.min(
    fusionWeights.QUERY_EVIDENCE_BASE_TRANSFER_MAX,
    transferableBase
  );
  return clamp01(relevanceFactor) * maxTransfer;
}
