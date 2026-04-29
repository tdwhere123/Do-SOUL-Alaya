import { randomUUID } from "node:crypto";
import {
  BankruptcyKind,
  ControlPlaneObjectKind,
  DYNAMICS_CONSTANTS,
  MemoryDimension,
  Phase3AEventType,
  ProjectMappingState,
  RecallCandidateSchema,
  RetentionPolicy,
  SoulRecallCompletedPayloadSchema,
  StorageTier,
  type BudgetSnapshot,
  type EventLogEntry,
  type FineAssessmentConfig,
  type ManifestationState,
  type MemoryDimension as MemoryDimensionType,
  type MemoryEntry,
  type ProjectMappingAnchor,
  type RecallCandidate,
  type RecallOriginPlane,
  type RecallPolicy,
  ScopeClass,
  type Slot,
  type StorageTier as StorageTierType,
  type TaskObjectSurface
} from "@do-soul/alaya-protocol";
import type {
  GlobalMemoryRecallCachePort,
  GlobalMemoryRecallPort
} from "./global-memory-recall-port.js";
import type {
  EmbeddingRecallSupplementResult,
  PreparedEmbeddingQueryHandle
} from "./embedding-recall-service.js";
import { loadGlobalRecallCandidates } from "./global-memory-recall-service.js";
import { STRATEGY_RECALL_DEFAULTS, type NodeStrategy } from "./task-surface-builder.js";
import { CoreError } from "./errors.js";
import { getNextRevision } from "./shared/event-utils.js";
import { parseRecallPolicy } from "./shared/recall-policy.js";

export interface KeywordSearchResult {
  readonly object_id: string;
  readonly normalized_rank: number;
}

export interface RecallServiceMemoryRepoPort {
  findByWorkspaceId(workspaceId: string, tier?: StorageTierType): Promise<readonly Readonly<MemoryEntry>[]>;
  findByDimension(workspaceId: string, dimension: MemoryDimensionType): Promise<readonly Readonly<MemoryEntry>[]>;
  findByScopeClass(workspaceId: string, scopeClass: ScopeClass): Promise<readonly Readonly<MemoryEntry>[]>;
  searchByKeyword?(workspaceId: string, queryText: string, limit: number): Promise<readonly KeywordSearchResult[]>;
  searchByKeywordWithinObjectIds?(
    workspaceId: string,
    queryText: string,
    limit: number,
    objectIds: readonly string[]
  ): Promise<readonly KeywordSearchResult[]>;
}

export interface RecallServiceSlotRepoPort {
  findByWorkspace(workspaceId: string): Promise<readonly Readonly<Slot>[]>;
}

export interface RecallServiceEventLogRepoPort {
  append(entry: Omit<EventLogEntry, "event_id" | "created_at">): Promise<EventLogEntry>;
  queryByEntity(entityType: string, entityId: string): Promise<readonly EventLogEntry[]>;
}

export interface RecallServiceGraphSupportPort {
  countInboundSupports(memoryId: string, workspaceId: string): Promise<number>;
}

export interface RecallServiceBudgetPenaltyPort {
  getSnapshot(runId: string): Promise<Readonly<BudgetSnapshot>>;
}

export interface RecallServiceProjectMappingPort {
  findByWorkspace(workspaceId: string): Promise<readonly Readonly<ProjectMappingAnchor>[]>;
  ensureSuggestedAnchors?(
    globalObjectIds: readonly string[],
    workspaceId: string,
    createdBy: string
  ): Promise<readonly Readonly<ProjectMappingAnchor>[]>;
}

export interface RecallServiceClaimResolverPort {
  findByIds(objectIds: readonly string[]): Promise<readonly Readonly<{
    readonly object_id: string;
    readonly source_object_refs: readonly string[];
  }>[]>;
}

export interface RecallServiceEmbeddingRecallPort {
  hasStoredVectors?(params: {
    readonly workspaceId: string;
    readonly eligibleMemories: readonly Readonly<MemoryEntry>[];
  }): Promise<boolean>;
  recordPrecheckDegraded?(params: {
    readonly workspaceId: string;
    readonly runId: string | null;
    readonly reason: string;
    readonly baseCandidateCount: number;
    readonly fallbackCandidateCount: number;
  }): Promise<void>;
  prepareQueryEmbedding?(params: {
    readonly workspaceId: string;
    readonly runId: string | null;
    readonly queryText: string;
  }): PreparedEmbeddingQueryHandle;
  querySupplementIfReady?(params: {
    readonly workspaceId: string;
    readonly runId: string | null;
    readonly eligibleMemories: readonly Readonly<MemoryEntry>[];
    readonly baseCandidateIds: readonly string[];
    readonly maxSupplement: number;
    readonly preparedQuery: PreparedEmbeddingQueryHandle;
  }): Promise<EmbeddingRecallSupplementResult>;
  querySupplement(params: {
    readonly workspaceId: string;
    readonly runId: string | null;
    readonly queryText: string;
    readonly eligibleMemories: readonly Readonly<MemoryEntry>[];
    readonly baseCandidateIds: readonly string[];
    readonly maxSupplement: number;
  }): Promise<EmbeddingRecallSupplementResult>;
}

export interface RecallServiceDependencies {
  readonly memoryRepo: RecallServiceMemoryRepoPort;
  readonly slotRepo: RecallServiceSlotRepoPort;
  readonly eventLogRepo: RecallServiceEventLogRepoPort;
  readonly graphSupportPort?: RecallServiceGraphSupportPort;
  readonly budgetPenaltyPort?: RecallServiceBudgetPenaltyPort;
  readonly projectMappingPort?: RecallServiceProjectMappingPort;
  readonly globalRecallPort?: GlobalMemoryRecallPort;
  readonly globalRecallCachePort?: GlobalMemoryRecallCachePort;
  readonly claimResolverPort?: RecallServiceClaimResolverPort;
  readonly embeddingRecallService?: RecallServiceEmbeddingRecallPort;
  readonly generateRuntimeId?: () => string;
  readonly now?: () => string;
  readonly warn?: RecallServiceWarnPort;
}

export type { RecallCandidate } from "@do-soul/alaya-protocol";

export interface RecallResult {
  readonly candidates: readonly Readonly<RecallCandidate>[];
  readonly total_scanned: number;
  readonly coarse_filter_count: number;
  readonly fine_assessment_count: number;
  readonly working_projection: null;
}

interface RecallSupplementaryData {
  readonly ftsRanks: Readonly<Record<string, number>>;
  readonly graphSupportCounts: Readonly<Record<string, number>>;
  readonly budgetPenaltyFactor: number;
}

interface CoarseRecallCandidate {
  readonly entry: Readonly<MemoryEntry>;
  readonly isAdvisory?: boolean;
  readonly originPlane?: RecallOriginPlane;
}

export interface RecallServiceWarnPort {
  (message: string, meta: Record<string, unknown>): void;
}

const CLAIM_LIKE_DIMENSIONS = new Set<MemoryDimensionType>([
  MemoryDimension.CONSTRAINT,
  MemoryDimension.PREFERENCE,
  MemoryDimension.PROCEDURE
]);
const EMBEDDING_SIMILARITY_WEIGHT = 0.8;

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
      event_type: Phase3AEventType.SOUL_RECALL_COMPLETED,
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
      CLAIM_LIKE_DIMENSIONS.has(entry.dimension) &&
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

function buildRecallCandidateDedupeKey(candidate: Readonly<CoarseRecallCandidate>): string {
  return `${candidate.originPlane ?? "workspace_local"}:${candidate.entry.object_id}`;
}

function parseEmbeddingPrecheckReason(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("reason" in error)) {
    return null;
  }

  return typeof error.reason === "string" && error.reason.trim().length > 0
    ? error.reason
    : null;
}

function compareMemoryEntries(left: Readonly<MemoryEntry>, right: Readonly<MemoryEntry>): number {
  const activationDelta = normalizeActivationScore(right.activation_score) - normalizeActivationScore(left.activation_score);

  if (activationDelta !== 0) {
    return activationDelta;
  }

  const createdAtComparison = left.created_at.localeCompare(right.created_at);
  if (createdAtComparison !== 0) {
    return createdAtComparison;
  }

  return left.object_id.localeCompare(right.object_id);
}

function compareEffectiveScores(
  left: Readonly<CoarseRecallCandidate & { effectiveScore: number }>,
  right: Readonly<CoarseRecallCandidate & { effectiveScore: number }>
): number {
  const scoreDelta = left.effectiveScore - right.effectiveScore;

  if (scoreDelta !== 0) {
    return scoreDelta;
  }

  return compareMemoryEntries(right.entry, left.entry);
}

function compareRecallCandidates(
  left: Readonly<RecallCandidate>,
  right: Readonly<RecallCandidate>
): number {
  const relevanceDelta = right.relevance_score - left.relevance_score;
  if (relevanceDelta !== 0) {
    return relevanceDelta;
  }

  const activationDelta = right.activation_score - left.activation_score;
  if (activationDelta !== 0) {
    return activationDelta;
  }

  return left.object_id.localeCompare(right.object_id);
}

function applySimilarityBoost(
  candidate: Readonly<RecallCandidate>,
  similarityHint: Readonly<{
    readonly normalized_similarity: number;
  }> | undefined
): Readonly<RecallCandidate> {
  if (similarityHint === undefined) {
    return candidate;
  }

  return RecallCandidateSchema.parse({
    ...candidate,
    relevance_score: clamp01(
      candidate.relevance_score +
        clamp01(similarityHint.normalized_similarity) * EMBEDDING_SIMILARITY_WEIGHT
    )
  });
}

function normalizeActivationScore(value: number | null): number {
  return value ?? 0;
}

function normalizeGraphSupport(count: number): number {
  return Math.min(Math.max(count, 0), 3) / 3;
}

function normalizeQueryText(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function mapBudgetPenalty(snapshot: Readonly<BudgetSnapshot>): number {
  switch (snapshot.bankruptcy_kind) {
    case BankruptcyKind.NONE:
      return 0;
    case BankruptcyKind.SOFT:
      return 0.3;
    case BankruptcyKind.HARD:
      return 1;
    default:
      return 0;
  }
}

function getGlobalRecallLimit(policy: Readonly<RecallPolicy>): number {
  const semanticSupplementLimit = policy.coarse_filter.semantic_supplement.enabled
    ? policy.coarse_filter.semantic_supplement.max_supplement
    : 0;

  return Math.max(
    1,
    policy.coarse_filter.precomputed_rank.max_candidates,
    policy.fine_assessment.budgets.max_entries,
    semanticSupplementLimit
  );
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function isProtectedDimension(value: MemoryDimensionType): boolean {
  return value === MemoryDimension.CONSTRAINT || value === MemoryDimension.HAZARD;
}

export function classifyGlobalCandidate(
  entry: { readonly global_object_id: string },
  anchorMap: ReadonlyMap<string, Readonly<ProjectMappingAnchor>>
): Readonly<{
  include: boolean;
  reason: "adopted" | "no_anchor" | `not_adopted:${ProjectMappingState}`;
  anchor_state: ProjectMappingState | null;
}> {
  const anchor = anchorMap.get(entry.global_object_id);

  if (anchor === undefined) {
    return Object.freeze({
      include: false,
      reason: "no_anchor",
      anchor_state: null
    });
  }

  if (
    anchor.mapping_state === ProjectMappingState.ACCEPTED ||
    anchor.mapping_state === ProjectMappingState.ADAPTED
  ) {
    return Object.freeze({
      include: true,
      reason: "adopted",
      anchor_state: anchor.mapping_state
    });
  }

  return Object.freeze({
    include: false,
    reason: `not_adopted:${anchor.mapping_state}`,
    anchor_state: anchor.mapping_state
  });
}

function classifyProjectMappingCandidate(
  entry: Readonly<MemoryEntry>,
  anchorMap: ReadonlyMap<string, Readonly<ProjectMappingAnchor>>,
  projectMappingPort: RecallServiceDependencies["projectMappingPort"]
): Readonly<{ include: boolean; isAdvisory?: boolean }> {
  if (projectMappingPort === undefined || entry.scope_class === ScopeClass.PROJECT) {
    return Object.freeze({ include: true });
  }

  const anchor = anchorMap.get(entry.object_id);

  if (anchor === undefined) {
    return Object.freeze({ include: true, isAdvisory: true });
  }

  if (
    anchor.mapping_state === ProjectMappingState.REJECTED ||
    anchor.mapping_state === ProjectMappingState.NOT_APPLICABLE
  ) {
    return Object.freeze({ include: false });
  }

  if (
    anchor.mapping_state === ProjectMappingState.ACCEPTED ||
    anchor.mapping_state === ProjectMappingState.ADAPTED
  ) {
    return Object.freeze({ include: true, isAdvisory: false });
  }

  return Object.freeze({ include: true, isAdvisory: true });
}

function hasTagOverlap(source: readonly string[], filter: readonly string[]): boolean {
  const filterSet = new Set(filter);
  return source.some((tag) => filterSet.has(tag));
}

function matchesConfiguredCoarseFilter(
  entry: Readonly<MemoryEntry>,
  config: Readonly<RecallPolicy>["coarse_filter"]
): boolean {
  if (isProtectedDimension(entry.dimension)) {
    return true;
  }

  return matchesDeterministicFilter(entry, config) && matchesPrecomputedRankFilter(entry, config);
}

function matchesDeterministicFilter(
  entry: Readonly<MemoryEntry>,
  config: Readonly<RecallPolicy>["coarse_filter"]
): boolean {
  const scopePass =
    config.deterministic_match.scope_filter === null ||
    config.deterministic_match.scope_filter.includes(entry.scope_class);
  const dimensionPass =
    config.deterministic_match.dimension_filter === null ||
    config.deterministic_match.dimension_filter.includes(entry.dimension);
  const domainPass =
    config.deterministic_match.domain_tag_filter === null ||
    hasTagOverlap(entry.domain_tags, config.deterministic_match.domain_tag_filter);

  return scopePass && dimensionPass && domainPass;
}

function matchesPrecomputedRankFilter(
  entry: Readonly<MemoryEntry>,
  config: Readonly<RecallPolicy>["coarse_filter"]
): boolean {
  return (
    config.precomputed_rank.min_activation_score === null ||
    normalizeActivationScore(entry.activation_score) >= config.precomputed_rank.min_activation_score
  );
}

function estimateTokens(content: string): number {
  return Math.ceil(content.length / 4);
}

function createContentPreview(
  content: string,
  manifestation?: ManifestationState,
  originPlane?: RecallOriginPlane
): string {
  if (originPlane === "global" && manifestation === "full_eligible") {
    return content;
  }

  if (content.length <= 160) {
    return content;
  }

  return `${content.slice(0, 157)}...`;
}

function assignManifestation(activationScore: number): ManifestationState {
  if (activationScore < DYNAMICS_CONSTANTS.manifestation_thresholds.hidden_max) {
    return "hidden";
  }

  if (activationScore < DYNAMICS_CONSTANTS.manifestation_thresholds.hint_max) {
    return "hint";
  }

  if (activationScore < DYNAMICS_CONSTANTS.manifestation_thresholds.excerpt_max) {
    return "excerpt";
  }

  return "full_eligible";
}

function assertActivationWeightsSumToOne(
  weights: Readonly<Record<keyof typeof DYNAMICS_CONSTANTS.activation_weights_phase4b, number>>
): void {
  const sum = Object.values(weights).reduce((total, weight) => total + weight, 0);

  if (Math.abs(sum - 1) > Number.EPSILON) {
    throw new CoreError("VALIDATION", `activation_weights_phase4b must sum to 1.0, got ${sum}`);
  }
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
