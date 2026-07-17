import { resolvePremiseInvalid } from "./abstention.js";
import { classifyQuestionMissTaxonomy } from "./miss/diagnostics-miss-taxonomy.js";
import {
  buildQuestionCohortLedger,
  hasAbstentionIdentityConflict
} from "./diagnostics-cohort.js";
import type {
  CandidateIdentityObservation,
  DiagnosticActiveConstraintResult,
  DiagnosticRecallResult,
  DiagnosticRecallResultInput,
  LongMemEvalGoldDiagnostic,
  LongMemEvalQuestionDiagnostic,
  LongMemEvalReplayCandidate,
  NarrowRecallDiagnostics
} from "./schema/diagnostics-types.js";
import {
  hasLongMemEvalSeedDropReasons,
  type LongMemEvalSeedDropReasons
} from "../extraction/seed-fuel/seed-drop-reasons.js";
import {
  buildObjectIdentityKey,
  createEmptyGraphExpansionPlaneCountPerEdgeType,
  createEmptyGraphExpansionPlaneCountPerHop,
  hasStructuralPlane,
  isDeliveryBudgetLoss
} from "./schema/diagnostics-private.js";

export interface QuestionDiagnosticInput {
  readonly questionId: string;
  readonly questionType?: string | null;
  readonly goldMemoryIds: readonly string[];
  readonly answerSessionIds: readonly string[];
  readonly deliveredResults: readonly DiagnosticRecallResultInput[];
  readonly activeConstraintResults?: readonly DiagnosticActiveConstraintResult[];
  readonly hitAt1: boolean;
  readonly hitAt5: boolean;
  readonly hitAt10: boolean;
  readonly isAbstention?: boolean;
  readonly premiseInvalid?: boolean;
  readonly degradationReason: string | null;
  readonly recallResult: unknown;
  readonly embeddingMode: "disabled" | "env";
  readonly roundIndex?: number;
  readonly seedDropReasons?: LongMemEvalSeedDropReasons;
}

export interface QuestionDiagnosticParts {
  readonly diagnostics: NarrowRecallDiagnostics | null;
  readonly deliveredResults: readonly DiagnosticRecallResult[];
  readonly activeConstraintResults: readonly DiagnosticActiveConstraintResult[];
  readonly gold: readonly LongMemEvalGoldDiagnostic[];
  readonly candidates: readonly LongMemEvalReplayCandidate[];
}

export function assembleQuestionDiagnostic(
  input: QuestionDiagnosticInput,
  parts: QuestionDiagnosticParts
): LongMemEvalQuestionDiagnostic {
  const scoringInput = failClosedAbstentionHits(input);
  const missFields = buildQuestionMissFields(scoringInput, parts);
  const candidateCollisions = classifyCandidateCollisions(parts.diagnostics);
  const candidatePoolComplete = isCandidatePoolComplete(parts);
  const premiseInvalid = input.premiseInvalid === true ? true : resolvePremiseInvalid();
  return {
    question_id: input.questionId,
    question_type: input.questionType ?? null,
    is_abstention: input.isAbstention === true,
    premise_invalid: premiseInvalid,
    round_index: input.roundIndex ?? null,
    gold_memory_ids: input.goldMemoryIds,
    answer_session_ids: input.answerSessionIds,
    delivered_results: parts.deliveredResults,
    active_constraint_results: parts.activeConstraintResults,
    hit_at_1: scoringInput.hitAt1,
    hit_at_5: scoringInput.hitAt5,
    hit_at_10: scoringInput.hitAt10,
    ...missFields,
    degradation_reason: input.degradationReason,
    ...buildRecallTelemetryFields(input, parts, candidatePoolComplete),
    query_probes: parts.diagnostics?.queryProbes ?? null,
    query_sought_facets: parts.diagnostics?.querySoughtFacets ?? null,
    candidate_pool_count: parts.diagnostics?.candidatePoolCount ?? null,
    fine_pruned_count: parts.diagnostics?.finePrunedCount ?? null,
    fine_assessment_pruned_candidates:
      parts.diagnostics?.fineAssessmentPrunedCandidates ?? [],
    candidates: parts.candidates,
    candidate_key_collisions: candidateCollisions.rows,
    cohort_ledger: buildQuestionCohortLedger({
      isAbstention: input.isAbstention === true,
      premiseInvalid,
      hitAt5: scoringInput.hitAt5,
      goldMemoryIds: input.goldMemoryIds,
      gold: parts.gold,
      diagnosticsAvailable: parts.diagnostics !== null,
      candidatePoolComplete,
      identityConflictObjectKeys: candidateCollisions.identityConflictObjectKeys,
      missTaxonomy: missFields.miss_taxonomy,
      seedDropReasons: input.seedDropReasons
    }),
    gold: parts.gold
  };
}

function failClosedAbstentionHits(input: QuestionDiagnosticInput): QuestionDiagnosticInput {
  if (input.isAbstention !== true) return input;
  return { ...input, hitAt1: false, hitAt5: false, hitAt10: false };
}

function buildQuestionMissFields(
  input: QuestionDiagnosticInput,
  parts: QuestionDiagnosticParts
) {
  return {
    miss_classification: classifyMiss(
      input.hitAt5,
      parts.gold,
      parts.diagnostics !== null,
      input.isAbstention === true,
      input.goldMemoryIds
    ),
    miss_taxonomy: classifyQuestionMissTaxonomy({
      hitAt5: input.hitAt5,
      goldMemoryIds: input.goldMemoryIds,
      gold: parts.gold,
      diagnosticsAvailable: parts.diagnostics !== null,
      isAbstention: input.isAbstention === true,
      seedDropReasons: input.seedDropReasons
    }),
    ...(hasLongMemEvalSeedDropReasons(input.seedDropReasons)
      ? { seed_drop_reasons: input.seedDropReasons }
      : {})
  };
}

function buildRecallTelemetryFields(
  input: QuestionDiagnosticInput,
  parts: QuestionDiagnosticParts,
  candidatePoolComplete: boolean
) {
  const diagnostics = parts.diagnostics;
  return {
    recall_diagnostics_present: diagnostics !== null,
    recall_diagnostics_keys: diagnostics?.keys ?? [],
    ...(diagnostics?.phaseLatencyMs === null || diagnostics?.phaseLatencyMs === undefined
      ? {}
      : { phase_latency_ms: diagnostics.phaseLatencyMs }),
    provider_state: diagnostics?.providerState ??
      (input.embeddingMode === "disabled" ? "provider_not_requested" : "unknown"),
    provider_degradation_reason: diagnostics?.providerDegradationReason ?? null,
    ...(diagnostics?.embeddingWorkspaceScannedCount === null || diagnostics === null
      ? {}
      : { embedding_workspace_scanned_count: diagnostics.embeddingWorkspaceScannedCount }),
    ...(diagnostics?.embeddingWorkspaceTruncated === null || diagnostics === null
      ? {}
      : { embedding_workspace_truncated: diagnostics.embeddingWorkspaceTruncated }),
    ...(diagnostics?.embeddingWorkspaceProviderKind === null || diagnostics === null
      ? {}
      : { embedding_workspace_provider_kind: diagnostics.embeddingWorkspaceProviderKind }),
    ...(diagnostics?.embeddingWorkspaceModelId === null || diagnostics === null
      ? {}
      : { embedding_workspace_model_id: diagnostics.embeddingWorkspaceModelId }),
    ...(diagnostics?.embeddingWorkspaceSchemaVersion === null || diagnostics === null
      ? {}
      : { embedding_workspace_schema_version: diagnostics.embeddingWorkspaceSchemaVersion }),
    answer_rerank_status: diagnostics?.answerRerankStatus ?? null,
    answer_rerank_expected_count: diagnostics?.answerRerankExpectedCount ?? null,
    answer_rerank_scored_count: diagnostics?.answerRerankScoredCount ?? null,
    answer_rerank_failure_class: diagnostics?.answerRerankFailureClass ?? null,
    graph_expansion_plane_count_per_hop: diagnostics?.graphExpansionPlaneCountPerHop ??
      createEmptyGraphExpansionPlaneCountPerHop(),
    graph_expansion_plane_count_per_edge_type:
      diagnostics?.graphExpansionPlaneCountPerEdgeType ??
      createEmptyGraphExpansionPlaneCountPerEdgeType(),
    candidate_pool_complete: candidatePoolComplete
  };
}

function isCandidatePoolComplete(parts: QuestionDiagnosticParts): boolean {
  return parts.diagnostics?.candidatePoolComplete === true &&
    parts.candidates.every(isReplayCandidateComplete);
}

function isReplayCandidateComplete(candidate: LongMemEvalReplayCandidate): boolean {
  return candidate.per_stream_rank !== null &&
    candidate.fused_rank_contribution_per_stream !== null &&
    candidate.score_factors.activation !== undefined &&
    candidate.score_factors.facet_overlap !== undefined &&
    candidate.score_factors.created_at !== undefined;
}

function classifyCandidateCollisions(
  diagnostics: NarrowRecallDiagnostics | null
): Readonly<{
  rows: LongMemEvalQuestionDiagnostic["candidate_key_collisions"];
  identityConflictObjectKeys: readonly string[];
}> {
  if (diagnostics === null) return { rows: [], identityConflictObjectKeys: [] };
  const groups = groupCandidateIdentityObservations(
    diagnostics.candidateIdentityObservations
  );
  const rows = groups
    .filter((group) => hasReportableCollision(group))
    .map(({ objectId, observations }) => ({
      object_id: objectId,
      candidate_keys: observations.map((item) => item.sourceCandidateKey).sort()
    }));
  return {
    rows,
    identityConflictObjectKeys: groups
      .filter(({ observations }) => hasIdentityConflict(observations))
      .map(({ objectIdentity }) => objectIdentity)
  };
}

interface CandidateIdentityGroup {
  readonly objectId: string;
  readonly objectIdentity: string;
  readonly observations: readonly CandidateIdentityObservation[];
}

function groupCandidateIdentityObservations(
  observations: readonly CandidateIdentityObservation[]
): readonly CandidateIdentityGroup[] {
  const byIdentity = new Map<string, CandidateIdentityObservation[]>();
  for (const observation of observations) {
    const identity = buildObjectIdentityKey(
      observation.candidate.objectKind,
      observation.candidate.objectId
    );
    const group = byIdentity.get(identity) ?? [];
    group.push(observation);
    byIdentity.set(identity, group);
  }
  return [...byIdentity.entries()].map(([objectIdentity, group]) => Object.freeze({
    objectId: group[0]!.candidate.objectId,
    objectIdentity,
    observations: Object.freeze(group)
  }));
}

function hasReportableCollision(group: CandidateIdentityGroup): boolean {
  const keys = group.observations.map((item) => item.sourceCandidateKey);
  return new Set(keys).size !== keys.length ||
    (group.observations.length > 1 && group.observations.some((item) => item.legacy)) ||
    hasIdentityConflict(group.observations);
}

function hasIdentityConflict(observations: readonly CandidateIdentityObservation[]): boolean {
  const candidates = observations.map((item) => item.candidate);
  const first = candidates[0];
  if (first === undefined) return false;
  return knownValuesConflict(candidates.map((row) => row.createdAt)) ||
    knownValuesConflict(candidates.map((row) => row.dimension)) ||
    knownValuesConflict(candidates.map((row) => row.sessionKey)) ||
    knownValuesConflict(candidates.map((row) => row.answerFeatures === null
      ? null
      : JSON.stringify(row.answerFeatures)));
}

function knownValuesConflict(values: readonly (string | null)[]): boolean {
  const known = values.filter((value): value is string => value !== null);
  return new Set(known).size > 1;
}

function classifyMiss(
  hitAt5: boolean,
  gold: readonly LongMemEvalGoldDiagnostic[],
  diagnosticsAvailable: boolean,
  isAbstention: boolean,
  goldMemoryIds: readonly string[]
): LongMemEvalQuestionDiagnostic["miss_classification"] {
  if (hasAbstentionIdentityConflict({ isAbstention, goldMemoryIds })) {
    return "evaluator_identity_inconsistent";
  }
  if (isAbstention) return "abstention_uncalibrated";
  if (gold.length === 0) return "no_gold";
  if (hitAt5) return "hit_at_5";
  if (!diagnosticsAvailable) return "diagnostics_unavailable";
  if (gold.some(isDeliveryBudgetLoss)) return "budget_dropped";
  if (gold.some((item) =>
    (item.final_rank !== null && item.final_rank > 5) ||
    item.pre_budget_rank !== null ||
    item.fused_rank !== null
  )) return "under_ranked";
  if (gold.some((item) => item.candidate_status === "active_constraint_delivered")) {
    return "active_constraint_only";
  }
  const notDelivered = gold.filter(
    (item) => item.candidate_status === "candidate_not_delivered"
  );
  if (notDelivered.some((item) => !item.source_planes.includes("lexical"))) {
    return "lexical_gap";
  }
  if (notDelivered.some((item) => !hasStructuralPlane(item.source_planes))) {
    return "structural_gap";
  }
  return "candidate_absent";
}
