import type {
  BudgetSnapshot,
  EventLogEntry,
  EvidenceCapsule,
  ManifestationState,
  MemoryDimension as MemoryDimensionType,
  MemoryEntry,
  PathAnchorRef,
  PathRelation,
  ProjectMappingAnchor,
  RecallCandidate,
  RecallScoreFactors,
  RecallOriginPlane,
  SoulActiveConstraint,
  SoulRecallHostContext,
  SoulRecallTokenizerHint,
  SoulMemorySearchDegradationReason,
  Slot,
  StorageTier as StorageTierType,
  SynthesisCapsule
} from "@do-soul/alaya-protocol";
import type { ScopeClass } from "@do-soul/alaya-protocol";
import type {
  EmbeddingNeighborHit,
  EmbeddingWorkspaceNeighborResult,
  EmbeddingRecallSupplementResult,
  PreparedEmbeddingSupplement,
  PreparedEmbeddingQueryHandle
} from "../embedding-recall/embedding-recall-service.js";
import type {
  ManifestationBiasSidecarEntry
} from "../manifestation/manifestation-resolver.js";
import type {
  GlobalMemoryRecallCachePort,
  GlobalMemoryRecallPort
} from "./global-memory-recall-port.js";

export interface KeywordSearchResult {
  readonly object_id: string;
  readonly normalized_rank: number;
  // Trigram-lane ordinal score, present only when the keyword search routed a
  // hit through the substring/CJK trigram lane. Feeds the trigram_fts fusion
  // stream. Absent for exact/porter-only hits.
  readonly trigram_rank?: number;
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
  // see also: 068-evidence-capsule-fts.sql. Used by lexical plane to admit
  // memories whose distilled content lost keywords but whose underlying
  // EvidenceCapsule.gist still matches the query.
  findByEvidenceRefs?(
    workspaceId: string,
    evidenceObjectIds: readonly string[]
  ): Promise<readonly Readonly<MemoryEntry>[]>;
  // Optional id-batch lookup. Used by the embedding-on coarse-injection path
  // to resolve workspace cosine neighbors into MemoryEntry candidates.
  findByIds?(objectIds: readonly string[]): Promise<readonly Readonly<MemoryEntry>[]>;
}

// Evidence FTS port consumed by the recall service. The implementing repo
// is SqliteEvidenceCapsuleRepo (migration 068). Recall uses this only to
// widen lexical candidate generation when distillation drops keywords.
export interface RecallServiceEvidenceSearchPort {
  searchByKeyword(
    workspaceId: string,
    queryText: string,
    limit: number
  ): Promise<readonly KeywordSearchResult[]>;
  findByIds?(
    workspaceId: string,
    evidenceObjectIds: readonly string[]
  ): Promise<readonly Readonly<EvidenceCapsule>[]>;
}

// Synthesis FTS port consumed by the recall service. The implementing repo
// is SqliteSynthesisCapsuleRepo (migration 079). Recall queries it on the
// FTS-backed keyword path and joins each hit as a synthesis_capsule candidate
// before fusion, rerank, and delivery-budget selection.
// see also: packages/storage/src/repos/synthesis-capsule-repo.ts
export interface RecallServiceSynthesisSearchPort {
  searchByKeyword(
    workspaceId: string,
    queryText: string,
    limit: number
  ): Promise<readonly KeywordSearchResult[]>;
  findByIds(
    objectIds: readonly string[]
  ): Promise<readonly Readonly<SynthesisCapsule>[]>;
}

export interface RecallServiceSlotRepoPort {
  findByWorkspace(workspaceId: string): Promise<readonly Readonly<Slot>[]>;
}

export interface RecallServiceEventLogRepoPort {
  append(entry: Omit<EventLogEntry, "event_id" | "created_at" | "revision">): EventLogEntry | Promise<EventLogEntry>;
  queryByEntity(entityType: string, entityId: string): Promise<readonly EventLogEntry[]>;
}

export interface RecallServiceGraphSupportPort {
  /** @deprecated recall reads `countInboundEdgesWeighted` instead.
   * Kept on the port for non-recall callers (raw supports-only count). */
  countInboundSupports(memoryId: string, workspaceId: string): Promise<number>;
  // Aggregates inbound graph edges by edge_type weight into one signed
  // support score. The recall service consumes this so that derives_from /
  // recalls signals also lift graph_support, and supersedes pulls it down
  // (floor-clamped to zero baseline; see MEMORY_GRAPH_EDGE_RECALL_WEIGHTS invariant).
  countInboundEdgesWeighted(memoryId: string, workspaceId: string): Promise<number>;
  // Counts inbound RECALLS edges only. Cold-mode transfer uses this as explicit
  // evidence that recall graph activity exists, independent of other
  // graph-support edge types.
  countInboundRecalls?(memoryId: string, workspaceId: string): Promise<number>;
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

/**
 * Optional port that returns the strongest direction-eligible
 * PathPlasticityState.strength across all path relations anchored on each
 * memory entry. Implementations are expected to read precomputed
 * PathRelation rows and apply direction_bias filtering; the recall service
 * does not compute paths itself.
 *
 * The map's value range is [0, 1]. Memories without an entry are treated as
 * having no plasticity boost.
 */
export interface RecallServicePathPlasticityPort {
  getStrengthByMemoryId(
    workspaceId: string,
    memoryIds: readonly string[]
  ): Promise<ReadonlyMap<string, number>>;
}

export interface RecallServicePathExpansionPort {
  findByAnchors(
    workspaceId: string,
    anchorRefs: readonly PathAnchorRef[]
  ): Promise<readonly Readonly<PathRelation>[]>;
  findByTimeConcernWindowDigests?(
    workspaceId: string,
    windowDigests: readonly string[]
  ): Promise<readonly Readonly<PathRelation>[]>;
}

export interface RecallServiceActiveConstraintsPort {
  findActiveConstraints(params: Readonly<{
    readonly workspaceId: string;
    readonly cap?: number | null;
  }>): Promise<Readonly<{
    readonly constraints: readonly Readonly<SoulActiveConstraint>[];
    readonly total_count: number;
  }>>;
}

// invariant: ManifestationSidecarApplierPort produces the bias sidecar
// the recall service forwards into RecallCandidate.pending_incomplete
// and RecallCandidate.unfinishedness_bias. Implementations are expected
// to call PathActivationCandidateProducer and ManifestationResolver in
// sequence. The port is optional. When absent the recall service skips
// the sidecar step and emits candidates unchanged.
export interface RecallServiceManifestationSidecarPort {
  buildBiasSidecar(params: Readonly<{
    readonly workspaceId: string;
    readonly runId: string;
    readonly anchorMemoryObjectIds: readonly string[];
    readonly taskSurfaceRef: Readonly<import("@do-soul/alaya-protocol").TaskObjectSurface> | null;
  }>): Promise<readonly Readonly<ManifestationBiasSidecarEntry>[]>;
}

export interface TokenEstimator {
  estimate(text: string): number;
}

export function makeTokenEstimator(opts: {
  readonly hint?: SoulRecallTokenizerHint | null;
} = {}): TokenEstimator {
  const charsPerToken = resolveCharsPerToken(opts.hint ?? null);

  return Object.freeze({
    estimate(text: string): number {
      return Math.ceil(text.length / charsPerToken);
    }
  });
}

function resolveCharsPerToken(hint: SoulRecallTokenizerHint | null): number {
  switch (hint) {
    case "cl100k":
      // OpenAI tokenizer docs cite ~4 chars/token for common English text;
      // the hint is a conservative heuristic, not a native tokenizer.
      return 3.6;
    case "o200k":
      return 3.2;
    case "approx_chars_per_token":
    case null:
      return 4;
  }
}

export interface RecallServiceEmbeddingRecallPort {
  prepareQuerySupplement?(params: {
    readonly workspaceId: string;
    readonly runId: string | null;
    readonly queryText: string;
    readonly eligibleMemories: readonly Readonly<MemoryEntry>[];
    readonly baseCandidateCount: number;
  }): Promise<PreparedEmbeddingSupplement>;
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
    readonly storedVectors?: PreparedEmbeddingSupplement["storedVectors"];
  }): Promise<EmbeddingRecallSupplementResult>;
  querySupplement(params: {
    readonly workspaceId: string;
    readonly runId: string | null;
    readonly queryText: string;
    readonly eligibleMemories: readonly Readonly<MemoryEntry>[];
    readonly baseCandidateIds: readonly string[];
    readonly maxSupplement: number;
  }): Promise<EmbeddingRecallSupplementResult>;
  // Embedding-on coarse-injection path: top-K workspace cosine neighbors that
  // lexical recall never admitted. Optional so keyword-only providers and
  // older test doubles stay valid.
  collectWorkspaceNeighbors?(params: {
    readonly workspaceId: string;
    readonly runId: string | null;
    readonly queryText: string;
    readonly excludeObjectIds: readonly string[];
    readonly maxNeighbors: number;
  }): Promise<readonly Readonly<EmbeddingNeighborHit>[]>;
  collectWorkspaceNeighborsWithMetadata?(params: {
    readonly workspaceId: string;
    readonly runId: string | null;
    readonly queryText: string;
    readonly excludeObjectIds: readonly string[];
    readonly maxNeighbors: number;
  }): Promise<Readonly<EmbeddingWorkspaceNeighborResult>>;
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
  readonly pathPlasticityPort?: RecallServicePathPlasticityPort;
  readonly pathExpansionPort?: RecallServicePathExpansionPort;
  readonly activeConstraintsPort?: RecallServiceActiveConstraintsPort;
  readonly evidenceSearchPort?: RecallServiceEvidenceSearchPort;
  readonly synthesisSearchPort?: RecallServiceSynthesisSearchPort;
  readonly manifestationSidecarPort?: RecallServiceManifestationSidecarPort;
  // Optional decorator applied to every policy buildDefaultPolicy emits.
  // The daemon uses it to inject scoring_weight_overrides driven by runtime
  // state (e.g. raise the embedding_similarity fusion weight when the
  // embedding provider is wired). Decorators must return a structurally
  // valid RecallPolicy; an identity function is the safe default.
  readonly defaultPolicyDecorator?: (
    policy: Readonly<import("@do-soul/alaya-protocol").RecallPolicy>
  ) => Readonly<import("@do-soul/alaya-protocol").RecallPolicy>;
  // see also: packages/core/src/shared/entity-extraction-port.ts
  // see also: packages/core/src/shared/entity-extraction-rules.ts RuleBasedEntityExtractor
  readonly entityExtractionPort?: import("../shared/entity-extraction-port.js").EntityExtractionPort;
  readonly generateRuntimeId?: () => string;
  readonly now?: () => string;
  readonly warn?: RecallServiceWarnPort;
}

export type RecallAdmissionPlane =
  | "activation"
  | "protected_winner"
  | "object_probe"
  | "evidence_anchor"
  | "domain_tag_cluster"
  | "session_surface_cohort"
  | "source_proximity"
  | "graph_expansion"
  | "path_expansion"
  | "lexical"
  // Coarse-injection candidates surfaced by the embedding workspace neighbor
  // scan. They have no lexical / structural anchor, so a separate plane name
  // keeps source-proximity / graph-expansion seed selection honest.
  | "semantic_supplement"
  // see also: collectEntityDerivedSeeds — query-time entity FTS hits that
  // both seed graph_expansion and admit candidates on their own plane.
  | "entity_seed";

export type RecallCandidateDropReason =
  | "duplicate"
  | "dimension_limit"
  | "max_entries"
  | "max_total_tokens";

export type RecallEmbeddingProviderStatus =
  | "provider_returned"
  | "provider_pending"
  | "provider_failed"
  | "provider_not_requested";

export type RecallFusionStream =
  | "lexical_fts"
  | "trigram_fts"
  | "synthesis_fts"
  | "evidence_fts"
  | "evidence_structural_agreement"
  | "source_proximity"
  | "source_evidence_agreement"
  | "subject_alignment"
  | "structural"
  | "existing_score"
  | "embedding_similarity"
  | "graph_expansion"
  // see also: packages/core/src/recall/fusion-delivery.ts:scoreRecallFusionStream
  | "entity_seed"
  // invariant: path_expansion is the direct multi-session fan-in carrier.
  // Earned sparse co_recalled PathRelations fan a query that hits a
  // non-representative cohort member into same-session siblings via the unified
  // path plane.
  // see also: packages/core/src/recall/fusion-delivery.ts:scoreRecallFusionStream
  | "path_expansion"
  | "temporal_recency"
  | "workspace_activation";

export type RecallFusionStreamRanks = Readonly<Record<RecallFusionStream, number | null>>;
export type RecallFusionStreamContributions = Readonly<Record<RecallFusionStream, number>>;

export interface RecallFusionBreakdown {
  readonly candidate_key: string;
  readonly object_id: string;
  readonly object_kind: RecallCandidate["object_kind"];
  readonly origin_plane: RecallOriginPlane;
  readonly per_stream_rank: RecallFusionStreamRanks;
  readonly fused_rank: number;
  readonly fused_score: number;
  readonly fused_rank_contribution_per_stream: RecallFusionStreamContributions;
}

export interface RecallCandidateDiagnostic {
  readonly candidate_key: string;
  readonly object_id: string;
  readonly object_kind: RecallCandidate["object_kind"];
  // Object's memory dimension (typed facet) — for facet-separation diagnostics. Provenance only.
  readonly dimension: string;
  readonly origin_plane: RecallOriginPlane;
  readonly admission_planes: readonly RecallAdmissionPlane[];
  readonly plane_first_admitted: RecallAdmissionPlane;
  readonly plane_winning_admission: RecallAdmissionPlane;
  readonly pre_budget_rank: number;
  readonly selection_order: number;
  readonly fused_rank: number;
  readonly fused_score: number;
  readonly per_stream_rank: RecallFusionStreamRanks;
  readonly fused_rank_contribution_per_stream: RecallFusionStreamContributions;
  readonly final_rank: number | null;
  readonly dropped_reason: RecallCandidateDropReason | null;
  readonly within_budget: boolean;
  readonly relevance_score: number;
  readonly lexical_rank: number | null;
  readonly structural_score: number;
  readonly score_factors: Readonly<RecallScoreFactors>;
  readonly source_channels: readonly string[];
  readonly path_expansion_sources: readonly RecallPathExpansionSourceDiagnostic[];
  // Per-stage delivery rank trajectory through fineAssess (1-based). Lets
  // diagnostics see WHERE a candidate fell out of the top-k delivery window:
  // natural fusion ordering vs feature rerank vs lexical priority vs a reserve
  // displacing it. reserved_by names the stage that pulled THIS candidate into
  // the window. Optional — provenance only, never feeds ranking.
  readonly rank_after_fusion?: number;
  readonly rank_after_feature_rerank?: number;
  readonly rank_after_lexical_priority?: number;
  readonly rank_after_synthesis_reserve?: number;
  readonly rank_after_structural_reserve?: number;
  readonly reserved_by?: "none" | "synthesis" | "structural";
}

export interface RecallPathExpansionSourceDiagnostic {
  readonly path_id: string;
  readonly seed_id: string;
  readonly seed_kind: "memory" | "time_concern";
  readonly target_object_id: string;
  readonly source_channel: "path_expansion" | "time_concern";
  // Which relation carried the candidate (constitution.relation_kind) and, when
  // the path is anchored on a specific object facet, which facet_key fired.
  // Provenance only — lets diagnostics attribute gold delivery to a relation/
  // facet instead of a flat "path_expansion" stream label.
  readonly relation_kind: string;
  readonly facet_key: string | null;
}

// invariant: per-recall token economy is measure-only instrumentation.
// It never feeds back into recall ranking, never gates eligibility, and
// never becomes part of the protocol payload — it lives entirely inside
// the in-memory RecallDiagnostics sub-object that the bench harness
// captures via BenchRecallDiagnosticsSchema.
// see also:
//   packages/core/src/recall/diagnostics.ts:buildRecallDiagnostics, computeRecallTokenEconomy
//   apps/bench-runner/src/harness/recall-diagnostics-schema.ts
//   apps/bench-runner/src/longmemeval/diagnostics.ts (KPI aggregation)
//
// @anchor recall-token-economy-token-units: every "tokens" figure is the
// chars/4 approximation produced by makeTokenEstimator (see resolveCharsPerToken
// above). The default 4 chars/token is OpenAI-style English heuristic; CJK
// content is underestimated by roughly 3-4x because Chinese / Japanese /
// Korean characters average closer to 1-1.5 chars/token under cl100k/o200k.
// Release notes citing mean / p95 figures must qualify with this caveat.
export interface RecallTokenEconomy {
  // Sum of token_estimate over candidates actually delivered to the caller.
  // Derived from the same chars/token heuristic the caller sees in the
  // delivered RecallCandidate.token_estimate field, so the figure agrees
  // with the bench's existing total_token_estimate KPI per recall.
  readonly delivered_context_tokens_estimate: number;
  // Coarse-stage pool size — the number of candidates flowing into
  // fineAssess, matching candidate_pool_count.
  readonly coarse_pool_size: number;
  // Fine-assess evaluated count — every coarse candidate has its fused
  // score and feature rerank computed before delivery truncation, so this
  // equals the input pool length even when the budget drops some rows.
  readonly fine_evaluated: number;
  // Number of distinct fusion streams that produced at least one non-null
  // per_stream_rank across all pre-budget candidates. Surfaces "how many
  // recall channels actually contributed signal" per call.
  readonly fusion_streams_with_hits: number;
  // Embedding provider inference calls attributable to this recall. 0 when
  // the provider was not requested, the snapshot was a cache hit, or the
  // provider failed before returning. 1 when the recall pipeline actually
  // consumed a fresh provider invocation for its query embedding.
  readonly embedding_inference_calls: number;
}

export type RecallGraphExpansionTrackedEdgeType =
  | "derives_from"
  | "recalls"
  | "supports";

export type RecallGraphExpansionPlaneCountPerHop = readonly [number, number];

export type RecallGraphExpansionPlaneCountPerEdgeType = Readonly<
  Record<RecallGraphExpansionTrackedEdgeType, number>
>;

// invariant: multi-seed fan-in is measured per addGraphExpansionCandidates
// call. When the entity_seed plane contributes 2+ distinct entity-derived
// seeds, each seed expands independently and the per-seed candidate counts
// are aggregated here so downstream tuning can read distribution shape
// without re-deriving from raw graph events.
// see also: recall-service.ts addGraphExpansionCandidates
export interface RecallMultiSeedGraphFanInDiagnostics {
  readonly distinct_seeds: number;
  readonly candidates_per_seed_p50: number;
  readonly candidates_per_seed_p95: number;
  readonly dedup_collisions: number;
}

export interface RecallGraphExpansionDiagnostics {
  readonly graph_expansion_plane_count_per_hop: RecallGraphExpansionPlaneCountPerHop;
  readonly graph_expansion_plane_count_per_edge_type: RecallGraphExpansionPlaneCountPerEdgeType;
  // Optional only when no entity-derived seeds were fanned in (distinct_seeds
  // would be 0 in that case). Absence preserves the legacy
  // RecallGraphExpansionDiagnostics shape so external readers that ignore
  // the field stay binary-compatible. see also: recall-service.ts
  // addGraphExpansionCandidates multi-seed fan-in path.
  readonly multi_seed_graph_fan_in?: Readonly<RecallMultiSeedGraphFanInDiagnostics>;
}

export interface RecallDiagnostics {
  readonly query_probes: {
    readonly subject_hints: readonly string[];
    readonly object_ids: readonly string[];
    readonly evidence_refs: readonly string[];
    readonly run_ids: readonly string[];
    readonly surface_ids: readonly string[];
    readonly file_paths: readonly string[];
    readonly command_names: readonly string[];
    readonly package_names: readonly string[];
    readonly task_refs: readonly string[];
    readonly dimensions: readonly string[];
    readonly scope_classes: readonly string[];
    readonly domain_tags: readonly string[];
    readonly lexical_terms: readonly string[];
    readonly expanded_terms: readonly string[];
    readonly phrases: readonly string[];
    readonly char_ngrams: readonly string[];
    readonly date_terms: readonly string[];
  };
  readonly total_scanned: number;
  readonly candidate_pool_count: number;
  readonly pre_budget_count: number;
  readonly delivered_count: number;
  readonly embedding_provider_status: RecallEmbeddingProviderStatus;
  readonly provider_degradation_reason: string | null;
  readonly graph_expansion_plane_count_per_hop: RecallGraphExpansionPlaneCountPerHop;
  readonly graph_expansion_plane_count_per_edge_type: RecallGraphExpansionPlaneCountPerEdgeType;
  // Optional. Only present when the entity_seed plane drove 1+ entity-derived
  // seeds into graph fan-in for this recall. Absence means the recall's
  // graph_expansion plane was content/structural-seed driven only and has
  // no per-seed distribution to summarise.
  readonly multi_seed_graph_fan_in?: Readonly<RecallMultiSeedGraphFanInDiagnostics>;
  readonly fusion_breakdown: readonly Readonly<RecallFusionBreakdown>[];
  readonly candidates: readonly Readonly<RecallCandidateDiagnostic>[];
  // Per-recall structural token instrument. Optional only for legacy callers
  // and malformed diagnostics; RecallService emits it for both normal and
  // degraded recall paths so bench token-instrument coverage can stay at
  // 100% per recall call without inventing synthetic zero samples.
  readonly token_economy?: Readonly<RecallTokenEconomy>;
}

export interface RecallResult {
  readonly candidates: readonly Readonly<RecallCandidate>[];
  readonly active_constraints: readonly Readonly<SoulActiveConstraint>[];
  readonly active_constraints_count: number;
  readonly total_scanned: number;
  readonly coarse_filter_count: number;
  readonly fine_assessment_count: number;
  readonly degradation_reason: SoulMemorySearchDegradationReason | null;
  readonly working_projection: null;
  readonly diagnostics?: Readonly<RecallDiagnostics>;
}

export interface RecallSupplementaryData {
  readonly queryProbes: Readonly<import("./recall-query-probes.js").RecallQueryProbes>;
  readonly ftsRanks: Readonly<Record<string, number>>;
  // Trigram-lane normalized rank, surfaced separately from ftsRanks so the
  // trigram_fts fusion stream can read substring / spelling-variant / CJK
  // matches without conflating them with word-level porter/exact ranks.
  readonly trigramFtsRanks: Readonly<Record<string, number>>;
  readonly synthesisFtsRanks: Readonly<Record<string, number>>;
  readonly evidenceFtsRanks: Readonly<Record<string, number>>;
  readonly sourceProximityScores: Readonly<Record<string, number>>;
  readonly sourceCohortKeys: Readonly<Record<string, string>>;
  readonly structuralScores: Readonly<Record<string, number>>;
  readonly graphExpansionScores: Readonly<Record<string, number>>;
  // see also: collectEntityDerivedSeeds — per-memory entity_seed plane score
  // produced from the FTS rank of the strongest entity surface that hit.
  readonly entitySeedScores: Readonly<Record<string, number>>;
  readonly pathExpansionScores: Readonly<Record<string, number>>;
  // Active sign-aware suppression deltas keyed by target memory id. A positive
  // value is subtracted from that memory's fused recall score before final
  // ranking, demoting targets that a reinforced negative path (recall_bias < 0)
  // suppresses. Empty when no negative path anchored on an expansion seed.
  // see also: recall-service.ts collectNegativePathSuppressions /
  // applyPathSuppressionToFusionScores.
  readonly pathSuppressionScores: Readonly<Record<string, number>>;
  readonly embeddingSimilarityScores: Readonly<Record<string, number>>;
  readonly graphSupportCounts: Readonly<Record<string, number>>;
  readonly budgetPenaltyFactor: number;
  readonly plasticityFactors: Readonly<Record<string, number>>;
  readonly graphAndPathColdScore: number;
  readonly recallsEdgeCount: number;
  readonly weightTransferAmount: number;
  // Evidence capsule `gist` text keyed by memory_entry.object_id, populated
  // when an evidence FTS hit resolved the candidate into the pool. The
  // feature rerank reads this so a query whose answer-bearing semantics live
  // in the evidence paraphrase (not the distilled content) can still be
  // promoted. Absent / empty string → rerank falls back to content-only,
  // bit-identical to the pre-B2 behavior.
  readonly evidenceGistsByMemoryId: Readonly<Record<string, string>>;
  // invariant: governance ceiling on recall manifestation, keyed by
  // memory_entry.object_id. Derived from each candidate's inbound
  // recall-eligible PathRelations (isPathRecallEligible) via
  // memoryGovernanceCeiling. The fine-assess clamp lowers a candidate's
  // strength tier to this ceiling (never elevates). A memory with no governing
  // inbound path is ABSENT from this map; the clamp site defaults it to
  // full_eligible (unrestricted). see also: path-manifestation-policy.ts
  // memoryGovernanceCeiling / clampManifestationByGovernance,
  // recall-candidate-builder.ts buildRecallCandidate.
  readonly governanceCeilingByMemoryId: Readonly<Record<string, ManifestationState>>;
}

export interface CoarseRecallCandidate {
  readonly entry: Readonly<MemoryEntry>;
  readonly isAdvisory?: boolean;
  readonly originPlane?: RecallOriginPlane;
  readonly sourceChannel?: string;
  readonly sourceChannels?: readonly string[];
  readonly admissionPlanes?: readonly RecallAdmissionPlane[];
  readonly firstAdmissionPlane?: RecallAdmissionPlane;
  readonly structuralScore?: number;
  readonly scoreMultiplier?: number;
  readonly pathExpansionSources?: readonly RecallPathExpansionSourceDiagnostic[];
  // invariant: true when this candidate was admitted on the path_expansion plane
  // by traversing an EARNED `co_recalled` PathRelation — the R1 sparse durable
  // fan-in carrier (path-relation-proposal-service.ts CO_RECALLED_SEED_PROFILE,
  // minted only after the threshold-3 co-usage counter gate). Gold-blind: it
  // reads the path's earned relation_kind, never a gold label. The structural
  // delivery reserve consumes this as the bounded exemption that lets a
  // zero-relevance earned fan-in sibling claim a reserve slot (the multi-session
  // fan-in mechanism) WITHOUT re-opening displacement to generic structural
  // distractors. Internal-only: it never reaches the emitted RecallDiagnostics
  // / bench path_expansion_sources surface.
  // see also: packages/core/src/recall/fusion-delivery.ts:isStructuralRescueCandidate,
  //   path-relation-proposal-service.ts (co_recalled accrual gate).
  readonly reachedViaEarnedCoRecalledFanin?: boolean;
  // Set to "synthesis_capsule" when the candidate is sourced from an L2
  // synthesis row rather than an L1 memory_entry. The `entry` is then a
  // synthesis-shaped pseudo memory carrying the synthesis summary as content.
  readonly objectKind?: RecallCandidate["object_kind"];
}

export interface RecallServiceWarnPort {
  (message: string, meta: Record<string, unknown>): void;
}

export type { SoulRecallHostContext };
export type { RecallCandidate } from "@do-soul/alaya-protocol";
