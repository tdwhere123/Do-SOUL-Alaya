import { randomUUID } from "node:crypto";
import {
  ControlPlaneObjectKind,
  DYNAMICS_CONSTANTS,
  MEMORY_GRAPH_EDGE_RECALL_WEIGHTS,
  RecallContextEventType,
  RetentionPolicy,
  SoulRecallCompletedPayloadSchema,
  StorageTier,
  type FineAssessmentConfig,
  type ActivationWeights,
  type MemoryDimension as MemoryDimensionType,
  type MemoryGraphEdge,
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
import type { PreparedEmbeddingQueryHandle } from "./embedding-recall-service.js";
import { loadGlobalRecallCandidates } from "./global-memory-recall-service.js";
import { compileRecallQueryProbes, type RecallQueryProbes } from "./recall-query-probes.js";
import {
  buildRecallCandidate,
  rebuildRecallBudgetStateForDelivery,
  selectCandidatesWithinBudgets
} from "./recall-candidate-builder.js";
import { STRATEGY_RECALL_DEFAULTS, type NodeStrategy } from "./task-surface-builder.js";
import {
  EMBEDDING_SIMILARITY_WEIGHT,
  COLD_CASCADE_DECAY,
  MIN_RECALL_RESULTS,
  PATH_PLASTICITY_WEIGHT,
  WARM_CASCADE_DECAY,
  applySimilarityBoost,
  assertActivationWeightsSumToOne,
  buildRecallCandidateDedupeKey,
  classifyGlobalCandidate,
  classifyProjectMappingCandidate,
  clamp01,
  compareEffectiveScores,
  compareMemoryEntries,
  compareRecallCandidates,
  entryMatchesTimeFilter,
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
  RecallAdmissionPlane,
  RecallCandidateDiagnostic,
  RecallCandidateDropReason,
  RecallDiagnostics,
  RecallEmbeddingProviderStatus,
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
const DYNAMIC_RECALL_TEMPORAL_RADIUS = 3;
const DYNAMIC_RECALL_COHORT_RADIUS = 8;
const DYNAMIC_RECALL_EDGE_FANOUT = 12;
const NO_EMBEDDING_RELEVANCE_DIRECT_WEIGHT = 0.24;

interface CoarseCandidateDraft {
  readonly entry: Readonly<MemoryEntry>;
  readonly admissionPlanes: readonly RecallAdmissionPlane[];
  readonly firstAdmissionPlane: RecallAdmissionPlane;
  readonly sourceChannels: readonly string[];
  readonly structuralScore: number;
}

type CoarseCandidateAdder = (
  entry: Readonly<MemoryEntry>,
  plane: RecallAdmissionPlane,
  structuralScore?: number,
  sourceChannel?: string
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
  }): Promise<RecallResult> {
    const policy = this.resolvePolicy(params.strategy, params.taskSurface.runtime_id, params.policyOverride);
    const tokenEstimator = makeTokenEstimator({ hint: params.hostContext?.tokenizer_hint });
    const queryText = normalizeQueryText(params.taskSurface.display_name);
    const queryProbes = compileRecallQueryProbes(queryText);
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

    const hotCoarseFilter = await this.coarseFilter(params.workspaceId, policy.coarse_filter, queryText, {
      timeFilter: params.timeFilter,
      queryProbes,
      winnerMemoryIds
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
      localEligibleCandidates: coarseFilter.candidates,
      lexicalFallbackCount: lexicalCandidates.length
    });
    const mergedCandidates = await this.mergeEmbeddingSupplementCandidates({
      baseCandidates: lexicalCandidates,
      localEligibleCandidates: coarseFilter.candidates,
      config: policy,
      workspaceId: params.workspaceId,
      runId: params.runId ?? null,
      queryText,
      winnerMemoryIds,
      supplementaryData,
      preparedEmbeddingQuery: preparedEmbeddingQuery.handle,
      tokenEstimator
    });
    const embeddingProviderStatus = resolveEmbeddingProviderStatus(
      policy,
      preparedEmbeddingQuery.handle,
      preparedEmbeddingQuery.degradedReason
    );
    const candidates = rebuildRecallBudgetStateForDelivery(
      mergedCandidates,
      policy.fine_assessment
    );
    const candidateDiagnostics = finalizeRecallCandidateDiagnostics(
      assessment.diagnostics,
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
    await this.recordGlobalRecallClassificationsSafely(globalRecallClassifications);

    return Object.freeze({
      candidates,
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
        providerDegradationReason: preparedEmbeddingQuery.degradedReason,
        candidates: candidateDiagnostics
      })
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
      readonly queryProbes?: Readonly<RecallQueryProbes>;
      readonly winnerMemoryIds?: ReadonlySet<string>;
    }> = {}
  ): Promise<{
    readonly total_scanned: number;
    readonly candidates: readonly Readonly<CoarseRecallCandidate>[];
    readonly ftsRanks: Readonly<Record<string, number>>;
    readonly structuralScores: Readonly<Record<string, number>>;
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
    const protectedCandidates = tierMemories.filter(
      (entry) => isProtectedDimension(entry.dimension) || winnerMemoryIds.has(entry.object_id)
    );
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
    const structuralScores = new Map<string, number>();
    const addCandidate = (
      entry: Readonly<MemoryEntry>,
      plane: RecallAdmissionPlane,
      structuralScore = 0,
      sourceChannel?: string
    ): void => {
      if (
        plane !== "protected_winner" &&
        plane !== "lexical" &&
        !isProtectedDimension(entry.dimension) &&
        !winnerMemoryIds.has(entry.object_id) &&
        !matchesDeterministicFilter(entry, config)
      ) {
        return;
      }
      const current = drafts.get(entry.object_id);
      const evidenceStructuralScore = sourceChannel === "lexical" ? 0 : clamp01(structuralScore);
      const nextStructuralScore = Math.max(current?.structuralScore ?? 0, evidenceStructuralScore);
      drafts.set(entry.object_id, {
        entry,
        admissionPlanes: uniquePlanes([...(current?.admissionPlanes ?? []), plane]),
        firstAdmissionPlane: current?.firstAdmissionPlane ?? plane,
        sourceChannels: uniqueStrings([
          ...(current?.sourceChannels ?? []),
          ...(sourceChannel === undefined ? [] : [sourceChannel])
        ]),
        structuralScore: nextStructuralScore
      });
      structuralScores.set(
        entry.object_id,
        Math.max(structuralScores.get(entry.object_id) ?? 0, evidenceStructuralScore)
      );
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
    }

    this.addContentDerivedExpansionCandidates({
      tierMemories,
      drafts,
      queryProbes,
      addCandidate
    });
    await this.addGraphExpansionCandidates({
      workspaceId,
      byId,
      drafts,
      addCandidate,
      winnerMemoryIds
    });
    await this.addPathExpansionCandidates({
      workspaceId,
      byId,
      drafts,
      addCandidate,
      winnerMemoryIds
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
      structuralScores: Object.freeze(Object.fromEntries(structuralScores.entries())),
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

    const sortedByCreatedAt = [...params.tierMemories].sort((left, right) => {
      const createdAtComparison = left.created_at.localeCompare(right.created_at);
      return createdAtComparison === 0 ? left.object_id.localeCompare(right.object_id) : createdAtComparison;
    });
    const createdAtIndex = new Map(sortedByCreatedAt.map((entry, index) => [entry.object_id, index]));
    const datePrefixes = params.queryProbes.date_terms.filter((term) => /^\d{4}-\d{2}-\d{2}$/u.test(term));
    if (datePrefixes.length > 0) {
      const byDate = params.tierMemories
        .filter((entry) => datePrefixes.some((datePrefix) => entry.created_at.startsWith(datePrefix)))
        .slice(0, DYNAMIC_RECALL_PLANE_CAP);
      for (const entry of byDate) {
        params.addCandidate(entry, "temporal_proximity", 0.7, "temporal_proximity");
      }
    }
    if (structuralSeeds.length > 0 || params.queryProbes.date_terms.length > 0) {
      for (const seed of seeds.slice(0, DYNAMIC_RECALL_SEED_CAP)) {
        const center = createdAtIndex.get(seed.object_id);
        if (center === undefined) {
          continue;
        }
        for (let offset = -DYNAMIC_RECALL_TEMPORAL_RADIUS; offset <= DYNAMIC_RECALL_TEMPORAL_RADIUS; offset += 1) {
          if (offset === 0) {
            continue;
          }
          const entry = sortedByCreatedAt[center + offset];
          if (entry === undefined) {
            continue;
          }
          const score = clamp01(0.65 - Math.abs(offset) * 0.08);
          params.addCandidate(entry, "temporal_proximity", score, "temporal_proximity");
        }
      }
    }

    const querySurfaceIds = new Set(params.queryProbes.surface_ids);
    const queryRunIds = new Set(params.queryProbes.run_ids);
    const exactCohortMatches = params.tierMemories
      .filter((entry) =>
        (entry.surface_id !== null && querySurfaceIds.has(entry.surface_id)) ||
        (entry.run_id !== null && queryRunIds.has(entry.run_id))
      )
      .sort(compareMemoryEntries)
      .slice(0, DYNAMIC_RECALL_PLANE_CAP);
    for (const entry of exactCohortMatches) {
      params.addCandidate(entry, "session_surface_cohort", 0.8, "session_surface_cohort");
    }
    // invariant: cohort dominance guard. The seed-cohort branch admits the
    // ±N neighbors around a structural seed. On a small workspace this
    // degenerates into "admit every memory in the workspace" because every
    // memory shares the same run_id / surface_id. We compute the would-be
    // cohort size (per-seed ±radius unique) before admitting; if it would
    // cover more than half of tierMemories, the plane is skipped so other
    // planes (evidence_anchor / domain_tag_cluster / lexical) can compete.
    if (structuralSeeds.length > 0) {
      const cohortByMemoryId = new Map<string, readonly Readonly<MemoryEntry>[]>();
      const wouldBeCohort = new Set<string>();
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
        cohortByMemoryId.set(seed.object_id, cohort);
        const center = cohort.findIndex((entry) => entry.object_id === seed.object_id);
        if (center < 0) {
          continue;
        }
        const start = Math.max(0, center - DYNAMIC_RECALL_COHORT_RADIUS);
        const end = Math.min(cohort.length, center + DYNAMIC_RECALL_COHORT_RADIUS + 1);
        for (const entry of cohort.slice(start, end)) {
          if (entry.object_id !== seed.object_id) {
            wouldBeCohort.add(entry.object_id);
          }
        }
      }
      const seedCohortRatio =
        params.tierMemories.length === 0
          ? 0
          : wouldBeCohort.size / params.tierMemories.length;
      if (seedCohortRatio <= 0.5) {
        for (const seed of seeds.slice(0, DYNAMIC_RECALL_SEED_CAP)) {
          const cohort = cohortByMemoryId.get(seed.object_id) ?? [];
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

  private async addGraphExpansionCandidates(params: Readonly<{
    readonly workspaceId: string;
    readonly byId: ReadonlyMap<string, Readonly<MemoryEntry>>;
    readonly drafts: ReadonlyMap<string, CoarseCandidateDraft>;
    readonly addCandidate: CoarseCandidateAdder;
    readonly winnerMemoryIds: ReadonlySet<string>;
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
      // usage_proof gate: a seed only qualifies to project its graph
      // neighbors when there is independent evidence that the seed was
      // *used* historically — not just lexically matched in this query.
      // Two sources count as proof:
      //   1. an inbound RECALLS edge (left behind by a prior
      //      report_context_usage on this memory), or
      //   2. governance attestation via winnerMemoryIds (the seed is the
      //      backing memory of a slot's winner_claim).
      // Without this gate, graph_expansion degrades into "lexical-match
      // neighborhood discovery" and pollutes the structural score band.
      const hasRecallsEdge = edges.some((edge) => edge.edge_type === "recalls");
      const isWinnerBackedSeed = params.winnerMemoryIds.has(seed.entry.object_id);
      if (!hasRecallsEdge && !isWinnerBackedSeed) {
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

  // see also: addGraphExpansionCandidates — same gate inlined there
  private async filterUsageProofSeeds(
    seeds: readonly Readonly<CoarseCandidateDraft>[],
    workspaceId: string,
    winnerMemoryIds: ReadonlySet<string>,
    graphExpansionPort: typeof this.dependencies.graphExpansionPort
  ): Promise<readonly Readonly<CoarseCandidateDraft>[]> {
    if (graphExpansionPort === undefined) {
      return seeds.filter((seed) => winnerMemoryIds.has(seed.entry.object_id));
    }
    const qualified: Readonly<CoarseCandidateDraft>[] = [];
    for (const seed of seeds) {
      if (winnerMemoryIds.has(seed.entry.object_id)) {
        qualified.push(seed);
        continue;
      }
      try {
        const edges = await graphExpansionPort.findByMemoryId(
          seed.entry.object_id,
          workspaceId
        );
        if (edges.some((edge) => edge.edge_type === "recalls")) {
          qualified.push(seed);
        }
      } catch (error) {
        this.warn("usage_proof seed gate lookup failed", {
          workspace_id: workspaceId,
          seed_memory_id: seed.entry.object_id,
          error: toErrorMessage(error)
        });
      }
    }
    return qualified;
  }

  private async addPathExpansionCandidates(params: Readonly<{
    readonly workspaceId: string;
    readonly byId: ReadonlyMap<string, Readonly<MemoryEntry>>;
    readonly drafts: ReadonlyMap<string, CoarseCandidateDraft>;
    readonly addCandidate: CoarseCandidateAdder;
    readonly winnerMemoryIds: ReadonlySet<string>;
  }>): Promise<void> {
    const pathExpansionPort = this.dependencies.pathExpansionPort;
    if (pathExpansionPort === undefined || params.drafts.size === 0) {
      return;
    }

    // invariant: usage_proof seed gate (also enforced in
    // addGraphExpansionCandidates): a PathRelation anchor must be either
    // governance-attested (winnerMemoryIds) or have at least one inbound
    // RECALLS edge. Lexical-only seeds do not qualify.
    const graphExpansionPort = this.dependencies.graphExpansionPort;
    const allSeeds = selectExpansionSeedDrafts(params.drafts).slice(0, DYNAMIC_RECALL_SEED_CAP);
    const seeds: readonly Readonly<CoarseCandidateDraft>[] = await this.filterUsageProofSeeds(
      allSeeds,
      params.workspaceId,
      params.winnerMemoryIds,
      graphExpansionPort
    );
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

    let added = 0;
    for (const path of paths) {
      if (added >= DYNAMIC_RECALL_PLANE_CAP) {
        return;
      }
      if (isRetiredPathRelation(path)) {
        continue;
      }
      for (const targetId of directionEligiblePathExpansionTargets(path, seedIds)) {
        const entry = params.byId.get(targetId);
        if (entry === undefined) {
          continue;
        }
        params.addCandidate(entry, "path_expansion", scorePathRelationExpansion(path), "path_expansion");
        added += 1;
        if (added >= DYNAMIC_RECALL_PLANE_CAP) {
          return;
        }
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
      winnerMemoryIds: params.winnerMemoryIds
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
      winnerMemoryIds: params.winnerMemoryIds
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
    readonly diagnostics: readonly Readonly<RecallCandidateDiagnostic>[];
  }>> {
    const supplementaryData = await this.collectSupplementaryData({
      candidates: params.coarseFilter.candidates.map((candidate) => candidate.entry),
      workspaceId: params.workspaceId,
      runId: params.runId,
      queryText: params.queryText,
      coarseFtsRanks: params.coarseFilter.ftsRanks,
      coarseStructuralScores: params.coarseFilter.structuralScores
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
      structuralScores: Object.freeze({
        ...current.structuralScores,
        ...next.structuralScores
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
    readonly coarseStructuralScores: Readonly<Record<string, number>>;
  }): Promise<RecallSupplementaryData> {
    // graph_support is a weighted inbound aggregate across edge types; the
    // storage repo owns the concrete edge_type weight map.
    const graphSupportCounts = Object.fromEntries(
      await Promise.all(
        params.candidates.map(async (candidate) => [
          candidate.object_id,
          this.dependencies.graphSupportPort === undefined
            ? 0
            : await this.dependencies.graphSupportPort.countInboundEdgesWeighted(
                candidate.object_id,
                params.workspaceId
              )
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

    const graphAndPathCold =
      params.candidates.length > 0 &&
      params.candidates.every(
        (candidate) =>
          normalizeGraphSupport(graphSupportCounts[candidate.object_id] ?? 0) === 0 &&
          clamp01(plasticityFactors[candidate.object_id] ?? 0) === 0
      );

    return Object.freeze({
      ftsRanks: params.coarseFtsRanks,
      structuralScores: params.coarseStructuralScores,
      graphSupportCounts: Object.freeze(graphSupportCounts),
      budgetPenaltyFactor,
      plasticityFactors,
      graphAndPathCold
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
      applySimilarityBoost(
        candidate,
        isWorkspaceLocalRecallCandidate(candidate)
          ? supplement.similarityHintsByObjectId[candidate.object_id]
          : undefined
      )
    );
    const seenLocalIds = new Set(
      boostedBaseCandidates
        .filter(isWorkspaceLocalRecallCandidate)
        .map((candidate) => candidate.object_id)
    );
    const additiveCandidates = supplement.supplementaryEntries.flatMap((entry) => {
      if (seenLocalIds.has(entry.object_id)) {
        return [];
      }

      const coarseCandidate = localCandidateById.get(entry.object_id);
      const similarityHint = supplement.similarityHintsByObjectId[entry.object_id];
      if (coarseCandidate === undefined || similarityHint === undefined) {
        return [];
      }

      seenLocalIds.add(entry.object_id);
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

    return selectCandidatesWithinBudgets(
      [...boostedBaseCandidates, ...additiveCandidates].sort(compareRecallCandidates),
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
  }): Promise<Readonly<{
    readonly handle: PreparedEmbeddingQueryHandle | null;
    readonly degradedReason: string | null;
  }>> {
    const embeddingRecallService = this.dependencies.embeddingRecallService;
    if (
      embeddingRecallService === undefined ||
      typeof embeddingRecallService.prepareQueryEmbedding !== "function" ||
      params.queryText === null ||
      params.config.coarse_filter.semantic_supplement.embedding_enabled !== true ||
      params.config.coarse_filter.semantic_supplement.max_supplement <= 0 ||
      params.localEligibleCandidates.length === 0
    ) {
      return Object.freeze({ handle: null, degradedReason: null });
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
          degradedReason: normalizeEmbeddingProviderDegradationReason(reason)
        });
      }

      if (!hasStoredVectors) {
        return Object.freeze({ handle: null, degradedReason: null });
      }
    }

    return Object.freeze({
      handle: embeddingRecallService.prepareQueryEmbedding({
        workspaceId: params.workspaceId,
        runId: params.runId,
        queryText: params.queryText
      }),
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
      candidate: Readonly<CoarseRecallCandidate>,
      mandatoryEntry: boolean,
      preBudgetRank: number
    ): FineAssessmentAccumulator => {
      const entry = candidate.entry;
      const candidateKey = buildRecallCandidateDedupeKey(candidate);
      const scored = this.computeEffectiveScoreDetails(
        entry,
        policy,
        winnerMemoryIds,
        supplementaryData,
        candidate.isAdvisory ?? false,
        candidate.scoreMultiplier ?? 1
      );
      const createDiagnostic = (
        droppedReason: RecallCandidateDropReason | null,
        finalRank: number | null
      ): Readonly<RecallCandidateDiagnostic> => {
        const admissionPlanes = Object.freeze([...(candidate.admissionPlanes ?? ["activation"])]);
        return Object.freeze({
          object_id: entry.object_id,
          admission_planes: admissionPlanes,
          plane_first_admitted: candidate.firstAdmissionPlane ?? admissionPlanes[0] ?? "activation",
          plane_winning_admission: admissionPlanes[admissionPlanes.length - 1] ?? candidate.firstAdmissionPlane ?? "activation",
          pre_budget_rank: preBudgetRank,
          final_rank: finalRank,
          dropped_reason: droppedReason,
          within_budget: droppedReason === null,
          relevance_score: scored.score,
          lexical_rank: supplementaryData.ftsRanks[entry.object_id] ?? null,
          structural_score: clamp01(candidate.structuralScore ?? supplementaryData.structuralScores[entry.object_id] ?? 0),
          source_channels: Object.freeze(uniqueStrings([
            candidate.originPlane ?? "workspace_local",
            candidate.sourceChannel ?? "",
            ...(candidate.sourceChannels ?? []),
            ...(admissionPlanes).map((plane) => `plane:${plane}`)
          ].filter((channel) => channel.length > 0)))
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

      if (!mandatoryEntry) {
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
      }

      const nextCandidate = buildRecallCandidate({
        candidate,
        relevanceScore: scored.score,
        scoreFactors: scored.factors,
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

    const withMandatory = mandatory.reduce(
      (accumulator, candidate, index) => appendCandidate(accumulator, candidate, true, index + 1),
      initialAccumulator
    );
    const finalAccumulator = optional.reduce(
      (accumulator, candidate, index) => appendCandidate(accumulator, candidate, false, mandatory.length + index + 1),
      withMandatory
    );

    return Object.freeze({
      candidates: Object.freeze([...finalAccumulator.selected]),
      diagnostics: Object.freeze([...finalAccumulator.diagnostics])
    });
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
    const weights = resolveDynamicActivationWeights(
      this.resolveEffectiveActivationWeights(entry, policy),
      supplementaryData.graphAndPathCold
    );
    const activationScore = normalizeActivationScore(entry.activation_score);
    const ftsFactor = supplementaryData.ftsRanks[entry.object_id] ?? 0;
    const structuralFactor = supplementaryData.structuralScores[entry.object_id] ?? 0;
    const relevanceFactor =
      ftsFactor > 0 && structuralFactor > 0
        ? clamp01(ftsFactor * 0.24 + structuralFactor * 0.76)
        : Math.max(ftsFactor * 0.62, structuralFactor);
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
    const pathPlasticityWeight = supplementaryData.graphAndPathCold ? 0 : PATH_PLASTICITY_WEIGHT;

    const rawScore = clamp01(
      activationScore * baseWeight +
        relevanceFactor * weights.relevance +
        relevanceFactor * NO_EMBEDDING_RELEVANCE_DIRECT_WEIGHT +
        graphSupportFactor * weights.graph_support +
        plasticityFactor * pathPlasticityWeight -
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

    return buildRecallCandidate({
      candidate,
      relevanceScore,
      scoreFactors,
      tokenEstimator,
      budgets: policy.fine_assessment.budgets,
      index: 0,
      usedTokensBeforeCandidate: 0,
      extraSourceChannel: "semantic_supplement"
    });
  }
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
    candidates: Object.freeze([...params.candidates])
  });
}

function finalizeRecallCandidateDiagnostics(
  diagnostics: readonly Readonly<RecallCandidateDiagnostic>[],
  deliveredCandidates: readonly Readonly<RecallCandidate>[]
): readonly Readonly<RecallCandidateDiagnostic>[] {
  const deliveredRankByObjectId = new Map(
    deliveredCandidates.map((candidate, index) => [candidate.object_id, index + 1] as const)
  );
  return Object.freeze(
    diagnostics.map((diagnostic) => {
      const deliveredRank = deliveredRankByObjectId.get(diagnostic.object_id) ?? null;
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

function normalizeEmbeddingProviderDegradationReason(reason: string): string | null {
  const normalized = reason.trim().toLowerCase();
  if (
    normalized === "query_embedding_failed" ||
    normalized === "provider_unavailable" ||
    normalized === "local_vector_lookup_failed"
  ) {
    return normalized;
  }
  return "provider_unavailable";
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
    plane === "temporal_proximity" ||
    plane === "session_surface_cohort" ||
    plane === "graph_expansion" ||
    plane === "path_expansion"
  )) {
    return 3;
  }
  if (draft.admissionPlanes.includes("lexical")) {
    return 2;
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
): readonly string[] {
  const sourceId = anchorMemoryId(path.anchors.source_anchor);
  const targetId = anchorMemoryId(path.anchors.target_anchor);
  if (sourceId === undefined || targetId === undefined || sourceId === targetId) {
    return [];
  }

  const targets = new Set<string>();
  if (
    seedIds.has(sourceId) &&
    (path.plasticity_state.direction_bias === "source_to_target" ||
      path.plasticity_state.direction_bias === "bidirectional_asymmetric")
  ) {
    targets.add(targetId);
  }
  if (
    seedIds.has(targetId) &&
    (path.plasticity_state.direction_bias === "target_to_source" ||
      path.plasticity_state.direction_bias === "bidirectional_asymmetric")
  ) {
    targets.add(sourceId);
  }
  return [...targets];
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

function uniquePlanes(values: readonly RecallAdmissionPlane[]): readonly RecallAdmissionPlane[] {
  return [...new Set(values)];
}

function isWorkspaceLocalRecallCandidate(candidate: Readonly<RecallCandidate>): boolean {
  return (candidate.origin_plane ?? "workspace_local") === "workspace_local";
}

function resolveDynamicActivationWeights(
  weights: ActivationWeights,
  graphAndPathCold: boolean
): ActivationWeights {
  if (!graphAndPathCold) {
    return weights;
  }

  return Object.freeze({
    ...weights,
    relevance: weights.relevance + weights.graph_support + PATH_PLASTICITY_WEIGHT,
    graph_support: 0
  });
}
