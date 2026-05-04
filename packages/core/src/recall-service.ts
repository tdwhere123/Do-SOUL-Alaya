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
  type MemoryDimension as MemoryDimensionType,
  type MemoryEntry,
  type RecallCandidate,
  type RecallPolicy,
  type TaskObjectSurface
} from "@do-soul/alaya-protocol";
import type { PreparedEmbeddingQueryHandle } from "./embedding-recall-service.js";
import { loadGlobalRecallCandidates } from "./global-memory-recall-service.js";
import { STRATEGY_RECALL_DEFAULTS, type NodeStrategy } from "./task-surface-builder.js";
import {
  EMBEDDING_SIMILARITY_WEIGHT,
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
  estimateTokens,
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
  toErrorMessage
} from "./recall-service-helpers.js";
import type {
  CoarseRecallCandidate,
  RecallResult,
  RecallServiceDependencies,
  RecallServiceWarnPort,
  RecallSupplementaryData
} from "./recall-service-types.js";
import { getNextRevision } from "./shared/event-utils.js";
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
  RecallServiceWarnPort
} from "./recall-service-types.js";

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
  }): Promise<RecallResult> {
    const policy = this.resolvePolicy(params.strategy, params.taskSurface.runtime_id, params.policyOverride);
    const queryText = normalizeQueryText(params.taskSurface.display_name);
    const coarseFilter = await this.coarseFilter(params.workspaceId, policy.coarse_filter, queryText);
    const globalCoarseFilter = await loadGlobalRecallCandidates({
      workspaceId: params.workspaceId,
      queryText,
      limit: getGlobalRecallLimit(policy),
      createdBy: "system",
      globalRecallPort: this.dependencies.globalRecallPort,
      projectMappingPort: this.dependencies.projectMappingPort,
      classifyGlobalCandidate
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
    const combinedCoarseCandidates = Object.freeze([
      ...coarseFilter.candidates,
      ...filteredGlobalCandidates
    ]) as readonly Readonly<CoarseRecallCandidate>[];
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

    const supplementaryData = await this.collectSupplementaryData({
      candidates: combinedCoarseCandidates.map((candidate) => candidate.entry),
      workspaceId: params.workspaceId,
      runId: params.runId ?? null,
      queryText,
      coarseFtsRanks: coarseFilter.ftsRanks
    });
    const lexicalCandidates = this.fineAssess(
      combinedCoarseCandidates,
      policy.fine_assessment,
      winnerMemoryIds,
      supplementaryData
    );
    const preparedEmbeddingQuery = await this.prepareEmbeddingSupplementQuery({
      config: policy,
      workspaceId: params.workspaceId,
      runId: params.runId ?? null,
      queryText,
      localEligibleCandidates: coarseFilter.candidates,
      lexicalFallbackCount: lexicalCandidates.length
    });
    const candidates = await this.mergeEmbeddingSupplementCandidates({
      baseCandidates: lexicalCandidates,
      localEligibleCandidates: coarseFilter.candidates,
      config: policy,
      workspaceId: params.workspaceId,
      runId: params.runId ?? null,
      queryText,
      winnerMemoryIds,
      supplementaryData,
      preparedEmbeddingQuery
    });
    const revision = await getNextRevision(
      this.dependencies.eventLogRepo,
      "task_object_surface",
      params.taskSurface.runtime_id
    );
    const occurredAt = this.now();

    await this.dependencies.eventLogRepo.append({
      event_type: RecallContextEventType.SOUL_RECALL_COMPLETED,
      entity_type: "task_object_surface",
      entity_id: params.taskSurface.runtime_id,
      workspace_id: params.workspaceId,
      run_id: params.runId ?? null,
      caused_by: "system",
      revision,
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
    queryText: string | null
  ): Promise<{
    readonly total_scanned: number;
    readonly candidates: readonly Readonly<CoarseRecallCandidate>[];
    readonly ftsRanks: Readonly<Record<string, number>>;
  }> {
    const [hotMemories, projectMappings] = await Promise.all([
      this.dependencies.memoryRepo.findByWorkspaceId(workspaceId, StorageTier.HOT),
      this.dependencies.projectMappingPort?.findByWorkspace(workspaceId) ?? Promise.resolve([])
    ]);
    const protectedCandidates = hotMemories.filter((entry) => isProtectedDimension(entry.dimension));
    const protectedIds = new Set(protectedCandidates.map((entry) => entry.object_id));
    const deterministicMatches = hotMemories.filter(
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
      const byId = new Map(hotMemories.map((memory) => [memory.object_id, memory]));
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
            isAdvisory: classification.isAdvisory
          })
        ];
      })
    ) as readonly Readonly<CoarseRecallCandidate>[];

    return Object.freeze({
      total_scanned: hotMemories.length,
      candidates: supplementedCandidates,
      ftsRanks: Object.freeze(Object.fromEntries(ftsRanks.entries()))
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

    return Object.freeze({
      ftsRanks: params.coarseFtsRanks,
      graphSupportCounts: Object.freeze(graphSupportCounts),
      budgetPenaltyFactor
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
          params.config.fine_assessment,
          params.winnerMemoryIds,
          params.supplementaryData,
          similarityHint.normalized_similarity
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

  private fineAssess(
    candidates: readonly Readonly<CoarseRecallCandidate>[],
    config: Readonly<FineAssessmentConfig>,
    winnerMemoryIds: ReadonlySet<string>,
    supplementaryData: RecallSupplementaryData
  ): readonly Readonly<RecallCandidate>[] {
    if (candidates.length === 0) {
      return Object.freeze([]);
    }

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
          config,
          winnerMemoryIds,
          supplementaryData,
          candidate.isAdvisory ?? false
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

      const tokenEstimate = estimateTokens(entry.content);
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
      const relevanceScore = this.computeEffectiveScore(
        entry,
        config,
        winnerMemoryIds,
        supplementaryData,
        candidate.isAdvisory ?? false
      );
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
    config: Readonly<FineAssessmentConfig>,
    winnerMemoryIds: ReadonlySet<string>,
    supplementaryData: RecallSupplementaryData,
    isAdvisory: boolean
  ): number {
    const weights = DYNAMICS_CONSTANTS.activation_weights_phase4b;
    const activationScore = normalizeActivationScore(entry.activation_score);
    const relevanceFactor = supplementaryData.ftsRanks[entry.object_id] ?? 0;
    const graphSupportFactor = normalizeGraphSupport(supplementaryData.graphSupportCounts[entry.object_id] ?? 0);
    const budgetPenalty = supplementaryData.budgetPenaltyFactor;
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

    return clamp01(
      activationScore * baseWeight +
        relevanceFactor * weights.relevance +
        graphSupportFactor * weights.graph_support -
        budgetPenalty * weights.budget_penalty -
        conflictPenalty * weights.conflict_penalty
    );
  }

  private buildSupplementaryRecallCandidate(
    candidate: Readonly<CoarseRecallCandidate>,
    config: Readonly<FineAssessmentConfig>,
    winnerMemoryIds: ReadonlySet<string>,
    supplementaryData: RecallSupplementaryData,
    normalizedSimilarity: number
  ): Readonly<RecallCandidate> {
    const activationScore = normalizeActivationScore(candidate.entry.activation_score);
    const manifestation = assignManifestation(activationScore);
    const relevanceScore = clamp01(
      this.computeEffectiveScore(
        candidate.entry,
        config,
        winnerMemoryIds,
        supplementaryData,
        candidate.isAdvisory ?? false
      ) + clamp01(normalizedSimilarity) * EMBEDDING_SIMILARITY_WEIGHT
    );

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
      token_estimate: estimateTokens(candidate.entry.content),
      manifestation,
      dimension: candidate.entry.dimension,
      scope_class: candidate.entry.scope_class,
      ...(candidate.originPlane === undefined ? {} : { origin_plane: candidate.originPlane }),
      ...(candidate.isAdvisory === undefined ? {} : { is_advisory: candidate.isAdvisory })
    });
  }
}
