import { randomUUID } from "node:crypto";
import {
  ControlPlaneObjectKind,
  DYNAMICS_CONSTANTS,
  RecallContextEventType,
  RecallCandidateSchema,
  RetentionPolicy,
  SoulRecallCompletedPayloadSchema,
  StorageTier,
  type FineAssessmentConfig,
  type ActivationWeights,
  type MemoryDimension as MemoryDimensionType,
  type MemoryEntry,
  type ProjectMappingAnchor,
  type RecallCandidate,
  type RecallScoreFactors,
  type RecallPolicy,
  type SoulRecallHostContext,
  type TaskObjectSurface
} from "@do-soul/alaya-protocol";
import type { PreparedEmbeddingQueryHandle } from "./embedding-recall-service.js";
import { loadGlobalRecallCandidates } from "./global-memory-recall-service.js";
import { STRATEGY_RECALL_DEFAULTS, type NodeStrategy } from "./task-surface-builder.js";
import {
  EMBEDDING_SIMILARITY_WEIGHT,
  COLD_CASCADE_DECAY,
  MIN_RECALL_RESULTS,
  PATH_PLASTICITY_WEIGHT,
  WARM_CASCADE_DECAY,
  applySimilarityBoost,
  assertActivationWeightsSumToOne,
  assignManifestation,
  buildRecallCandidateDedupeKey,
  classifyGlobalCandidate,
  classifyProjectMappingCandidate,
  clamp01,
  compareEffectiveScores,
  compareMemoryEntries,
  compareRecallCandidates,
  createContentPreview,
  entryMatchesTimeFilter,
  estimateTokens,
  filterMemoriesByTimeWindow,
  getGlobalRecallLimit,
  isClaimLikeDimension,
  isProtectedDimension,
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
  RecallServiceClaimResolverPort,
  RecallServiceDependencies,
  RecallServiceEmbeddingRecallPort,
  RecallServiceEventLogRepoPort,
  RecallServiceGraphSupportPort,
  RecallServiceMemoryRepoPort,
  RecallServiceProjectMappingPort,
  RecallServiceSlotRepoPort,
  RecallServiceWarnPort,
  TokenEstimator
} from "./recall-service-types.js";
export { makeTokenEstimator } from "./recall-service-types.js";

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
  }): Promise<RecallResult> {
    const policy = this.resolvePolicy(params.strategy, params.taskSurface.runtime_id, params.policyOverride);
    const tokenEstimator = makeTokenEstimator({ hint: params.hostContext?.tokenizer_hint });
    const queryText = normalizeQueryText(params.taskSurface.display_name);
    const hotCoarseFilter = await this.coarseFilter(params.workspaceId, policy.coarse_filter, queryText, {
      timeFilter: params.timeFilter
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
    const slots = await this.dependencies.slotRepo.findByWorkspace(params.workspaceId);
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

    // Codex re-review I2: prior implementation called assessCoarseFilter
    // on the HOT-only filter (1× collectSupplementaryData) just to feed
    // hotFineAssessmentCount into expandTierCascade, then ran it again
    // on the merged filter (2nd call). M5 already simplified the
    // cascade gate to use coarseFilter.candidates.length; this commit
    // applies the same simplification at the recall() call site so
    // collectSupplementaryData runs exactly once per recall — on the
    // final merged filter — even when cascade fires.
    const coarseFilter = await this.expandTierCascade({
      workspaceId: params.workspaceId,
      runId: params.runId ?? null,
      config: policy.coarse_filter,
      fineAssessmentConfig: policy.fine_assessment,
      queryText,
      hotCoarseFilter,
      hotFineAssessmentCount: hotCoarseFilter.candidates.length,
      winnerMemoryIds,
      timeFilter: params.timeFilter
    });
    const combinedCoarseCandidates = Object.freeze([
      ...coarseFilter.candidates,
      ...filteredGlobalCandidates
    ]) as readonly Readonly<CoarseRecallCandidate>[];

    const assessment = await this.assessCoarseFilter({
      coarseFilter: Object.freeze({
        ...coarseFilter,
        candidates: combinedCoarseCandidates
      }),
      workspaceId: params.workspaceId,
      runId: params.runId ?? null,
      queryText,
      policy,
      winnerMemoryIds,
      tokenEstimator
    });
    const supplementaryData = assessment.supplementaryData;
    const lexicalCandidates = assessment.candidates;
    const preparedEmbeddingQuery = await this.prepareEmbeddingSupplementQuery({
      config: policy,
      workspaceId: params.workspaceId,
      runId: params.runId ?? null,
      queryText,
      localEligibleCandidates: hotCoarseFilter.candidates,
      lexicalFallbackCount: lexicalCandidates.length
    });
    const mergedCandidates = await this.mergeEmbeddingSupplementCandidates({
      baseCandidates: lexicalCandidates,
      localEligibleCandidates: hotCoarseFilter.candidates,
      config: policy,
      workspaceId: params.workspaceId,
      runId: params.runId ?? null,
      queryText,
      winnerMemoryIds,
      supplementaryData,
      preparedEmbeddingQuery,
      tokenEstimator
    });
    const candidates = this.rebuildBudgetStateForDelivery(
      mergedCandidates,
      policy.fine_assessment
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
    await this.recordGlobalRecallClassificationsSafely(globalRecallClassifications);

    return Object.freeze({
      candidates,
      total_scanned: coarseFilter.total_scanned + globalCoarseFilter.total_scanned,
      coarse_filter_count: combinedCoarseCandidates.length,
      fine_assessment_count: candidates.length,
      degradation_reason: coarseFilter.degradation_reason,
      working_projection: null
    });
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
    }> = {}
  ): Promise<{
    readonly total_scanned: number;
    readonly candidates: readonly Readonly<CoarseRecallCandidate>[];
    readonly ftsRanks: Readonly<Record<string, number>>;
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
    const protectedCandidates = tierMemories.filter((entry) => isProtectedDimension(entry.dimension));
    const protectedIds = new Set(protectedCandidates.map((entry) => entry.object_id));
    const deterministicMatches = tierMemories.filter(
      (entry) => !protectedIds.has(entry.object_id) && matchesDeterministicFilter(entry, config)
    );

    const rankedMatches = deterministicMatches
      .filter((entry) => matchesPrecomputedRankFilter(entry, config))
      .sort(compareMemoryEntries)
      .slice(0, config.precomputed_rank.max_candidates);

    const protectedRanked = protectedCandidates.sort(compareMemoryEntries);
    const baseCandidates = Object.freeze([...protectedRanked, ...rankedMatches]);
    const ftsRanks = new Map<string, number>();
    let supplementedEntries: readonly Readonly<MemoryEntry>[] = baseCandidates;

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
      const seen = new Set(baseCandidates.map((candidate) => candidate.object_id));
      const supplementalEntries = supplement.reduce<Readonly<MemoryEntry>[]>((entries, match) => {
        ftsRanks.set(match.object_id, clamp01(match.normalized_rank));

        if (seen.has(match.object_id)) {
          return entries;
        }

        const entry = byId.get(match.object_id);

        if (entry === undefined) {
          return entries;
        }

        seen.add(entry.object_id);
        return [...entries, entry];
      }, []);

      supplementedEntries = Object.freeze([...baseCandidates, ...supplementalEntries]);
    }

    const anchorMap = new Map(projectMappings.map((mapping) => [mapping.global_object_id, mapping]));
    const supplementedCandidates = Object.freeze(
      supplementedEntries.flatMap((entry) => {
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
      degradation_reason: null
    });
  }

  private async expandTierCascade(params: {
    readonly workspaceId: string;
    readonly runId: string | null;
    readonly config: Readonly<RecallPolicy>["coarse_filter"];
    readonly fineAssessmentConfig: Readonly<FineAssessmentConfig>;
    readonly queryText: string | null;
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
      timeFilter: params.timeFilter
    });
    const warmMerged = this.mergeCoarseFilters(params.hotCoarseFilter, warmFilter, "warm_cascade_engaged");
    // Wave-end M5 (Reviewer I4): the cascade gate previously called
    // assessCoarseFilter (which runs collectSupplementaryData) just to
    // count candidates — meaning HOT-empty cold-start paths fanned the
    // N+1 graph/plasticity/embedding lookups twice (warm gate + final
    // assess) and three times when COLD also fired. Use the much
    // cheaper coarse-filter candidate count for the cascade trigger;
    // collectSupplementaryData now runs exactly once, on the final
    // merged filter, in assessCoarseFilter at the recall() call site.
    if (warmMerged.candidates.length >= targetCount) {
      return warmMerged;
    }

    const coldFilter = await this.coarseFilter(params.workspaceId, params.config, params.queryText, {
      tier: StorageTier.COLD,
      projectMappings,
      sourceChannel: "cold_cascade",
      scoreMultiplier: COLD_CASCADE_DECAY,
      timeFilter: params.timeFilter
    });
    return this.mergeCoarseFilters(warmMerged, coldFilter, "cold_cascade_engaged");
  }

  private async assessCoarseFilter(params: {
    readonly coarseFilter: Awaited<ReturnType<RecallService["coarseFilter"]>>;
    readonly workspaceId: string;
    readonly runId: string | null;
    readonly queryText: string | null;
    readonly policy: Readonly<RecallPolicy>;
    readonly winnerMemoryIds: ReadonlySet<string>;
    readonly tokenEstimator: TokenEstimator;
  }): Promise<Readonly<{
    readonly supplementaryData: RecallSupplementaryData;
    readonly candidates: readonly Readonly<RecallCandidate>[];
  }>> {
    const supplementaryData = await this.collectSupplementaryData({
      candidates: params.coarseFilter.candidates.map((candidate) => candidate.entry),
      workspaceId: params.workspaceId,
      runId: params.runId,
      queryText: params.queryText,
      coarseFtsRanks: params.coarseFilter.ftsRanks
    });
    const candidates = this.fineAssess(
      params.coarseFilter.candidates,
      params.policy,
      params.winnerMemoryIds,
      supplementaryData,
      params.tokenEstimator
    );

    return Object.freeze({
      supplementaryData,
      candidates
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
      degradation_reason: degradationReason
    });
  }

  private async collectSupplementaryData(params: {
    readonly candidates: readonly Readonly<MemoryEntry>[];
    readonly workspaceId: string;
    readonly runId: string | null;
    readonly queryText: string | null;
    readonly coarseFtsRanks: Readonly<Record<string, number>>;
  }): Promise<RecallSupplementaryData> {
    const graphSupportCounts = Object.fromEntries(
      await Promise.all(
        params.candidates.map(async (candidate) => [
          candidate.object_id,
          this.dependencies.graphSupportPort === undefined
            ? 0
            : await this.dependencies.graphSupportPort.countInboundSupports(candidate.object_id, params.workspaceId)
        ])
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

    return Object.freeze({
      ftsRanks: params.coarseFtsRanks,
      graphSupportCounts: Object.freeze(graphSupportCounts),
      budgetPenaltyFactor,
      plasticityFactors
    });
  }

  private async mergeEmbeddingSupplementCandidates(params: {
    readonly baseCandidates: readonly Readonly<RecallCandidate>[];
    readonly localEligibleCandidates: readonly Readonly<CoarseRecallCandidate>[];
    readonly config: Readonly<RecallPolicy>;
    readonly workspaceId: string;
    readonly runId: string | null;
    readonly queryText: string | null;
    readonly winnerMemoryIds: ReadonlySet<string>;
    readonly supplementaryData: RecallSupplementaryData;
    readonly preparedEmbeddingQuery: PreparedEmbeddingQueryHandle | null;
    readonly tokenEstimator: TokenEstimator;
  }): Promise<readonly Readonly<RecallCandidate>[]> {
    const embeddingRecallService = this.dependencies.embeddingRecallService;
    if (
      embeddingRecallService === undefined ||
      params.queryText === null ||
      params.config.coarse_filter.semantic_supplement.embedding_enabled !== true ||
      params.config.coarse_filter.semantic_supplement.max_supplement <= 0 ||
      params.localEligibleCandidates.length === 0
    ) {
      return params.baseCandidates;
    }

    if (
      params.preparedEmbeddingQuery === null ||
      typeof embeddingRecallService.querySupplementIfReady !== "function"
    ) {
      return params.baseCandidates;
    }

    const supplement = await embeddingRecallService.querySupplementIfReady({
      workspaceId: params.workspaceId,
      runId: params.runId,
      eligibleMemories: params.localEligibleCandidates.map((candidate) => candidate.entry),
      baseCandidateIds: params.baseCandidates.map((candidate) => candidate.object_id),
      maxSupplement: params.config.coarse_filter.semantic_supplement.max_supplement,
      preparedQuery: params.preparedEmbeddingQuery
    });

    if (
      supplement.supplementaryEntries.length === 0 &&
      Object.keys(supplement.similarityHintsByObjectId).length === 0
    ) {
      return params.baseCandidates;
    }

    const localCandidateById = new Map(
      params.localEligibleCandidates.map((candidate) => [candidate.entry.object_id, candidate] as const)
    );
    const boostedBaseCandidates = params.baseCandidates.map((candidate) =>
      applySimilarityBoost(candidate, supplement.similarityHintsByObjectId[candidate.object_id])
    );
    const seenIds = new Set(boostedBaseCandidates.map((candidate) => candidate.object_id));
    const additiveCandidates = supplement.supplementaryEntries.flatMap((entry) => {
      if (seenIds.has(entry.object_id)) {
        return [];
      }

      const coarseCandidate = localCandidateById.get(entry.object_id);
      const similarityHint = supplement.similarityHintsByObjectId[entry.object_id];
      if (coarseCandidate === undefined || similarityHint === undefined) {
        return [];
      }

      seenIds.add(entry.object_id);
      return [
        this.buildSupplementaryRecallCandidate(
          coarseCandidate,
          params.config,
          params.winnerMemoryIds,
          params.supplementaryData,
          similarityHint.normalized_similarity,
          params.tokenEstimator
        )
      ];
    });

    return this.appendAdditiveCandidatesWithinRemainingBudgets(
      [...boostedBaseCandidates].sort(compareRecallCandidates),
      additiveCandidates.sort(compareRecallCandidates),
      params.config.fine_assessment
    );
  }

  private async prepareEmbeddingSupplementQuery(params: {
    readonly config: Readonly<RecallPolicy>;
    readonly workspaceId: string;
    readonly runId: string | null;
    readonly queryText: string | null;
    readonly localEligibleCandidates: readonly Readonly<CoarseRecallCandidate>[];
    readonly lexicalFallbackCount: number;
  }): Promise<PreparedEmbeddingQueryHandle | null> {
    const embeddingRecallService = this.dependencies.embeddingRecallService;
    if (
      embeddingRecallService === undefined ||
      typeof embeddingRecallService.prepareQueryEmbedding !== "function" ||
      params.queryText === null ||
      params.config.coarse_filter.semantic_supplement.embedding_enabled !== true ||
      params.config.coarse_filter.semantic_supplement.max_supplement <= 0 ||
      params.localEligibleCandidates.length === 0
    ) {
      return null;
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
        return null;
      }

      if (!hasStoredVectors) {
        return null;
      }
    }

    return embeddingRecallService.prepareQueryEmbedding({
      workspaceId: params.workspaceId,
      runId: params.runId,
      queryText: params.queryText
    });
  }

  private appendAdditiveCandidatesWithinRemainingBudgets(
    baseCandidates: readonly Readonly<RecallCandidate>[],
    additiveCandidates: readonly Readonly<RecallCandidate>[],
    config: Readonly<FineAssessmentConfig>
  ): readonly Readonly<RecallCandidate>[] {
    if (additiveCandidates.length === 0) {
      return baseCandidates;
    }

    const selected = [...baseCandidates];
    const perDimensionCounts = new Map<MemoryDimensionType, number>();
    let totalTokens = 0;

    for (const candidate of baseCandidates) {
      const dimensionCount = perDimensionCounts.get(candidate.dimension) ?? 0;
      perDimensionCounts.set(candidate.dimension, dimensionCount + 1);
      totalTokens += candidate.token_estimate;
    }

    for (const candidate of additiveCandidates) {
      const dimensionCount = perDimensionCounts.get(candidate.dimension) ?? 0;
      const dimensionLimit = config.budgets.per_dimension_limits?.[candidate.dimension] ?? null;
      const nextEntryCount = selected.length + 1;
      const nextTokenCount = totalTokens + candidate.token_estimate;

      if (dimensionLimit !== null && dimensionCount >= dimensionLimit) {
        continue;
      }

      if (
        nextEntryCount > config.budgets.max_entries ||
        nextTokenCount > config.budgets.max_total_tokens
      ) {
        continue;
      }

      selected.push(candidate);
      perDimensionCounts.set(candidate.dimension, dimensionCount + 1);
      totalTokens = nextTokenCount;
    }

    return Object.freeze([...selected].sort(compareRecallCandidates));
  }

  private rebuildBudgetStateForDelivery(
    candidates: readonly Readonly<RecallCandidate>[],
    config: Readonly<FineAssessmentConfig>
  ): readonly Readonly<RecallCandidate>[] {
    let usedTokensBeforeCandidate = 0;

    return Object.freeze(
      candidates.map((candidate, index) => {
        const tokenEstimate = candidate.token_estimate;
        const rebuilt = RecallCandidateSchema.parse({
          ...candidate,
          budget_state: buildBudgetState({
            tokenEstimate,
            maxEntries: config.budgets.max_entries,
            maxTotalTokens: config.budgets.max_total_tokens,
            index,
            usedTokensBeforeCandidate
          })
        });

        usedTokensBeforeCandidate += tokenEstimate;
        return rebuilt;
      })
    );
  }

  private fineAssess(
    candidates: readonly Readonly<CoarseRecallCandidate>[],
    policy: Readonly<RecallPolicy>,
    winnerMemoryIds: ReadonlySet<string>,
    supplementaryData: RecallSupplementaryData,
    tokenEstimator: TokenEstimator
  ): readonly Readonly<RecallCandidate>[] {
    if (candidates.length === 0) {
      return Object.freeze([]);
    }
    const config = policy.fine_assessment;

    const mandatory = candidates.filter(
      ({ entry }) => isProtectedDimension(entry.dimension) || winnerMemoryIds.has(entry.object_id)
    );
    const optional = candidates
      .filter(
        ({ entry }) => !isProtectedDimension(entry.dimension) && !winnerMemoryIds.has(entry.object_id)
      )
      .map((candidate) => Object.freeze({
        ...candidate,
        effectiveScore: this.computeEffectiveScore(
          candidate.entry,
          policy,
          winnerMemoryIds,
          supplementaryData,
          candidate.isAdvisory ?? false,
          candidate.scoreMultiplier ?? 1
        )
      }))
      .sort((left, right) => compareEffectiveScores(right, left));

    type FineAssessmentAccumulator = {
      readonly selected: readonly Readonly<RecallCandidate>[];
      readonly seen: ReadonlySet<string>;
      readonly perDimensionCounts: ReadonlyMap<MemoryDimensionType, number>;
      readonly totalTokens: number;
    };

    const initialAccumulator: FineAssessmentAccumulator = {
      selected: Object.freeze([]),
      seen: new Set<string>(),
      perDimensionCounts: new Map<MemoryDimensionType, number>(),
      totalTokens: 0
    };

    const appendCandidate = (
      accumulator: FineAssessmentAccumulator,
      candidate: Readonly<CoarseRecallCandidate>,
      mandatoryEntry: boolean
    ): FineAssessmentAccumulator => {
      const entry = candidate.entry;
      const candidateKey = buildRecallCandidateDedupeKey(candidate);

      if (accumulator.seen.has(candidateKey)) {
        return accumulator;
      }

      const tokenEstimate = estimateTokens(entry.content, tokenEstimator);
      const dimensionCount = accumulator.perDimensionCounts.get(entry.dimension) ?? 0;
      const dimensionLimit = config.budgets.per_dimension_limits?.[entry.dimension] ?? null;
      const nextEntryCount = accumulator.selected.length + 1;
      const nextTokenCount = accumulator.totalTokens + tokenEstimate;

      if (!mandatoryEntry) {
        if (dimensionLimit !== null && dimensionCount >= dimensionLimit) {
          return accumulator;
        }

        if (nextEntryCount > config.budgets.max_entries || nextTokenCount > config.budgets.max_total_tokens) {
          return accumulator;
        }
      }

      const activationScore = normalizeActivationScore(entry.activation_score);
      const manifestation = assignManifestation(activationScore);
      const scored = this.computeEffectiveScoreDetails(
        entry,
        policy,
        winnerMemoryIds,
        supplementaryData,
        candidate.isAdvisory ?? false,
        candidate.scoreMultiplier ?? 1
      );
      const relevanceScore = scored.score;
      const nextCandidate = RecallCandidateSchema.parse({
        object_id: entry.object_id,
        object_kind: "memory_entry" as const,
        activation_score: activationScore,
        relevance_score: relevanceScore,
        content_preview: createContentPreview(entry.content, manifestation, candidate.originPlane),
        token_estimate: tokenEstimate,
        manifestation,
        dimension: entry.dimension,
        scope_class: entry.scope_class,
        selection_reason: buildSelectionReason(scored.factors, candidate.originPlane),
        source_channels: buildSourceChannels(candidate, scored.factors),
        score_factors: scored.factors,
        budget_state: buildBudgetState({
          tokenEstimate,
          maxEntries: config.budgets.max_entries,
          maxTotalTokens: config.budgets.max_total_tokens,
          index: accumulator.selected.length,
          usedTokensBeforeCandidate: accumulator.totalTokens
        }),
        ...(candidate.originPlane === undefined ? {} : { origin_plane: candidate.originPlane }),
        ...(candidate.isAdvisory === undefined ? {} : { is_advisory: candidate.isAdvisory })
      });

      return {
        selected: Object.freeze([...accumulator.selected, nextCandidate]),
        seen: new Set([...accumulator.seen, candidateKey]),
        perDimensionCounts: new Map([
          ...accumulator.perDimensionCounts,
          [entry.dimension, dimensionCount + 1]
        ]),
        totalTokens: nextTokenCount
      };
    };

    const withMandatory = mandatory.reduce(
      (accumulator, candidate) => appendCandidate(accumulator, candidate, true),
      initialAccumulator
    );
    const finalAccumulator = optional.reduce(
      (accumulator, candidate) => appendCandidate(accumulator, candidate, false),
      withMandatory
    );

    return Object.freeze([...finalAccumulator.selected]);
  }

  private computeEffectiveScore(
    entry: Readonly<MemoryEntry>,
    policy: Readonly<RecallPolicy>,
    winnerMemoryIds: ReadonlySet<string>,
    supplementaryData: RecallSupplementaryData,
    isAdvisory: boolean,
    scoreMultiplier = 1
  ): number {
    return this.computeEffectiveScoreDetails(
      entry,
      policy,
      winnerMemoryIds,
      supplementaryData,
      isAdvisory,
      scoreMultiplier
    ).score;
  }

  private computeEffectiveScoreDetails(
    entry: Readonly<MemoryEntry>,
    policy: Readonly<RecallPolicy>,
    winnerMemoryIds: ReadonlySet<string>,
    supplementaryData: RecallSupplementaryData,
    isAdvisory: boolean,
    scoreMultiplier = 1
  ): Readonly<{ readonly score: number; readonly factors: RecallScoreFactors }> {
    const config = policy.fine_assessment;
    const weights = this.resolveEffectiveActivationWeights(entry, policy);
    const activationScore = normalizeActivationScore(entry.activation_score);
    const relevanceFactor = supplementaryData.ftsRanks[entry.object_id] ?? 0;
    const graphSupportFactor = normalizeGraphSupport(supplementaryData.graphSupportCounts[entry.object_id] ?? 0);
    const budgetPenalty = supplementaryData.budgetPenaltyFactor;
    // PathPlasticity is supplementary, like the embedding similarity hint:
    // it boosts the score additively but the final value is still clamp01,
    // so a small plasticity boost cannot override a large lexical-rank gap.
    const plasticityFactor = clamp01(supplementaryData.plasticityFactors[entry.object_id] ?? 0);
    const conflictPenalty =
      config.conflict_awareness &&
      isClaimLikeDimension(entry.dimension) &&
      !winnerMemoryIds.has(entry.object_id)
        ? 1
        : 0;

    const baseWeight =
      (isAdvisory ? 0 : weights.scope_match) +
      weights.domain_match +
      weights.retention +
      weights.freshness;

    const rawScore = clamp01(
      activationScore * baseWeight +
        relevanceFactor * weights.relevance +
        graphSupportFactor * weights.graph_support +
        plasticityFactor * PATH_PLASTICITY_WEIGHT -
        budgetPenalty * weights.budget_penalty -
        conflictPenalty * weights.conflict_penalty
    );
    const score = clamp01(rawScore * scoreMultiplier);

    return Object.freeze({
      score,
      factors: Object.freeze({
        activation: activationScore,
        relevance: score,
        graph_support: graphSupportFactor,
        path_plasticity: plasticityFactor,
        budget_penalty: budgetPenalty,
        conflict_penalty: conflictPenalty,
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

  private buildSupplementaryRecallCandidate(
    candidate: Readonly<CoarseRecallCandidate>,
    policy: Readonly<RecallPolicy>,
    winnerMemoryIds: ReadonlySet<string>,
    supplementaryData: RecallSupplementaryData,
    normalizedSimilarity: number,
    tokenEstimator: TokenEstimator
  ): Readonly<RecallCandidate> {
    const activationScore = normalizeActivationScore(candidate.entry.activation_score);
    const manifestation = assignManifestation(activationScore);
    const scored = this.computeEffectiveScoreDetails(
      candidate.entry,
      policy,
      winnerMemoryIds,
      supplementaryData,
      candidate.isAdvisory ?? false,
      candidate.scoreMultiplier ?? 1
    );
    const normalizedEmbeddingSimilarity = clamp01(normalizedSimilarity);
    const relevanceScore = clamp01(
      scored.score + normalizedEmbeddingSimilarity * EMBEDDING_SIMILARITY_WEIGHT
    );
    const scoreFactors = Object.freeze({
      ...scored.factors,
      relevance: relevanceScore,
      embedding_similarity: normalizedEmbeddingSimilarity
    });
    const tokenEstimate = estimateTokens(candidate.entry.content, tokenEstimator);

    return RecallCandidateSchema.parse({
      object_id: candidate.entry.object_id,
      object_kind: "memory_entry",
      activation_score: activationScore,
      relevance_score: relevanceScore,
      content_preview: createContentPreview(
        candidate.entry.content,
        manifestation,
        candidate.originPlane
      ),
      token_estimate: tokenEstimate,
      manifestation,
      dimension: candidate.entry.dimension,
      scope_class: candidate.entry.scope_class,
      selection_reason: buildSelectionReason(scoreFactors, candidate.originPlane),
      source_channels: buildSourceChannels(candidate, scoreFactors, "semantic_supplement"),
      score_factors: scoreFactors,
      budget_state: buildBudgetState({
        tokenEstimate,
        maxEntries: policy.fine_assessment.budgets.max_entries,
        maxTotalTokens: policy.fine_assessment.budgets.max_total_tokens,
        index: 0,
        usedTokensBeforeCandidate: 0
      }),
      ...(candidate.originPlane === undefined ? {} : { origin_plane: candidate.originPlane }),
      ...(candidate.isAdvisory === undefined ? {} : { is_advisory: candidate.isAdvisory })
    });
  }
}

function buildSelectionReason(
  factors: Readonly<RecallScoreFactors>,
  originPlane: CoarseRecallCandidate["originPlane"]
): string {
  const origin = originPlane === "global" ? "global recall" : "workspace recall";
  const supports: string[] = [`activation ${factors.activation.toFixed(3)}`];
  if ((factors.graph_support ?? 0) > 0) {
    supports.push(`graph support ${factors.graph_support?.toFixed(3)}`);
  }
  if ((factors.path_plasticity ?? 0) > 0) {
    supports.push(`path plasticity ${factors.path_plasticity?.toFixed(3)}`);
  }
  if ((factors.embedding_similarity ?? 0) > 0) {
    supports.push(`embedding similarity ${factors.embedding_similarity?.toFixed(3)}`);
  }
  if ((factors.budget_penalty ?? 0) > 0) {
    supports.push(`budget penalty ${factors.budget_penalty?.toFixed(3)}`);
  }

  return `Selected by ${origin}; score ${factors.relevance.toFixed(3)} from ${supports.join(", ")}.`;
}

function buildSourceChannels(
  candidate: Readonly<CoarseRecallCandidate>,
  factors: Readonly<RecallScoreFactors>,
  extraChannel?: string
): readonly string[] {
  const channels = new Set<string>(["ranked_recall", candidate.originPlane ?? "workspace_local"]);
  if ((factors.graph_support ?? 0) > 0) {
    channels.add("graph_support");
  }
  if ((factors.path_plasticity ?? 0) > 0) {
    channels.add("path_plasticity");
  }
  if ((factors.embedding_similarity ?? 0) > 0 || extraChannel !== undefined) {
    channels.add(extraChannel ?? "semantic_supplement");
  }
  if (candidate.sourceChannel !== undefined) {
    channels.add(candidate.sourceChannel);
  }
  if (candidate.isAdvisory === true) {
    channels.add("advisory");
  }

  return Object.freeze([...channels]);
}

function buildBudgetState(params: Readonly<{
  readonly tokenEstimate: number;
  readonly maxEntries: number;
  readonly maxTotalTokens: number;
  readonly index: number;
  readonly usedTokensBeforeCandidate: number;
}>) {
  const usedTokensThroughCandidate = params.usedTokensBeforeCandidate + params.tokenEstimate;

  return Object.freeze({
    token_estimate: params.tokenEstimate,
    max_entries: params.maxEntries,
    max_total_tokens: params.maxTotalTokens,
    remaining_entries: Math.max(params.maxEntries - params.index - 1, 0),
    remaining_tokens: Math.max(params.maxTotalTokens - usedTokensThroughCandidate, 0),
    within_budget: params.index < params.maxEntries && usedTokensThroughCandidate <= params.maxTotalTokens
  });
}
