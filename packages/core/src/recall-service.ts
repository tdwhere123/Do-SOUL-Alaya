import { randomUUID } from "node:crypto";
import {
  ControlPlaneObjectKind,
  DYNAMICS_CONSTANTS,
  RecallContextEventType,
  RetentionPolicy,
  SoulRecallCompletedPayloadSchema,
  SoulRecallWeightTransferPayloadSchema,
  StorageTier,
  isPathActiveForRecall,
  isPathGovernedForSuppression,
  isPathRecallEligible,
  type FineAssessmentConfig,
  type ManifestationState,
  type MemoryDimension as MemoryDimensionType,
  type MemoryEntry,
  type PathAnchorRef,
  type PathRelation,
  type ProjectMappingAnchor,
  type RecallCandidate,
  type RecallScoreFactors,
  type RecallPolicy,
  type SoulRecallHostContext,
  type TaskObjectSurface
} from "@do-soul/alaya-protocol";
import { loadGlobalRecallCandidates } from "./global-memory-recall-service.js";
import { compileRecallQueryProbes, type RecallQueryProbes } from "./recall-query-probes.js";
import {
  buildRecallCandidate
} from "./recall-candidate-builder.js";
import { STRATEGY_RECALL_DEFAULTS, type NodeStrategy } from "./task-surface-builder.js";
import {
  COLD_CASCADE_DECAY,
  MIN_RECALL_RESULTS,
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
  mapBudgetPenalty,
  matchesConfiguredCoarseFilter,
  matchesDeterministicFilter,
  matchesPrecomputedRankFilter,
  normalizeGraphSupport,
  normalizeQueryText,
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
  RecallGraphExpansionDiagnostics,
  RecallGraphExpansionTrackedEdgeType,
  RecallPathExpansionSourceDiagnostic,
  RecallResult,
  RecallServiceDependencies,
  RecallServiceWarnPort,
  RecallSupplementaryData,
  RecallTokenEconomy,
  TokenEstimator
} from "./recall-service-types.js";
import { makeTokenEstimator } from "./recall-service-types.js";
import {
  GOVERNANCE_CEILING_FAILSAFE_BAND,
  memoryGovernanceCeiling,
  type PathGovernanceContribution
} from "./path-manifestation-policy.js";
import { parseRecallPolicy } from "./shared/recall-policy.js";
import {
  applyFeatureRerank,
  applyPathSuppressionToFusionScores,
  buildEmptyRecallFusionBreakdown,
  buildRecallFusionDetails,
  compareFusedRecallCandidates,
  prioritizeStrongLexicalDeliveryWindowCandidates,
  reserveStructuralDeliverySlots,
  reserveSynthesisDeliverySlots,
  synthesisReserveCount
} from "./recall/fusion-delivery.js";
import {
  scoreEvidenceAnchorMatch,
  scoreQueryEvidenceMatch
} from "./recall/query-evidence-scoring.js";
import {
  buildRecallDiagnostics,
  computeRecallTokenEconomy,
  finalizeRecallCandidateDiagnostics,
  resolveEmbeddingProviderDegradationReason,
  resolveEmbeddingProviderStatus
} from "./recall/diagnostics.js";
import {
  EDGE_TYPE_HOP_DECAY,
  EARNED_CO_RECALLED_FANIN_RELATION_KIND,
  compareGraphExpansionCandidateDrafts,
  createEmptyGraphExpansionDiagnostics,
  createMutableGraphExpansionDiagnostics,
  freezeGraphExpansionCandidatesResult,
  graphTraversalScoreFromPath,
  mergeGraphExpansionCandidateSources,
  mergeGraphExpansionDiagnosticsAcrossCascade,
  mergeGraphExpansionScores,
  shouldReplaceGraphExpansionCandidate,
  type GraphExpansionCandidateDraft,
  type GraphExpansionCandidateSourceDiagnostic,
  type GraphExpansionCandidatesResult,
  type GraphExpansionFrontierNode
} from "./recall/graph-expansion.js";
import {
  PATH_SUPPRESSION_MAX_PER_TARGET,
  anchorMemoryId,
  collectPathGraphNeighbors,
  directionEligiblePathExpansionTargets,
  firstTimeConcernSeedId,
  isPathExcludedFromRecall,
  normalizeTimeConcernWindowDigest,
  pathAnchorFacetKey,
  pathMatchesTimeConcernWindowDigest,
  pathRelationMemoryIds,
  scorePathRelationExpansion,
  scorePathRelationSuppression,
  uniquePathExpansionSources,
  uniqueStrings
} from "./recall/path-relations.js";
import {
  DYNAMIC_RECALL_SEED_CAP,
  DYNAMIC_RECALL_SOURCE_PROXIMITY_NEIGHBORS_PER_SEED,
  DYNAMIC_RECALL_SOURCE_PROXIMITY_RADIUS,
  ENTITY_GRAPH_EXPANSION_CONFIDENCE_FLOOR,
  EXPANDED_QUERY_RANK_DISCOUNT,
  SOURCE_PROXIMITY_STRUCTURAL_CARRY_MAX,
  buildEvidenceSearchQueries,
  buildEvidenceSourceChunkIndex,
  buildEvidenceSourceCohortKeys,
  buildExpandedKeywordQuery,
  countDomainTags,
  parseEvidenceSourceChunkRef,
  rankCoarseCandidateDrafts,
  resolveSourceProximityAdmissionLimit,
  scoreDomainTagCluster,
  scoreObjectProbeMatch,
  selectExpansionSeedDrafts,
  selectExpansionSeedEntries,
  selectPreferredExpansionSeedEntries,
  selectSourceProximitySeedDrafts,
  uniquePlanes,
  withEmbeddingSimilarityScores,
  type CoarseCandidateDraft
} from "./recall/coarse-candidates.js";
import {
  computeEffectiveScoreDetails,
  computeMaxWeightTransferAmount,
  selectRecallAdmissionAttributionPlane
} from "./recall/scoring.js";
import {
  collectEmbeddingCoarseInjection,
  collectEmbeddingSupplement,
  collectSynthesisCoarseCandidates,
  prepareEmbeddingSupplementQuery
} from "./recall/supplements.js";

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
  RecallServiceGraphSupportPort,
  RecallServiceMemoryRepoPort,
  RecallServicePathExpansionPort,
  RecallServiceProjectMappingPort,
  RecallServiceSlotRepoPort,
  RecallServiceWarnPort,
  RecallTokenEconomy,
  TokenEstimator
} from "./recall-service-types.js";
export { makeTokenEstimator } from "./recall-service-types.js";
export { computeRecallTokenEconomy } from "./recall/diagnostics.js";
export { RECALL_FUSION_STREAMS, recallDeliveryReserveTestInternals } from "./recall/fusion-delivery.js";

const DYNAMIC_RECALL_PLANE_CAP = 240;
const DYNAMIC_RECALL_TOTAL_CANDIDATE_CAP = 1000;
// anchor: entity_seed caps. The per-entity ceiling keeps a single common
// surface (e.g. "config") from flooding the plane; total admit caps
// bound the FTS-call fan-out per recall.
const ENTITY_EXTRACTION_MAX_ENTITIES = 8;
const ENTITY_SEED_PER_ENTITY_TOP_K_STRONG = 8;
const ENTITY_SEED_PER_ENTITY_TOP_K_WEAK = 5;
const ENTITY_SEED_TOTAL_ADMIT_CAP = 60;
const ENTITY_SEED_MIN_SURFACE_LENGTH = 2;
const DYNAMIC_RECALL_COHORT_RADIUS = 8;
const DYNAMIC_RECALL_EDGE_FANOUT = 12;
const MAX_GRAPH_HOPS = 2;
// anchor: shared cap for entity_seed fan-in. Reuses DYNAMIC_RECALL_PLANE_CAP
// so the per-plane admit ceiling is the structural truth and the multi-seed
// path inherits the same bound. see also: DYNAMIC_RECALL_PLANE_CAP
const MULTI_SEED_GRAPH_FAN_OUT_CAP = DYNAMIC_RECALL_PLANE_CAP;
const RECALLS_EDGE_COLD_THRESHOLD = 50;

type CoarseCandidateAdder = (
  entry: Readonly<MemoryEntry>,
  plane: RecallAdmissionPlane,
  structuralScore?: number,
  sourceChannel?: string,
  pathExpansionSource?: RecallPathExpansionSourceDiagnostic,
  // invariant: only forwarded for plane === "entity_seed" by
  // collectEntityDerivedSeeds; other planes leave this undefined.
  entityConfidence?: number,
  // invariant: only forwarded true by the direct path_expansion admission when
  // the traversed PathRelation's relation_kind is the earned co_recalled fan-in
  // carrier; other admissions leave it undefined. see also: addCandidate.
  reachedViaEarnedCoRecalledFanin?: boolean
) => boolean;

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
    const synthesisCoarseFilter = await collectSynthesisCoarseCandidates({
      dependencies: this.dependencies,
      warn: this.warn,
      workspaceId: params.workspaceId,
      queryText,
      queryProbes,
      policy
    });
    const lexicalCoarseCandidates = Object.freeze([
      ...coarseFilter.candidates,
      ...filteredGlobalCandidates,
      ...synthesisCoarseFilter.candidates
    ]) as readonly Readonly<CoarseRecallCandidate>[];
    // invariant: embedding-off recall path stays bit-identical. When the
    // embedding_enabled gate is false this resolves to an empty injection and
    // combinedCoarseCandidates is the exact lexicalCoarseCandidates array.
    const embeddingCoarseInjection = await collectEmbeddingCoarseInjection({
      dependencies: this.dependencies,
      warn: this.warn,
      policy,
      workspaceId: params.workspaceId,
      runId: params.runId ?? null,
      queryText,
      poolCandidates: lexicalCoarseCandidates
    });
    const combinedCoarseCandidates =
      embeddingCoarseInjection.candidates.length === 0
        ? lexicalCoarseCandidates
        : (Object.freeze([
            ...lexicalCoarseCandidates,
            ...embeddingCoarseInjection.candidates
          ]) as readonly Readonly<CoarseRecallCandidate>[]);
    const preparedEmbeddingQueryPromise = prepareEmbeddingSupplementQuery({
      dependencies: this.dependencies,
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
    const embeddingSupplement = await collectEmbeddingSupplement({
      dependencies: this.dependencies,
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
      embeddingSupplement.similarityHintsByObjectId,
      embeddingCoarseInjection.similarityScores
    );
    const finalAssessment =
      Object.keys(embeddingSupplement.similarityHintsByObjectId).length === 0 &&
      embeddingCoarseInjection.candidates.length === 0
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

    // Pure derivation, no async work and no extra corpus reads: token
    // economy is computed from values already materialised above. See
    // computeRecallTokenEconomy @anchor for the latency contract. Degraded
    // recall paths still emit this shape so bench coverage can prove every
    // recall call was instrumented.
    const preparedEmbeddingInferenceCalls =
      embeddingProviderStatus === "provider_returned" &&
      preparedEmbeddingQuery.handle?.cacheHit === false
        ? 1
        : 0;
    const tokenEconomy: Readonly<RecallTokenEconomy> = computeRecallTokenEconomy({
      deliveredCandidates: candidates,
      coarsePoolSize: combinedCoarseCandidates.length,
      // fineAssess scores every coarse candidate before delivery truncation,
      // so the evaluated count equals the pool length even when downstream
      // budgets drop some rows.
      fineEvaluated: combinedCoarseCandidates.length,
      preBudgetCandidates: candidateDiagnostics,
      embeddingInferenceCalls:
        embeddingCoarseInjection.embeddingInferenceCalls + preparedEmbeddingInferenceCalls
    });
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
        graphExpansionDiagnostics: coarseFilter.graphExpansionDiagnostics,
        candidates: candidateDiagnostics,
        tokenEconomy
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

    const base = parseRecallPolicy({
      runtime_id: this.generateRuntimeId(),
      object_kind: ControlPlaneObjectKind.RECALL_POLICY,
      task_surface_ref: taskSurfaceRef,
      expires_at: new Date(new Date(now).getTime() + 30 * 60 * 1000).toISOString(),
      derived_from: taskSurfaceRef,
      retention_policy: RetentionPolicy.SESSION_ONLY,
      coarse_filter: defaults.coarse,
      fine_assessment: defaults.fine
    });
    const decorator = this.dependencies.defaultPolicyDecorator;
    return decorator === undefined ? base : parseRecallPolicy(decorator(base));
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
    readonly trigramFtsRanks: Readonly<Record<string, number>>;
    readonly synthesisFtsRanks: Readonly<Record<string, number>>;
    readonly evidenceFtsRanks: Readonly<Record<string, number>>;
    // see also: packages/core/src/recall-service.ts:RecallService.collectEvidenceGistsByMemoryId.
    readonly evidenceFtsRanksPerRef: Readonly<Record<string, number>>;
    readonly sourceProximityScores: Readonly<Record<string, number>>;
    readonly sourceCohortKeys: Readonly<Record<string, string>>;
    readonly structuralScores: Readonly<Record<string, number>>;
    readonly graphExpansionScores: Readonly<Record<string, number>>;
    readonly graphExpansionDiagnostics: Readonly<RecallGraphExpansionDiagnostics>;
    readonly graphExpansionCandidateSources: ReadonlyMap<string, Readonly<GraphExpansionCandidateSourceDiagnostic>>;
    // see also: packages/core/src/recall-service.ts:RecallService.collectEntityDerivedSeeds.
    readonly entitySeedScores: Readonly<Record<string, number>>;
    readonly pathExpansionScores: Readonly<Record<string, number>>;
    // Negative-path active suppression deltas keyed by target memory id.
    // see also: packages/core/src/recall-service.ts:RecallService.collectNegativePathSuppressions,
    // packages/core/src/recall/fusion-delivery.ts:applyPathSuppressionToFusionScores.
    readonly pathSuppressionScores: Readonly<Record<string, number>>;
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
    const trigramFtsRanks = new Map<string, number>();
    const evidenceFtsRanks = new Map<string, number>();
    // see also: packages/core/src/recall-service.ts:RecallService.collectEvidenceGistsByMemoryId.
    // The per-ref map preserves the best-rank ref; aggregated evidenceFtsRanks loses ref identity.
    const evidenceFtsRanksPerRef = new Map<string, number>();
    const sourceProximityScores = new Map<string, number>();
    let sourceCohortKeys: Readonly<Record<string, string>> = Object.freeze({});
    const structuralScores = new Map<string, number>();
    const graphExpansionScores = new Map<string, number>();
    let graphExpansionDiagnostics = createEmptyGraphExpansionDiagnostics();
    let graphExpansionCandidateSources: ReadonlyMap<string, Readonly<GraphExpansionCandidateSourceDiagnostic>> =
      new Map();
    const entitySeedScores = new Map<string, number>();
    const pathExpansionScores = new Map<string, number>();
    // Active sign-aware suppression: target memory id -> accumulated demotion
    // delta sourced from negative (recall_bias < 0) paths anchored on the
    // expansion seeds. Applied to the fused score before sort.
    // see also: packages/core/src/recall-service.ts:RecallService.collectNegativePathSuppressions,
    // packages/core/src/recall/fusion-delivery.ts:applyPathSuppressionToFusionScores.
    const pathSuppressionScores = new Map<string, number>();
    const addCandidate = (
      entry: Readonly<MemoryEntry>,
      plane: RecallAdmissionPlane,
      structuralScore = 0,
      sourceChannel?: string,
      pathExpansionSource?: RecallPathExpansionSourceDiagnostic,
      entityConfidence?: number,
      reachedViaEarnedCoRecalledFanin?: boolean
    ): boolean => {
      if (
        plane !== "protected_winner" &&
        plane !== "lexical" &&
        plane !== "semantic_supplement" &&
        // invariant: entity_seed admissions still honor the deterministic
        // filter (scope_class / retention / dimension / domain_tag). The
        // entity helper draws from tier-filtered byId, but the underlying
        // memories may not match the strategy's scope/dimension contract;
        // bypassing the filter would let a cross-scope memory leak in just
        // because its surface name appears in the query.
        !winnerMemoryIds.has(entry.object_id) &&
        !matchesDeterministicFilter(entry, config)
      ) {
        return false;
      }
      const current = drafts.get(entry.object_id);
      const hadPlane = current?.admissionPlanes.includes(plane) ?? false;
      const planeScore = clamp01(structuralScore);
      const evidenceStructuralScore =
        plane === "source_proximity"
          ? Math.min(planeScore, SOURCE_PROXIMITY_STRUCTURAL_CARRY_MAX)
          : planeScore;
      const nextStructuralScore = Math.max(current?.structuralScore ?? 0, evidenceStructuralScore);
      // invariant: keep the strongest entity_seed confidence observed for
      // this memory id. Other planes never overwrite a real entityConfidence
      // with undefined. see also: packages/core/src/recall/coarse-candidates.ts:selectExpansionSeedDrafts.
      const nextEntityConfidence =
        plane === "entity_seed" && entityConfidence !== undefined
          ? Math.max(current?.entityConfidence ?? 0, entityConfidence)
          : current?.entityConfidence;
      // invariant: sticky-OR. Once a co_recalled fan-in admission marks this
      // memory id, no later plane admission (lexical / activation / structural)
      // can clear the earned-fan-in provenance, so a sibling reached via the R1
      // carrier keeps its reserve exemption even when it also picks up a generic
      // structural co-admission. see also: packages/core/src/recall/fusion-delivery.ts:isStructuralRescueCandidate.
      const nextReachedViaEarnedCoRecalledFanin =
        (current?.reachedViaEarnedCoRecalledFanin ?? false) ||
        reachedViaEarnedCoRecalledFanin === true;
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
        ]),
        ...(nextEntityConfidence === undefined ? {} : { entityConfidence: nextEntityConfidence }),
        ...(nextReachedViaEarnedCoRecalledFanin
          ? { reachedViaEarnedCoRecalledFanin: true }
          : {})
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
      if (plane === "entity_seed") {
        entitySeedScores.set(
          entry.object_id,
          Math.max(entitySeedScores.get(entry.object_id) ?? 0, evidenceStructuralScore)
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
      return !hadPlane;
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
        if (match.trigram_rank !== undefined && match.trigram_rank > 0) {
          trigramFtsRanks.set(match.object_id, clamp01(match.trigram_rank));
        }
        const entry = byId.get(match.object_id);
        if (entry !== undefined) {
          addCandidate(entry, "lexical", clamp01(match.normalized_rank), "lexical");
        }
      }

      // Deterministic query expansion (morphology folding + static domain
      // synonyms) widens lexical coverage for memories whose distilled wording
      // diverges from the query surface. Expanded hits are admitted at a
      // discounted rank so they cannot out-RRF an exact lexical match, and
      // their original fts rank is not overwritten when both passes hit.
      const expandedQuery = buildExpandedKeywordQuery(queryProbes);
      if (expandedQuery !== null) {
        const expandedSupplement =
          this.dependencies.memoryRepo.searchByKeywordWithinObjectIds !== undefined
            ? await this.dependencies.memoryRepo.searchByKeywordWithinObjectIds(
                workspaceId,
                expandedQuery,
                config.semantic_supplement.max_supplement,
                [...byId.keys()]
              )
            : await this.dependencies.memoryRepo.searchByKeyword!(
                workspaceId,
                expandedQuery,
                config.semantic_supplement.max_supplement
              );
        for (const match of expandedSupplement) {
          const discounted = clamp01(match.normalized_rank) * EXPANDED_QUERY_RANK_DISCOUNT;
          if (discounted <= 0) {
            continue;
          }
          if (!ftsRanks.has(match.object_id)) {
            ftsRanks.set(match.object_id, discounted);
          }
          if (
            match.trigram_rank !== undefined &&
            match.trigram_rank > 0 &&
            !trigramFtsRanks.has(match.object_id)
          ) {
            trigramFtsRanks.set(match.object_id, clamp01(match.trigram_rank) * EXPANDED_QUERY_RANK_DISCOUNT);
          }
          const entry = byId.get(match.object_id);
          if (entry !== undefined) {
            addCandidate(entry, "lexical", discounted, "lexical_expanded");
          }
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
              const ranked = clamp01(match.normalized_rank);
              evidenceRankById.set(match.object_id, ranked);
              evidenceFtsRanksPerRef.set(
                match.object_id,
                Math.max(evidenceFtsRanksPerRef.get(match.object_id) ?? 0, ranked)
              );
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
    const entityDerivedSeeds = await this.collectEntityDerivedSeeds({
      workspaceId,
      queryText,
      byId,
      addCandidate,
      lexicalFtsRanks: ftsRanks
    });
    // invariant: only strong entity signals are eligible to fan into
    // graph_expansion. Weak entities (kind=unknown / cjk_phrase /
    // proper_noun under the floor) stay in the entity_seed plane only —
    // graph fan-in compounds an attacker's surface manipulation across
    // every 1-hop neighbor, so the gate to that compounding must be a
    // high-confidence entity (quoted phrase / explicit code_ref / path /
    // package / task_ref).
    const graphExpansionSeedIds = entityDerivedSeeds
      .filter((seed) => seed.entityConfidence >= ENTITY_GRAPH_EXPANSION_CONFIDENCE_FLOOR)
      .map((seed) => seed.memoryId);
    // invariant: path_expansion (direct hop-1 associations) runs before
    // graph_expansion (multi-hop path traversal) because both planes now read
    // the same PathRelation rows. A direct association admitted on
    // path_expansion must not be re-admitted on graph_expansion — that would
    // give one target two RRF stream slots (double-count). graph_expansion
    // therefore skips any draft already carrying the path_expansion plane and
    // keeps only the propagation reach (hop-2 neighbors, plus hop-1 neighbors
    // of entity-derived seeds that path_expansion's draft-seed pass never
    // visited). see also: packages/core/src/recall-service.ts:RecallService.addGraphExpansionCandidates.
    // Snapshot the Pool A draft seeds before path_expansion runs. Once
    // path_expansion admits a direct hop-1 neighbor, that neighbor becomes a
    // draft carrying the path_expansion plane and would otherwise qualify as a
    // graph BFS seed — collapsing genuine hop-2 reach into hop-1 and rooting
    // traversal at path-reached nodes rather than query anchors. Pinning the
    // seed set to the pre-path drafts keeps hop semantics stable across the
    // ordering change. see also: packages/core/src/recall-service.ts:RecallService.addGraphExpansionCandidates.
    const prePathGraphSeedIds = selectExpansionSeedDrafts(drafts).map((draft) => draft.entry.object_id);
    await this.addPathExpansionCandidates({
      workspaceId,
      byId,
      drafts,
      queryProbes,
      addCandidate
    });
    const graphExpansionResult = await this.addGraphExpansionCandidates({
      workspaceId,
      byId,
      drafts,
      addCandidate,
      extraSeedMemoryIds: graphExpansionSeedIds,
      draftSeedIds: prePathGraphSeedIds
    });
    graphExpansionDiagnostics = graphExpansionResult.diagnostics;
    graphExpansionCandidateSources = graphExpansionResult.candidateSources;
    // Active sign-aware suppression runs off the same expansion seeds. Negative
    // paths are excluded from the positive expansion lanes above (the
    // isPathRecallEligible / direction filters never add their targets); here
    // they are collected separately so a reinforced negative actually demotes
    // its target's fused score instead of merely failing to amplify it.
    await this.collectNegativePathSuppressions({
      workspaceId,
      byId,
      drafts,
      suppressionScores: pathSuppressionScores
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
            ...(draft.reachedViaEarnedCoRecalledFanin
              ? { reachedViaEarnedCoRecalledFanin: true }
              : {}),
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
      trigramFtsRanks: Object.freeze(Object.fromEntries(trigramFtsRanks.entries())),
      synthesisFtsRanks: Object.freeze({}),
      evidenceFtsRanks: Object.freeze(Object.fromEntries(evidenceFtsRanks.entries())),
      evidenceFtsRanksPerRef: Object.freeze(Object.fromEntries(evidenceFtsRanksPerRef.entries())),
      sourceProximityScores: Object.freeze(Object.fromEntries(sourceProximityScores.entries())),
      sourceCohortKeys,
      structuralScores: Object.freeze(Object.fromEntries(structuralScores.entries())),
      graphExpansionScores: Object.freeze(Object.fromEntries(graphExpansionScores.entries())),
      graphExpansionDiagnostics,
      graphExpansionCandidateSources,
      entitySeedScores: Object.freeze(Object.fromEntries(entitySeedScores.entries())),
      pathExpansionScores: Object.freeze(Object.fromEntries(pathExpansionScores.entries())),
      pathSuppressionScores: Object.freeze(Object.fromEntries(pathSuppressionScores.entries())),
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
    // see also: packages/core/src/recall-service.ts:RecallService.collectEntityDerivedSeeds.
    // Entity-bearing memory ids fan into graph_expansion as additional seeds
    // so the graph plane is reachable even when the query never hits a prior
    // expansion seed.
    readonly extraSeedMemoryIds?: readonly string[];
    // Pool A draft-seed object ids snapshotted before path_expansion mutated
    // drafts. When provided, only these ids are eligible as content/structural
    // BFS roots so path-reached neighbors do not become traversal seeds. When
    // omitted the helper falls back to the live draft-seed selection.
    readonly draftSeedIds?: readonly string[];
  }>): Promise<Readonly<GraphExpansionCandidatesResult>> {
    const diagnostics = createMutableGraphExpansionDiagnostics();
    const candidateSources = new Map<string, Readonly<GraphExpansionCandidateSourceDiagnostic>>();
    // invariant: graph_expansion is the multi-hop traversal of the unified
    // PathRelation plane. It reads the same pathExpansionPort the direct
    // path_expansion plane uses. When no path port is wired the plane is empty.
    const pathExpansionPort = this.dependencies.pathExpansionPort;
    if (pathExpansionPort === undefined) {
      return freezeGraphExpansionCandidatesResult(diagnostics, candidateSources);
    }

    // invariant: entity-derived seeds drive the per-seed fan-in path (Pool B)
    // even when they were also admitted into drafts via the entity_seed plane.
    // Filtering them out of the pooled draft seeds (Pool A) below avoids
    // double-traversing the same anchor while keeping the legacy
    // content/structural seed BFS intact for non-entity callers.
    // see also: packages/core/src/recall-service.ts:RecallService.collectEntityDerivedSeeds.
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

    // Pool A: content / structural draft seeds (entity-derived seeds run
    // through Pool B instead) expand as a single pooled frontier. When no
    // entity-derived seeds are present this is the only active branch and
    // multi_seed_graph_fan_in stays undefined.
    if (draftSeeds.length > 0) {
      const draftSeedEntries = draftSeeds.map((seed) => seed.entry);
      await this.expandGraphFrontier({
        workspaceId: params.workspaceId,
        byId: params.byId,
        pathExpansionPort,
        seedEntries: draftSeedEntries,
        onCandidate: (candidate) => {
          const current = bestCandidates.get(candidate.entry.object_id);
          if (current === undefined || shouldReplaceGraphExpansionCandidate(candidate, current)) {
            bestCandidates.set(candidate.entry.object_id, candidate);
          }
        }
      });
    }

    // Pool B: entity-derived seeds fan in independently. Each seed runs its
    // own BFS with a fresh expandedIds set so a seed reached early by one
    // entity does not starve another entity's expansion. Per-seed candidate
    // maps feed max-score dedup so a memory hit by two different entity
    // paths records 1 dedup collision and keeps the higher-scoring draft.
    if (entitySeedEntries.length > 0) {
      diagnostics.multi_seed_fan_in_distinct_seeds = entitySeedEntries.length;
      const perSeedCandidates: Map<string, GraphExpansionCandidateDraft>[] = [];
      for (const seedEntry of entitySeedEntries) {
        const seedMap = new Map<string, GraphExpansionCandidateDraft>();
        await this.expandGraphFrontier({
          workspaceId: params.workspaceId,
          byId: params.byId,
          pathExpansionPort,
          seedEntries: [seedEntry],
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
      // anchor: max-score reduction across per-seed maps. Same candidate
      // reached by two distinct entity seeds increments dedup_collisions
      // once per extra arrival and keeps the strongest draft via the
      // shared shouldReplaceGraphExpansionCandidate ordering.
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
      .slice(0, MULTI_SEED_GRAPH_FAN_OUT_CAP);
    for (const candidate of admitted) {
      // double-count guard: path_expansion already runs (earlier in
      // coarseFilter) and admits direct associations off the same PathRelation
      // rows. A target it admitted must not also enter the graph_expansion
      // plane — both planes feed independent RRF streams, so re-admitting here
      // would hand one memory two stream slots. The graph plane keeps only the
      // multi-hop reach path_expansion's direct pass never produced.
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

  // anchor: single-source / pooled BFS expansion shared by both the pooled
  // draft-seed path and the per-seed entity fan-in path. expandedIds is
  // private to each invocation so a per-seed Pool B call cannot starve a
  // sibling seed by absorbing its 1-hop neighbors first.
  // see also: packages/core/src/recall-service.ts:RecallService.addGraphExpansionCandidates.
  private async expandGraphFrontier(params: Readonly<{
    readonly workspaceId: string;
    readonly byId: ReadonlyMap<string, Readonly<MemoryEntry>>;
    readonly pathExpansionPort: NonNullable<RecallServiceDependencies["pathExpansionPort"]>;
    readonly seedEntries: readonly Readonly<MemoryEntry>[];
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

    for (let hop = 1; hop <= MAX_GRAPH_HOPS && frontier.length > 0; hop += 1) {
      const nextFrontier = new Map<string, GraphExpansionFrontierNode>();
      // Resolve the still-unexpanded frontier nodes into a single batched
      // findByAnchors lookup so multi-hop traversal does not issue one query
      // per node. The path repo returns every active path anchored on any of
      // the requested object ids; the per-node direction filter below re-binds
      // each path to the frontier node it actually leaves from.
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
        this.warn("graph expansion path lookup failed", {
          workspace_id: params.workspaceId,
          seed_count: frontierIds.length,
          error: toErrorMessage(error)
        });
        break;
      }
      // invariant: only recall-eligible (active + recall_bias > 0) paths
      // propagate. Negative / neutral paths are handled by active suppression
      // (collectNegativePathSuppressions), never by traversal — admitting them
      // as positive neighbors would amplify a suppressed memory.
      const eligiblePaths = paths.filter((path) => isPathRecallEligible(path));
      const frontierIdSet = new Set(frontierIds);
      for (const node of frontier) {
        if (expandedIds.has(node.memoryId)) {
          continue;
        }
        expandedIds.add(node.memoryId);
        const nodeNeighbors = collectPathGraphNeighbors(eligiblePaths, node.memoryId)
          .slice(0, DYNAMIC_RECALL_EDGE_FANOUT);
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
          // Same-relation chain-extension gate: at hop >= 2, drop a neighbor
          // reached by the SAME relation_kind as its parent. Such single-relation
          // lineage walks (e.g. a long derives_from chain) flood the pool with
          // near-gold-free neighbours that demote genuine lexical / path gold
          // under fusion. Keyed on the raw relation_kind, not the folded tracked
          // edge_type, so heterogeneous associative reach (e.g. co_recalled ->
          // shares_entity) stays admitted as healthy convergence; hop-1
          // (arrivalRelationKind null) is never gated.
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
          if (hop < MAX_GRAPH_HOPS && !expandedIds.has(neighborId) && !frontierIdSet.has(neighborId)) {
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

  // anchor: query-time entity FTS seeding. Returns the memory ids of every
  // candidate admitted on the entity_seed plane (paired with the originating
  // entity confidence) so the caller can fan them into graph_expansion as
  // additional seeds subject to a confidence floor. The helper is fail-soft:
  // if no port is wired, no query text is present, or the keyword search port
  // is missing, returns an empty list and the recall pipeline degrades
  // gracefully back to the pre-entity behavior.
  // see also: packages/core/src/entity-extraction-port.ts EntityExtractionPort
  private async collectEntityDerivedSeeds(params: Readonly<{
    readonly workspaceId: string;
    readonly queryText: string | null;
    readonly byId: ReadonlyMap<string, Readonly<MemoryEntry>>;
    readonly addCandidate: CoarseCandidateAdder;
    // invariant: lexical FTS ranks observed during this coarse pass.
    // When an entity-FTS hit overlaps a lexical_fts hit the RRF contribution
    // must come from the lexical lane only — otherwise a single surface term
    // gets two fusion-stream rank slots and an attacker-controlled query can
    // roughly double a memory's fused score.
    readonly lexicalFtsRanks: ReadonlyMap<string, number>;
  }>): Promise<readonly Readonly<{ memoryId: string; entityConfidence: number }>[]> {
    const port = this.dependencies.entityExtractionPort;
    const memoryRepo = this.dependencies.memoryRepo;
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
      entities = await port.extract(params.queryText, { maxEntities: ENTITY_EXTRACTION_MAX_ENTITIES });
    } catch (error) {
      this.warn("entity extraction failed", {
        workspace_id: params.workspaceId,
        error: toErrorMessage(error)
      });
      return [];
    }
    if (entities.length === 0) {
      return [];
    }

    // Track the strongest entity confidence we observed per memory id. The
    // caller filters this against ENTITY_GRAPH_EXPANSION_CONFIDENCE_FLOOR
    // when deciding which seeds may fan into graph_expansion.
    const seedConfidenceById = new Map<string, number>();
    let admittedTotal = 0;
    const candidateIds = [...params.byId.keys()];
    for (const entity of entities) {
      if (admittedTotal >= ENTITY_SEED_TOTAL_ADMIT_CAP) {
        break;
      }
      const surface = entity.surface.trim();
      if (surface.length < ENTITY_SEED_MIN_SURFACE_LENGTH) {
        continue;
      }
      const perEntityLimit = entity.confidence >= 0.85
        ? ENTITY_SEED_PER_ENTITY_TOP_K_STRONG
        : ENTITY_SEED_PER_ENTITY_TOP_K_WEAK;
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
        this.warn("entity seed lookup failed", {
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
        // see also: lexicalFtsRanks doc above. Lexical-overlap admissions
        // still register on the entity_seed plane (so admission_planes
        // diagnostics can distinguish entity-only from entity+lexical hits)
        // but the RRF rank contribution is zeroed out — the entity_seed
        // stream returns 0 for this id and drops out of fusion, preventing
        // a single surface term from claiming two fusion-stream rank slots.
        const hasLexicalOverlap = (params.lexicalFtsRanks.get(hit.object_id) ?? 0) > 0;
        const score = hasLexicalOverlap ? 0 : rawScore;
        // The 6th argument (entityConfidence) lets the draft pool reason
        // about gating entity-only weak admissions out of graph_expansion
        // fan-in via the path-1 seed pool.
        // see also: packages/core/src/recall/coarse-candidates.ts:selectExpansionSeedDrafts,
        // packages/core/src/recall/coarse-candidates.ts:ENTITY_GRAPH_EXPANSION_CONFIDENCE_FLOOR.
        params.addCandidate(entry, "entity_seed", score, "entity_seed", undefined, entity.confidence);
        const previous = seedConfidenceById.get(entry.object_id) ?? 0;
        if (entity.confidence > previous) {
          seedConfidenceById.set(entry.object_id, entity.confidence);
        }
        admittedTotal += 1;
        if (admittedTotal >= ENTITY_SEED_TOTAL_ADMIT_CAP) {
          break;
        }
      }
    }
    return [...seedConfidenceById.entries()].map(([memoryId, entityConfidence]) =>
      Object.freeze({ memoryId, entityConfidence })
    );
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
      if (isPathExcludedFromRecall(path)) {
        continue;
      }
      // Gold-blind: the discriminator reads the EARNED path's relation_kind, not
      // a gold label. Only the co_recalled fan-in carrier (minted past the R1
      // threshold-3 counter gate) grants the reserve exemption; every other
      // relation_kind admitted here stays relevance-gated downstream.
      const reachedViaEarnedCoRecalledFanin =
        path.constitution.relation_kind === EARNED_CO_RECALLED_FANIN_RELATION_KIND;
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
            source_channel: "path_expansion",
            relation_kind: path.constitution.relation_kind,
            facet_key: pathAnchorFacetKey(path)
          },
          undefined,
          reachedViaEarnedCoRecalledFanin
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
      if (isPathExcludedFromRecall(path) || !pathMatchesTimeConcernWindowDigest(path, windowDigests)) {
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
            source_channel: "time_concern",
            relation_kind: path.constitution.relation_kind,
            facet_key: pathAnchorFacetKey(path)
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

  // anchor: active sign-aware suppression collector. Reuses the same expansion
  // seeds and pathExpansionPort.findByAnchors lookup as path_expansion, but
  // selects the negative (recall_bias < 0) active paths that the positive
  // lanes deliberately exclude. Each such path demotes its direction-eligible
  // target by a strength-gated delta (scorePathRelationSuppression). Deltas
  // accumulate per target so multiple converging negatives compound. The
  // collected map is applied to the fused score before sort. Fail-soft: a
  // missing port or lookup failure leaves suppression empty and recall
  // degrades to the no-suppression behavior.
  // see also: packages/core/src/recall/fusion-delivery.ts:applyPathSuppressionToFusionScores,
  // packages/core/src/recall/path-relations.ts:scorePathRelationSuppression.
  private async collectNegativePathSuppressions(params: Readonly<{
    readonly workspaceId: string;
    readonly byId: ReadonlyMap<string, Readonly<MemoryEntry>>;
    readonly drafts: ReadonlyMap<string, CoarseCandidateDraft>;
    readonly suppressionScores: Map<string, number>;
  }>): Promise<void> {
    const pathExpansionPort = this.dependencies.pathExpansionPort;
    if (pathExpansionPort === undefined || params.drafts.size === 0) {
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
      this.warn("path suppression lookup failed", {
        workspace_id: params.workspaceId,
        seed_count: seeds.length,
        error: toErrorMessage(error)
      });
      return;
    }
    for (const path of paths) {
      // invariant: only active, strictly-negative, governance-trusted paths
      // suppress. Active lifecycle reuses isPathActiveForRecall (dormant/retired
      // never suppress). isPathGovernedForSuppression is the governance gate:
      // attention_only / hint_only negatives are agent-reachable through
      // co-occurrence seeding + strength reinforcement, so they may exclude (via
      // isPathRecallEligible) but never actively demote — strength alone cannot
      // license suppression. Only recall_allowed / strictly_governed negatives
      // reach the strength-scaled delta below.
      // see also: path-relation.ts isPathGovernedForSuppression.
      if (
        !isPathActiveForRecall(path.lifecycle.status) ||
        path.effect_vector.recall_bias >= 0 ||
        !isPathGovernedForSuppression(path)
      ) {
        continue;
      }
      const delta = scorePathRelationSuppression(path);
      if (delta <= 0) {
        continue;
      }
      for (const target of directionEligiblePathExpansionTargets(path, seedIds)) {
        if (!params.byId.has(target.targetId)) {
          continue;
        }
        // invariant: per-target accumulation is capped at
        // packages/core/src/recall/path-relations.ts:PATH_SUPPRESSION_MAX_PER_TARGET
        // so converging negatives compound up to one reinforced-supersession
        // delta but never gang into erasure.
        const accumulated =
          (params.suppressionScores.get(target.targetId) ?? 0) + delta;
        params.suppressionScores.set(
          target.targetId,
          Math.min(accumulated, PATH_SUPPRESSION_MAX_PER_TARGET)
        );
      }
    }
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

  private async collectSupplementaryData(params: {
    readonly candidates: readonly Readonly<MemoryEntry>[];
    readonly workspaceId: string;
    readonly runId: string | null;
    readonly queryText: string | null;
    readonly queryProbes: Readonly<RecallQueryProbes>;
    readonly policy: Readonly<RecallPolicy>;
    readonly coarseFtsRanks: Readonly<Record<string, number>>;
    readonly coarseTrigramFtsRanks: Readonly<Record<string, number>>;
    readonly coarseSynthesisFtsRanks: Readonly<Record<string, number>>;
    readonly coarseEvidenceFtsRanks: Readonly<Record<string, number>>;
    readonly coarseEvidenceFtsRanksPerRef: Readonly<Record<string, number>>;
    readonly coarseSourceProximityScores: Readonly<Record<string, number>>;
    readonly coarseSourceCohortKeys: Readonly<Record<string, string>>;
    readonly coarseStructuralScores: Readonly<Record<string, number>>;
    readonly coarseGraphExpansionScores: Readonly<Record<string, number>>;
    readonly coarseEntitySeedScores: Readonly<Record<string, number>>;
    readonly coarsePathExpansionScores: Readonly<Record<string, number>>;
    readonly coarsePathSuppressionScores: Readonly<Record<string, number>>;
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
    const weightTransferAmount = computeMaxWeightTransferAmount({
      candidates: params.candidates,
      policy: params.policy,
      graphAndPathColdScore,
      warn: this.warn
    });

    // Evidence gist piggy-back: for the small subset of candidates whose
    // entry into the pool came through an evidence FTS hit, fetch the
    // associated evidence capsules so the feature rerank can score against
    // the gist paraphrase. A missing findByIds port (or fetch failure) is
    // fail-soft → empty map → rerank falls back to content-only.
    const evidenceGistsByMemoryId = await this.collectEvidenceGistsByMemoryId(
      params.workspaceId,
      params.candidates,
      params.coarseEvidenceFtsRanks,
      params.coarseEvidenceFtsRanksPerRef
    );

    const governanceCeilingByMemoryId = await this.collectGovernanceCeilings(
      params.workspaceId,
      params.candidates
    );

    return Object.freeze({
      queryProbes: params.queryProbes,
      ftsRanks: params.coarseFtsRanks,
      trigramFtsRanks: params.coarseTrigramFtsRanks,
      synthesisFtsRanks: params.coarseSynthesisFtsRanks,
      evidenceFtsRanks: params.coarseEvidenceFtsRanks,
      sourceProximityScores: params.coarseSourceProximityScores,
      sourceCohortKeys: params.coarseSourceCohortKeys,
      structuralScores: params.coarseStructuralScores,
      graphExpansionScores: params.coarseGraphExpansionScores,
      entitySeedScores: params.coarseEntitySeedScores,
      pathExpansionScores: params.coarsePathExpansionScores,
      pathSuppressionScores: params.coarsePathSuppressionScores,
      embeddingSimilarityScores: Object.freeze({}),
      graphSupportCounts: Object.freeze(graphSupportCounts),
      budgetPenaltyFactor,
      plasticityFactors,
      graphAndPathColdScore,
      recallsEdgeCount,
      weightTransferAmount,
      evidenceGistsByMemoryId,
      governanceCeilingByMemoryId
    });
  }

  private async collectEvidenceGistsByMemoryId(
    workspaceId: string,
    candidates: readonly Readonly<MemoryEntry>[],
    coarseEvidenceFtsRanks: Readonly<Record<string, number>>,
    coarseEvidenceFtsRanksPerRef: Readonly<Record<string, number>>
  ): Promise<Readonly<Record<string, string>>> {
    const evidenceSearchPort = this.dependencies.evidenceSearchPort;
    if (evidenceSearchPort?.findByIds === undefined) {
      return Object.freeze({});
    }
    // Restrict to candidates that already landed in the pool through an
    // evidence FTS hit — their gists are the ones whose paraphrase carries
    // recall-relevant semantics. Avoids an unbounded findByIds over every
    // memory's full evidence_refs set.
    const relevantCandidates = candidates.filter(
      (entry) =>
        entry.evidence_refs.length > 0 &&
        (coarseEvidenceFtsRanks[entry.object_id] ?? 0) > 0
    );
    if (relevantCandidates.length === 0) {
      return Object.freeze({});
    }
    // invariant: findByIds payload bounded by evidence-FTS hit set, not the
    // candidate's full evidence_refs cardinality. see also: P2-R2-E.
    //
    // invariant: per-memory evidence_refs cardinality is capped at
    // MAX_REFS_PER_MEMORY before the findByIds payload is built. A typical
    // memory carries 1-3 evidence_refs; an outlier with thousands of refs
    // (whether legitimate aggregation or adversarial) would dominate the
    // tokenizer / new Set fan-out inside the rerank loop. Cap reflects the
    // semantic assumption "one memory should not need more than this many
    // evidence anchors to recall well" — refs beyond the cap are sorted by
    // per-ref evidence-FTS rank and only the top MAX_REFS_PER_MEMORY are
    // forwarded; the best-rank ref (used by the gist picker below) is
    // always preserved.
    const MAX_REFS_PER_MEMORY = 8;
    const evidenceIds = uniqueStrings(
      relevantCandidates.flatMap((entry) => {
        const hitRefs = entry.evidence_refs.filter(
          (ref) => (coarseEvidenceFtsRanksPerRef[ref] ?? 0) > 0
        );
        if (hitRefs.length <= MAX_REFS_PER_MEMORY) {
          return hitRefs;
        }
        return [...hitRefs]
          .sort(
            (left, right) =>
              (coarseEvidenceFtsRanksPerRef[right] ?? 0) -
              (coarseEvidenceFtsRanksPerRef[left] ?? 0)
          )
          .slice(0, MAX_REFS_PER_MEMORY);
      })
    );
    if (evidenceIds.length === 0) {
      return Object.freeze({});
    }
    try {
      const evidenceCapsules = await evidenceSearchPort.findByIds(workspaceId, evidenceIds);
      const gistById = new Map<string, string>();
      for (const evidence of evidenceCapsules) {
        if (evidence.workspace_id !== workspaceId) {
          continue;
        }
        const gist = evidence.gist?.trim() ?? "";
        if (gist.length > 0) {
          gistById.set(evidence.object_id, gist);
        }
      }
      const gistsByMemory: Record<string, string> = {};
      for (const entry of relevantCandidates) {
        // invariant: pick gist from the highest-ranked ref in evidence_refs
        // (per coarseEvidenceFtsRanksPerRef); stable by evidence_refs order
        // on ties. see also: P2-R2-B in collectEvidenceGistsByMemoryId callers.
        const refsWithRank = entry.evidence_refs.map((ref) => Object.freeze({
          ref,
          rank: coarseEvidenceFtsRanksPerRef[ref] ?? 0
        }));
        const orderedRefs = [...refsWithRank].sort((left, right) => right.rank - left.rank);
        for (const { ref } of orderedRefs) {
          const gist = gistById.get(ref);
          if (gist !== undefined && gist.length > 0) {
            gistsByMemory[entry.object_id] = gist;
            break;
          }
        }
        // fallback: aggregated rank > 0 but no per-ref rank populated; mirrors
        // legacy first-non-empty-gist rule so future producers that only
        // populate the aggregate stay correct.
        // unreachable under current producer (coarseEvidenceFtsRanksPerRef
        // always populates every ref in evidence_refs); kept for forward-compat
        // with future producers that only emit the aggregate rank.
        if (gistsByMemory[entry.object_id] === undefined) {
          for (const ref of entry.evidence_refs) {
            const gist = gistById.get(ref);
            if (gist !== undefined && gist.length > 0) {
              gistsByMemory[entry.object_id] = gist;
              break;
            }
          }
        }
      }
      return Object.freeze(gistsByMemory);
    } catch (error) {
      this.warn("evidence gist lookup for rerank failed", {
        workspace_id: workspaceId,
        error: toErrorMessage(error)
      });
      return Object.freeze({});
    }
  }

  // invariant: governance_class is a HARD CEILING on recall manifestation.
  // For each candidate memory, collect its INBOUND recall-eligible
  // PathRelations (isPathRecallEligible: active + recall_bias > 0) — the paths
  // whose target_anchor resolves to that memory — and reduce their governance
  // contributions through memoryGovernanceCeiling. A memory with no governing
  // inbound path is ABSENT from the returned map; the clamp site defaults it to
  // full_eligible (unrestricted), so the ceiling only LOWERS, never suppresses
  // an ordinary ungoverned memory.
  //
  // invariant: the ceiling must not ride the agent-pumpable governance band. We
  // pass each path's legitimacy.evidence_basis alongside its governance_class so
  // memoryGovernanceCeiling can treat an auto-promoted recall_allowed (birth
  // marker only) as at most excerpt; only a trusted-provenance recall_allowed
  // contributes full_eligible. (The recall-WEIGHTING / plasticity use of the
  // promoted band elsewhere is unchanged — only this ceiling's trust narrows.)
  //
  // invariant: fail-OPEN vs fail-CLOSED are distinct:
  //   - pathExpansionPort ABSENT  => governance plane not deployed; empty map =>
  //     full_eligible (open) is an acceptable deployment choice.
  //   - findByAnchors THREW        => transient read failure; a hard ceiling that
  //     vanishes on error is soft. Cap EVERY candidate to the safe band
  //     (GOVERNANCE_CEILING_FAILSAFE_BAND = excerpt) via an explicit per-id map,
  //     NOT an empty map. Recall still returns/scores/ranks; only preview DETAIL
  //     is conservatively bounded until governance can be read.
  // see also: path-manifestation-policy.ts memoryGovernanceCeiling,
  //   path-manifestation-policy.ts GOVERNANCE_CEILING_FAILSAFE_BAND,
  //   recall-candidate-builder.ts buildRecallCandidate (clamp site).
  private async collectGovernanceCeilings(
    workspaceId: string,
    candidates: readonly Readonly<MemoryEntry>[]
  ): Promise<Readonly<Record<string, ManifestationState>>> {
    const pathExpansionPort = this.dependencies.pathExpansionPort;
    if (pathExpansionPort === undefined || candidates.length === 0) {
      return Object.freeze({});
    }
    const candidateIds = new Set(candidates.map((candidate) => candidate.object_id));
    const anchors: PathAnchorRef[] = [...candidateIds].map((object_id) => ({
      kind: "object",
      object_id
    }));
    let paths: readonly Readonly<PathRelation>[];
    try {
      paths = await pathExpansionPort.findByAnchors(workspaceId, anchors);
    } catch (error) {
      this.warn("governance ceiling path lookup failed", {
        workspace_id: workspaceId,
        candidate_count: candidates.length,
        error: toErrorMessage(error)
      });
      // fail-CLOSED: cap every candidate to the safe band so a transient read
      // error cannot lift a governed memory to its full strength tier.
      const failsafeCeilings: Record<string, ManifestationState> = {};
      for (const object_id of candidateIds) {
        failsafeCeilings[object_id] = GOVERNANCE_CEILING_FAILSAFE_BAND;
      }
      return Object.freeze(failsafeCeilings);
    }
    const contributionsByMemoryId = new Map<string, PathGovernanceContribution[]>();
    for (const path of paths) {
      if (!isPathRecallEligible(path)) {
        continue;
      }
      // invariant: the ceiling is INBOUND — keyed on the path's target memory.
      // findByAnchors also returns paths where the candidate is the SOURCE
      // anchor; those govern the path's target, not the source, so they must
      // not raise/lower the source memory's ceiling.
      const targetMemoryId = anchorMemoryId(path.anchors.target_anchor);
      if (targetMemoryId === undefined || !candidateIds.has(targetMemoryId)) {
        continue;
      }
      const contribution: PathGovernanceContribution = {
        governance_class: path.legitimacy.governance_class,
        evidence_basis: path.legitimacy.evidence_basis
      };
      const contributions = contributionsByMemoryId.get(targetMemoryId);
      if (contributions === undefined) {
        contributionsByMemoryId.set(targetMemoryId, [contribution]);
      } else {
        contributions.push(contribution);
      }
    }
    const ceilingByMemoryId: Record<string, ManifestationState> = {};
    for (const [memoryId, contributions] of contributionsByMemoryId) {
      ceilingByMemoryId[memoryId] = memoryGovernanceCeiling(contributions);
    }
    return Object.freeze(ceilingByMemoryId);
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
      const scored = computeEffectiveScoreDetails({
        entry: candidate.entry,
        policy,
        winnerMemoryIds,
        supplementaryData,
        originPlane: candidate.originPlane ?? "workspace_local",
        isAdvisory: candidate.isAdvisory ?? false,
        scoreMultiplier: candidate.scoreMultiplier ?? 1,
        objectKind: candidate.objectKind ?? "memory_entry",
        now: this.now,
        warn: this.warn
      });
      return Object.freeze({
        ...candidate,
        effectiveScore: scored.score,
        effectiveFactors: scored.factors
      });
    });
    const fusedDetails = buildRecallFusionDetails({
      candidates: additiveScoredCandidates,
      policy,
      supplementaryData,
      nowIso: this.now()
    });
    // Active sign-aware suppression: subtract the negative-path demotion delta
    // from the fused score and re-rank, before delivery sort. Runs after the
    // positive fusion so suppression demotes a target that positive streams
    // would otherwise rank highly. No-op when no suppression was collected.
    const fusionByCandidateKey = applyPathSuppressionToFusionScores(
      fusedDetails,
      supplementaryData.pathSuppressionScores
    );
    const scoredCandidates = additiveScoredCandidates.map((candidate) => Object.freeze({
      ...candidate,
      fusion: fusionByCandidateKey.get(buildRecallCandidateDedupeKey(candidate)) ?? buildEmptyRecallFusionBreakdown(candidate.entry.object_id)
    }));
    const rankedCandidates = scoredCandidates
      .sort(compareFusedRecallCandidates);
    const featureRerankedCandidates = applyFeatureRerank(rankedCandidates, supplementaryData);
    const prioritizedCandidates = prioritizeStrongLexicalDeliveryWindowCandidates(
      featureRerankedCandidates,
      supplementaryData,
      config.budgets.max_entries
    );
    const synthesisReservedCandidates = reserveSynthesisDeliverySlots(
      prioritizedCandidates,
      supplementaryData,
      config.budgets.max_entries
    );
    const deliveryOrderedCandidates = reserveStructuralDeliverySlots(
      synthesisReservedCandidates,
      supplementaryData,
      config.budgets.max_entries,
      synthesisReserveCount(prioritizedCandidates, config.budgets.max_entries)
    );

    // Per-stage delivery-rank capture (1-based). Each fineAssess stage reorders
    // the full set without dropping, so a candidate's index per stage shows the
    // step at which it left the top-k window. Diagnostic-only.
    const buildStageRankMap = (
      ordered: readonly Readonly<CoarseRecallCandidate>[]
    ): ReadonlyMap<string, number> => {
      const ranks = new Map<string, number>();
      ordered.forEach((item, index) => {
        ranks.set(buildRecallCandidateDedupeKey(item), index + 1);
      });
      return ranks;
    };
    const rankAfterFusion = buildStageRankMap(rankedCandidates);
    const rankAfterFeatureRerank = buildStageRankMap(featureRerankedCandidates);
    const rankAfterLexicalPriority = buildStageRankMap(prioritizedCandidates);
    const rankAfterSynthesisReserve = buildStageRankMap(synthesisReservedCandidates);
    const rankAfterStructuralReserve = buildStageRankMap(deliveryOrderedCandidates);

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
        const maxEntries = config.budgets.max_entries;
        const rankAfterLex = rankAfterLexicalPriority.get(candidateKey);
        const rankAfterSyn = rankAfterSynthesisReserve.get(candidateKey);
        const rankAfterStruct = rankAfterStructuralReserve.get(candidateKey);
        // A candidate is "reserved" by the stage that first pulled it inside the
        // top-k window it was outside of after lexical priority.
        const reservedBy: "none" | "synthesis" | "structural" =
          rankAfterSyn !== undefined && rankAfterSyn <= maxEntries &&
          (rankAfterLex === undefined || rankAfterLex > maxEntries)
            ? "synthesis"
            : rankAfterStruct !== undefined && rankAfterStruct <= maxEntries &&
              (rankAfterSyn === undefined || rankAfterSyn > maxEntries)
              ? "structural"
              : "none";
        return Object.freeze({
          candidate_key: candidateKey,
          object_id: entry.object_id,
          object_kind: objectKind,
          dimension: entry.dimension,
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
          path_expansion_sources: Object.freeze([...(candidate.pathExpansionSources ?? [])]),
          rank_after_fusion: rankAfterFusion.get(candidateKey),
          rank_after_feature_rerank: rankAfterFeatureRerank.get(candidateKey),
          rank_after_lexical_priority: rankAfterLex,
          rank_after_synthesis_reserve: rankAfterSyn,
          rank_after_structural_reserve: rankAfterStruct,
          reserved_by: reservedBy
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
        usedTokensBeforeCandidate: accumulator.totalTokens,
        // governance HARD CEILING; absent => unrestricted (full_eligible).
        // see also: collectGovernanceCeilings, path-manifestation-policy.ts.
        governanceCeiling: supplementaryData.governanceCeilingByMemoryId[entry.object_id]
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


}
