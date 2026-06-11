import { randomUUID } from "node:crypto";
import {
  ControlPlaneObjectKind,
  DYNAMICS_CONSTANTS,
  EDGE_TYPE_RECALL_MODEL,
  RecallContextEventType,
  RetentionPolicy,
  SoulRecallCompletedPayloadSchema,
  SoulRecallWeightTransferPayloadSchema,
  StorageTier,
  isPathActiveForRecall,
  isPathGovernedForSuppression,
  isPathRecallEligible,
  type FineAssessmentConfig,
  type ActivationWeights,
  type ManifestationState,
  type MemoryDimension as MemoryDimensionType,
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
import {
  buildRecallCandidate,
  buildSynthesisCoarseRecallCandidate
} from "./recall-candidate-builder.js";
import { computeFreshnessFactor } from "./dynamics-constants-runtime.js";
import { STRATEGY_RECALL_DEFAULTS, type NodeStrategy } from "./task-surface-builder.js";
import {
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
  RecallGraphExpansionDiagnostics,
  RecallGraphExpansionTrackedEdgeType,
  RecallMultiSeedGraphFanInDiagnostics,
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
  RECALL_FUSION_STREAMS,
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
export { RECALL_FUSION_STREAMS, recallDeliveryReserveTestInternals } from "./recall/fusion-delivery.js";

const DYNAMIC_RECALL_PLANE_CAP = 240;
const DYNAMIC_RECALL_TOTAL_CANDIDATE_CAP = 1000;
const DYNAMIC_RECALL_SEED_CAP = 50;
// anchor: entity_seed caps. The per-entity ceiling keeps a single common
// surface (e.g. "config") from flooding the plane; total admit caps
// bound the FTS-call fan-out per recall.
const ENTITY_EXTRACTION_MAX_ENTITIES = 8;
const ENTITY_SEED_PER_ENTITY_TOP_K_STRONG = 8;
const ENTITY_SEED_PER_ENTITY_TOP_K_WEAK = 5;
const ENTITY_SEED_TOTAL_ADMIT_CAP = 60;
const ENTITY_SEED_MIN_SURFACE_LENGTH = 2;
// anchor: entity-derived graph_expansion seeding floor. Only entities whose
// extractor confidence meets this threshold are allowed to fan their FTS
// hits into graph_expansion seeds. The 0.85 cut admits quoted / code_ref /
// path / package / task_ref signals (1.0 / 0.95 / 0.9 / 0.9 / 0.85) and
// excludes proper_noun (0.7), cjk_phrase (0.6), and unknown_long (0.35).
// see also: packages/core/src/entity-extraction-rules.ts CONFIDENCE_*
const ENTITY_GRAPH_EXPANSION_CONFIDENCE_FLOOR = 0.85;
const DYNAMIC_RECALL_COHORT_RADIUS = 8;
const DYNAMIC_RECALL_SOURCE_PROXIMITY_RADIUS = 6;
const DYNAMIC_RECALL_SOURCE_PROXIMITY_SEED_CAP = 12;
const DYNAMIC_RECALL_SOURCE_PROXIMITY_ADMISSION_CAP = 120;
const DYNAMIC_RECALL_SOURCE_PROXIMITY_ADMISSION_BUDGET_MULTIPLIER = 4;
const DYNAMIC_RECALL_SOURCE_PROXIMITY_NEIGHBORS_PER_SEED = 8;
const SOURCE_PROXIMITY_STRUCTURAL_CARRY_MAX = 0.25;
const DYNAMIC_RECALL_EDGE_FANOUT = 12;
const MAX_GRAPH_HOPS = 2;
// anchor: shared cap for entity_seed fan-in. Reuses DYNAMIC_RECALL_PLANE_CAP
// so the per-plane admit ceiling is the structural truth and the multi-seed
// path inherits the same bound. see also: DYNAMIC_RECALL_PLANE_CAP
const MULTI_SEED_GRAPH_FAN_OUT_CAP = DYNAMIC_RECALL_PLANE_CAP;
// invariant: membership equals EDGE_TYPE_RECALL_MODEL transitive rows
// (membership asserted in edge-hop-decay-derivation.test.ts; order asserted
// in recall-service.test.ts). order is load-bearing — indexOf here drives the
// edge_type tie-break, so the array stays explicit rather than derived from
// declaration order.
// see also: shouldReplaceGraphExpansionCandidate, compareGraphExpansionCandidateDrafts
const GRAPH_EXPANSION_TRACKED_EDGE_TYPES: readonly RecallGraphExpansionTrackedEdgeType[] = [
  "derives_from",
  "recalls",
  "supports"
];
// Derived view of EDGE_TYPE_RECALL_MODEL.hop_decay restricted to the
// transitive rows; only read at hop >= 2 in expandGraph.
const EDGE_TYPE_HOP_DECAY: Readonly<Record<RecallGraphExpansionTrackedEdgeType, number>> = Object.freeze(
  Object.fromEntries(
    GRAPH_EXPANSION_TRACKED_EDGE_TYPES.map((edgeType) => {
      const decay = EDGE_TYPE_RECALL_MODEL[edgeType].hop_decay;
      if (decay === null) {
        throw new Error(`graph-expansion tracked edge_type "${edgeType}" has null hop_decay in EDGE_TYPE_RECALL_MODEL`);
      }
      return [edgeType, decay];
    })
  ) as Record<RecallGraphExpansionTrackedEdgeType, number>
);
// invariant: path-graph traversal reads PathRelation rows (the single
// associative plane) instead of memory_graph_edges. A path's
// constitution.relation_kind is a free string, so traversal scoring maps it
// back onto the EDGE_TYPE_RECALL_MODEL contribution_weight / hop_decay basis
// when the kind names a transitive edge type (supports / derives_from /
// recalls). Path-only associative kinds (co_recalled / shares_entity /
// signal_graph_ref) have no edge-type row; they are treated as recalls-tier
// associations (contribution 0.3, hop_decay 0.3) — the weakest positive
// associative band — so they propagate at most one extra hop without
// over-amplifying. Negative / neutral kinds never reach this map because the
// traversal only follows isPathRecallEligible (recall_bias > 0) paths.
// see also: packages/protocol/src/soul/memory-graph.ts EDGE_TYPE_RECALL_MODEL
// see also: packages/core/src/path-relation-proposal-service.ts seed catalog
const PATH_ASSOCIATIVE_RELATION_KIND_FALLBACK: RecallGraphExpansionTrackedEdgeType = "recalls";
// invariant: the earned multi-session fan-in carrier relation_kind. Mirrors
// path-relation-proposal-service.ts CO_RECALLED_SEED_PROFILE.relationKind — the
// R1 path the co-usage counter mints ONLY after the threshold-3 gate (sparse,
// bounded). A path_expansion admission traversing this kind is the durable
// fan-in route Route 乙 depends on, so the structural delivery reserve grants it
// a gold-blind, earned exemption from the relevance gate (a zero-relevance
// earned sibling is the intended fan-in target, not a distractor). Any OTHER
// relation_kind (generic structural / session membership) stays relevance-gated.
const EARNED_CO_RECALLED_FANIN_RELATION_KIND = "co_recalled";
// Maps a path's free-string relation_kind onto the tracked transitive
// edge-type set used for graph-traversal scoring and the per-edge-type
// diagnostic. Unmapped associative kinds fold onto the recalls tier so the
// {derives_from, recalls, supports} diagnostic key set (consumed by the
// bench-runner zod schema) is preserved without inventing a new key.
function pathRelationKindToTrackedEdgeType(
  relationKind: string
): RecallGraphExpansionTrackedEdgeType {
  return GRAPH_EXPANSION_TRACKED_EDGE_TYPES.includes(relationKind as RecallGraphExpansionTrackedEdgeType)
    ? (relationKind as RecallGraphExpansionTrackedEdgeType)
    : PATH_ASSOCIATIVE_RELATION_KIND_FALLBACK;
}
// Active sign-aware suppression scale. A negative path (recall_bias < 0)
// demotes its target's fused recall score by
//   delta = |recall_bias| * f(strength) * PATH_SUPPRESSION_SCALE
// where f(strength) is the path's plasticity strength in [0, 1] (an
// attention_only co-occurrence sits near 0.5; a plasticity-reinforced
// contradiction climbs toward 0.9-1.0). PATH_SUPPRESSION_SCALE is the only
// magnitude tuned by intent here, and it is set so the gate is strength-aware
// rather than benchmark-fitted (no-benchmark-specific-patch):
//   - fused_score contributions are RRF terms ~weight/(k+rank), so a single
//     mid-table stream contributes on the order of 0.01-0.05 and a strong
//     multi-stream memory totals ~0.1-0.3.
//   - a weak attention_only negative (|bias|~0.4, strength~0.5) yields
//     delta ~ 0.4 * 0.5 * 0.5 = 0.10 ... too aggressive, so the strength gate
//     below floors weak/forming paths out of suppression entirely and only
//     stable/pinned high-strength negatives apply the full delta.
// The strength gate (PATH_SUPPRESSION_STRENGTH_FLOOR) makes "weak attention_only
// barely suppresses" literal: below the floor delta collapses to 0; at/above it
// scales linearly so a reinforced contradiction (strength ~0.9) lands
// delta ~ 0.4 * 0.9 * 0.6 = 0.216, enough to push a target out of a tight
// top-K, while a freshly-seeded weak negative does not move rankings.
const PATH_SUPPRESSION_SCALE = 0.6;
// invariant: strength below this floor contributes no suppression. Matches the
// attention_only seed band (initial strength 0.3-0.5 for co-occurrence-class
// paths) so a barely-formed negative association cannot demote a memory until
// plasticity has reinforced it past the floor. see also:
// path-relation-proposal-service.ts seed catalog (initialStrength per family).
const PATH_SUPPRESSION_STRENGTH_FLOOR = 0.6;
// invariant: hard ceiling on the total suppression delta any single target may
// accumulate, across all converging negative paths. Sized to one supersedes-class
// negative at full reinforcement: |recall_bias 0.5| * strength 0.9 *
// PATH_SUPPRESSION_SCALE 0.6 = 0.27, so a lone reinforced supersession can
// demote a target out of a tight top-K but stacked negatives can never exceed
// the worst single legitimate suppression. This bounds the accumulated delta
// (rank loss). The per-target cap limits the DELTA, not the residual score: a
// single full-strength negative whose target had a low base fused_score
// (< 0.27) could still drive that target's fused_score to 0 via one subtraction
// and drop it out of the candidate set. PATH_SUPPRESSION_RESIDUAL_FLOOR (below)
// is the residual-side guard that demotes, never erases.
// see also: collectNegativePathSuppressions, PATH_SUPPRESSION_SCALE rationale,
// PATH_SUPPRESSION_RESIDUAL_FLOOR.
const PATH_SUPPRESSION_MAX_PER_TARGET = 0.27;
const RECALLS_EDGE_COLD_THRESHOLD = 50;
// Injected pool-external semantic neighbors must clear this query cosine floor
// AND are hard-capped, so the semantic facet never floods delivery with
// low-relevance distractors (the embedding-on<off regression cause).
const EMBEDDING_INJECTION_SIMILARITY_FLOOR = 0.5;
const EMBEDDING_MAX_INJECTED_DELIVERY = 2;
const NO_EMBEDDING_RELEVANCE_DIRECT_WEIGHT = 0.24;
const QUERY_EVIDENCE_BASE_TRANSFER_MAX = 0.25;
const QUERY_EVIDENCE_BASE_WEIGHT_FLOOR = 0.35;
// Expanded-query lexical hits (morphology / synonym variants) are admitted at
// this fraction of their raw fts rank so an inflected-only match cannot
// out-RRF a memory that matched the original query surface terms.
const EXPANDED_QUERY_RANK_DISCOUNT = 0.6;
// invariant: confidence sub-weight is additive (outside sum-to-1
// activation_weights). MemoryEntry.confidence is propose/accept-updated
// epistemic certainty; reading it directly here keeps later confidence
// edits visible to recall ordering without waiting for retention decay
// or activation rescore. Final score stays clamp01.
const CONFIDENCE_DIRECT_WEIGHT = 0.08;
// invariant: prior dampening floor — minimum weight applied to the
// prior signal when calibrating weak-evidence candidates so that
// prior-only activation/confidence MUST NOT make weak query evidence
// look answer-confident. Intentionally a SEPARATE constant from the
// calibration gate below so each purpose can be tuned independently
// without silently shifting the other.
const WEAK_EVIDENCE_PRIOR_DAMPENING_FLOOR = 0.72;
// invariant: calibration gate threshold — calibration only fires when
// queryEvidenceCalibrationStrength is BELOW this floor; at-or-above
// evidence is treated as sufficient and the score shape is preserved.
// Matches WEAK_EVIDENCE_PRIOR_DAMPENING_FLOOR by initial design intent
// but is intentionally a separate constant to keep each purpose tunable.
const WEAK_EVIDENCE_CALIBRATION_GATE = 0.72;

interface CoarseCandidateDraft {
  readonly entry: Readonly<MemoryEntry>;
  readonly admissionPlanes: readonly RecallAdmissionPlane[];
  readonly firstAdmissionPlane: RecallAdmissionPlane;
  readonly sourceChannels: readonly string[];
  readonly structuralScore: number;
  readonly pathExpansionSources: readonly RecallPathExpansionSourceDiagnostic[];
  // invariant: the strongest entity-extractor confidence (0..1) observed when
  // this draft was admitted via the entity_seed plane; undefined when no
  // entity_seed admission has occurred. selectExpansionSeedDrafts uses this
  // to gate entity-only drafts out of graph_expansion fan-in when the entity
  // confidence falls below ENTITY_GRAPH_EXPANSION_CONFIDENCE_FLOOR.
  // see also: collectEntityDerivedSeeds (graph_expansion seed extraSeedMemoryIds path)
  readonly entityConfidence?: number;
  // invariant: sticky-true once this draft is admitted on the path_expansion
  // plane via an EARNED `co_recalled` PathRelation (relation_kind === COG). This
  // is the R1 sparse durable fan-in carrier; the structural delivery reserve
  // reads it as the bounded exemption that admits a zero-relevance earned fan-in
  // sibling without re-opening displacement to generic structural distractors.
  // Gold-blind. see also: isStructuralRescueCandidate, addCandidate.
  readonly reachedViaEarnedCoRecalledFanin?: boolean;
}

interface SourceProximitySeedDraft {
  readonly draft: Readonly<CoarseCandidateDraft>;
  readonly strength: number;
}

interface MutableGraphExpansionDiagnostics {
  readonly graph_expansion_plane_count_per_hop: [number, number];
  readonly graph_expansion_plane_count_per_edge_type: Record<RecallGraphExpansionTrackedEdgeType, number>;
  // invariant: 0 = pooled-seed only; 1+ = entity_seed fan-in ran.
  // see also: addGraphExpansionCandidates multi-seed branch
  multi_seed_fan_in_distinct_seeds: number;
  // anchor: dedup_collisions counts every collision (not unique colliders);
  // max-score reduction keeps one candidate.
  multi_seed_fan_in_dedup_collisions: number;
  // anchor: per-seed candidate counts (post-dedup, pre-cap) consumed by
  // freezeGraphExpansionDiagnostics to derive p50 / p95.
  readonly multi_seed_fan_in_candidates_per_seed: number[];
}

interface GraphExpansionFrontierNode {
  readonly memoryId: string;
  readonly pathScore: number;
  // The raw relation_kind traversed to REACH this node (null for seed roots).
  // hop >= 2 admission drops a neighbor reached by this same relation_kind to gate
  // single-relation lineage walks that would otherwise flood the candidate pool.
  // Keyed on the raw relation_kind, not the folded tracked edge_type, so
  // heterogeneous associative reach (e.g. co_recalled -> shares_entity) survives.
  readonly arrivalRelationKind: string | null;
}

interface GraphExpansionCandidateDraft {
  readonly entry: Readonly<MemoryEntry>;
  readonly score: number;
  readonly hop: 1 | 2;
  readonly edgeType: RecallGraphExpansionTrackedEdgeType;
}

interface GraphExpansionCandidateSourceDiagnostic {
  readonly hop: 1 | 2;
  readonly edgeType: RecallGraphExpansionTrackedEdgeType;
}

interface GraphExpansionCandidatesResult {
  readonly diagnostics: Readonly<RecallGraphExpansionDiagnostics>;
  readonly candidateSources: ReadonlyMap<string, Readonly<GraphExpansionCandidateSourceDiagnostic>>;
}

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
    const synthesisCoarseFilter = await this.collectSynthesisCoarseCandidates({
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
    const embeddingCoarseInjection = await this.collectEmbeddingCoarseInjection({
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
    // see also: collectEvidenceGistsByMemoryId
    readonly evidenceFtsRanksPerRef: Readonly<Record<string, number>>;
    readonly sourceProximityScores: Readonly<Record<string, number>>;
    readonly sourceCohortKeys: Readonly<Record<string, string>>;
    readonly structuralScores: Readonly<Record<string, number>>;
    readonly graphExpansionScores: Readonly<Record<string, number>>;
    readonly graphExpansionDiagnostics: Readonly<RecallGraphExpansionDiagnostics>;
    readonly graphExpansionCandidateSources: ReadonlyMap<string, Readonly<GraphExpansionCandidateSourceDiagnostic>>;
    // see also: collectEntityDerivedSeeds — entity_seed plane score by memory id.
    readonly entitySeedScores: Readonly<Record<string, number>>;
    readonly pathExpansionScores: Readonly<Record<string, number>>;
    // Negative-path active suppression deltas keyed by target memory id.
    // see also: collectNegativePathSuppressions, applyPathSuppressionToFusionScores.
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
    // see also: collectEvidenceGistsByMemoryId — picks best-rank ref via
    // this per-ref map; the aggregated evidenceFtsRanks loses ref identity.
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
    // see also: collectNegativePathSuppressions, applyPathSuppressionToFusionScores.
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
      // with undefined. see also: selectExpansionSeedDrafts entity-only floor.
      const nextEntityConfidence =
        plane === "entity_seed" && entityConfidence !== undefined
          ? Math.max(current?.entityConfidence ?? 0, entityConfidence)
          : current?.entityConfidence;
      // invariant: sticky-OR. Once a co_recalled fan-in admission marks this
      // memory id, no later plane admission (lexical / activation / structural)
      // can clear the earned-fan-in provenance, so a sibling reached via the R1
      // carrier keeps its reserve exemption even when it also picks up a generic
      // structural co-admission. see also: isStructuralRescueCandidate.
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
    // visited). see also: addGraphExpansionCandidates skip-path-admitted guard.
    // Snapshot the Pool A draft seeds before path_expansion runs. Once
    // path_expansion admits a direct hop-1 neighbor, that neighbor becomes a
    // draft carrying the path_expansion plane and would otherwise qualify as a
    // graph BFS seed — collapsing genuine hop-2 reach into hop-1 and rooting
    // traversal at path-reached nodes rather than query anchors. Pinning the
    // seed set to the pre-path drafts keeps hop semantics stable across the
    // ordering change. see also: addGraphExpansionCandidates draftSeedIds.
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
    // see also: collectEntityDerivedSeeds — entity-bearing memory ids fan
    // into graph_expansion as additional seeds so the graph plane is reachable
    // even when the query never hits a prior expansion seed.
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
    // see also: collectEntityDerivedSeeds (entity-derived seed source)
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
  // see also: addGraphExpansionCandidates (Pool A / Pool B)
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
        // fan-in via the path-1 (selectExpansionSeedDrafts) seed pool.
        // see also: selectExpansionSeedDrafts ENTITY_GRAPH_EXPANSION_CONFIDENCE_FLOOR
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
  // see also: applyPathSuppressionToFusionScores, scorePathRelationSuppression.
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
        // PATH_SUPPRESSION_MAX_PER_TARGET so converging negatives compound up to
        // one reinforced-supersession delta but never gang into erasure.
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
    const weightTransferAmount = this.computeMaxWeightTransferAmount(
      params.candidates,
      params.policy,
      graphAndPathColdScore
    );

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

  /**
   * Embedding-on coarse-injection path. Lexical coarse filtering admits only
   * memories that match deterministic / FTS / precomputed-rank predicates, so
   * a semantically relevant memory with zero lexical overlap never enters the
   * candidate pool. When the embedding_enabled gate is true this fetches the
   * top-K workspace cosine neighbors, resolves them into MemoryEntry coarse
   * candidates tagged with the semantic_supplement source channel, and returns
   * their similarity scores for the embedding_similarity fusion stream.
   *
   * invariant: returns an empty injection whenever the gate is false, so the
   * embedding-off recall path is unchanged at the bit level.
   */
  private async collectEmbeddingCoarseInjection(params: {
    readonly policy: Readonly<RecallPolicy>;
    readonly workspaceId: string;
    readonly runId: string | null;
    readonly queryText: string | null;
    readonly poolCandidates: readonly Readonly<CoarseRecallCandidate>[];
  }): Promise<Readonly<{
    readonly candidates: readonly Readonly<CoarseRecallCandidate>[];
    readonly similarityScores: Readonly<Record<string, number>>;
    readonly embeddingInferenceCalls: number;
  }>> {
    const empty = Object.freeze({
      candidates: Object.freeze([]) as readonly Readonly<CoarseRecallCandidate>[],
      similarityScores: Object.freeze({}),
      embeddingInferenceCalls: 0
    });
    const embeddingRecallService = this.dependencies.embeddingRecallService;
    const maxSupplement = params.policy.coarse_filter.semantic_supplement.max_supplement;
    if (
      params.policy.coarse_filter.semantic_supplement.embedding_enabled !== true ||
      maxSupplement <= 0 ||
      params.queryText === null ||
      embeddingRecallService === undefined ||
      (typeof embeddingRecallService.collectWorkspaceNeighbors !== "function" &&
        typeof embeddingRecallService.collectWorkspaceNeighborsWithMetadata !== "function") ||
      typeof this.dependencies.memoryRepo.findByIds !== "function"
    ) {
      return empty;
    }

    const poolObjectIds = params.poolCandidates.map((candidate) => candidate.entry.object_id);
    const neighborResult =
      typeof embeddingRecallService.collectWorkspaceNeighborsWithMetadata === "function"
        ? await embeddingRecallService.collectWorkspaceNeighborsWithMetadata({
            workspaceId: params.workspaceId,
            runId: params.runId,
            queryText: params.queryText,
            excludeObjectIds: poolObjectIds,
            maxNeighbors: maxSupplement
          })
        : {
            hits: await embeddingRecallService.collectWorkspaceNeighbors!({
              workspaceId: params.workspaceId,
              runId: params.runId,
              queryText: params.queryText,
              excludeObjectIds: poolObjectIds,
              maxNeighbors: maxSupplement
            }),
            embedding_inference_calls: 0,
            query_embedding_cache_hit: true
          };
    const neighbors = neighborResult.hits;
    if (neighbors.length === 0) {
      return Object.freeze({
        ...empty,
        embeddingInferenceCalls: neighborResult.embedding_inference_calls
      });
    }

    const similarityByObjectId = new Map(
      neighbors.map((neighbor) => [neighbor.object_id, neighbor.normalized_similarity] as const)
    );
    let neighborEntries: readonly Readonly<MemoryEntry>[];
    try {
      neighborEntries = await this.dependencies.memoryRepo.findByIds([...similarityByObjectId.keys()]);
    } catch (error) {
      this.warn("embedding coarse injection lookup failed", {
        workspace_id: params.workspaceId,
        run_id: params.runId,
        error: toErrorMessage(error)
      });
      return Object.freeze({
        ...empty,
        embeddingInferenceCalls: neighborResult.embedding_inference_calls
      });
    }

    const poolObjectIdSet = new Set(poolObjectIds);
    // Gate the injected neighbors on the query cosine floor and hard-cap the
    // count: the semantic facet contributes at most EMBEDDING_MAX_INJECTED_DELIVERY
    // pool-external objects, each clearing EMBEDDING_INJECTION_SIMILARITY_FLOOR.
    // The cosine floor IS the relevance gate — these are pure-semantic objects
    // with zero lexical overlap, so no lexical/deterministic filter applies.
    const candidates = neighborEntries
      .filter(
        (entry) =>
          entry.workspace_id === params.workspaceId &&
          !poolObjectIdSet.has(entry.object_id) &&
          (similarityByObjectId.get(entry.object_id) ?? 0) >=
            EMBEDDING_INJECTION_SIMILARITY_FLOOR
      )
      .sort(
        (left, right) =>
          (similarityByObjectId.get(right.object_id) ?? 0) -
          (similarityByObjectId.get(left.object_id) ?? 0)
      )
      .slice(0, EMBEDDING_MAX_INJECTED_DELIVERY)
      .map((entry) =>
        Object.freeze({
          entry,
          originPlane: "workspace_local" as const,
          sourceChannel: "semantic_supplement",
          sourceChannels: Object.freeze(["semantic_supplement"]),
          admissionPlanes: Object.freeze(["semantic_supplement" as const]),
          firstAdmissionPlane: "semantic_supplement" as const,
          structuralScore: 0
        })
    ) as readonly Readonly<CoarseRecallCandidate>[];
    if (candidates.length === 0) {
      return Object.freeze({
        ...empty,
        embeddingInferenceCalls: neighborResult.embedding_inference_calls
      });
    }

    const similarityScores = Object.fromEntries(
      candidates.map((candidate) => [
        candidate.entry.object_id,
        similarityByObjectId.get(candidate.entry.object_id) ?? 0
      ] as const)
    );
    return Object.freeze({
      candidates: Object.freeze([...candidates]),
      similarityScores: Object.freeze(similarityScores),
      embeddingInferenceCalls: neighborResult.embedding_inference_calls
    });
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
    // invariant: freshness is counted ONCE. The stored activation_score
    // already bakes a freshness sub-term (weight
    // activation_weights_phase1b.freshness, computed at store time). Multiplying
    // the whole composite by a read-time freshness factor double-counts
    // freshness and wrongly decays the scope/domain/retention sub-terms. Instead
    // decay only the freshness band: the non-freshness floor (stored minus at-most the
    // freshness weight) is preserved, and the freshness band is re-weighted by
    // the read-time factor. last_used_at is the "last reinforced" proxy; created_at
    // floors a never-used memory's age at birth. Bounded: the result is <= stored
    // and at full idle collapses ONLY the <=0.19 freshness contribution (plus the
    // legitimate idle decay), never the whole composite. Only memory entries carry
    // these timestamps, so leave global/synthesis activation un-decayed.
    const storedActivationScore = normalizeActivationScore(entry.activation_score);
    const shouldTimeDecay =
      canUseMemorySupplement && typeof entry.created_at === "string" && entry.created_at.length > 0;
    const freshnessFactorNow = shouldTimeDecay
      ? computeFreshnessFactor({
          lastUsedAt: entry.last_used_at ?? null,
          createdAt: entry.created_at,
          now: this.now()
        })
      : 1;
    const freshnessWeight = DYNAMICS_CONSTANTS.activation_weights_phase1b.freshness;
    const nonFreshnessFloor = Math.max(0, storedActivationScore - freshnessWeight);
    const activationScore = shouldTimeDecay
      ? Math.min(storedActivationScore, clamp01(nonFreshnessFloor + freshnessWeight * freshnessFactorNow))
      : storedActivationScore;
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
    const queryEvidenceCalibrationStrength = Math.max(
      relevanceFactor,
      graphSupportFactor,
      embeddingSimilarityFactor
    );
    // invariant: calibration only fires when query-grounded evidence is
    // BELOW WEAK_EVIDENCE_CALIBRATION_GATE. At-or-above the gate evidence
    // is treated as sufficient and the score shape is preserved. A prior-side
    // signal (plasticity / confidence) must also be present; without one
    // there is no prior term to dampen.
    const shouldCalibrateWeakEvidence =
      queryEvidenceCalibrationStrength < WEAK_EVIDENCE_CALIBRATION_GATE &&
      (plasticityFactor > 0 || (confidenceFactor > 0 && queryEvidenceCalibrationStrength > 0));
    const evidenceContributionCalibration = shouldCalibrateWeakEvidence
      ? queryEvidenceCalibrationStrength
      : 1;
    const priorEvidenceCalibration =
      shouldCalibrateWeakEvidence
        ? WEAK_EVIDENCE_PRIOR_DAMPENING_FLOOR +
          (1 - WEAK_EVIDENCE_PRIOR_DAMPENING_FLOOR) * queryEvidenceCalibrationStrength
        : 1;
    const calibratedRelevanceFactor = relevanceFactor * evidenceContributionCalibration;
    const effectiveRelevanceWeight =
      (weights.relevance +
        additiveWeights.NO_EMBEDDING_RELEVANCE_DIRECT_WEIGHT +
        queryEvidenceTransfer) *
      evidenceContributionCalibration;
    const adjustedBaseWeight = Math.max(0, baseWeight - queryEvidenceTransfer) * priorEvidenceCalibration;
    const weightedActivation = activationScore * adjustedBaseWeight;
    const weightedRelevance = calibratedRelevanceFactor * weights.relevance;
    const weightedRelevanceDirect =
      calibratedRelevanceFactor * additiveWeights.NO_EMBEDDING_RELEVANCE_DIRECT_WEIGHT;
    const weightedQueryEvidenceTransfer = calibratedRelevanceFactor * queryEvidenceTransfer;
    const weightedGraphSupport = graphSupportFactor * weights.graph_support;
    // Embedding adds no flat additive term here: its signal enters exactly once
    // through the rank-bounded `embedding_similarity` RRF stream, and the facet
    // additionally modulates path/graph firing (boost-only, see
    // buildRecallFusionDetails). The `embeddingSimilarityFactor` is retained only
    // as the `embedding_similarity` diagnostic factor below — it no longer
    // double-counts into rawScore.
    const weightedPathPlasticity = plasticityFactor * pathPlasticityWeight;
    const weightedConfidence =
      confidenceFactor * additiveWeights.CONFIDENCE_DIRECT_WEIGHT * priorEvidenceCalibration;
    const weightedBudgetPenalty = budgetPenalty * weights.budget_penalty;
    const weightedConflictPenalty = conflictPenalty * weights.conflict_penalty;

    const rawScore = clamp01(
      weightedActivation +
        weightedRelevance +
        weightedRelevanceDirect +
        weightedQueryEvidenceTransfer +
        weightedGraphSupport +
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
        effective_relevance_weight: effectiveRelevanceWeight,
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


function buildRecallDiagnostics(params: Readonly<{
  readonly queryProbes: Readonly<RecallQueryProbes>;
  readonly totalScanned: number;
  readonly candidatePoolCount: number;
  readonly preBudgetCount: number;
  readonly deliveredCount: number;
  readonly embeddingProviderStatus: RecallEmbeddingProviderStatus;
  readonly providerDegradationReason: string | null;
  readonly graphExpansionDiagnostics: Readonly<RecallGraphExpansionDiagnostics>;
  readonly candidates: readonly Readonly<RecallCandidateDiagnostic>[];
  readonly tokenEconomy: Readonly<RecallTokenEconomy>;
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
      expanded_terms: Object.freeze([...params.queryProbes.expanded_terms]),
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
    graph_expansion_plane_count_per_hop:
      params.graphExpansionDiagnostics.graph_expansion_plane_count_per_hop,
    graph_expansion_plane_count_per_edge_type:
      params.graphExpansionDiagnostics.graph_expansion_plane_count_per_edge_type,
    ...(params.graphExpansionDiagnostics.multi_seed_graph_fan_in === undefined
      ? {}
      : { multi_seed_graph_fan_in: params.graphExpansionDiagnostics.multi_seed_graph_fan_in }),
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
    candidates: Object.freeze([...params.candidates]),
    token_economy: params.tokenEconomy
  });
}

/**
 * Pure derivation of per-recall token economy from already-computed recall
 * state. Synchronous, allocation-light, and never widens the diagnostics
 * surface beyond integer counters and the existing token_estimate sum.
 *
 * @anchor compute-recall-token-economy: every figure must be derivable
 * from data already produced for the recall result. Adding a field that
 * needs new traversal of the corpus would push instrumentation past the
 * "no measurable latency budget impact" red line of phase 7.
 *
 * Exported only so the recall-service test suite can pin the latency
 * contract (O-1 regression: nested per-stream/per-candidate scan stays
 * sub-50µs even at the worst-case bench cardinality). Production callers
 * still go through RecallService.recall — there is no separate runtime
 * entry point.
 */
export function computeRecallTokenEconomy(params: Readonly<{
  readonly deliveredCandidates: readonly Readonly<RecallCandidate>[];
  readonly coarsePoolSize: number;
  readonly fineEvaluated: number;
  readonly preBudgetCandidates: readonly Readonly<RecallCandidateDiagnostic>[];
  readonly embeddingInferenceCalls: number;
}>): Readonly<RecallTokenEconomy> {
  let deliveredContextTokensEstimate = 0;
  for (const candidate of params.deliveredCandidates) {
    deliveredContextTokensEstimate += candidate.token_estimate;
  }
  // Count distinct fusion streams that produced at least one non-null
  // rank across the pre-budget candidate set. Iterates over the typed
  // RECALL_FUSION_STREAMS list so the count tracks the protocol's
  // fusion-stream surface, not an ad-hoc subset.
  let fusionStreamsWithHits = 0;
  for (const stream of RECALL_FUSION_STREAMS) {
    const hit = params.preBudgetCandidates.some(
      (candidate) => candidate.per_stream_rank[stream] !== null
    );
    if (hit) {
      fusionStreamsWithHits += 1;
    }
  }
  return Object.freeze({
    delivered_context_tokens_estimate: deliveredContextTokensEstimate,
    coarse_pool_size: params.coarsePoolSize,
    fine_evaluated: params.fineEvaluated,
    fusion_streams_with_hits: fusionStreamsWithHits,
    embedding_inference_calls: Math.max(0, Math.trunc(params.embeddingInferenceCalls))
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
  hintsByObjectId: EmbeddingRecallSupplementResult["similarityHintsByObjectId"],
  injectedSimilarityScores: Readonly<Record<string, number>>
): RecallSupplementaryData {
  const merged = new Map<string, number>();
  for (const [objectId, hint] of Object.entries(hintsByObjectId)) {
    const score = clamp01(hint.normalized_similarity);
    if (score > 0) {
      merged.set(objectId, Math.max(merged.get(objectId) ?? 0, score));
    }
  }
  for (const [objectId, rawScore] of Object.entries(injectedSimilarityScores)) {
    const score = clamp01(rawScore);
    if (score > 0) {
      merged.set(objectId, Math.max(merged.get(objectId) ?? 0, score));
    }
  }
  if (merged.size === 0) {
    return supplementaryData;
  }

  return Object.freeze({
    ...supplementaryData,
    embeddingSimilarityScores: Object.freeze(Object.fromEntries(merged))
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
  const expandedKeyQuery = queryProbes.expanded_terms.slice(0, 8).join(" ");
  const dateQueries = queryProbes.date_terms.slice(0, 6);
  return uniqueStrings([
    queryText,
    ...phraseQueries,
    ...(multiKeyQuery.length === 0 ? [] : [multiKeyQuery]),
    ...(expandedKeyQuery.length === 0 ? [] : [expandedKeyQuery]),
    ...dateQueries
  ].map((value) => value.trim()).filter((value) => value.length > 0));
}

// Deterministic OR-query of expanded lexical terms (morphology + synonym
// variants). Returns null when there is nothing to expand so callers can skip
// the extra FTS pass. see also: recall-query-probes.ts expandLexicalTerms.
function buildExpandedKeywordQuery(queryProbes: Readonly<RecallQueryProbes>): string | null {
  const expanded = uniqueStrings(
    queryProbes.expanded_terms.slice(0, 16).map((term) => term.trim()).filter((term) => term.length > 0)
  );
  return expanded.length === 0 ? null : expanded.join(" ");
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
  // invariant: mirrors the weak-entity-only filter that
  // selectExpansionSeedDrafts applies on the graph_expansion path. The
  // seeds returned here drive the evidence_anchor / domain_tag_cluster
  // planes in addContentDerivedExpansionCandidates (evidence_refs and
  // domain_tags of these seeds widen the per-plane match set). A weak
  // cjk_phrase / proper_noun / unknown surface (confidence below
  // ENTITY_GRAPH_EXPANSION_CONFIDENCE_FLOOR) admitted ONLY on
  // entity_seed must not be allowed to seed content expansion either —
  // otherwise the same surface manipulation that the graph_expansion
  // floor blocks would leak through evidence/tag fan-out.
  // Defense-in-depth: today addContentDerivedExpansionCandidates is
  // called BEFORE collectEntityDerivedSeeds, so no entity_seed draft
  // is present at the moment this seed pool is built. The filter is
  // applied anyway so any future reordering, or a follow-up caller
  // that runs after entity_seed admission, cannot silently bypass
  // the graph_expansion floor via the content-expansion lane.
  // see also: isWeakEntityOnlyDraft, selectExpansionSeedDrafts
  return rankCoarseCandidateDrafts([...drafts.values()])
    .filter((draft) => !isWeakEntityOnlyDraft(draft))
    // semantic_supplement candidates carry no structural anchor and must not
    // seed graph_expansion; they would expand from an unrelated neighbor.
    .filter((draft) =>
      draft.admissionPlanes.some(
        (plane) => plane !== "activation" && plane !== "semantic_supplement"
      ) || draft.structuralScore > 0
    )
    .slice(0, DYNAMIC_RECALL_SEED_CAP)
    .map((draft) => draft.entry);
}

function selectExpansionSeedDrafts(
  drafts: ReadonlyMap<string, CoarseCandidateDraft>
): readonly Readonly<CoarseCandidateDraft>[] {
  const ranked = rankCoarseCandidateDrafts([...drafts.values()]);
  // invariant: a draft whose ONLY non-activation admission is entity_seed,
  // and whose strongest observed entity confidence is below the floor, must
  // not seed graph_expansion. Mirrors collectEntityDerivedSeeds's confidence
  // gate on the extraSeedMemoryIds path — without this, a weak cjk_phrase /
  // proper_noun query surface (confidence 0.35-0.7) that hit only the
  // entity-FTS lane would still fan into the graph via path (1) and let
  // an attacker compound surface manipulation across 1-hop neighbors.
  // see also: ENTITY_GRAPH_EXPANSION_CONFIDENCE_FLOOR, addGraphExpansionCandidates
  const survivors = ranked.filter((draft) => !isWeakEntityOnlyDraft(draft));
  const preferred = survivors
    .filter((draft) =>
      draft.admissionPlanes.some(
        (plane) => plane !== "activation" && plane !== "semantic_supplement"
      ) || draft.structuralScore > 0
    )
    .slice(0, DYNAMIC_RECALL_SEED_CAP);
  const preferredIds = new Set(preferred.map((draft) => draft.entry.object_id));
  return [
    ...preferred,
    ...survivors.filter((draft) => !preferredIds.has(draft.entry.object_id))
  ].slice(0, DYNAMIC_RECALL_SEED_CAP);
}

// anchor: entity-only graph_expansion floor. A draft is "weak entity-only"
// when its admission_planes contain entity_seed and NO other non-activation
// plane co-admitted (no lexical, object_probe, evidence_anchor, etc.) and
// the strongest entity confidence is below the floor. Drafts with a real
// co-admitting plane (lexical hit, structural agreement, etc.) survive,
// even when the entity confidence is weak.
function isWeakEntityOnlyDraft(draft: Readonly<CoarseCandidateDraft>): boolean {
  const planes = draft.admissionPlanes;
  if (!planes.includes("entity_seed")) {
    return false;
  }
  const hasNonEntitySupport = planes.some(
    (plane) => plane !== "entity_seed" && plane !== "activation"
  );
  if (hasNonEntitySupport) {
    return false;
  }
  const confidence = draft.entityConfidence ?? 0;
  return confidence < ENTITY_GRAPH_EXPANSION_CONFIDENCE_FLOOR;
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
  if (draft.admissionPlanes.includes("lexical") || draft.admissionPlanes.includes("entity_seed")) {
    return 3;
  }
  // Semantic-supplement injections lack lexical / structural anchors; rank
  // them above raw activation-only candidates but below any plane that
  // carries a real anchor. see also: collectEmbeddingCoarseInjection.
  if (draft.admissionPlanes.includes("semantic_supplement")) {
    return 2;
  }
  return 1;
}

// Graph-traversal admission score MAGNITUDE for a PathRelation hop. The
// contribution basis is EDGE_TYPE_RECALL_MODEL[trackedEdgeType].contribution_weight
// (supports 1.0 / derives_from 0.5 / recalls 0.3); path-only relation kinds
// fold onto the recalls tier via pathRelationKindToTrackedEdgeType. Floored at
// 0 because only recall-eligible (recall_bias > 0) paths reach traversal.
// Strength deliberately does NOT scale the basis here: the caller routes hop-1
// (direct) associations through scorePathRelationExpansion (which already folds
// strength), and this traversal score carries only the static contribution
// magnitude.
// note: the score MAGNITUDE matches the static edge-era contribution_weight,
// but the traversal is NOT edge-equivalent in TOPOLOGY — collectPathGraphNeighbors
// follows path direction_bias (a source_to_target path is followed forward
// only), whereas retired memory_graph_edges propagated undirected. This is
// intentional and aligned with the hop-1 path_expansion direction filter
// (directionEligiblePathExpansionTargets), so the two planes agree on which way
// a path may be followed; it is not a zero-drift reproduction of the undirected
// edge plane. Producer-seeded paths are minted bidirectional_asymmetric (see
// path-relation-proposal-service.ts submitCandidate), so hop-2 reach narrows
// only after plasticity redirects a path to an asymmetric direction.
// see also: collectPathGraphNeighbors, directionEligiblePathExpansionTargets.
function graphTraversalScoreFromPath(
  trackedEdgeType: RecallGraphExpansionTrackedEdgeType
): number {
  const weight = EDGE_TYPE_RECALL_MODEL[trackedEdgeType].contribution_weight;
  return clamp01(Math.max(0, weight));
}

function createMutableGraphExpansionDiagnostics(): MutableGraphExpansionDiagnostics {
  return {
    graph_expansion_plane_count_per_hop: [0, 0],
    graph_expansion_plane_count_per_edge_type: {
      derives_from: 0,
      recalls: 0,
      supports: 0
    },
    multi_seed_fan_in_distinct_seeds: 0,
    multi_seed_fan_in_dedup_collisions: 0,
    multi_seed_fan_in_candidates_per_seed: []
  };
}

function createEmptyGraphExpansionDiagnostics(): Readonly<RecallGraphExpansionDiagnostics> {
  return freezeGraphExpansionDiagnostics(createMutableGraphExpansionDiagnostics());
}

// anchor: percentile-of-sample helper used only by multi_seed_graph_fan_in
// diagnostics. Linear interpolation between adjacent ranks, matches
// numpy.percentile(..., method='linear') for stable cross-language reads.
function percentileOfSorted(samples: readonly number[], percentile: number): number {
  if (samples.length === 0) {
    return 0;
  }
  if (samples.length === 1) {
    return samples[0];
  }
  const rank = ((samples.length - 1) * percentile) / 100;
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  if (lower === upper) {
    return samples[lower];
  }
  const weight = rank - lower;
  return samples[lower] * (1 - weight) + samples[upper] * weight;
}

function freezeGraphExpansionDiagnostics(
  diagnostics: Readonly<MutableGraphExpansionDiagnostics>
): Readonly<RecallGraphExpansionDiagnostics> {
  const base = {
    graph_expansion_plane_count_per_hop: Object.freeze([
      diagnostics.graph_expansion_plane_count_per_hop[0],
      diagnostics.graph_expansion_plane_count_per_hop[1]
    ]) as RecallGraphExpansionDiagnostics["graph_expansion_plane_count_per_hop"],
    graph_expansion_plane_count_per_edge_type: Object.freeze({
      derives_from: diagnostics.graph_expansion_plane_count_per_edge_type.derives_from,
      recalls: diagnostics.graph_expansion_plane_count_per_edge_type.recalls,
      supports: diagnostics.graph_expansion_plane_count_per_edge_type.supports
    })
  };
  if (diagnostics.multi_seed_fan_in_distinct_seeds === 0) {
    return Object.freeze(base);
  }
  const sortedCounts = [...diagnostics.multi_seed_fan_in_candidates_per_seed].sort((a, b) => a - b);
  const fanIn: RecallMultiSeedGraphFanInDiagnostics = {
    distinct_seeds: diagnostics.multi_seed_fan_in_distinct_seeds,
    candidates_per_seed_p50: percentileOfSorted(sortedCounts, 50),
    candidates_per_seed_p95: percentileOfSorted(sortedCounts, 95),
    dedup_collisions: diagnostics.multi_seed_fan_in_dedup_collisions
  };
  return Object.freeze({
    ...base,
    multi_seed_graph_fan_in: Object.freeze(fanIn)
  });
}

function freezeGraphExpansionCandidatesResult(
  diagnostics: Readonly<MutableGraphExpansionDiagnostics>,
  candidateSources: ReadonlyMap<string, Readonly<GraphExpansionCandidateSourceDiagnostic>>
): Readonly<GraphExpansionCandidatesResult> {
  return Object.freeze({
    diagnostics: freezeGraphExpansionDiagnostics(diagnostics),
    candidateSources: new Map(candidateSources)
  });
}

function mergeGraphExpansionCandidateSources(
  current: ReadonlyMap<string, Readonly<GraphExpansionCandidateSourceDiagnostic>>,
  next: ReadonlyMap<string, Readonly<GraphExpansionCandidateSourceDiagnostic>>,
  nextCandidateIds: ReadonlySet<string>
): ReadonlyMap<string, Readonly<GraphExpansionCandidateSourceDiagnostic>> {
  const merged = new Map(current);
  for (const id of nextCandidateIds) {
    const source = next.get(id);
    if (source !== undefined) {
      merged.set(id, source);
    }
  }
  return merged;
}

function mergeGraphExpansionScores(
  current: Readonly<Record<string, number>>,
  next: Readonly<Record<string, number>>,
  nextCandidateIds: ReadonlySet<string>
): Readonly<Record<string, number>> {
  const merged: Record<string, number> = { ...current };
  for (const id of nextCandidateIds) {
    const score = next[id];
    if (score !== undefined) {
      merged[id] = Math.max(merged[id] ?? 0, score);
    }
  }
  return Object.freeze(merged);
}

function summarizeGraphExpansionCandidateSources(
  sources: ReadonlyMap<string, Readonly<GraphExpansionCandidateSourceDiagnostic>>
): Readonly<RecallGraphExpansionDiagnostics> {
  const diagnostics = createMutableGraphExpansionDiagnostics();
  for (const source of sources.values()) {
    diagnostics.graph_expansion_plane_count_per_hop[source.hop - 1] += 1;
    diagnostics.graph_expansion_plane_count_per_edge_type[source.edgeType] += 1;
  }
  return freezeGraphExpansionDiagnostics(diagnostics);
}

// anchor: cascade merge for graph_expansion diagnostics. Re-derives hop /
// edge_type counts from candidate sources so the merged surface stays
// consistent with the kept candidates. multi_seed_graph_fan_in is not
// re-derivable from sources (per-seed BFS history is local to each
// addGraphExpansionCandidates call) so the merger prefers the cascade tier
// with more distinct_seeds; when only one tier carries fan-in stats, that
// tier wins. see also: mergeCoarseFilters
function mergeGraphExpansionDiagnosticsAcrossCascade(params: Readonly<{
  readonly sources: ReadonlyMap<string, Readonly<GraphExpansionCandidateSourceDiagnostic>>;
  readonly currentFanIn?: Readonly<RecallMultiSeedGraphFanInDiagnostics>;
  readonly nextFanIn?: Readonly<RecallMultiSeedGraphFanInDiagnostics>;
}>): Readonly<RecallGraphExpansionDiagnostics> {
  const summary = summarizeGraphExpansionCandidateSources(params.sources);
  const chosenFanIn = chooseStrongerFanIn(params.currentFanIn, params.nextFanIn);
  if (chosenFanIn === undefined) {
    return summary;
  }
  return Object.freeze({
    ...summary,
    multi_seed_graph_fan_in: chosenFanIn
  });
}

function chooseStrongerFanIn(
  left: Readonly<RecallMultiSeedGraphFanInDiagnostics> | undefined,
  right: Readonly<RecallMultiSeedGraphFanInDiagnostics> | undefined
): Readonly<RecallMultiSeedGraphFanInDiagnostics> | undefined {
  if (left === undefined) {
    return right;
  }
  if (right === undefined) {
    return left;
  }
  return right.distinct_seeds > left.distinct_seeds ? right : left;
}

function shouldReplaceGraphExpansionCandidate(
  candidate: Readonly<GraphExpansionCandidateDraft>,
  current: Readonly<GraphExpansionCandidateDraft>
): boolean {
  if (candidate.score !== current.score) {
    return candidate.score > current.score;
  }
  if (candidate.hop !== current.hop) {
    return candidate.hop < current.hop;
  }
  const edgeTypeOrder =
    GRAPH_EXPANSION_TRACKED_EDGE_TYPES.indexOf(candidate.edgeType) -
    GRAPH_EXPANSION_TRACKED_EDGE_TYPES.indexOf(current.edgeType);
  if (edgeTypeOrder !== 0) {
    return edgeTypeOrder < 0;
  }
  return compareMemoryEntries(candidate.entry, current.entry) < 0;
}

function compareGraphExpansionCandidateDrafts(
  left: Readonly<GraphExpansionCandidateDraft>,
  right: Readonly<GraphExpansionCandidateDraft>
): number {
  if (left.hop !== right.hop) {
    return left.hop - right.hop;
  }
  if (left.score !== right.score) {
    return right.score - left.score;
  }
  const edgeTypeOrder =
    GRAPH_EXPANSION_TRACKED_EDGE_TYPES.indexOf(left.edgeType) -
    GRAPH_EXPANSION_TRACKED_EDGE_TYPES.indexOf(right.edgeType);
  if (edgeTypeOrder !== 0) {
    return edgeTypeOrder;
  }
  return compareMemoryEntries(left.entry, right.entry);
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

// Strength-gated active suppression delta for one negative path. recall_bias
// is negative for the suppressing families (contradicts / supersedes /
// incompatible_with), so |recall_bias| is the suppression magnitude. The
// plasticity strength gate keeps weak / forming negatives inert: below
// PATH_SUPPRESSION_STRENGTH_FLOOR the delta is exactly 0, so an attention_only
// co-occurrence cannot demote a memory. At or above the floor the strength
// scales the delta linearly, so a plasticity-reinforced contradiction applies
// real demotion. Returns 0 for non-negative paths defensively (callers pass
// only recall_bias < 0 paths). see also: PATH_SUPPRESSION_SCALE rationale.
function scorePathRelationSuppression(path: Readonly<PathRelation>): number {
  const recallBias = path.effect_vector.recall_bias;
  if (recallBias >= 0) {
    return 0;
  }
  const strength = clamp01(path.plasticity_state.strength);
  if (strength < PATH_SUPPRESSION_STRENGTH_FLOOR) {
    return 0;
  }
  return Math.abs(recallBias) * strength * PATH_SUPPRESSION_SCALE;
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

interface PathGraphNeighbor {
  readonly neighborId: string;
  readonly edgeType: RecallGraphExpansionTrackedEdgeType;
  // The raw path relation_kind (pre-fold), kept alongside the tracked edgeType so
  // the hop>=2 chain gate can key on the true relation rather than the folded type.
  readonly relationKind: string;
}

// anchor: path-graph traversal neighbor extraction shared by expandGraphFrontier.
// Given a frontier node id, returns the direction-eligible object neighbors
// reachable through the supplied recall-eligible paths, each tagged with the
// tracked edge type its relation_kind maps onto. Reuses the same
// direction_bias semantics as directionEligiblePathExpansionTargets so the
// graph-traversal plane and the direct path_expansion plane agree on which
// way a path may be followed. Self-loops and non-object anchors yield nothing.
function collectPathGraphNeighbors(
  paths: readonly Readonly<PathRelation>[],
  nodeId: string
): readonly PathGraphNeighbor[] {
  const neighbors: PathGraphNeighbor[] = [];
  const seen = new Set<string>();
  for (const path of paths) {
    const sourceId = anchorMemoryId(path.anchors.source_anchor);
    const targetId = anchorMemoryId(path.anchors.target_anchor);
    if (sourceId === undefined || targetId === undefined || sourceId === targetId) {
      continue;
    }
    const relationKind = path.constitution.relation_kind;
    const edgeType = pathRelationKindToTrackedEdgeType(relationKind);
    if (
      sourceId === nodeId &&
      (path.plasticity_state.direction_bias === "source_to_target" ||
        path.plasticity_state.direction_bias === "bidirectional_asymmetric")
    ) {
      const key = `${targetId}:${edgeType}`;
      if (!seen.has(key)) {
        seen.add(key);
        neighbors.push({ neighborId: targetId, edgeType, relationKind });
      }
    }
    if (
      targetId === nodeId &&
      (path.plasticity_state.direction_bias === "target_to_source" ||
        path.plasticity_state.direction_bias === "bidirectional_asymmetric")
    ) {
      const key = `${sourceId}:${edgeType}`;
      if (!seen.has(key)) {
        seen.add(key);
        neighbors.push({ neighborId: sourceId, edgeType, relationKind });
      }
    }
  }
  return neighbors;
}

function pathRelationMemoryIds(path: Readonly<PathRelation>): readonly string[] {
  return uniqueStrings([
    anchorMemoryId(path.anchors.source_anchor),
    anchorMemoryId(path.anchors.target_anchor)
  ].filter((value): value is string => value !== undefined));
}

// Provenance helper: the facet_key the path is anchored on, if either endpoint
// is an object_facet anchor (source preferred — it is the matched side). null
// for plain object/obligation/risk/time anchors.
function pathAnchorFacetKey(path: Readonly<PathRelation>): string | null {
  const { source_anchor, target_anchor } = path.anchors;
  if (source_anchor.kind === "object_facet") return source_anchor.facet_key;
  if (target_anchor.kind === "object_facet") return target_anchor.facet_key;
  return null;
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

// invariant: recall path_expansion only consumes recall-eligible paths —
// active lifecycle AND recall_bias > 0 (the shared isPathRecallEligible
// predicate). This is the negation of recall-eligible, so it excludes in
// one gate:
//   - lifecycle: retired (terminal) and dormant (reversible cold storage)
//     never leak back into recall scoring;
//   - negative families (contradicts / supersedes / incompatible_with,
//     recall_bias < 0): suppression, not association — adding the target as
//     a positive path_expansion candidate would AMPLIFY the suppressed
//     memory instead of demoting it;
//   - the recall-neutral exception_to marker (recall_bias == 0): a topology
//     marker that must not enter positive expansion either.
// Using the shared predicate keeps the < 0 / <= 0 family boundary aligned
// with PathPlasticityService (which retires the negative + neutral family)
// rather than re-deriving the sign test here.
// Active sign-aware suppression that scores negatives as a demotion rather
// than a non-add is a separate recall pass, not yet implemented; this guard
// only stops the amplification.
// see also: path-relation-proposal-service.ts — recall_bias is
// recallBiasSign * recallBiasMagnitude, so a negative family is < 0 and the
// exception_to marker is exactly 0.
// see also: path-relation.ts isPathRecallEligible — the shared predicate.
function isPathExcludedFromRecall(path: Readonly<PathRelation>): boolean {
  return !isPathRecallEligible(path);
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
  // semantic_supplement is the embedding coarse-injection plane; attribute
  // it only when no anchored plane co-admitted the candidate.
  "semantic_supplement",
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
