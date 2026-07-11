import { resolvePremiseInvalid } from "../abstention.js";
import { classifyQuestionMissTaxonomy } from "../diagnostics-miss-taxonomy.js";
import type {
  DiagnosticActiveConstraintResult,
  DiagnosticRecallResult,
  DiagnosticRecallResultInput,
  LongMemEvalGoldDiagnostic,
  LongMemEvalQuestionDiagnostic,
  LongMemEvalReplayCandidate,
  NarrowRecallDiagnostics
} from "../diagnostics-types.js";
import {
  hasLongMemEvalSeedDropReasons,
  type LongMemEvalSeedDropReasons
} from "../seed-drop-reasons.js";
import {
  createEmptyGraphExpansionPlaneCountPerEdgeType,
  createEmptyGraphExpansionPlaneCountPerHop,
  hasStructuralPlane,
  isDeliveryBudgetLoss
} from "../diagnostics-private.js";

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
  return {
    question_id: input.questionId,
    question_type: input.questionType ?? null,
    is_abstention: input.isAbstention === true,
    premise_invalid: input.premiseInvalid === true ? true : resolvePremiseInvalid(),
    round_index: input.roundIndex ?? null,
    gold_memory_ids: input.goldMemoryIds,
    answer_session_ids: input.answerSessionIds,
    delivered_results: parts.deliveredResults,
    active_constraint_results: parts.activeConstraintResults,
    hit_at_1: input.hitAt1,
    hit_at_5: input.hitAt5,
    hit_at_10: input.hitAt10,
    ...buildQuestionMissFields(input, parts),
    degradation_reason: input.degradationReason,
    ...buildRecallTelemetryFields(input, parts),
    candidates: parts.candidates,
    candidate_key_collisions: buildCandidateKeyCollisions(parts.diagnostics),
    gold: parts.gold
  };
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
      input.isAbstention === true
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
  parts: QuestionDiagnosticParts
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
    graph_expansion_plane_count_per_hop: diagnostics?.graphExpansionPlaneCountPerHop ??
      createEmptyGraphExpansionPlaneCountPerHop(),
    graph_expansion_plane_count_per_edge_type:
      diagnostics?.graphExpansionPlaneCountPerEdgeType ??
      createEmptyGraphExpansionPlaneCountPerEdgeType(),
    candidate_pool_complete: diagnostics?.candidatePoolComplete === true &&
      parts.candidates.every(isReplayCandidateComplete)
  };
}

function isReplayCandidateComplete(candidate: LongMemEvalReplayCandidate): boolean {
  return candidate.per_stream_rank !== null &&
    candidate.fused_rank_contribution_per_stream !== null &&
    candidate.score_factors.activation !== undefined &&
    candidate.score_factors.facet_overlap !== undefined &&
    candidate.score_factors.created_at !== undefined;
}

function buildCandidateKeyCollisions(
  diagnostics: NarrowRecallDiagnostics | null
): LongMemEvalQuestionDiagnostic["candidate_key_collisions"] {
  if (diagnostics === null) return [];
  return [...diagnostics.candidateKeysByObjectId.entries()]
    .filter(([, candidateKeys]) => candidateKeys.length > 1)
    .map(([objectId, candidateKeys]) => ({
      object_id: objectId,
      candidate_keys: candidateKeys
    }));
}

function classifyMiss(
  hitAt5: boolean,
  gold: readonly LongMemEvalGoldDiagnostic[],
  diagnosticsAvailable: boolean,
  isAbstention: boolean
): LongMemEvalQuestionDiagnostic["miss_classification"] {
  if (isAbstention) return hitAt5 ? "abstained_correctly" : "abstain_false_confident";
  if (hitAt5) return "hit_at_5";
  if (!diagnosticsAvailable) return "diagnostics_unavailable";
  if (gold.length === 0) return "no_gold";
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
