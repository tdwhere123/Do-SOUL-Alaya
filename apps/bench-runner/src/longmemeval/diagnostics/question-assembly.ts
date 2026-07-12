import { resolvePremiseInvalid } from "../abstention.js";
import { classifyQuestionMissTaxonomy } from "../diagnostics-miss-taxonomy.js";
import {
  buildQuestionCohortLedger,
  hasAbstentionIdentityConflict
} from "../diagnostics-cohort.js";
import type {
  CandidateDiagnostic,
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
      identityConflictObjectIds: candidateCollisions.identityConflictObjectIds,
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
  identityConflictObjectIds: readonly string[];
}> {
  if (diagnostics === null) return { rows: [], identityConflictObjectIds: [] };
  const rows = [...diagnostics.candidateKeysByObjectId.entries()]
    .filter(([, candidateKeys]) => candidateKeys.length > 1)
    .map(([objectId, candidateKeys]) => ({
      object_id: objectId,
      candidate_keys: candidateKeys
    }));
  return {
    rows,
    identityConflictObjectIds: rows
      .filter((row) => hasIdentityConflict(diagnostics, row.candidate_keys))
      .map((row) => row.object_id)
  };
}

function hasIdentityConflict(
  diagnostics: NarrowRecallDiagnostics,
  candidateKeys: readonly string[]
): boolean {
  const candidates = candidateKeys
    .map((key) => diagnostics.candidatesByCandidateKey.get(key))
    .filter((candidate): candidate is CandidateDiagnostic => candidate !== undefined);
  const first = candidates[0];
  return first !== undefined && candidates.slice(1).some((candidate) =>
    candidate.objectKind !== first.objectKind ||
    candidate.createdAt !== first.createdAt ||
    candidate.dimension !== first.dimension ||
    candidate.sessionKey !== first.sessionKey ||
    JSON.stringify(candidate.answerFeatures) !== JSON.stringify(first.answerFeatures)
  );
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
