import { randomUUID } from "node:crypto";
import {
  DYNAMICS_CONSTANTS,
  RecallContextEventType,
  SoulRecallCompletedPayloadSchema,
  StorageTier,
  type MemoryEntry,
  type ProjectMappingAnchor,
  type RecallPolicy,
  type SoulRecallHostContext,
  type TaskObjectSurface
} from "@do-soul/alaya-protocol";
import { loadGlobalRecallCandidates } from "./global-memory-recall-service.js";
import { compileRecallQueryProbes, type RecallQueryProbes } from "./recall-query-probes.js";
import { type NodeStrategy } from "../conversation/task-surface-builder.js";
import {
  assertActivationWeightsSumToOne,
  classifyGlobalCandidate,
  classifyProjectMappingCandidate,
  clamp01,
  compareMemoryEntries,
  entryMatchesTimeFilter,
  filterMemoriesByTimeWindow,
  getGlobalRecallLimit,
  matchesConfiguredCoarseFilter,
  matchesDeterministicFilter,
  matchesPrecomputedRankFilter,
  normalizeQueryText,
  toErrorMessage,
  type RecallTimeFilter
} from "./recall-service-helpers.js";
import type {
  CoarseRecallCandidate,
  RecallAdmissionPlane,
  RecallCandidateDiagnostic,
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
  RecallTokenEconomy,
  TokenEstimator
} from "./recall-service-types.js";
import { makeTokenEstimator } from "./recall-service-types.js";
import {
  addContentDerivedExpansionCandidates,
  addSourceProximityCandidates
} from "./content-expansion.js";
import {
  buildRecallDiagnostics,
  computeRecallTokenEconomy,
  finalizeRecallCandidateDiagnostics,
  resolveEmbeddingProviderDegradationReason,
  resolveEmbeddingProviderStatus
} from "./diagnostics.js";
import {
  createEmptyGraphExpansionDiagnostics,
  type GraphExpansionCandidateSourceDiagnostic,
} from "./graph-expansion.js";
import {
  uniquePathExpansionSources,
  uniqueStrings
} from "./path-relations.js";
import {
  addPathExpansionCandidates,
  collectNegativePathSuppressions
} from "./path-expansion.js";
import {
  addGraphExpansionCandidates,
  collectEntityDerivedSeeds
} from "./structural-expansion.js";
import {
  applyManifestationBiasSidecar,
  appendWeightTransferTelemetry,
  assessCoarseFilter,
  buildDefaultPolicy,
  expandTierCascade,
  loadActiveConstraints,
  mergeCoarseFilters,
  recordGlobalRecallClassificationsSafely,
  resolvePolicy
} from "./orchestration.js";
import {
  ENTITY_GRAPH_EXPANSION_CONFIDENCE_FLOOR,
  EXPANDED_QUERY_RANK_DISCOUNT,
  SOURCE_PROXIMITY_STRUCTURAL_CARRY_MAX,
  buildEvidenceSearchQueries,
  buildExpandedKeywordQuery,
  rankCoarseCandidateDrafts,
  resolveSourceProximityAdmissionLimit,
  scoreObjectProbeMatch,
  selectExpansionSeedDrafts,
  uniquePlanes,
  withEmbeddingSimilarityScores,
  type CoarseCandidateDraft
} from "./coarse-candidates.js";
import { fineAssess } from "./fine-assessment.js";
import {
  collectEmbeddingCoarseInjection,
  collectEmbeddingSupplement,
  collectSynthesisCoarseCandidates,
  prepareEmbeddingSupplementQuery
} from "./supplements.js";

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
export { computeRecallTokenEconomy } from "./diagnostics.js";
export { RECALL_FUSION_STREAMS, recallDeliveryReserveTestInternals } from "./fusion-delivery.js";

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
const RECALLS_EDGE_COLD_THRESHOLD = 50;
// anchor: shared cap for entity_seed fan-in. Reuses DYNAMIC_RECALL_PLANE_CAP
// so the per-plane admit ceiling is the structural truth and the multi-seed
// path inherits the same bound. see also: DYNAMIC_RECALL_PLANE_CAP
const MULTI_SEED_GRAPH_FAN_OUT_CAP = DYNAMIC_RECALL_PLANE_CAP;

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
    const policy = resolvePolicy({
      strategy: params.strategy,
      taskSurfaceRef: params.taskSurface.runtime_id,
      policyOverride: params.policyOverride,
      buildDefaultPolicy: (strategy, taskSurfaceRef) => this.buildDefaultPolicy(strategy, taskSurfaceRef)
    });
    const tokenEstimator = makeTokenEstimator({ hint: params.hostContext?.tokenizer_hint });
    const queryText = normalizeQueryText(params.taskSurface.display_name);
    const queryProbes = compileRecallQueryProbes(queryText);
    const [slots, activeConstraints] = await Promise.all([
      this.dependencies.slotRepo.findByWorkspace(params.workspaceId),
      loadActiveConstraints({
        activeConstraintsPort: this.dependencies.activeConstraintsPort,
        workspaceId: params.workspaceId,
        cap: params.activeConstraintsCap ?? null
      })
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
    const coarseFilter = await expandTierCascade({
      coarseFilter: this.coarseFilter.bind(this),
      projectMappingPort: this.dependencies.projectMappingPort,
      mergeCoarseFilters,
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

    const initialAssessment = await assessCoarseFilter({
      dependencies: this.dependencies,
      warn: this.warn,
      now: this.now,
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
        : fineAssess({
            candidates: combinedCoarseCandidates,
            policy,
            winnerMemoryIds,
            supplementaryData,
            tokenEstimator,
            now: this.now,
            warn: this.warn
          });
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
    const candidates = await applyManifestationBiasSidecar({
      manifestationSidecarPort: this.dependencies.manifestationSidecarPort,
      warn: this.warn,
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
    await appendWeightTransferTelemetry({
      eventLogRepo: this.dependencies.eventLogRepo,
      warn: this.warn,
      now: this.now,
      recallsEdgeColdThreshold: RECALLS_EDGE_COLD_THRESHOLD,
      workspaceId: params.workspaceId,
      runId: params.runId ?? null,
      graphAndPathColdScore: supplementaryData.graphAndPathColdScore,
      recallsEdgeCount: supplementaryData.recallsEdgeCount,
      weightTransferAmount: supplementaryData.weightTransferAmount
    });
    await recordGlobalRecallClassificationsSafely({
      globalRecallCachePort: this.dependencies.globalRecallCachePort,
      warn: this.warn,
      classifications: globalRecallClassifications
    });

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

  public buildDefaultPolicy(strategy: NodeStrategy, taskSurfaceRef: string): Readonly<RecallPolicy> {
    return buildDefaultPolicy({
      strategy,
      taskSurfaceRef,
      now: this.now,
      generateRuntimeId: this.generateRuntimeId,
      defaultPolicyDecorator: this.dependencies.defaultPolicyDecorator
    });
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
    // see also: packages/core/src/recall/supplementary-data.ts:collectEvidenceGistsByMemoryId.
    readonly evidenceFtsRanksPerRef: Readonly<Record<string, number>>;
    readonly sourceProximityScores: Readonly<Record<string, number>>;
    readonly sourceCohortKeys: Readonly<Record<string, string>>;
    readonly structuralScores: Readonly<Record<string, number>>;
    readonly graphExpansionScores: Readonly<Record<string, number>>;
    readonly graphExpansionDiagnostics: Readonly<RecallGraphExpansionDiagnostics>;
    readonly graphExpansionCandidateSources: ReadonlyMap<string, Readonly<GraphExpansionCandidateSourceDiagnostic>>;
    // see also: packages/core/src/recall/structural-expansion.ts:collectEntityDerivedSeeds.
    readonly entitySeedScores: Readonly<Record<string, number>>;
    readonly pathExpansionScores: Readonly<Record<string, number>>;
    // Negative-path active suppression deltas keyed by target memory id.
    // see also: packages/core/src/recall/path-expansion.ts:collectNegativePathSuppressions,
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
    // see also: packages/core/src/recall/supplementary-data.ts:collectEvidenceGistsByMemoryId.
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
    // see also: packages/core/src/recall/path-expansion.ts:collectNegativePathSuppressions,
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
      // Bind to the repo so the delegate keeps its receiver; the local consts let
      // TS narrow away the optional methods without a non-null assertion. The
      // outer guard guarantees at least one is defined, so the [] tail is unreachable.
      const memoryRepo = this.dependencies.memoryRepo;
      const searchWithinObjectIds = memoryRepo.searchByKeywordWithinObjectIds?.bind(memoryRepo);
      const searchByKeywordFn = memoryRepo.searchByKeyword?.bind(memoryRepo);
      const supplement =
        searchWithinObjectIds !== undefined
          ? await searchWithinObjectIds(
              workspaceId,
              queryText,
              config.semantic_supplement.max_supplement,
              [...byId.keys()]
            )
          : searchByKeywordFn !== undefined
            ? await searchByKeywordFn(
                workspaceId,
                queryText,
                config.semantic_supplement.max_supplement
              )
            : [];
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
          searchWithinObjectIds !== undefined
            ? await searchWithinObjectIds(
                workspaceId,
                expandedQuery,
                config.semantic_supplement.max_supplement,
                [...byId.keys()]
              )
            : searchByKeywordFn !== undefined
              ? await searchByKeywordFn(
                  workspaceId,
                  expandedQuery,
                  config.semantic_supplement.max_supplement
                )
              : [];
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

    addContentDerivedExpansionCandidates({
      tierMemories,
      drafts,
      queryProbes,
      addCandidate,
      dynamicRecallPlaneCap: DYNAMIC_RECALL_PLANE_CAP,
      dynamicRecallCohortRadius: DYNAMIC_RECALL_COHORT_RADIUS
    });
    sourceCohortKeys = await addSourceProximityCandidates({
      workspaceId,
      tierMemories,
      drafts,
      addCandidate,
      admissionLimit: resolveSourceProximityAdmissionLimit(options.deliveryMaxEntries),
      evidenceSearchPort: this.dependencies.evidenceSearchPort,
      robustSourceRefParsing: this.dependencies.robustSourceRefParsing ?? false,
      warn: this.warn
    });
    const entityDerivedSeeds = await collectEntityDerivedSeeds({
      workspaceId,
      queryText,
      byId,
      addCandidate,
      lexicalFtsRanks: ftsRanks,
      entityExtractionPort: this.dependencies.entityExtractionPort,
      memoryRepo: this.dependencies.memoryRepo,
      warn: this.warn,
      entityExtractionMaxEntities: ENTITY_EXTRACTION_MAX_ENTITIES,
      entitySeedPerEntityTopKStrong: ENTITY_SEED_PER_ENTITY_TOP_K_STRONG,
      entitySeedPerEntityTopKWeak: ENTITY_SEED_PER_ENTITY_TOP_K_WEAK,
      entitySeedTotalAdmitCap: ENTITY_SEED_TOTAL_ADMIT_CAP,
      entitySeedMinSurfaceLength: ENTITY_SEED_MIN_SURFACE_LENGTH
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
    // visited). see also: packages/core/src/recall/structural-expansion.ts:addGraphExpansionCandidates.
    // Snapshot the Pool A draft seeds before path_expansion runs. Once
    // path_expansion admits a direct hop-1 neighbor, that neighbor becomes a
    // draft carrying the path_expansion plane and would otherwise qualify as a
    // graph BFS seed — collapsing genuine hop-2 reach into hop-1 and rooting
    // traversal at path-reached nodes rather than query anchors. Pinning the
    // seed set to the pre-path drafts keeps hop semantics stable across the
    // ordering change. see also: packages/core/src/recall/structural-expansion.ts:addGraphExpansionCandidates.
    const prePathGraphSeedIds = selectExpansionSeedDrafts(drafts).map((draft) => draft.entry.object_id);
    await addPathExpansionCandidates({
      workspaceId,
      byId,
      drafts,
      queryProbes,
      addCandidate,
      dynamicRecallPlaneCap: DYNAMIC_RECALL_PLANE_CAP,
      pathExpansionPort: this.dependencies.pathExpansionPort,
      warn: this.warn
    });
    const graphExpansionResult = await addGraphExpansionCandidates({
      workspaceId,
      byId,
      drafts,
      addCandidate,
      pathExpansionPort: this.dependencies.pathExpansionPort,
      extraSeedMemoryIds: graphExpansionSeedIds,
      draftSeedIds: prePathGraphSeedIds,
      maxGraphHops: MAX_GRAPH_HOPS,
      dynamicRecallEdgeFanout: DYNAMIC_RECALL_EDGE_FANOUT,
      multiSeedGraphFanOutCap: MULTI_SEED_GRAPH_FAN_OUT_CAP,
      warn: this.warn
    });
    graphExpansionDiagnostics = graphExpansionResult.diagnostics;
    graphExpansionCandidateSources = graphExpansionResult.candidateSources;
    // Active sign-aware suppression runs off the same expansion seeds. Negative
    // paths are excluded from the positive expansion lanes above (the
    // isPathRecallEligible / direction filters never add their targets); here
    // they are collected separately so a reinforced negative actually demotes
    // its target's fused score instead of merely failing to amplify it.
    await collectNegativePathSuppressions({
      workspaceId,
      byId,
      drafts,
      suppressionScores: pathSuppressionScores,
      pathExpansionPort: this.dependencies.pathExpansionPort,
      warn: this.warn
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
}
